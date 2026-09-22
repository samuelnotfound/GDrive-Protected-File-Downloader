(() => {
    if (window.__PSD_LOADED) return;
    window.__PSD_LOADED = true;

    const app = window.__PSD = window.__PSD || {};
    const pdf = app.pdfState = app.pdfState || {
        status: 'idle',
        stopRequested: false,
        pages: new Map(),
        capturedPages: new Map(),
        orderCounter: 0,
        unsupportedTimer: null
    };
    app.videoState = app.videoState || {
        fileId: '',
        viewerSessionId: '',
        pageBridgeId: '',
        formats: { video: [], audio: [], progressive: [] },
        pickerFormats: null,
        scanCache: null,
        restorePickerOnFileMenuOpen: false,
        playbackStarted: false,
        operation: 'idle',
        lastViewerState: false,
        lastFilenameSent: '',
        bridgeReplayAt: {}
    };

    app.ids = {
        pdfMenu: 'psd-protected-download-menuitem',
        videoMenu: 'psd-protected-video-menuitem'
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sendAction = (action, data = {}) => {
        try {
            chrome.runtime.sendMessage({ action, ...data }).catch?.(() => {});
        } catch (_) {}
    };
    const isDrivePage = () => (location.hostname === 'drive.google.com' || location.hostname.endsWith('.drive.google.com')) && /^\/file(?:\/|$)/.test(location.pathname);
    const isPDFBusy = () => pdf.status === 'capturing' || pdf.status === 'processing';

    const normalizeMenuText = value => String(value).replace(/\s+/g, ' ').trim();
    const getMenuLabel = item => normalizeMenuText(
        item.querySelector('[jsname="K4r5Ff"]')?.textContent || item.textContent || ''
    );
    function findMenuRow(menu, wanted) {
        const target = normalizeMenuText(wanted).toLowerCase();
        const candidates = [
            ...menu.querySelectorAll('[role="menuitem"]'),
            ...menu.querySelectorAll('li'),
            ...menu.querySelectorAll('[data-tooltip]')
        ];
        return candidates.find(el => el !== menu && getMenuLabel(el).toLowerCase() === target) || null;
    }
    const findShareRow = menu => findMenuRow(menu, 'Share');
    function insertAfterReference(parent, node, reference) {
        if (!node) return;
        if (reference?.parentNode) {
            reference.parentNode.insertBefore(node, reference.nextSibling);
        } else if (parent) {
            parent.appendChild(node);
        }
    }
    function makeStandaloneMenuRow(source, id, label) {
        if (!source) return null;
        const item = source.cloneNode(true);
        item.id = id;
        for (const attr of ['jsaction','jscontroller','jsmodel','data-id','data-tooltip','data-tooltip-class','aria-disabled','disabled','aria-haspopup']) {
            item.removeAttribute(attr);
        }
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', label);
        const labelNode = item.querySelector('[jsname="K4r5Ff"]');
        if (labelNode) {
            labelNode.textContent = label;
        } else {
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                if (normalizeMenuText(walker.currentNode.nodeValue)) {
                    walker.currentNode.nodeValue = label;
                    break;
                }
            }
        }
        const shortcut = item.querySelector('[jsname="orbTae"]');
        if (shortcut) shortcut.textContent = '';
        return item;
    }
    function getVisibleFileMenus() {
        return [...document.querySelectorAll('[role="menu"]')].filter(menu => {
            const rect = menu.getBoundingClientRect?.();
            return rect?.width > 0 && rect?.height > 0 && getComputedStyle(menu).visibility !== 'hidden';
        });
    }
    function getDriveFileButton() {
        return [...document.querySelectorAll('[role="button"],button')].find(el => {
            if (!el.offsetParent) return false;
            return normalizeMenuText(el.getAttribute('aria-label') || '') === 'File' ||
                normalizeMenuText(el.textContent || '') === 'File';
        }) || null;
    }

    function closeDriveFileMenu() {
        try {
            const fileButton = getDriveFileButton();
            if (fileButton) {
                fileButton.click();
                return true;
            }
        } catch (_) {}
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
            }));
        } catch (_) {}
        return false;
    }

    const DOWNLOAD_ICON = [
        '<span class="notranslate aqdrmf-rymPhb-Abojl aqdrmf-rymPhb-H09UMb-bN97Pc" aria-hidden="true">',
        '<svg height="24" viewBox="0 96 960 960" width="24">',
        '<path d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"></path>',
        '</svg></span>'
    ].join('');
    function setDownloadMenuItemIcon(item) {
        const host = item.querySelector('.aqdrmf-rymPhb-KkROqb');
        if (host) host.innerHTML = DOWNLOAD_ICON;
    }
    function styleDownloadMenuItem(item, opacity = '1') {
        item.style.cursor = 'pointer';
        item.style.opacity = opacity;
        item.style.pointerEvents = 'auto';
        item.style.transition = 'background-color 80ms ease, opacity 80ms ease';
        item.style.boxSizing = 'border-box';
        item.style.maxWidth = '100%';
        item.addEventListener('mouseenter', () => { item.style.backgroundColor = 'rgba(255,255,255,.08)'; });
        item.addEventListener('mouseleave', () => { item.style.backgroundColor = ''; });
    }
    function handleMenuKeyboardActivation(item, activate) {
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event);
        });
    }
    function addMenuDescription(item, labelClass, infoClass, text) {
        const label = item.querySelector('[jsname="K4r5Ff"]');
        if (!label || item.querySelector(`.${infoClass}`)) return;
        label.classList.add(labelClass);
        const parent = label.parentElement;
        if (!parent) return;
        const info = Object.assign(document.createElement('span'), { className: infoClass, textContent: text });
        info.style.cssText = 'display:block;box-sizing:border-box;width:100%;max-width:100%;margin-top:2px;font:400 11px/14px Roboto,Arial,sans-serif;color:rgba(255,255,255,.62);white-space:normal;overflow-wrap:anywhere;word-break:normal;overflow:hidden;';
        parent.append(info);
        Object.assign(parent.style, { display:'flex', flexDirection:'column', alignItems:'flex-start', flex:'1 1 0', width:'0', minWidth:'0', maxWidth:'100%', overflow:'hidden' });
    }

    const INPAGE_OVERLAY_HTML = `
      <style>
#psd-inpage-overlay { position:fixed; right:24px; bottom:24px; z-index:2147483646; pointer-events:none; font:14px/1.4 'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e3e3e3; -webkit-font-smoothing:antialiased }
#psd-inpage-card { width:360px; max-width:calc(100vw - 32px); background:#28292a; border:none; outline:none; border-radius:20px; box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2); overflow:hidden; pointer-events:auto; position:relative }
#psd-inpage-body { padding:16px 18px }
#psd-inpage-head { display:grid; grid-template-columns:36px minmax(0,1fr) auto; align-items:center; column-gap:14px; min-height:36px; position:relative }
#psd-inpage-spinner,#psd-inpage-check { width:36px; height:36px; flex:0 0 36px; position:relative }
#psd-inpage-spinner svg,#psd-inpage-check svg { display:block; width:36px; height:36px }
#psd-inpage-spinner svg { transform:rotate(-90deg); overflow:visible }
#psd-inpage-spinner .psd-ring-bg { fill:none; stroke:#444746; stroke-width:3.5 }
#psd-inpage-spinner .psd-ring { fill:none; stroke:#a8c7fa; stroke-width:3.5; stroke-linecap:round; stroke-dasharray:106.814150222; stroke-dashoffset:106.814150222; transition:stroke-dashoffset .15s linear; transform-box:fill-box; transform-origin:center }
#psd-inpage-check { display:none }
#psd-inpage-check circle { fill:none; stroke:#81c995; stroke-width:3.5 }
#psd-inpage-check path { fill:none; stroke:#81c995; stroke-width:3.5; stroke-linecap:round; stroke-linejoin:round }
#psd-inpage-title { font-size:15px; line-height:20px; white-space:nowrap; font-weight:500; color:#e3e3e3; letter-spacing:.1px }
#psd-inpage-detail { margin-top:3px; font-size:13px; color:#c4c7c5; line-height:1.4; min-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
#psd-inpage-actions { display:flex; align-items:center; justify-content:center; margin:0; align-self:center }
#psd-inpage-toggle { display:block; border:none; outline:none; border-radius:20px; padding:7px 18px; background:rgba(168,199,250,.12); color:#a8c7fa; cursor:pointer; font:500 13px 'Google Sans',Roboto,sans-serif }
#psd-inpage-toggle:hover { background:rgba(168,199,250,.22) }
#psd-inpage-toggle:focus-visible { outline:2px solid #a8c7fa; outline-offset:1px }
#psd-video-download { display:none }
#psd-inpage-close { display:none; position:absolute; top:10px; right:10px; width:30px; height:30px; border:0; border-radius:50%; background:transparent; color:#c4c7c5; font:18px/30px Arial,sans-serif; cursor:pointer; padding:0; text-align:center }
#psd-inpage-close:hover { background:rgba(255,255,255,.08); color:#e3e3e3 }
#psd-inpage-overlay.completed #psd-inpage-close { display:block }
#psd-inpage-overlay.completed #psd-inpage-toggle { display:none }
#psd-inpage-overlay.cancelled #psd-inpage-card { width:auto; min-width:190px }
#psd-inpage-overlay.cancelled #psd-inpage-body { padding:16px 20px }
#psd-inpage-overlay.cancelled #psd-inpage-spinner,#psd-inpage-overlay.cancelled #psd-inpage-actions { display:none }
#psd-inpage-close:focus-visible { outline:2px solid #8ab4f8; outline-offset:1px }
#psd-inpage-overlay.completed #psd-inpage-spinner { display:none }
#psd-inpage-overlay.completed #psd-inpage-check { display:block }
#psd-inpage-overlay.completed #psd-inpage-detail { display:none }
#psd-inpage-overlay.completed #psd-inpage-head { grid-template-columns:36px minmax(0,1fr) 28px; column-gap:14px }
#psd-inpage-overlay.completed #psd-inpage-close { display:block; position:static; grid-column:3; grid-row:1; width:28px; height:28px; line-height:28px; margin:0; text-align:center }
#psd-inpage-overlay.cancelled #psd-inpage-title { font-size:16px; line-height:20px; white-space:nowrap }
      </style>
      <div id="psd-inpage-card"><div id="psd-inpage-body"><div id="psd-inpage-head">
        <div id="psd-inpage-spinner" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="psd-ring-bg" cx="20" cy="20" r="17"></circle><circle id="psd-inpage-ring" class="psd-ring" cx="20" cy="20" r="17"></circle></svg></div>
        <div id="psd-inpage-check" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17"></circle><path d="M11.5 20.5 17 26l11.5-12"></path></svg></div>
        <div><div id="psd-inpage-title">Preparing download</div><div id="psd-inpage-detail"></div></div>
        <div id="psd-inpage-actions"><button id="psd-inpage-toggle" type="button">Cancel</button></div><button id="psd-inpage-close" aria-label="Close">×</button>
      </div></div></div>`;

    function createInPageOverlayRoot() {
        const root = document.createElement('div');
        root.id = 'psd-inpage-overlay';
        root.innerHTML = INPAGE_OVERLAY_HTML;
        return root;
    }

    function bindInPageOverlayEvents(root) {
        const cancelButton = root.querySelector('#psd-inpage-toggle');
        const closeButton = root.querySelector('#psd-inpage-close');
        cancelButton.onclick = () => {
            if (!isPDFBusy()) return;
            root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Cancelling download'));
            app.pdf?.cancel?.();
        };
        closeButton.onclick = () => {
            if (!isPDFBusy()) {
                showInPageOverlay(false);
                return;
            }
            if (pdf.stopRequested) return;
            root.classList.remove('completed', 'unsupported', 'cancelled');
            root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Cancelling download'));
            app.pdf?.cancel?.();
            const detail = root.querySelector('#psd-inpage-detail');
            if (detail) detail.textContent = '';
        };
    }
    function createInPageOverlay() {
        const host = document.body || document.documentElement;
        let dim = document.getElementById('psd-scroll-dim');
        if (!dim) {
            dim = document.createElement('div');
            dim.id = 'psd-scroll-dim';
            dim.setAttribute('aria-hidden', 'true');
            dim.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.80);pointer-events:auto;display:none;';
            host.appendChild(dim);
        }

        if (document.getElementById('psd-inpage-overlay')) return;
        const root = createInPageOverlayRoot();
        host.appendChild(root);
        root.style.display = 'none';
        bindInPageOverlayEvents(root);
    }
    function updateWindowControl() {
        const root = document.getElementById('psd-inpage-overlay');
        if (root && isPDFBusy()) root.classList.remove('idle', 'cancelled');
    }
    function showScrollDim(show = true) {
        const dim = document.getElementById('psd-scroll-dim');
        if (dim) dim.style.display = show ? 'block' : 'none';
    }
    function showInPageOverlay(show = true) {
        createInPageOverlay();
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;
        root.style.display = show ? 'block' : 'none';
        if (show) {
            root.classList.remove('cancelled', 'completed', 'unsupported');
            root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-check')?.style.setProperty('display', 'none');
        }
        updateWindowControl();
    }
    const INPAGE_RING_CIRCUMFERENCE = 2 * Math.PI * 17;
    function updateInPageOverlay(status, detail, percent) {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;
        const title = root.querySelector('#psd-inpage-title');
        const detailEl = root.querySelector('#psd-inpage-detail');
        if (title && !root.classList.contains('cancelled')) {
            const label = String(status || '');
            if (/^File downloaded$/i.test(label)) title.textContent = 'File downloaded';
            else if (/^PDF conversion failed$/i.test(label)) title.textContent = 'PDF conversion failed';
            else if (/^PDF incomplete$/i.test(label)) title.textContent = 'PDF incomplete';
            else if (/^Some pages were not captured$/i.test(label)) title.textContent = 'Capture incomplete';
            else title.textContent = 'Preparing download';
        }
        if (detailEl && !root.classList.contains('cancelled')) {
            const text = String(detail || '');
            if (/^(?:Processing page|OCR page)\b/i.test(text)) detailEl.textContent = text;
            else if (/^Preparing page\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing page/i, 'Capturing page');
            else if (/^Preparing pages\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing pages/i, 'Capturing');
            else if (/^Preparing your PDF/i.test(text)) detailEl.textContent = 'Preparing PDF…';
            else detailEl.textContent = text;
        }
        if (typeof percent === 'number') {
            const safePercent = Math.max(0, Math.min(100, percent));
            const ring = root.querySelector('#psd-inpage-ring');
            const offset = INPAGE_RING_CIRCUMFERENCE * (1 - safePercent / 100);
            if (ring) {
                ring.style.strokeDasharray = String(INPAGE_RING_CIRCUMFERENCE);
                ring.style.strokeDashoffset = String(offset);
            }
        }
    }

    function scanDriveMenus() {
        const menus = getVisibleFileMenus();
        void app.video?.scanViewerState().catch(error => {
            console.warn('[GDrive Downloader] viewer state scan failed:', error);
        });
        for (const menu of menus) {
            app.video?.scanMenu(menu);
            app.pdf?.scanMenu(menu);
        }
    }
    function watchDriveMenus() {
        if (!isDrivePage()) return;
        scanDriveMenus();
        let scanTimer = null;
        const scheduleScan = () => {
            if (scanTimer) return;
            scanTimer = setTimeout(() => { scanTimer = null; scanDriveMenus(); }, 100);
        };
        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-hidden']
        });
        setInterval(scheduleScan, 1000);
    }

    app.sleep = sleep;
    app.sendAction = sendAction;
    app.isDrivePage = isDrivePage;
    app.ui = {
        findMenuRow,
        findShareRow,
        insertAfterReference,
        makeStandaloneMenuRow,
        getVisibleFileMenus,
        getDriveFileButton,
        closeDriveFileMenu,
        setDownloadMenuItemIcon,
        styleDownloadMenuItem,
        handleMenuKeyboardActivation,
        addMenuDescription,
        showScrollDim,
        showInPageOverlay,
        updateInPageOverlay,
        updateWindowControl
    };

    app.init = function init() {
        app.video?.init();
        if (!app.isDrivePage()) return;

        createInPageOverlay();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', watchDriveMenus, { once: true });
        } else {
            watchDriveMenus();
        }
    };
})();
