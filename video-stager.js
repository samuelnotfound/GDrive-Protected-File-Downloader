function postStageMessage(type, payload = {
}) {
    try {
        chrome.runtime.sendMessage({
            type, ...payload
        });
    }catch (_) {
    }
}
function makeFullRangeURL(url) {
    if (!url) return url;
    try {
        const u = new URL(url),
        clen = Number(u.searchParams.get('clen'));
        if (Number.isSafeInteger(clen) && clen > 0) u.searchParams.set('range', `0-${clen-1}`);
        return u.toString();
    }catch (_) {
        return url;
    }
}
async function fetchToBlob(url, label, jobId, signal, expectedTotal = 0) {
    const response = await fetch(makeFullRangeURL(url), {
        credentials: 'include', cache: 'no-store', signal
    });
    if (!response.ok) throw new Error(`${label} request failed (${response.status})`);
    const contentRange = response.headers.get('content-range') || '',
    rangeMatch = contentRange.match(/\/([0-9]+)\s*$/),
    total = (rangeMatch  ? Number(rangeMatch[1]): 0) || Number(response.headers.get('content-length')) || Number(expectedTotal) || 0,
    reader = response.body?.getReader?.();
    if (!reader) {
        const blob = await response.blob();
        postStageMessage('videoStageProgress', {
            jobId, label, received: blob.size, total: total || blob.size
        });
        return blob;
    }
    const chunks = [];
    let received = 0,
    lastReport = 0;
    while (true) {
        const {
            done,
            value
        }
        = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.byteLength;
            const now = performance.now();
            if (now - lastReport >= 100 || (total && received >= total)) {
                lastReport = now;
                postStageMessage('videoStageProgress', {
                    jobId, label, received, total
                });
            }
        }
    }
    postStageMessage('videoStageProgress', {
        jobId, label, received, total
    });
    return new Blob(chunks);
}
// Keep each job's cancellable resources separate. Multiple Drive tabs can
// legitimately start downloads while the same offscreen document is alive.
const activeJobs = new Map();
// Offscreen runtime message handling
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target === 'video-offscreen' && message.type === 'videoStageStart') {
        const jobId = message.jobId;
        if (!jobId) {
            sendResponse({ accepted: false, error: 'A staging job id is required.' });
            return;
        }
        if (activeJobs.has(jobId)) {
            sendResponse({ accepted: true });
            return;
        }
        const state = {
            cancelled: false,
            videoController: null,
            audioController: null,
            worker: null
        };
        activeJobs.set(jobId, state);
        sendResponse({ accepted: true });
        runStagingJob(jobId, state)
            .catch(error => finishError(jobId, error, state))
            .finally(() => activeJobs.delete(jobId));
    }
    if (message?.target === 'video-offscreen' && message.type === 'videoStageCancelInternal') {
        const state = activeJobs.get(message.jobId);
        if (!state) {
            sendResponse({ accepted: false, error: 'The staging job is no longer active.' });
            return;
        }
        state.cancelled = true;
        try {
            state.videoController?.abort();
        }catch (_) {
        }
        try {
            state.audioController?.abort();
        }catch (_) {
        }
        try {
            state.worker?.terminate();
        }catch (_) {
        }
        sendResponse({ accepted: true });
    }
});
function isAbortError(error, state) {
    return state?.cancelled || error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
}
function finishError(jobId, error, state) {
    const payload = {
        jobId,
        message: error?.message || String(error)
    };
    postStageMessage(isAbortError(error, state)  ? 'videoStageCancelled': 'videoStageError', payload);
}
async function getJob(jobId) {
    return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'getVideoStageJob', jobId
        }, response => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!response?.job) reject(new Error(response?.error || 'Staging job was not found.'));
            else resolve(response.job);
        });
    });
}
async function triggerDownload(blob, filename, jobId) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    postStageMessage('videoStageDownloadStarted', {
        jobId
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function throwIfCancelled(state) {
    if (!state.cancelled) return;
    throw Object.assign(new Error("Download cancelled."), {
        name: "AbortError"
    });
}
// Download the actual source streams used to build the final video.
//
// This is separate from the short-lived stream warm-up in background.js. The
// warm-up is only a speed optimization; these fetches are the real downloads
// whose data is retained and later merged into the final file.
async function downloadSourceStreams(jobId, job, state) {
    postStageMessage("videoStageStatus", {
        jobId,
        stage: "download",
        message: "Downloading full video and audio streams…"
    });
    state.videoController = new AbortController();
    state.audioController = new AbortController();
    try {
        return await Promise.all([
            fetchToBlob(
                job.videoUrl,
                "video",
                jobId,
                state.videoController.signal,
                job.videoBytes || 0
            ),
            fetchToBlob(
                job.audioUrl,
                "audio",
                jobId,
                state.audioController.signal,
                job.audioBytes || 0
            )
        ]);
    } finally {
        state.videoController = null;
        state.audioController = null;
    }
}
function getAudioCodec(url) {
    try {
        const parsedURL = new URL(url);
        const codecs = parsedURL.searchParams.get("codecs") || "";
        const mime = parsedURL.searchParams.get("mime") || "";
        if (/mp4a/i.test(codecs) || /audio\/mp4/i.test(mime)) {
            return "aac";
        }
    } catch (_) {
        // Some captured URLs may not contain a complete query string.
    }
    return "";
}
async function mergeStreams(jobId, job, videoBlob, audioBlob, state) {
    const worker = new Worker(
        chrome.runtime.getURL("vendor/ffmpeg-mux-worker.js")
    );
    state.worker = worker;
    try {
        return await new Promise((resolve, reject) => {
            worker.onmessage = event => {
                const data = event.data || {};
                if (data.type === "source-progress") {
                    postStageMessage("videoStageProgress", {
                        jobId,
                        label: data.label,
                        received: data.received,
                        total: data.total
                    });
                    return;
                }
                if (data.type === "status") {
                    postStageMessage("videoStageStatus", {
                        jobId,
                        stage: "merge",
                        message: data.message
                    });
                    return;
                }
                if (data.type === "ffmpeg-log") {
                    postStageMessage("videoStageLog", {
                        jobId,
                        message: data.message
                    });
                    return;
                }
                if (data.type === "ffmpeg-progress") {
                    postStageMessage("videoStageMergeProgress", {
                        jobId,
                        progress: Math.max(
                            0,
                            Math.min(1, Number(data.progress) || 0)
                        ),
                        mergeTimeUs: Number(data.time) || 0,
                        mergeDurationUs: Number(data.duration) || 0,
                        frame: Number(data.frame) || 0
                    });
                    return;
                }
                if (data.type === "done") {
                    resolve(data.blob);
                    return;
                }
                if (data.type === "error") {
                    reject(new Error(data.message || "FFmpeg failed."));
                }
            };
            worker.onerror = event => {
                reject(new Error(event.message || "FFmpeg worker failed."));
            };
            worker.postMessage({
                type: "mux",
                video: videoBlob,
                audio: audioBlob,
                audioCodec: getAudioCodec(job.audioUrl)
            });
        });
    } finally {
        try {
            worker.terminate();
        } catch (_) {
        }
        state.worker = null;
    }
}
async function runStagingJob(jobId, state) {
    const job = await getJob(jobId);
    const [videoBlob, audioBlob] = await downloadSourceStreams(jobId, job, state);
    throwIfCancelled(state);
    const mergedBlob = await mergeStreams(jobId, job, videoBlob, audioBlob, state);
    throwIfCancelled(state);
    postStageMessage("videoStageStatus", {
        jobId,
        stage: "processing"
    });
    await triggerDownload(mergedBlob, job.filename, jobId);
    postStageMessage("videoStageFinished", { jobId });
}
