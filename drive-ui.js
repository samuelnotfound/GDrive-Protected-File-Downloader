/**
 * Shared UI
 * Handles Google Drive menu/button UI and the shared PDF/video download overlay.
 */

(() => {
    if (window.__PSD_LOADED) return;
    window.__PSD_LOADED = true;

    const app = window.__PSD = window.__PSD || {};
    const pdf = app.pdfState = app.pdfState || {
        running: false,
        completed: false,
        stopRequested: false,
        ready: false,
        currentTotalHint: null,
        activePort: null,
        enableOCR: true,
        pages: new Map(),
        capturedPages: new Map(),
        orderCounter: 0,
        unsupportedTimer: null
    };
    app.videoState = app.videoState || {
        streamDetected: false,
        playbackStarted: false,
        downloadInProgress: false,
        lastViewerState: false,
        lastFilenameSent: ''
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
    const muteVideo = video => {
        try {
            video.muted = video.defaultMuted = true;
            video.volume = 0;
        } catch (_) {}
    };
    const hostIs = name => location.hostname === name || location.hostname.endsWith(`.${name}`);
    const isDrivePage = () => hostIs('drive.google.com') && /^\/file(?:\/|$)/.test(location.pathname);

    function postExtensionMessage(type, data = {}) {
        const message = { type, ...data };
        try {
            chrome.runtime.sendMessage(message).catch?.(() => {});
        } catch (_) {}
        try {
            pdf.activePort?.postMessage(message);
        } catch (_) {}
        window.dispatchEvent(new CustomEvent('pdfslide:update', { detail: message }));
    }

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
    function closeDriveFileMenu() {
        try {
            const fileButton = [...document.querySelectorAll('[role="button"],button')].find(el => {
                if (!el.offsetParent) return false;
                return normalizeMenuText(el.getAttribute('aria-label') || '') === 'File' ||
                    normalizeMenuText(el.textContent || '') === 'File';
            });
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

    function createInPageOverlayRoot() {
        const root = document.createElement('div');
        root.id = 'psd-inpage-overlay';
        root.innerHTML = `
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
        return root;
    }

    function bindInPageOverlayEvents(root) {
        const cancelButton = root.querySelector('#psd-inpage-toggle');
        const closeButton = root.querySelector('#psd-inpage-close');
        cancelButton.onclick = () => {
            if (!pdf.running) return;
            root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Cancelling download'));
            app.pdf?.cancel?.();
        };
        closeButton.onclick = () => {
            if (!pdf.running) {
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
        if (document.getElementById('psd-scroll-dim')) return;
        const dim = document.createElement('div');
        dim.id = 'psd-scroll-dim';
        dim.setAttribute('aria-hidden', 'true');
        dim.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.80);pointer-events:auto;display:none;';
        (document.body || document.documentElement).appendChild(dim);
        if (document.getElementById('psd-inpage-overlay')) return;
        const root = createInPageOverlayRoot();
        (document.body || document.documentElement).appendChild(root);
        root.style.display = 'none';
        bindInPageOverlayEvents(root);
    }
    function updateWindowControl() {
        const root = document.getElementById('psd-inpage-overlay');
        if (root && pdf.running) root.classList.remove('idle', 'cancelled');
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
        try {
            const menus = getVisibleFileMenus();
            app.video?.scanViewerState();
            for (const menu of menus) {
                app.video?.scanMenu(menu);
                app.pdf?.scanMenu(menu);
            }
        } catch (error) {
            console.debug('[GDrive Downloader] menu scan error', error);
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
    app.muteVideo = muteVideo;
    app.hostIs = hostIs;
    app.isDrivePage = isDrivePage;
    app.postExtensionMessage = postExtensionMessage;
    app.ui = {
        normalizeMenuText,
        getMenuLabel,
        findMenuRow,
        findShareRow,
        insertAfterReference,
        makeStandaloneMenuRow,
        getVisibleFileMenus,
        closeDriveFileMenu,
        setDownloadMenuItemIcon,
        styleDownloadMenuItem,
        handleMenuKeyboardActivation,
        addMenuDescription,
        createInPageOverlay,
        showScrollDim,
        showInPageOverlay,
        updateInPageOverlay,
        updateWindowControl
    };

    app.init = function init() {
        app.video?.init();
        if (app.isDrivePage()) {
            app.ui.createInPageOverlay();
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', watchDriveMenus, { once: true });
            } else {
                watchDriveMenus();
            }
        }
        if (location.hostname.endsWith('drive.google.com')) {
            app.pdf?.consumeAutoStart().then(pending => {
                if (!pending) return;
                const waitForViewer = () => {
                    if (app.pdf.currentDriveFileIsPDF()) app.pdf.start();
                    else setTimeout(waitForViewer, 100);
                };
                waitForViewer();
            });
        }
    };
})();
(() => {
    const NS = 'GDriveVideoOverlay';
    const CIRCUMFERENCE = 106.81415022205297;
    const DOWNLOAD_WEIGHT = 0.75;
    const state = {
        jobId: null, stage: 'download', merge: 0, fixedTotals: {
            video: 0, audio: 0
        }, bytes: {
            video: {
                received: 0, total: 0
            }, audio: {
                received: 0, total: 0
            }
        }
    };
    function createOverlayRoot() {
        const root = document.createElement("div");
        root.id = "psd-video-progress-overlay";
        root.innerHTML = `
      <style>
#psd-video-progress-overlay {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 2147483646;
    pointer-events: none;
    color: #e3e3e3;
    font: 14px/1.4 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
}
#psd-video-progress-card {
    width: 360px;
    max-width: calc(100vw - 32px);
    box-sizing: border-box;
    background: #28292a;
    border-radius: 20px;
    box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.2);
    overflow: hidden;
    pointer-events: auto;
}
#psd-video-progress-body {
    padding: 16px 18px;
    box-sizing: border-box;
}
#psd-video-progress-head {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    column-gap: 14px;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
}
#psd-video-progress-spinner,         #psd-video-progress-check {
    grid-column: 1;
    grid-row: 1;
}
#psd-video-progress-title-wrap {
    grid-column: 2;
    grid-row: 1;
}
#psd-video-progress-cancel,         #psd-video-progress-close {
    grid-column: 3;
    grid-row: 1;
}
#psd-video-progress-spinner,         #psd-video-progress-check {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: grid;
    place-items: center;
}
#psd-video-progress-spinner svg,         #psd-video-progress-check svg {
    width: 36px;
    height: 36px;
    display: block;
}
#psd-video-progress-spinner svg {
    transform: rotate(-90deg);
}
#psd-video-progress-spinner .bg {
    fill: none;
    stroke: #444746;
    stroke-width: 3.5;
}
#psd-video-progress-spinner .ring {
    fill: none;
    stroke: #a8c7fa;
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-dasharray: ${CIRCUMFERENCE};
    stroke-dashoffset: ${CIRCUMFERENCE};
    transition: stroke-dashoffset .16s linear;
}
#psd-video-progress-check {
    display: none;
}
#psd-video-progress-check circle {
    fill: none;
    stroke: #81c995;
    stroke-width: 3.5;
}
#psd-video-progress-check path {
    fill: none;
    stroke: #81c995;
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}
#psd-video-progress-title-wrap {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
}
#psd-video-progress-title {
    min-width: 0;
    font-size: 15px;
    line-height: 20px;
    font-weight: 500;
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
}
#psd-video-progress-detail {
    min-width: 0;
    margin-top: 3px;
    font-size: 13px;
    line-height: 18px;
    color: #c4c7c5;
    white-space: normal;
    overflow-wrap: anywhere;
}
#psd-video-progress-cancel,         #psd-video-progress-close {
    border: 0;
    box-sizing: border-box;
    align-self: center;
}
#psd-video-progress-cancel {
    border-radius: 18px;
    padding: 8px 17px;
    background: rgba(168,199,250,.12);
    color: #a8c7fa;
    font: 500 13px/16px 'Google Sans', Roboto, sans-serif;
    cursor: pointer;
    white-space: nowrap;
}
#psd-video-progress-cancel:hover {
    background: rgba(168,199,250,.20);
}
#psd-video-progress-cancel:disabled {
    opacity: .55;
    cursor: default;
}
#psd-video-progress-close {
    display: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: transparent;
    color: #c4c7c5;
    font: 18px/28px Arial, sans-serif;
    cursor: pointer;
    padding: 0;
    text-align: center;
}
#psd-video-progress-close:hover {
    background: rgba(255,255,255,.08);
    color: #e3e3e3;
}
#psd-video-progress-overlay.processing #psd-video-progress-spinner,         #psd-video-progress-overlay.completed #psd-video-progress-spinner,         #psd-video-progress-overlay.cancelled #psd-video-progress-spinner,         #psd-video-progress-overlay.error #psd-video-progress-spinner {
    visibility: hidden;
}
#psd-video-progress-overlay.completed #psd-video-progress-check {
    display: grid;
}
#psd-video-progress-overlay.started #psd-video-progress-spinner {
    visibility: visible;
}
#psd-video-progress-overlay.started #psd-video-progress-spinner svg {
    animation: psd-video-indeterminate-spin .95s linear infinite;
}
#psd-video-progress-overlay.started #psd-video-progress-spinner .ring {
    stroke-dasharray: 30 77;
    stroke-dashoffset: 0;
    transition: none;
}
@keyframes psd-video-indeterminate-spin {
    to {
        transform: rotate(270deg);
    }
}
#psd-video-progress-overlay.completed #psd-video-progress-cancel {
    display: none;
}
#psd-video-progress-overlay.completed #psd-video-progress-close {
    display: block;
}
#psd-video-progress-overlay.completed #psd-video-progress-head {
    grid-template-columns: 36px minmax(0,1fr) 28px;
}
#psd-video-progress-overlay.cancelled #psd-video-progress-cancel,         #psd-video-progress-overlay.error #psd-video-progress-cancel {
    display: none;
}
      </style>
      <div id="psd-video-progress-card">
        <div id="psd-video-progress-body">
          <div id="psd-video-progress-head">
            <div id="psd-video-progress-spinner" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle class="bg" cx="20" cy="20" r="17"></circle>
                <circle id="psd-video-progress-ring" class="ring" cx="20" cy="20" r="17"></circle>
              </svg>
            </div>
            <div id="psd-video-progress-check" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17"></circle>
                <path d="M11.5 20.5 17 26l11.5-12"></path>
              </svg>
            </div>
            <div id="psd-video-progress-title-wrap">
              <div id="psd-video-progress-title">Downloading Stream</div>
              <div id="psd-video-progress-detail">Download will start slow, please wait!</div>
            </div>
            <button id="psd-video-progress-cancel" type="button">Cancel</button>
            <button id="psd-video-progress-close" type="button" aria-label="Close">×</button>
          </div>
        </div>
      </div>`;
        return root;
    }
    function bindOverlayEvents(root) {
        const cancelButton = root.querySelector("#psd-video-progress-cancel");
        const closeButton = root.querySelector("#psd-video-progress-close");
        cancelButton.addEventListener("click", () => {
            const jobId = state.jobId;
            if (!jobId || cancelButton.disabled) return;
            cancelButton.disabled = true;
            state.jobId = null;
            setState("cancelled");
            try {
                chrome.runtime.sendMessage({
                    type: "videoStageCancel",
                    jobId
                });
            } catch (_) {
                // The page can disappear while a download is being cancelled.
            }
            setTimeout(() => {
                const currentRoot = document.getElementById(
                    "psd-video-progress-overlay"
                );
                if (currentRoot) currentRoot.style.display = "none";
            }, 700);
        });
        closeButton.addEventListener("click", () => {
            state.jobId = null;
            root.style.display = "none";
        });
    }
    function ensure() {
        if (window.top !== window.self) return null;
        let root = document.getElementById("psd-video-progress-overlay");
        if (root) return root;
        root = createOverlayRoot();
        (document.body || document.documentElement).appendChild(root);
        root.style.display = "none";
        bindOverlayEvents(root);
        return root;
    }
    function combinedTotal() {
        const videoTotal = Math.max(0, Number(state.fixedTotals.video) || 0);
        const audioTotal = Math.max(0, Number(state.fixedTotals.audio) || 0);
        return videoTotal + audioTotal;
    }
    function combinedReceived() {
        const videoReceived = Math.max(0, Number(state.bytes.video.received) || 0);
        const audioReceived = Math.max(0, Number(state.bytes.audio.received) || 0);
        return videoReceived + audioReceived;
    }
    function downloadOverallPercent() {
        const combinedSize = combinedTotal();
        if (!combinedSize) return 0;
        const combinedDownloaded = Math.min(combinedSize, combinedReceived());
        return Math.max(0, Math.min(1, combinedDownloaded / combinedSize));
    }
    function setRing(overallPercent) {
        const root = ensure();
        if (!root) return;
        const ring = root.querySelector('#psd-video-progress-ring');
        const progress = Math.max(0, Math.min(100, Number(overallPercent) || 0)) / 100;
        if (ring) {
            ring.style.strokeDasharray = String(CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));
        }
    }
    function stageRank(stage) {
        return({
            download: 1, merge: 2, processing: 3, started: 4, ready: 5, cancel: 99, error: 99
        })[stage] || 0;
    }
    function setState(stage, detail = null, force = false) {
        const root = ensure();
        if (!root) return;
        if (!force && stageRank(stage) < stageRank(state.stage)) return;
        root.classList.remove('processing', 'started', 'completed', 'cancelled', 'error');
        const title = root.querySelector('#psd-video-progress-title');
        const info = root.querySelector('#psd-video-progress-detail');
        const cancel = root.querySelector('#psd-video-progress-cancel');
        if (stage === 'download') {
            title.textContent = 'Downloading Stream';
            info.textContent = combinedTotal()  ? `Estimated Size: ${formatBytes(combinedTotal())}`: 'Download will start slow, please wait!';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
        }else if (stage === 'merge') {
            title.textContent = 'Merging video + audio';
            info.textContent = 'Download will begin shortly, please wait.';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
        }else if (stage === 'processing') {
            title.textContent = 'Finalizing download';
            info.textContent = 'Please wait..';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
            root.classList.add('processing');
        }else if (stage === 'started') {
            title.textContent = 'Download has started';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('started');
            const ring = root.querySelector('#psd-video-progress-ring');
            if (ring) {
                ring.style.strokeDasharray = '30 77';
                ring.style.strokeDashoffset = '0';
            }
        }else if (stage === 'ready') {
            title.textContent = 'Video downloaded';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('completed');
            setRing(100);
        }else if (stage === 'cancel') {
            title.textContent = 'Download Cancelled';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('cancelled');
        }else if (stage === 'error') {
            title.textContent = 'Video download failed';
            info.textContent = detail || 'The video could not be downloaded.';
            cancel.style.display = 'none';
            root.classList.add('error');
        }
        state.stage = stage;
    }
    function formatBytes(bytes) {
        const n = Math.max(0, Number(bytes) || 0);
        if (n < 1024) return `${Math.round(n)} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = n;
        let unit = 'B';
        for (const next of units) {
            if (value < 1024) break;
            value /= 1024;
            unit = next;
        }
        const digits = value >= 100  ? 0: value >= 10  ? 1: 2;
        return `${value.toFixed(digits)} ${unit}`;
    }
    function show(visible = true, jobId = null, videoTotal = 0, audioTotal = 0) {
        const root = ensure();
        if (!root) return;
        if (!visible) {
            root.style.display = 'none';
            return;
        }
        if (state.jobId && !['ready', 'cancelled', 'error'].includes(state.stage)) {
            root.style.display = 'block';
            return;
        }
        root.style.display = 'block';
        state.jobId = jobId || null;
        state.stage = 'download';
        state.merge = 0;
        state.fixedTotals.video = Math.max(0, Number(videoTotal) || 0);
        state.fixedTotals.audio = Math.max(0, Number(audioTotal) || 0);
        state.bytes.video = {
            received: 0, total: state.fixedTotals.video
        };
        state.bytes.audio = {
            received: 0, total: state.fixedTotals.audio
        };
        setRing(0);
        setState('download', null, true);
    }
    function setJob(jobId, videoTotal = 0, audioTotal = 0) {
        state.jobId = jobId || state.jobId;
        if (videoTotal) {
            state.fixedTotals.video = Number(videoTotal) || state.fixedTotals.video;
            state.bytes.video.total = state.fixedTotals.video;
        }
        if (audioTotal) {
            state.fixedTotals.audio = Number(audioTotal) || state.fixedTotals.audio;
            state.bytes.audio.total = state.fixedTotals.audio;
        }
        setState(state.stage);
    }
    function enterStage(stage) {
        const rank = stageRank(stage);
        const current = stageRank(state.stage);
        if (rank < current) return false;
        setState(stage);
        return state.stage === stage;
    }
    function update(msg = {
    }) {
        const root = ensure();
        if (!root) return;
        if (msg.label === 'video' || msg.label === 'audio') {
            const bucket = state.bytes[msg.label];
            bucket.received = Math.max(bucket.received, Number(msg.received) || 0);
            if (!state.fixedTotals[msg.label] && msg.total != null) {
                const fallbackTotal = Math.max(0, Number(msg.total) || 0);
                state.fixedTotals[msg.label] = fallbackTotal;
                bucket.total = fallbackTotal;
            }
            const percent = downloadOverallPercent();
            if (state.stage === 'download') setRing(percent * DOWNLOAD_WEIGHT * 100);
            return;
        }
        if (msg.stage === 'download') {
            if (state.stage === 'download') {
                const percent = downloadOverallPercent();
                setRing(percent * DOWNLOAD_WEIGHT * 100);
            }
            return;
        }
        if (msg.stage === 'merge') {
            if (stageRank('merge') < stageRank(state.stage)) return;
            state.merge = Math.max(0, Math.min(1, Number(msg.progress) || 0));
            if (!enterStage('merge')) return;
            if (state.stage === 'merge') {
                setRing(DOWNLOAD_WEIGHT * 100 + state.merge * (100 - DOWNLOAD_WEIGHT * 100));
            }
            return;
        }
        if (msg.stage === 'processing') {
            if (stageRank('processing') < stageRank(state.stage)) return;
            enterStage('processing');
            return;
        }
        if (msg.stage === 'started') {
            if (stageRank('started') < stageRank(state.stage)) return;
            if (!enterStage('started')) return;
            return;
        }
        if (msg.stage === 'ready') {
            setState('ready', null, true);
            return;
        }
        if (msg.stage === 'cancel') {
            state.jobId = null;
            setState('cancel', null, true);
            setTimeout(() => {
                const current = document.getElementById('psd-video-progress-overlay');
                if (current) current.style.display = 'none';
            }, 700);
            return;
        }
        if (msg.stage === 'error') {
            state.jobId = null;
            setState('error', msg.message || '', true);
        }
    }
    window[NS] = {
        ensure, show, setJob, update, getJobId: () => state.jobId, getStage: () => state.stage, clearJob: () => {
            state.jobId = null;
        }
    };
})();
