


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


function pickBestAudioFromPools(session, tabId) {
    // Audio is a single shared track for the file — prefer the locked session.audio.
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

    const deduped = dedupeAudioFormats(pools);
    const best = deduped.sort((a, b) =>
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

function pickVideoFromPools(session, request, tabId) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url) : null;
    const wantHeight = Number(request?.qualityHeight || 0);
    const heightOf = item => Number(item?.qualityHeight || item?.height || 0);

    // Progressive (muxed) streams — single-file download.
    const selectedProgressive = find(formats.progressive, request.progressiveFormatId)
        || (wantHeight
            ? (formats.progressive || []).find(item => heightOf(item) === wantHeight && item?.url)
            : null);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    // Prefer the stream whose qualityHeight matches the menu row the user picked.
    let video = wantHeight
        ? (formats.video || []).find(item => heightOf(item) === wantHeight && item?.url)
        : null;
    if (!video) video = find(formats.video, request.videoFormatId);
    if (!video && formats.video?.length) {
        video = formats.video.find(item => item?.url) || formats.video[0];
    }

    // Fall back to session video candidates / recent in-memory streams.
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

    // Session-level last-seen video URL — preserve actual height; do not invent wantHeight.
    if (!video?.url && session?.video) {
        const existingH = Number(
            (Array.isArray(session?.formats?.video) && session.formats.video[0]?.qualityHeight)
            || (Array.isArray(session?.formats?.video) && session.formats.video[0]?.height)
            || (Array.isArray(session?.videoCandidates) && session.videoCandidates[0]?.height)
            || 0
        );
        video = {
            url: session.video,
            originalUrl: session.videoOriginal || session.video,
            contentLength: getStreamBytes(session.videoOriginal || session.video),
            height: existingH,
            qualityHeight: existingH
        };
    }

    // Only claim wantHeight when the stream was probe-tagged or already matches.
    if (video?.url && wantHeight) {
        const actual = Number(video.qualityHeight || video.height || 0);
        const probeOk = video.probeToken || video.probeHeight === wantHeight || video.heightSource === 'probe';
        if (actual && actual !== wantHeight && !probeOk) {
            // Keep actual height; do not relabel a mismatched leftover as the requested tier.
        } else if (!actual && probeOk) {
            video = { ...video, height: wantHeight, qualityHeight: wantHeight };
        }
    }

    return video?.url ? { mode: 'adaptive', video } : null;
}

function selectFormats(session, request, tabId = null) {
    const progressiveOrVideo = pickVideoFromPools(session, request, tabId);
    if (!progressiveOrVideo) return null;
    if (progressiveOrVideo.mode === 'single') return progressiveOrVideo;

    const video = progressiveOrVideo.video;

    // Muxed URL in the video list — download as a single progressive file.
    if (video?.url && isMuxedStream(video)) {
        return { mode: 'single', media: { ...video, progressive: true } };
    }

    let audio = null;
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url) : null;

    if (request.audioFormatId) audio = find(formats.audio, request.audioFormatId);
    if (!audio?.url && formats.audio?.length) audio = formats.audio.find(item => item?.url) || formats.audio[0];
    if (!audio?.url) audio = pickBestAudioFromPools(session, tabId);

    if (video?.url && audio?.url) {
        return {
            mode: 'adaptive',
            video,
            audio: {
                url: cleanURL(audio.originalUrl || audio.url),
                originalUrl: audio.originalUrl || audio.url,
                contentLength: Number(audio.contentLength) || getStreamBytes(audio.originalUrl || audio.url),
                mime: audio.mime || '',
                itag: audio.itag || ''
            }
        };
    }

    // Last resort: any progressive stream for the requested height.
    if (video?.url && !audio?.url) {
        const wantHeight = Number(request?.qualityHeight || video.qualityHeight || video.height || 0);
        const progressive = (formats.progressive || []).find(item =>
            item?.url && (!wantHeight || Number(item.qualityHeight || item.height || 0) === wantHeight)
        ) || (formats.progressive || []).find(item => item?.url);
        if (progressive?.url) return { mode: 'single', media: progressive };

        return { mode: 'adaptive', video, audio: null, missingAudio: true };
    }
    return null;
}

async function startVideoDownload(tabId, request = {}) {
    let session = await getStoredSession(tabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    const contextError = validateDownloadContext(session, request);
    if (contextError) return { success: false, error: contextError };

    // Prefer URLs captured just-in-time for the selected quality.
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
