// ============================================================================
// FILE: src/background/network-capture.js
// PURPOSE: Low-level network traffic interception via chrome.webRequest.
//          Sniffs all Google Drive and YouTube media segment URLs containing 'videoplayback',
//          classifies them as audio or video, correlates them with ongoing quality probes,
//          deduplicates dual webRequest events, and saves formats to session storage.
// ============================================================================

/** Maximum number of recent streams kept in the tab's in-memory ring buffer */
const RECENT_STREAM_LIMIT = 96;

/** Maximum number of probe candidates retained in memory for an active quality probe */
const PROBE_BUFFER_LIMIT = 48;

/** Storage key under chrome.storage.local where the most recently detected global audio/video streams are saved */
const GLOBAL_STREAM_KEY = 'psdGlobalStreams';

/** FIFO Promise queue ensuring serialized writes to global streams in chrome.storage.local */
let globalStreamsQueue = Promise.resolve();

// In-memory mirrors of chrome.storage.local[GLOBAL_STREAM_KEY] for zero-latency lookups
let GLOBAL_LAST_AUDIO = null;
let GLOBAL_LAST_VIDEO = null;

/**
 * Deduplication map for chrome.webRequest events.
 * Key: requestId (string), Value: expiration timestamp (number)
 *
 * WHY THIS IS CRITICAL:
 * The extension listens to both `onBeforeRequest` and `onResponseStarted`.
 * Both events fire for the exact same network request ID.
 * To avoid duplicate processing and duplicate candidate notifications,
 * request IDs are remembered for 15 seconds.
 */
const RECENT_REQUEST_IDS = new Map();
const REQUEST_ID_TTL_MS = 15000;

/**
 * Clears the in-memory stream capture ring buffer for a given tab.
 *
 * @param {number} tabId - Browser tab ID
 */
function clearStreamCaptureState(tabId) {
    STREAM_CAPTURE_TABS.delete(Number(tabId));
}

/**
 * Retrieves (or initializes) the in-memory capture state structure for a tab.
 *
 * @param {number} tabId - Browser tab ID
 * @returns {{activeProbe: Object|null, probeBuffer: Array<Object>, recentStreams: Array<Object>}}
 */
function streamCaptureState(tabId) {
    const key = Number(tabId);
    let state = STREAM_CAPTURE_TABS.get(key);
    if (!state) {
        state = { activeProbe: null, probeBuffer: [], recentStreams: [] };
        STREAM_CAPTURE_TABS.set(key, state);
    }
    return state;
}

/** Returns the last globally captured audio stream */
function getGlobalLastAudio() { return GLOBAL_LAST_AUDIO; }

/** Returns the last globally captured video stream */
function getGlobalLastVideo() { return GLOBAL_LAST_VIDEO; }

/**
 * Wipes global audio/video caches from both memory and local storage.
 */
function clearGlobalStreams() {
    GLOBAL_LAST_AUDIO = null;
    GLOBAL_LAST_VIDEO = null;
    try { chrome.storage.local.remove([GLOBAL_STREAM_KEY]); } catch (_) {}
}

/**
 * Persists the latest captured stream as the global fallback stream.
 *
 * PURPOSE:
 * If a tab reloads or the content script opens a download overlay before tab formats
 * are fully populated, the extension can fallback to `GLOBAL_LAST_AUDIO` / `GLOBAL_LAST_VIDEO`.
 *
 * @param {string} kind - "audio" or "video"
 * @param {Object} candidate - Captured format descriptor
 * @param {string} rawUrl - Full stream URL
 * @returns {Object} Stored global stream descriptor
 */
