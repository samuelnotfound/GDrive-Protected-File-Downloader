// ============================================================================
// FILE: src/background/video-jobs.js
// PURPOSE: Resolve selected streams, create a download job, open the offscreen
//          document, and start sequential 4 MiB range downloads + remux.
// ============================================================================

let offscreenLock = Promise.resolve();
let offscreenGeneration = 0;

/** Open the offscreen document used for chunk download + MP4 remux (MV3 has no DOM in the SW). */
async function ensureVideoOffscreen() {
    const myGen = ++offscreenGeneration;
    const run = offscreenLock.then(async () => {
        if (myGen !== offscreenGeneration) return;

        const url = chrome.runtime.getURL('src/offscreen/video-offscreen.html');
        if (chrome.runtime.getContexts) {
            try {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT'],
                    documentUrls: [url]
                });
                if (contexts.length) return;
            } catch (_) {}
        }

        try {
            await chrome.offscreen.createDocument({
                url: 'src/offscreen/video-offscreen.html',
                reasons: ['BLOBS', 'WORKERS'],
                justification: 'Download and merge Google Drive video/audio streams.'
            });
        } catch (error) {
            const msg = String(error?.message || error || '');
            if (/already exists|single offscreen|only one offscreen/i.test(msg)) return;
            throw error;
        }
    });

    offscreenLock = run.catch(() => {});
    return run;
}

/** Close offscreen document when no jobs remain. */
async function closeVideoOffscreen() {
    const myGen = offscreenGeneration;
    const run = offscreenLock.then(async () => {
        if (myGen !== offscreenGeneration) return;
        try {
            const jobs = await getStoredJobs();
            if (Object.keys(jobs).length) return;
            await chrome.offscreen.closeDocument();
        } catch (_) {}
    });
    offscreenLock = run.catch(() => {});
    return run;
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

/** Cancel every job that belongs to a tab (navigation / close / reload). */
async function cancelJobsForTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    let jobs = {};
    try { jobs = await getStoredJobs(); } catch (_) { return; }

    const ids = Object.keys(jobs).filter(id => Number(jobs[id]?.sourceTabId) === Number(tabId));
    for (const jobId of ids) {
        const job = jobs[jobId];
        try {
            if (typeof cancelVideoStage === 'function') {
                await cancelVideoStage(jobId, job, { silent: true });
            } else {
                try { sendOffscreen?.({ type: 'videoStageCancelInternal', jobId }); } catch (_) {}
                await removeVideoStageJob(jobId);
            }
        } catch (_) {}
    }
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

/** Best available audio for this session (shared track). */
function pickBestAudioFromPools(session, tabId) {
    if (session?.audio) {
        return {
            url: cleanURL(session.audioOriginal || session.audio) || session.audio,
            originalUrl: session.audioOriginal || session.audio,
            contentLength: getStreamBytes(session.audioOriginal || session.audio),
            mime: session.formats?.audio?.[0]?.mime || 'audio/mp4',
            itag: session.formats?.audio?.[0]?.itag || ''
        };
    }

    const pools = [
        ...(Array.isArray(session?.formats?.audio) ? session.formats.audio : []),
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(tabId != null ? (streamCaptureState(tabId)?.recentStreams || []).filter(isAudioStream) : [])
    ].filter(item => item?.url);

    const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    if (globalAudio?.url) pools.push(globalAudio);

    const best = dedupeAudioFormats(pools).sort((a, b) =>
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;

    if (best?.url) return best;

    const urlOnly = getBestAudioURL(session);
    if (!urlOnly) return null;
    return {
        url: cleanURL(urlOnly),
        originalUrl: urlOnly,
        contentLength: getStreamBytes(urlOnly)
    };
}

/** Resolve video (or progressive) stream from session pools matching the request. */
function pickVideoFromPools(session, request, tabId) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url) : null;
    const wantHeight = Number(request?.qualityHeight || 0);
    const heightOf = item => Number(item?.qualityHeight || item?.height || 0);

    const selectedProgressive = find(formats.progressive, request.progressiveFormatId)
        || (wantHeight ? (formats.progressive || []).find(item => heightOf(item) === wantHeight && item?.url) : null);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    let video = wantHeight
        ? (formats.video || []).find(item => heightOf(item) === wantHeight && item?.url)
        : null;
    if (!video) video = find(formats.video, request.videoFormatId);
    if (!video && formats.video?.length) {
        video = formats.video.find(item => item?.url) || formats.video[0];
    }

    if (!video?.url) {
        const candidates = [
            ...(Array.isArray(session?.videoCandidates) ? session.videoCandidates : []),
            ...(tabId != null
                ? (streamCaptureState(tabId)?.recentStreams || []).filter(s => s?.url && !isAudioStream(s))
                : [])
        ];
        if (wantHeight) {
            video = candidates.find(item => heightOf(item) === wantHeight && item?.url)
                || candidates.find(item => Number(item?.height || 0) === wantHeight && item?.url);
        }
        if (!video?.url) video = candidates.find(item => item?.url) || null;
    }

    if (!video?.url && session?.video) {
        video = {
            url: session.video,
            originalUrl: session.videoOriginal || session.video,
            height: wantHeight || 0,
            qualityHeight: wantHeight || 0
        };
    }

    if (!video?.url) return null;
    if (isMuxedStream(video)) return { mode: 'single', media: { ...video, progressive: true } };
    return { mode: 'adaptive', video };
}

