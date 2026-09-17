/**
 * Video Processor
 * Runs in the offscreen document after the source streams are downloaded.
 * Merges video and audio with FFmpeg, creates the final MP4 Blob, and starts the save. 
 */

(() => {
    const downloader = window.GDriveVideoStreamDownloader;
    let activeWorker = null;
    let activeReject = null;

    function getAudioCodec(url) {
        try {
            const parsedURL = new URL(url);
            const codecs = parsedURL.searchParams.get('codecs') || '';
            const mime = parsedURL.searchParams.get('mime') || '';
            if (/mp4a/i.test(codecs) || /audio\/mp4/i.test(mime)) return 'aac';
        } catch (_) {}
        return '';
    }

    function cancel() {
        try { activeWorker?.terminate(); } catch (_) {}
        activeWorker = null;
        activeReject?.(Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
        activeReject = null;
    }

    async function mergeStreams(job, videoBlob, audioBlob) {
        const worker = new Worker(chrome.runtime.getURL('vendor/ffmpeg-mux-worker.js'));
        activeWorker = worker;

        try {
            return await new Promise((resolve, reject) => {
                activeReject = reject;
                worker.onmessage = event => {
                    const data = event.data || {};
                    if (data.type === 'status') {
                        downloader.postStageMessage('videoStageStatus', {
                            jobId: job.jobId,
                            stage: 'merge',
                            message: data.message
                        });
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
                    if (data.type === 'error') {
                        reject(new Error(data.message || 'FFmpeg failed.'));
                    }
                };
                worker.onerror = event => {
                    reject(new Error(event.message || 'FFmpeg worker failed.'));
                };
                worker.postMessage({
                    type: 'mux',
                    video: videoBlob,
                    audio: audioBlob,
                    audioCodec: getAudioCodec(job.audioUrl)
                });
            });
        } finally {
            activeReject = null;
            try { worker.terminate(); } catch (_) {}
            if (activeWorker === worker) activeWorker = null;
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
        downloader.throwIfCancelled();
        const mergedBlob = await mergeStreams(job, videoBlob, audioBlob);
        downloader.throwIfCancelled();
        downloader.postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'processing'
        });
        await triggerDownload(mergedBlob, job.filename, job.jobId);
        downloader.postStageMessage('videoStageFinished', { jobId: job.jobId });
    }

    window.GDriveVideoProcessor = {
        process,
        cancel
    };
})();
