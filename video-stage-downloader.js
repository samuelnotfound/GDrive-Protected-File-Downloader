/**
 * Video Stream Downloader
 * Runs in the offscreen document and downloads selected Drive video/audio
 * streams into Blobs. Jobs are isolated so one video's cancellation/state
 * cannot accidentally affect another video's stream.
 */

(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const jobControllers = new Map();
    const cancelledJobs = new Set();

    function postStageMessage(type, payload = {}) {
        try { chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {}); } catch (_) {}
    }

    function isAbortError(error, jobId = '') {
        return cancelledJobs.has(jobId) || error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
    }

    async function getJob(jobId) {
        return await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'getVideoStageJob', jobId }, response => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (!response?.job) reject(new Error(response?.error || 'Staging job was not found.'));
                else resolve(response.job);
            });
        });
    }

    function makeFullRangeURL(url) {
        if (!url) return url;
        try {
            const parsed = new URL(url);
            const clen = Number(parsed.searchParams.get('clen'));
            if (Number.isSafeInteger(clen) && clen > 0) parsed.searchParams.set('range', `0-${clen - 1}`);
            return parsed.toString();
        } catch (_) { return url; }
    }

    async function fetchToBlob(url, label, jobId, signal, expectedTotal = 0) {
        const response = await fetch(makeFullRangeURL(url), {
            credentials: 'include',
            cache: 'no-store',
            signal
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
            postStageMessage('videoStageProgress', { jobId, label, received: blob.size, total: total || blob.size });
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
        postStageMessage('videoStageProgress', { jobId, label, received, total: total || blob.size });
        return blob;
    }

    function throwIfCancelled(jobId) {
        if (cancelledJobs.has(jobId)) throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' });
    }

    async function downloadSourceStreams(job) {
        postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: job.mode === 'single' ? 'Downloading selected video stream…' : 'Downloading selected video and audio streams…'
        });

        const controller = new AbortController();
        jobControllers.set(job.jobId, controller);
        try {
            throwIfCancelled(job.jobId);
            if (job.mode === 'single') {
                const mediaBlob = await fetchToBlob(job.mediaUrl, 'video', job.jobId, controller.signal, job.mediaBytes || 0);
                return { mediaBlob, videoBlob: mediaBlob, audioBlob: null };
            }
            const [videoBlob, audioBlob] = await Promise.all([
                fetchToBlob(job.videoUrl, 'video', job.jobId, controller.signal, job.videoBytes || 0),
                fetchToBlob(job.audioUrl, 'audio', job.jobId, controller.signal, job.audioBytes || 0)
            ]);
            return { videoBlob, audioBlob, mediaBlob: null };
        } finally {
            jobControllers.delete(job.jobId);
        }
    }

    function cancel(jobId) {
        if (jobId) cancelledJobs.add(jobId);
        const controller = jobControllers.get(jobId);
        try { controller?.abort(); } catch (_) {}
        try { window.GDriveVideoProcessor?.cancel(jobId); } catch (_) {}
    }

    async function run(jobId) {
        cancelledJobs.delete(jobId);
        try {
            const job = { ...(await getJob(jobId)), jobId };
            const sources = await downloadSourceStreams(job);
            throwIfCancelled(jobId);
            if (job.mode === 'single') {
                await window.GDriveVideoProcessor.processSingle(job, sources.mediaBlob);
            } else {
                await window.GDriveVideoProcessor.process(job, sources.videoBlob, sources.audioBlob);
            }
        } catch (error) {
            postStageMessage(isAbortError(error, jobId) ? 'videoStageCancelled' : 'videoStageError', {
                jobId,
                message: error?.message || String(error)
            });
        } finally {
            cancelledJobs.delete(jobId);
        }
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message?.target !== 'video-offscreen') return;
        if (message.type === 'videoStageStart') run(message.jobId);
        if (message.type === 'videoStageCancelInternal') cancel(message.jobId);
    });

    window[NS] = {
        getJob,
        postStageMessage,
        throwIfCancelled,
        isAbortError,
        cancel,
        downloadSourceStreams
    };
})();
