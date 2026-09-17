async function shouldLog() {
    try {
        const result = await chrome.storage.local.get(['debugMode']);
        return result.debugMode === true;
    }catch (error) {
        return false;
    }
}
async function logDebug(message, data = null) {
    if (await shouldLog()) {
        if (data) console.log(`[GDrive SW] ${message}`, data);
        else console.log(`[GDrive SW] ${message}`);
    }
}
function cleanURL(url) {
    if (!url) return null;
    const hashIndex = url.indexOf('#');
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf('?');
    if (queryIndex === -1) return url;

    const base = withoutHash.slice(0, queryIndex);
    const parameters = withoutHash.slice(queryIndex + 1).split('&');
    const filtered = parameters.filter(parameter => parameter.split('=', 1)[0] !== 'range');
    if (filtered.length === parameters.length) return url;
    return `${base}${filtered.length ? `?${filtered.join('&')}` : ''}${hash}`;
}
function sanitizeVideoFilename(name) {
    let value = String(name || '').trim();
    value = value.replace(/[\\/:*?"<>|]+/g, '_').replace(/[\x00-\x1F]/g, '').trim();
    if (!value) value = 'gdrive-video';
    // If Drive already supplied a real media extension, keep the filename
    // exactly as supplied. Otherwise Chrome gets an MP4 extension.
    if (!/\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value)) value += '.mp4';
    return value;
}
const EMPTY_STREAMS = {
    video: null,
    audio: null,
    videoOriginal: null,
    audioOriginal: null,
    audioCandidates: [],
    videoCandidates: [],
    playbackStarted: false,
    filename: 'gdrive-video',
    timestamp: null
};
function getStreamBytes(url) {
    if (!url) return 0;
    try {
        const n = Number(new URL(url).searchParams.get('clen'));
        return Number.isSafeInteger(n) && n > 0  ? n: 0;
    }catch (_) {
        return 0;
    }
}
function describeStreamURL(url) {
    try {
        const parsedURL = new URL(url);
        return {
            host: parsedURL.hostname,
            path: parsedURL.pathname,
            mime: parsedURL.searchParams.get('mime') || '',
            bytes: getStreamBytes(url)
        };
    }catch (_) {
        return { host: '', path: '', mime: '', bytes: 0 };
    }
}
function getBestAudioURL(streams) {
    const list = Array.isArray(streams?.audioCandidates) &&
        streams.audioCandidates.length
        ? streams.audioCandidates.slice()
        : (streams?.audio ? [streams.audioOriginal || streams.audio] : []);
    return list.reduce((best, url) => getStreamBytes(url) > getStreamBytes(best) ? url : best, null);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
const emptyStreams = () => ({ ...EMPTY_STREAMS, audioCandidates: [], videoCandidates: [] });
const sendTab = async (tabId, message) => {
    if (!Number.isInteger(tabId)) return;
    try { await chrome.tabs.sendMessage(tabId, message); } catch (_) {}
};
const sendOffscreen = async message => {
    const response = await chrome.runtime.sendMessage({ target: 'video-offscreen', ...message });
    if (!response?.accepted) {
        throw new Error(response?.error || 'The video processor did not acknowledge the request.');
    }
};
const setBadge = text => { try { chrome.action.setBadgeText({ text }); if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' }); } catch (_) {} };
// Stream warm-up (speed boost)
const activeStreamWarmups = new Map();
const STORAGE_QUEUE = {
    streams: Promise.resolve(),
    jobs: Promise.resolve()
};
const SERVICE_WORKER_START = Date.now();
const requestStats = {
    total: 0,
    video: 0,
    audio: 0,
    lastError: null
};
function queueStorageMutation(kind, key, mutator) {
    const q = kind === 'jobs' ? 'jobs' : 'streams';
    const task = STORAGE_QUEUE[q].then(async () => {
        const isStreamState = key === 'capturedStreams';
        const defaults = isStreamState ? emptyStreams() : {};
        const storageArea = isStreamState ? chrome.storage.local : chrome.storage.session;
        const value = (await storageArea.get({ [key]: defaults }))[key] || defaults;
        await mutator(value);
        await storageArea.set({ [key]: value });
        return value;
    });
    STORAGE_QUEUE[q] = task.catch(error => { requestStats.lastError = error?.message || String(error); });
    return task;
}
async function startStreamWarmup(jobId, label, url, durationMs = 10000) {
    if (!jobId || !url) return;
    const key = `${jobId}:${label}`;
    const controller = new AbortController();
    activeStreamWarmups.set(key, controller);
    const timer = setTimeout(() => controller.abort(), durationMs);
    try {
        const response = await fetch(url, {
            credentials: 'include', cache: 'no-store', redirect: 'follow', signal: controller.signal
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        while (!(await reader.read()).done);
    } catch (error) {
        // The expected error is AbortError when the 10-second warm-up timer
        // expires. Other request failures are also safe to ignore because the
        // warm-up is only an optimization; the real download continues.
    } finally {
        clearTimeout(timer);
        activeStreamWarmups.delete(key);
    }
}
function stopStreamWarmups(jobId) {
    const prefix = `${jobId}:`;
    for (const [key, controller] of activeStreamWarmups) {
        if (key.startsWith(prefix)) { controller.abort(); activeStreamWarmups.delete(key); }
    }
}
let videoOffscreenCreating = null;
let videoOffscreenClosing = null;
let videoOffscreenCloseTimer = null;
async function ensureVideoOffscreen() {
    if (videoOffscreenCloseTimer) {
        clearTimeout(videoOffscreenCloseTimer);
        videoOffscreenCloseTimer = null;
    }
    if (videoOffscreenClosing) await videoOffscreenClosing;
    const url = chrome.runtime.getURL('video-stager.html');
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
        });
        if (contexts.length) return;
    }
    if (!videoOffscreenCreating) {
        videoOffscreenCreating = chrome.offscreen.createDocument({
            url: 'video-stager.html', reasons: ['BLOBS', 'WORKERS'], justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
        }).finally(() => {
            videoOffscreenCreating = null;
        });
    }
    await videoOffscreenCreating;
}
async function closeVideoOffscreen() {
    if (!videoOffscreenClosing) {
        videoOffscreenClosing = Promise.resolve()
            .then(() => chrome.offscreen.closeDocument())
            .catch(() => {});
    }
    const closing = videoOffscreenClosing;
    await closing;
    if (videoOffscreenClosing === closing) videoOffscreenClosing = null;
}
function scheduleVideoOffscreenCloseIfIdle(delayMs) {
    if (videoOffscreenCloseTimer) clearTimeout(videoOffscreenCloseTimer);
    videoOffscreenCloseTimer = setTimeout(async () => {
        videoOffscreenCloseTimer = null;
        try {
            const { videoStageJobs = {} } = await chrome.storage.session.get({ videoStageJobs: {} });
            if (Object.keys(videoStageJobs).length === 0) await closeVideoOffscreen();
        }catch (_) {
        }
    }, delayMs);
}
async function waitForAudioStream(streams, timeoutMs = 6000) {
    if (streams.audio || streams.audioCandidates?.length) {
        return streams;
    }
    const deadline = Date.now() + timeoutMs;
    let current = streams;
    while (Date.now() < deadline) {
        await sleep(200);
        current = await getStoredStreams();
        if (current.audio || current.audioCandidates?.length) {
            return current;
        }
    }
    return current;
}
async function createVideoStageJob(tabId, filename, videoUrl, audioUrl, videoBytes, audioBytes) {
    const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await queueStorageMutation("jobs", "videoStageJobs", async jobs => {
        jobs[jobId] = {
            sourceTabId: Number.isInteger(tabId) ? tabId : null,
            filename,
            videoUrl,
            audioUrl,
            videoBytes,
            audioBytes,
            createdAt: Date.now()
        };
    });
    return jobId;
}
const notifyVideoStagePreload = (tabId, jobId, videoBytes, audioBytes) => sendTab(tabId, { type: "videoStagePreload", jobId, videoBytes, audioBytes });
const notifyVideoStageStarted = (tabId, jobId, videoBytes, audioBytes) => sendTab(tabId, { type: "videoStageStarted", jobId, videoBytes, audioBytes });
async function startVideoStaging(jobId, videoOriginal, audioOriginal) {
    // Start the temporary warm-ups before asking the offscreen document to do
    // the real download. The warm-ups and the real download intentionally run
    // at the same time because the extra traffic can make Drive serve the
    // actual stream faster.
    void Promise.all([
        startStreamWarmup(jobId, "video", videoOriginal, 10000),
        startStreamWarmup(jobId, "audio", audioOriginal, 10000)
    ]);
    await sendOffscreen({ type: "videoStageStart", jobId });
}
async function removeVideoStageJob(jobId) {
    await queueStorageMutation("jobs", "videoStageJobs", async jobs => {
        delete jobs[jobId];
    });
}
async function startVideoDownload(tabId, streams, requestedFilename = "") {
    let current = streams || {};
    const candidates = Array.isArray(current.videoCandidates) && current.videoCandidates.length
        ? current.videoCandidates
        : (current.video ? [current.video] : []);
    if (!candidates.length) {
        return {
            success: false,
            error: "No video captured. Play the video first."
        };
    }
    current = await waitForAudioStream(current);
    const audioOriginal = getBestAudioURL(current);
    if (!audioOriginal) {
        return {
            success: false,
            error: "Audio stream was not captured yet. Keep the video playing for a moment and try again."
        };
    }
    const videoOriginal = current.videoOriginal || candidates[0];
    const videoFetchURL = cleanURL(videoOriginal);
    const audioFetchURL = cleanURL(audioOriginal);
    const videoBytes = getStreamBytes(videoOriginal);
    const audioBytes = getStreamBytes(audioOriginal);
    const finalFilename = sanitizeVideoFilename(
        requestedFilename || current.filename || "gdrive-video"
    );
    const jobId = await createVideoStageJob(
        tabId,
        finalFilename,
        videoFetchURL,
        audioFetchURL,
        videoBytes,
        audioBytes
    );
    await notifyVideoStagePreload(tabId, jobId, videoBytes, audioBytes);
    try {
        await ensureVideoOffscreen();
        await notifyVideoStageStarted(tabId, jobId, videoBytes, audioBytes);
        await startVideoStaging(jobId, videoOriginal, audioOriginal);
        logDebug(`⚡ Stream warm-up started for 10 seconds: ${jobId}`);
        return {
            success: true,
            staging: true,
            jobId,
            videoBytes,
            audioBytes
        };
    } catch (error) {
        stopStreamWarmups(jobId);
        await removeVideoStageJob(jobId);
        return {
            success: false,
            error: error?.message || "Could not start local video staging."
        };
    }
}
const getStoredStreams = async () => (await chrome.storage.local.get({ capturedStreams: emptyStreams() })).capturedStreams;
chrome.webRequest.onBeforeRequest.addListener((details) => {
    const url = details.url;
    if (!url.includes('videoplayback')) return;
    requestStats.total += 1;
    const hasMimeVideo = url.includes('mime=video');
    const hasMimeAudio = url.includes('mime=audio');
    const isGenericVideo = !hasMimeVideo && !hasMimeAudio;
    if (hasMimeVideo || hasMimeAudio || isGenericVideo) {
        if (hasMimeVideo || isGenericVideo) requestStats.video += 1;
        if (hasMimeAudio) requestStats.audio += 1;
        logDebug('🔎 Network traffic detected:', describeStreamURL(url));
        queueStorageMutation('streams', 'capturedStreams', async(currentData) => {
            const timestamp = Date.now();
            let updated = false;
            if ((hasMimeVideo || isGenericVideo) && currentData.videoOriginal !== url) {
                // A real videoplayback request is the reliable fallback when the
                // Drive player lives in a frame that our content script cannot see.
                // The supplied downloader uses this network signal as its playback
                // detection path as well.
                currentData.playbackStarted = true;
                const cleaned = cleanURL(url);
                logDebug('🎥 NEW VIDEO STREAM FOUND!');
                currentData.videoOriginal = url;
                currentData.video = cleaned;
                currentData.videoCandidates = Array.isArray(currentData.videoCandidates)  ? currentData.videoCandidates: [];
                currentData.videoCandidates = [cleaned, ...currentData.videoCandidates.filter(item => item && item !== cleaned)].slice(0, 6);
                currentData.timestamp = timestamp;
                updated = true;
            }
            if (hasMimeAudio) {
                const cleaned = cleanURL(url);
                const audioList = Array.isArray(currentData.audioCandidates)  ? currentData.audioCandidates: [];
                const nextAudioList = [cleaned, ...audioList.filter(item => item && item !== cleaned)].slice(0, 8);
                if (currentData.audioOriginal !== url || JSON.stringify(audioList) !== JSON.stringify(nextAudioList)) {
                    logDebug('🎵 NEW AUDIO STREAM FOUND!');
                    currentData.audioOriginal = url;
                    currentData.audio = cleaned;
                    currentData.audioCandidates = nextAudioList;
                    currentData.timestamp = timestamp;
                    updated = true;
                }
            }
            if (updated) {
                logDebug('✅ Data saved to storage.');
                setBadge('ON');
            }
        }).then(streams => {
            return sendTab(details.tabId, {
                type: 'videoStreamState',
                playbackStarted: streams.playbackStarted,
                hasVideo: !!streams.video
            });
        }).catch(error => {
            requestStats.lastError = error?.message || String(error);
        });
    }
}, {
    urls: ['<all_urls>']
});
async function playVideoInAllFrames(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) {
        return {
            success: false,
            error: 'Invalid Drive tab.'
        };
    }
    const playRoutine = async() => {
        const videos = [];
        const seen = new Set();
        const collect = (root) => {
            try {
                if (!root?.querySelectorAll) return;
                for (const video of root.querySelectorAll('video')) {
                    if (!seen.has(video)) {
                        seen.add(video);
                        videos.push(video);
                    }
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) collect(el.shadowRoot);
                }
            }catch (_) {
            }
        };
        collect(document);
        const visible = videos.filter(video => {
            try {
                const r = video.getBoundingClientRect();
                const style = getComputedStyle(video);
                return r.width > 1 && r.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }catch (_) {
                return false;
            }
        });
        const candidates = (visible.length  ? visible: videos).sort((a, b) => {
            const ap = (!a.paused && !a.ended)  ? 1: 0;
            const bp = (!b.paused && !b.ended)  ? 1: 0;
            if (ap !== bp) return bp - ap;
            try {
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return(br.width * br.height) - (ar.width * ar.height);
            }catch (_) {
                return 0;
            }
        });
        // Mute every discovered media element first. Drive may expose more than
        // one <video> while switching between the thumbnail and the real player.
        for (const video of videos) {
            try {
                video.muted = true;
                video.defaultMuted = true;
                video.volume = 0;
            }catch (_) {
            }
        }
        const results = [];
        for (const video of candidates) {
            try {
                const before = Number(video.currentTime || 0);
                video.muted = true;
                video.defaultMuted = true;
                video.volume = 0;
                let playError = '';
                try {
                    const promise = video.play();
                    if (promise?.then) await promise;
                }catch (error) {
                    playError = error?.message || String(error);
                }
                // Give the media element a moment to transition out of paused state.
                await new Promise(resolve => setTimeout(resolve, 250));
                // Re-apply mute after play(); some players reset volume/muted while
                // initializing the MediaSource pipeline.
                video.muted = true;
                video.defaultMuted = true;
                video.volume = 0;
                const after = Number(video.currentTime || 0);
                const playing = !video.paused && !video.ended && !video.error;
                results.push({
                    attempted: true, before, after, playing, muted: video.muted === true && video.volume === 0, error: playError || (video.error  ? `MediaError ${video.error.code || ''}`.trim(): '')
                });
                if (playing) break;
            }catch (error) {
                results.push({
                    attempted: true, playing: false, error: error?.message || String(error)
                });
            }
        }
        // Some Drive player versions expose a Play control around the media
        // element. Click it only if direct play() did not produce playback.
        if (!results.some(r => r.playing)) {
            try {
                const buttons = [...document.querySelectorAll('button,[role="button"]')];
                const playButton = buttons.find(el => {
                    const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.textContent || ''}`.toLowerCase();
                    return /(^|\b)(play|play video|start playback)(\b|$)/i.test(text);
                });
                if (playButton) {
                    playButton.click();
                    await new Promise(resolve => setTimeout(resolve, 300));
                    for (const video of videos) {
                        try {
                            video.muted = true;
                            video.defaultMuted = true;
                            video.volume = 0;
                        }catch (_) {
                        }
                    }
                    results.push({
                        clicked: true, playing: videos.some(v => !v.paused && !v.ended)
                    });
                }
            }catch (_) {
            }
        }
        return {
            attempted: results.some(r => r.attempted || r.clicked),
            playing: videos.some(v => !v.paused && !v.ended),
            muted: videos.length > 0 && videos.every(v => v.muted === true && v.volume === 0),
            errors: results.map(r => r.error).filter(Boolean).slice(0, 3)
        };
    };
    try {
        const results = await chrome.scripting.executeScript({
            target: {
                tabId, allFrames: true
            }, func: playRoutine
        });
        const attempted = results.some(r => r?.result?.attempted === true);
        const playing = results.some(r => r?.result?.playing === true);
        const muted = results.some(r => r?.result?.muted === true);
        const errors = results.flatMap(r => Array.isArray(r?.result?.errors)  ? r.result.errors: []).filter(Boolean);
        if (!playing) {
            const detail = errors.length  ? ` ${errors[0]}`: '';
            return {
                success: false,
                error: `Could not start the current Drive video.${detail}`,
                attempted,
                muted
            };
        }
        return {
            success: true,
            attempted,
            playing,
            muted
        };
    }catch (error) {
        return {
            success: false,
            error: error?.message || 'Could not access the Drive video player.'
        };
    }
}
async function handleRuntimeMessage(request, sender) {
    const action = request.action;
    const senderTabId = sender.tab?.id;
    if (action === 'playCurrentVideo') return playVideoInAllFrames(senderTabId);

    if (action === 'clearVideoStream' || action === 'clearStreams') {
        if (action === 'clearStreams') logDebug('🧹 Clearing streams...');
        setBadge('');
        await chrome.storage.local.set({ capturedStreams: emptyStreams() });
        await sendTab(senderTabId, { type: 'videoStreamState', playbackStarted: false, hasVideo: false });
        return { success: true };
    }

    if (action === 'updateFilename') {
        logDebug('📝 Filename update request:', request.filename);
        await queueStorageMutation('streams', 'capturedStreams', data => { data.filename = request.filename; });
        return { success: true };
    }

    if (action === 'videoPlaybackStarted') {
        await queueStorageMutation('streams', 'capturedStreams', data => {
            data.playbackStarted = true;
            data.timestamp = Date.now();
        });
        await sendTab(senderTabId, { type: 'videoStreamState', playbackStarted: true });
        logDebug('▶️ Main-page video playback detected.');
        return { success: true };
    }

    if (action === 'getStreams') {
        return { streams: await getStoredStreams() };
    }

    if (action === 'downloadVideo') {
        logDebug('⬇️ Received request to download VIDEO');
        const tabId = Number.isInteger(request.tabId) ? request.tabId : senderTabId;
        const streams = await getStoredStreams();
        return startVideoDownload(tabId, streams, request.filename || streams.filename || '');
    }

    if (request.type === 'getVideoStageJob') {
        const all = (await chrome.storage.session.get({ videoStageJobs: {} })).videoStageJobs || {};
        const job = all[request.jobId];
        return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
    }

    if (request.type?.startsWith('videoStage')) {
        const all = (await chrome.storage.session.get({ videoStageJobs: {} })).videoStageJobs || {};
        const job = all[request.jobId];
        if (job?.sourceTabId != null) await sendTab(job.sourceTabId, { type: request.type, ...request });

        if (request.type === 'videoStageCancel') {
            await sendOffscreen({ type: 'videoStageCancelInternal', jobId: request.jobId });
            stopStreamWarmups(request.jobId);
            if (job?.sourceTabId != null) await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId: request.jobId });
            await removeVideoStageJob(request.jobId);
            scheduleVideoOffscreenCloseIfIdle(100);
            return { success: true };
        }

        if (request.type === 'videoStageFinished' || request.type === 'videoStageError') {
            stopStreamWarmups(request.jobId);
            await removeVideoStageJob(request.jobId);
            scheduleVideoOffscreenCloseIfIdle(1200);
        }
        return { success: true };
    }

    if (action === 'ping') {
        const streams = await getStoredStreams();

        return {
            success: true,
            serviceWorkerAlive: true,
            monitoring: {
                active: true,
                totalRequests: 'Auto',
                videosCaptured: +!!streams.video,
                audiosCaptured: +!!streams.audio
            }
        };
    }

    if (action === 'getDiagnostics') {
        const streams = await getStoredStreams();
        const diagnostics = {
            serviceWorkerStartTime: SERVICE_WORKER_START,
            lastActivity: streams.timestamp || Date.now(),
            totalRequestsMonitored: requestStats.total,
            videoRequestsCaptured: requestStats.video,
            audioRequestsCaptured: requestStats.audio,
            webRequestListenerActive: true,
            lastError: requestStats.lastError,
            uptime: Date.now() - SERVICE_WORKER_START
        };

        return {
            success: true,
            diagnostics
        };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.target === 'video-offscreen') return false;
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => {
            sendResponse({
                success: false,
                error: error?.message || String(error)
            });
        });

    return true;
});
console.log('[GDrive SW] Service Worker Initialized');
