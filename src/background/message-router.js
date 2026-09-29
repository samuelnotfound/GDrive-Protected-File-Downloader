const PICKER_SNAPSHOT_KEY = 'psdQualityPickerSnapshots';

const invalidTabResponse = () => ({ success: false, error: 'Invalid Drive tab.' });
const sessionChangedResponse = () => ({ success: false, error: 'The current Drive video session changed.' });
const hasAudioMime = stream => /audio/i.test(String(stream?.mime || ''));

const requireDriveTab = (handler, unauthorizedResponse = invalidTabResponse) =>
    ctx => (Number.isInteger(ctx.tabId) ? handler(ctx) : unauthorizedResponse());

async function getSessionForFile(tabId, requestedFileId) {
    const session = await getStoredSession(tabId);
    const fileId = String(requestedFileId || session?.fileId || '').trim();
    const isCurrent = session && fileId && (!session.fileId || session.fileId === fileId);
    return isCurrent ? { session, fileId } : null;
}


async function readPickerSnapshots(storageArea) {
    const data = await storageArea.get(PICKER_SNAPSHOT_KEY);
    const snapshots = data?.[PICKER_SNAPSHOT_KEY];
    return snapshots && typeof snapshots === 'object' ? snapshots : {};
}

async function writePickerSnapshot(storageArea, fileId, snapshot) {
    const snapshots = await readPickerSnapshots(storageArea);
    snapshots[fileId] = snapshot;
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

async function deletePickerSnapshot(storageArea, fileId) {
    const snapshots = { ...await readPickerSnapshots(storageArea) };
    delete snapshots[fileId];
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

async function handleSaveQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId || !request.snapshot?.formats) return { success: false, error: 'No quality snapshot.' };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try {
            await writePickerSnapshot(storageArea, fileId, request.snapshot);
            return { success: true };
        } catch (error) {
            if (storageArea === chrome.storage.local) return { success: false, error: error?.message || String(error) };
        }
    }
}

async function handleLoadQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: false, error: 'Missing file id.' };
    try {
        const snapshot = (await readPickerSnapshots(chrome.storage.session))[fileId] || null;
        if (snapshot) return { success: true, snapshot };
    } catch (_) {}
    try {
        return { success: true, snapshot: (await readPickerSnapshots(chrome.storage.local))[fileId] || null };
    } catch (error) {
        return { success: false, snapshot: null, error: error?.message || String(error) };
    }
}

async function handleClearQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: true };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try { await deletePickerSnapshot(storageArea, fileId); } catch (_) {}
    }
    return { success: true };
}


