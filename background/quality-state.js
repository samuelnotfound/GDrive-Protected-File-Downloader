// Quality-probe state and captured-stream correlation.



async function prepareQualityScanState(tabId, expectedFileId = '') {
    if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
    const state = debuggerNetworkState(tabId);
    state.activeProbe = null;
    state.probeBuffer = [];
    let next = null;
    await queueSessionMutation(tabId, session => {
        if (expectedFileId && session.fileId && session.fileId !== expectedFileId) return false;
        // IMPORTANT: do not wipe the live stream history here. The user may have
        // already played 360p -> 720p -> 1080p before pressing Download. Those
        // signed videoplayback URLs belong to this exact file/viewer session and
        // are valuable evidence. Only the temporary probe state is cleared.
        session.activeQualityProbe = null;
        session.probeCandidates = [];
        session.streamCaptureEnabled = true;
        next = session;
        return session;
    });
    return { success: true, session: next };
}

async function resetVideoCaptureState(tabId, expectedFileId = '') {
    if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
    const state = debuggerNetworkState(tabId);
    state.activeProbe = null;
    state.probeBuffer = [];
    let next = null;
    await queueSessionMutation(tabId, session => {
        if (expectedFileId && session.fileId && session.fileId !== expectedFileId) return false;
        session.video = null;
        session.audio = null;
        session.videoOriginal = null;
        session.audioOriginal = null;
        session.videoCandidates = [];
        session.audioCandidates = [];
        session.formats = { video: [], audio: [], progressive: [] };
        session.formatsFetchedAt = 0;
        session.legacyFormatsFetchedAt = 0;
        session.activeQualityProbe = null;
        session.probeCandidates = [];
        session.playbackStarted = false;
        session.streamCaptureEnabled = false;
        session.timestamp = null;
        next = session;
        return session;
    });
    return { success: true, session: next };
}

chrome.webRequest.onBeforeRequest.addListener(details => {
    const tabId = Number(details.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const url = String(details.url || '');
    if (!url.includes('/videoplayback')) return;
    // Backup detector: feed the exact same low-latency capture path used by the
    // debugger. This prevents webRequest and debugger from maintaining separate
    // candidate lists that can disagree about which URL was seen.
    recordDebuggerNetworkStream(tabId, url, {
        source: 'webRequest',
        requestId: details.requestId,
        frameId: details.frameId,
        resourceType: details.type
    });
}, { urls: ['*://*/videoplayback*'] });


function dedupeScannedFormats(formats = {}) {
    const videoMap = new Map();
    const audioMap = new Map();
    const add = (map, fmt) => {
        if (!fmt?.url) return;
        const itag = String(fmt.itag || '').trim();
        const kind = /audio/i.test(String(fmt.mime || '')) ? 'audio' : 'video';
        const key = itag
            ? `${kind}|itag:${itag}|${Number(fmt.width || 0)}x${Number(fmt.height || 0)}|${String(fmt.probeQuality || '')}`
            : `${kind}|${fmt.width || 0}x${fmt.height || 0}|${fmt.mime || ''}|${fmt.contentLength || 0}`;
        const previous = map.get(key);
        if (!previous || Number(fmt.capturedAt || 0) >= Number(previous.capturedAt || 0)) map.set(key, fmt);
    };
    for (const item of Array.isArray(formats.video) ? formats.video : []) add(videoMap, item);
    for (const item of Array.isArray(formats.audio) ? formats.audio : []) add(audioMap, item);
    return {
        video: [...videoMap.values()].sort((a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength)),
        audio: [...audioMap.values()].sort((a,b) => (b.contentLength-a.contentLength)),
        progressive: []
    };
}

async function beginQualityProbe(tabId, fileId, label) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const state = debuggerNetworkState(tabId);
    state.activeProbe = { token, label: String(label || ''), startedAt };
    state.probeBuffer = [];
    let result = null;
    await queueSessionMutation(tabId, session => {
        if (fileId && session.fileId && session.fileId !== fileId) return false;
        session.activeQualityProbe = { token, label: String(label || ''), startedAt };
        session.streamCaptureEnabled = true;
        session.probeCandidates = [];
        result = session;
        return session;
    });
    return { token, startedAt, session: result };
}

