// ============================================================================
// FILE: src/background/video-jobs.js
// PURPOSE: Download job orchestration and offscreen worker coordinator.
//          Resolves requested video/audio stream formats, manages the hidden
//          Chrome offscreen document for media remuxing, registers download jobs,
//          preheats network connections, and triggers the chunk downloader.
// ============================================================================

/**
 * Promise-based mutex lock for serializing creation and closing of the offscreen document.
 * Prevents race conditions where a fast cancel/close operation closes an offscreen
 * document that a concurrent download job is just starting to open.
 */
let offscreenLock = Promise.resolve();

/** Generation counter to invalidate and supersede stale offscreen document operations */
let offscreenGeneration = 0;

/**
 * Ensures the extension's offscreen document is open and ready.
 *
 * WHY OFFSCREEN DOCUMENTS ARE REQUIRED IN MANIFEST V3:
 * MV3 Service Workers do not have access to DOM APIs, HTMLMediaElement, WebCodecs,
 * Canvas, or Web Workers in the same way full browser windows do.
 * An Offscreen Document provides a hidden sandbox environment with full DOM and Web Worker
 * capabilities (e.g. running the MP4 remuxer in a Web Worker).
 *
 * HOW IT WORKS:
 * 1. Checks `chrome.runtime.getContexts` (if available in modern Chrome) to see if
 *    the offscreen document already exists.
 * 2. If not found, calls `chrome.offscreen.createDocument` with reasons `BLOBS` and `WORKERS`.
 * 3. Catches and suppresses "already exists" errors in case of browser timing races.
 *
 * @returns {Promise<void>}
 */
async function ensureVideoOffscreen() {
    const myGen = ++offscreenGeneration;
    const run = offscreenLock.then(async () => {
        // If another operation incremented the generation while waiting on the lock, exit
        if (myGen !== offscreenGeneration) return;

        const url = chrome.runtime.getURL('src/offscreen/video-offscreen.html');

        // Check if an offscreen context with this URL is already open
        if (chrome.runtime.getContexts) {
            try {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
                });
                if (contexts.length) return; // Already running
            } catch (_) {}
        }

        try {
            // Create the hidden offscreen document
            await chrome.offscreen.createDocument({
                url: 'src/offscreen/video-offscreen.html',
                reasons: ['BLOBS', 'WORKERS'],
                justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
            });
        } catch (error) {
            const msg = String(error?.message || error || '');
            // Suppress error if browser created it concurrently
            if (/already exists|single offscreen|only one offscreen/i.test(msg)) return;
            throw error;
        }
    });

    // Keep the chain alive even on error
    offscreenLock = run.catch(() => {});
    return run;
}

/**
 * Closes the offscreen document if no active download jobs remain.
 *
 * HOW IT WORKS:
 * 1. Acquires `offscreenLock`.
 * 2. Verifies that the generation has not changed.
 * 3. Checks stored jobs; if any active jobs exist in `JOB_STORE_KEY`, aborts close!
 * 4. Calls `chrome.offscreen.closeDocument()`.
 *
 * @returns {Promise<void>}
 */
async function closeVideoOffscreen() {
    const myGen = offscreenGeneration;
    const run = offscreenLock.then(async () => {
        // A newer ensureVideoOffscreen raced ahead; do not close!
        if (myGen !== offscreenGeneration) return;
        try {
            const jobs = await getStoredJobs();
            // If jobs still remain in the queue, keep the offscreen document alive
            if (Object.keys(jobs).length) return;
            await chrome.offscreen.closeDocument();
        } catch (_) {}
    });

    offscreenLock = run.catch(() => {});
    return run;
}

/**
 * Creates and persists a new video stage job record in storage.
 *
 * @param {number} tabId - Originating tab ID
 * @param {Object} session - Drive tab session object
 * @param {'single'|'adaptive'} mode - Download mode (single progressive file or separate video+audio)
 * @param {Object} payload - Stream URLs and byte sizes
 * @returns {Promise<string>} Generated unique jobId
 */
