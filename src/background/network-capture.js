const RECENT_STREAM_LIMIT = 96;
const PROBE_BUFFER_LIMIT = 48;
const GLOBAL_STREAM_KEY = 'psdGlobalStreams';

// In-memory mirrors of chrome.storage.local[GLOBAL_STREAM_KEY]
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
    try { chrome.storage.local.remove([GLOBAL_STREAM_KEY]); } catch (_) {}
}


/** Persist + memory, no tab/session gates — same as the simple plugin. */
function saveGlobalStream(kind, candidate, rawUrl) {
    const entry = {
        url: candidate?.url || cleanURL(rawUrl) || rawUrl,
        originalUrl: candidate?.originalUrl || rawUrl,
        mime: candidate?.mime || (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
        itag: candidate?.itag || '',
        height: candidate?.height || 0,
        contentLength: candidate?.contentLength || 0,
        capturedAt: Date.now()
    };
    if (kind === 'audio') GLOBAL_LAST_AUDIO = entry;
    else GLOBAL_LAST_VIDEO = entry;

    // Fire-and-forget durable store so SW sleep does not erase it.
    try {
        chrome.storage.local.get([GLOBAL_STREAM_KEY], result => {
            const prev = result?.[GLOBAL_STREAM_KEY] || {};
            const next = {
                video: kind === 'video' ? entry : (prev.video || GLOBAL_LAST_VIDEO),
                audio: kind === 'audio' ? entry : (prev.audio || GLOBAL_LAST_AUDIO),
                timestamp: Date.now()
            };
            chrome.storage.local.set({ [GLOBAL_STREAM_KEY]: next });
        });
    } catch (_) {}
    return entry;
}

async function loadGlobalStreamsFromStorage() {
    try {
        const result = await chrome.storage.local.get([GLOBAL_STREAM_KEY]);
        const data = result?.[GLOBAL_STREAM_KEY];
        if (data?.audio?.url) GLOBAL_LAST_AUDIO = data.audio;
        if (data?.video?.url) GLOBAL_LAST_VIDEO = data.video;
    } catch (_) {}
}
// Warm from storage when SW starts.
loadGlobalStreamsFromStorage();

/**
 * Simple-plugin classification:
 *   url has mime=audio → audio
 *   url has mime=video → video
 *   known audio itag   → audio
 *   else               → video
 */
function classifySimple(url, candidate) {
    const raw = String(url || '');
    if (raw.includes('mime=audio') || /audio/i.test(String(candidate?.mime || ''))) return 'audio';
    if (AUDIO_ITAG_PATTERN.test(String(candidate?.itag || ''))) return 'audio';
    // YouTube/Drive sometimes marks audio-only with ot=a
    if (/[?&]ot=a(?:&|$)/i.test(raw)) return 'audio';
    if (isAudioStream(candidate)) return 'audio';
    return 'video';
}

function pushRecentStream(tabId, candidate) {
    if (!Number.isInteger(tabId) || tabId < 0) return candidate;
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
    const raw = String(url || '');
    if (!candidate.mime) {
        if (raw.includes('mime=audio')) candidate.mime = 'audio/mp4';
        else if (raw.includes('mime=video')) candidate.mime = 'video/mp4';
    }
    return candidate;
}

function streamBelongsToSession(candidate, requestUrl, session) {
    if (!session) return true;
    if (candidate.fileId && session.fileId) return candidate.fileId === session.fileId;
    if (candidate.fileId || !session.fileId) return true;
    const params = requestUrl.searchParams;
    const hintedFileId = params.get('id') || params.get('driveid') || params.get('fileid') || '';
    return !hintedFileId || hintedFileId === session.fileId;
}

function tagCandidateWithProbe(candidate, probe) {
    const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
    candidate.probeHeight = labelHeight;
    candidate.probeQuality = probe.label || '';
    candidate.probeToken = probe.token || '';
    if (labelHeight && classifySimple(candidate.originalUrl || candidate.url, candidate) !== 'audio') {
        candidate.qualityHeight = labelHeight;
        if (!Number(candidate.height || 0)) {
            candidate.height = labelHeight;
            candidate.heightSource = 'probe';
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
                candidate.qualityHeight = labelHeight;
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
            if (isMuxedStream(candidate)) {
                current.formats.progressive = mergeFormatLists(
                    current.formats.progressive,
                    [{ ...candidate, progressive: true }],
                    byHeightWidthThenSize,
                    24
                );
            } else {
                current.formats.video = mergeFormatLists(current.formats.video, [candidate], byHeightWidthThenSize, 48);
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

async function fanOutToActiveSessions(candidate, requestUrl) {
    try {
        const all = await chrome.storage.local.get(STREAM_STORE_KEY);
        const sessions = all?.[STREAM_STORE_KEY] || {};
        for (const [key, session] of Object.entries(sessions)) {
            const tabId = Number(key);
            if (!Number.isInteger(tabId) || tabId < 0) continue;
            if (!session || typeof session !== 'object') continue;
            if (!streamBelongsToSession(candidate, requestUrl, session)) continue;
            pushRecentStream(tabId, candidate);
            await storeCandidateInSession(tabId, session, candidate);
            notifyTabOfStream(tabId, session, candidate);
        }
    } catch (_) {}
}

/**
 * ALWAYS-ON — identical idea to the simple plugin.
 * 1) Classify by mime= string in URL
 * 2) Save globally (memory + chrome.storage.local)
 * 3) Also attach to tab session when possible
 */
async function recordNetworkStream(tabId, url, meta = {}) {
    if (!url || !url.includes('videoplayback')) return;

    let requestUrl;
    try { requestUrl = new URL(url); } catch (_) { return; }

    const candidate = buildNetworkCandidate(url, meta);
    if (!candidate) return;

    const kind = classifySimple(url, candidate);
    if (kind === 'audio') {
        if (!/audio/i.test(String(candidate.mime || ''))) candidate.mime = 'audio/mp4';
    }
    saveGlobalStream(kind, candidate, url);

    // No valid tab → still fan out to any open Drive sessions
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
            // Still fan-out in case session is keyed differently
            await fanOutToActiveSessions(candidate, requestUrl);
            return;
        }
        if (!streamBelongsToSession(candidate, requestUrl, session)) return;
        await storeCandidateInSession(tabId, session, candidate);
        notifyTabOfStream(tabId, session, candidate);
    } catch (_) {}
}

// Simple plugin filter: every URL, match videoplayback in the handler.
chrome.webRequest.onBeforeRequest.addListener(details => {
    const url = String(details.url || '');
    if (!url.includes('videoplayback')) return;
    recordNetworkStream(Number(details.tabId), url, {
        source: 'webRequest',
        requestId: details.requestId,
        frameId: details.frameId,
        resourceType: details.type
    });
}, { urls: ['<all_urls>'] });

// Extra: also catch on response start (some SW restarts miss onBeforeRequest race).
try {
    chrome.webRequest.onResponseStarted.addListener(details => {
        const url = String(details.url || '');
        if (!url.includes('videoplayback')) return;
        recordNetworkStream(Number(details.tabId), url, {
            source: 'webRequest-response',
            requestId: details.requestId,
            frameId: details.frameId,
            resourceType: details.type
        });
    }, { urls: ['<all_urls>'] });
} catch (_) {}