function filterProbeCandidates(all = [], token = '') {
    const list = Array.isArray(all) ? all : [];
    const filtered = token ? list.filter(item => item?.probeToken === token) : list;
    return {
        video: filtered.filter(item => /video/i.test(String(item?.mime || '')) || (!/audio/i.test(String(item?.mime || '')) && item?.itag)),
        audio: filtered.filter(item => /audio/i.test(String(item?.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(item?.itag || '')))
    };
}

async function endQualityProbe(tabId, token) {
    const state = debuggerNetworkState(tabId);
    let result = filterProbeCandidates(Array.isArray(state.probeBuffer) ? state.probeBuffer : [], token);
    await queueSessionMutation(tabId, session => {
        const probe = session.activeQualityProbe;
        if (!probe || (token && probe.token !== token)) return false;
        const stored = filterProbeCandidates(Array.isArray(session.probeCandidates) ? session.probeCandidates : [], token);
        result = {
            video: [...result.video, ...stored.video],
            audio: [...result.audio, ...stored.audio]
        };
        session.activeQualityProbe = null;
        session.probeCandidates = [];
        if (!session.playbackStarted) session.streamCaptureEnabled = false;
        return session;
    });
    if (state.activeProbe?.token === token) state.activeProbe = null;
    state.probeBuffer = [];
    return {
        video: mergeFormatLists([], result.video, (a,b) => (Number(b.height||0)-Number(a.height||0)) || (Number(b.contentLength||0)-Number(a.contentLength||0)), 48),
        audio: mergeFormatLists([], result.audio, (a,b) => Number(b.contentLength||0)-Number(a.contentLength||0), 48)
    };
}

async function getQualityProbeCandidates(tabId, token) {
    const state = debuggerNetworkState(tabId);
    const memory = filterProbeCandidates(Array.isArray(state.probeBuffer) ? state.probeBuffer : [], token);
    const session = await getStoredSession(tabId);
    if (!session) return memory;
    const stored = filterProbeCandidates(Array.isArray(session.probeCandidates) ? session.probeCandidates : [], token);
    return {
        video: mergeFormatLists([], [...memory.video, ...stored.video], (a,b) => (Number(b.height||0)-Number(a.height||0)) || (Number(b.contentLength||0)-Number(a.contentLength||0)), 48),
        audio: mergeFormatLists([], [...memory.audio, ...stored.audio], (a,b) => Number(b.contentLength||0)-Number(a.contentLength||0), 48)
    };
}

async function fetchAndAnnotateCapturedStream(format, expectedFileId = '') {
    if (!format?.url) return null;
    try {
        const probe = await backgroundProbeCapturedFormat(format, expectedFileId);
        return {
            ...format,
            backgroundFetched: true,
            backgroundProbe: probe,
            contentLength: Number(probe?.totalBytes || format.contentLength || 0)
        };
    } catch (error) {
        // The player already generated this signed URL, so a failed secondary
        // probe is never a reason to throw away the stream. Keep the URL and
        // annotate the failure for diagnostics.
        return {
            ...format,
            backgroundFetched: false,
            backgroundProbe: { ok:false, reason:error?.message || String(error) }
        };
    }
}

async function getCurrentSessionAudioCandidate(tabId) {
    const session = await getStoredSession(tabId);
    const state = debuggerNetworkState(tabId);
    const pool = [
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(Array.isArray(state?.recentStreams) ? state.recentStreams.filter(x => /audio/i.test(String(x?.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(x?.itag || ''))) : [])
    ].filter(x => x?.url);
    const unique = [];
    const seen = new Set();
    for (const item of pool) {
        const key = item.itag ? `itag:${item.itag}` : cleanURL(item.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique.sort((a,b) =>
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;
}

async function captureAndFetchQualityPair(tabId, fileId, height, probeResult) {
    const matchingVideo = (probeResult?.video || []).filter(x => Number(x?.height || 0) === Number(height));
    const video = chooseProbeCandidate(matchingVideo.length ? matchingVideo : (probeResult?.video || []), height, `${height}p`);
    let audio = chooseProbeCandidate(probeResult?.audio || [], 0, 'audio');
    if (!audio) audio = await getCurrentSessionAudioCandidate(tabId);

    const [videoFetched, audioFetched] = await Promise.all([
        video ? fetchAndAnnotateCapturedStream(video, fileId) : Promise.resolve(null),
        audio ? fetchAndAnnotateCapturedStream(audio, fileId) : Promise.resolve(null)
    ]);

    return {
        height: Number(height) || 0,
        video: videoFetched || video || null,
        audio: audioFetched || audio || null,
        capturedAt: Date.now()
    };
}

