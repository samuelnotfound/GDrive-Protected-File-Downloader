/**
 * Background Service Worker
 * Captures Google Drive media requests, manages stream/job state, runs warm-up requests,
 * and coordinates the offscreen video download/processing pipeline.
 */

function cleanURL(url) {
    if (!url) return null;
    const value = String(url);
    const rangeIndex = value.search(/[?&]range=/i);
    return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
}
function sanitizeVideoFilename(name) {
    let value = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/[\x00-\x1F]/g, '').trim();
    if (!value) value = 'gdrive-video';
    return /\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value) ? value : `${value}.mp4`;
}

const emptyStreams = () => ({
    video: null,
    audio: null,
    videoOriginal: null,
    audioOriginal: null,
    audioCandidates: [],
    videoCandidates: [],
    videoFormats: [],
    audioFormats: [],
    formatFileId: '',
    formatsFetchedAt: 0,
    activeFileId: '',
    playbackStarted: false,
    filename: 'gdrive-video',
    timestamp: null
});

function getStreamBytes(url) {
    if (!url) return 0;
    try {
        const bytes = Number(new URL(url).searchParams.get('clen'));
        return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    } catch (_) {
        return 0;
    }
}

function getBestAudioURL(streams) {
    const candidates = streams?.audioCandidates?.length
        ? streams.audioCandidates
        : streams?.audio
            ? [streams.audioOriginal || streams.audio]
            : [];
    return candidates.reduce(
        (best, url) => getStreamBytes(url) > getStreamBytes(best) ? url : best,
        null
    );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendTab = async (tabId, message) => {
    if (!Number.isInteger(tabId)) return;
    try { await chrome.tabs.sendMessage(tabId, message); } catch (_) {}
};
const sendOffscreen = message => {
    try {
        chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch?.(() => {});
    } catch (_) {}
};
const setBadge = text => {
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {}
};

// Drive-specific speed optimization: start a short-lived duplicate fetch for
// each source while the real offscreen download starts. The warm-up data is
// discarded and the requests are aborted after 10 seconds or when the job ends.
const activeStreamWarmups = new Map();

function startStreamWarmup(jobId, label, url, durationMs = 10000) {
    if (!jobId || !url) return;

    const key = `${jobId}:${label}`;
    const controller = new AbortController();
    activeStreamWarmups.set(key, controller);

    const timer = setTimeout(() => controller.abort(), durationMs);
    fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
    }).then(response => {
        if (!response.ok || !response.body) return;
        return (async () => {
            const reader = response.body.getReader();
            try {
                while (!(await reader.read()).done) {}
            } finally {
                try { await reader.cancel(); } catch (_) {}
            }
        })();
    }).catch(() => {
        // Warm-up is an optimization; failures must not affect the real download.
    }).finally(() => {
        clearTimeout(timer);
        activeStreamWarmups.delete(key);
    });
}

function stopStreamWarmups(jobId) {
    const prefix = `${jobId}:`;
    for (const [key, controller] of activeStreamWarmups) {
        if (!key.startsWith(prefix)) continue;
        try { controller.abort(); } catch (_) {}
        activeStreamWarmups.delete(key);
    }
}

let streamsCache = null;
let streamsQueue = Promise.resolve();
let jobsCache = null;
let jobsQueue = Promise.resolve();

async function loadStreams() {
    if (!streamsCache) {
        const result = await chrome.storage.local.get({ capturedStreams: emptyStreams() });
        streamsCache = result.capturedStreams || emptyStreams();
    }
    return streamsCache;
}

function queueStreamMutation(mutator) {
    const task = streamsQueue.then(async () => {
        const streams = await loadStreams();
        const changed = await mutator(streams);
        if (changed !== false) await chrome.storage.local.set({ capturedStreams: streams });
        return streams;
    });
    streamsQueue = task.catch(error => {
        console.error('[GDrive SW] Stream storage update failed:', error);
    });
    return task;
}

async function loadJobs() {
    if (jobsCache) return jobsCache;
    const result = await chrome.storage.local.get({ videoStageJobs: {} });
    jobsCache = result.videoStageJobs || {};
    return jobsCache;
}

function queueJobMutation(mutator) {
    const task = jobsQueue.then(async () => {
        const jobs = await loadJobs();
        const changed = await mutator(jobs);
        if (changed !== false) await chrome.storage.local.set({ videoStageJobs: jobs });
        return jobs;
    });
    jobsQueue = task.catch(error => {
        console.error('[GDrive SW] Stage job storage update failed:', error);
    });
    return task;
}

async function getStoredJobs() {
    await jobsQueue.catch(() => {});
    return loadJobs();
}

