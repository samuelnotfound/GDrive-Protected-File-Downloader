
(() => {
    const app = window.__PSD;
    const video = app.videoState;
    const core = app.videoCore;
    const { sleep, waitUntil } = window.__PSD_CONTENT_UTILS;
    const VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;

    const SCAN_VEIL_TEXT = 'Finding available video qualities…';
    let qualityPickerObserver = null;
    let qualityPickerWatchTimer = null;
    let qualityPickerMounting = false;
    let qualityPickerRehydrating = false;
    let qualityPickerRestorePromise = null;

    function getDisplayVideoFormats(formats = []) {
        const map = new Map();

        for (const format of Array.isArray(formats) ? formats : []) {
            if (!format?.url) continue;

            const height = Number(format.height) || 0;
            const fps = Number(format.fps) || 0;
            const key = height
                ? `${height}p|${fps >= 50 ? 'highfps' : 'normal'}`
                : `${Number(format.width) || 0}x${height}`;

            const score = item =>
                (/video\/mp4/i.test(String(item.mime || '')) ? 1_000_000_000 : 0) +
                Number(item.contentLength || 0) +
                Number(item.capturedAt || 0) / 1e9;

            const current = map.get(key);
            if (!current || score(format) > score(current)) map.set(key, format);
        }

        return [...map.values()].sort((a, b) =>
            (Number(b.height || 0) - Number(a.height || 0)) ||
            (Number(b.fps || 0) - Number(a.fps || 0)) ||
            (Number(b.contentLength || 0) - Number(a.contentLength || 0))
        );
    }

    const formatVideoLabel = format => {
        const height = Number(format?.height) || 0;
        const width = Number(format?.width) || 0;
        return height ? `${height}p` : (width ? `${width}px` : 'Video');
    };

    function ensureScanPageBlocker() {
        let root = document.getElementById('psd-video-scan-blocker');
        if (root) return root;

        root = document.createElement('div');
        root.id = 'psd-video-scan-blocker';
        root.setAttribute('role', 'group');
        root.innerHTML = `
            <style>
                #psd-video-scan-blocker{position:fixed !important;left:0 !important;right:0 !important;top:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;outline:0 !important;background:#1b1b1b !important;color:transparent !important;overflow:hidden !important;box-sizing:border-box !important;z-index:2147483646 !important;pointer-events:none !important;display:none !important;cursor:default !important;user-select:none !important;}
                #psd-video-scan-blocker[data-open="true"]{pointer-events:auto !important;cursor:default !important;display:block !important;}
                #psd-video-scan-blocker .psd-scan-status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;min-width:0;max-width:min(460px,calc(100vw - 48px));box-sizing:border-box;padding:0;color:#fff;text-align:center;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.7);}
                #psd-video-scan-blocker .psd-scan-text{font:500 17px/1.35 'Google Sans',Roboto,Arial,sans-serif;letter-spacing:.1px;}
                #psd-video-scan-blocker .psd-scan-hint{font:400 13px/1.4 Roboto,Arial,sans-serif;color:rgba(255,255,255,.72);}
            </style>
            <div class="psd-scan-status" aria-live="polite"><span class="psd-scan-text">${SCAN_VEIL_TEXT}</span><span class="psd-scan-hint">This only takes a moment</span></div>`;
        document.documentElement.appendChild(root);
        return root;
    }

    function showPageBlocker(message = SCAN_VEIL_TEXT) {
        if (window.top !== window.self) return;

        const blocker = ensureScanPageBlocker();
        blocker.querySelector('.psd-scan-text').textContent = message;
        blocker.dataset.open = 'true';
    }

    function hidePageBlocker() {
        const blocker = document.getElementById('psd-video-scan-blocker');
        if (blocker) delete blocker.dataset.open;
    }

    function installInteractionShield() {
        if (window.__PSD_QUALITY_PICKER_INTERACTION_SHIELD) return;
        window.__PSD_QUALITY_PICKER_INTERACTION_SHIELD = true;

        const blockPickerEvent = event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;

            event.stopImmediatePropagation();
            if (event.type === 'click' && event.target?.closest?.('#psd-video-quality-download')) {
                event.preventDefault();
                void downloadFromPicker();
            }
        };

        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown']) {
            window.addEventListener(type, blockPickerEvent, true);
        }
    }

    function syncQualityPickerTypography(item) {
        const root = document.getElementById('psd-video-quality-picker');
        if (!root || !item) return;

        const apply = (element, size, weight, line) => {
            if (!element) return;
            element.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
            element.style.setProperty('font-size', size, 'important');
            element.style.setProperty('font-weight', weight, 'important');
            element.style.setProperty('line-height', line, 'important');
            element.style.setProperty('letter-spacing', 'normal', 'important');
        };

        apply(root.querySelector('label'), '14px', '400', '20px');
        apply(root.querySelector('#psd-video-quality-video'), '14px', '400', '20px');
        apply(root.querySelector('#psd-video-quality-download'), '14px', '500', '20px');
        root.querySelectorAll('#psd-video-quality-video option').forEach(option =>
            apply(option, '14px', '400', '20px')
        );

        const status = root.querySelector('#psd-video-quality-status');
        if (status) {
            status.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
            status.style.setProperty('font-size', '11px', 'important');
            status.style.setProperty('line-height', '14px', 'important');
            status.style.setProperty('font-weight', '400', 'important');
        }
    }

    const QUALITY_PICKER_TEMPLATE = `
            <style>
                #psd-video-quality-picker{display:none;box-sizing:border-box;width:100%;margin:10px 0 2px;padding:0;font:14px/20px Roboto,Arial,sans-serif;color:inherit;background:transparent;border:0;border-radius:0;box-shadow:none;position:relative;z-index:3;pointer-events:auto;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;}
                #psd-video-quality-picker .psd-quality-row{display:flex;align-items:stretch;gap:8px;width:100%;}
                #psd-video-quality-picker .psd-quality-field{flex:1 1 0;min-width:0;margin:0;padding:0;}
                #psd-video-quality-picker .psd-quality-select-wrap{position:relative;pointer-events:auto;height:36px;}
                #psd-video-quality-picker select{display:block;position:relative;z-index:4;width:100% !important;height:36px !important;min-height:36px !important;max-height:36px !important;box-sizing:border-box;appearance:none;-webkit-appearance:none;color-scheme:dark;background-color:#303134;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path fill='%23a8c7fa' d='M7 10l5 5 5-5z'/></svg>");background-repeat:no-repeat;background-position:right 6px center;background-size:24px 24px;color:inherit;border:1px solid #6f7376;border-radius:8px;padding:0 32px 0 12px !important;font-family:Roboto,Arial,sans-serif !important;font-size:14px !important;font-weight:400 !important;line-height:20px !important;letter-spacing:normal !important;outline:none;cursor:pointer;box-shadow:none;transition:background-color .12s ease,border-color .12s ease;}
                #psd-video-quality-picker select option{font-family:Roboto,Arial,sans-serif !important;font-size:14px !important;font-weight:400 !important;line-height:20px !important;background:#303134;color:#fff;}
                #psd-video-quality-picker select:hover{background-color:#35363a;border-color:#9aa0a6;}
                #psd-video-quality-picker select:focus{border-color:#a8c7fa;box-shadow:0 0 0 1px #a8c7fa;}
                #psd-video-quality-picker select:disabled{opacity:.7;cursor:default;}
                #psd-video-quality-status{margin:6px 0 0;padding:0 2px;font:inherit;font-size:11px !important;line-height:14px !important;font-weight:400 !important;color:rgba(255,255,255,.62);white-space:normal;}
                #psd-video-quality-status:empty{display:none;}
                #psd-video-quality-actions{display:flex;flex:0 0 auto;align-items:stretch;position:relative;z-index:4;pointer-events:auto;}
                #psd-video-quality-actions button{display:inline-flex;align-items:center;justify-content:center;position:relative;z-index:5;border:0;outline:none;box-sizing:border-box;width:96px !important;min-height:36px !important;height:36px !important;border-radius:8px;padding:0 12px;background:#a8c7fa;color:#062e6f;font-family:Roboto,Arial,sans-serif !important;font-size:14px !important;font-weight:500 !important;line-height:20px !important;letter-spacing:.1px !important;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,box-shadow .12s ease,transform .06s ease;}
                #psd-video-quality-actions button:hover{background:#c2d7fb;box-shadow:0 1px 3px rgba(0,0,0,.35);}
                #psd-video-quality-actions button:active{transform:translateY(1px);}
                #psd-video-quality-actions button:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px;}
                #psd-video-quality-download:disabled{opacity:.5;cursor:default;transform:none;box-shadow:none;}
            </style>
            <div class="psd-quality-row">
                <div class="psd-quality-field">
                    <div class="psd-quality-select-wrap"><select id="psd-video-quality-video" aria-label="Video quality"></select></div>
                </div>
                <div id="psd-video-quality-actions">
                    <button id="psd-video-quality-download" type="button">Download</button>
                </div>
            </div>
            <div id="psd-video-quality-status"></div>`;

    function bindQualityPickerEvents(root) {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            root.addEventListener(type, event => event.stopPropagation(), true);
        }
        root.addEventListener('keydown', event => {
            if (event.target?.matches?.('select')) event.stopPropagation();
        }, true);

        root.querySelector('#psd-video-quality-download').onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            downloadFromPicker();
        };
        root.querySelector('#psd-video-quality-video').onchange = updatePickerState;
    }

    function ensureQualityPicker() {
        let root = document.getElementById('psd-video-quality-picker');
        if (root) return root;

        root = document.createElement('div');
        root.id = 'psd-video-quality-picker';
        root.setAttribute('role', 'group');
        root.innerHTML = QUALITY_PICKER_TEMPLATE;
        bindQualityPickerEvents(root);
        installInteractionShield();
        document.body.appendChild(root);
        return root;
    }

    function getVisibleDriveMenu() {
        const visible = app.ui.getVisibleFileMenus();
        return visible.find(menu =>
            menu.querySelector('#' + VIDEO_MENU_ID) ||
            [...menu.querySelectorAll('[role="menuitem"],li,[data-tooltip]')].some(element =>
                /^(share|security limitations|details|add to starred)$/i.test(
                    String(element.textContent || '').replace(/\s+/g, ' ').trim()
                )
            )
        ) || visible[0] || null;
    }

    async function waitForDriveFileMenuClosed(timeoutMs = 1800) {
        return waitUntil(() => {
            const button = app.ui.getDriveFileButton();
            const expanded = String(button?.getAttribute('aria-expanded') || '').toLowerCase();
            return !getVisibleDriveMenu() && expanded !== 'true';
        }, Math.max(250, Number(timeoutMs) || 1800), 20);
    }

    async function reopenDriveFileMenu() {
        const existing = getVisibleDriveMenu();
        if (existing) return existing;

        const button = app.ui.getDriveFileButton();
        if (!button) return null;

        try { button.click(); } catch (_) { return null; }
        return waitUntil(() => getVisibleDriveMenu(), 1100, 35);
    }

    function isMountedInVisibleDriveMenu(root = document.getElementById('psd-video-quality-picker')) {
        if (!root || !root.parentElement) return false;

        const menu = root.parentElement.closest?.('[role="menu"]');
        if (!menu) return false;

        const rect = menu.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;

        const style = getComputedStyle(menu);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

        const item = menu.querySelector('#' + VIDEO_MENU_ID);
        return !!item && (root.parentElement === item || item.contains(root));
    }

    function stopWatch() {
        if (qualityPickerObserver) {
            try { qualityPickerObserver.disconnect(); } catch (_) {}
            qualityPickerObserver = null;
        }
        if (qualityPickerWatchTimer) {
            clearTimeout(qualityPickerWatchTimer);
            qualityPickerWatchTimer = null;
        }
    }

    function queueWatch(delay = 0) {
        if (video.operation !== 'picker' || qualityPickerWatchTimer) return;

        qualityPickerWatchTimer = setTimeout(() => {
            qualityPickerWatchTimer = null;
            ensureQualityPickerMounted({ reopenIfMissing: false }).catch(() => {});
        }, delay);
    }

    async function mountQualityPicker(root, menu) {
        if (video.operation !== 'picker') return false;

        const liveMenu = getVisibleDriveMenu() || menu;
        if (!liveMenu) return false;

        let item = liveMenu.querySelector('#' + VIDEO_MENU_ID);
        if (!item) {
            try { await app.video?.addProtectedVideoMenuItem(liveMenu); } catch (_) {}
            item = liveMenu.querySelector('#' + VIDEO_MENU_ID);
        }
        if (!item?.parentNode || !liveMenu.contains(item)) return false;

        const label = item.querySelector('.psd-video-menu-label');
        const contentHost = label?.parentElement || item;
        if (root.parentNode !== contentHost) contentHost.appendChild(root);

        app.video?.normalizeQualityMenuItem(item);
        item.style.setProperty('align-items', 'flex-start', 'important');
        item.querySelectorAll('.aqdrmf-rymPhb-KkROqb').forEach(host => {
            host.style.setProperty('align-self', 'flex-start', 'important');
            host.style.setProperty('margin-top', '3px', 'important');
        });

        root.style.display = 'block';
        app.video?.updateMenuState();
        return true;
    }

    async function ensureQualityPickerMounted({ reopenIfMissing = false } = {}) {
        if (video.operation !== 'picker' || qualityPickerMounting) return false;

        const root = ensureQualityPicker();
        if (isMountedInVisibleDriveMenu(root)) {
            root.style.display = 'block';
            return true;
        }

        qualityPickerMounting = true;
        try {
            let menu = getVisibleDriveMenu();
            if (!menu && reopenIfMissing) menu = await reopenDriveFileMenu();
            return menu ? await waitUntil(() => mountQualityPicker(root, menu), 900, 25) : false;
        } finally {
            qualityPickerMounting = false;
        }
    }

    function startWatch() {
        stopWatch();
        if (video.operation !== 'picker') return;

        qualityPickerObserver = new MutationObserver(() => {
            if (video.operation !== 'picker') return;

            const liveRoot = document.getElementById('psd-video-quality-picker');
            if (getVisibleDriveMenu() && !isMountedInVisibleDriveMenu(liveRoot)) {
                queueWatch();
                return;
            }
            if (!video.pickerFormats || qualityPickerRehydrating || !isMountedInVisibleDriveMenu(liveRoot)) return;

            const select = liveRoot.querySelector('#psd-video-quality-video');
            if (!select || select.options.length) return;

            qualityPickerRehydrating = true;
            try { updatePickerState(); }
            finally {
                queueMicrotask(() => { qualityPickerRehydrating = false; });
            }
        });

        try {
            qualityPickerObserver.observe(document.body, { childList: true, subtree: true });
        } catch (_) {
            qualityPickerObserver = null;
            return;
        }

        queueWatch();
    }

    async function clearSnapshot(fileId = video.fileId) {
        const id = String(fileId || '').trim();
        if (id) {
            try { await core.sendRuntime({ action: 'clearQualityPickerSnapshot', fileId: id }); }
            catch (_) {}
        }
        video.pickerFormats = null;
        video.scanCache = null;
    }

    function close(clearSnapshot = false) {
        stopWatch();

        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';

        video.operation = 'idle';
        video.restorePickerOnFileMenuOpen = !clearSnapshot;
        hidePageBlocker();

        if (clearSnapshot) void clearSnapshot();
        app.video?.updateMenuState();
    }

    function populateSelect(select, formats, labeler, emptyText) {
        const previousValue = select.value;
        const previousText = select.selectedOptions?.[0]?.textContent || '';

        select.replaceChildren();

        if (!Array.isArray(formats) || !formats.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = emptyText;
            option.disabled = true;
            option.selected = true;
            select.appendChild(option);
            select.disabled = true;
            return;
        }

        select.disabled = false;
        formats.forEach((format, index) => {
            const option = document.createElement('option');
            option.value = format.id || String(index);
            option.textContent = labeler(format);
            select.appendChild(option);
        });

        const options = [...select.options];
        const byValue = options.findIndex(option => previousValue && option.value === previousValue);
        const byText = byValue >= 0
            ? byValue
            : options.findIndex(option => previousText && option.textContent === previousText);

        select.selectedIndex = byText >= 0 ? byText : 0;
    }

    function updatePickerState() {
        const root = ensureQualityPicker();
        const videoSelect = root.querySelector('#psd-video-quality-video');
        const download = root.querySelector('#psd-video-quality-download');
        const status = root.querySelector('#psd-video-quality-status');

        const pickerFormats =
            video.operation === 'picker' && video.pickerFormats
                ? video.pickerFormats
                : video.formats;

        const hasProgressive = Array.isArray(pickerFormats?.progressive) && pickerFormats.progressive.length;
        const hasAdaptiveVideo = Array.isArray(pickerFormats?.video) && pickerFormats.video.length;
        const hasAudio = Array.isArray(pickerFormats?.audio) && pickerFormats.audio.some(item => item?.url);

        const formatsForSelect = !hasAdaptiveVideo && hasProgressive
            ? pickerFormats.progressive
            : pickerFormats?.video;
        const emptyText = !hasAdaptiveVideo && hasProgressive
            ? 'No video format detected'
            : 'No adaptive video format detected';

        populateSelect(videoSelect, getDisplayVideoFormats(formatsForSelect), formatVideoLabel, emptyText);

        const valid = !!(videoSelect.value && (hasProgressive || (hasAdaptiveVideo && hasAudio)));
        download.disabled = !valid;
        status.textContent = valid ? '' : 'Waiting for a usable Drive stream…';

        const mountedItem = root.closest?.('#' + VIDEO_MENU_ID);
        if (mountedItem) syncQualityPickerTypography(mountedItem);
    }

    function resetScanUI() {
        stopWatch();

        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';

        video.operation = 'idle';
        hidePageBlocker();
        app.video?.updateMenuState();
    }

    function describeScanReport(report, fallback) {
        const missed = (Array.isArray(report) ? report : [])
            .filter(item => item && !item.captured)
            .map(item => `${item.height}p`);

        return missed.length
            ? `${fallback ? fallback + ' ' : ''}Could not capture ${missed.join(', ')}. open Download again to retry.`.trim()
            : fallback;
    }

    function prepareQualityPicker(formats, message) {
        video.formats = formats || { video: [], audio: [], progressive: [] };
        video.pickerFormats = core.cloneFormats(video.formats);
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: new Set([
                ...video.pickerFormats.video,
                ...video.pickerFormats.progressive
            ].map(format => Number(format.height) || 0).filter(Boolean)).size,
            note: message || ''
        };
    }

    async function mountPickerAfterScan() {
        await waitForDriveFileMenuClosed(700);
        const menu = await reopenDriveFileMenu();
        if (!menu) throw new Error('Drive File menu did not reopen after quality detection.');

        const ready = await waitUntil(async () => {
            const mounted = await ensureQualityPickerMounted({ reopenIfMissing: false });
            if (!mounted) return false;
            updatePickerState();

            const liveRoot = document.getElementById('psd-video-quality-picker');
            return (liveRoot?.querySelector('#psd-video-quality-video')?.options?.length || 0) > 0;
        }, 700, 25);

        if (!ready) throw new Error('Quality picker could not be mounted into the reopened File menu.');
        document.querySelectorAll('#' + VIDEO_MENU_ID).forEach(app.video?.normalizeQualityMenuItem);
        updatePickerState();
        startWatch();
    }

    async function showQualityPicker(formats, message = '') {
        prepareQualityPicker(formats, message);
        await core.saveQualitySnapshot();

        const root = ensureQualityPicker();
        const status = root.querySelector('#psd-video-quality-status');
        root.style.display = 'none';
        video.operation = 'picker';
        video.restorePickerOnFileMenuOpen = true;
        hidePageBlocker();
        updatePickerState();
        if (message) status.textContent = message;
        app.video?.updateMenuState();

        try {
            await mountPickerAfterScan();
            return true;
        } catch (_) {
            video.operation = 'idle';
            hidePageBlocker();
            app.video?.updateMenuState();
            return false;
        }
    }

    function getPickerDownloadRequest(root) {
        const videoId = root.querySelector('#psd-video-quality-video').value;
        const pickerFormats = video.pickerFormats && video.operation === 'picker'
            ? video.pickerFormats
            : video.formats;
        return pickerFormats?.video?.length
            ? { videoFormatId: videoId }
            : { progressiveFormatId: videoId };
    }

    function beginVideoDownload(root, response) {
        root.style.display = 'none';
        video.restorePickerOnFileMenuOpen = false;
        video.operation = 'staging';
        clearSnapshot();
        try { app.ui.closeDriveFileMenu(); } catch (_) {}
        hidePageBlocker();

        videoOverlay.show(
            true,
            response.jobId || null,
            response.videoBytes || response.mediaBytes || 0,
            response.audioBytes || 0
        );
        app.video?.updateMenuState();
    }

    async function downloadFromPicker() {
        core.muteMediaImmediately();

        const root = ensureQualityPicker();
        const request = getPickerDownloadRequest(root);
        const button = root.querySelector('#psd-video-quality-download');
        const status = root.querySelector('#psd-video-quality-status');
        button.disabled = true;
        status.textContent = 'Starting download…';

        const response = await core.sendDownload(request);
        if (!response?.success) {
            button.disabled = false;
            status.textContent = response?.error || 'Could not start the download.';
            video.operation = 'picker';
            app.video?.updateMenuState();
            return;
        }

        beginVideoDownload(root, response);
    }

    async function ensureCached(fileId) {
        if (core.hasUsableFormats(video.pickerFormats)) return true;

        const id = String(fileId || '').trim();
        if (!id) return false;

        if (!qualityPickerRestorePromise) {
            qualityPickerRestorePromise = (async () => {
                try {
                    if (core.hasUsableFormats(video.pickerFormats)) return true;
                    return await core.restoreQualitySnapshot(id);
                } finally {
                    qualityPickerRestorePromise = null;
                }
            })();
        }

        try { return !!(await qualityPickerRestorePromise); }
        catch (_) { return false; }
    }

    async function remountCached() {
        if (!video.restorePickerOnFileMenuOpen || !getVisibleDriveMenu() || video.operation === 'picker') return false;

        const context = core.getCurrentDriveFileContext();
        const fileId = String(video.fileId || context.fileId || '').trim();
        const restored = await ensureCached(fileId);

        if (!restored || !core.hasUsableFormats(video.pickerFormats)) return false;

        video.operation = 'picker';
        video.formats = core.cloneFormats(video.pickerFormats);
        app.video?.updateMenuState();
        updatePickerState();

        const mounted = await ensureQualityPickerMounted({ reopenIfMissing: false });
        if (mounted) startWatch();
        return mounted;
    }

    function installDismissListener() {
        if (window.__PSD_VIDEO_QUALITY_MENU_DISMISS) return;
        window.__PSD_VIDEO_QUALITY_MENU_DISMISS = true;

        document.addEventListener('pointerdown', event => {
            if (video.operation !== 'picker') return;

            const target = event.target;
            if (target?.closest?.('#psd-video-quality-picker')) return;
            if (target?.closest?.('#' + VIDEO_MENU_ID)) return;

            close();
        }, true);
    }

    function init() {
        installDismissListener();
    }

    app.videoQuality = {
        init,
        getVisibleDriveMenu,
        waitForDriveFileMenuClosed,
        showPageBlocker,
        hidePageBlocker,
        resetScanUI,
        describeScanReport,
        show: showQualityPicker,
        download: downloadFromPicker,
        update: updatePickerState,
        startWatch,
        stopWatch,
        clearSnapshot,
        ensureCached,
        remountCached,
        ensureQualityPickerMounted,
        syncTypography: syncQualityPickerTypography,
        normalizeMenuItem: item => app.video?.normalizeQualityMenuItem?.(item),
        mountQualityPicker,
        getDisplayVideoFormats
    };
})();
