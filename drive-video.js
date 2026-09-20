/**
 * Video Controller
 * Runs on the Google Drive page. Video quality is detected by briefly starting the muted Drive player and
 * automating its real Settings -> Quality menu; network capture remains the
 * authoritative fallback when a quality switch emits a videoplayback request.
 */

(() => {
    if (!window.__PSD_LOADED || window.__PSD_VIDEO_LOADED) return;
    window.__PSD_VIDEO_LOADED = true;
    const app = window.__PSD;
    const video = app.videoState;
    const PROTECTED_VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;
    if (!videoOverlay) throw new Error('Video overlay module failed to load.');

    video.fileId = video.fileId || '';
    video.viewerSessionId = video.viewerSessionId || '';
    video.lastContextSignature = video.lastContextSignature || '';
    video.formats = video.formats || { video: [], audio: [], progressive: [] };
    video.formatsDetectedAt = 0;
    video.pageBridgeId = video.pageBridgeId || '';
    video.qualityPickerOpen = false;
    // Snapshot used exclusively by the open picker. Drive may mutate/rebuild its
    // menu and can overwrite the live session format state while the debugger
    // detaches. The picker must keep the last completed scan data independently.
    video.pickerFormats = video.pickerFormats || null;
    // Cached picker data should return only when the user OPENS the Drive File menu.
    // Never auto-open the File menu just because the menu DOM was removed/rebuilt.
    video.qualityPickerRestoreOnFileOpen = !!video.qualityPickerRestoreOnFileOpen;
    // True only while the initial automated quality scan is actively running.
    // File-menu restore must stay completely out of the way until the scan is done.
    video.qualityScanInProgress = false;

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

    async function saveQualitySnapshot() {
        const fileId = String(video.fileId || '').trim();
        if (!fileId || !video.pickerFormats) return;
        try {
            const snapshot = {
                fileId,
                viewerSessionId: String(video.viewerSessionId || ''),
                formats: {
                    video: Array.isArray(video.pickerFormats.video) ? video.pickerFormats.video.map(x => ({ ...x })) : [],
                    audio: Array.isArray(video.pickerFormats.audio) ? video.pickerFormats.audio.map(x => ({ ...x })) : [],
                    progressive: Array.isArray(video.pickerFormats.progressive) ? video.pickerFormats.progressive.map(x => ({ ...x })) : []
                },
                qualityStreams: Array.isArray(video.qualityStreams) ? video.qualityStreams.map(x => ({ ...x, video: x?.video ? { ...x.video } : x?.video, audio: x?.audio ? { ...x.audio } : x?.audio })) : [],
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
            video.pickerFormats = {
                video: Array.isArray(snapshot.formats.video) ? snapshot.formats.video.map(x => ({ ...x })) : [],
                audio: Array.isArray(snapshot.formats.audio) ? snapshot.formats.audio.map(x => ({ ...x })) : [],
                progressive: Array.isArray(snapshot.formats.progressive) ? snapshot.formats.progressive.map(x => ({ ...x })) : []
            };
            video.formats = {
                video: video.pickerFormats.video.map(x => ({ ...x })),
                audio: video.pickerFormats.audio.map(x => ({ ...x })),
                progressive: video.pickerFormats.progressive.map(x => ({ ...x }))
            };
            video.qualityStreams = Array.isArray(snapshot.qualityStreams) ? snapshot.qualityStreams.map(x => ({ ...x, video: x?.video ? { ...x.video } : x?.video, audio: x?.audio ? { ...x.audio } : x?.audio })) : [];
            video.formatsDetectedAt = Number(snapshot.savedAt) || Date.now();
            video.scanCache = {
                fileId: id,
                at: Number(snapshot.savedAt) || Date.now(),
                heights: new Set([...video.pickerFormats.video, ...video.pickerFormats.progressive].map(f => Number(f.height) || 0).filter(Boolean)).size,
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

    function getCurrentDriveFileContext() {
        let data = null;
        const json = document.querySelector('#drive-active-item-info');
        if (json?.textContent) {
            try { data = JSON.parse(json.textContent || ''); } catch (_) {}
        }

        const pathnameId = location.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/i)?.[1] || '';
        const fileId = String(
            data?.id || data?.fileId || data?.file_id || data?.resourceId || pathnameId || ''
        ).trim();
        const filename = getCurrentDriveFileName(data);
        return { fileId, filename };
    }

    function getCurrentDriveFileName(dataOverride = null) {
        const candidates = [];
        const data = dataOverride || (() => {
            const json = document.querySelector('#drive-active-item-info');
            if (!json) return null;
            try { return JSON.parse(json.textContent || ''); } catch (_) { return null; }
        })();
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
        // The Download Video menu itself is only injected while a Drive video
        // viewer is active, but Drive changes its viewer DOM faster than our
        // selector can always follow it.  Do not reject a perfectly valid
        // file context just because the current player markup isn't the exact
        // legacy selector shape.
        const { fileId, filename } = getCurrentDriveFileContext();
        if (!fileId && !isVideoViewerOpen()) return null;
        // Ignore filename/heading churn while Drive rebuilds its File menu.
        // A filename mutation is not a new video session and must never erase the scan.
        const contextKey = String(fileId || video.fileId || '');
        if (!force && contextKey && contextKey === String(video.fileId || '') && video.viewerSessionId) {
            if (filename) video.lastFilenameSent = filename;
            return { fileId: video.fileId, filename, viewerSessionId: video.viewerSessionId };
        }

        const changed = !!fileId && !!video.fileId && String(fileId) !== String(video.fileId);
        video.lastContextSignature = contextKey;
        if (changed || !video.viewerSessionId || !video.fileId) video.viewerSessionId = createViewerSessionId(fileId);
        if (fileId) video.fileId = fileId;
        if (changed) {
            video.streamDetected = false;
            video.playbackStarted = false;
            video.formats = { video: [], audio: [], progressive: [] };
            video.pickerFormats = null;
            video.qualityStreams = [];
            video.formatsDetectedAt = 0;
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
        // Do not start playback or quality scanning merely because the viewer opened.
        // Quality discovery is triggered by the user clicking Download Video.
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

    function hasMainPagePlaybackStarted() {
        return collectVideoElements().some(videoElement =>
            isVisibleVideoElement(videoElement) && !videoElement.paused && !videoElement.ended &&
            (videoElement.currentTime > 0 || videoElement.readyState >= 3)
        );
    }

    function setVideoPlaybackStarted(started = true) {
        if (!started || video.playbackStarted) return;
        video.playbackStarted = true;
        updateVideoMenuState();
        app.sendAction('videoPlaybackStarted');
    }

    function normalizeQualityMenuItem(item) {
        if (!item) return;
        const label = item.querySelector('.psd-video-menu-label');
        const info = item.querySelector('.psd-video-menu-info');
        // The Drive row itself is the picker header. Remove any stale header that
        // may remain from an older installed build so the menu can never show
        // "Download Video" + "Choose video quality" as two separate blocks.
        item.querySelectorAll('.psd-quality-head,.psd-quality-head-copy,.psd-quality-head-title,.psd-quality-head-subtitle').forEach(el => el.remove());
        if (label) {
            label.textContent = video.qualityPickerOpen ? 'Choose video quality' : 'Download';
            label.classList.add('psd-video-menu-label');
            // Do not impose an extension-specific type scale. The row is cloned from
            // Drive's own menu item, so letting its computed typography flow through
            // is the only reliable way to stay pixel-consistent with the surrounding rows.
            label.style.removeProperty('font-size');
            label.style.removeProperty('line-height');
            label.style.removeProperty('font-weight');
        }
        if (info) {
            info.textContent = 'GDrive Protected File Downloader';
            // This is the same compact supporting-text treatment used by the
            // surrounding Drive menu rows. Do not inherit the row's larger label font.
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
            const labelText = video.qualityPickerOpen ? 'Choose video quality' : 'Download';
            if (label) label.textContent = labelText;
            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = (video.streamDetected || hasFormats) ? 'true' : 'false';
            item.dataset.playbackReady = video.playbackStarted ? 'true' : 'false';
            // Downloads are background work. Never veil/disable the Drive page or
            // the menu item itself while the media is being fetched/processed.
            item.removeAttribute('aria-disabled');
            item.removeAttribute('disabled');
            item.style.cursor = 'pointer';
            item.style.opacity = '1';
            item.style.pointerEvents = 'auto';
            item.tabIndex = 0;
            if (info) info.textContent = 'GDrive Protected File Downloader';
        });
    }

    function setVideoDownloadState(hasStream) {
        video.streamDetected = !!hasStream;
        updateVideoMenuState();
    }

    function syncVideoStreamState(streams = {}) {
        const sameSession = !streams.fileId || !video.fileId || streams.fileId === video.fileId;
        if (!sameSession) return;
        if (streams.playbackStarted || streams.video) video.playbackStarted = true;
        if (streams.formats) video.formats = streams.formats;
        setVideoDownloadState(!!streams.video || (video.formats?.video?.length || video.formats?.progressive?.length) > 0);
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

    function formatSize(bytes) {
        const n = Number(bytes) || 0;
        if (!n) return 'size unknown';
        if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 50 * 1024 * 1024 ? 0 : 1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function formatVideoLabel(fmt) {
        const height = Number(fmt?.height) || 0;
        const width = Number(fmt?.width) || 0;
        return height ? `${height}p` : (width ? `${width}px` : 'Video');
    }

    function formatAudioLabel(fmt) {
        const codec = String(fmt?.acodec || '').split(/[ ,]/)[0];
        return `${formatSize(fmt?.contentLength)}${codec ? ` • ${codec}` : ''}`;
    }

    function getDriveToolbarBottom() {
        try {
            const candidates = [];
            const selectors = [
                '[role="banner"]',
                'header',
                '[aria-label*="toolbar" i]',
                '[role="toolbar"]',
                '[data-tooltip*="Google Drive" i]'
            ];
            for (const selector of selectors) {
                for (const el of document.querySelectorAll(selector)) {
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    if (r.width < 300 || r.height < 30 || r.top > 20 || r.top < -10) continue;
                    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                    candidates.push(r.bottom);
                }
            }
            if (candidates.length) {
                const bottom = Math.max(...candidates.filter(v => Number.isFinite(v)));
                return Math.min(120, Math.max(56, Math.round(bottom)));
            }
        } catch (_) {}
        return 64;
    }

    function ensurePageBlocker() {
        let root = document.getElementById('psd-video-page-blocker');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'psd-video-page-blocker';
        root.innerHTML = `
            <style>
                #psd-video-page-blocker{position:fixed !important;left:0 !important;right:0 !important;top:64px;bottom:0 !important;z-index:2147483645 !important;background:rgba(0,0,0,.20) !important;pointer-events:auto !important;cursor:wait !important;display:none;isolation:isolate;}
                #psd-video-page-blocker[data-mode="download"]{cursor:progress !important;}
                #psd-video-page-blocker .psd-blocker-status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:240px;max-width:min(420px,calc(100vw - 48px));box-sizing:border-box;padding:14px 18px;border-radius:14px;background:rgba(32,33,36,.94);box-shadow:0 8px 32px rgba(0,0,0,.45);color:#e8eaed;text-align:center;font:500 14px/1.4 'Google Sans',Roboto,Arial,sans-serif;pointer-events:none;}
            </style>
            <div class="psd-blocker-status" aria-live="polite">Preparing video…</div>`;
        document.documentElement.appendChild(root);
        return root;
    }

    const SCAN_VEIL_TEXT = 'Finding available video qualities…';

    function ensureScanPageBlocker() {
        let root = document.getElementById('psd-video-scan-blocker');
        if (root) return root;
        // A normal fixed div (not <dialog>): a non-modal <dialog> does not enter the top layer,
        // so Drive's viewer could paint above it.
        root = document.createElement('div');
        root.id = 'psd-video-scan-blocker';
        root.setAttribute('role', 'group');
        root.innerHTML = `
            <style>
                /* The veil is purely visual and must NEVER intercept the pointer: the extension's own
                   trusted clicks (Play, Settings, Quality, each quality row) and its hit-tests
                   (elementFromPoint) have to reach Drive's real controls. It used to take the pointer
                   (pointer-events:auto) and only step aside around some clicks, so any click that was
                   not wrapped - e.g. the initial Play click - landed on the veil and the auto-click
                   silently failed. Hidden by default; shown ONLY through [data-open]. The old code set an inline
                   display:block, which can never beat this stylesheet's display:none !important,
                   so the veil was never visible. */
                #psd-video-scan-blocker{position:fixed !important;left:0 !important;right:0 !important;top:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;outline:0 !important;background:rgba(0,0,0,.55) !important;color:transparent !important;overflow:hidden !important;box-sizing:border-box !important;z-index:2147483646 !important;pointer-events:none !important;display:none !important;user-select:none !important;}
                #psd-video-scan-blocker[data-open="true"]{display:block !important;}
                #psd-video-scan-blocker .psd-scan-status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;min-width:0;max-width:min(460px,calc(100vw - 48px));box-sizing:border-box;padding:0;color:#fff;text-align:center;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.7);}
                #psd-video-scan-blocker .psd-scan-spin{flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#8ab4f8;animation:psd-scan-spin .8s linear infinite;}
                #psd-video-scan-blocker .psd-scan-text{font:500 17px/1.35 'Google Sans',Roboto,Arial,sans-serif;letter-spacing:.1px;}
                #psd-video-scan-blocker .psd-scan-hint{font:400 13px/1.4 Roboto,Arial,sans-serif;color:rgba(255,255,255,.72);}
                @keyframes psd-scan-spin{to{transform:rotate(360deg)}}
            </style>
            <div class="psd-scan-status" aria-live="polite"><div class="psd-scan-spin"></div><span class="psd-scan-text">${SCAN_VEIL_TEXT}</span><span class="psd-scan-hint">This only takes a moment</span></div>`;
        document.documentElement.appendChild(root);
        return root;
    }

    // While the extension sends its own trusted clicks to Drive, the veil stays VISIBLE but lets
    // pointer events fall through to Drive's controls (hiding it made the screen flash on every click).
    function setBlockerPassThrough(pass) {
        for (const id of ['psd-video-scan-blocker', 'psd-video-page-blocker']) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (pass) el.style.setProperty('pointer-events', 'none', 'important');
            else el.style.removeProperty('pointer-events');
        }
    }

    function showPageBlocker(message='Preparing video…', mode='scan') {
        if (window.top !== window.self) return;
        if (mode === 'scan') {
            const modal = ensureScanPageBlocker();
            const status = modal.querySelector('.psd-scan-text');
            if (status) status.textContent = message;
            setBlockerPassThrough(false);
            modal.dataset.open = 'true';
            return;
        }
        const root = ensurePageBlocker();
        root.style.top = `${getDriveToolbarBottom()}px`;
        root.dataset.mode = mode;
        const status = root.querySelector('.psd-blocker-status');
        if (status) status.textContent = message;
        root.style.display = 'block';
    }


    function hidePageBlocker() {
        setBlockerPassThrough(false);
        const modal = document.getElementById('psd-video-scan-blocker');
        if (modal) delete modal.dataset.open;
        const root = document.getElementById('psd-video-page-blocker');
        if (root) root.style.display = 'none';
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

        window.addEventListener('pointerdown', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            // Do not preventDefault: native selects need their default pointer behavior.
            event.stopImmediatePropagation();
        }, true);

        window.addEventListener('mousedown', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            event.stopImmediatePropagation();
        }, true);

        window.addEventListener('pointerup', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            event.stopImmediatePropagation();
        }, true);

        window.addEventListener('mouseup', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            event.stopImmediatePropagation();
        }, true);

        window.addEventListener('click', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            const downloadButton = event.target?.closest?.('#psd-video-quality-download');
            event.stopImmediatePropagation();
            if (downloadButton) {
                event.preventDefault();
                downloadFromPicker();
            }
        }, true);

        window.addEventListener('keydown', event => {
            const picker = event.target?.closest?.('#psd-video-quality-picker');
            if (!picker) return;
            // Let the browser handle arrows/home/end/space inside native selects,
            // but keep Drive's menu keyboard manager from stealing those keystrokes.
            if (event.target?.matches?.('select')) event.stopImmediatePropagation();
        }, true);
    }

    function syncQualityPickerTypography(item) {
        const root = document.getElementById('psd-video-quality-picker');
        if (!root || !item) return;
        // Keep the picker on the same compact scale as the surrounding Drive menu.
        // Do not inherit the larger heading scale from Drive's injected content column.
        const apply = (el, size, weight, line) => {
            if (!el) return;
            el.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
            el.style.setProperty('font-size', size, 'important');
            el.style.setProperty('font-weight', weight, 'important');
            el.style.setProperty('line-height', line, 'important');
            el.style.setProperty('letter-spacing', 'normal', 'important');
        };
        // Use the compact 14px/20px Material body/menu scale rather than Drive's
        // larger content-heading scale. The menu description stays at 11px/14px.
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
                /* One balanced control row: [ quality select ........ ][ Download ], equal height. */
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

        // Keep the native controls interactive inside Drive's role=menu/role=menuitem tree.
        // Drive uses high-level delegated pointer handlers, so a normal child stopPropagation
        // is not always early enough. The window-capture shield runs before Drive's document
        // handlers, preserves native <select> behavior, and manually routes the Download button.
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

        // Drive can reconcile/reparent/rebuild its File-menu DOM when chrome.debugger
        // detaches. Depending on the exact Drive frame timing it may leave our picker
        // element visible while clearing its <select> children a moment later. Watch the
        // whole document, not just the picker root, and rehydrate from the immutable picker
        // snapshot whenever a visible menu contains an empty selector.
        if (!qualityPickerDataObserver) {
            qualityPickerDataObserver = new MutationObserver(() => {
                if (!video.qualityPickerOpen || !video.pickerFormats || qualityPickerDataRehydrating) return;
                const liveRoot = document.getElementById('psd-video-quality-picker');
                if (!liveRoot || !isQualityPickerMountedInVisibleDriveMenu(liveRoot)) return;
                const videoSelect = liveRoot.querySelector('#psd-video-quality-video');
                const needsVideo = videoSelect && videoSelect.options.length === 0;
                if (!needsVideo) return;
                qualityPickerDataRehydrating = true;
                try { updatePickerState(); }
                finally { queueMicrotask(() => { qualityPickerDataRehydrating = false; }); }
            });
            try {
                qualityPickerDataObserver.observe(document.body, { childList: true, subtree: true });
            } catch (_) {
                qualityPickerDataObserver = null;
            }
        }
        return root;
    }

    function getVisibleDriveMenu() {
        const visible = [...document.querySelectorAll('[role="menu"]')].filter(menu => {
            const r = menu.getBoundingClientRect?.();
            if (!r || r.width <= 0 || r.height <= 0) return false;
            const style = getComputedStyle(menu);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
        return visible.find(menu =>
            menu.querySelector('#' + PROTECTED_VIDEO_MENU_ID) ||
            [...menu.querySelectorAll('[role="menuitem"],li,[data-tooltip]')].some(el =>
                /^(share|security limitations|details|add to starred)$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
            )
        ) || visible[0] || null;
    }

    function getDriveFileButton() {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        return [...document.querySelectorAll('[role="button"],button')].find(el => {
            if (!el.offsetParent) return false;
            const label = normalize(el.getAttribute('aria-label'));
            const text = normalize(el.textContent);
            return label === 'File' || text === 'File';
        }) || null;
    }

    async function waitForDriveFileMenuClosed(timeoutMs = 1800) {
        const deadline = Date.now() + Math.max(250, Number(timeoutMs) || 1800);
        while (Date.now() < deadline) {
            const button = getDriveFileButton();
            const expanded = String(button?.getAttribute('aria-expanded') || '').toLowerCase();
            const menu = getVisibleDriveMenu();
            if (!menu && expanded !== 'true') return true;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        return !getVisibleDriveMenu();
    }

    async function reopenDriveFileMenu() {
        let menu = getVisibleDriveMenu();
        if (menu) return menu;
        const button = getDriveFileButton();
        if (!button) return null;
        try { button.click(); } catch (_) { return null; }
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 35));
            menu = getVisibleDriveMenu();
            if (menu) return menu;
        }
        return null;
    }

    if (!window.__PSD_VIDEO_QUALITY_MENU_DISMISS) {
        window.__PSD_VIDEO_QUALITY_MENU_DISMISS = true;
        document.addEventListener('pointerdown', event => {
            if (!video.qualityPickerOpen) return;
            const target = event.target;
            if (target?.closest?.('#psd-video-quality-picker')) return;
            if (target?.closest?.('#' + PROTECTED_VIDEO_MENU_ID)) return;
            closeQualityPicker();
        }, true);
    }

    let qualityPickerMountObserver = null;
    let qualityPickerMountTimer = null;
    let qualityPickerMounting = false;
    let qualityPickerDataObserver = null;
    let qualityPickerDataRehydrating = false;
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

    function stopQualityPickerMountWatch() {
        if (qualityPickerMountObserver) {
            try { qualityPickerMountObserver.disconnect(); } catch (_) {}
            qualityPickerMountObserver = null;
        }
        if (qualityPickerMountTimer) {
            clearTimeout(qualityPickerMountTimer);
            qualityPickerMountTimer = null;
        }
    }

    function queueQualityPickerMountWatch(delay = 0) {
        if (!video.qualityPickerOpen || qualityPickerMountTimer) return;
        qualityPickerMountTimer = setTimeout(() => {
            qualityPickerMountTimer = null;
            ensureQualityPickerMounted({ reopenIfMissing: false }).catch(() => {});
        }, delay);
    }

    async function ensureQualityPickerMounted({ reopenIfMissing = false } = {}) {
        if (!video.qualityPickerOpen || qualityPickerMounting) return false;
        const root = ensureQualityPicker();
        if (isQualityPickerMountedInVisibleDriveMenu(root)) {
            root.style.display = 'block';
            return true;
        }

        qualityPickerMounting = true;
        try {
            let menu = getVisibleDriveMenu();
            // IMPORTANT: background mount/rebuild watchers must never click File for the user.
            // Doing so is what caused the File menu to reopen immediately after the user
            // intentionally closed it. Only the scan-complete handoff is allowed to reopen it.
            if (!menu && reopenIfMissing) menu = await reopenDriveFileMenu();
            if (!menu) return false;

            for (let i = 0; i < 35; i++) {
                if (!video.qualityPickerOpen) return false;
                let item = menu.querySelector('#' + PROTECTED_VIDEO_MENU_ID);
                if (!item) {
                    try { addProtectedVideoMenuItem(menu); } catch (_) {}
                    item = menu.querySelector('#' + PROTECTED_VIDEO_MENU_ID);
                }
                if (item?.parentNode && menu.contains(item)) {
                    // Mount inside the Download Video row's text column so the picker is a
                    // native-looking continuation of that menu item, directly under its
                    // label/description, rather than a separate menu card.
                    const label = item.querySelector('.psd-video-menu-label');
                    const contentHost = label?.parentElement || item;
                    if (root.parentNode !== contentHost) contentHost.appendChild(root);
                    // The existing Drive row is the only heading. Never leave a second
                    // picker title/subtitle inside the injected content.
                    normalizeQualityMenuItem(item);
                    item.style.setProperty('align-items', 'flex-start', 'important');
                    item.querySelectorAll('.aqdrmf-rymPhb-KkROqb').forEach(host => {
                        host.style.setProperty('align-self', 'flex-start', 'important');
                        host.style.setProperty('margin-top', '3px', 'important');
                    });
                    root.style.display = 'block';
                    video.qualityPickerOpen = true;
                    updateVideoMenuState();
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 25));
                menu = getVisibleDriveMenu() || menu;
                if (!menu && !reopenIfMissing) return false;
            }
            return false;
        } finally {
            qualityPickerMounting = false;
        }
    }

    function startQualityPickerMountWatch() {
        stopQualityPickerMountWatch();
        if (!video.qualityPickerOpen) return;

        // Drive may refresh/rebuild its File menu immediately after the debugger detaches.
        // Keep the same quality picker node alive and reinsert it into the fresh Download
        // Video row. This lets the debugger close immediately while the options remain visible.
        qualityPickerMountObserver = new MutationObserver(() => {
            if (!video.qualityPickerOpen) return;
            // Only repair an already-open/rebuilt Drive menu. If File is closed, wait
            // for Drive to create a new visible menu; scanMenu() will restore the picker.
            if (!getVisibleDriveMenu()) return;
            if (!isQualityPickerMountedInVisibleDriveMenu()) queueQualityPickerMountWatch(0);
        });
        try {
            qualityPickerMountObserver.observe(document.body, { childList: true, subtree: true });
        } catch (_) {
            qualityPickerMountObserver = null;
        }
        queueQualityPickerMountWatch(0);
    }

    async function mountQualityPickerInDriveMenu() {
        const ok = await ensureQualityPickerMounted({ reopenIfMissing: true });
        if (ok) startQualityPickerMountWatch();
        return ok;
    }

    function positionQualityPicker() {
        // Compatibility hook: the quality selector is now inline with the Drive menu,
        // so there is deliberately no floating position to calculate.
        const root = document.getElementById('psd-video-quality-picker');
        if (video.qualityPickerOpen && root?.parentElement?.closest?.('[role="menu"]')) root.style.display = 'block';
    }

    async function clearQualitySnapshot() {
        try { await sendRuntime({ action: 'clearQualityPickerSnapshot', fileId: video.fileId }); } catch (_) {}
        video.pickerFormats = null;
        video.qualityStreams = [];
        video.scanCache = null;
    }

    function closeQualityPicker(clearSnapshot = false) {
        stopQualityPickerMountWatch();
        if (qualityPickerDataObserver) {
            try { qualityPickerDataObserver.disconnect(); } catch (_) {}
            qualityPickerDataObserver = null;
        }
        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';
        video.qualityPickerOpen = false;
        video.downloadInProgress = false;
        // Keep the completed snapshot alive so the next user click on File restores it.
        // A real Cancel/clear action explicitly disables that restore path.
        video.qualityPickerRestoreOnFileOpen = !clearSnapshot;
        hidePageBlocker();
        if (clearSnapshot) clearQualitySnapshot();
        updateVideoMenuState();
    }

// One entry per distinct audio FILE. Re-captures of the same track (after a reload, or once per
    // probed quality) carry different signed URLs and probe labels but the same itag and size, so
    // they must not be listed twice. The newest URL is kept because signed URLs expire.
        function dedupeAudioFormats(list) {
        const items = (Array.isArray(list) ? list : []).filter(x => x?.url);
        const idOf = x => String(x.itag || '').trim() || `${String(x.mime || '').toLowerCase()}|${String(x.acodec || x.codecs || '').toLowerCase()}`;
        const groups = new Map();
        for (const x of items) {
            const k = idOf(x);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(x);
        }
        const newer = (a, b) => Number(a?.capturedAt || 0) >= Number(b?.capturedAt || 0);
        const out = [];
        for (const arr of groups.values()) {
            const byLen = new Map();
            for (const x of arr) {
                const len = Number(x.contentLength || 0);
                const prev = byLen.get(len);
                if (!prev || newer(x, prev)) byLen.set(len, x);
            }
            const known = [...byLen.keys()].filter(l => l > 0);
            const unknown = byLen.get(0);
            byLen.delete(0);
            if (known.length) {
                // A copy with no size yet is the same file as the sized one of the same itag.
                if (unknown && known.length === 1) {
                    const sized = byLen.get(known[0]);
                    if (!newer(sized, unknown)) byLen.set(known[0], { ...unknown, contentLength: known[0] });
                }
            } else if (unknown) {
                byLen.set(0, unknown);
            }
            out.push(...byLen.values());
        }
        return out;
    }

    function populateSelect(select, formats, labeler, emptyText) {
        // Remember the user's choice: updatePickerState() runs whenever the menu is rehydrated, and
        // rebuilding the list used to snap the selection back to the first entry, so picking any
        // other quality appeared not to work.
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
        // Once the picker is open, its data source is the immutable-in-practice
        // snapshot captured at scan completion. Do not let Drive/session refreshes
        // replace it with an empty transient format set during menu rebuilds.
        const pickerFormats = (video.qualityPickerOpen && video.pickerFormats) ? video.pickerFormats : video.formats;
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

    // v1.81: the scan reports, per menu option, whether its click took effect and a matching
    // stream was captured. Tell the user about any that were not, instead of listing a quality
    // that was never really reached.
    function describeScanReport(report, fallback) {
        const list = Array.isArray(report) ? report : [];
        const missed = list.filter(r => r && !r.captured).map(r => `${r.height}p`);
        if (!missed.length) return fallback;
        return `${fallback ? fallback + ' ' : ''}Could not capture ${missed.join(', ')}. open Download again to retry.`.trim();
    }

    async function showQualityPicker(formats, message = '') {
        video.formats = formats || { video: [], audio: [], progressive: [] };
        // Keep a dedicated snapshot for the picker. Drive is free to rebuild the
        // surrounding menu when chrome.debugger detaches; the picker must not
        // depend on Drive's transient menu DOM.
        const src = video.formats || {};
        video.pickerFormats = {
            video: Array.isArray(src.video) ? src.video.map(x => ({ ...x })) : [],
            audio: Array.isArray(src.audio) ? src.audio.map(x => ({ ...x })) : [],
            progressive: Array.isArray(src.progressive) ? src.progressive.map(x => ({ ...x })) : []
        };
        video.qualityStreams = Array.isArray(formats?.qualityStreams) ? formats.qualityStreams : [];
        video.formatsDetectedAt = Date.now();
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heights: new Set([...video.pickerFormats.video, ...video.pickerFormats.progressive].map(f => Number(f.height) || 0).filter(Boolean)).size,
            note: message || ''
        };
        await saveQualitySnapshot();

        const root = ensureQualityPicker();
        const status = root.querySelector('#psd-video-quality-status');
        root.style.display = 'none';
        video.qualityPickerOpen = true;
        video.qualityPickerRestoreOnFileOpen = true;
        video.qualityScanInProgress = false;
        hidePageBlocker();
        updatePickerState();
        if (message) status.textContent = message;
        updateVideoMenuState();

        // Deterministic handoff:
        //  1) make absolutely sure the old File menu is closed,
        //  2) let Drive finish the debugger-detach/menu rebuild,
        //  3) open File once,
        //  4) insert the already-captured picker into that fresh menu.
        // This avoids showing the picker inside the stale menu that Drive destroys
        // when chrome.debugger detaches.
        try {
            await waitForDriveFileMenuClosed(700);
            await new Promise(resolve => setTimeout(resolve, 20));
            const menu = await reopenDriveFileMenu();
            if (!menu) throw new Error('Drive File menu did not reopen after quality detection.');

            // Drive can repaint the new File menu for a few animation frames after the
            // debugger detach completes. Mount only after the menu is real, then refresh
            // the selector data again after each short settle window. This avoids the
            // "picker shell is visible but both selects are empty" state from v1.84.3.
            let mounted = false;
            for (let pass = 0; pass < 6; pass++) {
                mounted = await ensureQualityPickerMounted({ reopenIfMissing: false });
                if (!mounted) {
                    await new Promise(resolve => setTimeout(resolve, 35));
                    continue;
                }
                updatePickerState();
                const liveRoot = document.getElementById('psd-video-quality-picker');
                const videoSelect = liveRoot?.querySelector('#psd-video-quality-video');
                if ((videoSelect?.options?.length || 0) > 0) break;
                await new Promise(resolve => setTimeout(resolve, 45));
            }
            if (!mounted) throw new Error('Quality picker could not be mounted into the reopened File menu.');
            document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID).forEach(normalizeQualityMenuItem);
            updatePickerState();
            startQualityPickerMountWatch();
            return true;
        } catch (_) {
            video.qualityPickerOpen = false;
            video.downloadInProgress = false;
            hidePageBlocker();
            updateVideoMenuState();
            return false;
        }
    }

    async function downloadFromPicker() {
        const root = ensureQualityPicker();
        const videoId = root.querySelector('#psd-video-quality-video').value;
        const pickerFormats = (video.pickerFormats && video.qualityPickerOpen) ? video.pickerFormats : video.formats;
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
            video.downloadInProgress = false;
            video.qualityPickerOpen = true;
            updateVideoMenuState();
            return;
        }
        root.style.display = 'none';
        video.qualityPickerOpen = false;
        clearQualitySnapshot();
        try { app.ui.closeDriveFileMenu(); } catch (_) {}
        // The actual download is background work. Remove any scan veil and leave the
        // Drive page fully interactive while video/audio streams are fetched and merged.
        hidePageBlocker();
        setBlockerPassThrough(true);
        videoOverlay.show(true, response.jobId || null, response.videoBytes || response.mediaBytes || 0, response.audioBytes || 0);
        updateVideoMenuState();
    }

    function parseLegacyFormatEntry(entry, fmtMap, index) {
        const raw = String(entry || '').trim();
        if (!raw) return null;
        try {
            let params = null;
            if (raw.includes('|') && !raw.includes('=url=')) {
                const pieces = raw.split('|');
                const itag = String(pieces.shift() || '').trim();
                const url = decodeURIComponent(pieces.join('|') || '').trim();
                params = new URLSearchParams();
                params.set('itag', itag);
                params.set('url', url);
            } else {
                params = new URLSearchParams(raw);
            }
            const itag = String(params.get('itag') || params.get('format_id') || '').trim();
            const url = params.get('url') || '';
            if (!url) return null;
            const meta = fmtMap.get(itag) || {};
            let parsed;
            try { parsed = new URL(url); } catch (_) { parsed = null; }
            const q = String(params.get('quality') || meta.quality || '').toLowerCase();
            const qualityHeight = /(?:hd)?(2160|1440|1080|720|480|360|240|144)/.exec(q)?.[1];
            const width = Number(meta.width || params.get('width') || 0) || 0;
            const height = Number(meta.height || params.get('height') || qualityHeight || 0) || 0;
            const contentLength = Number(params.get('clen') || 0) || Number(parsed?.searchParams?.get('clen') || 0) || 0;
            const mime = params.get('type')?.split(';')[0] || params.get('mime') || parsed?.searchParams?.get('mime') || 'video/mp4';
            const codecs = params.get('type')?.match(/codecs=\"([^\"]+)/i)?.[1] || params.get('codecs') || parsed?.searchParams?.get('codecs') || '';
            const fps = Number(params.get('fps') || 0) || 0;
            return {
                id: `legacy:${itag || index}:${width}x${height}`,
                url,
                originalUrl: url,
                family: 'legacy',
                kind: 'progressive',
                itag,
                mime: String(mime || 'video/mp4').toLowerCase(),
                width,
                height,
                fps,
                contentLength,
                vcodec: '',
                acodec: /audio\//i.test(mime) ? codecs : codecs,
                quality: q,
                capturedAt: Date.now()
            };
        } catch (_) {
            return null;
        }
    }

    function parseLegacyDriveVideoInfo(text) {
        if (!text || typeof text !== 'string') return { video: [], audio: [], progressive: [] };
        let data;
        try { data = new URLSearchParams(text); } catch (_) { return { video: [], audio: [], progressive: [] }; }
        const status = String(data.get('status') || '').toLowerCase();
        if (status && status !== 'ok') return { video: [], audio: [], progressive: [] };

        const fmtMap = new Map();
        const fmtList = String(data.get('fmt_list') || '');
        for (const item of fmtList.split(',')) {
            const bits = item.split('/');
            const itag = String(bits[0] || '').trim();
            const dims = String(bits[1] || '').match(/^(\d+)x(\d+)$/);
            if (itag && dims) fmtMap.set(itag, { width: Number(dims[1]), height: Number(dims[2]), quality: '' });
        }

        const maps = [
            ['progressive', data.get('url_encoded_fmt_stream_map')],
            ['progressive', data.get('fmt_stream_map')],
            ['adaptive', data.get('adaptive_fmts')]
        ].filter(([, value]) => !!value);
        const result = { video: [], audio: [], progressive: [] };
        const seen = new Set();

        for (const [family, streamMap] of maps) {
            for (const entry of String(streamMap).split(',')) {
                const fmt = parseLegacyFormatEntry(entry, fmtMap, result.progressive.length + result.video.length + result.audio.length);
                if (!fmt || seen.has(fmt.url)) continue;
                seen.add(fmt.url);
                const mime = String(fmt.mime || '').toLowerCase();
                const isAudio = /audio\//i.test(mime) || /mp4a|opus|vorbis|aac/i.test(String(fmt.acodec || fmt.mime || '')) || (!fmt.height && !/video\//i.test(mime));
                const isVideo = fmt.height > 0 || /video\//i.test(mime);
                if (family === 'adaptive') {
                    if (isVideo && !isAudio) result.video.push(fmt);
                    else if (isAudio && !isVideo) result.audio.push(fmt);
                    else if (isVideo) result.video.push(fmt);
                } else if (isVideo) {
                    result.progressive.push(fmt);
                } else if (isAudio) {
                    result.audio.push(fmt);
                }
            }
        }
        result.video.sort((a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength));
        result.audio.sort((a,b) => b.contentLength-a.contentLength);
        result.progressive.sort((a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength));
        return result;
    }

    async function probeLegacyDriveVideoInfo(fileId) {
        if (!fileId || !isVideoViewerOpen()) return null;
        const authuser = new URL(location.href).searchParams.get('authuser');
        const paths = [
            '/get_video_info',
            '/e/get_video_info'
        ];
        for (const path of paths) {
            try {
                const url = new URL(path, location.origin);
                url.searchParams.set('docid', fileId);
                if (authuser != null && authuser !== '') url.searchParams.set('authuser', authuser);
                const response = await fetch(url.toString(), { credentials: 'include', cache: 'no-store', headers: { 'Accept': 'text/plain,text/html,*/*' } });
                if (!response.ok) continue;
                const text = await response.text();
                const formats = parseLegacyDriveVideoInfo(text);
                if (formats.progressive.length || formats.video.length || formats.audio.length) {
                    const register = await sendRuntime({ action: 'registerVideoFormats', fileId, formats });
                    if (register?.success && register.formats) return register.formats;
                    return formats;
                }
            } catch (error) {
                console.debug('[GDrive Downloader] legacy pre-playback probe failed:', error?.message || error);
            }
        }
        return null;
    }

    async function runAutomatedPlayerQualityScan() {
        if (!video.fileId || !isVideoViewerOpen()) return null;
        try {
            const response = await sendRuntime({ action: 'automatedQualityScan', fileId: video.fileId });
            if (response?.success && response.formats) {
                video.formats = response.formats;
                video.formatsDetectedAt = Date.now();
                setVideoDownloadState(!!(response.formats.video?.length || response.formats.progressive?.length));
                if (video.qualityPickerOpen) updatePickerState();
                return response.formats;
            }
            if (response?.error) console.debug('[GDrive Downloader] automated quality scan:', response.error);
        } catch (error) {
            console.debug('[GDrive Downloader] automated quality scan failed:', error?.message || error);
        }
        return null;
    }

    async function detectAvailableFormats(force = false) {
        if (!video.fileId || !isVideoViewerOpen()) return null;
        if (!force && video.formatsDetectedAt && Date.now() - video.formatsDetectedAt < 60000 &&
            (video.formats?.video?.length || video.formats?.progressive?.length)) return video.formats;

        // Primary path: drive the actual Drive player's Settings -> Quality menu.
        // This is intentionally done only from an explicit download/refresh action,
        // so simply opening or refreshing a Drive page never starts playback.
        const scanned = await runAutomatedPlayerQualityScan();
        if (scanned?.video?.length || scanned?.progressive?.length) return scanned;

        // Secondary path: Drive metadata endpoints. These can still help on builds
        // where the player exposes the formats before the DOM menu is usable.
        const legacy = await probeLegacyDriveVideoInfo(video.fileId);
        if (legacy?.progressive?.length || legacy?.video?.length || legacy?.audio?.length) {
            video.formats = mergeFormatSets(video.formats, legacy);
            video.formatsDetectedAt = Date.now();
            setVideoDownloadState(true);
            if (video.qualityPickerOpen) updatePickerState();
        }

        try {
            const response = await sendRuntime({ action: 'probeVideoFormats', fileId: video.fileId });
            if (response?.success && response.formats) {
                video.formats = mergeFormatSets(video.formats, response.formats);
                video.formatsDetectedAt = Date.now();
                setVideoDownloadState(true);
                if (video.qualityPickerOpen) updatePickerState();
                return video.formats;
            }
        } catch (_) {}

        return (video.formats?.video?.length || video.formats?.progressive?.length || video.formats?.audio?.length) ? video.formats : null;
    }

    function stableFormatKey(fmt) {
        const itag = String(fmt?.itag || '').trim();
        if (itag) return `${fmt?.kind || 'format'}|itag:${itag}`;
        return `${fmt?.kind || 'format'}|${Number(fmt?.width)||0}x${Number(fmt?.height)||0}|${fmt?.mime||''}|${fmt?.vcodec||''}|${fmt?.acodec||''}|${Number(fmt?.contentLength)||0}`;
    }

    function mergeFormatSets(base = {}, extra = {}) {
        const merge = (a, b, sort) => {
            const map = new Map();
            for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
                if (!item?.url) continue;
                const key = stableFormatKey(item);
                const current = map.get(key);
                if (!current || Number(item.capturedAt || 0) >= Number(current.capturedAt || 0)) map.set(key, item);
            }
            return [...map.values()].sort(sort);
        };
        return {
            video: merge(base.video, extra.video, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength)),
            audio: merge(base.audio, extra.audio, (a,b) => b.contentLength-a.contentLength),
            progressive: merge(base.progressive, extra.progressive, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength))
        };
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

    // A completed scan is reused: signed stream URLs stay valid for a long time, so a second
    // click on Download just reopens the picker instead of replaying the whole detection.
    function cachedScanUsable() {
        const cache = video.scanCache;
        if (!cache || !video.fileId || cache.fileId !== video.fileId) return false;
        const videos = [...(video.formats?.video || []), ...(video.formats?.progressive || [])];
        const all = [...videos, ...(video.formats?.audio || [])].filter(f => f?.url);
        if (!videos.length || !all.length) return false;
        const heights = new Set(videos.map(f => Number(f.height) || 0).filter(Boolean));
        if (heights.size < cache.heights) return false;
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
            heights: new Set(videos.map(f => Number(f.height) || 0).filter(Boolean)).size,
            note: describeScanReport(scanReport, '')
        };
    }

    async function startVideoFromMenu(anchorRect) {
        if (anchorRect) video.menuAnchorRect = anchorRect;
        if (video.qualityPickerOpen) { positionQualityPicker(); return; }
        if (video.downloadInProgress) return;
        if (cachedScanUsable() || hasUsableFormats(video.pickerFormats)) {
            app.ui.closeDriveFileMenu();
            video.downloadInProgress = true;
            showQualityPicker(video.pickerFormats || video.formats, video.scanCache?.note || '');
            return;
        }
        video.downloadInProgress = true;
        video.qualityPickerOpen = false;
        updateVideoMenuState();
        showPageBlocker(SCAN_VEIL_TEXT, 'scan');

        // IMPORTANT: kick the real Drive player in the same synchronous task as
        // the user's Download click.  The previous build waited for a runtime
        // message/context round-trip before calling play(), which meant Chrome
        // no longer considered the action user-initiated and Drive could stay
        // paused.  We intentionally do this BEFORE the first await.
        app.ui.closeDriveFileMenu();
        // The first thing the scan must see is a genuinely closed Drive File menu.
        // Waiting here prevents the debugger/CDP scan from racing Drive's own menu
        // teardown and guarantees the picker is reopened only after the scan ends.
        await waitForDriveFileMenuClosed(1200);
        const immediatePlaybackKick = startDrivePlayerFromUserGesture();
        video.qualityScanInProgress = true;
        if (immediatePlaybackKick?.started) {
            video.playbackStarted = true;
        }

        try {
            // Establish the fresh file/session first, but do not lose the already
            // started media element.  The player can keep running while the worker
            // resets its capture state.
            const context = await syncViewerContext(true);
            if (!context?.fileId) {
                throw new Error('Could not identify the current Drive video before starting quality detection.');
            }
            // Do NOT reset the current stream list here. If the user has already
            // played multiple Drive qualities, those URLs are exactly what we want
            // to retain and surface. Clear only temporary quality-probe state.
            await sendRuntime({ action:'prepareQualityScan', fileId:video.fileId });
            video.formatsDetectedAt = 0;

            // Do not show the picker while scanning. The integrated V24 path now
            // runs only after this explicit click kick has started the player, then
            // opens Settings → Quality, clicks real options, captures their real
            // videoplayback requests, probes sizes in the background, and finally
            // presents the selector.
            const response = await sendRuntime({ action:'automatedQualityScan', fileId:video.fileId });
            const formats = response?.success ? response.formats : null;
            if (formats && (formats.video?.length || formats.progressive?.length)) {
                await showQualityPicker(formats, describeScanReport(response?.scanReport, ''));
                rememberCompletedScan(response?.scanReport);
                return;
            }

            // A manually playing player is still a valid fallback.  Only show the
            // picker if we actually have a usable captured stream.  Never create an
            // empty picker merely to display an error: that was the source of the
            // immediate overlay seen in the previous build.
            const fallback = await captureExistingStreamsAndPick();
            if (fallback.success) {
                await showQualityPicker(fallback.formats, 'Using the stream(s) currently playing in Drive.');
                return;
            }

            console.warn('[GDrive Downloader] quality detection did not produce a usable stream:', response?.error || fallback?.error);
            video.downloadInProgress = false;
            video.qualityPickerOpen = false;
            video.qualityScanInProgress = false;
            hidePageBlocker();
            updateVideoMenuState();
        } catch (error) {
            console.error('[GDrive Downloader] video quality detection failed:', error);
            video.downloadInProgress = false;
            video.qualityPickerOpen = false;
            video.qualityScanInProgress = false;
            hidePageBlocker();
            updateVideoMenuState();
        }
    }

    function installVideoMenuClickGuard() {
        if (window.__PSD_VIDEO_MENU_CLICK_GUARD) return;
        window.__PSD_VIDEO_MENU_CLICK_GUARD = true;
        const activate = (item, event) => {
            if (!item || (event.target?.closest?.('#psd-video-quality-picker')) || (video.downloadInProgress && !video.qualityPickerOpen)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            item.dataset.activationInProgress = 'true';
            setTimeout(() => { item.dataset.activationInProgress = 'false'; }, 1800);
            // Capture where the item is NOW; Drive closes its menu as soon as it is clicked.
            const r = item.getBoundingClientRect();
            startVideoFromMenu({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
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
                // In a content script we do not have a direct tab id. The service
                // worker sends format/context messages below; storage changes are
                // therefore treated only as a convenient refresh when the session
                // signature already matches this viewer.
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
            const originOk = (() => { const o = String(event.origin || '').toLowerCase(); const h = (() => { try { return new URL(o).hostname; } catch (_) { return ''; } })(); return h === 'drive.google.com' || h.endsWith('.drive.google.com') || h === location.hostname || h.endsWith('.googleusercontent.com'); })();
            if (!originOk) return;
            if (data.bridgeId) video.pageBridgeId = String(data.bridgeId);
            // Ask the main-world bridge to replay resource URLs that may already
            // have been requested before the isolated content script initialized.
            // Do this ONCE per announcement: the bridge answers every replay request with another
            // READY, so answering each READY produced an endless message loop (about 30,000
            // messages/second) that kept the Drive tab's main thread ~100% busy and starved the
            // PDF OCR.
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
        const originOk = (() => { const o = String(event.origin || '').toLowerCase(); const h = (() => { try { return new URL(o).hostname; } catch (_) { return ''; } })(); return h === 'drive.google.com' || h.endsWith('.drive.google.com') || h === location.hostname || h.endsWith('.googleusercontent.com'); })();
        if (!originOk) return;
        // The page-world bridge runs in every frame. Child-player frames post
        // their URLs to window.top, so event.source can legitimately be a
        // descendant frame rather than the top window. Trust the already-
        // validated Drive/Google origin instead of discarding those streams.
        if (typeof data.url !== 'string' || !data.url.includes('videoplayback')) return;
        if (!isVideoViewerOpen()) return;

        // Make sure the worker has the current file/viewer session before accepting
        // a URL. This keeps the page-world interception early while still binding
        // every captured URL to the current Drive viewer.
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
                video.streamDetected = true;
                if (response.session?.formats) video.formats = response.session.formats;
                updateVideoMenuState();
                if (video.qualityPickerOpen) updatePickerState();
            }
        } catch (_) {}
    }

    function installPageNetworkBridgeRelay() {
        if (window.top !== window || window.__PSD_PAGE_BRIDGE_RELAY) return;
        window.__PSD_PAGE_BRIDGE_RELAY = true;
        window.addEventListener('message', event => {
            handlePageBridgeMessage(event).catch(() => {});
        }, true);
        // Request a buffered replay once immediately and again shortly after the
        // Drive viewer/player has finished bootstrapping.
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

    const setVideoBusy = busy => {
        video.downloadInProgress = busy;
        updateVideoMenuState();
    };

    async function scanViewerState() {
        const open = isVideoViewerOpen();
        if (open !== video.lastViewerState) {
            if (open) {
                video.lastContextSignature = '';
                video.viewerSessionId = '';
                video.fileId = '';
                video.streamDetected = false;
                video.playbackStarted = false;
                video.lastFilenameSent = '';
                await syncViewerContext(true);
            } else {
                if (!video.downloadInProgress) hidePageBlocker();
                const root = document.getElementById('psd-video-quality-picker');
                if (root) { root.style.display = 'none'; if (root.parentElement?.closest?.('[role="menu"]')) root.remove(); }
                stopQualityPickerMountWatch();
                video.qualityPickerOpen = false;
                video.downloadInProgress = false;
                video.lastContextSignature = '';
                video.fileId = '';
                video.viewerSessionId = '';
            video.formats = { video: [], audio: [], progressive: [] };
            clearQualitySnapshot();
            video.formatsDetectedAt = 0;
            }
            updateVideoMenuState();
            video.lastViewerState = open;
        } else if (open) {
            // Drive can replace the file inside the same viewer dialog without
            // toggling the dialog itself. Detect that transition explicitly.
            await syncViewerContext(false);
            updateCapturedVideoFilename();
        }
    }

    async function ensureCachedQualityPickerForCurrentFile() {
        // The File menu is ephemeral. Closing/reopening it must not require a new
        // debugger scan. Restore the completed quality snapshot first, then treat
        // it as the source of truth for the picker.
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
        if (!video.qualityPickerRestoreOnFileOpen) return false;
        if (!getVisibleDriveMenu()) return false;
        if (video.downloadInProgress && video.qualityPickerOpen) return;
        const restored = await ensureCachedQualityPickerForCurrentFile();
        if (!restored || !hasUsableFormats(video.pickerFormats)) return false;

        // IMPORTANT: ensureQualityPickerMounted() intentionally refuses to mount
        // while qualityPickerOpen is false. Reopening File after the previous
        // menu was dismissed therefore must mark the cached picker active BEFORE
        // mounting it. The old build forgot this handoff, so the data stayed cached
        // but the selector never came back into the newly-created Drive menu.
        video.qualityPickerOpen = true;
        video.downloadInProgress = true;
        video.formats = {
            video: Array.isArray(video.pickerFormats.video) ? video.pickerFormats.video.map(x => ({ ...x })) : [],
            audio: Array.isArray(video.pickerFormats.audio) ? video.pickerFormats.audio.map(x => ({ ...x })) : [],
            progressive: Array.isArray(video.pickerFormats.progressive) ? video.pickerFormats.progressive.map(x => ({ ...x })) : []
        };
        updateVideoMenuState();
        updatePickerState();
        const mounted = await ensureQualityPickerMounted({ reopenIfMissing: false });
        if (mounted) startQualityPickerMountWatch();
        return mounted;
    }

    function scanMenu(menu) {
        const securityRow = app.ui.findMenuRow(menu, 'Security limitations');
        const printRow = app.ui.findMenuRow(menu, 'Print');
        if (securityRow && !printRow && !app.ui.findMenuRow(menu, 'Download')) addProtectedVideoMenuItem(menu);
        // Cached quality restoration is triggered by an actual File-button OPEN event
        // (see installDriveFileMenuRestore below), not by generic menu mutations.
        // This prevents a File-button click that CLOSES the menu from immediately
        // reopening it through the cache-restoration path.
    }

    function installDriveFileMenuRestore() {
        if (window.__PSD_FILE_MENU_QUALITY_RESTORE) return;
        window.__PSD_FILE_MENU_QUALITY_RESTORE = true;

        const isFileButton = target => {
            if (!target?.closest) return false;
            const button = target.closest('[role="button"],button');
            if (!button || !button.offsetParent) return false;
            const label = String(button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            const text = String(button.textContent || '').replace(/\s+/g, ' ').trim();
            return label === 'File' || text === 'File';
        };

        // Drive toggles the File menu asynchronously. Reading the menu on pointerdown
        // races Drive and can mistake the CLOSE click for an OPEN click. Instead, wait
        // until Drive has applied the toggle, then restore only when the File menu is
        // actually open. This makes CLOSE -> OPEN deterministic and never reopens a menu
        // that the user just dismissed.
        const restoreAfterToggle = () => {
            if (video.qualityScanInProgress) return;
            if (!video.qualityPickerRestoreOnFileOpen || !video.fileId) return;
            const button = getDriveFileButton();
            const expanded = String(button?.getAttribute('aria-expanded') || '').toLowerCase();
            const menu = getVisibleDriveMenu();
            if (expanded === 'false' || !menu) return;
            remountCachedQualityPicker().catch(() => {});
        };

        document.addEventListener('pointerdown', event => {
            if (!isFileButton(event.target)) return;
            setTimeout(restoreAfterToggle, 0);
            setTimeout(restoreAfterToggle, 35);
            setTimeout(restoreAfterToggle, 90);
            setTimeout(restoreAfterToggle, 160);
        }, true);
    }

    function initMessaging() {
        chrome.runtime.onMessage.addListener(msg => {
            if (window.top !== window.self || !videoStageTypes.has(msg?.type)) return;
            if (msg.type === 'videoFormatsDetected') {
                const sameFile = !msg.fileId || !video.fileId || msg.fileId === video.fileId;
                const sameViewer = !msg.viewerSessionId || !video.viewerSessionId || msg.viewerSessionId === video.viewerSessionId;
                if (sameFile && sameViewer) {
                    video.formats = msg.formats || { video: [], audio: [], progressive: [] };
                    video.formatsDetectedAt = Date.now();
                    setVideoDownloadState(true);
                    if (video.qualityPickerOpen) updatePickerState();
                }
                return;
            }
            if (msg.type === 'videoStreamDetected') {
                const sameFile = !msg.fileId || !video.fileId || msg.fileId === video.fileId;
                const sameViewer = !msg.viewerSessionId || !video.viewerSessionId || msg.viewerSessionId === video.viewerSessionId;
                if (sameFile && sameViewer) {
                    if (msg.formats) video.formats = msg.formats;
                    video.formatsDetectedAt = Date.now();
                    console.debug('[GDrive Downloader] live Drive stream detected', msg.stream || msg.formats);
                    video.playbackStarted = true;
                    setVideoDownloadState(true);
                    if (video.qualityPickerOpen) updatePickerState();
                }
                return;
            }
            if (msg.type === 'videoAutomationBlocker') {
                // V24 uses trusted CDP pointer events to open Settings and Quality.
                // Those events must temporarily pass through our page blocker so
                // they land on Drive's real controls instead of the blocker.
                if (video.qualityScanInProgress) {
                    // Scanning: the page stays dimmed the whole time. During the extension's own
                    // trusted clicks the veil stays visible but lets those clicks through.
                    // (downloadInProgress is ALSO true while scanning, so it cannot be used here;
                    // testing it made this handler hide the veil on every message.)
                    if (msg.visible) showPageBlocker(SCAN_VEIL_TEXT, 'scan');
                    else setBlockerPassThrough(true);
                } else {
                    // During the download itself there is intentionally no blocking veil.
                    hidePageBlocker();
                    setBlockerPassThrough(true);
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
