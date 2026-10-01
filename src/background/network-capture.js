const RECENT_STREAM_LIMIT = 96;
const PROBE_BUFFER_LIMIT = 48;
const GLOBAL_STREAM_KEY = 'psdGlobalStreams';
let globalStreamsQueue = Promise.resolve();

// In-memory mirrors of chrome.storage.session[GLOBAL_STREAM_KEY]
let GLOBAL_LAST_AUDIO = null;
let GLOBAL_LAST_VIDEO = null;

function clearStreamCaptureState(tabId) {
    STREAM_CAPTURE_TABS.delete(Number(tabId));
}

function streamCaptureState(tabId) {
    const key = Number(tabId);
    let state = STREAM_CAPTURE_TABS.get(key);
    if (!state) {
        state = { activeProbe: null, probeBuffer: [], recentStreams: [] };
        STREAM_CAPTURE_TABS.set(key, state);
    }
    return state;
}

function getGlobalLastAudio() { return GLOBAL_LAST_AUDIO; }
function getGlobalLastVideo() { return GLOBAL_LAST_VIDEO; }

function clearGlobalStreams() {
    GLOBAL_LAST_AUDIO = null;
    GLOBAL_LAST_VIDEO = null;
    try { chrome.storage.session.remove([GLOBAL_STREAM_KEY]); } catch (_) {}
}

/** Persist + memory. Only call when the stream belongs to an active Drive session on this tab. */
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
    if (kind === 'audio') GLOBAL_LAST_AUDIO = entry;
    else GLOBAL_LAST_VIDEO = entry;

    // Serialize persisted global updates (same idea as sessionsQueue).
    try {
        globalStreamsQueue = globalStreamsQueue.then(async () => {
            const result = await chrome.storage.session.get([GLOBAL_STREAM_KEY]);
            const prev = result?.[GLOBAL_STREAM_KEY] || {};
            const next = {
                video: kind === 'video' ? entry : (prev.video || GLOBAL_LAST_VIDEO),
                audio: kind === 'audio' ? entry : (prev.audio || GLOBAL_LAST_AUDIO),
                timestamp: Date.now()
            };
            await chrome.storage.session.set({ [GLOBAL_STREAM_KEY]: next });
        }).catch(() => {});
    } catch (_) {}
    return entry;
}

async function loadGlobalStreamsFromStorage() {
    try {
        const result = await chrome.storage.session.get([GLOBAL_STREAM_KEY]);
        const data = result?.[GLOBAL_STREAM_KEY];
        if (data?.audio?.url) GLOBAL_LAST_AUDIO = data.audio;
        if (data?.video?.url) GLOBAL_LAST_VIDEO = data.video;
    } catch (_) {}
}
loadGlobalStreamsFromStorage();

/**
 * Simple-plugin classification:
 *   url has mime=audio → audio
 *   url has mime=video → video
 *   known audio itag   → audio
 *   else               → video
 * Defined here because network-capture loads before format-catalog.
 */
function classifySimple(url, candidate) {
    const raw = String(url || '');
    if (raw.includes('mime=audio') || /audio/i.test(String(candidate?.mime || ''))) return 'audio';
    // AUDIO_ITAG_PATTERN is defined in format-catalog; guard if load order changes.
    if (typeof AUDIO_ITAG_PATTERN !== 'undefined' && AUDIO_ITAG_PATTERN.test(String(candidate?.itag || ''))) return 'audio';
    if (/[?&]ot=a(?:&|$)/i.test(raw)) return 'audio';
    if (typeof isAudioStream === 'function' && isAudioStream(candidate)) return 'audio';
    return 'video';
}

function pushRecentStream(tabId, candidate) {
    if (!Number.isInteger(tabId) || tabId < 0 || !candidate?.url) return null;
    const state = streamCaptureState(tabId);
    const list = Array.isArray(state.recentStreams) ? state.recentStreams : [];
    const kind = classifySimple(candidate.originalUrl || candidate.url, candidate);
    const key = candidate?.itag
        ? `${kind}|itag:${candidate.itag}`
        : `${kind}|${candidate?.mime || ''}|${candidate?.url || ''}`;
    const item = { ...candidate, _dedupeKey: key, observedAt: Date.now() };
    const existingIndex = list.findIndex(entry => entry._dedupeKey === key);
    if (existingIndex >= 0) list.splice(existingIndex, 1);
    list.unshift(item);
    state.recentStreams = list.slice(0, RECENT_STREAM_LIMIT);
    return item;
}

function buildNetworkCandidate(url, meta) {
    const candidate = parseStreamCandidate(url, url);
    if (!candidate) return null;
    candidate.source = meta.source || 'webRequest';
    candidate.frameId = Number(meta.frameId ?? -1);
    candidate.requestId = String(meta.requestId || '');
    candidate.type = meta.resourceType || 'Media';
    candidate.capturedAt = Date.now();
    if (Number.isInteger(meta.tabId)) candidate.tabId = meta.tabId;
    const raw = String(url || '');
    if (!candidate.mime) {
        if (raw.includes('mime=audio')) candidate.mime = 'audio/mp4';
        else if (raw.includes('mime=video')) candidate.mime = 'video/mp4';
    }
    return candidate;
}

/**
 * Strict membership: only attach when we can positively match the file, or when
 * the session has no fileId yet (first capture on a tab). Never treat "missing
 * hints on either side" as a match for cross-tab fan-out.
 */
