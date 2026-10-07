(() => {
    if (!window.__PSD_LOADED || window.__PSD_VIDEO_LOADED) return;
    window.__PSD_VIDEO_LOADED = true;

    const app = window.__PSD;
    const video = app.videoState;
    const VIDEO_MENU_ID = app.ids.videoMenu;
    const VIDEO_CONTROLS_ID = 'psd-protected-video-controls';
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
        const downloadBusy = video.operation === 'staging' || !!videoOverlay.getJobId?.();
        const ready = isPlaybackReadyForDownload();
        // Picker/scanning stay interactive once opened; idle Download requires playback.
        const blocked = downloadBusy
            || video.operation === 'scanning'
            || (video.operation === 'idle' && !ready);

        let labelText = 'Download';
        let infoText = 'GDrive Protected File Downloader';
        if (downloadBusy) {
            labelText = 'Downloading…';
        } else if (video.operation === 'picker') {
            labelText = 'Choose video quality';
        } else if (video.operation === 'scanning') {
            labelText = 'Reading qualities…';
        } else if (!ready) {
            labelText = 'Download';
            infoText = 'Play a video first to enable download.';
        }

        document.querySelectorAll('#' + VIDEO_MENU_ID).forEach(item => {
            normalizeQualityMenuItem(item);

            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            if (label) label.textContent = labelText;
            if (info) info.textContent = infoText;

            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = hasFormats ? 'true' : 'false';
            item.dataset.playbackReady = ready ? 'true' : 'false';

            if (blocked) {
                item.setAttribute('aria-disabled', 'true');
                item.setAttribute('disabled', 'true');
                item.style.cursor = 'default';
                item.style.opacity = '0.5';
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
        const label = app.ui.findPrimaryLabel(item);
        if (label) {
            label.classList.add('psd-video-menu-label');
            label.textContent = 'Download';
            label.style.visibility = 'visible';
        }
        app.ui.addMenuDescription(item, 'psd-video-menu-label', 'psd-video-menu-info', 'GDrive Protected File Downloader');
        app.ui.setDownloadMenuItemIcon(item);
        // Icon host was hidden with Share's non-label chrome — show it again.
        item.querySelectorAll('svg, img, [aria-hidden="true"]').forEach(el => {
            el.style.visibility = 'visible';
            let p = el.parentElement;
            while (p && p !== item) {
                p.style.visibility = 'visible';
                p = p.parentElement;
            }
        });
        const info = item.querySelector('.psd-video-menu-info');
        if (info) {
            info.style.visibility = 'visible';
            let p = info.parentElement;
            while (p && p !== item) {
                p.style.visibility = 'visible';
                p = p.parentElement;
            }
        }
        app.ui.styleDownloadMenuItem(item, '1');
        app.ui.handleMenuKeyboardActivation(item, event => {
            event.preventDefault();
            event.stopPropagation();
            item.click();
        });
    }

    // Find Share by visible own-text (reference style) — never jsname.
    function findShareInMenu(menu) {
        return app.ui.findShareRow(menu) || app.ui.findMenuRow(menu, 'Share');
    }

    // Align control block text with Share's label (from menu+quality reference).
    function alignVideoControls(shareRow, shareLabel, labelRow, controlBlock) {
        if (!labelRow?.isConnected || !controlBlock?.isConnected || !shareLabel) return;
        const box = shareRow.getBoundingClientRect();
        if (!box.width) return;
        const scale = (shareRow.offsetWidth ? box.width / shareRow.offsetWidth : 1) || 1;
        try {
            const range = document.createRange();
            range.selectNodeContents(shareLabel);
            const textLeft = range.getBoundingClientRect().left;
            const dx = (textLeft - controlBlock.getBoundingClientRect().left) / scale;
            if (dx >= 8 && dx <= 160) {
                controlBlock.style.paddingLeft = `${Math.round(dx)}px`;
            }
        } catch (_) {}
    }

    function makeVideoControlBlock(shareLabel) {
        const style = shareLabel ? getComputedStyle(shareLabel) : null;
        const block = document.createElement('div');
        block.id = VIDEO_CONTROLS_ID;
        block.setAttribute('data-psd', '');
        block.setAttribute('data-psd-menu', 'controls');
        Object.assign(block.style, {
            display: 'block',
            padding: '2px 16px 10px 56px',
            color: style?.color || 'inherit',
            fontFamily: style?.fontFamily || 'inherit',
            fontSize: '13px',
            cursor: 'default',
            boxSizing: 'border-box'
        });
        return block;
    }

    function addProtectedVideoMenuItem(menu) {
        if (menu.querySelector(`#${VIDEO_MENU_ID}`)) return true;

        // Only inject into protected (view-only) menus: has "Security limitations", no native Download/Print.
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        if (!securityRow) return false;
        if (app.ui.findMenuRow(menu, 'Print') || app.ui.findMenuRow(menu, 'Download')) return false;

        const shareRow = findShareInMenu(menu);
        const templateRow = shareRow ||
            app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') ||
            securityRow;
        if (!templateRow) return false;

        // 1) Label row — inert clone of Share (reference: makeLabelRow).
        const item = app.ui.makeStandaloneMenuRow(templateRow, VIDEO_MENU_ID, 'Download');
        if (!item) return false;
        item.setAttribute('data-psd', '');
        item.setAttribute('data-psd-menu', 'download');
        item.removeAttribute('aria-haspopup');
        item.removeAttribute('aria-expanded');
        configureVideoMenuItem(item);

        // 2) Control block — sibling under the label (reference: makeControlRow / makeBlock).
        const shareLabel =
            (shareRow && (app.ui.findLabel(shareRow, 'Share') || app.ui.findPrimaryLabel(shareRow))) ||
            app.ui.findPrimaryLabel(templateRow);
        const controls = makeVideoControlBlock(shareLabel);

        // Insert after Share: label row + controls (reference: item.after(...rows)).
        const anchor = shareRow || securityRow;
        if (typeof anchor.after === 'function') {
            anchor.after(item, controls);
        } else if (anchor.parentNode) {
            anchor.parentNode.insertBefore(item, anchor.nextSibling);
            item.parentNode.insertBefore(controls, item.nextSibling);
        } else {
            return false;
        }

        const place = () => alignVideoControls(shareRow || item, shareLabel, item, controls);
        place();
        setTimeout(place, 300);
        return true;
    }

    function scanMenu(menu) {
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        if (!securityRow) return;
        if (app.ui.findMenuRow(menu, 'Print') || app.ui.findMenuRow(menu, 'Download')) return;
        addProtectedVideoMenuItem(menu);
    }








    function isDriveVideoPlayingNow() {
        try {
            const videos = core.collectVideoElements?.() || [...document.querySelectorAll('video')];
            for (const v of videos) {
                try {
                    if (!v || v.ended) continue;
                    // Actively playing
                    if (!v.paused && (v.currentTime > 0.05 || v.readyState >= 2)) return true;
                    // Buffering after user hit play
                    if (!v.paused && v.readyState >= 1) return true;
                } catch (_) {}
            }
        } catch (_) {}
        return false;
    }

    /** Download is allowed only when a real playback signal exists. */
    function isPlaybackReadyForDownload() {
        if (isDriveVideoPlayingNow()) return true;
        // Network recently saw videoplayback for this tab (set by videoStreamDetected).
        if (video.streamActivityAt && (Date.now() - Number(video.streamActivityAt)) < 120000) {
            return true;
        }
        return false;
    }

    function optionsFromPlaybackApi() {
        const heights = Array.isArray(video.playbackQualityHeights) ? video.playbackQualityHeights : [];
        if (!heights.length) return [];
        return heights.map(h => ({
            height: Number(h) || 0,
            label: `${Number(h)}p`,
            selected: false,
            source: 'playback-api'
        })).filter(o => o.height);
    }

    function applyQualityOptions(options, note) {
        const formats = {
            video: options.map(o => ({
                id: `label:${o.height}`,
                height: Number(o.height) || 0,
                qualityHeight: Number(o.height) || 0,
                probeQuality: o.label || `${o.height}p`,
                menuLabel: o.label || `${o.height}p`,
                labelOnly: true,
                url: ''
            })),
            audio: [],
            progressive: []
        };
        video.qualityMenuOptions = options;
        video.pickerFormats = formats;
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: options.length,
            note: note || `Found ${options.length} quality option(s). Select one, then Download.`,
            menuOptions: options.slice()
        };
        return formats;
    }

    async function runQualityDetection() {
        if (video.operation === 'scanning') return;

        if (!isPlaybackReadyForDownload()) {
            updateVideoMenuState();
            return;
        }

        video.operation = 'scanning';
        updateVideoMenuState();

        app.ui.closeDriveFileMenu();
        await quality.waitForDriveFileMenuClosed(1000);

        try {
            const context = await core.syncViewerContext(true);
            if (!context?.fileId) throw new Error('Could not identify the current Drive video.');

            // 1) Prefer heights from the intercepted /playback API (prototype approach).
            //    Available as soon as the video has played; no Settings→Quality DOM needed.
            const fromApi = optionsFromPlaybackApi();
            if (fromApi.length) {
                const formats = applyQualityOptions(
                    fromApi,
                    `Found ${fromApi.length} quality option(s) from player. Select one, then Download.`
                );
                await quality.show(
                    formats,
                    `Found ${fromApi.length} quality option(s). Select one, then Download.`,
                    fromApi
                );
                return;
            }

            // 2) Fallback: open Settings → Quality and scan menu labels.
            const response = await core.sendRuntime({
                action: 'listPlayerQualityLabels',
                fileId: video.fileId
            });

            const options = Array.isArray(response?.options) ? response.options : [];
            if (response?.success && options.length) {
                const formats = applyQualityOptions(
                    options,
                    `Found ${options.length} quality option(s). Select one, then Download.`
                );
                await quality.show(
                    formats,
                    `Found ${options.length} quality option(s). Select one, then Download.`,
                    options
                );
                return;
            }

            video.operation = 'picker';
            updateVideoMenuState();
            await quality.show(
                { video: [], audio: [], progressive: [] },
                response?.error
                    || 'Could not read quality options from the player. Keep the video playing and try Download again.',
                []
            );
            return;
        } catch (error) {
            try {
                video.operation = 'picker';
                await quality.show(
                    { video: [], audio: [], progressive: [] },
                    error?.message || 'Quality detection failed. Try again while the video is playing.',
                    []
                );
                return;
            } catch (_) {}
        }

        quality.resetScanUI();
    }

    async function startVideoFromMenu() {
        if (video.operation === 'staging' || video.operation === 'scanning' || videoOverlay.getJobId?.()) return;
        if (video.operation !== 'idle') return;

        // Hard gate: Download only runs after real playback / stream activity.
        if (!isPlaybackReadyForDownload()) {
            updateVideoMenuState();
            return;
        }
        video.playbackStarted = true;

        // Only skip the label scan if we already listed player quality rows this session.
        // Having a current stream URL alone is NOT enough — that is the bug that
        // skipped probing and only offered the playing quality.
        const menuOpts = Array.isArray(video.qualityMenuOptions) ? video.qualityMenuOptions : [];
        if (menuOpts.length > 0) {
            app.ui.closeDriveFileMenu();
            video.operation = 'picker';
            const formats = video.pickerFormats || {
                video: menuOpts.map(o => ({
                    id: `label:${o.height}`,
                    height: o.height,
                    qualityHeight: o.height,
                    probeQuality: o.label || o.text || `${o.height}p`,
                    menuLabel: o.label || o.text || `${o.height}p`,
                    labelOnly: true,
                    url: ''
                })),
                audio: (video.formats?.audio || []).slice(0, 1),
                progressive: []
            };
            await quality.show(
                formats,
                video.scanCache?.note || `Found ${menuOpts.length} quality option(s). Select one, then Download.`,
                menuOpts
            );
            return;
        }

        // Always list ARIA quality labels from the player (Settings → Quality → scan).
        await runQualityDetection();
    }

    function installPlaybackUnlockWatch() {
        if (window.__PSD_PLAYBACK_UNLOCK_WATCH) return;
        window.__PSD_PLAYBACK_UNLOCK_WATCH = true;

        const markPlaying = () => {
            video.playbackStarted = true;
            video.streamActivityAt = Date.now();
            updateVideoMenuState();
        };

        const attachToVideos = () => {
            const videos = core.collectVideoElements?.() || [...document.querySelectorAll('video')];
            for (const v of videos) {
                if (v.__psdPlayWatch) continue;
                v.__psdPlayWatch = true;
                for (const ev of ['play', 'playing', 'timeupdate', 'loadeddata']) {
                    v.addEventListener(ev, () => {
                        try {
                            if (!v.paused && !v.ended) markPlaying();
                        } catch (_) {}
                    }, { passive: true });
                }
            }
        };

        attachToVideos();
        // Drive rebuilds the player — reattach periodically.
        setInterval(attachToVideos, 2000);
        // Refresh menu enabled state from live player + recent streams.
        setInterval(() => {
            if (video.operation !== 'idle') return;
            updateVideoMenuState();
        }, 800);

        // Soft check background for recent videoplayback without probing qualities.
        setInterval(async () => {
            if (video.operation !== 'idle') return;
            if (isPlaybackReadyForDownload()) {
                updateVideoMenuState();
                return;
            }
            try {
                const response = await core.sendRuntime({ action: 'getStreams' });
                const session = response?.streams;
                const hasVideo = !!(
                    session?.video
                    || response?.globalVideo?.url
                    || (session?.formats?.video || []).some(s => s?.url)
                    || (session?.videoCandidates || []).some(s => s?.url)
                );
                if (hasVideo) {
                    video.playbackStarted = true;
                    video.streamActivityAt = Date.now();
                    updateVideoMenuState();
                }
            } catch (_) {}
        }, 2500);
    }

    function installVideoMenuClickGuard() {
        if (window.__PSD_VIDEO_MENU_CLICK_GUARD) return;
        window.__PSD_VIDEO_MENU_CLICK_GUARD = true;

        // Reference-style: stop Drive from seeing pointer/focus events on our rows
        // so the File menu does not close or swallow our controls.
        const inOurs = n => (n instanceof Element ? n.closest('[data-psd], #' + VIDEO_MENU_ID + ', #psd-video-quality-picker, #psd-video-quality-menu') : null);

        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
            window.addEventListener(type, e => {
                if (!inOurs(e.target)) return;
                e.stopImmediatePropagation();
                if (type === 'mousedown') e.preventDefault();
            }, true);
        }
        for (const type of ['focusin', 'focusout', 'focus', 'blur']) {
            window.addEventListener(type, e => {
                if (inOurs(e.target) || inOurs(e.relatedTarget)) e.stopImmediatePropagation();
            }, true);
        }

        const activate = (item, event) => {
            if (!item || event.target?.closest?.('#psd-video-quality-picker') || video.operation !== 'idle') return;
            if (!isPlaybackReadyForDownload()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                event.stopPropagation();
                updateVideoMenuState();
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            item.dataset.activationInProgress = 'true';
            setTimeout(() => { item.dataset.activationInProgress = 'false'; }, 1800);
            void startVideoFromMenu();
        };

        document.addEventListener('click', event => {
            if (event.target?.closest?.('#psd-video-quality-picker') ||
                event.target?.closest?.('#psd-protected-video-controls')) {
                // Picker buttons handle their own clicks; keep Drive out.
                event.stopImmediatePropagation();
                return;
            }
            const item = event.target?.closest?.('#' + VIDEO_MENU_ID);
            if (item && item.dataset.activationInProgress !== 'true') activate(item, event);
        }, true);
    }

    
    // Fresh page load: drop any in-memory formats and ask background to wipe
    // cached streams for this tab so we never reuse URLs from a previous load.
    (function clearCaptureStateOnPageLoad() {
        if (window.__PSD_CLEAR_ON_LOAD) return;
        window.__PSD_CLEAR_ON_LOAD = true;
        try {
            video.formats = core.cloneFormats({});
            video.pickerFormats = null;
            video.scanCache = null;
            video.restorePickerOnFileMenuOpen = false;
            video.qualityMenuOptions = [];
            video.playbackQualityHeights = [];
            video.playbackQualityLabels = [];
            video.playbackQualityFileId = '';
            video.playbackStarted = false;
        } catch (_) {}
        try {
            chrome.runtime.sendMessage({ action: 'clearTabCaptureState' }, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) {}
    })();

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


    function installLeavePageCancel() {
        if (window.__PSD_LEAVE_PAGE_CANCEL) return;
        window.__PSD_LEAVE_PAGE_CANCEL = true;

        const cancelActive = () => {
            const jobId = videoOverlay?.getJobId?.();
            if (!jobId) return;
            try {
                chrome.runtime.sendMessage({
                    action: 'videoStageMessage',
                    type: 'videoStageCancel',
                    jobId
                });
            } catch (_) {}
        };

        // Tab close / navigate away / reload
        window.addEventListener('pagehide', cancelActive);
        window.addEventListener('beforeunload', cancelActive);
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
            // Apply menu options in the same tick as formats so the picker
            // never renders formats against a stale/empty menu snapshot.
            const menu =
                message.quality?.options ||
                message.qualityOptions ||
                null;
            if (Array.isArray(menu) && menu.length) {
                video.qualityMenuOptions = menu
                    .map(option => ({
                        height: Number(option?.height || 0),
                        label: String(option?.text || option?.label || '').trim(),
                        text: String(option?.text || option?.label || '').trim()
                    }))
                    .filter(option => option.height > 0);
            }
            // Keep label-only picker rows intact; only merge audio onto the picker.
            if ((video.operation === 'picker' || video.pickerFormats) && Array.isArray(video.qualityMenuOptions) && video.qualityMenuOptions.length) {
                const pf = video.pickerFormats || { video: [], audio: [], progressive: [] };
                video.pickerFormats = {
                    video: pf.video?.length ? pf.video : video.qualityMenuOptions.map(o => ({
                        id: `label:${o.height}`,
                        height: o.height,
                        qualityHeight: o.height,
                        probeQuality: o.label || `${o.height}p`,
                        menuLabel: o.label || `${o.height}p`,
                        labelOnly: true,
                        url: ''
                    })),
                    audio: (message.formats?.audio?.length ? message.formats.audio : pf.audio) || [],
                    progressive: pf.progressive || []
                };
            } else if (video.operation === 'picker' || video.pickerFormats) {
                video.pickerFormats = core.cloneFormats(video.formats);
            }
        } else if (message.formats) {
            // Merge so a video-only update never wipes already-captured audio.
            const incoming = message.formats || {};
            const base = video.formats || { video: [], audio: [], progressive: [] };
            video.formats = {
                video: (incoming.video?.length ? incoming.video : base.video) || [],
                audio: (incoming.audio?.length ? incoming.audio : base.audio) || [],
                progressive: (incoming.progressive?.length ? incoming.progressive : base.progressive) || []
            };
            // Never replace label rows with a single live stream during/after download.
            if ((video.operation === 'picker' || video.pickerFormats) && Array.isArray(video.qualityMenuOptions) && video.qualityMenuOptions.length) {
                const pf = video.pickerFormats || { video: [], audio: [], progressive: [] };
                video.pickerFormats = {
                    video: pf.video?.length ? pf.video : video.qualityMenuOptions.map(o => ({
                        id: `label:${o.height}`,
                        height: o.height,
                        qualityHeight: o.height,
                        probeQuality: o.label || `${o.height}p`,
                        menuLabel: o.label || `${o.height}p`,
                        labelOnly: true,
                        url: ''
                    })),
                    audio: (incoming.audio?.length ? incoming.audio : pf.audio) || [],
                    progressive: pf.progressive || []
                };
            } else if (video.operation === 'picker' || video.pickerFormats) {
                const pf = video.pickerFormats || { video: [], audio: [], progressive: [] };
                video.pickerFormats = {
                    video: (incoming.video?.length ? incoming.video : pf.video) || [],
                    audio: (incoming.audio?.length ? incoming.audio : pf.audio) || [],
                    progressive: (incoming.progressive?.length ? incoming.progressive : pf.progressive) || []
                };
            }
        }

        if (message.type === 'videoStreamDetected') {
            video.playbackStarted = true;
            video.streamActivityAt = Date.now();
            updateVideoMenuState();
        }
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
        // Always keep scanned quality labels so the next File → Download can
        // reopen the picker without probing the player again.
        const menuOpts = Array.isArray(video.qualityMenuOptions) ? video.qualityMenuOptions : [];
        if (menuOpts.length) {
            video.restorePickerOnFileMenuOpen = true;
            video.pickerFormats = {
                video: menuOpts.map(o => ({
                    id: `label:${o.height}`,
                    height: Number(o.height) || 0,
                    qualityHeight: Number(o.height) || 0,
                    probeQuality: o.label || o.text || `${o.height}p`,
                    menuLabel: o.label || o.text || `${o.height}p`,
                    labelOnly: true,
                    url: ''
                })),
                audio: (video.formats?.audio || video.pickerFormats?.audio || []).slice(0, 1),
                progressive: []
            };
            void core.saveQualitySnapshot?.();
        } else if (core.hasUsableFormats(video.pickerFormats) || core.hasUsableFormats(video.formats)) {
            video.restorePickerOnFileMenuOpen = true;
            if (!video.pickerFormats && video.formats) {
                video.pickerFormats = core.cloneFormats(video.formats);
            }
        }
        updateVideoMenuState();
        try { quality.update?.(); } catch (_) {}
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
            // Allow a new jobId to take over (slow-start restart creates a fresh job).
            // Only ignore preload when it's the same job already past the download stage.
            const sameJobWrongStage = job === message.jobId && stage !== 'download';
            if (sameJobWrongStage) return;

            videoOverlay.show(
                true,
                message.jobId || null,
                message.videoBytes || message.mediaBytes || 0,
                message.audioBytes || 0,
                video.lastSelectedQuality || ''
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
        installPlaybackUnlockWatch();
        installDriveFileMenuRestore();
        installLeavePageCancel();
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
