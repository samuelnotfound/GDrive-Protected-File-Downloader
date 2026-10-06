
(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const jobControllers = new Map();
    const cancelledJobs = new Set();

    function postStageMessage(type, payload = {}) {
        try {
            return chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {});
        } catch (_) {
            return Promise.resolve();
        }
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
        const baseUrl = cleanStageURL(url);
        const parts = [];
        let received = 0;
        let total = Math.max(0, Number(expectedTotal) || 0);
        let lastReport = 0;

        async function readResponse(response, rangeStart = 0) {
            const contentRange = response.headers.get('content-range') || '';
            const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
            const responseTotal = rangeMatch && rangeMatch[3] !== '*'
                ? Number(rangeMatch[3])
                : 0;
            if (responseTotal > 0) total = Math.max(total, responseTotal);

            const responseStart = rangeMatch ? Number(rangeMatch[1]) : rangeStart;
            const responseEnd = rangeMatch ? Number(rangeMatch[2]) : 0;
            const chunks = [];
            let responseBytes = 0;

            if (!response.body) {
                const blob = await response.blob();
                chunks.push(blob);
                responseBytes = blob.size;
            } else {
                const reader = response.body.getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!value?.byteLength) continue;
                        chunks.push(value);
                        responseBytes += value.byteLength;

                        const now = performance.now();
                        if (now - lastReport >= 250 || (total && received + responseBytes >= total)) {
                            lastReport = now;
                            postStageMessage('videoStageProgress', {
                                jobId,
                                label,
                                received: received + responseBytes,
                                total: total || (received + responseBytes)
                            });
                        }
                    }
                } finally {
                    try { reader.releaseLock(); } catch (_) {}
                }
            }

            return {
                blob: new Blob(chunks, { type: response.headers.get('content-type') || '' }),
                bytes: responseBytes,
                start: responseStart,
                end: responseEnd,
                contentRange: !!rangeMatch,
                status: response.status
            };
        }

        // First request keeps the existing Drive behavior. Some Drive responses
        // can be only a tiny partial response even though the URL's clen says
        // the stream is much larger. Never treat that short response as complete.
        const firstResponse = await fetch(makeFullRangeURL(baseUrl), {
            credentials: 'include',
            cache: 'no-store',
            signal
        });
        if (!firstResponse.ok) throw new Error(`${label} request failed (${firstResponse.status})`);

        const first = await readResponse(firstResponse, 0);
        if (first.bytes > 0) {
            parts.push(first.blob);
            received += first.bytes;
        }

        // If the first response was a genuine full response, we're done. If it
        // was partial, continue from the exact next byte using both an HTTP Range
        // header and a matching ?range= query parameter.
        if (total > 0 && received < total) {
            let attempts = 0;
            while (received < total && attempts++ < 128) {
                const rangeStart = received;
                const rangeEnd = total - 1;
                const rangeUrl = makeRangeURL(baseUrl, rangeStart, rangeEnd);
                const response = await fetch(rangeUrl, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal,
                    headers: {
                        Range: `bytes=${rangeStart}-${rangeEnd}`
                    }
                });
                if (!response.ok) throw new Error(`${label} range request failed (${response.status})`);

                const part = await readResponse(response, rangeStart);
                if (part.bytes <= 0) {
                    throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
                }

                // A server that ignores a non-zero Range request may return the
                // entire file with 200. Use that full response as the file rather
                // than appending it to the small first response.
                if (response.status === 200 && !part.contentRange) {
                    if (part.bytes >= total) {
                        parts.length = 0;
                        parts.push(part.blob);
                        received = part.bytes;
                        break;
                    }
                    throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
                }

                if (part.contentRange && part.start !== rangeStart) {
                    throw new Error(`${label} returned an unexpected byte range.`);
                }

                parts.push(part.blob);
                received += part.bytes;
            }
        }

        if (total > 0 && received < total) {
            throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
        }

        const blob = new Blob(parts, { type: firstResponse.headers.get('content-type') || '' });
        if (total > 0 && blob.size < total) {
            throw new Error(`${label} stream ended early (${formatStageBytes(blob.size)} / ${formatStageBytes(total)}).`);
        }

        // This final message is awaited so processing cannot start before the
        // overlay has seen the true end of this stream.
        await postStageMessage('videoStageProgress', {
            jobId,
            label,
            received: blob.size,
            total: total || blob.size
        });
        return blob;
    }

    function makeRangeURL(url, start, end) {
        if (!url) return url;
        try {
            const parsed = new URL(url);
            parsed.searchParams.set('range', `${start}-${end}`);
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }

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

    function formatStageBytes(bytes) {
        const n = Math.max(0, Number(bytes) || 0);
        if (n < 1024) return `${Math.round(n)} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

    const activeRuns = new Map();

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
                        throw new Error(`Video stream is incomplete (${formatStageBytes(sources.mediaBlob.size)} / ${formatStageBytes(expected)}).`);
                    }
                } else {
                    const expectedVideo = Number(job.videoBytes) || 0;
                    const expectedAudio = Number(job.audioBytes) || 0;
                    if (expectedVideo > 0 && sources.videoBlob.size < expectedVideo) {
                        throw new Error(`Video stream is incomplete (${formatStageBytes(sources.videoBlob.size)} / ${formatStageBytes(expectedVideo)}).`);
                    }
                    if (expectedAudio > 0 && sources.audioBlob.size < expectedAudio) {
                        throw new Error(`Audio stream is incomplete (${formatStageBytes(sources.audioBlob.size)} / ${formatStageBytes(expectedAudio)}).`);
                    }
                }

                // For adaptive downloads, downloadSourceStreams resolves only
                // after BOTH video and audio blobs are complete and their final
                // progress messages have reached the tab. Processing cannot
                // begin from a single stream finishing early.
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

    window[NS] = {
        postStageMessage,
        throwIfCancelled,
        cancel
    };
})();