async function createVideoStageJob(tabId, session, mode, payload) {
    // Unique job identifier with timestamp and random alphanumeric string
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

/**
 * Removes a video stage job from storage by its jobId.
 *
 * @param {string} jobId - Video download job ID
 */
async function removeVideoStageJob(jobId) {
    await queueJobMutation(jobs => {
        delete jobs[jobId];
        return true;
    });
}

/**
 * Cancels all active download jobs that originated from a specific tab.
 *
 * PURPOSE:
 * Called by lifecycle.js when a tab navigates away, reloads, or is closed by the user.
 * Halts stream warmups, clears monitors, notifies offscreen worker, and cleans storage.
 *
 * @param {number} tabId - Browser tab ID
 */
async function cancelJobsForTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    let jobs = {};
    try { jobs = await getStoredJobs(); } catch (_) { return; }

    // Find all job IDs originating from this tab
    const ids = Object.keys(jobs).filter(id => Number(jobs[id]?.sourceTabId) === Number(tabId));

    for (const jobId of ids) {
        const job = jobs[jobId];
        try {
            if (typeof cancelVideoStage === 'function') {
                // Call full cancellation workflow
                await cancelVideoStage(jobId, job, { silent: true });
            } else {
                // Fallback cleanup if cancelVideoStage is not yet linked
                try { stopStreamWarmups?.(jobId); } catch (_) {}
                try { clearDownloadMonitor?.(jobId); } catch (_) {}
                try { sendOffscreen?.({ type: 'videoStageCancelInternal', jobId }); } catch (_) {}
                await removeVideoStageJob(jobId);
            }
        } catch (_) {}
    }
}

/**
 * Helper resolving total byte length of a format from contentLength or clen query parameter.
 *
 * @param {Object} format - Format descriptor
 * @returns {number}
 */
function formatBytes(format) {
    return Number(format?.contentLength) || getStreamBytes(format?.url || '');
}

/**
 * Calculates byte size breakdowns for the selected streams.
 *
 * @param {Object} selected - Format selection object
 * @returns {{mediaBytes: number, videoBytes: number, audioBytes: number}}
 */
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

/**
 * Packages download parameters into a structured stage payload.
 *
 * @param {Object} selected - Format selection
 * @param {string} filename - Cleaned target filename
 * @returns {Object} Stage payload
 */
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

/**
 * Validates that the active tab session matches the download request.
 *
 * PURPOSE:
 * Protects against race conditions where the user opened a different Drive file
 * in the tab right before clicking "Download" on an old quality dialog.
 *
 * @param {Object} session - Stored tab session
 * @param {Object} request - Incoming download request
 * @returns {string} Error message string if invalid, or empty string if valid
 */
function validateDownloadContext(session, request) {
    if (request.fileId && session.fileId && String(request.fileId) !== String(session.fileId)) {
        return 'The Drive file changed before download. Please open the quality menu again.';
    }
    if (request.viewerSessionId && session.viewerSessionId && String(request.viewerSessionId) !== String(session.viewerSessionId)) {
        return 'The Drive viewer changed before download. Please open the quality menu again.';
    }
    return '';
}

/**
 * Selects the highest quality audio stream available across all candidate pools.
 *
 * PRIORITY ORDER:
 * 1. Locked session audio (`session.audio`).
 * 2. Candidate arrays in session (`formats.audio`, `audioCandidates`).
 * 3. Recent in-memory streams captured in the tab.
 * 4. Fallback to `GLOBAL_LAST_AUDIO`.
 *
 * @param {Object} session - Tab session
 * @param {number|null} tabId - Browser tab ID
 * @returns {Object|null}
 */
