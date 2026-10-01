(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const storage = self.GDriveVideoStageStorage;
    const jobControllers = new Map();
    const cancelledJobs = new Set();
    const activeRuns = new Map();

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
        } catch (_) { return url; }
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

    async function fetchToTempFile(url, label, jobId, signal, expectedTotal = 0) {
        const baseUrl = cleanStageURL(url);
        let writer = await storage.openWriter(jobId, label);
        let writerClosed = false;
        let received = 0;
        let total = Math.max(0, Number(expectedTotal) || 0);
        let lastReport = 0;
        let responseBytes = 0;

        const report = (force = false) => {
            const now = performance.now();
            if (!force && now - lastReport < 250) return;
            lastReport = now;
            postStageMessage('videoStageProgress', {
                jobId,
                label,
                received,
                total: total || received
            });
        };

        async function resetWriter() {
            if (!writerClosed) {
                try { await writer.close(); } catch (_) {}
            }
            writer = await storage.openWriter(jobId, label);
            writerClosed = false;
            received = 0;
            responseBytes = 0;
            lastReport = 0;
        }

        async function readResponse(response, rangeStart = 0) {
            const contentRange = response.headers.get('content-range') || '';
            const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
            const responseTotal = rangeMatch && rangeMatch[3] !== '*'
                ? Number(rangeMatch[3])
                : 0;
            if (responseTotal > 0) total = Math.max(total, responseTotal);

            const contentLength = Number(response.headers.get('content-length') || 0);
            if (!rangeMatch && contentLength > 0 && total <= 0) total = contentLength;

            const responseStart = rangeMatch ? Number(rangeMatch[1]) : rangeStart;
            const responseEnd = rangeMatch ? Number(rangeMatch[2]) : 0;
            responseBytes = 0;

            if (!response.body) {
                const blob = await response.blob();
                if (blob.size) {
                    await writer.write(blob);
                    responseBytes = blob.size;
                    received += blob.size;
                    report(true);
                }
            } else {
                const reader = response.body.getReader();
                try {
                    for (;;) {
                        throwIfCancelled(jobId);
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!value?.byteLength) continue;
                        await writer.write(value);
                        responseBytes += value.byteLength;
                        received += value.byteLength;
                        report(false);
                    }
                } finally {
                    try { reader.releaseLock(); } catch (_) {}
                }
            }

            return {
                bytes: responseBytes,
                start: responseStart,
                end: responseEnd,
                contentRange: !!rangeMatch,
                status: response.status
            };
        }

        try {
            throwIfCancelled(jobId);
            const firstResponse = await fetch(makeFullRangeURL(baseUrl), {
                credentials: 'include',
                cache: 'no-store',
                signal
            });
            if (!firstResponse.ok) throw new Error(`${label} request failed (${firstResponse.status})`);

            const first = await readResponse(firstResponse, 0);

            if (total > 0 && received < total) {
                let attempts = 0;
                while (received < total && attempts++ < 128) {
                    throwIfCancelled(jobId);
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

                    // If the server ignores the requested range and returns a
                    // full 200 response, discard the earlier short response and
                    // write this response as the complete file from byte zero.
                    if (response.status === 200 && !response.headers.get('content-range')) {
                        await resetWriter();
                        const full = await readResponse(response, 0);
                        if (full.bytes >= total) break;
                        throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
                    }

                    const part = await readResponse(response, rangeStart);
                    if (part.bytes <= 0) {
                        throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
                    }
                    if (part.contentRange && part.start !== rangeStart) {
                        throw new Error(`${label} returned an unexpected byte range.`);
                    }
                }
            }

            if (total > 0 && received < total) {
                throw new Error(`${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`);
            }

            await writer.close();
            writerClosed = true;
            const size = await storage.getSize(jobId, label);
            if (total > 0 && size < total) {
                throw new Error(`${label} stream ended early (${formatStageBytes(size)} / ${formatStageBytes(total)}).`);
            }

            await postStageMessage('videoStageProgress', {
                jobId,
                label,
                received: size,
                total: total || size
            });

            return { jobId, label, size, total: total || size };
        } catch (error) {
            if (!writerClosed) {
                try { await writer.abort(); } catch (_) {}
            }
            throw error;
        }
    }

    async function downloadSourceStreams(job) {
        await postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: job.mode === 'single' ? 'Downloading selected video stream…' : 'Downloading selected video and audio streams…'
        });

        const controller = new AbortController();
        jobControllers.set(job.jobId, controller);
        try {
            throwIfCancelled(job.jobId);
            if (job.mode === 'single') {
                const mediaFile = await fetchToTempFile(job.mediaUrl, 'video', job.jobId, controller.signal, job.mediaBytes || 0);
                return { mediaFile, videoFile: mediaFile, audioFile: null };
            }
            const [videoFile, audioFile] = await Promise.all([
                fetchToTempFile(job.videoUrl, 'video', job.jobId, controller.signal, job.videoBytes || 0),
                fetchToTempFile(job.audioUrl, 'audio', job.jobId, controller.signal, job.audioBytes || 0)
            ]);
            return { videoFile, audioFile, mediaFile: null };
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
        if (!jobId || activeRuns.has(jobId)) return;

        const promise = (async () => {
            cancelledJobs.delete(jobId);
            try {
                const job = { ...(await getJob(jobId)), jobId };
                const sources = await downloadSourceStreams(job);
                throwIfCancelled(jobId);

                if (job.mode === 'single') {
                    const expected = Number(job.mediaBytes) || 0;
                    if (expected > 0 && sources.mediaFile.size < expected) {
                        throw new Error(`Video stream is incomplete (${formatStageBytes(sources.mediaFile.size)} / ${formatStageBytes(expected)}).`);
                    }
                } else {
                    const expectedVideo = Number(job.videoBytes) || 0;
                    const expectedAudio = Number(job.audioBytes) || 0;
                    if (expectedVideo > 0 && sources.videoFile.size < expectedVideo) {
                        throw new Error(`Video stream is incomplete (${formatStageBytes(sources.videoFile.size)} / ${formatStageBytes(expectedVideo)}).`);
                    }
                    if (expectedAudio > 0 && sources.audioFile.size < expectedAudio) {
                        throw new Error(`Audio stream is incomplete (${formatStageBytes(sources.audioFile.size)} / ${formatStageBytes(expectedAudio)}).`);
                    }
                }

                if (job.mode === 'single') {
                    await window.GDriveVideoProcessor.processSingle(job, sources.mediaFile);
                } else {
                    await window.GDriveVideoProcessor.process(job, sources.videoFile, sources.audioFile);
                }
            } catch (error) {
                postStageMessage(isAbortError(error, jobId) ? 'videoStageCancelled' : 'videoStageError', {
                    jobId,
                    message: error?.message || String(error)
                });
                try { await storage.removeJob(jobId); } catch (_) {}
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

    self[NS] = {
        postStageMessage,
        throwIfCancelled,
        cancel
    };
})();
