function postStageMessage(type, payload = {
}) {
    try {
        chrome.runtime.sendMessage({
            type, ...payload
        }).catch?.(() => {});
    }catch (_) {
    }
}
function makeFullRangeURL(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        const clen = Number(parsed.searchParams.get('clen'));
        if (Number.isSafeInteger(clen) && clen > 0) {
            parsed.searchParams.set('range', `0-${clen - 1}`);
        }
        return parsed.toString();
    } catch (_) {
        return url;
    }
}
async function fetchToBlob(url, label, jobId, signal, expectedTotal = 0) {
    const response = await fetch(makeFullRangeURL(url), {
        credentials: 'include', cache: 'no-store', signal
    });
    if (!response.ok) throw new Error(`${label} request failed (${response.status})`);

    const contentRange = response.headers.get('content-range') || '';
    const rangeMatch = contentRange.match(/\/([0-9]+)\s*$/);
    const total = (rangeMatch ? Number(rangeMatch[1]) : 0)
        || Number(response.headers.get('content-length'))
        || Number(expectedTotal)
        || 0;

    if (!response.body || typeof TransformStream !== 'function') {
        const blob = await response.blob();
        postStageMessage('videoStageProgress', {
            jobId, label, received: blob.size, total: total || blob.size
        });
        return blob;
    }

    let received = 0;
    let lastReport = 0;
    const stream = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            received += chunk.byteLength;
            const now = performance.now();
            if (now - lastReport >= 250 || (total && received >= total)) {
                lastReport = now;
                postStageMessage('videoStageProgress', { jobId, label, received, total });
            }
            controller.enqueue(chunk);
        }
    }));

    const blob = await new Response(stream).blob();
    postStageMessage('videoStageProgress', {
        jobId, label, received, total: total || blob.size
    });
    return blob;
}

// Keep these at module scope so cancellation can abort active fetches or FFmpeg.
let cancelled = false;
let sourceController = null;
let activeWorker = null;
// Offscreen runtime message handling
chrome.runtime.onMessage.addListener(message => {
    if (message?.target === 'video-offscreen' && message.type === 'videoStageStart') {
        runStagingJob(message.jobId).catch(error => finishError(message.jobId, error));
    }
    if (message?.target === 'video-offscreen' && message.type === 'videoStageCancelInternal') {
        cancelled = true;
        try {
            sourceController?.abort();
        } catch (_) {
        }
        try {
            activeWorker?.terminate();
        }catch (_) {
        }
        sourceController = null;
        activeWorker = null;
    }
});
function isAbortError(error) {
    return cancelled || error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
}
function finishError(jobId, error) {
    const payload = {
        jobId,
        message: error?.message || String(error)
    };
    postStageMessage(isAbortError(error)  ? 'videoStageCancelled': 'videoStageError', payload);
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
function throwIfCancelled() {
    if (!cancelled) return;
    throw Object.assign(new Error("Download cancelled."), {
        name: "AbortError"
    });
}
// Download both source streams in parallel so FFmpeg can merge them immediately.
async function downloadSourceStreams(job) {
    postStageMessage("videoStageStatus", {
        jobId: job.jobId,
        stage: "download",
        message: "Downloading full video and audio streams…"
    });
    sourceController = new AbortController();
    try {
        return await Promise.all([
            fetchToBlob(
                job.videoUrl,
                "video",
                job.jobId,
                sourceController.signal,
                job.videoBytes || 0
            ),
            fetchToBlob(
                job.audioUrl,
                "audio",
                job.jobId,
                sourceController.signal,
                job.audioBytes || 0
            )
        ]);
    } finally {
        sourceController = null;
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
async function mergeStreams(job, videoBlob, audioBlob) {
    const worker = new Worker(
        chrome.runtime.getURL("vendor/ffmpeg-mux-worker.js")
    );
    activeWorker = worker;
    try {
        return await new Promise((resolve, reject) => {
            worker.onmessage = event => {
                const data = event.data || {};
                if (data.type === "status") {
                    postStageMessage("videoStageStatus", {
                        jobId: job.jobId,
                        stage: "merge",
                        message: data.message
                    });
                    return;
                }
                if (data.type === "ffmpeg-progress") {
                    postStageMessage("videoStageMergeProgress", {
                        jobId: job.jobId,
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
        activeWorker = null;
    }
}
async function runStagingJob(jobId) {
    cancelled = false;
    const job = { ...(await getJob(jobId)), jobId };
    const [videoBlob, audioBlob] = await downloadSourceStreams(job);
    throwIfCancelled();
    const mergedBlob = await mergeStreams(job, videoBlob, audioBlob);
    throwIfCancelled();
    postStageMessage("videoStageStatus", {
        jobId,
        stage: "processing"
    });
    await triggerDownload(mergedBlob, job.filename, jobId);
    postStageMessage("videoStageFinished", { jobId });
}