function pickBestAudioFromPools(session, tabId) {
    // 1. Audio track is shared for the entire video file; prefer locked session.audio
    if (session?.audio) {
        return {
            url: cleanURL(session.audioOriginal || session.audio) || session.audio,
            originalUrl: session.audioOriginal || session.audio,
            contentLength: getStreamBytes(session.audioOriginal || session.audio),
            mime: session.formats?.audio?.[0]?.mime || 'audio/mp4',
            itag: session.formats?.audio?.[0]?.itag || ''
        };
    }

    // 2. Aggregate candidates from session formats, candidates, and memory buffer
    const pools = [
        ...(Array.isArray(session?.formats?.audio) ? session.formats.audio : []),
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(tabId != null ? (streamCaptureState(tabId)?.recentStreams || []).filter(isAudioStream) : [])
    ].filter(item => item?.url);

    // 3. Include global audio stream if available
    const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    if (globalAudio?.url) pools.push(globalAudio);

    // 4. Deduplicate and sort by content length descending (largest/highest bitrate first)
    const deduped = dedupeAudioFormats(pools);
    const best = deduped.sort((a, b) =>
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;
    if (best?.url) return best;

    // 5. Fallback URL extraction
    const urlOnly = getBestAudioURL(session);
    if (!urlOnly) return null;
    return {
        url: cleanURL(urlOnly),
        originalUrl: urlOnly,
        contentLength: getStreamBytes(urlOnly)
    };
}

/**
 * Resolves the appropriate video stream from session pools matching user request.
 *
 * HOW IT WORKS:
 * 1. Checks for progressive (muxed) stream matching requested format or height.
 * 2. Searches session video formats for matching `qualityHeight`.
 * 3. Falls back to `videoFormatId` or first video format.
 * 4. Falls back to in-memory recent stream captures.
 * 5. Returns `{ mode: 'single', media }` or `{ mode: 'adaptive', video }`.
 *
 * @param {Object} session - Tab session
 * @param {Object} request - Download parameters
 * @param {number|null} tabId - Browser tab ID
 * @returns {Object|null}
 */
function pickVideoFromPools(session, request, tabId) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url) : null;
    const wantHeight = Number(request?.qualityHeight || 0);
    const heightOf = item => Number(item?.qualityHeight || item?.height || 0);

    // Check progressive (muxed) streams — single-file download
    const selectedProgressive = find(formats.progressive, request.progressiveFormatId)
        || (wantHeight
            ? (formats.progressive || []).find(item => heightOf(item) === wantHeight && item?.url)
            : null);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    // Prefer stream whose qualityHeight matches the menu row chosen by the user
    let video = wantHeight
        ? (formats.video || []).find(item => heightOf(item) === wantHeight && item?.url)
        : null;
    if (!video) video = find(formats.video, request.videoFormatId);
    if (!video && formats.video?.length) {
        video = formats.video.find(item => item?.url) || formats.video[0];
    }

    // Fall back to session video candidates / recent in-memory streams
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

    // Session-level last-seen video URL fallback
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

    // Validate claimed height against real stream metadata
    if (video?.url && wantHeight) {
        const actual = Number(video.qualityHeight || video.height || 0);
        const probeOk = video.probeToken || video.probeHeight === wantHeight || video.heightSource === 'probe';
        if (actual && actual !== wantHeight && !probeOk) {
            // Keep actual height; do not relabel a mismatched leftover as the requested tier
        } else if (!actual && probeOk) {
            video = { ...video, height: wantHeight, qualityHeight: wantHeight };
        }
    }

    return video?.url ? { mode: 'adaptive', video } : null;
}

/**
 * Selects and pairs video and audio streams for the download job.
 *
 * @param {Object} session - Tab session
 * @param {Object} request - Download parameters
 * @param {number|null} [tabId=null] - Browser tab ID
 * @returns {Object|null}
 */
function selectFormats(session, request, tabId = null) {
    const progressiveOrVideo = pickVideoFromPools(session, request, tabId);
    if (!progressiveOrVideo) return null;
    if (progressiveOrVideo.mode === 'single') return progressiveOrVideo;

    const video = progressiveOrVideo.video;

    // If stream is marked as muxed, use single file mode
    if (video?.url && isMuxedStream(video)) {
        return { mode: 'single', media: { ...video, progressive: true } };
    }

    // Resolve audio track
    let audio = null;
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url) : null;

    if (request.audioFormatId) audio = find(formats.audio, request.audioFormatId);
    if (!audio?.url && formats.audio?.length) audio = formats.audio.find(item => item?.url) || formats.audio[0];
    if (!audio?.url) audio = pickBestAudioFromPools(session, tabId);

    // Valid adaptive pairing (separate video and audio)
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

    // Fallback: If audio is missing, look for any progressive fallback matching the height
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

