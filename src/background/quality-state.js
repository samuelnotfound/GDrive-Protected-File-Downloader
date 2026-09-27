
async function prepareQualityScanState(tabId, expectedFileId = '') {
    if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
    const state = streamCaptureState(tabId);
    state.activeProbe = null;
    state.probeBuffer = [];
    let next = null;
    await queueSessionMutation(tabId, session => {
        if (expectedFileId && session.fileId && session.fileId !== expectedFileId) return false;
        session.activeQualityProbe = null;
        session.probeCandidates = [];
        session.streamCaptureEnabled = true;
        next = session;
        return session;
    });
    return { success: true, session: next };
}

async function beginQualityProbe(tabId, fileId, label) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const state = streamCaptureState(tabId);
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
        audio: filtered.filter(isAudioStream)
    };
}

async function endQualityProbe(tabId, token) {
    const state = streamCaptureState(tabId);
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
        video: mergeFormatLists([], result.video, byHeightThenSize, 48),
        audio: mergeFormatLists([], result.audio, bySizeDesc, 48)
    };
}

async function getQualityProbeCandidates(tabId, token) {
    const state = streamCaptureState(tabId);
    const memory = filterProbeCandidates(Array.isArray(state.probeBuffer) ? state.probeBuffer : [], token);
    const session = await getStoredSession(tabId);
    if (!session) return memory;
    const stored = filterProbeCandidates(Array.isArray(session.probeCandidates) ? session.probeCandidates : [], token);
    return {
        video: mergeFormatLists([], [...memory.video, ...stored.video], byHeightThenSize, 48),
        audio: mergeFormatLists([], [...memory.audio, ...stored.audio], bySizeDesc, 48)
    };
}

async function getCurrentSessionAudioCandidate(tabId) {
    const session = await getStoredSession(tabId);
    const state = streamCaptureState(tabId);
    const pool = [
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(Array.isArray(state?.recentStreams) ? state.recentStreams.filter(isAudioStream) : [])
    ].filter(item => item?.url);
    return dedupeAudioFormats(pool).sort((a, b) =>
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;
}