async function handleSetVideoContext({ request, tabId }) {
    const fileId = String(request.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();
    const filename = String(request.filename || '').trim();

    const current = await getStoredSession(tabId);
    const changed = !current
        || current.fileId !== fileId
        || current.viewerSessionId !== viewerSessionId
        || (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId);

    const next = changed
        ? emptySession(fileId, filename || 'gdrive-video', viewerSessionId)
        : {
            ...current,
            fileId: fileId || current.fileId,
            filename: filename || current.filename,
            viewerSessionId: viewerSessionId || current.viewerSessionId,
            pageBridgeId: pageBridgeId || current.pageBridgeId || ''
        };

    // Capture is on for the active viewer session immediately, so several quality URLs the user has
    // already generated before pressing Download are retained.
    next.streamCaptureEnabled = true;
    if (!changed && pageBridgeId) next.pageBridgeId = pageBridgeId;

    await setStoredSession(tabId, next);
    if (changed) setBadge('');
    return { success: true, changed, session: next };
}

const handlePrepareQualityScan = ({ request, tabId }) => prepareQualityScanState(tabId, String(request.fileId || '').trim());


async function handleUpdateFilename({ request, tabId }) {
    const filename = String(request.filename || '').trim();
    await queueSessionMutation(tabId, session => {
        if (!filename || session.filename === filename) return false;
        session.filename = filename;
        return session;
    });
    return { success: true };
}

async function handleVideoPlaybackIntent({ request, tabId }) {
    await queueSessionMutation(tabId, session => {
        if (request.fileId && session.fileId && request.fileId !== session.fileId) return false;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

async function handleVideoPlaybackStarted({ tabId }) {
    await queueSessionMutation(tabId, session => {
        if (session.playbackStarted) return false;
        session.playbackStarted = true;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}


function validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate }) {
    if (!session || !fileId || !viewerSessionId) return { success: false, error: 'No active Drive viewer session.' };
    if (session.fileId && fileId !== session.fileId) return { success: false, error: 'Drive file/session mismatch.' };
    if (session.viewerSessionId && viewerSessionId !== session.viewerSessionId) return { success: false, error: 'Drive viewer session mismatch.' };
    if (session.pageBridgeId && pageBridgeId && session.pageBridgeId !== pageBridgeId) return { success: false, error: 'Stale page bridge.' };
    const candidateFileId = String(candidate?.fileId || '').trim();
    if (candidateFileId && session.fileId && candidateFileId !== session.fileId) {
        return { success: false, error: 'Playback URL belongs to another Drive file.' };
    }
    return null;
}

function addCapturedStreamToSession(session, candidate, isAudio) {
    const kind = isAudio ? 'audio' : 'video';
    session[kind] = candidate.url;
    session[`${kind}Original`] = candidate.originalUrl;
    session[`${kind}Candidates`] = addUniqueCandidate(session[`${kind}Candidates`], candidate, 16);

    const format = {
        ...candidate,
        id: `captured:${candidate.itag || formatHash(candidate.url)}`,
        kind,
        acodec: isAudio ? candidate.codecs || '' : '',
        vcodec: isAudio ? '' : candidate.codecs || '',
        url: candidate.url,
        originalUrl: candidate.originalUrl
    };
    session.formats = {
        ...session.formats,
        [kind]: mergeFormatLists(session.formats?.[kind], [format], isAudio ? bySizeDesc : byHeightThenSize),
        [isAudio ? 'video' : 'audio']: session.formats?.[isAudio ? 'video' : 'audio'] || [],
        progressive: session.formats?.progressive || []
    };
}

async function handlePageStreamDetected({ request, tabId }) {
    const url = String(request.url || '').trim();
    if (!url || !url.includes('/videoplayback')) return { success: false, error: 'Not a Drive playback URL.' };

    const parsed = parseStreamCandidate(url, url);
    if (!parsed) return { success: false, error: 'Could not parse Drive playback URL.' };

    // Tag into the in-memory probe buffer FIRST (same as webRequest path).
    // waitForQualityStream polls memory; waiting on the storage queue was the
    // main reason quality-click streams were missed during automated scans.
    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    const candidate = {
        ...parsed,
        pageBridgeId: String(request.pageBridgeId || ''),
        frameUrl: String(request.frameUrl || ''),
        source: String(request.source || 'page-bridge'),
        capturedAt: Date.now()
    };
    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    const session = await getStoredSession(tabId);
    const fileId = String(request.fileId || session?.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || session?.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();

    const rejection = validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate: parsed });
    if (rejection) return rejection;

    candidate.pageBridgeId = pageBridgeId || session.pageBridgeId || '';

    let latest = null;
    await queueSessionMutation(tabId, current => {
        if (current.fileId !== session.fileId || current.viewerSessionId !== session.viewerSessionId) return false;
        if (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId) return false;
        if (!current.pageBridgeId && pageBridgeId) current.pageBridgeId = pageBridgeId;

        const probe = current.activeQualityProbe;
        if (probe) {
            candidate.probeQuality = probe.label || candidate.probeQuality || '';
            candidate.probeToken = probe.token || candidate.probeToken || '';
            const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
            if (labelHeight && !isAudioStream(candidate)) {
                candidate.qualityHeight = labelHeight;
                candidate.probeHeight = labelHeight;
            }
            current.probeCandidates = [candidate, ...(Array.isArray(current.probeCandidates) ? current.probeCandidates : [])].slice(0, 32);
        }

        // Simple-plugin classification: mime=audio in URL, else itag/isAudioStream.
        const rawUrl = String(candidate.originalUrl || candidate.url || '');
        const isAudio = rawUrl.includes('mime=audio') || isAudioStream(candidate);
        if (isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('audio', candidate, rawUrl);
        } else if (!isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('video', candidate, rawUrl);
        }
        addCapturedStreamToSession(current, candidate, isAudio);
        current.playbackStarted = true;
        current.streamCaptureEnabled = true;
        latest = current;
        return current;
    });
    if (!latest) return { success: false, error: 'The current Drive viewer changed.' };

    setBadge('ON');
    await sendTab(tabId, {
        type: 'videoStreamDetected',
        fileId: latest.fileId,
        viewerSessionId: latest.viewerSessionId,
        stream: candidate,
        formats: latest.formats
    });
    return { success: true, session: latest, stream: candidate };
}



async function storeScannedFormats(tabId, fileId, formats) {
    await queueSessionMutation(tabId, current => {
        if (!current || current.fileId !== fileId) return false;

        // Merge — never wipe audio/video candidates the network path already stored.
        // Scan result is preferred order, then prior session candidates, then prior formats.
        const mergedVideo = mergeFormatLists(
            formats?.video || [],
            [...(current.videoCandidates || []), ...(current.formats?.video || [])],
            byHeightWidthThenSize,
            48
        );
        const mergedAudio = dedupeAudioFormats(mergeFormatLists(
            formats?.audio || [],
            [...(current.audioCandidates || []), ...(current.formats?.audio || [])],
            bySizeDesc,
            24
        ));
        const mergedProgressive = mergeFormatLists(
            formats?.progressive || [],
            current.formats?.progressive || [],
            byHeightWidthThenSize,
            24
        );

        current.formats = {
            video: mergedVideo,
            audio: mergedAudio,
            progressive: mergedProgressive
        };
        current.formatsFetchedAt = Date.now();
        current.videoCandidates = mergedVideo.slice();
        current.audioCandidates = mergedAudio.slice();
        current.video = mergedVideo[0]?.url || current.video || null;
        current.audio = mergedAudio[0]?.url || current.audio || null;
        current.videoOriginal = mergedVideo[0]?.originalUrl || current.videoOriginal || current.video;
        current.audioOriginal = mergedAudio[0]?.originalUrl || current.audioOriginal || current.audio;
        current.streamCaptureEnabled = true;
        return current;
    });
}

async function performQualityScan(tabId, fileId) {
    try {
        const result = await scanQualities(tabId, fileId);
        if (!result?.success) return result || { success: false, error: 'Trusted Drive quality scan failed.' };

        // Prefer heights confirmed by the live Quality menu / probe pairs.
        // qualityHeight (set when we click a menu row) beats raw height (which
        // may still carry an itag-table guess). Never invent resolutions that
        // were not on the menu.
        const menuOptions = Array.isArray(result.quality?.options) ? result.quality.options : [];
        const menuHeights = new Set(
            menuOptions
                .map(option => Number(option?.height || 0))
                .filter(height => height > 0)
        );

        // Prefer explicit qualityStreams pairs when present — each pair is
        // already keyed to a real menu height from the probe loop.
        const pairVideos = (Array.isArray(result.qualityStreams) ? result.qualityStreams : [])
            .map(pair => {
                const video = pair?.video;
                if (!video?.url) return null;
                const height = Number(pair.height || video.qualityHeight || video.height || 0);
                if (!height) return null;
                return {
                    ...video,
                    height,
                    qualityHeight: height,
                    probeQuality: video.probeQuality || `${height}p`
                };
            })
            .filter(Boolean);

        const rawVideo = Array.isArray(result.formats?.video) ? result.formats.video : [];
        const normalizeHeight = stream => {
            const h = Number(stream?.qualityHeight || stream?.height || 0);
            if (!h) return null;
            return {
                ...stream,
                height: h,
                qualityHeight: h
            };
        };

        let menuScopedVideo;
        if (pairVideos.length) {
            // Probe pairs are authoritative when the scan captured them.
            menuScopedVideo = pairVideos;
            // Fill any menu heights still missing from pairs with raw captures.
            const have = new Set(pairVideos.map(s => Number(s.height)));
            for (const stream of rawVideo) {
                const normalized = normalizeHeight(stream);
                if (!normalized) continue;
                if (have.has(normalized.height)) continue;
                if (menuHeights.size && !menuHeights.has(normalized.height)) continue;
                menuScopedVideo.push(normalized);
                have.add(normalized.height);
            }
        } else if (menuHeights.size) {
            menuScopedVideo = rawVideo
                .map(normalizeHeight)
                .filter(stream => stream && menuHeights.has(stream.height));
        } else {
            menuScopedVideo = rawVideo.map(normalizeHeight).filter(Boolean);
        }

        // One shared audio track for the file (not per quality).
        const state = streamCaptureState(tabId);
        const priorSession = await getStoredSession(tabId);
        const recentAudio = (state?.recentStreams || [])
            .filter(isAudioStream)
            .filter(s => s?.url);
        const audioPool = [
            ...(Array.isArray(result.formats?.audio) ? result.formats.audio : []),
            ...recentAudio,
            ...(Array.isArray(priorSession?.audioCandidates) ? priorSession.audioCandidates : []),
            ...(Array.isArray(priorSession?.formats?.audio) ? priorSession.formats.audio : [])
        ];
        if (priorSession?.audio) {
            audioPool.unshift({
                url: priorSession.audio,
                originalUrl: priorSession.audioOriginal || priorSession.audio,
                mime: 'audio/mp4'
            });
        }
        const sharedAudioList = dedupeAudioFormats(mergeFormatLists([], audioPool, bySizeDesc));
        const sharedAudio = sharedAudioList.length ? [sharedAudioList[0]] : [];

        // Split muxed (progressive) streams out of the adaptive video list.
        const progressive = [];
        const adaptiveVideo = [];
        for (const stream of mergeFormatLists([], menuScopedVideo, byHeightWidthThenSize)) {
            if (!stream?.url) continue;
            if (isMuxedStream(stream)) {
                progressive.push({ ...stream, progressive: true });
            } else {
                adaptiveVideo.push(stream);
            }
        }
        // Also promote muxed streams from the recent ring / prior session.
        for (const stream of [
            ...(state?.recentStreams || []),
            ...(Array.isArray(priorSession?.videoCandidates) ? priorSession.videoCandidates : [])
        ]) {
            if (!stream?.url || isAudioStream(stream) || !isMuxedStream(stream)) continue;
            progressive.push({ ...stream, progressive: true });
        }

        const scannedFormats = {
            video: adaptiveVideo,
            audio: sharedAudio,
            progressive: mergeFormatLists([], progressive, byHeightWidthThenSize, 24)
        };
        // Persist first, but ALWAYS return/send the in-memory scannedFormats.
        // Re-reading the session can race with concurrent stream updates and
        // hand the picker an empty or stale formats object.
        await storeScannedFormats(tabId, fileId, scannedFormats);

        const latest = await getStoredSession(tabId);
        const formats = scannedFormats;
        await sendTab(tabId, {
            type: 'videoFormatsDetected',
            formats,
            fileId,
            viewerSessionId: latest?.viewerSessionId || '',
            quality: result.quality || { options: menuOptions },
            qualityOptions: menuOptions
        });
        return {
            success: true,
            formats,
            scanReport: result.scanReport || [],
            quality: result.quality || { options: menuOptions },
            qualityOptions: menuOptions,
            qualityStreams: result.qualityStreams || [],
            observedQualityLabels: result.observedQualityLabels || []
        };
    } catch (error) {
        return { success: false, error: error?.message || 'Trusted Drive quality scan failed.' };
    }
}

async function handleAutomatedQualityScan({ request, tabId }) {
    const found = await getSessionForFile(tabId, request.fileId);
    if (!found) return sessionChangedResponse();
    const { session, fileId } = found;

    const runningKey = `${tabId}|${fileId}|${session.viewerSessionId || ''}`;
    if (QUALITY_SCAN_RUNNING.has(runningKey)) {
        try { return await QUALITY_SCAN_RUNNING.get(runningKey); }
        catch (error) { return { success: false, error: error?.message || 'Quality scan failed.' }; }
    }

    const scan = performQualityScan(tabId, fileId);
    QUALITY_SCAN_RUNNING.set(runningKey, scan);
    try {
        return await scan;
    } finally {
        if (QUALITY_SCAN_RUNNING.get(runningKey) === scan) QUALITY_SCAN_RUNNING.delete(runningKey);
    }
}



async function handleClearTabCaptureState({ tabId }) {
    if (!Number.isInteger(tabId) || tabId < 0) return { success: false };
    try {
        if (typeof clearTabMediaState === 'function') {
            await clearTabMediaState(tabId, { clearGlobal: true });
        } else {
            await clearStoredSession(tabId);
            clearStreamCaptureState(tabId);
            try {
                if (typeof GLOBAL_LAST_AUDIO !== 'undefined') GLOBAL_LAST_AUDIO = null;
                if (typeof GLOBAL_LAST_VIDEO !== 'undefined') GLOBAL_LAST_VIDEO = null;
            } catch (_) {}
            try { await chrome.storage.local.remove(['psdGlobalStreams']); } catch (_) {}
        }
    } catch (_) {}
    return { success: true };
}

const handleGetStreams = async ({ tabId }) => {
    // Always reload durable global streams (simple-plugin style).
    if (typeof loadGlobalStreamsFromStorage === 'function') {
        await loadGlobalStreamsFromStorage();
    }
    let session = await getStoredSession(tabId);
    let globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    let globalVideo = typeof getGlobalLastVideo === 'function' ? getGlobalLastVideo() : null;

    // Attach global audio onto the session if still missing.
    if (session && !session.audio && globalAudio?.url) {
        await queueSessionMutation(tabId, current => {
            if (!current) return false;
            current.audio = globalAudio.url;
            current.audioOriginal = globalAudio.originalUrl || globalAudio.url;
            current.audioCandidates = addUniqueCandidate(
                Array.isArray(current.audioCandidates) ? current.audioCandidates : [],
                globalAudio,
                8
            );
            current.formats = current.formats || { video: [], audio: [], progressive: [] };
            current.formats.audio = [{ ...globalAudio, id: `audio:global:${globalAudio.itag || ''}` }];
            return current;
        });
        session = await getStoredSession(tabId);
    }
    return {
        streams: session,
        globalAudio: globalAudio || session?.formats?.audio?.[0] || (session?.audio ? {
            url: session.audio,
            originalUrl: session.audioOriginal || session.audio,
            mime: 'audio/mp4'
        } : null),
        globalVideo: globalVideo || null
    };
};

async function handleMuteMediaNow({ tabId }) {
    if (!Number.isInteger(tabId)) return { success: false, error: 'No active Drive tab.' };
    await sendTab(tabId, { type: 'PSD_MUTE_MEDIA_NOW' });
    return { success: true };
}

const handleDownloadVideo = ({ request, tabId }) => startVideoDownload(tabId, request || {});

async function handleGetVideoStageJob({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
}

const FINISHED_STAGE_TYPES = new Set(['videoStageFinished', 'videoStageError', 'videoStageCancelled']);

async function cancelVideoStage(jobId, job, options = {}) {
    stopStreamWarmups(jobId);
    clearDownloadMonitor(jobId);
    sendOffscreen({ type: 'videoStageCancelInternal', jobId });
    if (!options.silent && job?.sourceTabId != null) {
        await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId });
    }
    await removeVideoStageJob(jobId);
    setTimeout(closeVideoOffscreen, 100);
    return { success: true };
}

async function handleVideoStageMessage({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    const isCancel = request.type === 'videoStageCancel';

    if (request.type === 'videoStageProgress' && request.jobId) {
        noteDownloadProgress(request.jobId, request.label, request.received);
    }

    if (job?.sourceTabId != null && !isCancel) await sendTab(job.sourceTabId, { type: request.type, ...request });
    if (isCancel) return cancelVideoStage(request.jobId, job);

    if (FINISHED_STAGE_TYPES.has(request.type)) {
        stopStreamWarmups(request.jobId);
        clearDownloadMonitor(request.jobId);
        await queueJobMutation(currentJobs => {
            if (!currentJobs[request.jobId]) return false;
            delete currentJobs[request.jobId];
            return true;
        });
        setTimeout(closeVideoOffscreen, 1200);
    }
    return { success: true };
}


const ACTION_HANDLERS = Object.freeze({
    saveQualityPickerSnapshot: requireDriveTab(handleSaveQualityPickerSnapshot),
    loadQualityPickerSnapshot: requireDriveTab(handleLoadQualityPickerSnapshot),
    clearQualityPickerSnapshot: requireDriveTab(handleClearQualityPickerSnapshot),
    setVideoContext: requireDriveTab(handleSetVideoContext),
    prepareQualityScan: handlePrepareQualityScan,
    updateFilename: requireDriveTab(handleUpdateFilename),
    pageStreamDetected: requireDriveTab(handlePageStreamDetected),
    videoPlaybackIntent: requireDriveTab(handleVideoPlaybackIntent, () => ({ success: false })),
    videoPlaybackStarted: requireDriveTab(handleVideoPlaybackStarted, () => ({ success: false })),
    automatedQualityScan: requireDriveTab(handleAutomatedQualityScan),
    clearTabCaptureState: requireDriveTab(handleClearTabCaptureState),
    getStreams: handleGetStreams,
    muteMediaNow: handleMuteMediaNow,
    downloadVideo: handleDownloadVideo
});

const TYPE_HANDLERS = Object.freeze({
    getVideoStageJob: handleGetVideoStageJob
});

async function handleRuntimeMessage(request = {}, sender = {}) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    const ctx = { request, sender, tabId };

    const actionHandler = ACTION_HANDLERS[String(request.action || '')];
    if (actionHandler) return actionHandler(ctx);

    const type = String(request.type || '');
    const typeHandler = TYPE_HANDLERS[type];
    if (typeHandler) return typeHandler(ctx);
    if (type.startsWith('videoStage')) return handleVideoStageMessage(ctx);

    return undefined;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
});