function saveGlobalStream(kind, candidate, rawUrl) {
    const entry = {
        url: candidate?.url || cleanURL(rawUrl) || rawUrl,
        originalUrl: candidate?.originalUrl || rawUrl,
        mime: candidate?.mime || (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
        itag: candidate?.itag || '',
        height: candidate?.height || 0,
        contentLength: candidate?.contentLength || 0,
        capturedAt: Date.now(),
        tabId: Number.isInteger(candidate?.tabId) ? candidate.tabId : undefined,
        fileId: candidate?.fileId || ''
    };

    // Update in-memory reference immediately
    if (kind === 'audio') GLOBAL_LAST_AUDIO = entry;
    else GLOBAL_LAST_VIDEO = entry;

    // Serialize persistence to chrome.storage.local
    try {
        globalStreamsQueue = globalStreamsQueue.then(async () => {
            const result = await chrome.storage.local.get([GLOBAL_STREAM_KEY]);
            const prev = result?.[GLOBAL_STREAM_KEY] || {};
            const next = {
                video: kind === 'video' ? entry : (prev.video || GLOBAL_LAST_VIDEO),
                audio: kind === 'audio' ? entry : (prev.audio || GLOBAL_LAST_AUDIO),
                timestamp: Date.now()
            };
            await chrome.storage.local.set({ [GLOBAL_STREAM_KEY]: next });
        }).catch(() => {});
    } catch (_) {}

    return entry;
}

/**
 * Loads stored global stream records from chrome.storage.local on service worker start.
 */
async function loadGlobalStreamsFromStorage() {
    try {
        const result = await chrome.storage.local.get([GLOBAL_STREAM_KEY]);
        const data = result?.[GLOBAL_STREAM_KEY];
        if (data?.audio?.url) GLOBAL_LAST_AUDIO = data.audio;
        if (data?.video?.url) GLOBAL_LAST_VIDEO = data.video;
    } catch (_) {}
}
// Execute on module load to restore memory mirror from disk
loadGlobalStreamsFromStorage();

/**
 * Lightweight classification of media streams (audio vs video).
 *
 * HOW IT WORKS:
 * 1. Checks for `mime=audio` in URL or candidate mime property.
 * 2. Checks against `AUDIO_ITAG_PATTERN` if loaded.
 * 3. Checks for Google Drive's audio output query param `ot=a`.
 * 4. Checks `isAudioStream` helper.
 * 5. Defaults to "video".
 *
 * NOTE ON LOAD ORDER:
 * Defined here because network-capture.js is loaded before format-catalog.js
 * in src/background.js.
 *
 * @param {string} url - Stream URL
 * @param {Object} candidate - Parsed candidate object
 * @returns {'audio'|'video'}
 */
function classifySimple(url, candidate) {
    const raw = String(url || '');
    if (raw.includes('mime=audio') || /audio/i.test(String(candidate?.mime || ''))) return 'audio';
    // Guard in case format-catalog.js has not finished executing yet
    if (typeof AUDIO_ITAG_PATTERN !== 'undefined' && AUDIO_ITAG_PATTERN.test(String(candidate?.itag || ''))) return 'audio';
    // Google's query param ot=a stands for output_type=audio
    if (/[?&]ot=a(?:&|$)/i.test(raw)) return 'audio';
    if (typeof isAudioStream === 'function' && isAudioStream(candidate)) return 'audio';
    return 'video';
}

/**
 * Inserts a candidate into the tab's recent streams ring buffer.
 *
 * HOW IT WORKS:
 * 1. Derives a deduplication key using itag (e.g. "video|itag:137") or URL.
 * 2. Removes any older instance with the exact same key.
 * 3. Adds the fresh stream to the front of the list (`unshift`).
 * 4. Truncates the ring buffer to `RECENT_STREAM_LIMIT` (96 items).
 *
 * @param {number} tabId - Browser tab ID
 * @param {Object} candidate - Stream descriptor
 * @returns {Object|null}
 */
function pushRecentStream(tabId, candidate) {
    if (!Number.isInteger(tabId) || tabId < 0 || !candidate?.url) return null;
    const state = streamCaptureState(tabId);
    const list = Array.isArray(state.recentStreams) ? state.recentStreams : [];
    const kind = classifySimple(candidate.originalUrl || candidate.url, candidate);

    // Formulate deduplication key
    const key = candidate?.itag
        ? `${kind}|itag:${candidate.itag}`
        : `${kind}|${candidate?.mime || ''}|${candidate?.url || ''}`;

    const item = { ...candidate, _dedupeKey: key, observedAt: Date.now() };

    // Evict previous entry with identical key
    const existingIndex = list.findIndex(entry => entry._dedupeKey === key);
    if (existingIndex >= 0) list.splice(existingIndex, 1);

    // Prepend newest capture
    list.unshift(item);
    state.recentStreams = list.slice(0, RECENT_STREAM_LIMIT);
    return item;
}

/**
 * Converts a raw webRequest into a structured network stream candidate.
 *
 * @param {string} url - Request URL
 * @param {Object} meta - Details from webRequest event
 * @returns {Object|null}
 */
function buildNetworkCandidate(url, meta) {
    // Parse using format-catalog's parseStreamCandidate
    const candidate = parseStreamCandidate(url, url);
    if (!candidate) return null;

    // Attach webRequest context metadata
    candidate.source = meta.source || 'webRequest';
    candidate.frameId = Number(meta.frameId ?? -1);
    candidate.requestId = String(meta.requestId || '');
    candidate.type = meta.resourceType || 'Media';
    candidate.capturedAt = Date.now();
    if (Number.isInteger(meta.tabId)) candidate.tabId = meta.tabId;

    // Infer fallback mime type if missing
    const raw = String(url || '');
    if (!candidate.mime) {
        if (raw.includes('mime=audio')) candidate.mime = 'audio/mp4';
        else if (raw.includes('mime=video')) candidate.mime = 'video/mp4';
    }
    return candidate;
}

/**
 * Strict file membership verification.
 *
 * PURPOSE:
 * Ensures a captured stream actually belongs to the file open in this tab.
 * Avoids mixing up video files if a user has multiple Google Drive tabs open simultaneously!
 *
 * RULES:
 * 1. If candidate and session both have a fileId -> must match exactly.
 * 2. If stream URL has an embedded fileId query parameter -> must match session fileId.
 * 3. Cross-tab fan-out (`forFanOut: true`) requires an explicit, positive match.
 * 4. Same tab allows unhinted streams because Google Drive often omits fileId from chunk queries.
 *
 * @param {Object} candidate - Captured stream descriptor
 * @param {URL|string} requestUrl - Request URL object
 * @param {Object} session - Tab video session
 * @param {Object} [options]
 * @param {boolean} [options.forFanOut=false] - Whether testing for cross-tab fan-out
 * @returns {boolean} True if stream belongs to this session
 */
function streamBelongsToSession(candidate, requestUrl, session, { forFanOut = false } = {}) {
    if (!session) return false;
    const sessionFileId = String(session.fileId || '').trim();
    const candidateFileId = String(candidate?.fileId || '').trim();

    // Direct candidate fileId match
    if (candidateFileId && sessionFileId) {
        return candidateFileId === sessionFileId;
    }

    // Inspect URL query parameters for file/drive/doc ID hints
    let hintedFileId = '';
    try {
        const params = requestUrl instanceof URL
            ? requestUrl.searchParams
            : new URL(String(requestUrl || '')).searchParams;
        hintedFileId = String(
            params.get('id') || params.get('driveid') || params.get('fileid') || ''
        ).trim();
    } catch (_) {}

    // Hinted fileId match
    if (hintedFileId && sessionFileId) {
        return hintedFileId === sessionFileId;
    }
    // Candidate has fileId, but session doesn't know its fileId yet (initial capture)
    if (candidateFileId && !sessionFileId) return true;

    // Cross-tab fan-out demands a positive match; do not spray unknown streams to all tabs
    if (forFanOut) return false;
    // Tab has no fileId yet; seed it
    if (!sessionFileId) return true;
    // Same tab, session has fileId, stream has no hint: allow (Drive frequently omits fileId)
    return true;
}

/**
 * Stamped quality probe metadata onto a stream candidate.
 *
 * PURPOSE:
 * When testing qualities, this stamps the candidate with `probeToken`, `probeQuality`,
 * and `probeHeight` so subsequent code knows this stream was generated in response
 * to selecting that specific quality option.
 *
 * @param {Object} candidate - Stream descriptor to mutate
 * @param {Object} probe - Active probe metadata { label, token, startedAt }
 */
function tagCandidateWithProbe(candidate, probe) {
    // Extract numeric height from label (e.g. "1080p" -> 1080)
    const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
    candidate.probeHeight = labelHeight;
    candidate.probeQuality = probe.label || '';
    candidate.probeToken = probe.token || '';

    // Only stamp qualityHeight from the probe label when the candidate has no
    // independent height — never overwrite a real itag-derived height!
    if (labelHeight && classifySimple(candidate.originalUrl || candidate.url, candidate) !== 'audio') {
        if (!Number(candidate.height || 0)) {
            candidate.height = labelHeight;
            candidate.heightSource = 'probe';
        }
        if (!Number(candidate.qualityHeight || 0)) {
            candidate.qualityHeight = Number(candidate.height || labelHeight);
        }
    }
}

/** Helper generating a unique key for the probe buffer */
const probeBufferKey = stream => stream.itag
    ? `${stream.itag}|${classifySimple(stream.originalUrl || stream.url, stream)}`
    : `${stream.mime || ''}|${stream.url}`;

/**
 * Adds a stream candidate to the tab's in-memory probe buffer.
 *
 * @param {Object} state - Tab in-memory capture state
 * @param {Object} candidate - Captured stream descriptor
 */
function addToProbeBuffer(state, candidate) {
    const incomingKey = probeBufferKey(candidate);
    const previous = Array.isArray(state.probeBuffer) ? state.probeBuffer : [];
    // Prepend new candidate, filter out older items matching incomingKey, limit size
    state.probeBuffer = [candidate, ...previous]
        .filter((stream, index) => probeBufferKey(stream) !== incomingKey || index === 0)
        .slice(0, PROBE_BUFFER_LIMIT);
}

/**
 * Atomically stores a newly captured stream into the persisted tab session.
 *
 * HOW IT WORKS:
 * 1. Queues a mutation to `sessionsQueue`.
 * 2. If a probe is active, stamps candidate and updates `session.probeCandidates`.
 * 3. Classifies stream kind:
 *    - Audio: Updates `current.audio`, adds to `audioCandidates`, updates `formats.audio`.
 *    - Video: Updates `current.video`, adds to `videoCandidates`, merges into `formats.video` or `formats.progressive`.
 * 4. Sets `playbackStarted = true` and `streamCaptureEnabled = true`.
 *
 * @param {number} tabId - Browser tab ID
 * @param {Object} session - Current session snapshot
 * @param {Object} candidate - Captured stream descriptor
 * @returns {Promise<Object>}
 */
function storeCandidateInSession(tabId, session, candidate) {
    return queueSessionMutation(tabId, current => {
        if (!current) return false;
        // Prevent race condition if tab navigated to a different file
        if (session.fileId && current.fileId && current.fileId !== session.fileId) return false;

        const activeProbe = current.activeQualityProbe;
        if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
            tagCandidateWithProbe(candidate, activeProbe);
            current.probeCandidates = addUniqueCandidate(current.probeCandidates, candidate, PROBE_BUFFER_LIMIT);
        }

        const kind = classifySimple(candidate.originalUrl || candidate.url, candidate);
        if (kind === 'audio') {
            current.audio = candidate.url;
            current.audioOriginal = candidate.originalUrl;
            current.audioCandidates = addUniqueCandidate(current.audioCandidates, candidate, 8);
            current.formats = current.formats || { video: [], audio: [], progressive: [] };
            current.formats.audio = [{
                ...candidate,
                url: current.audio,
                originalUrl: current.audioOriginal,
                id: candidate.id || `audio:${candidate.itag || formatHash(current.audio)}`
            }];
        } else {
            current.video = candidate.url;
            current.videoOriginal = candidate.originalUrl;
            current.videoCandidates = addUniqueCandidate(current.videoCandidates, candidate, 24);
            current.formats = current.formats || { video: [], audio: [], progressive: [] };

            // Segregate muxed progressive formats from separate adaptive video streams
            if (typeof isMuxedStream === 'function' && isMuxedStream(candidate)) {
                current.formats.progressive = mergeFormatLists(
                    current.formats.progressive,
                    [{ ...candidate, progressive: true }],
                    byHeightWidthThenSize,
                    24
                );
            } else {
                current.formats.video = mergeFormatLists(
                    current.formats.video,
                    [candidate],
                    byHeightWidthThenSize,
                    48
                );
            }
        }
        current.playbackStarted = true;
        current.streamCaptureEnabled = true;
        return current;
    });
}

