const JOB_DB = 'gdrive-video-staging', JOB_STORE = 'jobs';
function openStagingDatabase() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(JOB_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(JOB_STORE)) db.createObjectStore(JOB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Could not open local staging storage.'));
    });
}
async function saveStagedValue(key, value) {
    const db = await openStagingDatabase();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(JOB_STORE, 'readwrite');
        tx.objectStore(JOB_STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Could not save staged data.'));
    });
    db.close();
}
async function readStagedValue(key) {
    const db = await openStagingDatabase();
    const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(JOB_STORE, 'readonly');
        const req = tx.objectStore(JOB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Could not read staged job.'));
    });
    db.close();
    return value;
}
async function deleteStagedValue(key) {
    const db = await openStagingDatabase();
    await new Promise(resolve => {
        const tx = db.transaction(JOB_STORE, 'readwrite');
        tx.objectStore(JOB_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = resolve;
    });
    db.close();
}
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
// Active staging resources
// Active staging resources.
// Keep these at module scope so the runtime message handler can immediately
// abort the real video/audio downloads or terminate FFmpeg when the user
// cancels the job.
let currentJobId = null;
let cancelled = false;
let videoController = null;
let audioController = null;
let activeWorker = null;
// Offscreen runtime message handling
chrome.runtime.onMessage.addListener(message => {
    if (message?.target === 'video-offscreen' && message.type === 'videoStageStart') {
        runStagingJob(message.jobId).catch(error => finishError(message.jobId, error));
    }
    if (message?.target === 'video-offscreen' && message.type === 'videoStageCancelInternal') {
        cancelled = true;
        try {
            videoController?.abort();
        }catch (_) {
        }
        try {
            audioController?.abort();
        }catch (_) {
        }
        try {
            activeWorker?.terminate();
        }catch (_) {
        }
        videoController = null;
        audioController = null;
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
// Download the actual source streams used to build the final video.
//
// This is separate from the short-lived stream warm-up in background.js. The
// warm-up is only a speed optimization; these fetches are the real downloads
// whose data is retained and later merged into the final file.
async function downloadSourceStreams(job) {
    postStageMessage("videoStageStatus", {
        jobId: currentJobId,
        stage: "download",
        message: "Downloading full video and audio streams…"
    });
    videoController = new AbortController();
    audioController = new AbortController();
    try {
        return await Promise.all([
            fetchToBlob(
                job.videoUrl,
                "video",
                currentJobId,
                videoController.signal,
                job.videoBytes || 0
            ),
            fetchToBlob(
                job.audioUrl,
                "audio",
                currentJobId,
                audioController.signal,
                job.audioBytes || 0
            )
        ]);
    } finally {
        videoController = null;
        audioController = null;
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
        // Convert once here and transfer the buffers to FFmpeg instead of
        // structured-cloning large Blob objects into the worker.
        const [videoBuffer, audioBuffer] = await Promise.all([
            videoBlob.arrayBuffer(),
            audioBlob.arrayBuffer()
        ]);

        return await new Promise((resolve, reject) => {
            worker.onmessage = event => {
                const data = event.data || {};
                if (data.type === "source-progress") {
                    postStageMessage("videoStageProgress", {
                        jobId: currentJobId,
                        label: data.label,
                        received: data.received,
                        total: data.total
                    });
                    return;
                }
                if (data.type === "status") {
                    postStageMessage("videoStageStatus", {
                        jobId: currentJobId,
                        stage: "merge",
                        message: data.message
                    });
                    return;
                }
                if (data.type === "ffmpeg-log") {
                    postStageMessage("videoStageLog", {
                        jobId: currentJobId,
                        message: data.message
                    });
                    return;
                }
                if (data.type === "ffmpeg-progress") {
                    postStageMessage("videoStageMergeProgress", {
                        jobId: currentJobId,
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
                    resolve(new Blob([data.buffer], { type: "video/mp4" }));
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
                video: videoBuffer,
                audio: audioBuffer,
                audioCodec: getAudioCodec(job.audioUrl)
            }, [videoBuffer, audioBuffer]);
        });
    } finally {
        try {
            worker.terminate();
        } catch (_) {
        }
        activeWorker = null;
    }
}
async function finishStagedDownload(job, output) {
    if (!(output instanceof Blob)) {
        throw new Error("Merged MP4 was not produced.");
    }
    await triggerDownload(output, job.filename, job.jobId);
    postStageMessage("videoStageFinished", {
        jobId: job.jobId
    });
}
async function runStagingJob(jobId) {
    currentJobId = jobId;
    cancelled = false;
    const job = await getJob(jobId);
    const [videoBlob, audioBlob] = await downloadSourceStreams(job);
    throwIfCancelled();
    postStageMessage("videoStageStatus", {
        jobId,
        stage: "staged"
    });
    throwIfCancelled();
    const mergedBlob = await mergeStreams(job, videoBlob, audioBlob);
    throwIfCancelled();
    postStageMessage("videoStageStatus", {
        jobId,
        stage: "processing"
    });
    await finishStagedDownload({
        ...job,
        jobId
    }, mergedBlob);
}
