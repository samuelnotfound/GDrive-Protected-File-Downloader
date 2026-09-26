(() => {
    if (!window.__PSD_LOADED || window.__PSD_VIDEO_LOADED) return;
    window.__PSD_VIDEO_LOADED = true;

    const app = window.__PSD;
    const video = app.videoState;
    const VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;
    const core = app.videoCore;
    const quality = app.videoQuality;
    const bridge = app.videoBridge;

    if (!videoOverlay || !core || !quality || !bridge) {
        throw new Error('Video modules failed to load.');
    }

    const STAGE_MESSAGES = new Set([
        'videoFormatsDetected', 'videoStreamDetected',
        'videoStagePreload', 'videoStageStarted', 'videoStageStatus', 'videoStageProgress',
        'videoStageMergeProgress', 'videoStageDownloadStarted', 'videoStageFinished',
        'videoStageError', 'videoStageCancelled'
    ]);
    const SCAN_VEIL_TEXT = 'Finding available video qualities…';

    function normalizeQualityMenuItem(item) {
        if (!item) return;

        const label = item.querySelector('.psd-video-menu-label');
        const info = item.querySelector('.psd-video-menu-info');
        item.querySelectorAll('.psd-quality-head,.psd-quality-head-copy,.psd-quality-head-title,.psd-quality-head-subtitle')
            .forEach(element => element.remove());

        if (label) {
            label.textContent = video.operation === 'picker' ? 'Choose video quality' : 'Download';
            label.classList.add('psd-video-menu-label');
            label.style.removeProperty('font-size');
            label.style.removeProperty('line-height');
            label.style.removeProperty('font-weight');
        }

        if (info) {
            info.textContent = 'GDrive Protected File Downloader';
            info.style.cssText = 'display:block;box-sizing:border-box;width:100%;max-width:100%;margin-top:2px;font:400 11px/14px Roboto,Arial,sans-serif;color:rgba(255,255,255,.62);white-space:normal;overflow-wrap:anywhere;word-break:normal;overflow:hidden;';
        }

        item.querySelectorAll('.aqdrmf-rymPhb-KkROqb').forEach(host => {
            host.style.setProperty('align-self', 'flex-start', 'important');
            host.style.setProperty('margin-top', '3px', 'important');
        });
    }

    function updateVideoMenuState() {
        const hasFormats = (video.formats?.video?.length || video.formats?.progressive?.length) > 0;
        const labelText = video.operation === 'picker' ? 'Choose video quality' : 'Download';

        document.querySelectorAll('#' + VIDEO_MENU_ID).forEach(item => {
            normalizeQualityMenuItem(item);
            quality.syncTypography(item);

            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            if (label) label.textContent = labelText;
            if (info) info.textContent = 'GDrive Protected File Downloader';

            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = hasFormats ? 'true' : 'false';
            item.dataset.playbackReady = video.playbackStarted ? 'true' : 'false';
            item.removeAttribute('aria-disabled');
            item.removeAttribute('disabled');
            item.style.cursor = 'pointer';
            item.style.opacity = '1';
            item.style.pointerEvents = 'auto';
            item.tabIndex = 0;
        });
    }

    function syncVideoStreamState(streams = {}) {
        const sameSession = !streams.fileId || !video.fileId || streams.fileId === video.fileId;
        if (!sameSession) return;

        if (streams.playbackStarted || streams.video) video.playbackStarted = true;
        if (streams.formats) video.formats = streams.formats;
        updateVideoMenuState();
    }

    function configureVideoMenuItem(item) {
        item.classList.add('psd-video-download-item');
        item.querySelector('[jsname="K4r5Ff"]')?.classList.add('psd-video-menu-label');
        const label = item.querySelector('.psd-video-menu-label');
        if (label) label.textContent = 'Download';

        app.ui.addMenuDescription(item, 'psd-video-menu-label', 'psd-video-menu-info', 'GDrive Protected File Downloader');
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item, '1');
        app.ui.handleMenuKeyboardActivation(item, event => {
            event.preventDefault();
            event.stopPropagation();
            item.click();
        });
    }

    function addProtectedVideoMenuItem(menu) {
        if (menu.querySelector(`#${VIDEO_MENU_ID}`)) return true;

        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        if (!securityRow || app.ui.findMenuRow(menu, 'Print')) return false;

        const templateRow = app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') || securityRow;
        const item = app.ui.makeStandaloneMenuRow(templateRow, VIDEO_MENU_ID, 'Download');
        if (!item) return false;

        configureVideoMenuItem(item);
        app.ui.insertAfterReference(
            securityRow.parentNode,
            item,
            app.ui.findShareRow(menu) || null
        );
        return true;
    }

    function scanMenu(menu) {
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        if (!securityRow) return;
        if (app.ui.findMenuRow(menu, 'Print') || app.ui.findMenuRow(menu, 'Download')) return;
        addProtectedVideoMenuItem(menu);
    }

    function cachedScanUsable() {
        const cache = video.scanCache;
        if (!cache || !video.fileId || cache.fileId !== video.fileId) return false;

        const videos = [...(video.formats?.video || []), ...(video.formats?.progressive || [])];
        const all = [...videos, ...(video.formats?.audio || [])].filter(format => format?.url);
        if (!videos.length || !all.length) return false;

        const heights = new Set(videos.map(format => Number(format.height) || 0).filter(Boolean));
        if (heights.size < cache.heightCount) return false;

        let soonestExpiry = Infinity;
        for (const format of all) {
            try {
                const expires = Number(new URL(format.originalUrl || format.url).searchParams.get('expire') || 0);
                if (expires) soonestExpiry = Math.min(soonestExpiry, expires);
            } catch (_) {}
        }

        return Number.isFinite(soonestExpiry)
            ? soonestExpiry > Date.now() / 1000 + 120
            : Date.now() - cache.at < 30 * 60 * 1000;
    }

    function rememberCompletedScan(scanReport) {
        const formats = [...(video.formats?.video || []), ...(video.formats?.progressive || [])];
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: new Set(formats.map(format => Number(format.height) || 0).filter(Boolean)).size,
            note: quality.describeScanReport(scanReport, '')
        };
    }

    function toCapturedVideoFormat(item, index) {
        return {
            id: item.id || `captured-v-${index}`,
            url: item.url,
            originalUrl: item.originalUrl,
            contentLength: Number(item.contentLength) || 0,
            width: Number(item.width) || 0,
            height: Number(item.height) || 0,
            fps: Number(item.fps) || 0,
            itag: item.itag || '',
            kind: 'video',
            mime: item.mime || 'video/mp4'
        };
    }

    function toCapturedAudioFormat(item, index) {
        return {
            id: item.id || `captured-a-${index}`,
            url: item.url,
            originalUrl: item.originalUrl,
            contentLength: Number(item.contentLength) || 0,
            itag: item.itag || '',
            kind: 'audio',
            acodec: item.codecs || '',
            mime: item.mime || 'audio/mp4'
        };
    }

    async function captureExistingStreamsAndPick() {
        const response = await core.sendRuntime({ action: 'getStreams' });
        const streams = response?.streams || {};
        const videoCandidates = Array.isArray(streams.videoCandidates) ? streams.videoCandidates : [];
        const audioCandidates = Array.isArray(streams.audioCandidates) ? streams.audioCandidates : [];

        const videoFormats = videoCandidates.map(toCapturedVideoFormat)
            .sort((a, b) => (b.height - a.height) || (b.contentLength - a.contentLength));
        const audioFormats = audioCandidates.map(toCapturedAudioFormat)
            .sort((a, b) => b.contentLength - a.contentLength);

        if (videoFormats.length || audioFormats.length) {
            return {
                success: true,
                formats: { video: videoFormats, audio: audioFormats, progressive: [] }
            };
        }

        return {
            success: false,
            error: 'No stream has been captured yet. Play the video once, let it load, then press Refresh.'
        };
    }

    async function showDetectedQuality(response) {
        const formats = response?.success ? response.formats : null;
        if (!formats || (!formats.video?.length && !formats.progressive?.length)) return false;

        await quality.show(
            formats,
            quality.describeScanReport(response.scanReport, '')
        );
        rememberCompletedScan(response.scanReport);
        return true;
    }

    async function showCapturedQualityFallback() {
        const fallback = await captureExistingStreamsAndPick();
        if (!fallback.success) return false;

        await quality.show(
            fallback.formats,
            'Using the stream(s) currently playing in Drive.'
        );
        return true;
    }

    async function runQualityDetection() {
        video.operation = 'scanning';
        updateVideoMenuState();
        quality.showPageBlocker(SCAN_VEIL_TEXT);

        app.ui.closeDriveFileMenu();
        await quality.waitForDriveFileMenuClosed(1200);
        if (core.startDrivePlayerFromUserGesture()?.started) video.playbackStarted = true;

        try {
            const context = await core.syncViewerContext(true);
            if (!context?.fileId) throw new Error('Could not identify the current Drive video before starting quality detection.');

            await core.sendRuntime({ action: 'prepareQualityScan', fileId: video.fileId });
            const response = await core.sendRuntime({ action: 'automatedQualityScan', fileId: video.fileId });
            if (await showDetectedQuality(response)) return;
            if (await showCapturedQualityFallback()) return;

            console.warn(
                '[GDrive Downloader] quality detection did not produce a usable stream:',
                response?.error || 'No captured fallback stream.'
            );
        } catch (error) {
            console.error('[GDrive Downloader] video quality detection failed:', error);
        }

        quality.resetScanUI();
    }

    async function startVideoFromMenu() {
        core.muteMediaImmediately();
        if (video.operation !== 'idle') return;

        if (cachedScanUsable() || core.hasUsableFormats(video.pickerFormats)) {
            app.ui.closeDriveFileMenu();
            video.operation = 'picker';
            await quality.show(video.pickerFormats || video.formats, video.scanCache?.note || '');
            return;
        }

        await runQualityDetection();
    }

    function installVideoMenuClickGuard() {
        if (window.__PSD_VIDEO_MENU_CLICK_GUARD) return;
        window.__PSD_VIDEO_MENU_CLICK_GUARD = true;

        const activate = (item, event) => {
            if (!item || event.target?.closest?.('#psd-video-quality-picker') || video.operation !== 'idle') return;
            core.muteMediaImmediately();
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            item.dataset.activationInProgress = 'true';
            setTimeout(() => { item.dataset.activationInProgress = 'false'; }, 1800);
            void startVideoFromMenu();
        };

        document.addEventListener('pointerdown', event => {
            const item = event.target?.closest?.('#' + VIDEO_MENU_ID);
            if (item) activate(item, event);
        }, true);
        document.addEventListener('click', event => {
            if (event.target?.closest?.('#psd-video-quality-picker')) return;
            const item = event.target?.closest?.('#' + VIDEO_MENU_ID);
            if (item && item.dataset.activationInProgress !== 'true') activate(item, event);
        }, true);
    }

    function installStreamStorageListener() {
        if (window.__PSD_STREAM_STORAGE_LISTENER) return;
        window.__PSD_STREAM_STORAGE_LISTENER = true;

        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.videoSessions) return;
                const sessions = changes.videoSessions.newValue || {};
                const session = Object.values(sessions).find(item =>
                    item?.fileId === video.fileId &&
                    (!video.viewerSessionId || item.viewerSessionId === video.viewerSessionId)
                );
                if (session) syncVideoStreamState(session);
            });
        } catch (_) {}
    }

    function resetViewerState(previousFileId) {
        if (video.operation !== 'staging') quality.hidePageBlocker();
        quality.stopWatch();

        const root = document.getElementById('psd-video-quality-picker');
        if (root) {
            root.style.display = 'none';
            if (root.parentElement?.closest?.('[role="menu"]')) root.remove();
        }

        video.restorePickerOnFileMenuOpen = false;
        video.operation = 'idle';
        video.fileId = '';
        video.viewerSessionId = '';
        video.formats = core.cloneFormats({});
        void quality.clearSnapshot(previousFileId);
    }

    async function scanViewerState() {
        const open = core.isVideoViewerOpen();
        if (open === video.lastViewerState) {
            if (open) {
                await core.syncViewerContext(false);
                core.updateCapturedVideoFilename();
            }
            return;
        }

        if (open) {
            video.viewerSessionId = '';
            video.fileId = '';
            video.playbackStarted = false;
            video.lastFilenameSent = '';
            await core.syncViewerContext(true);
        } else {
            resetViewerState(video.fileId);
        }

        updateVideoMenuState();
        video.lastViewerState = open;
    }

    function installDriveFileMenuRestore() {
        if (window.__PSD_FILE_MENU_QUALITY_RESTORE) return;
        window.__PSD_FILE_MENU_QUALITY_RESTORE = true;

        const restoreAfterToggle = async () => {
            if (video.operation === 'scanning' || !video.restorePickerOnFileMenuOpen || !video.fileId) return;

            const ready = await window.__PSD_CONTENT_UTILS.waitUntil(() => {
                const button = app.ui.getDriveFileButton();
                const expanded = String(button?.getAttribute('aria-expanded') || '').toLowerCase();
                return expanded !== 'false' && !!quality.getVisibleDriveMenu();
            }, 300, 25);
            if (ready) await quality.remountCached();
        };

        document.addEventListener('pointerdown', event => {
            const target = event.target?.closest?.('[role="button"],button');
            if (target && target === app.ui.getDriveFileButton()) void restoreAfterToggle();
        }, true);
    }

    function handleFormatMessage(message) {
        if (!core.isCurrentVideoMessage(message)) return;

        if (message.type === 'videoFormatsDetected') {
            video.formats = message.formats || { video: [], audio: [], progressive: [] };
        } else if (message.formats) {
            video.formats = message.formats;
        }

        if (message.type === 'videoStreamDetected') video.playbackStarted = true;
        updateVideoMenuState();
        if (video.operation === 'picker') quality.update();
    }

    function handleVideoStageMessage(message) {
        const activeJob = videoOverlay.getJobId();
        if (activeJob && message.jobId && activeJob !== message.jobId) return;

        switch (message.type) {
            case 'videoStageStatus':
                if (message.stage === 'staged' || message.stage === 'merge') {
                    videoOverlay.update({ stage: 'merge', progress: message.stage === 'staged' ? 0 : undefined });
                } else if (message.stage === 'processing') {
                    videoOverlay.update({ stage: 'processing' });
                }
                break;
            case 'videoStageStarted':
                videoOverlay.setJob(message.jobId || activeJob, message.videoBytes || message.mediaBytes || 0, message.audioBytes || 0);
                break;
            case 'videoStageProgress':
                videoOverlay.update({ label: message.label, received: message.received, total: message.total });
                break;
            case 'videoStageMergeProgress':
                videoOverlay.update({ stage: 'merge', progress: message.progress });
                break;
            case 'videoStageDownloadStarted':
                videoOverlay.update({ stage: 'started' });
                break;
            case 'videoStageFinished':
                finishVideoStage('ready');
                break;
            case 'videoStageError':
                finishVideoStage('error', message.message || 'Video processing failed.');
                break;
            case 'videoStageCancelled':
                finishVideoStage('cancel');
                break;
        }
    }

    function finishVideoStage(stage, message) {
        videoOverlay.clearJob();
        video.operation = 'idle';
        updateVideoMenuState();
        videoOverlay.update({ stage, ...(message ? { message } : {}) });
    }

    function handleVideoMessage(message) {
        if (!message || !STAGE_MESSAGES.has(message.type)) return;

        if (message.type === 'videoFormatsDetected' || message.type === 'videoStreamDetected') {
            handleFormatMessage(message);
            return;
        }

        if (message.type === 'videoStagePreload') {
            const job = videoOverlay.getJobId();
            const stage = videoOverlay.getStage();
            const conflictingJob = job && job !== message.jobId && !['ready', 'cancelled', 'error'].includes(stage);
            const sameJobWrongStage = job === message.jobId && stage !== 'download';
            if (conflictingJob || sameJobWrongStage) return;

            videoOverlay.show(
                true,
                message.jobId || null,
                message.videoBytes || message.mediaBytes || 0,
                message.audioBytes || 0
            );
            return;
        }

        handleVideoStageMessage(message);
    }

    function initMessaging() {
        chrome.runtime.onMessage.addListener(message => {
            if (window.top !== window.self) return;
            handleVideoMessage(message);
        });
    }

    function init() {
        quality.init();
        bridge.init();
        installVideoMenuClickGuard();
        installDriveFileMenuRestore();
        installStreamStorageListener();
        initMessaging();
    }

    app.video = {
        updateMenuState: updateVideoMenuState,
        normalizeQualityMenuItem,
        addProtectedVideoMenuItem,
        isVideoViewerOpen: core.isVideoViewerOpen,
        scanViewerState,
        scanMenu,
        init
    };
})();
