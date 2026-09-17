/**
 * Video Controller
 * Runs on the Google Drive page: detects playback/streams, controls the video Download button,
 * and sends video download requests and progress updates through the extension runtime.
 */

(() => {
    if (!window.__PSD_LOADED || window.__PSD_VIDEO_LOADED) return;
    window.__PSD_VIDEO_LOADED = true;
    const app = window.__PSD;
    const video = app.videoState;
    const PROTECTED_VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;
    if (!videoOverlay) throw new Error('Video overlay module failed to load.');
    video.availableFormats = video.availableFormats || [];
    video.lastStreams = video.lastStreams || {};
    video.selectedQuality = video.selectedQuality || '';
    let qualityProbeInFlight = null;
    let qualityProbeRetryTimer = null;
    let qualityProbeAttempts = 0;

    // Video detection and menu integration
    
    
    
    
    
    

    function isVideoViewerOpen() {
        const viewer = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]');
        const player = document.querySelector('section[aria-label="Video Player"]');
        const open = !!(viewer && player && viewer.getAttribute('aria-hidden') !== 'true');
        return open;
    }
    function getCurrentDriveFileName() {
        const candidates = [];
        const json = document.querySelector('#drive-active-item-info');
        if (json) {
            try {
                const data = JSON.parse(json.textContent || '');
                candidates.push(data?.title, data?.name);
            }catch (_) {
            }
        }
        const meta = document.querySelector('meta[itemprop="name"]')?.content || '';
        candidates.push(meta);
        const selectors = ['[aria-label^="File name"]', '[data-tooltip^="File name"]', '[aria-label][role="heading"]', 'h1[aria-label]', '[data-tooltip][role="heading"]'];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                candidates.push(el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.textContent);
            }
        }
        candidates.push(String(document.title || '').replace(/\s*-\s*Google Drive\s*$/i, ''));
        for (const value of candidates) {
            const name = String(value || '').replace(/^File name\s*[:\-]?\s*/i, '').trim();
            if (!name || /^Google Drive$/i.test(name)) continue;
            if (/^(File name|Showing viewer|Video Player)$/i.test(name)) continue;
            return name;
        }
        return '';
    }

    function getCurrentDriveFileId() {
        try {
            const info = document.querySelector('#drive-active-item-info');
            if (info?.textContent) {
                const data = JSON.parse(info.textContent);
                const id = data?.id || data?.fileId || data?.file_id;
                if (id) return String(id);
            }
        } catch (_) {}
        const match = location.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
        return match ? match[1] : '';
    }

    const ITAG_HEIGHTS = {
        17: 144, 18: 360, 22: 720, 37: 1080, 38: 3072,
        133: 240, 134: 360, 135: 480, 136: 720, 137: 1080,
        160: 144, 242: 240, 243: 360, 244: 480, 247: 720,
        248: 1080, 278: 144, 264: 144, 266: 240, 302: 720,
        303: 1080, 308: 1440, 313: 2160, 315: 2160,
        394: 144, 395: 240, 396: 360, 397: 480, 398: 720,
        399: 1080, 400: 1440, 401: 2160, 402: 2880, 403: 4320
    };

    function qualityFromStreamUrl(url) {
        if (!url) return '';
        try {
            const params = new URL(url).searchParams;
            for (const key of ['size', 'resolution']) {
                const value = params.get(key) || '';
                const match = value.match(/(?:x)?(\d{3,4})p?$/i) || value.match(/(?:^|x)(\d{3,4})(?:p|$)/i);
                if (match) return `${Number(match[1])}p`;
            }
            for (const key of ['height', 'quality', 'res']) {
                const value = params.get(key) || '';
                const match = String(value).match(/(?:^|\D)(\d{3,4})p?(?:\D|$)/i);
                const height = match ? Number(match[1]) : Number(value);
                if (Number.isInteger(height) && height >= 144 && height <= 4320) return `${height}p`;
            }
            const itag = Number(params.get('itag'));
            if (ITAG_HEIGHTS[itag]) return `${ITAG_HEIGHTS[itag]}p`;
        } catch (_) {}
        return '';
    }

    function qualityOptionsFromCapturedStreams(streams = {}) {
        const urls = [
            streams.video, streams.videoOriginal,
            ...(Array.isArray(streams.videoCandidates) ? streams.videoCandidates : [])
        ].filter(Boolean);
        const qualities = [...new Set(urls.map(qualityFromStreamUrl).filter(Boolean))];
        return qualityOptionsFromFormats(qualities.map(quality => ({ quality, height: Number(quality.replace('p', '')) })));
    }

    function qualityOptionsFromFormats(formats = []) {
        const seen = new Set();
        return formats
            .filter(format => format?.quality)
            .sort((a, b) => Number(b.height || String(b.quality).replace('p', '')) - Number(a.height || String(a.quality).replace('p', '')))
            .filter(format => !seen.has(format.quality) && seen.add(format.quality))
            .map(format => ({ label: format.quality, value: format.quality }));
    }

    async function getAvailableVideoQualities() {
        const fileId = getCurrentDriveFileId();
        if (!fileId) return [];

        try {
            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'getVideoFormats', fileId }, response => {
                    if (chrome.runtime.lastError) return resolve({ success: false });
                    resolve(response || { success: false });
                });
            });
            if (result?.success && Array.isArray(result.videos) && result.videos.length) {
                video.availableFormats = result.videos;
                return qualityOptionsFromFormats(video.availableFormats);
            }
        } catch (_) {}

        try {
            const local = await new Promise(resolve => {
                chrome.storage.local.get({ capturedStreams: {} }, result => resolve(result?.capturedStreams || {}));
            });
            if (local.activeFileId && local.activeFileId !== fileId) return [];
            video.lastStreams = local;
            video.availableFormats = Array.isArray(local.videoFormats) ? local.videoFormats : video.availableFormats || [];
            if (video.availableFormats.length) return qualityOptionsFromFormats(video.availableFormats);
            const inferred = qualityOptionsFromCapturedStreams(local);
            if (inferred.length) video.streamDetected = true;
            return inferred;
        } catch (_) {}
        const inferred = qualityOptionsFromCapturedStreams(video.lastStreams);
        if (inferred.length) video.streamDetected = true;
        return inferred;
    }

    function bindVideoQualityPicker(item) {
        app.ui.addDownloadQualityPicker(item);
        item.__psdQualityOnChange = quality => {
            video.selectedQuality = quality || '';
        };
        return item.__psdQualityPicker;
    }

    function updateVideoQualityPickers(options) {
        const items = document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID);
        items.forEach(item => {
            bindVideoQualityPicker(item);
            const selected = app.ui.setDownloadQualityOptions(item, options, video.selectedQuality);
            if (selected && selected !== video.selectedQuality) video.selectedQuality = selected;
        });
    }

    function retryQualityProbe(delay = 900) {
        if (qualityProbeRetryTimer || qualityProbeAttempts >= 6) return;
        qualityProbeRetryTimer = setTimeout(() => {
            qualityProbeRetryTimer = null;
            probeAvailableVideoQualities();
        }, delay);
    }

    async function probeAvailableVideoQualities() {
        if (qualityProbeInFlight) return qualityProbeInFlight;
        if (!getCurrentDriveFileId()) return [];
        qualityProbeInFlight = (async () => {
            try {
                qualityProbeAttempts++;
                const options = await getAvailableVideoQualities();
                if (options.length) qualityProbeAttempts = 0;
                if (options.length) {
                    updateVideoQualityPickers(options);
                } else if (video.lastViewerState || video.streamDetected) {
                    retryQualityProbe(1200);
                }
                updateVideoMenuState();
                return options;
            } finally {
                qualityProbeInFlight = null;
            }
        })();
        return qualityProbeInFlight;
    }

    function updateCapturedVideoFilename() {
        const name = getCurrentDriveFileName();
        if (!name || name === video.lastFilenameSent) return name;
        video.lastFilenameSent = name;
        app.sendAction("updateFilename", { filename: name });
        return name;
    }

    function isVisibleVideoElement(video) {
        if (!video) return false;
        const r = video.getBoundingClientRect?.();
        if (!r || r.width <= 1 || r.height <= 1) return false;
        const style = getComputedStyle(video);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function collectVideoElements(root = document, out = []) {
        try {
            if (root.querySelectorAll) {
                out.push(...root.querySelectorAll('video'));
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) collectVideoElements(el.shadowRoot, out);
                }
            }
        }catch (_) {
        }
        return out;
    }
    function hasMainPagePlaybackStarted() {
        return collectVideoElements().some(video => isVisibleVideoElement(video) && !video.paused && !video.ended && (video.currentTime > 0 || video.readyState >= 3));
    }
    function getQualityFromDriveUI() {
        const resolutionPattern = /\b(2160|1440|1080|720|480|360|240|144)p\b/i;
        const selectors = [
            '[role="menuitemradio"][aria-checked="true"]',
            '[role="option"][aria-selected="true"]',
            '[aria-current="true"]',
            '[aria-label*="p"]',
            '[data-tooltip*="p"]'
        ];
        const viewer = document.querySelector('section[aria-label="Video Player"]') || document;
        for (const selector of selectors) {
            for (const el of viewer.querySelectorAll(selector)) {
                const text = [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.textContent]
                    .filter(Boolean).join(' ');
                const match = text.match(resolutionPattern);
                if (match) return match[1] + 'p';
            }
        }
        return '';
    }

    function getCurrentVideoResolution() {
        const uiQuality = getQualityFromDriveUI();
        if (uiQuality) return uiQuality;
        const all = collectVideoElements().filter(v => Number(v.videoHeight) > 0 && Number(v.videoWidth) > 0);
        const videos = all.filter(isVisibleVideoElement);
        const active = (videos.length ? videos : all)
            .sort((a, b) => (Number(b.videoWidth) * Number(b.videoHeight)) - (Number(a.videoWidth) * Number(a.videoHeight)))[0];
        const height = Number(active?.videoHeight) || 0;
        return height ? `${height}p` : '';
    }
    function setVideoPlaybackStarted(started = true) {
        if (!started || video.playbackStarted) return;
        video.playbackStarted = true;
        updateVideoMenuState();
        app.sendAction('videoPlaybackStarted', { fileId: getCurrentDriveFileId() });
        probeAvailableVideoQualities();
    }
    function updateVideoMenuState() {
        const items = document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID);
        items.forEach(item => {
            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            const busy = !!video.downloadInProgress;
            const labelText = busy ? 'Downloading…' : 'Download';
            if (label) label.textContent = labelText;
            item.setAttribute('aria-label', labelText);
            item.removeAttribute('aria-haspopup');
            item.dataset.streamReady = video.streamDetected ? 'true' : 'false';
            item.dataset.playbackReady = video.playbackStarted ? 'true' : 'false';
            const ready = (video.playbackStarted || video.streamDetected || video.availableFormats.length > 0) && !busy;
            if (busy || !ready) {
                item.setAttribute('aria-disabled', 'true');
                item.setAttribute('disabled', 'true');
                item.style.cursor = 'default';
                item.style.opacity = '.55';
                item.style.pointerEvents = 'none';
                item.tabIndex = -1;
            } else {
                item.removeAttribute('aria-disabled');
                item.removeAttribute('disabled');
                item.style.cursor = 'pointer';
                item.style.opacity = '1';
                item.style.pointerEvents = 'auto';
                item.tabIndex = 0;
            }
            app.ui.setDownloadQualityDisabled(item, busy || !ready);
            if (info) info.textContent = 'GDrive Protected File Downloader';
        });
    }
    function setVideoDownloadState(hasStream) {
        video.streamDetected = !!hasStream;
        updateVideoMenuState();
    }
    function syncVideoStreamState(streams = {}) {
        video.lastStreams = streams;
        if (streams.playbackStarted || streams.video) video.playbackStarted = true;
        video.availableFormats = Array.isArray(streams.videoFormats) ? streams.videoFormats : video.availableFormats || [];
        if (video.availableFormats.length) updateVideoQualityPickers(qualityOptionsFromFormats(video.availableFormats));
        setVideoDownloadState(!!streams.video || video.availableFormats.length > 0);
    }

    async function tryDirectVideoPlayback(videos) {
        for (const video of videos) {
            try {
                const before = Number(video.currentTime || 0);
                const playPromise = video.play();
                if (playPromise?.then) await playPromise;
                await app.sleep(250);
                app.muteVideo(video);
                if (!video.paused && !video.ended) {
                    setVideoPlaybackStarted();
                    return {
                        success: true,
                        direct: true,
                        before,
                        after: Number(video.currentTime || 0),
                        muted: video.muted
                    };
                }
            } catch (error) {
                console.warn(
                    "[GDrive Downloader] Direct muted playback failed:",
                    error?.message || error
                );
            }
        }
        return null;
    }
    async function requestFrameVideoPlayback() {
        try {
            return await new Promise(resolve => {
                chrome.runtime.sendMessage(
                    { action: "playCurrentVideo" },
                    response => {
                        if (chrome.runtime.lastError) {
                            resolve({
                                success: false,
                                error: chrome.runtime.lastError.message
                            });
                            return;
                        }
                        resolve(response || {
                            success: false,
                            error: "Could not start the Drive video."
                        });
                    }
                );
            });
        } catch (error) {
            return {
                success: false,
                error: error?.message || "Could not start the Drive video."
            };
        }
    }
    async function waitForVideoResolution(maxWait = 1200) {
        const end = Date.now() + maxWait;
        do {
            const resolution = getCurrentVideoResolution();
            if (resolution) return resolution;
            await app.sleep(100);
        } while (Date.now() < end);
        return '';
    }
    async function startCurrentVideoAndWait() {
        let videos = [];
        try {
            videos = collectVideoElements();
            videos.forEach(app.muteVideo);
            const directResult = await tryDirectVideoPlayback(videos);
            if (directResult) return directResult;
        } catch (error) {
            console.warn(
                "[GDrive Downloader] Direct player scan failed:",
                error?.message || error
            );
        }
        const result = await requestFrameVideoPlayback();
        await app.sleep(1500);
        if (!result?.success) {
            return {
                success: false,
                error: result?.error ||
                    "The video did not start playing, so no download was started."
            };
        }
        try {
            collectVideoElements().forEach(app.muteVideo);
        } catch (_) {
        }
        setVideoPlaybackStarted();
        return {
            success: true
        };
    }
    async function beginVideoDownload(quality) {
        if (video.downloadInProgress || !quality) return;
        video.downloadInProgress = true;
        updateVideoMenuState();
        const filename = getCurrentDriveFileName();
        const fileId = getCurrentDriveFileId();
        videoOverlay.show(true);
        try {
            app.ui.closeDriveFileMenu();
            const response = await new Promise(resolve => {
                chrome.runtime.sendMessage({
                    action: 'downloadVideo',
                    filename: filename || undefined,
                    resolution: quality,
                    fileId: fileId || undefined
                }, result => {
                    if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
                    resolve(result || { success: false, error: 'Video download did not start.' });
                });
            });
            if (!response.success) {
                video.downloadInProgress = false;
                updateVideoMenuState();
                videoOverlay.update({ stage: 'error', message: response.error || 'Video processing failed.' });
            }
        } catch (error) {
            video.downloadInProgress = false;
            updateVideoMenuState();
            videoOverlay.update({ stage: 'error', message: error?.message || String(error) });
        }
    }

    function installVideoMenuHandler() {
        // Download rows install their own click handler when created.
    }


    function installStreamStorageListener() {
        if (window.__PSD_STREAM_STORAGE_LISTENER) return;
        window.__PSD_STREAM_STORAGE_LISTENER = true;
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.capturedStreams) return;
                syncVideoStreamState(changes.capturedStreams.newValue || {});
            });
            chrome.storage.local.get({ capturedStreams: {} }, result => {
                syncVideoStreamState(result?.capturedStreams || {});
            });
        }catch (_) {
        }
    }

    function addProtectedVideoMenuItem(menu) {
        if (menu.querySelector(`#${PROTECTED_VIDEO_MENU_ID}`)) return true;
        const securityRow = app.ui.findMenuRow(menu, "Security limitations");
        if (!securityRow) return false;
        const printRow = app.ui.findMenuRow(menu, "Print");
        if (printRow) return false;
        const templateRow =
            app.ui.findMenuRow(menu, "Details") ||
            app.ui.findMenuRow(menu, "Add to starred") ||
            securityRow;
        const item = app.ui.makeStandaloneMenuRow(
            templateRow,
            PROTECTED_VIDEO_MENU_ID,
            "Download"
        );
        if (!item) return false;

        // This row contains its own Quality control, so Drive must not treat it as a native menu action.
        item.setAttribute('role', 'presentation');
        item.setAttribute('data-psd-video-download-row', 'true');

        const label = item.querySelector('[jsname="K4r5Ff"]');
        if (label) {
            label.classList.add("psd-video-menu-label");
            label.textContent = "Download";
        } else {
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (app.ui.normalizeMenuText(node.nodeValue) === "Security limitations") {
                    node.nodeValue = "Download";
                    break;
                }
            }
        }
        app.ui.addMenuDescription(item, "psd-video-menu-label", "psd-video-menu-info", "GDrive Protected File Downloader");
        bindVideoQualityPicker(item);
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item, "1");
        app.ui.handleMenuKeyboardActivation(item, event => {
            if (event.target?.closest?.('.psd-quality-picker')) return;
            event.preventDefault();
            event.stopPropagation();
            const quality = app.ui.getDownloadQuality(item) || video.selectedQuality;
            if (quality) beginVideoDownload(quality);
        });
        const parent = securityRow.parentNode;
        const shareRow = app.ui.findShareRow(menu);
        app.ui.insertAfterReference(parent, item, shareRow || null);
        app.ui.addDownloadQualityPicker(item);
        const options = qualityOptionsFromFormats(video.availableFormats || []);
        app.ui.setDownloadQualityOptions(item, options, video.selectedQuality);
        item.addEventListener('click', event => {
            if (event.target?.closest?.('.psd-quality-picker')) return;
            event.preventDefault();
            event.stopPropagation();
            const quality = app.ui.getDownloadQuality(item) || video.selectedQuality;
            if (quality) beginVideoDownload(quality);
        });
        updateVideoMenuState();
        return true;
    }

    function installFramePlaybackRelay() {
        if (window.__PSD_FRAME_PLAYBACK_RELAY) return;
        window.__PSD_FRAME_PLAYBACK_RELAY = true;

        const relay = event => {
            const video = event.target;
            if (!video || String(video.tagName || '').toLowerCase() !== 'video') return;
            if (!isVisibleVideoElement(video)) return;
            setVideoPlaybackStarted();
        };

        document.addEventListener('play', relay, true);
        document.addEventListener('playing', relay, true);

        let checks = 0;
        const poll = setInterval(() => {
            if (hasMainPagePlaybackStarted()) setVideoPlaybackStarted();
            if (++checks >= 20) clearInterval(poll);
        }, 250);
    }
    const videoStageTypes = new Set([
        'videoStagePreload', 'videoStageStarted', 'videoStageStatus', 'videoStageProgress',
        'videoStageMergeProgress', 'videoStageDownloadStarted', 'videoStageFinished',
        'videoStageError', 'videoStageCancelled'
    ]);
    const setVideoBusy = busy => {
        video.downloadInProgress = busy;
        updateVideoMenuState();
    };
    function scanViewerState() {
        const open = isVideoViewerOpen();
        if (open !== video.lastViewerState) {
            if (open) {
                video.streamDetected = false;
                video.playbackStarted = false;
                video.availableFormats = [];
                video.lastStreams = {};
                video.selectedQuality = '';
                qualityProbeAttempts = 0;
                if (qualityProbeRetryTimer) { clearTimeout(qualityProbeRetryTimer); qualityProbeRetryTimer = null; }
                video.lastFilenameSent = '';
                updateVideoMenuState();
                app.sendAction('clearVideoStream', { fileId: getCurrentDriveFileId() });
                updateCapturedVideoFilename();
                retryQualityProbe(250);
            }
            if (open) updateCapturedVideoFilename();
            video.lastViewerState = open;
        }
    }
    function scanMenu(menu) {
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        const printRow = app.ui.findMenuRow(menu, 'Print');
        if (securityRow && !printRow && !app.ui.findMenuRow(menu, 'Download')) addProtectedVideoMenuItem(menu);
    }
    function initMessaging() {
        chrome.runtime.onMessage.addListener(msg => {
            if (window.top !== window.self || !videoStageTypes.has(msg?.type)) return;
            if (msg.type === 'videoStagePreload') {
                const job = videoOverlay.getJobId();
                const stage = videoOverlay.getStage();
                if ((job && job !== msg.jobId && !['ready', 'cancelled', 'error'].includes(stage)) ||
                    (job === msg.jobId && stage !== 'download')) return;
                return videoOverlay.show(true, msg.jobId || null, msg.videoBytes || 0, msg.audioBytes || 0, msg.resolution || '');
            }
            const activeJob = videoOverlay.getJobId();
            if (activeJob && msg.jobId && activeJob !== msg.jobId) return;
            switch (msg.type) {
                case 'videoStageStatus':
                    if (msg.stage === 'staged' || msg.stage === 'merge') {
                        videoOverlay.update({ stage: 'merge', progress: msg.stage === 'staged' ? 0 : undefined });
                    } else if (msg.stage === 'processing') {
                        videoOverlay.update({ stage: 'processing' });
                    }
                    break;
                case 'videoStageStarted':
                    videoOverlay.setJob(msg.jobId || activeJob, msg.videoBytes || 0, msg.audioBytes || 0, msg.resolution || '');
                    break;
                case 'videoStageProgress':
                    videoOverlay.update({ label: msg.label, received: msg.received, total: msg.total });
                    break;
                case 'videoStageMergeProgress':
                    videoOverlay.update({ stage: 'merge', progress: msg.progress });
                    break;
                case 'videoStageDownloadStarted':
                    videoOverlay.update({ stage: 'started' });
                    break;
                case 'videoStageFinished':
                    setVideoBusy(false);
                    videoOverlay.update({ stage: 'ready' });
                    break;
                case 'videoStageError':
                    videoOverlay.clearJob();
                    setVideoBusy(false);
                    videoOverlay.update({ stage: 'error', message: msg.message || 'Video processing failed.' });
                    break;
                case 'videoStageCancelled':
                    videoOverlay.clearJob();
                    setVideoBusy(false);
                    videoOverlay.update({ stage: 'cancel' });
                    break;
            }
        });
    }
    function init() {
        installVideoMenuHandler();
        installStreamStorageListener();
        initMessaging();
        installFramePlaybackRelay();
    }

    app.video = { isVideoViewerOpen, scanViewerState, scanMenu, init };
    app.init();
})();
