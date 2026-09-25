(() => {
    if (!window.__PSD_LOADED || window.__PSD_VIDEO_LOADED) return;
    window.__PSD_VIDEO_LOADED = true;
    const app = window.__PSD;
    const video = app.videoState;
    const PROTECTED_VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;
    if (!videoOverlay) throw new Error('Video overlay module failed to load.');

    function sendRuntime(message) {
        return new Promise(resolve => {
            try {
                chrome.runtime.sendMessage(message, response => {
                    if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
                    else resolve(response || { success: false, error: 'No response.' });
                });
            } catch (error) {
                resolve({ success: false, error: error?.message || String(error) });
            }
        });
    }

    function hasUsableFormats(formats) {
        return !!(formats && (formats.video?.some?.(x => x?.url) || formats.audio?.some?.(x => x?.url) || formats.progressive?.some?.(x => x?.url)));
    }

    async function waitUntil(check, timeoutMs, intervalMs = 25) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const result = await check();
            if (result) return result;
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return await check();
    }

    function cloneFormats(formats = {}) {
        return {
            video: Array.isArray(formats.video) ? formats.video.map(item => ({ ...item })) : [],
            audio: Array.isArray(formats.audio) ? formats.audio.map(item => ({ ...item })) : [],
            progressive: Array.isArray(formats.progressive) ? formats.progressive.map(item => ({ ...item })) : []
        };
    }

    async function saveQualitySnapshot() {
        const fileId = String(video.fileId || '').trim();
        if (!fileId || !video.pickerFormats) return;
        try {
            const snapshot = {
                fileId,
                viewerSessionId: String(video.viewerSessionId || ''),
                formats: cloneFormats(video.pickerFormats),
                savedAt: Date.now()
            };
            await sendRuntime({ action: 'saveQualityPickerSnapshot', fileId, snapshot });
        } catch (_) {}
    }

    async function restoreQualitySnapshot(fileId = video.fileId) {
        const id = String(fileId || '').trim();
        if (!id) return false;
        try {
            const response = await sendRuntime({ action: 'loadQualityPickerSnapshot', fileId: id });
            const snapshot = response?.success ? response.snapshot : null;
            if (!snapshot?.formats || !hasUsableFormats(snapshot.formats)) return false;
            if (snapshot.savedAt && Date.now() - Number(snapshot.savedAt) > 30 * 60 * 1000) return false;
            video.pickerFormats = cloneFormats(snapshot.formats);
            video.formats = cloneFormats(video.pickerFormats);
            video.scanCache = {
                fileId: id,
                at: Number(snapshot.savedAt) || Date.now(),
                heightCount: new Set([...video.pickerFormats.video, ...video.pickerFormats.progressive].map(f => Number(f.height) || 0).filter(Boolean)).size,
                note: ''
            };
            return true;
        } catch (_) {
            return false;
        }
    }


    function isVideoViewerOpen() {
        const viewer = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]');
        const player = document.querySelector('section[aria-label="Video Player"]');
        return !!(viewer && player && viewer.getAttribute('aria-hidden') !== 'true');
    }

    function readActiveItemInfo() {
        const json = document.querySelector('#drive-active-item-info');
        if (!json?.textContent) return null;
        try { return JSON.parse(json.textContent); } catch (_) { return null; }
    }

    function getCurrentDriveFileContext() {
        const data = readActiveItemInfo();
        const pathnameId = location.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/i)?.[1] || '';
        const fileId = String(
            data?.id || data?.fileId || data?.file_id || data?.resourceId || pathnameId || ''
        ).trim();
        return { fileId, filename: getCurrentDriveFileName(data) };
    }

    function getCurrentDriveFileName(dataOverride = null) {
        const candidates = [];
        const data = dataOverride || readActiveItemInfo();
        if (data) candidates.push(data?.title, data?.name);
        candidates.push(document.querySelector('meta[itemprop="name"]')?.content || '');
        const selectors = [
            '[aria-label^="File name"]',
            '[data-tooltip^="File name"]',
            '[aria-label][role="heading"]',
            'h1[aria-label]',
            '[data-tooltip][role="heading"]'
        ];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                candidates.push(el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.textContent);
            }
        }
        candidates.push(String(document.title || '').replace(/\s*-\s*Google Drive\s*$/i, ''));
        for (const value of candidates) {
            const name = String(value || '').replace(/^File name\s*[:\-]?\s*/i, '').trim();
            if (!name || /^Google Drive$/i.test(name) || /^(File name|Showing viewer|Video Player)$/i.test(name)) continue;
            return name;
        }
        return '';
    }

    function createViewerSessionId(fileId) {
        return `${fileId || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    function findDrivePlayerElement() {
        const candidates = [];
        const sections = [...document.querySelectorAll('section[aria-label*="Video Player" i], [role="dialog"][aria-label*="Showing viewer" i]')];
        for (const section of sections) {
            for (const el of section.querySelectorAll('video')) {
                if (isVisibleVideoElement(el)) candidates.push(el);
            }
            for (const host of section.querySelectorAll('*')) {
                if (host.shadowRoot) {
                    try {
                        for (const el of host.shadowRoot.querySelectorAll('video')) if (isVisibleVideoElement(el)) candidates.push(el);
                    } catch (_) {}
                }
            }
        }
        for (const el of collectVideoElements()) if (isVisibleVideoElement(el) && !candidates.includes(el)) candidates.push(el);
        return candidates[0] || null;
    }

    function getAccessibleLabel(el) {
        return [el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('data-tooltip')]
            .filter(Boolean).map(v => String(v).replace(/\s+/g, ' ').trim()).join(' ');
    }

    function findDrivePlayButton(player) {
        const root = player?.closest?.('section[aria-label*="Video Player" i], [role="dialog"]') || player?.parentElement || document;
        const candidates = [];
        const collect = r => {
            try {
                for (const el of r.querySelectorAll('[role="button"], button, [tabindex]')) {
                    if (!isVisibleVideoElement(el)) continue;
                    if (/^\s*(play|play video|play\/pause)\s*$/i.test(getAccessibleLabel(el)) || /^\s*play\s*$/i.test(String(el.textContent || '').trim())) candidates.push(el);
                }
                for (const host of r.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot);
            } catch (_) {}
        };
        collect(root);
        collect(document);
        return candidates[0] || null;
    }

    function startDrivePlayerFromUserGesture() {
        const player = findDrivePlayerElement();
        if (!player) return { player: null, started: false };
        try {
            player.muted = true;
            player.defaultMuted = true;
            player.setAttribute('muted', '');
            player.volume = 0;
        } catch (_) {}
        const enforceMute = () => {
            try {
                player.muted = true;
                player.defaultMuted = true;
                player.volume = 0;
                player.setAttribute('muted', '');
            } catch (_) {}
        };
        player.addEventListener('play', enforceMute, { once: true });
        player.addEventListener('playing', enforceMute, { once: true });

        let started = false;
        try {
            const promise = player.play();
            started = true;
            if (promise?.catch) promise.catch(() => {
                try { findDrivePlayButton(player)?.click(); } catch (_) {}
            });
        } catch (_) {}
        // If autoplay is rejected, activate Drive's actual Play control while the
        // extension click still has user-gesture context. This is intentionally
        // done in the click handler, before any await/runtime round-trip.
        if (player.paused) {
            try { findDrivePlayButton(player)?.click(); } catch (_) {}
        }
        return { player, started };
    }

    async function syncViewerContext(force = false) {
        const { fileId, filename } = getCurrentDriveFileContext();
        if (!fileId && !isVideoViewerOpen()) return null;
        const contextKey = String(fileId || video.fileId || '');
        if (!force && contextKey && contextKey === String(video.fileId || '') && video.viewerSessionId) {
            if (filename) video.lastFilenameSent = filename;
            return { fileId: video.fileId, filename, viewerSessionId: video.viewerSessionId };
        }

        const changed = !!fileId && !!video.fileId && String(fileId) !== String(video.fileId);
        if (changed || !video.viewerSessionId || !video.fileId) video.viewerSessionId = createViewerSessionId(fileId);
        if (fileId) video.fileId = fileId;
        if (changed) {
            stopQualityPickerWatch();
            video.playbackStarted = false;
            video.restorePickerOnFileMenuOpen = false;
            video.formats = { video: [], audio: [], progressive: [] };
            video.pickerFormats = null;
            video.scanCache = null;
        }
        video.lastFilenameSent = filename || video.lastFilenameSent || '';


        const response = await sendRuntime({
            action: 'setVideoContext',
            fileId,
            filename: filename || 'gdrive-video',
            viewerSessionId: video.viewerSessionId,
            pageBridgeId: video.pageBridgeId
        });

        if (response?.success) {
            const sessionFormats = response.session?.formats;
            if (hasUsableFormats(sessionFormats) || !video.pickerFormats) {
                video.formats = sessionFormats || { video: [], audio: [], progressive: [] };
            }
        }
        if (!video.pickerFormats && fileId) await restoreQualitySnapshot(fileId);
        updateVideoMenuState();
        return { fileId, filename, viewerSessionId: video.viewerSessionId };
    }

    function updateCapturedVideoFilename() {
        const name = getCurrentDriveFileName();
        if (!name || name === video.lastFilenameSent) return name;
        video.lastFilenameSent = name;
        app.sendAction('updateFilename', { filename: name });
        return name;
    }

    function isVisibleVideoElement(videoElement) {
        if (!videoElement) return false;
        const r = videoElement.getBoundingClientRect?.();
        if (!r || r.width <= 1 || r.height <= 1) return false;
        const style = getComputedStyle(videoElement);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function collectVideoElements(root = document, out = []) {
        try {
            if (root.querySelectorAll) {
                out.push(...root.querySelectorAll('video'));
                for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collectVideoElements(el.shadowRoot, out);
            }
        } catch (_) {}
        return out;
    }

    function muteMediaImmediately() {
        try {
            const media = [];
            const roots = [document];
            for (let i = 0; i < roots.length; i++) {
                const root = roots[i];
                if (!root?.querySelectorAll) continue;
                media.push(...root.querySelectorAll('video, audio'));
                for (const element of root.querySelectorAll('*')) {
                    if (element.shadowRoot) roots.push(element.shadowRoot);
                }
            }
            for (const element of new Set(media)) {
                element.muted = true;
                element.defaultMuted = true;
                element.volume = 0;
                element.setAttribute('muted', '');
            }
        } catch (_) {}
        try {
            window.postMessage({ type: 'PSD_MEDIA_MUTE_NOW' }, '*');
        } catch (_) {}
        void sendRuntime({ action: 'muteMediaNow' });
    }

    function setVideoPlaybackStarted(started = true) {
        if (!started || video.playbackStarted) return;
        video.playbackStarted = true;
        updateVideoMenuState();
        app.sendAction('videoPlaybackStarted');
    }

    function isCurrentVideoMessage(message) {
        const sameFile = !message?.fileId || !video.fileId || message.fileId === video.fileId;
        const sameViewer = !message?.viewerSessionId || !video.viewerSessionId || message.viewerSessionId === video.viewerSessionId;
        return sameFile && sameViewer;
    }

    function isTrustedPageOrigin(origin) {
        const value = String(origin || '').toLowerCase();
        let hostname = '';
        try { hostname = new URL(value).hostname; } catch (_) {}
        return hostname === 'drive.google.com' ||
            hostname.endsWith('.drive.google.com') ||
            hostname === location.hostname ||
            hostname.endsWith('.googleusercontent.com');
    }

    function resetQualityScanUI() {
        stopQualityPickerWatch();
        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';
        video.operation = 'idle';
        hidePageBlocker();
        updateVideoMenuState();
    }

    function normalizeQualityMenuItem(item) {
        if (!item) return;
        const label = item.querySelector('.psd-video-menu-label');
        const info = item.querySelector('.psd-video-menu-info');
        item.querySelectorAll('.psd-quality-head,.psd-quality-head-copy,.psd-quality-head-title,.psd-quality-head-subtitle').forEach(el => el.remove());
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
        const iconHosts = item.querySelectorAll('.aqdrmf-rymPhb-KkROqb');
        iconHosts.forEach(host => {
            host.style.setProperty('align-self', 'flex-start', 'important');
            host.style.setProperty('margin-top', '3px', 'important');
        });
    }

    function updateVideoMenuState() {
        const items = document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID);
        items.forEach(item => {
            normalizeQualityMenuItem(item);
            syncQualityPickerTypography(item);
            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            const hasFormats = (video.formats?.video?.length || video.formats?.progressive?.length) > 0;
            const labelText = video.operation === 'picker' ? 'Choose video quality' : 'Download';
            if (label) label.textContent = labelText;
            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = hasFormats ? 'true' : 'false';
            item.dataset.playbackReady = video.playbackStarted ? 'true' : 'false';
            item.removeAttribute('aria-disabled');
            item.removeAttribute('disabled');
            item.style.cursor = 'pointer';
            item.style.opacity = '1';
            item.style.pointerEvents = 'auto';
            item.tabIndex = 0;
            if (info) info.textContent = 'GDrive Protected File Downloader';
        });
    }

    function syncVideoStreamState(streams = {}) {
        const sameSession = !streams.fileId || !video.fileId || streams.fileId === video.fileId;
        if (!sameSession) return;
        if (streams.playbackStarted || streams.video) video.playbackStarted = true;
        if (streams.formats) video.formats = streams.formats;
        updateVideoMenuState();
    }

    function sendDownload(request) {
        return sendRuntime({
            action: 'downloadVideo',
            filename: getCurrentDriveFileName() || undefined,
            fileId: video.fileId || undefined,
            viewerSessionId: video.viewerSessionId || undefined,
            ...request
        });
    }

    function formatVideoLabel(fmt) {
        const height = Number(fmt?.height) || 0;
        const width = Number(fmt?.width) || 0;
        return height ? `${height}p` : (width ? `${width}px` : 'Video');
    }

    const SCAN_VEIL_TEXT = 'Finding available video qualities…';

    function ensureScanPageBlocker() {
        let root = document.getElementById('psd-video-scan-blocker');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'psd-video-scan-blocker';
        root.setAttribute('role', 'group');
        root.innerHTML = `
            <style>
                #psd-video-scan-blocker{position:fixed !important;left:0 !important;right:0 !important;top:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;outline:0 !important;background:#1b1b1b !important;color:transparent !important;overflow:hidden !important;box-sizing:border-box !important;z-index:2147483646 !important;pointer-events:none !important;display:none !important;cursor:default !important;user-select:none !important;}
                #psd-video-scan-blocker[data-open="true"]{pointer-events:auto !important;cursor:default !important;}
                #psd-video-scan-blocker[data-open="true"]{display:block !important;}
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
        const status = blocker.querySelector('.psd-scan-text');
        if (status) status.textContent = message;
        blocker.dataset.open = 'true';
    }

    function hidePageBlocker() {
        const blocker = document.getElementById('psd-video-scan-blocker');
        if (blocker) delete blocker.dataset.open;
    }



    function getDisplayVideoFormats(formats = []) {
        const map = new Map();
        for (const fmt of Array.isArray(formats) ? formats : []) {
            if (!fmt?.url) continue;
            const height = Number(fmt.height) || 0;
            const fps = Number(fmt.fps) || 0;
            const key = height ? `${height}p|${fps >= 50 ? 'highfps' : 'normal'}` : `${Number(fmt.width)||0}x${height}`;
            const current = map.get(key);
            const score = item => {
                let value = 0;
                if (/video\/mp4/i.test(String(item.mime || ''))) value += 1000000000;
                value += Number(item.contentLength || 0);
                value += Number(item.capturedAt || 0) / 1e9;
                return value;
            };
            if (!current || score(fmt) > score(current)) map.set(key, fmt);
        }
        return [...map.values()].sort((a,b) =>
            (Number(b.height||0)-Number(a.height||0)) ||
            (Number(b.fps||0)-Number(a.fps||0)) ||
            (Number(b.contentLength||0)-Number(a.contentLength||0)
        ));
    }

    function installQualityPickerInteractionShield() {
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
        const apply = (el, size, weight, line) => {
            if (!el) return;
            el.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
            el.style.setProperty('font-size', size, 'important');
            el.style.setProperty('font-weight', weight, 'important');
            el.style.setProperty('line-height', line, 'important');
            el.style.setProperty('letter-spacing', 'normal', 'important');
        };
        apply(root.querySelector('label'), '14px', '400', '20px');
        apply(root.querySelector('#psd-video-quality-video'), '14px', '400', '20px');
        apply(root.querySelector('#psd-video-quality-download'), '14px', '500', '20px');
        root.querySelectorAll('#psd-video-quality-video option').forEach(opt => apply(opt, '14px', '400', '20px'));
        const status = root.querySelector('#psd-video-quality-status');
        if (status) {
            status.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
            status.style.setProperty('font-size', '11px', 'important');
            status.style.setProperty('line-height', '14px', 'important');
            status.style.setProperty('font-weight', '400', 'important');
        }
    }

    function ensureQualityPicker() {
        let root = document.getElementById('psd-video-quality-picker');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'psd-video-quality-picker';
        root.setAttribute('role', 'group');
        root.innerHTML = `
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
        root.addEventListener('pointerdown', event => event.stopPropagation(), true);
        root.addEventListener('mousedown', event => event.stopPropagation(), true);
        root.addEventListener('pointerup', event => event.stopPropagation(), true);
        root.addEventListener('mouseup', event => event.stopPropagation(), true);
        root.addEventListener('click', event => event.stopPropagation(), true);
        root.addEventListener('keydown', event => {
            if (event.target?.matches?.('select')) event.stopPropagation();
        }, true);
        root.querySelector('#psd-video-quality-download').onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            downloadFromPicker();
        };
        root.querySelector('#psd-video-quality-video').onchange = () => updatePickerState();
        installQualityPickerInteractionShield();
        document.body.appendChild(root);

        return root;
    }

    function getVisibleDriveMenu() {
        const visible = app.ui.getVisibleFileMenus();
        return visible.find(menu =>
            menu.querySelector('#' + PROTECTED_VIDEO_MENU_ID) ||
            [...menu.querySelectorAll('[role="menuitem"],li,[data-tooltip]')].some(el =>
                /^(share|security limitations|details|add to starred)$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
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

    if (!window.__PSD_VIDEO_QUALITY_MENU_DISMISS) {
        window.__PSD_VIDEO_QUALITY_MENU_DISMISS = true;
        document.addEventListener('pointerdown', event => {
            if (video.operation !== 'picker') return;
            const target = event.target;
            if (target?.closest?.('#psd-video-quality-picker')) return;
            if (target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID)) return;
            closeQualityPicker();
        }, true);
    }

    let qualityPickerObserver = null;
    let qualityPickerWatchTimer = null;
    let qualityPickerMounting = false;
    let qualityPickerRehydrating = false;
    let qualityPickerRestorePromise = null;

    function isQualityPickerMountedInVisibleDriveMenu(root = document.getElementById('psd-video-quality-picker')) {
        if (!root || !root.parentElement) return false;
        const menu = root.parentElement.closest?.('[role="menu"]');
        if (!menu) return false;
        const rect = menu.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(menu);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const item = menu.querySelector('#' + PROTECTED_VIDEO_MENU_ID);
        if (!item) return false;
        return root.parentElement === item || item.contains(root);
    }

    function stopQualityPickerWatch() {
        if (qualityPickerObserver) {
            try { qualityPickerObserver.disconnect(); } catch (_) {}
            qualityPickerObserver = null;
        }
        if (qualityPickerWatchTimer) {
            clearTimeout(qualityPickerWatchTimer);
            qualityPickerWatchTimer = null;
        }
    }

    function queueQualityPickerWatch(delay = 0) {
        if (video.operation !== 'picker' || qualityPickerWatchTimer) return;
        qualityPickerWatchTimer = setTimeout(() => {
            qualityPickerWatchTimer = null;
            ensureQualityPickerMounted({ reopenIfMissing: false }).catch(() => {});
        }, delay);
    }

    function mountQualityPicker(root, menu) {
        if (video.operation !== 'picker') return false;
        const liveMenu = getVisibleDriveMenu() || menu;
        if (!liveMenu) return false;

        let item = liveMenu.querySelector('#' + PROTECTED_VIDEO_MENU_ID);
        if (!item) {
            try { addProtectedVideoMenuItem(liveMenu); } catch (_) {}
            item = liveMenu.querySelector('#' + PROTECTED_VIDEO_MENU_ID);
        }
        if (!item?.parentNode || !liveMenu.contains(item)) return false;

        const label = item.querySelector('.psd-video-menu-label');
        const contentHost = label?.parentElement || item;
        if (root.parentNode !== contentHost) contentHost.appendChild(root);
        normalizeQualityMenuItem(item);
        item.style.setProperty('align-items', 'flex-start', 'important');
        item.querySelectorAll('.aqdrmf-rymPhb-KkROqb').forEach(host => {
            host.style.setProperty('align-self', 'flex-start', 'important');
            host.style.setProperty('margin-top', '3px', 'important');
        });
        root.style.display = 'block';
        updateVideoMenuState();
        return true;
    }

    async function ensureQualityPickerMounted({ reopenIfMissing = false } = {}) {
        if (video.operation !== 'picker' || qualityPickerMounting) return false;
        const root = ensureQualityPicker();
        if (isQualityPickerMountedInVisibleDriveMenu(root)) {
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

    function startQualityPickerWatch() {
        stopQualityPickerWatch();
        if (video.operation !== 'picker') return;

        qualityPickerObserver = new MutationObserver(() => {
            if (video.operation !== 'picker') return;
            const liveRoot = document.getElementById('psd-video-quality-picker');
            if (getVisibleDriveMenu() && !isQualityPickerMountedInVisibleDriveMenu(liveRoot)) {
                queueQualityPickerWatch();
                return;
            }
            if (!video.pickerFormats || qualityPickerRehydrating || !isQualityPickerMountedInVisibleDriveMenu(liveRoot)) return;
            const select = liveRoot.querySelector('#psd-video-quality-video');
            if (!select || select.options.length) return;
            qualityPickerRehydrating = true;
            try { updatePickerState(); }
            finally { queueMicrotask(() => { qualityPickerRehydrating = false; }); }
        });
        try {
            qualityPickerObserver.observe(document.body, { childList: true, subtree: true });
        } catch (_) {
            qualityPickerObserver = null;
            return;
        }
        queueQualityPickerWatch();
    }

    async function clearQualitySnapshot(fileId = video.fileId) {
        const id = String(fileId || '').trim();
        if (id) {
            try { await sendRuntime({ action: 'clearQualityPickerSnapshot', fileId: id }); } catch (_) {}
        }
        video.pickerFormats = null;
        video.scanCache = null;
    }

    function closeQualityPicker(clearSnapshot = false) {
        stopQualityPickerWatch();
        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';
        video.operation = 'idle';
        video.restorePickerOnFileMenuOpen = !clearSnapshot;
        hidePageBlocker();
        if (clearSnapshot) void clearQualitySnapshot();
        updateVideoMenuState();
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
        formats.forEach((fmt, index) => {
            const option = document.createElement('option');
            option.value = fmt.id || String(index);
            option.textContent = labeler(fmt);
            select.appendChild(option);
        });
        const options = [...select.options];
        const keep = options.findIndex(o => previousValue && o.value === previousValue);
        const byText = keep >= 0 ? keep : options.findIndex(o => previousText && o.textContent === previousText);
        select.selectedIndex = byText >= 0 ? byText : 0;
    }

    function updatePickerState() {
        const root = ensureQualityPicker();
        const videoSelect = root.querySelector('#psd-video-quality-video');
        const download = root.querySelector('#psd-video-quality-download');
        const status = root.querySelector('#psd-video-quality-status');
        const pickerFormats = (video.operation === 'picker' && video.pickerFormats) ? video.pickerFormats : video.formats;
        const hasProgressive = Array.isArray(pickerFormats?.progressive) && pickerFormats.progressive.length;
        const hasAdaptiveVideo = Array.isArray(pickerFormats?.video) && pickerFormats.video.length;
        const hasAudio = Array.isArray(pickerFormats?.audio) && pickerFormats.audio.some(x => x?.url);

        if (!hasAdaptiveVideo && hasProgressive) {
            populateSelect(videoSelect, getDisplayVideoFormats(pickerFormats.progressive), formatVideoLabel, 'No video format detected');
        } else {
            populateSelect(videoSelect, getDisplayVideoFormats(pickerFormats?.video), formatVideoLabel, 'No adaptive video format detected');
        }

        const valid = !!(videoSelect.value && (hasProgressive || (hasAdaptiveVideo && hasAudio)));
        download.disabled = !valid;
        status.textContent = valid ? '' : 'Waiting for a usable Drive stream…';
        const mountedItem = root.closest?.('#' + PROTECTED_VIDEO_MENU_ID);
        if (mountedItem) syncQualityPickerTypography(mountedItem);
    }

    function describeScanReport(report, fallback) {
        const list = Array.isArray(report) ? report : [];
        const missed = list.filter(r => r && !r.captured).map(r => `${r.height}p`);
        if (!missed.length) return fallback;
        return `${fallback ? fallback + ' ' : ''}Could not capture ${missed.join(', ')}. open Download again to retry.`.trim();
    }

    async function showQualityPicker(formats, message = '') {
        video.formats = formats || { video: [], audio: [], progressive: [] };
        video.pickerFormats = cloneFormats(video.formats);
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: new Set([...video.pickerFormats.video, ...video.pickerFormats.progressive].map(f => Number(f.height) || 0).filter(Boolean)).size,
            note: message || ''
        };
        await saveQualitySnapshot();

        const root = ensureQualityPicker();
        const status = root.querySelector('#psd-video-quality-status');
        root.style.display = 'none';
        video.operation = 'picker';
        video.restorePickerOnFileMenuOpen = true;
        hidePageBlocker();
        updatePickerState();
        if (message) status.textContent = message;
        updateVideoMenuState();

        try {
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
            document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID).forEach(normalizeQualityMenuItem);
            updatePickerState();
            startQualityPickerWatch();
            return true;
        } catch (_) {
            video.operation = 'idle';
            hidePageBlocker();
            updateVideoMenuState();
            return false;
        }
    }

    async function downloadFromPicker() {
        muteMediaImmediately();
        const root = ensureQualityPicker();
        const videoId = root.querySelector('#psd-video-quality-video').value;
        const pickerFormats = (video.pickerFormats && video.operation === 'picker') ? video.pickerFormats : video.formats;
        const hasAdaptive = !!(pickerFormats?.video?.length);
        const request = hasAdaptive
            ? { videoFormatId: videoId }
            : { progressiveFormatId: videoId };

        root.querySelector('#psd-video-quality-download').disabled = true;
        root.querySelector('#psd-video-quality-status').textContent = 'Starting download…';
        const response = await sendDownload(request);
        if (!response?.success) {
            root.querySelector('#psd-video-quality-download').disabled = false;
            root.querySelector('#psd-video-quality-status').textContent = response?.error || 'Could not start the download.';
            video.operation = 'picker';
            updateVideoMenuState();
            return;
        }
        root.style.display = 'none';
        video.restorePickerOnFileMenuOpen = false;
        video.operation = 'staging';
        clearQualitySnapshot();
        try { app.ui.closeDriveFileMenu(); } catch (_) {}
        hidePageBlocker();
        videoOverlay.show(true, response.jobId || null, response.videoBytes || response.mediaBytes || 0, response.audioBytes || 0);
        updateVideoMenuState();
    }

    async function captureExistingStreamsAndPick() {
        const streamsResponse = await sendRuntime({ action: 'getStreams' });
        const streams = streamsResponse?.streams || {};
        const fallbackVideo = Array.isArray(streams.videoCandidates) ? streams.videoCandidates : [];
        const fallbackAudio = Array.isArray(streams.audioCandidates) ? streams.audioCandidates : [];
        const formats = {
            video: fallbackVideo.map((item, index) => ({
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
            })).sort((a, b) => (b.height - a.height) || (b.contentLength - a.contentLength)),
            audio: fallbackAudio.map((item, index) => ({
                id: item.id || `captured-a-${index}`,
                url: item.url,
                originalUrl: item.originalUrl,
                contentLength: Number(item.contentLength) || 0,
                itag: item.itag || '',
                kind: 'audio',
                acodec: item.codecs || '',
                mime: item.mime || 'audio/mp4'
            })).sort((a, b) => b.contentLength - a.contentLength),
            progressive: []
        };
        if (formats.video.length || formats.audio.length) return { success: true, formats };
        return { success: false, error: 'No stream has been captured yet. Play the video once, let it load, then press Refresh.' };
    }

    function cachedScanUsable() {
        const cache = video.scanCache;
        if (!cache || !video.fileId || cache.fileId !== video.fileId) return false;
        const videos = [...(video.formats?.video || []), ...(video.formats?.progressive || [])];
        const all = [...videos, ...(video.formats?.audio || [])].filter(f => f?.url);
        if (!videos.length || !all.length) return false;
        const heights = new Set(videos.map(f => Number(f.height) || 0).filter(Boolean));
        if (heights.size < cache.heightCount) return false;
        let soonest = Infinity;
        for (const f of all) {
            try {
                const expire = Number(new URL(f.originalUrl || f.url).searchParams.get('expire') || 0);
                if (expire) soonest = Math.min(soonest, expire);
            } catch (_) {}
        }
        if (Number.isFinite(soonest)) return soonest > Date.now() / 1000 + 120;
        return Date.now() - cache.at < 30 * 60 * 1000;
    }

    function rememberCompletedScan(scanReport) {
        const videos = [...(video.formats?.video || []), ...(video.formats?.progressive || [])];
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: new Set(videos.map(f => Number(f.height) || 0).filter(Boolean)).size,
            note: describeScanReport(scanReport, '')
        };
    }

    async function runQualityDetection() {
        video.operation = 'scanning';
        updateVideoMenuState();
        showPageBlocker(SCAN_VEIL_TEXT);

        app.ui.closeDriveFileMenu();
        await waitForDriveFileMenuClosed(1200);
        if (startDrivePlayerFromUserGesture()?.started) video.playbackStarted = true;

        try {
            const context = await syncViewerContext(true);
            if (!context?.fileId) throw new Error('Could not identify the current Drive video before starting quality detection.');

            await sendRuntime({ action: 'prepareQualityScan', fileId: video.fileId });
            const response = await sendRuntime({ action: 'automatedQualityScan', fileId: video.fileId });
            const formats = response?.success ? response.formats : null;
            if (formats && (formats.video?.length || formats.progressive?.length)) {
                await showQualityPicker(formats, describeScanReport(response.scanReport, ''));
                rememberCompletedScan(response.scanReport);
                return;
            }

            const fallback = await captureExistingStreamsAndPick();
            if (fallback.success) {
                await showQualityPicker(fallback.formats, 'Using the stream(s) currently playing in Drive.');
                return;
            }

            console.warn('[GDrive Downloader] quality detection did not produce a usable stream:', response?.error || fallback.error);
        } catch (error) {
            console.error('[GDrive Downloader] video quality detection failed:', error);
        }
        resetQualityScanUI();
    }

    async function startVideoFromMenu() {
        muteMediaImmediately();
        if (video.operation !== 'idle') return;
        if (cachedScanUsable() || hasUsableFormats(video.pickerFormats)) {
            app.ui.closeDriveFileMenu();
            video.operation = 'picker';
            await showQualityPicker(video.pickerFormats || video.formats, video.scanCache?.note || '');
            return;
        }
        await runQualityDetection();
    }

    function installVideoMenuClickGuard() {
        if (window.__PSD_VIDEO_MENU_CLICK_GUARD) return;
        window.__PSD_VIDEO_MENU_CLICK_GUARD = true;
        const activate = (item, event) => {
            if (!item || (event.target?.closest?.('#psd-video-quality-picker')) || video.operation !== 'idle') return;
            muteMediaImmediately();
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            item.dataset.activationInProgress = 'true';
            setTimeout(() => { item.dataset.activationInProgress = 'false'; }, 1800);
            startVideoFromMenu();
        };
        document.addEventListener('pointerdown', e => {
            const item = e.target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID);
            if (item) activate(item, e);
        }, true);
        document.addEventListener('click', e => {
            if (e.target?.closest?.('#psd-video-quality-picker')) return;
            const item = e.target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID);
            if (item && item.dataset.activationInProgress !== 'true') activate(item, e);
        }, true);
    }

    function installStreamStorageListener() {
        if (window.__PSD_STREAM_STORAGE_LISTENER) return;
        window.__PSD_STREAM_STORAGE_LISTENER = true;
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.videoSessions) return;
                const sessions = changes.videoSessions.newValue || {};
                const session = Object.values(sessions).find(item => item?.fileId && item.fileId === video.fileId && (!video.viewerSessionId || item.viewerSessionId === video.viewerSessionId));
                if (session) syncVideoStreamState(session);
            });
        } catch (_) {}
    }

    function addProtectedVideoMenuItem(menu) {
        if (menu.querySelector(`#${PROTECTED_VIDEO_MENU_ID}`)) return true;
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        if (!securityRow) return false;
        const printRow = app.ui.findMenuRow(menu, 'Print');
        if (printRow) return false;
        const templateRow = app.ui.findMenuRow(menu, 'Details') || app.ui.findMenuRow(menu, 'Add to starred') || securityRow;
        const item = app.ui.makeStandaloneMenuRow(templateRow, PROTECTED_VIDEO_MENU_ID, 'Download');
        if (!item) return false;
        item.classList.add('psd-video-download-item');
        const label = item.querySelector('[jsname="K4r5Ff"]');
        if (label) {
            label.classList.add('psd-video-menu-label');
            label.textContent = 'Download';
        }
        app.ui.addMenuDescription(item, 'psd-video-menu-label', 'psd-video-menu-info', 'GDrive Protected File Downloader');
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item, '1');
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

    async function handlePageBridgeMessage(event) {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'PSD_GDRIVE_PAGE_BRIDGE_READY') {
            if (window.top !== window) return;
            if (!isTrustedPageOrigin(event.origin)) return;
            if (data.bridgeId) video.pageBridgeId = String(data.bridgeId);
            const bridgeKey = String(data.bridgeId || '');
            const now = Date.now();
            video.bridgeReplayAt = video.bridgeReplayAt || {};
            if (now - (video.bridgeReplayAt[bridgeKey] || 0) < 2000) return;
            video.bridgeReplayAt[bridgeKey] = now;
            try { window.postMessage({ type: 'PSD_GDRIVE_STREAM_REPLAY', fromReady: true }, '*'); } catch (_) {}
            return;
        }
        if (data.type !== 'PSD_GDRIVE_STREAM_DETECTED') return;
        if (window.top !== window) return;
        if (!isTrustedPageOrigin(event.origin)) return;
        // The page-world bridge runs in every frame. Child-player frames post
        // their URLs to window.top, so event.source can legitimately be a
        // descendant frame rather than the top window. Trust the already-
        // validated Drive/Google origin instead of discarding those streams.
        if (typeof data.url !== 'string' || !data.url.includes('videoplayback')) return;
        if (!isVideoViewerOpen()) return;

        if (!video.fileId || !video.viewerSessionId) {
            await syncViewerContext(false);
        }
        try {
            const response = await sendRuntime({
                action: 'pageStreamDetected',
                url: data.url,
                fileId: video.fileId,
                viewerSessionId: video.viewerSessionId,
                pageBridgeId: String(data.bridgeId || video.pageBridgeId || ''),
                source: data.source || 'page-bridge',
                frameUrl: data.frameUrl || ''
            });
            if (response?.success) {
                video.playbackStarted = true;
                if (response.session?.formats) video.formats = response.session.formats;
                updateVideoMenuState();
                if (video.operation === 'picker') updatePickerState();
            }
        } catch (_) {}
    }

    function installPageNetworkBridgeRelay() {
        if (window.top !== window || window.__PSD_PAGE_BRIDGE_RELAY) return;
        window.__PSD_PAGE_BRIDGE_RELAY = true;
        window.addEventListener('message', event => {
            handlePageBridgeMessage(event).catch(() => {});
        }, true);
        try { window.postMessage({ type: 'PSD_GDRIVE_STREAM_REPLAY' }, '*'); } catch (_) {}
        setTimeout(() => { try { window.postMessage({ type: 'PSD_GDRIVE_STREAM_REPLAY' }, '*'); } catch (_) {} }, 1000);
    }

    function installFramePlaybackRelay() {
        if (window.__PSD_FRAME_PLAYBACK_RELAY) return;
        window.__PSD_FRAME_PLAYBACK_RELAY = true;
        const relay = event => {
            const target = event.target;
            if (!target || String(target.tagName || '').toLowerCase() !== 'video') return;
            if (!isVisibleVideoElement(target)) return;
            try { chrome.runtime.sendMessage({ action: 'videoPlaybackIntent', fileId: video.fileId }); } catch (_) {}
            setVideoPlaybackStarted();
        };
        document.addEventListener('play', relay, true);
        document.addEventListener('playing', relay, true);
    }

    const videoStageTypes = new Set([
        'videoFormatsDetected', 'videoStreamDetected',
        'videoStagePreload', 'videoStageStarted', 'videoStageStatus', 'videoStageProgress',
        'videoStageMergeProgress', 'videoStageDownloadStarted', 'videoStageFinished',
        'videoStageError', 'videoStageCancelled'
    ]);

    async function scanViewerState() {
        const open = isVideoViewerOpen();
        if (open !== video.lastViewerState) {
            if (open) {
                video.viewerSessionId = '';
                video.fileId = '';
                video.playbackStarted = false;
                video.lastFilenameSent = '';
                await syncViewerContext(true);
            } else {
                if (video.operation !== 'staging') hidePageBlocker();
                const root = document.getElementById('psd-video-quality-picker');
                if (root) { root.style.display = 'none'; if (root.parentElement?.closest?.('[role="menu"]')) root.remove(); }
                stopQualityPickerWatch();
                const previousFileId = video.fileId;
                    video.restorePickerOnFileMenuOpen = false;
                video.operation = 'idle';
                video.fileId = '';
                video.viewerSessionId = '';
                video.formats = { video: [], audio: [], progressive: [] };
                void clearQualitySnapshot(previousFileId);
            }
            updateVideoMenuState();
            video.lastViewerState = open;
        } else if (open) {
            await syncViewerContext(false);
            updateCapturedVideoFilename();
        }
    }

    async function ensureCachedQualityPickerForCurrentFile() {
        if (hasUsableFormats(video.pickerFormats)) return true;
        const context = getCurrentDriveFileContext();
        const fileId = String(video.fileId || context.fileId || '').trim();
        if (!fileId) return false;
        if (!qualityPickerRestorePromise) {
            qualityPickerRestorePromise = (async () => {
                try {
                    if (hasUsableFormats(video.pickerFormats)) return true;
                    return await restoreQualitySnapshot(fileId);
                } finally {
                    qualityPickerRestorePromise = null;
                }
            })();
        }
        try { return !!(await qualityPickerRestorePromise); }
        catch (_) { return false; }
    }

    async function remountCachedQualityPicker() {
        if (!video.restorePickerOnFileMenuOpen) return false;
        if (!getVisibleDriveMenu()) return false;
        if (video.operation === 'picker') return false;
        const restored = await ensureCachedQualityPickerForCurrentFile();
        if (!restored || !hasUsableFormats(video.pickerFormats)) return false;

        video.operation = 'picker';
        video.formats = cloneFormats(video.pickerFormats);
        updateVideoMenuState();
        updatePickerState();
        const mounted = await ensureQualityPickerMounted({ reopenIfMissing: false });
        if (mounted) startQualityPickerWatch();
        return mounted;
    }

    function scanMenu(menu) {
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        const printRow = app.ui.findMenuRow(menu, 'Print');
        if (securityRow && !printRow && !app.ui.findMenuRow(menu, 'Download')) addProtectedVideoMenuItem(menu);
    }

    function installDriveFileMenuRestore() {
        if (window.__PSD_FILE_MENU_QUALITY_RESTORE) return;
        window.__PSD_FILE_MENU_QUALITY_RESTORE = true;

        const restoreAfterToggle = async () => {
            if (video.operation === 'scanning' || !video.restorePickerOnFileMenuOpen || !video.fileId) return;
            const ready = await waitUntil(() => {
                const button = app.ui.getDriveFileButton();
                const expanded = String(button?.getAttribute('aria-expanded') || '').toLowerCase();
                return expanded !== 'false' && !!getVisibleDriveMenu();
            }, 300, 25);
            if (ready) await remountCachedQualityPicker();
        };

        document.addEventListener('pointerdown', event => {
            const target = event.target?.closest?.('[role="button"],button');
            if (target && target === app.ui.getDriveFileButton()) void restoreAfterToggle();
        }, true);
    }

    function initMessaging() {
        chrome.runtime.onMessage.addListener(msg => {
            if (window.top !== window.self || !videoStageTypes.has(msg?.type)) return;
            if (msg.type === 'videoFormatsDetected') {
                if (isCurrentVideoMessage(msg)) {
                    video.formats = msg.formats || { video: [], audio: [], progressive: [] };
                    updateVideoMenuState();
                    if (video.operation === 'picker') updatePickerState();
                }
                return;
            }
            if (msg.type === 'videoStreamDetected') {
                if (isCurrentVideoMessage(msg)) {
                    if (msg.formats) video.formats = msg.formats;
                    video.playbackStarted = true;
                    updateVideoMenuState();
                    if (video.operation === 'picker') updatePickerState();
                }
                return;
            }
            if (msg.type === 'videoStagePreload') {
                const job = videoOverlay.getJobId();
                const stage = videoOverlay.getStage();
                if ((job && job !== msg.jobId && !['ready', 'cancelled', 'error'].includes(stage)) || (job === msg.jobId && stage !== 'download')) return;
                return videoOverlay.show(true, msg.jobId || null, msg.videoBytes || msg.mediaBytes || 0, msg.audioBytes || 0);
            }
            const activeJob = videoOverlay.getJobId();
            if (activeJob && msg.jobId && activeJob !== msg.jobId) return;
            switch (msg.type) {
                case 'videoStageStatus':
                    if (msg.stage === 'staged' || msg.stage === 'merge') videoOverlay.update({ stage: 'merge', progress: msg.stage === 'staged' ? 0 : undefined });
                    else if (msg.stage === 'processing') videoOverlay.update({ stage: 'processing' });
                    break;
                case 'videoStageStarted':
                    videoOverlay.setJob(msg.jobId || activeJob, msg.videoBytes || msg.mediaBytes || 0, msg.audioBytes || 0);
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
                    videoOverlay.clearJob();
                    video.operation = 'idle';
                    updateVideoMenuState();
                    videoOverlay.update({ stage: 'ready' });
                    break;
                case 'videoStageError':
                    videoOverlay.clearJob();
                    video.operation = 'idle';
                    updateVideoMenuState();
                    videoOverlay.update({ stage: 'error', message: msg.message || 'Video processing failed.' });
                    break;
                case 'videoStageCancelled':
                    videoOverlay.clearJob();
                    video.operation = 'idle';
                    updateVideoMenuState();
                    videoOverlay.update({ stage: 'cancel' });
                    break;
            }
        });
    }

    function init() {
        installPageNetworkBridgeRelay();
        installVideoMenuClickGuard();
        installDriveFileMenuRestore();
        installStreamStorageListener();
        initMessaging();
        installFramePlaybackRelay();
    }

    app.video = {
        isVideoViewerOpen,
        scanViewerState,
        scanMenu,
        init
    };
    app.init();
})();