async function getStoredStreams() {
    await streamsQueue.catch(() => {});
    return loadStreams();
}

async function replaceStoredStreams(value) {
    const task = streamsQueue.then(async () => {
        streamsCache = value;
        await chrome.storage.local.set({ capturedStreams: value });
        return value;
    });
    streamsQueue = task.catch(error => {
        console.error('[GDrive SW] Stream storage update failed:', error);
    });
    return task;
}

async function waitForAudioStream(streams, timeoutMs = 6000) {
    if (streams.audio || streams.audioCandidates?.length) return streams;
    const deadline = Date.now() + timeoutMs;
    let current = streams;
    while (Date.now() < deadline) {
        await sleep(200);
        current = await getStoredStreams();
        if (current.audio || current.audioCandidates?.length) return current;
    }
    return current;
}

let videoOffscreenCreating = null;
async function ensureVideoOffscreen() {
    const url = chrome.runtime.getURL('video-offscreen.html');
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
        });
        if (contexts.length) return;
    }
    if (!videoOffscreenCreating) {
        videoOffscreenCreating = chrome.offscreen.createDocument({
            url: 'video-offscreen.html',
            reasons: ['BLOBS', 'WORKERS'],
            justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
        }).finally(() => {
            videoOffscreenCreating = null;
        });
    }
    await videoOffscreenCreating;
}

async function closeVideoOffscreen() {
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
}

async function createVideoStageJob(tabId, filename, videoUrl, audioUrl, videoBytes, audioBytes, resolution) {
    const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await queueJobMutation(jobs => {
        jobs[jobId] = {
            sourceTabId: Number.isInteger(tabId) ? tabId : null,
            filename,
            videoUrl,
            audioUrl,
            videoBytes,
            audioBytes,
            resolution: String(resolution || ''),
            createdAt: Date.now()
        };
    });
    return jobId;
}

async function removeVideoStageJob(jobId) {
    await queueJobMutation(jobs => {
        delete jobs[jobId];
    });
}

function getVideoResolution(url, fallback = '') {
    const supplied = String(fallback || '').trim();
    if (/^\d{3,4}p$/i.test(supplied)) return supplied.toLowerCase();
    if (/^(?:hd)?\d{3,4}$/i.test(supplied)) return `${supplied.match(/\d{3,4}/)[0]}p`;
    if (!url) return '';

    // Google Drive videoplayback URLs do not consistently expose the
    // resolution as a width/height query parameter. The selected stream
    // commonly carries a format id (itag), so use known video mappings as
    // the strongest URL-based fallback.
    const itagHeights = {
        18: 360, 22: 720, 34: 360, 35: 480, 37: 1080, 59: 480, 78: 480,
        133: 240, 134: 360, 135: 480, 136: 720, 137: 1080,
        243: 360, 244: 480, 247: 720, 248: 1080, 278: 144,
        242: 240, 245: 480, 246: 480, 271: 1440, 308: 1440, 313: 2160, 315: 2160
    };

    try {
        const parsed = new URL(url);
        const params = parsed.searchParams;
        const size = params.get('size') || params.get('resolution') || '';
        const sizeMatch = size.match(/(?:^|x)(\d{3,4})$/i) || size.match(/^(\d{3,4})x/i);
        if (sizeMatch) return `${sizeMatch[1]}p`;

        for (const key of ['height', 'quality', 'res']) {
            const value = params.get(key) || '';
            const match = String(value).match(/(?:^|\D)(\d{3,4})p?(?:\D|$)/i);
            const height = match ? Number(match[1]) : Number(value);
            if (Number.isInteger(height) && height >= 144 && height <= 4320) return `${height}p`;
        }

        const itag = Number(params.get('itag'));
        if (Number.isInteger(itag) && itagHeights[itag]) return `${itagHeights[itag]}p`;

        const urlMatch = url.match(/(?:^|[?&_])(?:size|resolution|quality|height)[=:_-]?(?:\d{3,4}x)?(\d{3,4})p?(?:[&_]|$)/i);
        if (urlMatch) return `${urlMatch[1]}p`;
    } catch (_) {
    }
    return '';
}


const DRIVE_PLAYBACK_ENDPOINTS = [
    'https://content-workspacevideo-pa.googleapis.com/v1/drive/media/{id}/playback',
    'https://workspacevideo-pa.googleapis.com/v1/drive/media/{id}/playback'
];
const DRIVE_PLAYBACK_API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';

function normalizeQuality(value) {
    const match = String(value || '').match(/(?:^|\D)(\d{3,4})p?/i);
    return match ? `${Number(match[1])}p` : '';
}

