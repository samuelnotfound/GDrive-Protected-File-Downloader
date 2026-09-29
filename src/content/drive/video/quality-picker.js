
(() => {
    const app = window.__PSD;
    const video = app.videoState;
    const core = app.videoCore;
    const { sleep, waitUntil } = window.__PSD_CONTENT_UTILS;
    const VIDEO_MENU_ID = app.ids.videoMenu;
    const videoOverlay = window.GDriveVideoOverlay;

    const SCAN_VEIL_TEXT = 'Checking video quality';
    let qualityPickerObserver = null;
    let qualityPickerWatchTimer = null;
    let qualityPickerMounting = false;
    let qualityPickerRehydrating = false;
    let qualityPickerRestorePromise = null;

    // Prefer the player's real Quality menu labels (scanned from the DOM),
    // same idea as Drive Quality Trigger's scanQualities() → renderQualityList().
    // Only surfaces heights the menu actually offered, never assumed itag heights.
    function getDisplayVideoFormats(formats = [], menuOptions = null) {
        const score = item =>
            (/video\/mp4/i.test(String(item.mime || '')) ? 1_000_000_000 : 0) +
            Number(item.contentLength || 0) +
            Number(item.capturedAt || 0) / 1e9;

        const byHeight = new Map();
        for (const format of Array.isArray(formats) ? formats : []) {
            if (!format?.url) continue;
            // qualityHeight (menu probe) always wins over raw height (itag guess).
            const height = Number(format.qualityHeight || format.height) || 0;
            if (!height) continue;
            const normalized = { ...format, height, qualityHeight: height };
            const current = byHeight.get(height);
            if (!current || score(normalized) > score(current)) byHeight.set(height, normalized);
        }

        // Also index by probeQuality label so a stream tagged "480p" during
        // probing can be matched even if its itag height said something else.
        const byProbeLabel = new Map();
        for (const format of Array.isArray(formats) ? formats : []) {
            if (!format?.url) continue;
            const label = String(format.probeQuality || format.menuLabel || '').trim().toLowerCase();
            if (!label) continue;
            const height = Number(format.qualityHeight || format.height) || 0;
            const normalized = { ...format, height: height || Number(label.match(/(\d{3,4})p/i)?.[1] || 0), qualityHeight: height };
            const current = byProbeLabel.get(label);
            if (!current || score(normalized) > score(current)) byProbeLabel.set(label, normalized);
        }

        const menu = Array.isArray(menuOptions) ? menuOptions : (video.qualityMenuOptions || []);
        const menuHeights = menu
            .map(option => ({
                height: Number(option?.height || 0),
                label: String(option?.text || option?.label || '').trim()
            }))
            .filter(option => option.height > 0);

        // Live menu is the only source of truth when we have it — never invent
        // 1080p/720p that the player did not list (same as Drive Quality Trigger).
        if (menuHeights.length) {
            const seen = new Set();
            const ordered = [];
            for (const option of menuHeights.sort((a, b) => b.height - a.height)) {
                if (seen.has(option.height)) continue;
                const labelKey = (option.label || `${option.height}p`).toLowerCase();
                const stream =
                    byHeight.get(option.height) ||
                    byProbeLabel.get(labelKey) ||
                    byProbeLabel.get(`${option.height}p`);
                if (!stream?.url) continue;
                seen.add(option.height);
                ordered.push({
                    ...stream,
                    height: option.height,
                    qualityHeight: option.height,
                    menuLabel: option.label || `${option.height}p`
                });
            }
            // If menu matching produced nothing (probe race / missing pairs)
            // fall through to captured streams so the picker is not empty.
            if (ordered.length) return ordered;
        }

        // Fallback: no menu snapshot — show captured streams, dropping pure itag guesses.
        return [...byHeight.values()]
            .filter(stream => {
                const source = String(stream.heightSource || '').toLowerCase();
                if (Number(stream.qualityHeight || 0) > 0) return true;
                if (source === 'probe' || source === 'url') return true;
                if (source === 'itag' || source === '') {
                    return !!String(stream.probeQuality || '').trim();
                }
                return true;
            })
            .sort((a, b) =>
                (Number(b.height || 0) - Number(a.height || 0)) ||
                (Number(b.contentLength || 0) - Number(a.contentLength || 0))
            );
    }

    const formatVideoLabel = format => {
        if (format?.menuLabel) return format.menuLabel;
        const height = Number(format?.height) || 0;
        const width = Number(format?.width) || 0;
        return height ? `${height}p` : (width ? `${width}px` : 'Video');
    };

    let scanCancelled = false;

    function ensureScanPageBlocker() {
        let root = document.getElementById('psd-video-scan-blocker');
        if (root) return root;

        root = document.createElement('div');
        root.id = 'psd-video-scan-blocker';
        root.setAttribute('role', 'presentation');
        // Dim matches PDF scroll dim; card matches other overlays (bottom-right 360px).
        root.innerHTML = `
            <style>
                #psd-video-scan-blocker{
                    position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;
                    margin:0 !important;padding:0 !important;border:0 !important;
                    background:rgba(0,0,0,.80) !important;
                    z-index:2147483646 !important;pointer-events:none !important;display:none !important;
                    box-sizing:border-box !important;cursor:default !important;user-select:none !important;
                }
                #psd-video-scan-blocker[data-open="true"]{pointer-events:auto !important;display:block !important;}
                #psd-video-scan-card{
                    position:absolute !important;right:24px !important;bottom:24px !important;left:auto !important;
                    display:flex !important;align-items:center !important;gap:14px !important;
                    width:360px !important;max-width:calc(100vw - 32px) !important;box-sizing:border-box !important;
                    padding:16px 18px !important;border-radius:20px !important;
                    background:#28292a !important;color:#e3e3e3 !important;
                    box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2) !important;
                    font:500 14px/1.4 'Google Sans',Roboto,Arial,sans-serif !important;
                    pointer-events:auto !important;
                }
                #psd-video-scan-card .psd-scan-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}
                #psd-video-scan-card .psd-scan-text{font:500 15px/20px 'Google Sans',Roboto,Arial,sans-serif;color:#e3e3e3;letter-spacing:.1px;}
                #psd-video-scan-card .psd-scan-hint{font:400 13px/1.4 Roboto,Arial,sans-serif;color:#c4c7c5;}
                #psd-video-scan-cancel{
                    flex:0 0 auto;border:none;outline:none;border-radius:20px;padding:7px 18px;
                    background:rgba(168,199,250,.12);color:#a8c7fa;cursor:pointer;
                    font:500 13px 'Google Sans',Roboto,sans-serif;
                }
                #psd-video-scan-cancel:hover{background:rgba(168,199,250,.22);}
            </style>
            <div id="psd-video-scan-card" role="status" aria-live="polite">
                <div class="psd-scan-copy">
                    <span class="psd-scan-text">Checking video quality</span>
                    <span class="psd-scan-hint">This only takes a moment</span>
                </div>
                <button id="psd-video-scan-cancel" type="button">Cancel</button>
            </div>`;
        document.documentElement.appendChild(root);
        root.querySelector('#psd-video-scan-cancel').addEventListener('click', () => {
            scanCancelled = true;
            hidePageBlocker();
            try { video.operation = 'idle'; } catch (_) {}
            try { app.video?.updateMenuState?.(); } catch (_) {}
        });
        return root;
    }

    function isScanCancelled() {
        return !!scanCancelled;
    }

    function showPageBlocker(message = SCAN_VEIL_TEXT) {
        if (window.top !== window.self) return;
        scanCancelled = false;
        const blocker = ensureScanPageBlocker();
        const textEl = blocker.querySelector('.psd-scan-text');
        if (textEl) textEl.textContent = message || SCAN_VEIL_TEXT;
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
            const target = event.target;
            const inUi = !!(
                target?.closest?.('#psd-video-quality-picker') ||
                target?.closest?.('#psd-video-quality-menu')
            );
            if (!inUi) return;

            // Stop Drive menu handlers; we handle UI ourselves in capture phase.
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (event.type !== 'click') return;
            event.preventDefault();

            const root = document.getElementById('psd-video-quality-picker');
            if (!root) return;

            if (target.closest('#psd-video-quality-download')) {
                setQualityDropdownOpen(root, false);
                const btn = root.querySelector('#psd-video-quality-download');
                if (btn?.disabled || video.operation === 'staging' || videoOverlay.getJobId?.()) return;
                void downloadFromPicker();
                return;
            }

            if (target.closest('#psd-video-quality-trigger')) {
                const trigger = root.querySelector('#psd-video-quality-trigger');
                if (trigger?.getAttribute('aria-disabled') === 'true') return;
                setQualityDropdownOpen(root, !root.classList.contains('open'));
                return;
            }

            const option = target.closest('.psd-quality-option');
            if (option && !option.disabled) {
                const select = root.querySelector('#psd-video-quality-video');
                const labelEl = root.querySelector('.psd-quality-trigger-label');
                const value = option.dataset.value || '';
                if (select) select.value = value;
                if (labelEl) labelEl.textContent = option.textContent || value;
                // Remember height so download can resolve even if format ids collide.
                try {
                    video.lastSelectedQuality = (option.textContent || '').trim();
                    video.lastSelectedHeight = Number(option.dataset.height || 0) || 0;
                } catch (_) {}
                document.querySelectorAll('#psd-video-quality-menu .psd-quality-option').forEach(node => {
                    node.setAttribute('aria-selected', node === option ? 'true' : 'false');
                });
                setQualityDropdownOpen(root, false);
                // Same enable rules as updatePickerState — never enable on value alone.
                updateDownloadEnabled(root);
            }
        };

        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown']) {
            window.addEventListener(type, blockPickerEvent, true);
        }
    }

    function syncQualityPickerTypography() {
        /* typography is owned by the template CSS */
    }

    const QUALITY_PICKER_TEMPLATE = `
            <style>
                #psd-video-quality-picker{
                    display:none;box-sizing:border-box;width:100%;
                    margin:10px 0 4px;padding:0;
                    font:500 14px/20px 'Google Sans',Roboto,Arial,sans-serif;
                    color:#e8eaed;background:transparent;border:0;
                    position:relative;z-index:5;pointer-events:auto;
                    -webkit-font-smoothing:antialiased;
                }
                #psd-video-quality-picker .psd-quality-row{
                    display:flex;align-items:center;gap:6px;width:100%;
                    min-width:0;
                }
                #psd-video-quality-picker .psd-quality-field{
                    flex:0 1 96px;width:96px;min-width:84px;max-width:110px;
                    margin:0;padding:0;position:relative;
                }
                #psd-video-quality-trigger{
                    display:flex;align-items:center;justify-content:space-between;gap:4px;
                    width:100%;height:32px;box-sizing:border-box;
                    padding:0 8px 0 10px;
                    border:1px solid rgba(255,255,255,.12);
                    border-radius:999px;
                    background:#3c4043;color:#e8eaed;
                    cursor:pointer;outline:none;
                    font:500 13px/18px 'Google Sans',Roboto,Arial,sans-serif;
                }
                #psd-video-quality-trigger:hover{background:#44474a;border-color:rgba(255,255,255,.18);}
                #psd-video-quality-trigger[aria-disabled="true"]{opacity:.55;cursor:default;}
                #psd-video-quality-picker.open #psd-video-quality-trigger{
                    border-radius:10px 10px 0 0;
                    border-bottom-color:transparent;
                    background:#3c4043;
                }
                #psd-video-quality-trigger .psd-quality-trigger-label{
                    flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:clip;
                }
                #psd-video-quality-trigger .psd-quality-chevron{
                    flex:0 0 auto;width:16px;height:16px;display:grid;place-items:center;color:#c4c7c5;
                }
                #psd-video-quality-picker.open #psd-video-quality-trigger .psd-quality-chevron{
                    transform:rotate(180deg);
                }
                #psd-video-quality-menu{
                    display:none;
                    position:fixed;
                    z-index:2147483647;
                    box-sizing:border-box;
                    padding:3px;
                    background:#3c4043;
                    border:1px solid rgba(255,255,255,.12);
                    border-top-color:rgba(255,255,255,.08);
                    border-radius:0 0 10px 10px;
                    max-height:160px;
                    overflow-x:hidden;overflow-y:auto;
                    pointer-events:auto;
                    scrollbar-width:thin;
                    scrollbar-color:rgba(255,255,255,.2) transparent;
                }
                #psd-video-quality-menu[data-open="true"]{display:block;}
                #psd-video-quality-menu::-webkit-scrollbar{width:6px;}
                #psd-video-quality-menu::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:6px;}
                .psd-quality-option{
                    display:flex;align-items:center;justify-content:space-between;gap:8px;
                    width:100%;box-sizing:border-box;
                    margin:0;padding:7px 8px;
                    border:0;border-radius:6px;
                    background:transparent;color:#e8eaed;
                    font:400 13px/18px 'Google Sans',Roboto,Arial,sans-serif;
                    text-align:left;cursor:pointer;outline:none;
                }
                .psd-quality-option:hover{background:rgba(255,255,255,.06);}
                .psd-quality-option[aria-selected="true"]{font-weight:700;background:transparent;}
                .psd-quality-option[aria-selected="true"]::after{
                    content:"";flex:0 0 auto;width:14px;height:14px;
                    background:center / 14px 14px no-repeat
                      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e8eaed' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='M5 13l4 4L19 7'/></svg>");
                }
                .psd-quality-option[disabled]{opacity:.5;cursor:default;}
                #psd-video-quality-actions{flex:0 0 auto;}
                #psd-video-quality-download{
                    display:inline-flex;align-items:center;justify-content:center;gap:6px;
                    height:32px;box-sizing:border-box;
                    padding:0 12px;
                    border:1px solid rgba(255,255,255,.12);
                    border-radius:999px;
                    background:#3c4043;color:#e8eaed;
                    font:500 13px/18px 'Google Sans',Roboto,Arial,sans-serif;
                    cursor:pointer;outline:none;white-space:nowrap;
                    flex:0 0 auto;flex-shrink:0;
                }
                #psd-video-quality-download:hover{background:#44474a;border-color:rgba(255,255,255,.18);}
                #psd-video-quality-download:disabled{opacity:.5;cursor:default;}
                #psd-video-quality-download::before{
                    content:"";width:16px;height:16px;flex:0 0 auto;
                    background:center / 16px 16px no-repeat
                      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e8eaed' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='M8 11l4 4 4-4'/><path d='M4 21h16'/></svg>");
                }
                #psd-video-quality-status{
                    margin:6px 0 0;padding:0 2px;
                    font:400 11px/14px Roboto,Arial,sans-serif;
                    color:rgba(255,255,255,.62);
                }
                #psd-video-quality-status:empty{display:none;}
            </style>
            <div class="psd-quality-row">
                <div class="psd-quality-field">
                    <button type="button" id="psd-video-quality-trigger" aria-haspopup="listbox" aria-expanded="false">
                        <span class="psd-quality-trigger-label">Quality</span>
                        <span class="psd-quality-chevron" aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </span>
                    </button>
                    <input type="hidden" id="psd-video-quality-video" value="" />
                </div>
                <div id="psd-video-quality-actions">
                    <button id="psd-video-quality-download" type="button">Download</button>
                </div>
            </div>
            <div id="psd-video-quality-status"></div>
            <div id="psd-video-quality-menu" role="listbox" aria-label="Video quality"></div>`;

    function positionQualityMenu(root) {
        const trigger = root?.querySelector('#psd-video-quality-trigger');
        const menu = document.getElementById('psd-video-quality-menu');
        if (!trigger || !menu) return;

        const rect = trigger.getBoundingClientRect();
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.width = `${Math.round(rect.width)}px`;
        menu.style.top = `${Math.round(rect.bottom - 1)}px`;
    }

    function setQualityDropdownOpen(root, open) {
        const picker = root || document.getElementById('psd-video-quality-picker');
        const menu = document.getElementById('psd-video-quality-menu');
        const trigger = picker?.querySelector('#psd-video-quality-trigger');

        if (picker) {
            picker.classList.toggle('open', !!open);
            if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }

        if (!menu) return;

        if (open && picker) {
            if (menu.parentElement !== document.body) document.body.appendChild(menu);
            menu.dataset.open = 'true';
            menu.style.display = 'block';
            positionQualityMenu(picker);
            requestAnimationFrame(() => positionQualityMenu(picker));
        } else {
            delete menu.dataset.open;
            menu.style.left = '';
            menu.style.top = '';
            menu.style.width = '';
            menu.style.display = 'none';
        }
    }

    function closeQualityDropdown() {
        setQualityDropdownOpen(document.getElementById('psd-video-quality-picker'), false);
    }

    function bindQualityPickerEvents(root) {
        // Close list on any outside interaction.
        const maybeClose = event => {
            const menu = document.getElementById('psd-video-quality-menu');
            if (!menu || menu.dataset.open !== 'true') return;
            const t = event.target;
            if (t?.closest?.('#psd-video-quality-trigger')) return;
            if (t?.closest?.('#psd-video-quality-menu')) return;
            closeQualityDropdown();
        };

        document.addEventListener('pointerdown', maybeClose, true);
        document.addEventListener('mousedown', maybeClose, true);
        document.addEventListener('click', maybeClose, true);

        // If the Drive file menu closes or picker is hidden, drop the floating list.
        const observer = new MutationObserver(() => {
            const menu = document.getElementById('psd-video-quality-menu');
            if (!menu || menu.dataset.open !== 'true') return;
            const picker = document.getElementById('psd-video-quality-picker');
            const hidden = !picker || picker.style.display === 'none' || !picker.offsetParent;
            const driveMenuGone = !getVisibleDriveMenu();
            if (hidden || driveMenuGone) closeQualityDropdown();
        });
        try {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        } catch (_) {}

        window.addEventListener('blur', closeQualityDropdown);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) closeQualityDropdown();
        });
        window.addEventListener('resize', closeQualityDropdown);
        window.addEventListener('scroll', closeQualityDropdown, true);
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
            const menu = document.getElementById('psd-video-quality-menu');
            const hasOptions = menu && menu.querySelector('.psd-quality-option:not([disabled])');
            if (!select || hasOptions) return;

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
        video.qualityMenuOptions = [];
    }

    function close(clearSnapshot = false) {
        stopWatch();
        closeQualityDropdown();

        const root = document.getElementById('psd-video-quality-picker');
        if (root) root.style.display = 'none';

        video.operation = 'idle';
        video.restorePickerOnFileMenuOpen = !clearSnapshot;
        hidePageBlocker();

        if (clearSnapshot) void clearSnapshot();
        app.video?.updateMenuState();
    }

    function populateSelect(select, formats, labeler, emptyText) {
        const root = document.getElementById('psd-video-quality-picker');
        const menu = document.getElementById('psd-video-quality-menu');
        const trigger = root?.querySelector('#psd-video-quality-trigger');
        const labelEl = trigger?.querySelector('.psd-quality-trigger-label');
        if (!root || !menu || !trigger || !labelEl || !select) return;

        const previousValue = select.value;
        const previousText = labelEl.textContent || '';
        menu.replaceChildren();
        setQualityDropdownOpen(root, false);

        if (!Array.isArray(formats) || !formats.length) {
            select.value = '';
            labelEl.textContent = emptyText;
            trigger.setAttribute('aria-disabled', 'true');
            const empty = document.createElement('button');
            empty.type = 'button';
            empty.className = 'psd-quality-option';
            empty.disabled = true;
            empty.textContent = emptyText;
            menu.appendChild(empty);
            return;
        }

        trigger.removeAttribute('aria-disabled');
        let selectedValue = '';
        let selectedLabel = '';

        formats.forEach((format, index) => {
            const height = Number(format.qualityHeight || format.height || 0) || 0;
            // Unique per menu row so 240p and 360p never share a value even if
            // the underlying stream id/itag collided during capture.
            const value = `h${height}:${format.id || index}`;
            const label = labeler(format);
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'psd-quality-option';
            option.setAttribute('role', 'option');
            option.dataset.value = value;
            option.dataset.height = String(height || '');
            option.dataset.formatId = format.id || '';
            option.textContent = label;
            menu.appendChild(option);

            if (!selectedValue && previousValue && value === previousValue) {
                selectedValue = value;
                selectedLabel = label;
            } else if (!selectedValue && previousText && label === previousText) {
                selectedValue = value;
                selectedLabel = label;
            } else if (!selectedValue && video.lastSelectedHeight && height === Number(video.lastSelectedHeight)) {
                selectedValue = value;
                selectedLabel = label;
            }
        });

        if (!selectedValue) {
            const first = formats[0];
            const height = Number(first.qualityHeight || first.height || 0) || 0;
            selectedValue = `h${height}:${first.id || '0'}`;
            selectedLabel = labeler(first);
        }

        select.value = selectedValue;
        labelEl.textContent = selectedLabel;
        menu.querySelectorAll('.psd-quality-option').forEach(node => {
            node.setAttribute('aria-selected', node.dataset.value === selectedValue ? 'true' : 'false');
        });
    }

    function resolvedFormatLists() {
        const live = video.formats || {};
        const pf = (video.operation === 'picker' && video.pickerFormats)
            ? video.pickerFormats
            : (video.formats || {});
        // Union video/audio from both sources (scan snapshot + live webRequest updates).
        const byUrl = (list) => {
            const map = new Map();
            for (const item of (list || [])) {
                if (!item?.url) continue;
                map.set(String(item.url), item);
            }
            return [...map.values()];
        };
        return {
            video: byUrl([...(pf.video || []), ...(live.video || [])]),
            audio: byUrl([...(pf.audio || []), ...(live.audio || [])]),
            progressive: byUrl([...(pf.progressive || []), ...(live.progressive || [])])
        };
    }

    function updateDownloadEnabled(root) {
        const el = root || document.getElementById('psd-video-quality-picker');
        if (!el) return false;
        const videoSelect = el.querySelector('#psd-video-quality-video');
        const download = el.querySelector('#psd-video-quality-download');
        const status = el.querySelector('#psd-video-quality-status');
        if (!videoSelect || !download) return false;

        const { video: videoList, audio: audioList, progressive: progressiveList } = resolvedFormatLists();
        const hasProgressive = progressiveList.some(item => item?.url);
        const hasAdaptiveVideo = videoList.some(item => item?.url);
        const hasAudio = audioList.some(item => item?.url);
        const hasSelection = !!(videoSelect.value || video.lastSelectedHeight);

        // Progressive is self-contained. Adaptive needs the single shared audio track.
        const valid = !!(hasSelection && (hasProgressive || (hasAdaptiveVideo && hasAudio)));
        const downloadBusy =
            video.operation === 'staging' ||
            !!videoOverlay.getJobId?.();
        download.disabled = !valid || downloadBusy;

        if (status) {
            if (downloadBusy) status.textContent = 'Download in progress…';
            else if (valid) status.textContent = '';
            else if (hasAdaptiveVideo && !hasAudio && !hasProgressive) {
                status.textContent = 'Waiting for audio track…';
            } else if (!hasSelection) {
                status.textContent = 'Select a quality to download.';
            } else {
                status.textContent = 'Waiting for a usable Drive stream…';
            }
        }
        return valid;
    }

    let audioHydrateInFlight = false;
    async function hydrateSharedAudioFromSession() {
        if (audioHydrateInFlight || video.operation !== 'picker') return;
        const lists = resolvedFormatLists();
        if (lists.audio.some(a => a?.url)) {
            updateDownloadEnabled();
            return;
        }
        audioHydrateInFlight = true;
        try {
            const response = await core.sendRuntime({ action: 'getStreams' });
            const session = response?.streams;
            const globalAudio = response?.globalAudio;

            const audioEntries = [];
            if (session?.audio) {
                audioEntries.push({
                    url: session.audio,
                    originalUrl: session.audioOriginal || session.audio,
                    mime: 'audio/mp4'
                });
            }
            for (const a of (session?.audioCandidates || [])) {
                if (a?.url) audioEntries.push(a);
            }
            for (const a of (session?.formats?.audio || [])) {
                if (a?.url) audioEntries.push(a);
            }
            if (globalAudio?.url) audioEntries.push(globalAudio);
            if (!audioEntries.length) return;

            const shared = audioEntries[0];
            video.formats = video.formats || { video: [], audio: [], progressive: [] };
            video.formats.audio = [shared];
            if (video.pickerFormats) {
                video.pickerFormats = {
                    ...video.pickerFormats,
                    audio: [shared]
                };
            }
            updateDownloadEnabled();
        } catch (_) {
        } finally {
            audioHydrateInFlight = false;
        }
    }

    function updatePickerState() {
        const root = ensureQualityPicker();
        const videoSelect = root.querySelector('#psd-video-quality-video');

        const { video: videoList, audio: audioList, progressive: progressiveList } = resolvedFormatLists();
        const hasAdaptiveVideo = videoList.some(item => item?.url);
        const hasProgressive = progressiveList.some(item => item?.url);

        const formatsForSelect = hasAdaptiveVideo
            ? videoList
            : (hasProgressive ? progressiveList : videoList);
        const emptyText = hasProgressive && !hasAdaptiveVideo
            ? 'No video format detected'
            : 'No adaptive video format detected';

        populateSelect(videoSelect, getDisplayVideoFormats(formatsForSelect, video.qualityMenuOptions), formatVideoLabel, emptyText);
        updateDownloadEnabled(root);

        // If UI has video but no audio yet, pull global/session audio (retry while open).
        if (hasAdaptiveVideo && !audioList.some(a => a?.url) && !hasProgressive) {
            void hydrateSharedAudioFromSession();
            if (!window.__PSD_AUDIO_HYDRATE_TIMER) {
                window.__PSD_AUDIO_HYDRATE_TIMER = setInterval(() => {
                    if (video.operation !== 'picker') {
                        clearInterval(window.__PSD_AUDIO_HYDRATE_TIMER);
                        window.__PSD_AUDIO_HYDRATE_TIMER = null;
                        return;
                    }
                    const lists = resolvedFormatLists();
                    if (lists.audio.some(a => a?.url)) {
                        clearInterval(window.__PSD_AUDIO_HYDRATE_TIMER);
                        window.__PSD_AUDIO_HYDRATE_TIMER = null;
                        updateDownloadEnabled();
                        return;
                    }
                    void hydrateSharedAudioFromSession();
                }, 1000);
            }
        }

        const mountedItem = root.closest?.('#' + VIDEO_MENU_ID);
        if (mountedItem) syncQualityPickerTypography(mountedItem);
    }

    function resetScanUI() {
        stopWatch();
        closeQualityDropdown();

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

    function prepareQualityPicker(formats, message, menuOptions = null) {
        video.formats = formats || { video: [], audio: [], progressive: [] };
        video.pickerFormats = core.cloneFormats(video.formats);
        if (Array.isArray(menuOptions) && menuOptions.length) {
            video.qualityMenuOptions = menuOptions
                .map(option => ({
                    height: Number(option?.height || 0),
                    label: String(option?.text || option?.label || '').trim(),
                    text: String(option?.text || option?.label || '').trim()
                }))
                .filter(option => option.height > 0);
        } else if (!Array.isArray(video.qualityMenuOptions)) {
            video.qualityMenuOptions = [];
        }
        video.scanCache = {
            fileId: video.fileId,
            at: Date.now(),
            heightCount: new Set([
                ...video.pickerFormats.video,
                ...video.pickerFormats.progressive
            ].map(format => Number(format.height) || 0).filter(Boolean)).size,
            note: message || '',
            menuOptions: video.qualityMenuOptions.slice()
        };
    }

    async function mountPickerAfterScan() {
        // Longer budgets: a multi-second quality scan can leave Drive's File menu
        // in a transitional state; rushing the reopen is the main silent-fail path.
        await waitForDriveFileMenuClosed(1200);
        const menu = await reopenDriveFileMenu();
        if (!menu) throw new Error('Drive File menu did not reopen after quality detection.');

        const ready = await waitUntil(async () => {
            const mounted = await ensureQualityPickerMounted({ reopenIfMissing: true });
            if (!mounted) return false;
            updatePickerState();

            const liveRoot = document.getElementById('psd-video-quality-picker');
            return !!(liveRoot?.querySelector('#psd-video-quality-video')?.value);
        }, 1500, 40);

        if (!ready) throw new Error('Quality picker could not be mounted into the reopened File menu.');
        document.querySelectorAll('#' + VIDEO_MENU_ID).forEach(app.video?.normalizeQualityMenuItem);
        updatePickerState();
        startWatch();
    }

    async function showQualityPicker(formats, message = '', menuOptions = null) {
        prepareQualityPicker(formats, message, menuOptions);
        await core.saveQualitySnapshot();

        const root = ensureQualityPicker();
        const status = root.querySelector('#psd-video-quality-status');
        root.style.display = 'none';
        video.operation = 'picker';
        // Always keep restore-on-open so a successful scan is never discarded
        // just because the immediate mount dance timed out.
        video.restorePickerOnFileMenuOpen = true;
        hidePageBlocker();
        updatePickerState();
        if (message) status.textContent = message;
        app.video?.updateMenuState();

        try {
            await mountPickerAfterScan();
            return true;
        } catch (err) {
            // Scan data is already saved — keep operation as 'picker' and
            // restorePickerOnFileMenuOpen so the next File-menu open shows it.
            // Only fall back to idle if we have nothing to show.
            const hasFormats = !!(
                (video.pickerFormats?.video || []).length ||
                (video.pickerFormats?.progressive || []).length ||
                (formats?.video || []).length
            );
            if (!hasFormats) {
                video.operation = 'idle';
                video.restorePickerOnFileMenuOpen = false;
            } else if (status) {
                status.textContent = message
                    || 'Qualities detected. Open the File menu to choose a quality.';
            }
            hidePageBlocker();
            app.video?.updateMenuState();
            return hasFormats;
        }
    }

    function getPickerDownloadRequest(root) {
        const rawValue = root.querySelector('#psd-video-quality-video')?.value || '';
        const label = root.querySelector('.psd-quality-trigger-label')?.textContent?.trim() || '';
        const pickerFormats = video.pickerFormats && video.operation === 'picker'
            ? video.pickerFormats
            : video.formats;

        // Values are "h{height}:{formatId}". Parse height so we pick the right stream
        // even when multiple rows briefly shared an underlying id.
        const heightMatch = String(rawValue).match(/^h(\d+):(.*)$/);
        const selectedHeight = heightMatch
            ? Number(heightMatch[1])
            : (Number(video.lastSelectedHeight || 0) || Number(label.match(/(\d{3,4})/)?.[1] || 0));
        const formatId = heightMatch ? heightMatch[2] : rawValue;

        const list = pickerFormats?.video?.length
            ? pickerFormats.video
            : (pickerFormats?.progressive || []);
        const byHeight = list.find(item =>
            Number(item?.qualityHeight || item?.height || 0) === selectedHeight && item?.url
        );
        const byId = list.find(item => item?.id === formatId && item?.url);
        const chosen = byHeight || byId || list[0] || null;
        const resolvedId = chosen?.id || formatId;
        const qualityHeight = Number(chosen?.qualityHeight || chosen?.height || selectedHeight || 0);

        // Append " (480p)" so the saved file shows which quality was downloaded.
        let filename = core.getCurrentDriveFileName?.() || video.lastFilenameSent || 'gdrive-video';
        if (qualityHeight > 0) {
            const base = String(filename).replace(/\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i, '');
            const cleaned = base.replace(/\s*\(\d{3,4}p\)\s*$/i, '').trim() || 'gdrive-video';
            filename = `${cleaned} (${qualityHeight}p).mp4`;
        }

        const request = pickerFormats?.video?.length
            ? { videoFormatId: resolvedId, qualityHeight, filename }
            : { progressiveFormatId: resolvedId, qualityHeight, filename };
        return request;
    }

    function beginVideoDownload(root, response) {
        const qualityLabel =
            root.querySelector('.psd-quality-trigger-label')?.textContent?.trim() ||
            video.lastSelectedQuality ||
            '';
        video.lastSelectedQuality = qualityLabel;

        root.style.display = 'none';
        // Keep scanned qualities in memory/storage until page refresh or file change.
        video.restorePickerOnFileMenuOpen = true;
        video.operation = 'staging';
        try { app.ui.closeDriveFileMenu(); } catch (_) {}
        hidePageBlocker();

        // Persist snapshot so cancel/reopen can restore the picker without re-probing.
        void core.saveQualitySnapshot?.();

        videoOverlay.show(
            true,
            response.jobId || null,
            response.videoBytes || response.mediaBytes || 0,
            response.audioBytes || 0,
            qualityLabel
        );
        app.video?.updateMenuState();
    }

    async function downloadFromPicker() {
        core.muteMediaImmediately();

        // Disallow starting another download while one is already running.
        if (video.operation === 'staging' || videoOverlay.getJobId?.()) {
            const root = document.getElementById('psd-video-quality-picker');
            const button = root?.querySelector('#psd-video-quality-download');
            const status = root?.querySelector('#psd-video-quality-status');
            if (button) button.disabled = true;
            if (status) status.textContent = 'Download in progress…';
            return;
        }

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
        isScanCancelled,
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
