const RECENT_STREAM_LIMIT = 96;
const PROBE_BUFFER_LIMIT = 48;

function clearStreamCaptureState(tabId) {
    STREAM_CAPTURE_TABS.delete(Number(tabId));
}

function streamCaptureState(tabId) {
    const key = Number(tabId);
    let state = STREAM_CAPTURE_TABS.get(key);
    if (!state) {
        state = {
            activeProbe: null,
            probeBuffer: [],
            recentStreams: []
        };
        STREAM_CAPTURE_TABS.set(key, state);
    }
    return state;
}

function pushRecentStream(tabId, candidate) {
    const state = streamCaptureState(tabId);
    const list = Array.isArray(state.recentStreams) ? state.recentStreams : [];
    const kind = isAudioStream(candidate) ? 'audio' : 'video';
    const key = candidate?.itag
        ? `${kind}|itag:${candidate.itag}|q:${Number(candidate?.height || 0)}|w:${Number(candidate?.width || 0)}`
        : `${kind}|${candidate?.mime || ''}|${candidate?.width || 0}x${candidate?.height || 0}|${candidate?.url || ''}`;
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
    return candidate;
}

function streamBelongsToSession(candidate, requestUrl, session) {
    if (candidate.fileId && session.fileId) return candidate.fileId === session.fileId;
    if (candidate.fileId || !session.fileId) return true;
    const params = requestUrl.searchParams;
    const hintedFileId = params.get('id') || params.get('driveid') || params.get('fileid') || '';
    return !hintedFileId || hintedFileId === session.fileId;
}

/**
 * While a quality is being probed, the probe label is the authority for which quality a request belongs to.
 * The label height is only FILLED IN when the URL carries no height itself: stamping it on every request
 * used to record a stray request for the still-playing quality as the quality being probed.
 */
function tagCandidateWithProbe(candidate, probe) {
    const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
    candidate.probeHeight = labelHeight;
    if (labelHeight && !isAudioStream(candidate) && !Number(candidate.height || 0)) {
        candidate.height = labelHeight;
        candidate.heightSource = 'probe';
    }
    candidate.probeQuality = probe.label || '';
    candidate.probeToken = probe.token || '';
}

const probeBufferKey = stream => stream.itag
    ? `${stream.itag}|${/audio/i.test(String(stream.mime || '')) ? 'audio' : 'video'}`
    : `${stream.mime || ''}|${stream.width || 0}x${stream.height || 0}|${stream.url}`;

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
        if (current.viewerSessionId !== session.viewerSessionId || current.fileId !== session.fileId) return false;

        const activeProbe = current.activeQualityProbe;
        if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
            candidate.probeQuality = activeProbe.label || candidate.probeQuality || '';
            candidate.probeToken = activeProbe.token || candidate.probeToken || '';
            current.probeCandidates = addUniqueCandidate(current.probeCandidates, candidate, PROBE_BUFFER_LIMIT);
        }

        if (isAudioStream(candidate)) {
            current.audio = candidate.url;
            current.audioOriginal = candidate.originalUrl;
            current.audioCandidates = addUniqueCandidate(current.audioCandidates, candidate, 24);
        } else {
            current.video = candidate.url;
            current.videoOriginal = candidate.originalUrl;
            current.videoCandidates = addUniqueCandidate(current.videoCandidates, candidate, 24);
        }
        current.playbackStarted = true;
        current.streamCaptureEnabled = true;
        return current;
    });
}

function notifyTabOfStream(tabId, session, candidate) {
    getStoredSession(Number(tabId))
        .then(latest => sendTab(Number(tabId), {
            type: 'videoStreamDetected',
            stream: candidate,
            fileId: latest?.fileId || session.fileId || candidate.fileId || '',
            viewerSessionId: latest?.viewerSessionId || session.viewerSessionId || '',
            formats: { video: latest?.videoCandidates || [], audio: latest?.audioCandidates || [], progressive: [] }
        }))
        .catch(() => {});
}

async function recordNetworkStream(tabId, url, meta = {}) {
    if (!url || !url.includes('/videoplayback')) return;
    let requestUrl;
    try { requestUrl = new URL(url); } catch (_) { return; }
    const candidate = buildNetworkCandidate(url, meta);
    if (!candidate) return;

    // Probe state lives in memory: requests arrive faster than the storage queue can be updated.
    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    const session = await getStoredSession(Number(tabId));
    if (!session) return;
    const isCapturing = session.streamCaptureEnabled || activeProbe;
    if (!isCapturing || !streamBelongsToSession(candidate, requestUrl, session)) return;

    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    try {
        await storeCandidateInSession(tabId, session, candidate);
        notifyTabOfStream(tabId, session, candidate);
    } catch (_) {}
}

chrome.webRequest.onBeforeRequest.addListener(details => {
    const tabId = Number(details.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) return;
    if (!String(details.url || '').includes('/videoplayback')) return;
    recordNetworkStream(tabId, String(details.url), {
        source: 'webRequest',
        requestId: details.requestId,
        frameId: details.frameId,
        resourceType: details.type
    });
}, { urls: ['*://*/videoplayback*'] });
