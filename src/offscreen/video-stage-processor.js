(() => {
    const downloader = self.GDriveVideoStreamDownloader;
    const storage = self.GDriveVideoStageStorage;
    const workers = new Map();
    const rejects = new Map();
    let mergeQueueTail = Promise.resolve();

    async function withMergeSlot(task) {
        const previous = mergeQueueTail;
        let release;
        mergeQueueTail = new Promise(resolve => { release = resolve; });
        await previous.catch(() => {});
        try {
            return await task();
        } finally {
            release();
        }
    }

    function getAudioCodec(url) {
        try {
            const parsedURL = new URL(url);
            const codecs = parsedURL.searchParams.get('codecs') || '';
            const mime = parsedURL.searchParams.get('mime') || '';
            if (/mp4a/i.test(codecs) || /audio\/mp4/i.test(mime)) return 'aac';
        } catch (_) {}
        return '';
    }

    function cancel(jobId) {
        if (jobId) {
            try { workers.get(jobId)?.terminate(); } catch (_) {}
            workers.delete(jobId);
            rejects.get(jobId)?.(Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
            rejects.delete(jobId);
            return;
        }
        for (const id of workers.keys()) cancel(id);
    }

    async function mergeStreamsNow(job, videoFile, audioFile) {
        const worker = new Worker(chrome.runtime.getURL('vendor/mp4-remux-worker.js'));
        workers.set(job.jobId, worker);
        try {
            return await new Promise((resolve, reject) => {
                rejects.set(job.jobId, reject);
                worker.onmessage = event => {
                    const data = event.data || {};
                    if (data.type === 'status') {
                        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'merge', message: data.message });
                        return;
                    }
                    if (data.type === 'ffmpeg-progress') {
                        downloader.postStageMessage('videoStageMergeProgress', {
                            jobId: job.jobId,
                            progress: Math.max(0, Math.min(1, Number(data.progress) || 0)),
                            mergeTimeUs: Number(data.time) || 0,
                            mergeDurationUs: Number(data.duration) || 0,
                            frame: Number(data.frame) || 0
                        });
                        return;
                    }
                    if (data.type === 'done') {
                        resolve(data);
                        return;
                    }
                    if (data.type === 'error') reject(new Error(data.message || 'FFmpeg failed.'));
                };
                worker.onerror = event => reject(new Error(event.message || 'FFmpeg worker failed.'));
                worker.postMessage({
                    type: 'mux',
                    videoJobId: videoFile.jobId,
                    videoLabel: videoFile.label,
                    audioJobId: audioFile.jobId,
                    audioLabel: audioFile.label,
                    audioCodec: getAudioCodec(job.audioUrl)
                });
            });
        } finally {
            rejects.delete(job.jobId);
            try { worker.terminate(); } catch (_) {}
            if (workers.get(job.jobId) === worker) workers.delete(job.jobId);
        }
    }

    async function mergeStreams(job, videoFile, audioFile) {
        return await withMergeSlot(() => mergeStreamsNow(job, videoFile, audioFile));
    }

    async function triggerDownload(file, filename, jobId) {
        downloader.throwIfCancelled(jobId);
        const fileSize = Number(file?.size) || 0;
        downloader.postStageMessage('videoStageStatus', {
            jobId,
            stage: 'save',
            message: fileSize > 0 ? 'Saving final file…' : 'Starting final download…',
            fileBytes: fileSize
        });

        const url = URL.createObjectURL(file);
        try {
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            downloader.postStageMessage('videoStageDownloadStarted', { jobId, fileBytes: fileSize });
        } finally {
            // The File object remains usable after the URL is created. Revoke the
            // object URL later to avoid keeping the browser-side handle alive.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }

        // Source/output OPFS files are now no longer needed by the extension.
        try { await storage.removeJob(jobId); } catch (_) {}
    }

    async function process(job, videoFile, audioFile) {
        downloader.throwIfCancelled(job.jobId);
        await mergeStreams(job, videoFile, audioFile);
        downloader.throwIfCancelled(job.jobId);
        const mergedFile = await storage.getFile(job.jobId, 'merged', 'video/mp4');
        await triggerDownload(mergedFile, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    async function processSingle(job, mediaFile) {
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'save', message: 'Preparing final file…' });
        const file = await storage.getFile(job.jobId, mediaFile.label, job.mediaMime || 'video/mp4');
        await triggerDownload(file, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    self.GDriveVideoProcessor = { process, processSingle, cancel };
})();