/**
 * Notifies content script in the browser tab that a new media stream has been intercepted.
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} session - Session snapshot
 * @param {Object} candidate - Captured stream descriptor
 */
function notifyTabOfStream(tabId, session, candidate) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    getStoredSession(Number(tabId))
        .then(latest => sendTab(Number(tabId), {
            type: 'videoStreamDetected',
            stream: candidate,
            fileId: latest?.fileId || session?.fileId || candidate.fileId || '',
            viewerSessionId: latest?.viewerSessionId || session?.viewerSessionId || '',
            formats: {
                video: latest?.formats?.video || latest?.videoCandidates || [],
                audio: latest?.formats?.audio || latest?.audioCandidates || [],
                progressive: latest?.formats?.progressive || []
            }
        }))
        .catch(() => {});
}

/**
 * Matches an orphaned stream against all open Drive tab sessions.
 *
 * PURPOSE:
 * Some network requests have `tabId = -1` (e.g. requests made from sandboxed workers,
 * iframes, or detached contexts). When this happens, `fanOutToActiveSessions` searches
 * all open sessions and attaches the stream to the session with matching fileId.
 *
 * @param {Object} candidate - Stream descriptor
 * @param {URL} requestUrl - Stream request URL
 */
async function fanOutToActiveSessions(candidate, requestUrl) {
    try {
        const all = await chrome.storage.local.get(STREAM_STORE_KEY);
        const sessions = all?.[STREAM_STORE_KEY] || {};
        for (const [key, session] of Object.entries(sessions)) {
            const tabId = Number(key);
            if (!Number.isInteger(tabId) || tabId < 0) continue;
            if (!session || typeof session !== 'object') continue;
            // Only attach if explicit fileId matches
            if (!streamBelongsToSession(candidate, requestUrl, session, { forFanOut: true })) continue;

            pushRecentStream(tabId, candidate);
            await storeCandidateInSession(tabId, session, candidate);
            notifyTabOfStream(tabId, session, candidate);
        }
    } catch (_) {}
}

