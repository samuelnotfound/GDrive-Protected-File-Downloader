
(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const jobControllers = new Map();
    const cancelledJobs = new Set();
    const activeRuns = new Map();

    const CHUNK_SIZE = 4 * 1024 * 1024;
    /** Reject bodies smaller than this when a large range was requested. */
    const MIN_USEFUL_CHUNK = 8 * 1024;

    function postStageMessage(type, payload = {}) {
        try {
            return chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {});
        } catch (_) {
            return Promise.resolve();
        }
    }

    function isAbortError(error, jobId = '') {
        return cancelledJobs.has(jobId)
            || error?.name === 'AbortError'
            || /aborted|abort/i.test(String(error?.message || error || ''));
    }

    function formatStageBytes(bytes) {
        const n = Math.max(0, Number(bytes) || 0);
        if (n < 1024) return `${Math.round(n)} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    function throwIfCancelled(jobId) {
        if (cancelledJobs.has(jobId)) {
            throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' });
        }
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

    /** Remove existing range param so we control ranges ourselves. */
    function cleanStageURL(url) {
        if (!url) return url;
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('range');
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }

    function makeRangeQueryURL(url, start, end) {
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('range');
            parsed.searchParams.set('range', `${start}-${end}`);
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }

    /**
     * True if the response body is a usable media chunk for [start, end].
     * Rejects tiny init/error bodies when a multi-MB range was requested.
     */
    function isUsableChunk(response, data, start, end) {
        if (!response || !data) return false;
        const size = data.byteLength || 0;
        if (size <= 0) return false;

        const requested = end - start + 1;
        const status = response.status;
        if (status !== 206 && status !== 200) return false;

        // Tiny body for a large request → not media
        if (size < MIN_USEFUL_CHUNK && requested > MIN_USEFUL_CHUNK) return false;

        const contentRange = response.headers.get('content-range') || '';
        if (contentRange) {
            const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
            if (match && Number(match[1]) !== start) return false;
        }

        return true;
    }

    /**
     * Fetch one inclusive range.
     * Try HTTP Range header first; on failure/invalid body, try ?range=start-end.
     */
    async function fetchOneRange(baseUrl, start, end, signal, label) {
        const attempts = [
            {
                url: baseUrl,
                headers: { Range: `bytes=${start}-${end}` },
                name: 'Range header'
            },
            {
                url: makeRangeQueryURL(baseUrl, start, end),
                headers: {},
                name: 'range query'
            }
        ];

        let lastError = null;
        for (const attempt of attempts) {
            try {
                const response = await fetch(attempt.url, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal,
                    headers: attempt.headers
                });

                if (!response.ok && response.status !== 206) {
                    lastError = new Error(`${label} ${attempt.name} failed (${response.status})`);
                    continue;
                }

                const data = await response.arrayBuffer();
                if (!isUsableChunk(response, data, start, end)) {
                    lastError = new Error(
                        `${label} returned ${formatStageBytes(data.byteLength)} for bytes=${start}-${end} (${attempt.name})`
                    );
                    continue;
                }

                return data;
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                lastError = err;
            }
        }

        throw lastError || new Error(`${label} range request failed for bytes=${start}-${end}`);
    }

    /**
     * Download a full stream as sequential 4 MiB inclusive ranges.
     * Accumulates Uint8Array chunks; builds one Blob at the end.
     */
    async function downloadVideoInChunks(mediaUrl, totalSize, label, jobId, signal) {
        const baseUrl = cleanStageURL(mediaUrl);
        const expectedTotal = Math.max(0, Number(totalSize) || 0);
        const chunks = [];
        let downloadedBytes = 0;
        let lastReport = 0;

        // No known size: single full-body request (rare for Drive streams).
        if (expectedTotal <= 0) {
            const response = await fetch(baseUrl, {
                credentials: 'include',
                cache: 'no-store',
                signal
            });
            if (!response.ok) throw new Error(`${label} request failed (${response.status})`);
            const data = await response.arrayBuffer();
            if (data.byteLength < MIN_USEFUL_CHUNK) {
                throw new Error(`${label} returned an unexpectedly small response (${formatStageBytes(data.byteLength)}).`);
            }
            await postStageMessage('videoStageProgress', {
                jobId, label, received: data.byteLength, total: data.byteLength
            });
            return new Blob([data], { type: response.headers.get('content-type') || 'video/mp4' });
        }

        while (downloadedBytes < expectedTotal) {
            throwIfCancelled(jobId);

            const start = downloadedBytes;
            const end = Math.min(start + CHUNK_SIZE - 1, expectedTotal - 1);
            const data = await fetchOneRange(baseUrl, start, end, signal, label);
            const bytes = data.byteLength;

            if (bytes <= 0) {
                throw new Error(
                    `${label} stream ended early (${formatStageBytes(downloadedBytes)} / ${formatStageBytes(expectedTotal)}).`
                );
            }

            chunks.push(new Uint8Array(data));
            downloadedBytes += bytes;

            const now = performance.now();
            if (now - lastReport >= 200 || downloadedBytes >= expectedTotal) {
                lastReport = now;
                postStageMessage('videoStageProgress', {
                    jobId, label, received: downloadedBytes, total: expectedTotal
                });
            }
        }

        if (downloadedBytes < expectedTotal) {
            throw new Error(
                `${label} stream ended early (${formatStageBytes(downloadedBytes)} / ${formatStageBytes(expectedTotal)}).`
            );
        }

        await postStageMessage('videoStageProgress', {
            jobId, label, received: downloadedBytes, total: expectedTotal
        });

        return new Blob(chunks, { type: 'video/mp4' });
    }

    async function downloadSourceStreams(job) {
        postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: job.mode === 'single'
                ? 'Downloading selected video stream…'
                : 'Downloading selected video and audio streams…'
        });

        const controller = new AbortController();
        jobControllers.set(job.jobId, controller);

        try {
            throwIfCancelled(job.jobId);

            if (job.mode === 'single') {
                const mediaBlob = await downloadVideoInChunks(
                    job.mediaUrl, job.mediaBytes || 0, 'video', job.jobId, controller.signal
                );
                return { mediaBlob, videoBlob: mediaBlob, audioBlob: null };
            }

            const [videoBlob, audioBlob] = await Promise.all([
                downloadVideoInChunks(job.videoUrl, job.videoBytes || 0, 'video', job.jobId, controller.signal),
                downloadVideoInChunks(job.audioUrl, job.audioBytes || 0, 'audio', job.jobId, controller.signal)
            ]);
            return { videoBlob, audioBlob, mediaBlob: null };
        } finally {
            jobControllers.delete(job.jobId);
        }
    }

    function cancel(jobId) {
        if (jobId) cancelledJobs.add(jobId);
        try { jobControllers.get(jobId)?.abort(); } catch (_) {}
        try { window.GDriveVideoProcessor?.cancel(jobId); } catch (_) {}
    }

    async function run(jobId) {
        if (!jobId || activeRuns.has(jobId)) return;

        const promise = (async () => {
            cancelledJobs.delete(jobId);
            try {
                const job = { ...(await getJob(jobId)), jobId };
                const sources = await downloadSourceStreams(job);
                throwIfCancelled(jobId);

                if (job.mode === 'single') {
                    const expected = Number(job.mediaBytes) || 0;
                    if (expected > 0 && sources.mediaBlob.size < expected) {
                        throw new Error(
                            `Video stream is incomplete (${formatStageBytes(sources.mediaBlob.size)} / ${formatStageBytes(expected)}).`
                        );
                    }
                    await window.GDriveVideoProcessor.processSingle(job, sources.mediaBlob);
                } else {
                    const expectedVideo = Number(job.videoBytes) || 0;
                    const expectedAudio = Number(job.audioBytes) || 0;
                    if (expectedVideo > 0 && sources.videoBlob.size < expectedVideo) {
                        throw new Error(
                            `Video stream is incomplete (${formatStageBytes(sources.videoBlob.size)} / ${formatStageBytes(expectedVideo)}).`
                        );
                    }
                    if (expectedAudio > 0 && sources.audioBlob.size < expectedAudio) {
                        throw new Error(
                            `Audio stream is incomplete (${formatStageBytes(sources.audioBlob.size)} / ${formatStageBytes(expectedAudio)}).`
                        );
                    }
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
        })();

        activeRuns.set(jobId, promise);
        try {
            await promise;
        } finally {
            if (activeRuns.get(jobId) === promise) activeRuns.delete(jobId);
        }
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message?.target !== 'video-offscreen') return;
        if (message.type === 'videoStageStart') run(message.jobId);
        if (message.type === 'videoStageCancelInternal') cancel(message.jobId);
    });

    window[NS] = { postStageMessage, throwIfCancelled, cancel };
})();
