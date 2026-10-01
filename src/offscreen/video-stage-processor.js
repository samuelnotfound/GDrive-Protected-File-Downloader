(() => {
    const downloader = self.GDriveVideoStreamDownloader;
    const storage = self.GDriveVideoStageStorage;
    const workers = new Map();
    const rejects = new Map();

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

    async function mergeStreams(job, videoFile, audioFile) {
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

    async function triggerDownload(file, filename, jobId) {
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        downloader.postStageMessage('videoStageDownloadStarted', { jobId });
        // The File object is a snapshot; source/output files can be removed
        // from OPFS after the download URL has been created.
        try { await storage.removeJob(jobId); } catch (_) {}
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function process(job, videoFile, audioFile) {
        downloader.throwIfCancelled(job.jobId);
        await mergeStreams(job, videoFile, audioFile);
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing' });
        const mergedFile = await storage.getFile(job.jobId, 'merged', 'video/mp4');
        await triggerDownload(mergedFile, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    async function processSingle(job, mediaFile) {
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing', message: 'Preparing selected quality…' });
        const file = await storage.getFile(job.jobId, mediaFile.label, job.mediaMime || 'video/mp4');
        await triggerDownload(file, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    self.GDriveVideoProcessor = { process, processSingle, cancel };
})();
