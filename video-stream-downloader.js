/**
 * Video Stream Downloader
 * Runs in the offscreen document and downloads the captured video/audio streams into Blobs.
 * It reports progress, supports cancellation, and passes the completed source Blobs to the processor.
 */

(() => {
    const NS = 'GDriveVideoStreamDownloader';
    let cancelled = false;
    let sourceController = null;

    function postStageMessage(type, payload = {}) {
        try {
            chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {});
        } catch (_) {}
    }

    function isAbortError(error) {
        return cancelled || error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
    }

    async function getJob(jobId) {
        return await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'getVideoStageJob', jobId }, response => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (!response?.job) {
                    reject(new Error(response?.error || 'Staging job was not found.'));
                } else {
                    resolve(response.job);
                }
            });
        });
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
            postStageMessage('videoStageProgress', {
                jobId,
                label,
                received: blob.size,
                total: total || blob.size
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
            jobId,
            label,
            received,
            total: total || blob.size
        });
        return blob;
    }

    function throwIfCancelled() {
        if (!cancelled) return;
        throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' });
    }

    async function downloadSourceStreams(job) {
        postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: 'Downloading full video and audio streams…'
        });

        sourceController = new AbortController();
        try {
            return await Promise.all([
                fetchToBlob(job.videoUrl, 'video', job.jobId, sourceController.signal, job.videoBytes || 0),
                fetchToBlob(job.audioUrl, 'audio', job.jobId, sourceController.signal, job.audioBytes || 0)
            ]);
        } finally {
            sourceController = null;
        }
    }

    function cancel() {
        cancelled = true;
        try { sourceController?.abort(); } catch (_) {}
        try { window.GDriveVideoProcessor?.cancel(); } catch (_) {}
        sourceController = null;
    }

    async function run(jobId) {
        cancelled = false;
        try {
            const job = { ...(await getJob(jobId)), jobId };
            const [videoBlob, audioBlob] = await downloadSourceStreams(job);
            throwIfCancelled();
            await window.GDriveVideoProcessor.process(job, videoBlob, audioBlob);
        } catch (error) {
            postStageMessage(isAbortError(error) ? 'videoStageCancelled' : 'videoStageError', {
                jobId,
                message: error?.message || String(error)
            });
        }
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message?.target !== 'video-offscreen') return;
        if (message.type === 'videoStageStart') run(message.jobId);
        if (message.type === 'videoStageCancelInternal') cancel();
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
