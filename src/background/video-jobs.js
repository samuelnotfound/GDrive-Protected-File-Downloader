


async function ensureVideoOffscreen() {
    const url = chrome.runtime.getURL('src/offscreen/video-offscreen.html');
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
        });
        if (contexts.length) return;
    }
    await chrome.offscreen.createDocument({
        url: 'src/offscreen/video-offscreen.html',
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
    }).catch(error => {
        if (!String(error?.message || '').includes('already exists')) throw error;
    });
}

async function closeVideoOffscreen() {
    try {
        const jobs = await getStoredJobs();
        if (Object.keys(jobs).length) return;
        await chrome.offscreen.closeDocument();
    } catch (_) {}
}

async function createVideoStageJob(tabId, session, mode, payload) {
    const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await queueJobMutation(jobs => {
        jobs[jobId] = {
            jobId,
            sourceTabId: Number.isInteger(tabId) ? tabId : null,
            fileId: session?.fileId || '',
            viewerSessionId: session?.viewerSessionId || '',
            filename: payload.filename,
            mode,
            videoUrl: payload.videoUrl || null,
            audioUrl: payload.audioUrl || null,
            mediaUrl: payload.mediaUrl || null,
            videoBytes: payload.videoBytes || 0,
            audioBytes: payload.audioBytes || 0,
            mediaBytes: payload.mediaBytes || 0,
            mediaMime: payload.mediaMime || 'video/mp4',
            createdAt: Date.now()
        };
    });
    return jobId;
}

async function removeVideoStageJob(jobId) {
    await queueJobMutation(jobs => {
        delete jobs[jobId];
        return true;
    });
}

function formatBytes(format) {
    return Number(format?.contentLength) || getStreamBytes(format?.url || '');
}

function stageSizes(selected) {
    if (selected.mode === 'single') {
        return { mediaBytes: formatBytes(selected.media), videoBytes: 0, audioBytes: 0 };
    }
    return {
        mediaBytes: 0,
        videoBytes: formatBytes(selected.video),
        audioBytes: formatBytes(selected.audio)
    };
}

function createStagePayload(selected, filename) {
    const sizes = stageSizes(selected);
    if (selected.mode === 'single') {
        return {
            filename,
            mediaUrl: cleanURL(selected.media.originalUrl || selected.media.url),
            mediaBytes: sizes.mediaBytes,
            mediaMime: selected.media.mime || 'video/mp4'
        };
    }
    return {
        filename,
        videoUrl: cleanURL(selected.video.originalUrl || selected.video.url),
        audioUrl: cleanURL(selected.audio.originalUrl || selected.audio.url),
        videoBytes: sizes.videoBytes,
        audioBytes: sizes.audioBytes
    };
}


function validateDownloadContext(session, request) {
    if (request.fileId && session.fileId && String(request.fileId) !== String(session.fileId)) {
        return 'The Drive file changed before download. Please open the quality menu again.';
    }
    if (request.viewerSessionId && session.viewerSessionId && String(request.viewerSessionId) !== String(session.viewerSessionId)) {
        return 'The Drive viewer changed before download. Please open the quality menu again.';
    }
    return '';
}


function selectFormats(session, request) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id) : null;
    const wantHeight = Number(request?.qualityHeight || 0);

    const selectedProgressive = find(formats.progressive, request.progressiveFormatId)
        || (wantHeight
            ? (formats.progressive || []).find(item =>
                Number(item?.qualityHeight || item?.height || 0) === wantHeight && item?.url)
            : null);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    // Prefer the stream whose qualityHeight matches the menu row the user picked.
    let video = wantHeight
        ? (formats.video || []).find(item =>
            Number(item?.qualityHeight || item?.height || 0) === wantHeight && item?.url)
        : null;
    if (!video) video = find(formats.video, request.videoFormatId);
    let audio = find(formats.audio, request.audioFormatId);
    if (!video && formats.video?.length) video = formats.video[0];
    if (!audio && formats.audio?.length) audio = formats.audio[0];
    if (video?.url && audio?.url) return { mode: 'adaptive', video, audio };

    const capturedVideo = Array.isArray(session?.videoCandidates) ? session.videoCandidates[0] : null;
    const capturedAudioUrl = getBestAudioURL(session);
    if (capturedVideo?.url && capturedAudioUrl) {
        return {
            mode: 'adaptive',
            video: { url: capturedVideo.url, originalUrl: capturedVideo.originalUrl, contentLength: capturedVideo.contentLength },
            audio: { url: cleanURL(capturedAudioUrl), originalUrl: capturedAudioUrl, contentLength: getStreamBytes(capturedAudioUrl) }
        };
    }
    return null;
}

async function startVideoDownload(tabId, request = {}) {
    let session = await getStoredSession(tabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    const contextError = validateDownloadContext(session, request);
    if (contextError) return { success: false, error: contextError };

    // Formats come from quality probe + network capture only (no Drive playback API).
    const selected = selectFormats(session, request);
    if (!selected) {
        return {
            success: false,
            error: 'No usable video/audio stream is ready. Let quality detection finish or play the video once as a fallback.'
        };
    }

    const finalFilename = sanitizeVideoFilename(request.filename || session.filename || 'gdrive-video');
    const stagePayload = createStagePayload(selected, finalFilename);
    const sizes = stageSizes(selected);

    let jobId = '';
    try {
        jobId = await createVideoStageJob(
            tabId,
            session,
            selected.mode === 'single' ? 'single' : 'adaptive',
            stagePayload
        );
        await ensureVideoOffscreen();
        await sendTab(tabId, { type: 'videoStagePreload', jobId, ...sizes });
        await sendTab(tabId, { type: 'videoStageStarted', jobId, ...sizes });

        if (selected.mode === 'adaptive') {
            startStreamWarmup(jobId, 'video', selected.video.originalUrl || selected.video.url);
            startStreamWarmup(jobId, 'audio', selected.audio.originalUrl || selected.audio.url);
        } else {
            startStreamWarmup(jobId, 'media', selected.media.originalUrl || selected.media.url);
        }

        const monitorRequest = {
            filename: finalFilename,
            fileId: request.fileId || session.fileId || '',
            viewerSessionId: request.viewerSessionId || session.viewerSessionId || '',
            videoFormatId: request.videoFormatId,
            audioFormatId: request.audioFormatId,
            progressiveFormatId: request.progressiveFormatId
        };
        startDownloadWarmupMonitor(
            jobId,
            tabId,
            monitorRequest,
            request._restartAttempt || 0
        );

        sendOffscreen({ type: 'videoStageStart', jobId });
        return { success: true, jobId, ...sizes };
    } catch (error) {
        if (jobId) {
            await removeVideoStageJob(jobId);
            stopStreamWarmups(jobId);
            clearDownloadMonitor(jobId);
        }
        return { success: false, error: error?.message || String(error) };
    }
}
