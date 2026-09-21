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
    const session = await getStoredSession(tabId);
    const fileId = String(request.fileId || session?.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || session?.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();

    const rejection = validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate: parsed });
    if (rejection) return rejection;

    const candidate = {
        ...parsed,
        pageBridgeId: pageBridgeId || session.pageBridgeId || '',
        frameUrl: String(request.frameUrl || ''),
        source: String(request.source || 'page-bridge'),
        capturedAt: Date.now()
    };

    let latest = null;
    await queueSessionMutation(tabId, current => {
        if (current.fileId !== session.fileId || current.viewerSessionId !== session.viewerSessionId) return false;
        if (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId) return false;
        if (!current.pageBridgeId && pageBridgeId) current.pageBridgeId = pageBridgeId;

        const probe = current.activeQualityProbe;
        if (probe) {
            candidate.probeQuality = probe.label || '';
            candidate.probeToken = probe.token || '';
            current.probeCandidates = [candidate, ...(Array.isArray(current.probeCandidates) ? current.probeCandidates : [])].slice(0, 32);
        }

        addCapturedStreamToSession(current, candidate, hasAudioMime(candidate));
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
        current.formats = formats;
        current.formatsFetchedAt = Date.now();
        current.videoCandidates = Array.isArray(formats.video) ? formats.video.slice() : [];
        current.audioCandidates = Array.isArray(formats.audio) ? formats.audio.slice() : [];
        current.video = formats.video?.[0]?.url || null;
        current.audio = formats.audio?.[0]?.url || null;
        current.videoOriginal = formats.video?.[0]?.originalUrl || current.video;
        current.audioOriginal = formats.audio?.[0]?.originalUrl || current.audio;
        current.streamCaptureEnabled = true;
        return current;
    });
}

async function performQualityScan(tabId, fileId) {
    try {
        const result = await scanQualities(tabId, fileId);
        if (!result?.success) return result || { success: false, error: 'Trusted Drive quality scan failed.' };

        const scannedFormats = {
            video: mergeFormatLists([], result.formats?.video, byHeightWidthThenSize),
            audio: dedupeAudioFormats(mergeFormatLists([], result.formats?.audio, bySizeDesc)),
            progressive: []
        };
        await storeScannedFormats(tabId, fileId, scannedFormats);

        const latest = await getStoredSession(tabId);
        const formats = latest?.formats || scannedFormats;
        await sendTab(tabId, { type: 'videoFormatsDetected', formats, fileId, viewerSessionId: latest?.viewerSessionId || '' });
        return {
            success: true,
            formats,
            scanReport: result.scanReport || []
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


const handleGetStreams = async ({ tabId }) => ({ streams: await getStoredSession(tabId) });

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

async function cancelVideoStage(jobId, job) {
    stopStreamWarmups(jobId);
    sendOffscreen({ type: 'videoStageCancelInternal', jobId });
    if (job?.sourceTabId != null) await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId });
    await removeVideoStageJob(jobId);
    setTimeout(closeVideoOffscreen, 100);
    return { success: true };
}

async function handleVideoStageMessage({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    const isCancel = request.type === 'videoStageCancel';

    if (job?.sourceTabId != null && !isCancel) await sendTab(job.sourceTabId, { type: request.type, ...request });
    if (isCancel) return cancelVideoStage(request.jobId, job);

    if (FINISHED_STAGE_TYPES.has(request.type)) {
        stopStreamWarmups(request.jobId);
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
