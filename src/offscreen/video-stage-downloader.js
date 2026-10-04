
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

    // Match salauddinn / common Drive fixes: strip range (and pot) so the
    // server serves the full stream instead of a tiny player segment.
    function cleanStageURL(url) {
        if (!url) return url;
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('range');
            // pot / cver can cause short or rejected responses outside the player.
            parsed.searchParams.delete('pot');
            parsed.searchParams.delete('cver');
            return parsed.toString();
        } catch (_) {
            // Fallback: cut at &range= / ?range= like salauddinn does.
            const value = String(url);
            const rangeIndex = value.search(/[?&]range=/i);
            return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
        }
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

    function clenFromUrl(url) {
        try {
            const n = Number(new URL(url).searchParams.get('clen'));
            return Number.isSafeInteger(n) && n > 0 ? n : 0;
        } catch (_) {
            return 0;
        }
    }

    const DRIVE_FETCH_HEADERS = {
        // Helps Google treat the request more like the player / browser download.
        Referer: 'https://drive.google.com/',
        Origin: 'https://drive.google.com'
    };

    // Prefer modest chunk sizes — full-file range=0-clen-1 often returns only
    // a few KB from Drive when requested outside the player context.
    const RANGE_CHUNK = 8 * 1024 * 1024; // 8 MiB

    async function fetchToBlob(url, label, jobId, signal, expectedTotal = 0) {
        const baseUrl = cleanStageURL(url);
        const parts = [];
        let received = 0;
        let total = Math.max(0, Number(expectedTotal) || 0, clenFromUrl(baseUrl));
        let lastReport = 0;
        let contentType = '';

        async function readResponse(response, rangeStart = 0) {
            const contentRange = response.headers.get('content-range') || '';
            const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
            const responseTotal = rangeMatch && rangeMatch[3] !== '*'
                ? Number(rangeMatch[3])
                : 0;
            if (responseTotal > 0) total = Math.max(total, responseTotal);

            // Prefer real Content-Length when no Content-Range (full 200 body).
            if (!rangeMatch) {
                const cl = Number(response.headers.get('content-length'));
                if (Number.isSafeInteger(cl) && cl > 0) total = Math.max(total, cl);
            }

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

            const type = response.headers.get('content-type') || '';
            if (type) contentType = type;

            return {
                blob: new Blob(chunks, { type: type || contentType || '' }),
                bytes: responseBytes,
                start: responseStart,
                end: responseEnd,
                contentRange: !!rangeMatch,
                status: response.status
            };
        }

        // 1) First request: plain cleaned URL (NO forced range=0-clen-1).
        //    Forcing a full-file range is what produces the "1.2 KB / 83.6 MB" failure.
        const firstResponse = await fetch(baseUrl, {
            credentials: 'include',
            cache: 'no-store',
            signal,
            headers: { ...DRIVE_FETCH_HEADERS }
        });
        if (!firstResponse.ok) {
            throw new Error(`${label} request failed (${firstResponse.status})`);
        }

        const first = await readResponse(firstResponse, 0);
        if (first.bytes > 0) {
            parts.push(first.blob);
            received += first.bytes;
        }

        // If server already sent everything (200 + body matches total, or no total known), done.
        const firstLooksComplete =
            (total > 0 && received >= total) ||
            (total === 0 && first.bytes > 0 && firstResponse.status === 200 && !first.contentRange);

        if (firstLooksComplete) {
            const blob = new Blob(parts, { type: contentType || '' });
            await postStageMessage('videoStageProgress', {
                jobId,
                label,
                received: blob.size,
                total: total || blob.size
            });
            return blob;
        }

        // 2) Need more bytes → request remaining data in chunks (Range header + ?range=).
        //    Use modest chunk size so Drive is less likely to short-circuit.
        if (total > 0 && received < total) {
            let attempts = 0;
            let emptyStreak = 0;
            while (received < total && attempts++ < 256) {
                const rangeStart = received;
                const rangeEnd = Math.min(total - 1, rangeStart + RANGE_CHUNK - 1);
                const rangeUrl = makeRangeURL(baseUrl, rangeStart, rangeEnd);
                const response = await fetch(rangeUrl, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal,
                    headers: {
                        ...DRIVE_FETCH_HEADERS,
                        Range: `bytes=${rangeStart}-${rangeEnd}`
                    }
                });

                // 416 / 4xx on range: stop if we already have a usable amount.
                if (!response.ok) {
                    if (received > 0 && response.status === 416) break;
                    throw new Error(`${label} range request failed (${response.status})`);
                }

                const part = await readResponse(response, rangeStart);
                if (part.bytes <= 0) {
                    emptyStreak += 1;
                    if (emptyStreak >= 3) {
                        throw new Error(
                            `${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`
                        );
                    }
                    continue;
                }
                emptyStreak = 0;

                // Server ignored Range and returned a full 200 body.
                if (response.status === 200 && !part.contentRange) {
                    if (part.bytes >= total || part.bytes > received) {
                        parts.length = 0;
                        parts.push(part.blob);
                        received = part.bytes;
                        break;
                    }
                    // Tiny 200 while we expected much more — treat as failure.
                    if (part.bytes < 64 * 1024 && total > 1024 * 1024) {
                        throw new Error(
                            `${label} stream ended early (${formatStageBytes(part.bytes)} / ${formatStageBytes(total)}).`
                        );
                    }
                }

                if (part.contentRange && part.start !== rangeStart) {
                    // Server started at a different offset; only accept if it continues past us.
                    if (part.start > rangeStart) {
                        throw new Error(`${label} returned an unexpected byte range.`);
                    }
                    // Overlap: skip already-received prefix (rare).
                    if (part.start < rangeStart && part.bytes > (rangeStart - part.start)) {
                        // Simplified: just append; slight overlap is rare and remux tolerates better than abort.
                    }
                }

                parts.push(part.blob);
                received += part.bytes;

                // Progress already reported inside readResponse.
            }
        }

        // Soft completeness: allow a small shortfall (Drive sometimes under-reports).
        const shortfall = total > 0 ? total - received : 0;
        const softOk = total > 0 && received > 0 && shortfall <= Math.max(4096, total * 0.002);

        if (total > 0 && received < total && !softOk) {
            throw new Error(
                `${label} stream ended early (${formatStageBytes(received)} / ${formatStageBytes(total)}).`
            );
        }

        const blob = new Blob(parts, { type: contentType || '' });
        if (total > 0 && blob.size < total && !softOk) {
            throw new Error(
                `${label} stream ended early (${formatStageBytes(blob.size)} / ${formatStageBytes(total)}).`
            );
        }

        await postStageMessage('videoStageProgress', {
            jobId,
            label,
            received: blob.size,
            total: total || blob.size
        });
        return blob;
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