function streamBelongsToSession(candidate, requestUrl, session, { forFanOut = false } = {}) {
    if (!session) return false;
    const sessionFileId = String(session.fileId || '').trim();
    const candidateFileId = String(candidate?.fileId || '').trim();

    if (candidateFileId && sessionFileId) {
        return candidateFileId === sessionFileId;
    }

    let hintedFileId = '';
    try {
        const params = requestUrl instanceof URL
            ? requestUrl.searchParams
            : new URL(String(requestUrl || '')).searchParams;
        hintedFileId = String(
            params.get('id') || params.get('driveid') || params.get('fileid') || ''
        ).trim();
    } catch (_) {}

    if (hintedFileId && sessionFileId) {
        return hintedFileId === sessionFileId;
    }
    if (candidateFileId && !sessionFileId) return true;

    // Fan-out requires an explicit file match; same-tab attach may seed a session
    // that does not yet know its fileId.
    if (forFanOut) return false;
    if (!sessionFileId) return true;
    // Same tab, session has fileId, stream has no hint: allow (Drive often omits id).
    return true;
}

function tagCandidateWithProbe(candidate, probe) {
    const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
    candidate.probeHeight = labelHeight;
    candidate.probeQuality = probe.label || '';
    candidate.probeToken = probe.token || '';
    // Only stamp qualityHeight from the probe label when the candidate has no
    // independent height — never overwrite a real itag-derived height.
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

const probeBufferKey = stream => stream.itag
    ? `${stream.itag}|${classifySimple(stream.originalUrl || stream.url, stream)}`
    : `${stream.mime || ''}|${stream.url}`;

function addToProbeBuffer(state, candidate) {
    const incomingKey = probeBufferKey(candidate);
    const previous = Array.isArray(state.probeBuffer) ? state.probeBuffer : [];
    state.probeBuffer = [candidate, ...previous]
        .filter((stream, index) => probeBufferKey(stream) !== incomingKey || index === 0)
        .slice(0, PROBE_BUFFER_LIMIT);
}

function storeCandidateInSession(tabId, session, candidate) {
    return queueSessionMutation(tabId, current => {
        if (!current) return false;
        if (session.fileId && current.fileId && current.fileId !== session.fileId) return false;

        const activeProbe = current.activeQualityProbe;
        if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
            candidate.probeQuality = activeProbe.label || candidate.probeQuality || '';
            candidate.probeToken = activeProbe.token || candidate.probeToken || '';
            const labelHeight = Number(String(activeProbe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
            if (labelHeight && classifySimple(candidate.originalUrl || candidate.url, candidate) !== 'audio') {
                if (!Number(candidate.height || 0)) {
                    candidate.height = labelHeight;
                    candidate.heightSource = 'probe';
                }
                if (!Number(candidate.qualityHeight || 0)) {
                    candidate.qualityHeight = Number(candidate.height || labelHeight);
                }
                candidate.probeHeight = labelHeight;
            }
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
 * Only attach to sessions that positively match the stream's file id.
 * Never spray an unhinted stream across every open tab.
 */
async function fanOutToActiveSessions(candidate, requestUrl) {
    try {
        const all = await chrome.storage.session.get(STREAM_STORE_KEY);
        const sessions = all?.[STREAM_STORE_KEY] || {};
        for (const [key, session] of Object.entries(sessions)) {
            const tabId = Number(key);
            if (!Number.isInteger(tabId) || tabId < 0) continue;
            if (!session || typeof session !== 'object') continue;
            if (!streamBelongsToSession(candidate, requestUrl, session, { forFanOut: true })) continue;
            pushRecentStream(tabId, candidate);
            await storeCandidateInSession(tabId, session, candidate);
            notifyTabOfStream(tabId, session, candidate);
        }
    } catch (_) {}
}

function shouldUpdateGlobal(tabId, session) {
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    if (!session) return false;
    if (session.fileId || session.streamCaptureEnabled || session.playbackStarted) return true;
    const state = streamCaptureState(tabId);
    return !!state?.activeProbe;
}


/**
 * Capture videoplayback requests. Scoped primarily to the originating tab's
 * session; globals only update for sessions that are actively capturing.
 */
async function recordNetworkStream(tabId, url, meta = {}) {
    if (!url || !url.includes('videoplayback')) return;

    let requestUrl;
    try { requestUrl = new URL(url); } catch (_) { return; }

    const candidate = buildNetworkCandidate(url, { ...meta, tabId });
    if (!candidate) return;

    const kind = (typeof classifySimple === 'function')
        ? classifySimple(url, candidate)
        : (/mime=audio/i.test(url) ? 'audio' : 'video');
    if (kind === 'audio') {
        if (!/audio/i.test(String(candidate.mime || ''))) candidate.mime = 'audio/mp4';
    }

    if (!Number.isInteger(tabId) || tabId < 0) {
        await fanOutToActiveSessions(candidate, requestUrl);
        return;
    }

    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    try {
        let session = await getStoredSession(Number(tabId));
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

        if (session.fileId && !streamBelongsToSession(candidate, requestUrl, session)) {
            await fanOutToActiveSessions(candidate, requestUrl);
            return;
        }

        if (shouldUpdateGlobal(tabId, session)) {
            saveGlobalStream(kind, candidate, url);
        }

        await storeCandidateInSession(tabId, session, candidate);
        notifyTabOfStream(tabId, session, candidate);
    } catch (_) {
        try { await fanOutToActiveSessions(candidate, requestUrl); } catch (__) {}
    }
}

chrome.webRequest.onBeforeRequest.addListener(details => {
    const url = String(details.url || '');
    if (!url.includes('videoplayback')) return;
    recordNetworkStream(Number(details.tabId), url, {
        source: 'webRequest',
        frameId: details.frameId,
        resourceType: details.type,
        tabId: details.tabId
    });
}, { urls: ['<all_urls>'] });

// Older builds stored transient signed stream URLs in persistent local storage.
// Remove those legacy copies once; current builds keep them only in session storage.
try {
    void chrome.storage.local.remove([STREAM_STORE_KEY, GLOBAL_STREAM_KEY]);
} catch (_) {}