/**
 * Build { mode, video, audio } or { mode: 'single', media } from session + request.
 * Prefer explicit URLs from the quality picker when present.
 */
function selectFormats(session, request, tabId = null) {
    const picked = pickVideoFromPools(session, request, tabId);
    if (!picked) return null;

    if (picked.mode === 'single') return picked;

    const audio = pickBestAudioFromPools(session, tabId);
    if (!audio?.url) return { ...picked, audio: null, missingAudio: true };
    return { ...picked, audio };
}

/**
 * Start download of the already-selected quality.
 *
 * Flow:
 * 1. Validate session matches request
 * 2. Resolve video + audio (or progressive) URLs
 * 3. Create job, open offscreen, notify UI
 * 4. Offscreen downloads 4 MiB ranges, remuxes, triggers browser download
 */
async function startVideoDownload(tabId, request = {}) {
    const session = await getStoredSession(tabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    const contextError = validateDownloadContext(session, request);
    if (contextError) return { success: false, error: contextError };

    // Prefer URLs supplied by the quality picker; fall back to session pools.
    let selected = null;
    if (request.videoUrl) {
        const video = {
            url: cleanURL(request.videoUrl) || request.videoUrl,
            originalUrl: request.videoUrl,
            height: Number(request.qualityHeight || 0),
            qualityHeight: Number(request.qualityHeight || 0),
            probeQuality: request.qualityLabel || ''
        };

        if (request.audioUrl) {
            selected = {
                mode: 'adaptive',
                video,
                audio: {
                    url: cleanURL(request.audioUrl) || request.audioUrl,
                    originalUrl: request.audioUrl,
                    mime: 'audio/mp4'
                }
            };
        } else if (isMuxedStream(video)) {
            selected = { mode: 'single', media: { ...video, progressive: true } };
        } else {
            const audio = pickBestAudioFromPools(session, tabId);
            if (audio?.url) {
                selected = {
                    mode: 'adaptive',
                    video,
                    audio: {
                        url: cleanURL(audio.originalUrl || audio.url) || audio.url,
                        originalUrl: audio.originalUrl || audio.url,
                        contentLength: Number(audio.contentLength) || 0,
                        mime: audio.mime || 'audio/mp4',
                        itag: audio.itag || ''
                    }
                };
            } else {
                selected = { mode: 'adaptive', video, audio: null, missingAudio: true };
            }
        }
    }

    if (!selected) selected = selectFormats(session, request, tabId);

    if (!selected) {
        return {
            success: false,
            error: 'No usable video stream was found for this quality. Play the video, pick a quality, then try again.'
        };
    }
    if (selected.missingAudio || (selected.mode === 'adaptive' && !selected.audio?.url)) {
        return {
            success: false,
            error: 'Video stream is ready but no audio track was captured yet. Play the video for a few seconds, then try Download again.'
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
        sendOffscreen({ type: 'videoStageStart', jobId });

        return { success: true, jobId, ...sizes };
    } catch (error) {
        if (jobId) await removeVideoStageJob(jobId);
        return { success: false, error: error?.message || String(error) };
    }
}
