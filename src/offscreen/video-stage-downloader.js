
(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const jobControllers = new Map();
    const cancelledJobs = new Set();
    const activeRuns = new Map();
    /** Per-job download-phase state: live attempts + streams waiting for a manual restart. */
    const jobRuntime = new Map();

    const CHUNK_SIZE = 4 * 1024 * 1024;
    /** No bytes received for this long → treat the stream as stuck and resume it. */
    const STUCK_MS = 5000;
    /** Automatic resumes per stream before we stop and wait for the user's Restart click. */
    const MAX_STUCK_RESTARTS = 2;
    /** Retries for one failed range request (each retry tries Range header, then ?range=). */
    const CHUNK_RETRIES = 3;
    const RETRY_BASE_MS = 300;

    function postStageMessage(type, payload = {}) {
        try {
            return chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {});
        } catch (_) {
            return Promise.resolve();
        }
    }

    function abortError(message = 'Download cancelled.') {
        return Object.assign(new Error(message), { name: 'AbortError' });
    }

    function isAbortError(error, jobId = '') {
        return cancelledJobs.has(jobId)
            || error?.name === 'AbortError'
            || /aborted|abort/i.test(String(error?.message || error || ''));
    }

    function throwIfCancelled(jobId) {
        if (cancelledJobs.has(jobId)) throw abortError();
    }

    function sleepAbortable(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            const onAbort = () => { clearTimeout(timer); reject(abortError()); };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
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

    /** "bytes 0-4194303/24589214" → { start, end, total } (total 0 when "*"). */
    function parseContentRange(value) {
        const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(value || ''));
        if (!m) return null;
        return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
    }

    /**
     * Read a response body while reporting every network read, so progress
     * (and stuck detection) is byte-accurate instead of per-4-MiB-chunk.
     */
    async function readBody(response, onBytes) {
        if (!response.body?.getReader) {
            const whole = new Uint8Array(await response.arrayBuffer());
            onBytes(whole.byteLength);
            return whole;
        }
        const reader = response.body.getReader();
        const parts = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value?.byteLength) {
                    parts.push(value);
                    size += value.byteLength;
                    onBytes(value.byteLength);
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (_) {}
        }
        if (parts.length === 1) return parts[0];
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
        return out;
    }

    /**
     * Ask the server for the real stream size (headers only; body is cancelled).
     * Drive's clen is sometimes wrong, and a wrong size is exactly what lets a
     * truncated stream look "complete". Returns 0 when the server won't say.
     */
    async function probeTotal(baseUrl, ctx) {
        try {
            const response = await fetch(baseUrl, {
                credentials: 'include',
                cache: 'no-store',
                signal: ctx.signal,
                headers: { Range: 'bytes=0-0' }
            });
            try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
            ctx.markProgress();
            if (response.status === 206) {
                return parseContentRange(response.headers.get('content-range'))?.total || 0;
            }
            if (response.status === 200) {
                return Number(response.headers.get('content-length')) || 0;
            }
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
        }
        return 0;
    }

    /**
     * Fetch one inclusive range. Tries the HTTP Range header first, then
     * ?range=start-end. Returns { data, total, whole } where `total` is the
     * server-confirmed stream size (0 if unknown). Never returns an empty body.
     */
    async function fetchRange(baseUrl, start, end, ctx, label) {
        const attempts = [
            { mode: 'header', url: baseUrl, headers: { Range: `bytes=${start}-${end}` } },
            { mode: 'query', url: makeRangeQueryURL(baseUrl, start, end), headers: {} }
        ];

        let lastError = null;
        for (const attempt of attempts) {
            try {
                throwIfCancelled(ctx.jobId);
                let inflight = 0;
                const onBytes = n => { inflight += n; ctx.markProgress(); ctx.report(inflight); };

                const response = await fetch(attempt.url, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: ctx.signal,
                    headers: attempt.headers
                });
                ctx.markProgress();

                if (!response.ok && response.status !== 206) {
                    lastError = new Error(`${label} download failed (${response.status})`);
                    continue;
                }

                const range = parseContentRange(response.headers.get('content-range'));
                const body = await readBody(response, onBytes);
                if (!body.byteLength) {
                    lastError = new Error(`${label} download returned no data`);
                    continue;
                }

                if (range && range.start !== start) {
                    lastError = new Error(`${label} server returned the wrong byte range`);
                    continue;
                }

                // Server ignored the Range header and sent the whole file.
                if (attempt.mode === 'header' && response.status === 200) {
                    if (start === 0) return { data: body, total: body.byteLength, whole: true };
                    if (body.byteLength > end) {
                        return { data: body.subarray(start, end + 1), total: body.byteLength, whole: false };
                    }
                    lastError = new Error(`${label} server ignored the range request`);
                    continue;
                }

                return { data: body, total: range?.total || 0, whole: false };
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                lastError = err;
            }
        }
        throw lastError || new Error(`${label} download failed`);
    }

    async function fetchRangeWithRetry(baseUrl, start, end, ctx, label) {
        let lastError = null;
        for (let i = 0; i < CHUNK_RETRIES; i++) {
            try {
                return await fetchRange(baseUrl, start, end, ctx, label);
            } catch (err) {
                if (err?.name === 'AbortError' || cancelledJobs.has(ctx.jobId)) throw err;
                lastError = err;
                await sleepAbortable(RETRY_BASE_MS * (i + 1), ctx.signal);
            }
        }
        throw lastError || new Error(`${label} download failed`);
    }

    /** Server gave us no size at all: fetch the stream in one request. */
    async function pullWhole(st, baseUrl, label, ctx) {
        let inflight = 0;
        const response = await fetch(baseUrl, {
            credentials: 'include',
            cache: 'no-store',
            signal: ctx.signal
        });
        ctx.markProgress();
        if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
        const declared = Number(response.headers.get('content-length')) || 0;
        const body = await readBody(response, n => { inflight += n; ctx.markProgress(); ctx.report(inflight); });
        if (!body.byteLength) throw new Error(`${label} download failed`);
        if (declared && body.byteLength < declared) {
            throw new Error(`${label} download incomplete (${body.byteLength} of ${declared} bytes)`);
        }
        st.chunks = [body];
        st.bytes = body.byteLength;
        st.total = body.byteLength;
    }

    /**
     * Pull bytes [st.bytes, st.total). Resumes from wherever the previous
     * attempt stopped. Only returns once EVERY byte has been received;
     * anything short throws instead of returning a partial stream.
     */
    async function pullStream(st, baseUrl, label, ctx) {
        if (st.bytes === 0 && !st.probed) {
            const probed = await probeTotal(baseUrl, ctx);
            st.probed = true;
            if (probed > 0) st.total = probed;
        }

        if (st.total <= 0) {
            await pullWhole(st, baseUrl, label, ctx);
            return;
        }

        while (st.bytes < st.total) {
            throwIfCancelled(ctx.jobId);
            if (ctx.signal.aborted) throw abortError();

            const start = st.bytes;
            const end = Math.min(start + CHUNK_SIZE - 1, st.total - 1);
            const res = await fetchRangeWithRetry(baseUrl, start, end, ctx, label);

            // The server's own size beats the URL's clen (Drive often misreports it).
            if (res.total > 0 && res.total !== st.total) st.total = res.total;

            if (res.whole) {
                st.chunks = [res.data];
                st.bytes = res.data.byteLength;
                st.total = res.total;
            } else {
                // A short slice is fine: we simply continue from the new offset.
                st.chunks.push(res.data);
                st.bytes += res.data.byteLength;
            }
            ctx.report(0, true);
        }

        if (st.bytes < st.total) {
            throw new Error(`${label} download incomplete (${st.bytes} of ${st.total} bytes)`);
        }
        if (st.bytes > st.total) st.total = st.bytes;
    }

    function makeReporter(jobId, label, st) {
        let last = 0;
        return (inflight = 0, force = false) => {
            const now = performance.now();
            if (!force && now - last < 200) return;
            last = now;
            const total = st.total;
            const received = total > 0 ? Math.min(st.bytes + inflight, total) : st.bytes + inflight;
            postStageMessage('videoStageProgress', { jobId, label, received, total: total || received });
        };
    }

    /** One download attempt: own abort controller + stuck watchdog. */
    function beginAttempt(parentSignal, rt) {
        const controller = new AbortController();
        const attempt = {
            controller,
            signal: controller.signal,
            stuck: false,
            manual: false,
            lastProgressAt: Date.now()
        };
        const onParentAbort = () => { try { controller.abort(); } catch (_) {} };
        if (parentSignal) {
            if (parentSignal.aborted) controller.abort();
            else parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
        const watchdog = setInterval(() => {
            if (controller.signal.aborted) return;
            if (Date.now() - attempt.lastProgressAt >= STUCK_MS) {
                attempt.stuck = true;
                try { controller.abort(); } catch (_) {}
            }
        }, 1000);
        attempt.markProgress = () => { attempt.lastProgressAt = Date.now(); };
        rt?.attempts.add(attempt);
        attempt.dispose = () => {
            clearInterval(watchdog);
            parentSignal?.removeEventListener('abort', onParentAbort);
            rt?.attempts.delete(attempt);
        };
        return attempt;
    }

    /** Park a stalled stream until the user presses Restart (or the job ends). */
    function waitForManualRestart(rt, signal) {
        return new Promise((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(abortError()); };
            const waiter = { resolve: () => { cleanup(); resolve(); } };
            const cleanup = () => {
                rt.waiters.delete(waiter);
                signal?.removeEventListener('abort', onAbort);
            };
            if (signal?.aborted) return reject(abortError());
            rt.waiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Download one stream completely. A stall (automatic or user-requested)
     * resumes from the last received byte instead of starting over.
     * Resolves only with a stream whose size matches the expected total.
     */
    async function downloadStream(url, totalHint, label, job, parentSignal, rt) {
        const jobId = job.jobId;
        const baseUrl = cleanStageURL(url);
        const st = { chunks: [], bytes: 0, total: Math.max(0, Number(totalHint) || 0), probed: false };
        const report = makeReporter(jobId, label, st);
        let autoRestarts = 0;

        for (;;) {
            throwIfCancelled(jobId);
            const attempt = beginAttempt(parentSignal, rt);
            try {
                await pullStream(st, baseUrl, label, {
                    jobId,
                    signal: attempt.signal,
                    report,
                    markProgress: attempt.markProgress
                });

                const blob = new Blob(st.chunks, { type: 'video/mp4' });
                if (blob.size !== st.bytes || st.bytes !== st.total || blob.size <= 0) {
                    throw new Error(`${label} download incomplete (${blob.size} of ${st.total} bytes)`);
                }
                report(0, true);
                return { blob, bytes: st.bytes, total: st.total };
            } catch (err) {
                if (cancelledJobs.has(jobId)) throw abortError();

                if (attempt.manual) {
                    postStageMessage('videoStageStatus', {
                        jobId, stage: 'download', message: `Restarting ${label} download…`
                    });
                    continue;
                }
                if (attempt.stuck) {
                    if (autoRestarts < MAX_STUCK_RESTARTS) {
                        autoRestarts++;
                        postStageMessage('videoStageStatus', {
                            jobId, stage: 'download', message: `Restarting ${label} download…`
                        });
                        continue;
                    }
                    postStageMessage('videoStageStatus', {
                        jobId, stage: 'download', message: `${label} download stalled. Waiting for restart…`
                    });
                    await waitForManualRestart(rt, parentSignal);
                    autoRestarts = 0;
                    continue;
                }
                throw err;
            } finally {
                attempt.dispose();
            }
        }
    }

    /** User pressed Restart: abort live attempts / wake stalled streams. They resume, not restart. */
    function requestRestart(jobId) {
        const rt = jobRuntime.get(jobId);
        if (!rt) return false;
        for (const attempt of [...rt.attempts]) {
            attempt.manual = true;
            try { attempt.controller.abort(); } catch (_) {}
        }
        for (const waiter of [...rt.waiters]) waiter.resolve();
        return true;
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
        const rt = { attempts: new Set(), waiters: new Set() };
        jobRuntime.set(job.jobId, rt);

        try {
            throwIfCancelled(job.jobId);

            if (job.mode === 'single') {
                const media = await downloadStream(
                    job.mediaUrl, job.mediaBytes || 0, 'video', job, controller.signal, rt
                );
                return { mediaBlob: media.blob, videoBlob: media.blob, audioBlob: null, mediaBlobInfo: media };
            }

            // Both streams must finish (or one must fail) before anything else happens.
            const [video, audio] = await Promise.all([
                downloadStream(job.videoUrl, job.videoBytes || 0, 'video', job, controller.signal, rt),
                downloadStream(job.audioUrl, job.audioBytes || 0, 'audio', job, controller.signal, rt)
            ]);
            return { videoBlob: video.blob, audioBlob: audio.blob, mediaBlob: null, video, audio };
        } catch (error) {
            // One stream failed: stop the other instead of letting it keep downloading.
            try { controller.abort(); } catch (_) {}
            throw error;
        } finally {
            jobRuntime.delete(job.jobId);
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

                // Final gate: never hand a partial stream to the merger.
                const parts = job.mode === 'single'
                    ? [sources.mediaBlobInfo]
                    : [sources.video, sources.audio];
                for (const part of parts) {
                    if (!part || part.bytes <= 0 || part.bytes !== part.total || part.blob.size !== part.bytes) {
                        throw new Error('A stream did not finish downloading. Please try again.');
                    }
                }

                if (job.mode === 'single') {
                    await window.GDriveVideoProcessor.processSingle(job, sources.mediaBlob);
                } else {
                    // Both streams verified complete → only now start merging.
                    postStageMessage('videoStageStatus', { jobId, stage: 'staged' });
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

    /**
     * Restart request from the overlay.
     *  - Live download: abort the stalled requests; each stream resumes from its last byte.
     *  - No live run (offscreen document was recreated): start the job again from scratch.
     */
    function restart(jobId) {
        if (!jobId) return;
        if (activeRuns.has(jobId)) {
            if (requestRestart(jobId)) postStageMessage('videoStageRestarted', { jobId, reset: false });
            return;
        }
        postStageMessage('videoStageRestarted', { jobId, reset: true });
        run(jobId);
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message?.target !== 'video-offscreen') return;
        if (message.type === 'videoStageStart') run(message.jobId);
        if (message.type === 'videoStageCancelInternal') cancel(message.jobId);
        if (message.type === 'videoStageRestartInternal') restart(message.jobId);
    });

    window[NS] = { postStageMessage, throwIfCancelled, cancel };
})();
