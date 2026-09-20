/**
 * Video Processor
 * Runs in the offscreen document after source streams are downloaded.
 * Merges adaptive video+audio with FFmpeg when necessary, or saves a selected
 * progressive stream directly. Each job has its own FFmpeg worker.
 */

(() => {
    const downloader = window.GDriveVideoStreamDownloader;
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

    async function mergeStreams(job, videoBlob, audioBlob) {
        const worker = new Worker(chrome.runtime.getURL('vendor/ffmpeg-mux-worker.js'));
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
                        if (!(data.buffer instanceof ArrayBuffer)) {
                            reject(new Error('FFmpeg returned an invalid MP4 buffer.'));
                            return;
                        }
                        resolve(new Blob([data.buffer], { type: 'video/mp4' }));
                        return;
                    }
                    if (data.type === 'error') reject(new Error(data.message || 'FFmpeg failed.'));
                };
                worker.onerror = event => reject(new Error(event.message || 'FFmpeg worker failed.'));
                worker.postMessage({
                    type: 'mux',
                    video: videoBlob,
                    audio: audioBlob,
                    audioCodec: getAudioCodec(job.audioUrl)
                });
            });
        } finally {
            rejects.delete(job.jobId);
            try { worker.terminate(); } catch (_) {}
            if (workers.get(job.jobId) === worker) workers.delete(job.jobId);
        }
    }

    async function triggerDownload(blob, filename, jobId) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        downloader.postStageMessage('videoStageDownloadStarted', { jobId });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function process(job, videoBlob, audioBlob) {
        downloader.throwIfCancelled(job.jobId);
        const mergedBlob = await mergeStreams(job, videoBlob, audioBlob);
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing' });
        await triggerDownload(mergedBlob, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    async function processSingle(job, mediaBlob) {
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing', message: 'Preparing selected quality…' });
        const type = String(job.mediaMime || 'video/mp4').toLowerCase();
        const blob = type.includes('mp4') ? mediaBlob : new Blob([mediaBlob], { type: type || 'video/mp4' });
        await triggerDownload(blob, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    window.GDriveVideoProcessor = { process, processSingle, cancel };
})();