/**
 * Determines whether this stream should update the global last-known stream caches.
 *
 * @param {number} tabId - Browser tab ID
 * @param {Object} session - Tab session
 * @returns {boolean}
 */
function shouldUpdateGlobal(tabId, session) {
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    if (!session) return false;
    if (session.fileId || session.streamCaptureEnabled || session.playbackStarted) return true;
    const state = streamCaptureState(tabId);
    return !!state?.activeProbe;
}

/**
 * Remembers a request ID to prevent duplicate processing within 15 seconds.
 *
 * HOW IT WORKS:
 * 1. Cleans expired entries when the Map grows beyond 200 items.
 * 2. Returns `true` if requestId was already observed within the TTL.
 * 3. Otherwise records requestId with expiration timestamp and returns `false`.
 *
 * @param {string} requestId - Chrome webRequest ID
 * @returns {boolean} True if request was already processed
 */
function rememberRequestId(requestId) {
    const id = String(requestId || '');
    if (!id) return false;
    const now = Date.now();

    // Garbage collect expired IDs when Map gets large
    if (RECENT_REQUEST_IDS.size > 200) {
        for (const [k, exp] of RECENT_REQUEST_IDS) {
            if (exp <= now) RECENT_REQUEST_IDS.delete(k);
        }
    }

    if (RECENT_REQUEST_IDS.has(id)) return true; // Already processed
    RECENT_REQUEST_IDS.set(id, now + REQUEST_ID_TTL_MS);
    return false;
}

