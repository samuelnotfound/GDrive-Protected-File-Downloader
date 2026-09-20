// Network discovery and signed Drive playback URL capture.


function debuggerNetworkState(tabId) {
    const key = Number(tabId);
    let state = DEBUGGER_NETWORK_TABS.get(key);
    if (!state) {
        state = {
            attached:false,
            networkEnabled:false,
            qualityScanKeepAttached:false,
            activeProbe:null,
            probeBuffer:[],
            recentStreams:[],
            seenNetworkEvents:new Set(),
            qualityContexts:new Map(),
            runtimeEnabled:false
        };
        DEBUGGER_NETWORK_TABS.set(key, state);
    }
    return state;
}

function pushDebuggerRecentStream(tabId, candidate) {
    const state = debuggerNetworkState(tabId);
    const list = Array.isArray(state.recentStreams) ? state.recentStreams : [];
    const isAudio = /audio/i.test(String(candidate?.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(candidate?.itag || ''));
    // Drive can reuse the same itag across quality-switch requests in the viewer.
    // Do NOT use itag alone as the identity, or 1080p -> 720p -> 360p collapses to the last URL.
    const quality = Number(candidate?.height || 0);
    const key = candidate?.itag
        ? `${isAudio ? 'audio' : 'video'}|itag:${candidate.itag}|q:${quality || 0}|w:${Number(candidate?.width || 0)}`
        : `${isAudio ? 'audio' : 'video'}|${candidate?.mime || ''}|${candidate?.width || 0}x${candidate?.height || 0}|${candidate?.url || ''}`;
    const item = { ...candidate, _dedupeKey:key, observedAt:Date.now() };
    const idx = list.findIndex(x => x._dedupeKey === key);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(item);
    state.recentStreams = list.slice(0, 96);
    return item;
}

async function recordDebuggerNetworkStream(tabId, url, meta = {}) {
    if (!url || !url.includes('/videoplayback')) return;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return; }
    const candidate = parseStreamCandidate(url, url);
    if (!candidate) return;
    candidate.source = meta.source || 'debugger-network';
    candidate.frameId = Number(meta.frameId ?? -1);
    candidate.requestId = String(meta.requestId || '');
    candidate.type = meta.resourceType || 'Media';
    candidate.capturedAt = Date.now();

    // Keep probe state in the debugger map, not only chrome.storage. Network
    // events can arrive faster than the storage mutation queue can be updated.
    const state = debuggerNetworkState(tabId);
    const activeProbe = state.activeProbe;
    const session = await getStoredSession(Number(tabId));
    if (!session) return;
    if (!session.streamCaptureEnabled && !activeProbe && !state.qualityScanKeepAttached) return;

    if (candidate.fileId && session.fileId && candidate.fileId !== session.fileId) return;
    if (!candidate.fileId && session.fileId) {
        const hinted = parsed.searchParams.get('id') || parsed.searchParams.get('driveid') || parsed.searchParams.get('fileid') || '';
        if (hinted && hinted !== session.fileId) return;
    }

    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        // Some Drive playback requests reuse the same itag while the player switches
        // quality. The active probe label is therefore authoritative for this capture.
        // Attach the probed height so 1080/720/360 remain separate even when Drive
        // does not put a distinguishing height in the URL itself.
        const probeMatch = String(activeProbe.label || '').match(/(\d{3,4})p/i);
        const isAudioCandidate = /audio/i.test(String(candidate.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(candidate.itag || ''));
        candidate.probeHeight = probeMatch ? Number(probeMatch[1]) : 0;
        // v1.81: only FILL IN a height when the URL itself does not identify one.
        // Previously every request seen during a probe window was stamped with the probe's
        // height, so a stray request for the quality that was still playing (Drive keeps
        // fetching ranges of it while a switch is pending) was recorded as the quality being
        // probed. A click that never took effect therefore looked like a success.
        if (probeMatch && !isAudioCandidate && !Number(candidate.height || 0)) {
            candidate.height = Number(probeMatch[1]);
            candidate.heightSource = 'probe';
        }
        candidate.probeQuality = activeProbe.label || '';
        candidate.probeToken = activeProbe.token || '';
        const incomingKey = candidate.itag ? `${candidate.itag}|${/audio/i.test(String(candidate.mime || '')) ? 'audio' : 'video'}` : `${candidate.mime || ''}|${candidate.width || 0}x${candidate.height || 0}|${candidate.url}`;
        state.probeBuffer = [candidate, ...(Array.isArray(state.probeBuffer) ? state.probeBuffer : [])]
            .filter((item, index, arr) => {
                const key = item.itag ? `${item.itag}|${/audio/i.test(String(item.mime || '')) ? 'audio' : 'video'}` : `${item.mime || ''}|${item.width || 0}x${item.height || 0}|${item.url}`;
                return key !== incomingKey || index === 0;
            }).slice(0, 48);
    }
    pushDebuggerRecentStream(tabId, candidate);

    await queueSessionMutation(tabId, current => {
        if (!current) return false;
        if (current.viewerSessionId !== session.viewerSessionId || current.fileId !== session.fileId) return false;
        const active = current.activeQualityProbe;
        if (active && Number(candidate.capturedAt) >= Number(active.startedAt || 0)) {
            candidate.probeQuality = active.label || candidate.probeQuality || '';
            candidate.probeToken = active.token || candidate.probeToken || '';
            current.probeCandidates = addUniqueCandidate(current.probeCandidates, candidate, 48);
        }
        const isAudio = /audio/i.test(String(candidate.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(candidate.itag || ''));
        if (isAudio) {
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
        current.timestamp = Date.now();
        current.updatedAt = Date.now();
        return current;
    }).then(() => {
        getStoredSession(Number(tabId)).then(latest => sendTab(Number(tabId), {
            type: 'videoStreamDetected',
            stream: candidate,
            fileId: latest?.fileId || session.fileId || candidate.fileId || '',
            viewerSessionId: latest?.viewerSessionId || session.viewerSessionId || '',
            formats: { video: latest?.videoCandidates || [], audio: latest?.audioCandidates || [], progressive: [] }
        }).catch(() => {})).catch(() => {});
    }).catch(() => {});
}
chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = Number(source?.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const state = debuggerNetworkState(tabId);

    // Keep a fast frame -> Runtime execution-context map while the one debugger
    // session is attached. The quality-option clicker uses a CDP DOM object from
    // the exact player frame instead of guessing iframe offsets.
    if (method === 'Runtime.executionContextCreated') {
        const ctx = params?.context;
        const frameId = String(ctx?.auxData?.frameId || '');
        if (frameId && ctx?.id != null) {
            const prev = state.qualityContexts?.get(frameId);
            const isDefault = ctx?.auxData?.isDefault === true;
            if (!prev || isDefault) state.qualityContexts.set(frameId, { contextId:Number(ctx.id), isDefault, origin:String(ctx.origin || '') });
        }
        return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
        const id = Number(params?.executionContextId);
        for (const [frameId, ctx] of state.qualityContexts || []) {
            if (Number(ctx?.contextId) === id) state.qualityContexts.delete(frameId);
        }
        return;
    }
    if (method === 'Runtime.executionContextsCleared') {
        state.qualityContexts?.clear();
        return;
    }

    if (!state?.networkEnabled) return;
    let url = '';
    let requestId = '';
    let frameId = -1;
    let resourceType = 'Media';
    if (method === 'Network.requestWillBeSent') {
        url = String(params?.request?.url || '');
        requestId = String(params?.requestId || '');
        frameId = Number(params?.frameId ?? -1);
        resourceType = params?.type || 'Media';
    } else if (method === 'Network.responseReceived') {
        url = String(params?.response?.url || '');
        requestId = String(params?.requestId || '');
        frameId = Number(params?.frameId ?? -1);
        resourceType = params?.type || 'Media';
    } else {
        return;
    }
    if (!url.includes('/videoplayback')) return;
    const eventKey = `${requestId}|${url}`;
    if (requestId && state.seenNetworkEvents?.has(eventKey)) return;
    if (requestId) {
        state.seenNetworkEvents.add(eventKey);
        if (state.seenNetworkEvents.size > 512) state.seenNetworkEvents = new Set([...state.seenNetworkEvents].slice(-256));
    }
    recordDebuggerNetworkStream(tabId, url, {
        source: method === 'Network.responseReceived' ? 'debugger-response' : 'debugger-network',
        requestId, frameId, resourceType
    });
});

chrome.debugger.onDetach.addListener((source) => {
    const tabId = Number(source?.tabId);
    if (Number.isInteger(tabId)) DEBUGGER_NETWORK_TABS.delete(tabId);
});


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