function isVideoFormat(format) {
    const meta = format?.transcodeMetadata || {};
    const mime = String(meta.mimeType || format.mimeType || '').toLowerCase();
    const hasVideoCodec = meta.videoCodecString && !/^none$/i.test(String(meta.videoCodecString));
    return hasVideoCodec || mime.startsWith('video/') || Number(meta.height) > 0;
}

function isAudioFormat(format) {
    const meta = format?.transcodeMetadata || {};
    const mime = String(meta.mimeType || format.mimeType || '').toLowerCase();
    const hasAudioCodec = meta.audioCodecString && !/^none$/i.test(String(meta.audioCodecString));
    return hasAudioCodec || mime.startsWith('audio/');
}

function parsePlaybackFormats(data) {
    const formatData = data?.mediaStreamingData?.formatStreamingData || {};
    const rawFormats = [
        ...(Array.isArray(formatData.adaptiveTranscodes) ? formatData.adaptiveTranscodes : []),
        ...(Array.isArray(formatData.progressiveTranscodes) ? formatData.progressiveTranscodes : [])
    ];
    const videos = [];
    const audios = [];
    const videoByQuality = new Map();

    for (const format of rawFormats) {
        if (!format?.url) continue;
        const meta = format.transcodeMetadata || {};
        const width = Number(meta.width) || 0;
        const height = Number(meta.height) || 0;
        const bytes = Number(meta.contentLength) || getStreamBytes(format.url);
        const mime = String(meta.mimeType || '').toLowerCase();
        const itag = Number(format.itag) || 0;
        const hasVideo = isVideoFormat(format);
        const hasAudio = isAudioFormat(format);

        if (hasVideo && height > 0) {
            const quality = `${height}p`;
            const item = {
                url: format.url,
                quality,
                width,
                height,
                bytes,
                itag,
                mime,
                hasAudio
            };
            const current = videoByQuality.get(quality);
            const score = (hasAudio ? 0 : 1000000000000) + (mime === 'video/mp4' ? 1000000000 : 0) + bytes;
            const currentScore = current?.score || -1;
            if (score > currentScore) videoByQuality.set(quality, { ...item, score });
        }

        if (hasAudio && !hasVideo) {
            audios.push({
                url: format.url,
                bytes,
                itag,
                mime,
                codec: String(meta.audioCodecString || '')
            });
        }
    }

    return {
        videos: [...videoByQuality.values()]
            .sort((a, b) => b.height - a.height)
            .map(({ score, ...item }) => item),
        audios: audios.sort((a, b) => b.bytes - a.bytes)
    };
}

async function fetchDrivePlaybackFormats(fileId) {
    const id = String(fileId || '').trim();
    if (!id) return { success: false, error: 'Drive file ID is missing.' };

    let lastError = '';
    for (const template of DRIVE_PLAYBACK_ENDPOINTS) {
        const url = `${template.replace('{id}', encodeURIComponent(id))}?key=${encodeURIComponent(DRIVE_PLAYBACK_API_KEY)}`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4500);
            const response = await fetch(url, {
                credentials: 'include',
                cache: 'no-store',
                referrer: 'https://drive.google.com/',
                referrerPolicy: 'strict-origin-when-cross-origin',
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!response.ok) {
                lastError = `Playback metadata request failed (${response.status}).`;
                continue;
            }
            const data = await response.json();
            const formats = parsePlaybackFormats(data);
            if (formats.videos.length) return { success: true, ...formats };
            lastError = 'Google Drive returned no downloadable video formats.';
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }
    return { success: false, error: lastError || 'Could not read Google Drive playback metadata.' };
}

async function refreshVideoFormats(fileId) {
    const result = await fetchDrivePlaybackFormats(fileId);
    if (!result.success) return result;
    await queueStreamMutation(streams => {
        if (streams.activeFileId && streams.activeFileId !== String(fileId)) return false;
        if (streams.formatFileId === String(fileId) && streams.formatsFetchedAt &&
            Date.now() - streams.formatsFetchedAt < 15000 && streams.videoFormats?.length) {
            return false;
        }
        streams.videoFormats = result.videos;
        streams.audioFormats = result.audios;
        streams.formatFileId = String(fileId);
        streams.formatsFetchedAt = Date.now();
        return true;
    });
    return result;
}

function getBestVideoFormat(streams, requestedResolution = '') {
    const formats = Array.isArray(streams?.videoFormats) ? streams.videoFormats : [];
    if (!formats.length) return null;
    const requested = normalizeQuality(requestedResolution);
    return requested ? formats.find(format => format.quality === requested) || null : formats[0];
}