/**
 * Core stream processor: parses, tags, stores, and notifies on intercepted videoplayback URLs.
 *
 * @param {number} tabId - Originating tab ID
 * @param {string} url - Request URL
 * @param {Object} meta - WebRequest event metadata
 */
async function recordNetworkStream(tabId, url, meta = {}) {
    // Only process Google video streaming URLs
    if (!url || !url.includes('videoplayback')) return;

    // Deduplicate dual onBeforeRequest and onResponseStarted listener events
    if (meta.requestId && rememberRequestId(meta.requestId)) return;

    let requestUrl;
    try { requestUrl = new URL(url); } catch (_) { return; }

    // Parse stream candidate descriptor
    const candidate = buildNetworkCandidate(url, { ...meta, tabId });
    if (!candidate) return;

    // Classify audio vs video
    const kind = (typeof classifySimple === 'function')
        ? classifySimple(url, candidate)
        : (/mime=audio/i.test(url) ? 'audio' : 'video');
    if (kind === 'audio') {
        if (!/audio/i.test(String(candidate.mime || ''))) candidate.mime = 'audio/mp4';
    }

    // If request has no valid tab ID (e.g. background service or detached iframe), fan out
    if (!Number.isInteger(tabId) || tabId < 0) {
        await fanOutToActiveSessions(candidate, requestUrl);
        return;
    }

    // Check active quality probe in memory
    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    try {
        let session = await getStoredSession(Number(tabId));
        // Initialize blank session if tab has no stored session yet
        if (!session) {
            session = {
                fileId: '',
                filename: '',
                formats: { video: [], audio: [], progressive: [] },
                videoCandidates: [],
                audioCandidates: [],
                streamCaptureEnabled: true,
                playbackStarted: true
            };
            await setStoredSession(Number(tabId), session);
        }

        // If fileId doesn't match this tab's session, attempt cross-tab fan out
        if (session.fileId && !streamBelongsToSession(candidate, requestUrl, session)) {
            await fanOutToActiveSessions(candidate, requestUrl);
            return;
        }

        // Update global fallback caches if session is active
        if (shouldUpdateGlobal(tabId, session)) {
            saveGlobalStream(kind, candidate, url);
        }

        // Persist candidate into session storage
        await storeCandidateInSession(tabId, session, candidate);
        // Dispatch IPC notification to tab content script
        notifyTabOfStream(tabId, session, candidate);
    } catch (_) {
        try { await fanOutToActiveSessions(candidate, requestUrl); } catch (__) {}
    }
}

