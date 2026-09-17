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

    function cleanPlaybackURL(url) {
        if (!url) return url;
        const value = String(url);
        const hashIndex = value.indexOf('#');
        const hash = hashIndex === -1 ? '' : value.slice(hashIndex);
        const main = hashIndex === -1 ? value : value.slice(0, hashIndex);
        const queryIndex = main.indexOf('?');
        if (queryIndex === -1) return value;
        const base = main.slice(0, queryIndex);
        const query = main.slice(queryIndex + 1);
        const parts = query.split('&').filter(part => !/^range=/i.test(part));
        return base + (parts.length ? `?${parts.join('&')}` : '') + hash;
    }

    function getDownloadRange(url) {
        try {
            const clen = Number(new URL(url).searchParams.get('clen'));
            return Number.isSafeInteger(clen) && clen > 0 ? `bytes=0-${clen - 1}` : '';
        } catch (_) {
            return '';
        }
    }

    async function requestStream(url, label, signal) {
        const clean = cleanPlaybackURL(url);
        const common = {
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            referrer: 'https://drive.google.com/',
            referrerPolicy: 'strict-origin-when-cross-origin',
            signal
        };

        let response = await fetch(clean, common);
        if (response.ok) return response;

        const range = getDownloadRange(clean);
        if (range) {
            try { await response.body?.cancel(); } catch (_) {}
            response = await fetch(clean, { ...common, headers: { Range: range } });
            if (response.ok) return response;
        }

        throw new Error(`${label} request failed (${response.status})`);
    }

    async function fetchToBlob(url, label, jobId, signal, expectedTotal = 0) {
        const response = await requestStream(url, label, signal);

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

    async function fetchCandidates(urls, label, jobId, signal, expectedTotal = 0) {
        const candidates = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))];
        let lastError = null;
        for (const url of candidates) {
            throwIfCancelled();
            try {
                return await fetchToBlob(url, label, jobId, signal, expectedTotal);
            } catch (error) {
                lastError = error;
                if (!/(^|\()403\)?|401|404|410|429/.test(String(error?.message || error))) throw error;
            }
        }
        throw lastError || new Error(`${label} request failed.`);
    }

    async function downloadSourceStreams(job) {
        postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: 'Downloading video and audio streams'
        });

        sourceController = new AbortController();
        try {
            return await Promise.all([
                fetchCandidates(job.videoUrls || [job.videoUrl], 'video', job.jobId, sourceController.signal, job.videoBytes || 0),
                fetchCandidates(job.audioUrls || [job.audioUrl], 'audio', job.jobId, sourceController.signal, job.audioBytes || 0)
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