function getBestAudioFromFormats(streams) {
    const format = Array.isArray(streams?.audioFormats) ? streams.audioFormats[0] : null;
    return format?.url || null;
}

async function startVideoDownload(tabId, streams, requestedFilename = "", requestedResolution = "", fileId = "") {
    let current = streams || {};
    const requestedFormat = getBestVideoFormat(current, requestedResolution);
    const candidates = Array.isArray(current.videoCandidates) && current.videoCandidates.length
        ? current.videoCandidates
        : (current.video ? [current.video] : []);

    if (!requestedFormat && fileId) {
        const refreshed = await refreshVideoFormats(fileId);
        if (refreshed.success) current = await getStoredStreams();
    }

    const selectedFormat = getBestVideoFormat(current, requestedResolution);
    if (requestedResolution && !selectedFormat) {
        return {
            success: false,
            error: `The selected ${normalizeQuality(requestedResolution)} stream is no longer available. Play the video again and retry.`
        };
    }
    const selectedVideoURL = selectedFormat?.url || current.videoOriginal || candidates[0];
    if (!selectedVideoURL) {
        return {
            success: false,
            error: "No video stream is available yet. Play the video so Google Drive exposes a stream, then try again."
        };
    }

    current = await waitForAudioStream(current);
    const audioOriginal = getBestAudioFromFormats(current) || getBestAudioURL(current);
    if (!audioOriginal) {
        return {
            success: false,
            error: "No audio stream is available yet. Play the video so Google Drive exposes the audio stream, then try again."
        };
    }

    const videoOriginal = selectedVideoURL;
    const videoFetchURL = cleanURL(videoOriginal);
    const audioFetchURL = cleanURL(audioOriginal);
    const videoBytes = Number(selectedFormat?.bytes) || getStreamBytes(videoOriginal);
    const audioBytes = getStreamBytes(audioOriginal);
    const resolution = selectedFormat?.quality || getVideoResolution(videoOriginal) ||
        candidates.map(url => getVideoResolution(url)).find(Boolean) || requestedResolution || '';
    const finalFilename = sanitizeVideoFilename(
        requestedFilename || current.filename || "gdrive-video"
    );
    const jobId = await createVideoStageJob(
        tabId,
        finalFilename,
        videoFetchURL,
        audioFetchURL,
        videoBytes,
        audioBytes,
        resolution
    );
    try {
        await sendTab(tabId, { type: 'videoStagePreload', jobId, videoBytes, audioBytes, resolution });
        await ensureVideoOffscreen();
        await sendTab(tabId, { type: 'videoStageStarted', jobId, videoBytes, audioBytes, resolution });

        // Intentionally duplicate the requests: the warm-ups prime Drive's
        // serving path while the real downloads retain the actual data.
        startStreamWarmup(jobId, 'video', videoOriginal);
        startStreamWarmup(jobId, 'audio', audioOriginal);
        sendOffscreen({ type: 'videoStageStart', jobId });
        return {
            success: true,
            staging: true,
            jobId,
            videoBytes,
            audioBytes,
            resolution
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
chrome.webRequest.onBeforeRequest.addListener(details => {
    const url = details.url;
    const hasMimeVideo = url.includes('mime=video');
    const hasMimeAudio = url.includes('mime=audio');
    const isGenericVideo = !hasMimeVideo && !hasMimeAudio;
    queueStreamMutation(streams => {
        const timestamp = Date.now();
        let changed = false;
        const cleaned = cleanURL(url);

        if (hasMimeVideo || isGenericVideo) {
            const candidates = Array.isArray(streams.videoCandidates) ? streams.videoCandidates : [];
            if (streams.video !== cleaned) {
                streams.video = cleaned;
                streams.videoOriginal = url;
                streams.videoCandidates = [
                    cleaned,
                    ...candidates.filter(item => item && item !== cleaned)
                ].slice(0, 6);
                changed = true;
            } else if (!streams.videoOriginal) {
                streams.videoOriginal = url;
                changed = true;
            }
            const quality = getVideoResolution(url);
            if (quality) {
                const formats = Array.isArray(streams.videoFormats) ? streams.videoFormats : [];
                const existing = formats.find(item => item.quality === quality);
                if (!existing || getStreamBytes(url) > Number(existing.bytes || 0)) {
                    streams.videoFormats = [
                        { url, quality, bytes: getStreamBytes(url), width: 0, height: Number(quality.replace('p', '')) || 0, itag: Number(new URL(url).searchParams.get('itag')) || 0 },
                        ...formats.filter(item => item.quality !== quality)
                    ].sort((a, b) => b.height - a.height).slice(0, 8);
                    changed = true;
                }
            }
            streams.playbackStarted = true;
        }

        if (hasMimeAudio) {
            const candidates = Array.isArray(streams.audioCandidates) ? streams.audioCandidates : [];
            if (!candidates.includes(cleaned)) {
                streams.audioCandidates = [cleaned, ...candidates.filter(item => item)].slice(0, 8);
                streams.audio = cleaned;
                streams.audioOriginal = url;
                changed = true;
            } else if (!streams.audioOriginal) {
                streams.audioOriginal = url;
                streams.audio = cleaned;
                changed = true;
            }
        }

        if (changed) {
            streams.timestamp = timestamp;
            setBadge('ON');
        }
        return changed;
    }).catch(() => {});
}, {
    urls: ['*://*/videoplayback*']
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

    if (action === 'playCurrentVideo') return playVideoInAllFrames(sender.tab?.id);

    if (action === 'clearVideoStream' || action === 'clearStreams') {
        setBadge('');
        const streams = emptyStreams();
        streams.activeFileId = String(request.fileId || '');
        await replaceStoredStreams(streams);
        return { success: true };
    }

    if (action === 'updateFilename') {
        await queueStreamMutation(streams => {
            const filename = String(request.filename || '').trim();
            if (!filename || streams.filename === filename) return false;
            streams.filename = filename;
            return true;
        });
        return { success: true };
    }

    if (action === 'videoPlaybackStarted') {
        const fileId = String(request.fileId || '').trim();
        await queueStreamMutation(streams => {
            let changed = false;
            if (fileId && streams.activeFileId !== fileId) {
                streams.activeFileId = fileId;
                streams.formatFileId = '';
                streams.formatsFetchedAt = 0;
                streams.videoFormats = [];
                streams.audioFormats = [];
                changed = true;
            }
            if (!streams.playbackStarted) {
                streams.playbackStarted = true;
                streams.timestamp = Date.now();
                changed = true;
            }
            return changed;
        });
        if (fileId) refreshVideoFormats(fileId).catch(() => {});
        return { success: true };
    }

    if (action === 'getStreams') return { streams: await getStoredStreams() };

    if (action === 'getVideoFormats') {
        const fileId = String(request.fileId || '').trim();
        if (!fileId) return { success: false, error: 'Drive file ID is missing.' };
        const streams = await getStoredStreams();
        const fresh = streams.formatFileId === fileId &&
            streams.formatsFetchedAt && Date.now() - streams.formatsFetchedAt < 10000;
        if (fresh && streams.videoFormats?.length) {
            return { success: true, videos: streams.videoFormats, audios: streams.audioFormats || [] };
        }
        const refreshed = await refreshVideoFormats(fileId);
        if (refreshed.success) return refreshed;
        if (streams.formatFileId === fileId && streams.videoFormats?.length) {
            return { success: true, videos: streams.videoFormats, audios: streams.audioFormats || [], stale: true };
        }
        return refreshed;
    }

    if (action === 'downloadVideo') {
        let streams = await getStoredStreams();
        const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
        return startVideoDownload(
            tabId,
            streams,
            request.filename || streams.filename || '',
            request.resolution || '',
            request.fileId || ''
        );
    }

    if (request.type === 'getVideoStageJob') {
        const jobs = await getStoredJobs();
        const job = jobs[request.jobId];
        return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
    }

    if (request.type?.startsWith('videoStage')) {
        const jobs = await getStoredJobs();
        const job = jobs[request.jobId];

        if (job?.sourceTabId != null && request.type !== 'videoStageCancel') {
            await sendTab(job.sourceTabId, { type: request.type, ...request, resolution: request.resolution || job.resolution || '' });
        }

        if (request.type === 'videoStageCancel') {
            stopStreamWarmups(request.jobId);
            sendOffscreen({ type: 'videoStageCancelInternal', jobId: request.jobId });
            if (job?.sourceTabId != null) {
                await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId: request.jobId });
            }
            setTimeout(closeVideoOffscreen, 100);
            await queueJobMutation(currentJobs => {
                if (!currentJobs[request.jobId]) return false;
                delete currentJobs[request.jobId];
                return true;
            });
            return { success: true };
        }

        if (request.type === 'videoStageFinished' || request.type === 'videoStageError') {
            stopStreamWarmups(request.jobId);
            setTimeout(closeVideoOffscreen, 1200);
            await queueJobMutation(currentJobs => {
                if (!currentJobs[request.jobId]) return false;
                delete currentJobs[request.jobId];
                return true;
            });
        }
        return { success: true };
    }

}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