/**
 * Event Listener: chrome.webRequest.onBeforeRequest
 *
 * PURPOSE:
 * Catches HTTP media requests at the earliest possible stage, before the browser
 * transmits bytes over the network wire.
 */
chrome.webRequest.onBeforeRequest.addListener(details => {
    const url = String(details.url || '');
    if (!url.includes('videoplayback')) return;
    recordNetworkStream(Number(details.tabId), url, {
        source: 'webRequest',
        requestId: details.requestId,
        frameId: details.frameId,
        resourceType: details.type,
        tabId: details.tabId
    });
}, { urls: ['<all_urls>'] });

/**
 * Event Listener: chrome.webRequest.onResponseStarted
 *
 * PURPOSE:
 * Catches HTTP media responses as soon as headers are received from the server.
 * Provides a reliable second opportunity to capture streams if onBeforeRequest
 * fired before extension initialization.
 */
try {
    chrome.webRequest.onResponseStarted.addListener(details => {
        const url = String(details.url || '');
        if (!url.includes('videoplayback')) return;
        recordNetworkStream(Number(details.tabId), url, {
            source: 'webRequest-response',
            requestId: details.requestId,
            frameId: details.frameId,
            resourceType: details.type,
            tabId: details.tabId
        });
    }, { urls: ['<all_urls>'] });
} catch (_) {}
