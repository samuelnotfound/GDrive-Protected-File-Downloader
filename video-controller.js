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
    function setVideoPlaybackStarted(started = true) {
        if (!started || video.playbackStarted) return;
        video.playbackStarted = true;
        updateVideoMenuState();
        app.sendAction("videoPlaybackStarted");
    }
    function updateVideoMenuState() {
        const items = document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID);
        items.forEach(item => {
            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            const busy = !!video.downloadInProgress;
            const labelText = busy  ? 'Downloading Video…': 'Download Video';
            if (label) label.textContent = labelText;
            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = video.streamDetected  ? 'true': 'false';
            item.dataset.playbackReady = video.playbackStarted  ? 'true': 'false';
            if (busy) {
                item.setAttribute('aria-disabled', 'true');
                item.setAttribute('disabled', 'true');
                item.style.cursor = 'default';
                item.style.opacity = '.55';
                item.style.pointerEvents = 'none';
                item.tabIndex = - 1;
            }else {
                item.removeAttribute('aria-disabled');
                item.removeAttribute('disabled');
                item.style.cursor = 'pointer';
                item.style.opacity = '1';
                item.style.pointerEvents = 'auto';
                item.tabIndex = 0;
            }
            if (info) info.textContent = busy  ? 'Video download is in progress…': 'This option uses an alternative method to download the video when the usual download option is unavailable.';
        });
    }
    function setVideoDownloadState(hasStream) {
        video.streamDetected = !!hasStream;
        updateVideoMenuState();
    }
    function syncVideoStreamState(streams = {}) {
        if (streams.playbackStarted || streams.video) video.playbackStarted = true;
        setVideoDownloadState(!!streams.video);
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
    async function startCurrentVideoAndWait() {
        let videos = [];
        try {
            videos = collectVideoElements();
            videos.forEach(muteVideo);
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
            collectVideoElements().forEach(muteVideo);
        } catch (_) {
        }
        setVideoPlaybackStarted();
        return {
            success: true
        };
    }
    async function startVideoFromMenu() {
        if (video.downloadInProgress) return;
        video.downloadInProgress = true;
        updateVideoMenuState();
        const filename = getCurrentDriveFileName();
        videoOverlay.show(true);
        try {
            app.ui.closeDriveFileMenu();
            const playback = await startCurrentVideoAndWait();
            if (!playback.success) {
                videoOverlay.update({
                    stage: 'error', message: playback.error || 'The video did not start playing.'
                });
                const root = document.getElementById('psd-video-progress-overlay');
                root?.classList.add('error');
                video.downloadInProgress = false;
                updateVideoMenuState();
                return;
            }
            chrome.runtime.sendMessage({
                action: 'downloadVideo', filename: filename || undefined
            }, response => {
                if (chrome.runtime.lastError) {
                    videoOverlay.update({
                        stage: 'error', message: chrome.runtime.lastError.message
                    });
                    return;
                }
                if (response && !response.success) {
                    video.downloadInProgress = false;
                    updateVideoMenuState();
                    videoOverlay.update({
                        stage: 'error', message: response.error || 'Video processing failed.'
                    });
                    return;
                }
                updateVideoMenuState();
            });
        }catch (error) {
            video.downloadInProgress = false;
            updateVideoMenuState();
            videoOverlay.update({
                stage: 'error', message: error?.message || String(error)
            });
        }
    }
    function installVideoMenuClickGuard() {
        if (window.__PSD_VIDEO_MENU_CLICK_GUARD) return;
        window.__PSD_VIDEO_MENU_CLICK_GUARD = true;
        const activate = (item, event) => {
            if (!item || video.downloadInProgress) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            item.dataset.activationInProgress = 'true';
            setTimeout(() => {
                item.dataset.activationInProgress = 'false';
            }, 1800);
            startVideoFromMenu();
        };
        document.addEventListener('pointerdown', e => {
            const item = e.target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID);
            if (item) activate(item, e);
        }, true);
        document.addEventListener('click', e => {
            const item = e.target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID);
            if (item && item.dataset.activationInProgress !== 'true') activate(item, e);
        }, true);
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
            "Download Video"
        );
        if (!item) return false;

        const label = item.querySelector('[jsname="K4r5Ff"]');
        if (label) {
            label.classList.add("psd-video-menu-label");
            label.textContent = "Download Video";
        } else {
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (app.ui.normalizeMenuText(node.nodeValue) === "Security limitations") {
                    node.nodeValue = "Download Video";
                    break;
                }
            }
        }
        app.ui.addMenuDescription(item, "psd-video-menu-label", "psd-video-menu-info", "This option uses an alternative method to download the video when the usual download option is unavailable.");
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item, "1");
        app.ui.handleMenuKeyboardActivation(item, event => {
            event.preventDefault();
            event.stopPropagation();
            item.click();
        });
        const parent = securityRow.parentNode;
        const shareRow = app.ui.findShareRow(menu);
        app.ui.insertAfterReference(parent, item, shareRow || null);
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
                video.lastFilenameSent = '';
                updateVideoMenuState();
                app.sendAction('clearVideoStream');
                updateCapturedVideoFilename();
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
                return videoOverlay.show(true, msg.jobId || null, msg.videoBytes || 0, msg.audioBytes || 0);
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
                    videoOverlay.setJob(msg.jobId || activeJob, msg.videoBytes || 0, msg.audioBytes || 0);
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
        installVideoMenuClickGuard();
        installStreamStorageListener();
        initMessaging();
        installFramePlaybackRelay();
    }

    app.video = { isVideoViewerOpen, scanViewerState, scanMenu, init };
    app.init();
})();