/**
 * Initiates the video download pipeline.
 *
 * HOW IT WORKS:
 * 1. Validates session and file context.
 * 2. Resolves selected format (single progressive or adaptive video+audio).
 * 3. Sanitizes destination filename.
 * 4. Creates a job record in `videoStageJobs` storage.
 * 5. Ensures the offscreen document is open.
 * 6. Dispatches `videoStagePreload` and `videoStageStarted` messages to tab UI.
 * 7. Starts stream warmups (`startStreamWarmup`).
 * 8. Starts CDN slow-start speed monitor (`startDownloadWarmupMonitor`).
 * 9. Signals offscreen document (`videoStageStart`) to begin chunk fetching and remuxing.
 *
 * @param {number} tabId - Browser tab ID
 * @param {Object} [request={}] - Download options
 * @returns {Promise<{success: boolean, jobId?: string, error?: string, mediaBytes?: number, videoBytes?: number, audioBytes?: number}>}
 */
async function startVideoDownload(tabId, request = {}) {
    let session = await getStoredSession(tabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    const contextError = validateDownloadContext(session, request);
    if (contextError) return { success: false, error: contextError };

    // Prefer URLs captured just-in-time for the selected quality
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

    // Sanitize destination filename
    const finalFilename = sanitizeVideoFilename(request.filename || session.filename || 'gdrive-video');
    const stagePayload = createStagePayload(selected, finalFilename);
    const sizes = stageSizes(selected);

    let jobId = '';
    try {
        // Register job record
        jobId = await createVideoStageJob(
            tabId,
            session,
            selected.mode === 'single' ? 'single' : 'adaptive',
            stagePayload
        );

        // Ensure offscreen document is open
        await ensureVideoOffscreen();

        // Update UI overlay on tab
        await sendTab(tabId, { type: 'videoStagePreload', jobId, ...sizes });
        await sendTab(tabId, { type: 'videoStageStarted', jobId, ...sizes });

        // Pre-heat network connections to edge servers
        if (selected.mode === 'adaptive') {
            startStreamWarmup(jobId, 'video', selected.video.originalUrl || selected.video.url);
            startStreamWarmup(jobId, 'audio', selected.audio.originalUrl || selected.audio.url);
        } else {
            startStreamWarmup(jobId, 'media', selected.media.originalUrl || selected.media.url);
        }

        // Configure slow-start CDN speed monitor
        const monitorRequest = {
            filename: finalFilename,
            fileId: request.fileId || session.fileId || '',
            viewerSessionId: request.viewerSessionId || session.viewerSessionId || '',
            videoFormatId: request.videoFormatId,
            audioFormatId: request.audioFormatId,
            progressiveFormatId: request.progressiveFormatId,
            qualityHeight: request.qualityHeight || selected.video?.qualityHeight || selected.video?.height || 0,
            qualityLabel: request.qualityLabel || selected.video?.probeQuality || '',
            videoUrl: request.videoUrl || selected.video?.originalUrl || selected.video?.url || selected.media?.url || '',
            audioUrl: request.audioUrl || selected.audio?.originalUrl || selected.audio?.url || ''
        };
        startDownloadWarmupMonitor(
            jobId,
            tabId,
            monitorRequest,
            request._restartAttempt || 0
        );

        // Tell offscreen worker to start downloading segments
        sendOffscreen({ type: 'videoStageStart', jobId });
        return { success: true, jobId, ...sizes };
    } catch (error) {
        // Cleanup on failure
        if (jobId) {
            await removeVideoStageJob(jobId);
            stopStreamWarmups(jobId);
            clearDownloadMonitor(jobId);
        }
        return { success: false, error: error?.message || String(error) };
    }
}
