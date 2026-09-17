(() => {
if (window.__PSD_LOADED) return;
    window.__PSD_LOADED = true;
    const PREFIX = "blob:https://drive.google.com/";
    const MIN_W = 500;
    const MIN_H = 300;
    const DEFAULT_DELAY = 40;
    const IMAGE_WAIT_FAST = 1600;
    const IMAGE_WAIT_RECOVERY = 4000;
    const SAME_IMAGE_GRACE = 800;
    const FIRST_PAGE_SETTLE = 300;
    const PAGE_COUNT_WAIT = 1500;
    let running = false;
    let completed = false;
    let stopRequested = false;
    let ready = false;
    let currentTotalHint = null;
    let activePort = null;
    let scrollDelay = DEFAULT_DELAY;
    let enableOCR = true;
    const pages = new Map();
    const capturedPages = new Map();
    let orderCounter = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
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

    function postExtensionMessage(type, data = {}) {
        const message = { type, ...data };
        try {
            chrome.runtime.sendMessage(message).catch?.(() => {});
        } catch (_) {}

        try {
            activePort?.postMessage(message);
        } catch (_) {}
        window.dispatchEvent(new CustomEvent("pdfslide:update", {
            detail: message
        }));
    }
    const hostIs = name => location.hostname === name || location.hostname.endsWith(`.${name}`);
    const isDrivePage = () => hostIs("drive.google.com") && (/^\/file(?:\/|$)/).test(location.pathname);
    // Video detection and menu integration
    const PROTECTED_DOWNLOAD_MENU_ID = "psd-protected-download-menuitem";
    const PROTECTED_VIDEO_MENU_ID = "psd-protected-video-menuitem";
    let videoStreamDetected = false;
    let videoPlaybackStarted = false;
    let videoDownloadInProgress = false;
    let lastVideoViewerState = false;
    let lastVideoFilenameSent = '';

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
        if (!name || name === lastVideoFilenameSent) return name;
        lastVideoFilenameSent = name;
        sendAction("updateFilename", { filename: name });
        return name;
    }
    function normalizeMenuText(value = "") {
        return String(value).replace(/\s+/g, " ").trim();
    }
    function getMenuLabel(item) {
        const preferred = item.querySelector('[jsname="K4r5Ff"]');
        const text = normalizeMenuText(preferred?.textContent || item.textContent || "");
        return text;
    }
    function findMenuRow(menu, wanted) {
        const target = normalizeMenuText(wanted).toLowerCase();
        const candidates = [...menu.querySelectorAll('[role="menuitem"]'), ...menu.querySelectorAll('li'), ...menu.querySelectorAll('[data-tooltip]')];
        for (const el of candidates) {
            if (el === menu) continue;
            const text = getMenuLabel(el).toLowerCase();
            if (text === target) return el;
        }
        return null;
    }
    function findShareRow(menu) {
        return findMenuRow(menu, 'Share');
    }
    function insertAfterReference(parent, node, reference) {
        if (!node) return;
        if (reference && reference.parentNode) {
            reference.parentNode.insertBefore(node, reference.nextSibling);
            return;
        }
        if (parent) parent.appendChild(node);
    }
    function makeStandaloneMenuRow(source, id, label) {
        if (!source) return null;
        const item = source.cloneNode(true);
        item.id = id;
        item.removeAttribute('jsaction');
        item.removeAttribute('jscontroller');
        item.removeAttribute('jsmodel');
        item.removeAttribute('data-id');
        item.removeAttribute('data-tooltip');
        item.removeAttribute('data-tooltip-class');
        item.removeAttribute('aria-disabled');
        item.removeAttribute('disabled');
        item.removeAttribute('aria-haspopup');
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', label);
        const labelNode = item.querySelector('[jsname="K4r5Ff"]');
        if (labelNode) labelNode.textContent = label;
        else {
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (normalizeMenuText(node.nodeValue)) {
                    node.nodeValue = label;
                    break;
                }
            }
        }
        const shortcut = item.querySelector('[jsname="orbTae"]');
        if (shortcut) shortcut.textContent = '';
        return item;
    }
    function getVisibleFileMenus() {
        return[...document.querySelectorAll('[role="menu"]')].filter(menu => {
            const r = menu.getBoundingClientRect?.();
            return!!r && r.width > 0 && r.height > 0 && getComputedStyle(menu).visibility !== 'hidden';
        });
    }
    function closeDriveFileMenu() {
        try {
            const fileButton = [...document.querySelectorAll('[role="button"],button')].find(el => {
                if (!el.offsetParent) return false;
                const aria = normalizeMenuText(el.getAttribute('aria-label') || '');
                const text = normalizeMenuText(el.textContent || '');
                return aria === 'File' || text === 'File';
            });
            if (fileButton) {
                fileButton.click();
                return true;
            }
        }catch (_) {
        }
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
            }));
        }catch (_) {
        }
        return false;
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
        if (!started || videoPlaybackStarted) return;
        videoPlaybackStarted = true;
        updateVideoMenuState();
        sendAction("videoPlaybackStarted");
    }
    function updateVideoMenuState() {
        const items = document.querySelectorAll('#' + PROTECTED_VIDEO_MENU_ID);
        items.forEach(item => {
            const label = item.querySelector('.psd-video-menu-label');
            const info = item.querySelector('.psd-video-menu-info');
            const busy = !!videoDownloadInProgress;
            const labelText = busy  ? 'Downloading Video…': 'Download Video';
            if (label) label.textContent = labelText;
            item.setAttribute('aria-label', labelText);
            item.dataset.streamReady = videoStreamDetected  ? 'true': 'false';
            item.dataset.playbackReady = videoPlaybackStarted  ? 'true': 'false';
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
        videoStreamDetected = !!hasStream;
        updateVideoMenuState();
    }
    function syncVideoStreamState(streams = {}) {
        if (streams.playbackStarted || streams.video) videoPlaybackStarted = true;
        setVideoDownloadState(!!streams.video);
    }

    async function tryDirectVideoPlayback(videos) {
        for (const video of videos) {
            try {
                const before = Number(video.currentTime || 0);
                const playPromise = video.play();
                if (playPromise?.then) await playPromise;
                await sleep(250);
                muteVideo(video);
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
        await sleep(1500);
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
        if (videoDownloadInProgress) return;
        videoDownloadInProgress = true;
        updateVideoMenuState();
        const filename = getCurrentDriveFileName();
        videoOverlay.show(true);
        try {
            closeDriveFileMenu();
            const playback = await startCurrentVideoAndWait();
            if (!playback.success) {
                videoOverlay.update({
                    stage: 'error', message: playback.error || 'The video did not start playing.'
                });
                const root = document.getElementById('psd-video-progress-overlay');
                root?.classList.add('error');
                videoDownloadInProgress = false;
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
                    videoDownloadInProgress = false;
                    updateVideoMenuState();
                    videoOverlay.update({
                        stage: 'error', message: response.error || 'Video processing failed.'
                    });
                    return;
                }
                updateVideoMenuState();
            });
        }catch (error) {
            videoDownloadInProgress = false;
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
            if (!item || videoDownloadInProgress) return;
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
    const DOWNLOAD_ICON = [
        '<span class="notranslate aqdrmf-rymPhb-Abojl aqdrmf-rymPhb-H09UMb-bN97Pc" aria-hidden="true">',
        '<svg height="24" viewBox="0 96 960 960" width="24">',
        '<path d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"></path>',
        '</svg>',
        '</span>'
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
        item.addEventListener('mouseenter', () => {
            item.style.backgroundColor = 'rgba(255,255,255,.08)';
        });
        item.addEventListener('mouseleave', () => {
            item.style.backgroundColor = '';
        });
    }
    function handleMenuKeyboardActivation(item, activate) {
        item.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            activate(event);
        });
    }
    function addMenuDescription(item, labelClass, infoClass, text) {
        const label = item.querySelector('[jsname="K4r5Ff"]');
        if (!label || item.querySelector(`.${infoClass}`)) return;
        label.classList.add(labelClass);
        const parent = label.parentElement;
        if (!parent) return;
        const info = Object.assign(document.createElement("span"), { className: infoClass, textContent: text });
        info.style.cssText = "display:block;box-sizing:border-box;width:100%;max-width:100%;margin-top:2px;font:400 11px/14px Roboto,Arial,sans-serif;color:rgba(255,255,255,.62);white-space:normal;overflow-wrap:anywhere;word-break:normal;overflow:hidden;";
        parent.append(info);
        Object.assign(parent.style, { display:"flex", flexDirection:"column", alignItems:"flex-start", flex:"1 1 0", width:"0", minWidth:"0", maxWidth:"100%", overflow:"hidden" });
    }
    function addProtectedVideoMenuItem(menu) {
        if (menu.querySelector(`#${PROTECTED_VIDEO_MENU_ID}`)) return true;
        const securityRow = findMenuRow(menu, "Security limitations");
        if (!securityRow) return false;
        const printRow = findMenuRow(menu, "Print");
        if (printRow) return false;
        const templateRow =
            findMenuRow(menu, "Details") ||
            findMenuRow(menu, "Add to starred") ||
            securityRow;
        const item = makeStandaloneMenuRow(
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
                if (normalizeMenuText(node.nodeValue) === "Security limitations") {
                    node.nodeValue = "Download Video";
                    break;
                }
            }
        }
        addMenuDescription(item, "psd-video-menu-label", "psd-video-menu-info", "This option uses an alternative method to download the video when the usual download option is unavailable.");
        setDownloadMenuItemIcon(item);
        styleDownloadMenuItem(item, "1");
        handleMenuKeyboardActivation(item, event => {
            event.preventDefault();
            event.stopPropagation();
            item.click();
        });
        const parent = securityRow.parentNode;
        const shareRow = findShareRow(menu);
        insertAfterReference(parent, item, shareRow || null);
        return true;
    }
    const addProtectedPDFMenuDescription = item => addMenuDescription(item, "psd-pdf-menu-label", "psd-pdf-menu-info", "Standard downloads are disabled for this file. This option captures each page and combines them into a downloadable PDF.");
    function activateProtectedPDFDownload(event) {
        event.preventDefault();
        event.stopPropagation();
        closeDriveFileMenu();
        showInPageOverlay(true);
        const root = document.getElementById("psd-inpage-overlay");
        root?.classList.remove("quiet", "idle", "completed", "cancelled");
        root?.querySelector("#psd-inpage-title")?.replaceChildren(
            document.createTextNode("Preparing download")
        );
        root?.querySelector("#psd-inpage-detail")?.replaceChildren(
            document.createTextNode("")
        );
        setTimeout(() => startPDFDownload(), 0);
    }
    function addProtectedDownloadMenuItem() {
        if (!isDrivePage() || !document.body) return;
        const visibleMenus = getVisibleFileMenus();
        for (const menu of visibleMenus) {
            const videoSecurityRow = findMenuRow(menu, "Security limitations");
            const videoPrintRow = findMenuRow(menu, "Print");
            if (videoSecurityRow && !videoPrintRow) {
                const hasNativeDownload = !!findMenuRow(menu, "Download");
                if (!hasNativeDownload) {
                    addProtectedVideoMenuItem(menu);
                }
                        continue;
            }
            // For PDFs, use the actual Download menu item as the source of truth.
            // Do not use Print or Security limitations to decide whether to inject.
            if (!isLikelyPDFForMenu()) continue;
            if (menu.querySelector(`#${PROTECTED_DOWNLOAD_MENU_ID}`)) continue;
            const nativeDownload = findMenuRow(menu, "Download");
            const nativeDisabled = !!nativeDownload && (
                nativeDownload.getAttribute("aria-disabled") === "true" ||
                nativeDownload.hasAttribute("disabled") ||
                nativeDownload.dataset.disabled === "true" ||
                nativeDownload.classList.contains("disabled")
            );
            if (nativeDownload && !nativeDisabled) continue;
            const templateRow =
                findMenuRow(menu, "Details") ||
                findMenuRow(menu, "Add to starred") ||
                findMenuRow(menu, "Security limitations") ||
                nativeDownload;
            if (!templateRow) continue;
            const item = makeStandaloneMenuRow(
                templateRow,
                PROTECTED_DOWNLOAD_MENU_ID,
                "Download"
            );
            if (!item) continue;
            item.setAttribute("aria-label", "Download");
            setDownloadMenuItemIcon(item);
            styleDownloadMenuItem(item);
            addProtectedPDFMenuDescription(item);
            item.addEventListener("click", activateProtectedPDFDownload);
            handleMenuKeyboardActivation(item, activateProtectedPDFDownload);
            const shareRow = findShareRow(menu);
            insertAfterReference(menu, item, shareRow || null);
        }
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
    function scanDriveMenus() {
        try {
            const playerOpen = isVideoViewerOpen();
            const menus = getVisibleFileMenus();
            if (playerOpen !== lastVideoViewerState) {
                if (playerOpen && !lastVideoViewerState) {
                    videoStreamDetected = false;
                    videoPlaybackStarted = false;
                    lastVideoFilenameSent = "";
                    updateVideoMenuState();
                    sendAction("clearVideoStream");
                    updateCapturedVideoFilename();
                }
                if (playerOpen) {
                    updateCapturedVideoFilename();
                }
                lastVideoViewerState = playerOpen;
            }
            addProtectedDownloadMenuItem();
        } catch (error) {
            console.debug("[GDrive Downloader] menu scan error", error);
        }
    }
    function watchDriveMenus() {
        if (!isDrivePage()) return;
        installVideoMenuClickGuard();
        installStreamStorageListener();
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
            attributeFilter: ["aria-hidden"]
        });
        setInterval(scheduleScan, 1000);
    }
    function isLikelyPDFForMenu() {
        if (isVideoViewerOpen()) return false;
        const text = [document.title || "", document.body?.innerText || ""].join(" ");
        if (/\.pdf(?:$|[?#\s])/i.test(text)) return true;
        const json = document.querySelector('#drive-active-item-info');
        if (json) {
            try {
                const data = JSON.parse(json.textContent || "");
                if (/application\/pdf/i.test(data?.mimeType || data?.mime_type || "") || /\.pdf$/i.test(data?.title || "")) return true;
            }catch (_) {
            }
        }
        return false;
    }
    function looksLikePDFName(value = "") {
        return /\.pdf(?:$|[?#])/i.test(value) || /\bpdf\b/i.test(value) && /\.pdf\b/i.test(value);
    }

    function currentDriveFileIsPDF() {
        if (!location.hostname.endsWith("drive.google.com")) return false;
        const title = document.title || "";
        if (looksLikePDFName(title)) return true;
        const bodyText = document.body?.innerText || "";
        if (/\.pdf\b/i.test(bodyText)) return true;
        const pdfHints = document.querySelectorAll('[aria-label*=".pdf" i], [title*=".pdf" i], [data-tooltip*=".pdf" i]');
        if (pdfHints.length) return true;
        const pageInfo = getPageInput();
        const hasPageCounter = /\bPage\s+\d+\s*\/\s*\d+\b/i.test(bodyText) || !!(pageInfo?.current && pageInfo?.max);
        if (hasPageCounter && allImages().length > 0) return true;
        return false;
    }

    async function consumeAutoStart() {
        let pending = false;
        try {
            const result = await chrome.storage.session.get({
                psdAutoStart: false
            });
            pending = !!result.psdAutoStart;
            if (pending) await chrome.storage.session.remove("psdAutoStart");
        }catch (_) {
            try {
                const result = await chrome.storage.local.get({
                    psdAutoStart: false
                });
                pending = !!result.psdAutoStart;
                if (pending) await chrome.storage.local.remove("psdAutoStart");
            }catch (_) {
            }
        }
        return pending;
    }
    function allImages() {
        return[...document.images].filter(img => {
            const src = img.currentSrc || img.src || "";
            return src.startsWith(PREFIX) && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
        });
    }
    function scanRenderedPages(pageNumber = null) {
        let added = 0;
        for (const img of allImages()) {
            const src = img.currentSrc || img.src;
            if (!pages.has(src)) {
                pages.set(src, {
                    src, w: img.naturalWidth, h: img.naturalHeight, order: orderCounter++, pageNumber
                });
                added++;
            }else if (pageNumber != null) {
                const existing = pages.get(src);
                if (existing && existing.pageNumber == null) existing.pageNumber = pageNumber;
            }
        }
        return added;
    }
    let pageInputCache = null;
    let pageInputCacheAt = 0;
    function getCurrentPageImage() {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const vh = window.innerHeight || document.documentElement.clientHeight || 1;
        const cx = vw / 2;
        const cy = vh / 2;
        let best = null;
        let bestScore = - Infinity;
        for (const img of allImages()) {
            const r = img.getBoundingClientRect();
            const visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            if (visibleW < 50 || visibleH < 50) continue;
            const area = visibleW * visibleH;
            const fullArea = Math.max(1, r.width * r.height);
            const mx = r.left + r.width / 2;
            const my = r.top + r.height / 2;
            const distance = Math.hypot(mx - cx, my - cy);
            const score = area * 2 + fullArea - distance * 500;
            if (score > bestScore) {
                bestScore = score;
                best = img;
            }
        }
        return best;
    }
    async function waitForCurrentPageImage(pageNumber, previousSrc = "", timeout = IMAGE_WAIT_FAST) {
        const start = performance.now();
        let stableSrc = "";
        let stableSince = 0;
        let sameSrcSince = 0;
        while (performance.now() - start < timeout) {
            const info = getPageInput();
            if (info?.current === pageNumber) {
                const img = getCurrentPageImage();
                if (img) {
                    const src = img.currentSrc || img.src || "";
                    const valid = src && img.complete && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
                    if (valid) {
                        if (src !== stableSrc) {
                            stableSrc = src;
                            stableSince = performance.now();
                        }
                        if (src === previousSrc) {
                            if (!sameSrcSince) sameSrcSince = performance.now();
                        }else {
                            sameSrcSince = 0;
                        }
                        if (src !== previousSrc && performance.now() - stableSince >= 80) return img;
                        if (src === previousSrc && performance.now() - sameSrcSince >= SAME_IMAGE_GRACE) return img;
                    }
                }
            }
            await sleep(15);
        }
        return null;
    }
    function getPageCountHint() {
        const text = document.body?.innerText || "";
        const m = text.match(/Page\s+\d+\s*\/\s*(\d+)/i);
        if (m) return Number(m[1]);
        const m2 = text.match(/\bPage\s+\d+\s+of\s+(\d+)\b/i);
        return m2  ? Number(m2[1]): null;
    }
    async function waitForPageInfo(timeout = PAGE_COUNT_WAIT) {
        const start = performance.now();
        let lastMax = null;
        let stableCount = 0;
        while (performance.now() - start < timeout) {
            const info = getPageInput(true);
            const max = info?.max || getPageCountHint();
            if (info?.current >= 1 && max >= 1) {
                if (max === lastMax) stableCount++;
                else {
                    lastMax = max;
                    stableCount = 1;
                }
                if (stableCount >= 2) return {
                    ...info, max
                };
            }
            await sleep(40);
        }
        return null;
    }
    async function waitForFirstPageReady(timeout = IMAGE_WAIT_RECOVERY) {
        const start = performance.now();
        let stableSrc = "";
        let stableSince = 0;
        while (performance.now() - start < timeout) {
            const info = getPageInput();
            if (info?.current === 1) {
                const img = getCurrentPageImage();
                if (img) {
                    const src = img.currentSrc || img.src || "";
                    const valid = src && img.complete && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
                    if (valid) {
                        if (src !== stableSrc) {
                            stableSrc = src;
                            stableSince = performance.now();
                        }
                        if (performance.now() - stableSince >= FIRST_PAGE_SETTLE) return img;
                    }
                }
            }
            await sleep(20);
        }
        return null;
    }
    function resetProgressUI() {
        const root = document.getElementById("psd-inpage-overlay");
        if (!root) return;
        const ring = root.querySelector("#psd-inpage-ring");
        if (ring) ring.style.strokeDashoffset = "106.8";
        root.classList.remove("cancelled", "completed");
    }
    function createInPageOverlayRoot() {
        const root = document.createElement("div");
        root.id = "psd-inpage-overlay";
        root.innerHTML = `
      <style>
#psd-inpage-overlay {
    position:fixed;
    right:24px;
    bottom:24px;
    z-index:2147483646;
    pointer-events:none;
    font:14px/1.4 'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:#e3e3e3;
    -webkit-font-smoothing:antialiased
}
#psd-inpage-card {
    width:360px;
    max-width:calc(100vw - 32px);
    background:#28292a;
    border:none;
    outline:none;
    border-radius:20px;
    box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);
    overflow:hidden;
    pointer-events:auto;
    position:relative
}
#psd-inpage-body {
    padding:16px 18px
}
#psd-inpage-head {
    display:grid;
    grid-template-columns:36px minmax(0,1fr) auto;
    align-items:center;
    column-gap:14px;
    min-height:36px;
    position:relative
}
#psd-inpage-spinner,#psd-inpage-check {
    width:36px;
    height:36px;
    flex:0 0 36px;
    position:relative
}
#psd-inpage-spinner svg,#psd-inpage-check svg {
    display:block;
    width:36px;
    height:36px
}
#psd-inpage-spinner svg {
    transform:rotate(-90deg)
}
#psd-inpage-spinner .psd-ring-bg {
    fill:none;
    stroke:#444746;
    stroke-width:3.5
}
#psd-inpage-spinner .psd-ring {
    fill:none;
    stroke:#a8c7fa;
    stroke-width:3.5;
    stroke-linecap:round;
    stroke-dasharray:106.8;
    stroke-dashoffset:106.8;
    transition:stroke-dashoffset .15s linear
}
#psd-inpage-check {
    display:none
}
#psd-inpage-check svg {
    display:block;
    width:36px;
    height:36px
}
#psd-inpage-check circle {
    fill:none;
    stroke:#81c995;
    stroke-width:3.5
}
#psd-inpage-check path {
    fill:none;
    stroke:#81c995;
    stroke-width:3.5;
    stroke-linecap:round;
    stroke-linejoin:round
}
#psd-inpage-title {
    font-size:15px;
    line-height:20px;
    white-space:nowrap;
    font-weight:500;
    color:#e3e3e3;
    letter-spacing:.1px
}
#psd-inpage-detail {
    margin-top:3px;
    font-size:13px;
    color:#c4c7c5;
    line-height:1.4;
    min-height:18px;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis
}
#psd-inpage-actions {
    display:flex;
    align-items:center;
    justify-content:center;
    margin:0;
    align-self:center
}
#psd-inpage-toggle {
    display:block;
    border:none;
    outline:none;
    border-radius:20px;
    padding:7px 18px;
    background:rgba(168,199,250,.12);
    color:#a8c7fa;
    cursor:pointer;
    font:500 13px 'Google Sans',Roboto,sans-serif
}
#psd-inpage-toggle:hover {
    background:rgba(168,199,250,.22)
}
#psd-inpage-toggle:focus-visible {
    outline:2px solid #a8c7fa;
    outline-offset:1px
}
#psd-video-download {
    display:none
}
#psd-inpage-close {
    display:none;
    position:absolute;
    top:10px;
    right:10px;
    width:30px;
    height:30px;
    border:0;
    border-radius:50%;
    background:transparent;
    color:#c4c7c5;
    font:18px/30px Arial,sans-serif;
    cursor:pointer;
    padding:0;
    text-align:center
}
#psd-inpage-close:hover {
    background:rgba(255,255,255,.08);
    color:#e3e3e3
}
#psd-inpage-overlay.completed #psd-inpage-close {
    display:block
}
#psd-inpage-overlay.completed #psd-inpage-toggle {
    display:none
}
#psd-inpage-overlay.cancelled #psd-inpage-card {
    width:auto;
    min-width:190px
}
#psd-inpage-overlay.cancelled #psd-inpage-body {
    padding:16px 20px
}
#psd-inpage-overlay.cancelled #psd-inpage-spinner,#psd-inpage-overlay.cancelled #psd-inpage-actions {
    display:none
}
#psd-inpage-close:focus-visible {
    outline:2px solid #8ab4f8;
    outline-offset:1px
}
#psd-inpage-overlay.completed #psd-inpage-spinner {
    display:none
}
#psd-inpage-overlay.completed #psd-inpage-check {
    display:block
}
#psd-inpage-overlay.completed #psd-inpage-detail {
    display:none
}
#psd-inpage-overlay.completed #psd-inpage-head {
    grid-template-columns:36px minmax(0,1fr) 28px;
    column-gap:14px
}
#psd-inpage-overlay.completed #psd-inpage-close {
    display:block;
    position:static;
    grid-column:3;
    grid-row:1;
    width:28px;
    height:28px;
    line-height:28px;
    margin:0;
    text-align:center
}
#psd-inpage-overlay.cancelled #psd-inpage-title {
    font-size:16px;
    line-height:20px;
    white-space:nowrap
}
      </style>
      <div id="psd-inpage-card">
        <div id="psd-inpage-body">
          <div id="psd-inpage-head">
            <div id="psd-inpage-spinner" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle class="psd-ring-bg" cx="20" cy="20" r="17"></circle><circle id="psd-inpage-ring" class="psd-ring" cx="20" cy="20" r="17"></circle>
              </svg>
            </div>
            <div id="psd-inpage-check" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17"></circle>
                <path d="M11.5 20.5 17 26l11.5-12"></path>
              </svg>
            </div>
            <div>
              <div id="psd-inpage-title">Preparing download</div>
              <div id="psd-inpage-detail"></div>
            </div>
            <div id="psd-inpage-actions"><button id="psd-inpage-toggle" type="button">Cancel</button></div><button id="psd-inpage-close" aria-label="Close">×</button>
          </div>
        </div>
      </div>`;
        return root;
    }
    function bindInPageOverlayEvents(root) {
        const cancelButton = root.querySelector("#psd-inpage-toggle");
        const closeButton = root.querySelector("#psd-inpage-close");
        cancelButton.onclick = () => {
            if (!running) return;
            stopRequested = true;
            const title = root.querySelector("#psd-inpage-title");
            if (title) title.textContent = "Cancelling download";
        };
        closeButton.onclick = () => {
            if (!running) {
                showInPageOverlay(false);
                return;
            }
            if (stopRequested) return;
            stopRequested = true;
            root.classList.remove("completed", "unsupported", "cancelled");
            const title = root.querySelector("#psd-inpage-title");
            const detail = root.querySelector("#psd-inpage-detail");
            if (title) title.textContent = "Cancelling download";
            if (detail) detail.textContent = "";
        };
    }
    function createInPageOverlay() {
        if (document.getElementById("psd-scroll-dim")) return;
        const dim = document.createElement("div");
        dim.id = "psd-scroll-dim";
        dim.setAttribute("aria-hidden", "true");
        dim.style.cssText =
            "position:fixed;inset:0;z-index:2147483645;" +
            "background:rgba(0,0,0,.80);pointer-events:auto;display:none;";
        (document.body || document.documentElement).appendChild(dim);
        if (document.getElementById("psd-inpage-overlay")) return;
        const root = createInPageOverlayRoot();
        (document.body || document.documentElement).appendChild(root);
        root.style.display = "none";
        bindInPageOverlayEvents(root);
    }
    function updateWindowControl() {
        const root = document.getElementById("psd-inpage-overlay");
        if (!root) return;
        if (running) {
            root.classList.remove("idle", "cancelled");
        }
    }
    function showScrollDim(show = true) {
        const dim = document.getElementById("psd-scroll-dim");
        if (dim) dim.style.display = show  ? "block": "none";
    }
    function showInPageOverlay(show = true) {
        createInPageOverlay();
        const root = document.getElementById("psd-inpage-overlay");
        if (root) {
            root.style.display = show  ? "block": "none";
            if (show) {
                root.classList.remove("cancelled", "completed", "unsupported");
                const spinner = root.querySelector("#psd-inpage-spinner");
                const check = root.querySelector("#psd-inpage-check");
                if (spinner) spinner.style.display = "block";
                if (check) check.style.display = "none";
            }
            updateWindowControl();
        }
    }
    function updateInPageOverlay(status, detail, percent) {
        const root = document.getElementById("psd-inpage-overlay");
        if (!root) return;
        const title = root.querySelector("#psd-inpage-title");
        const detailEl = root.querySelector("#psd-inpage-detail");
        if (title && !root.classList.contains("cancelled")) {
            title.textContent = /^File downloaded$/i.test(String(status || ""))  ? "File downloaded": "Preparing download";
        }
        if (detailEl && !root.classList.contains("cancelled")) {
            const text = String(detail || "");
            if (/^(?:Processing page|OCR page)\b/i.test(text)) detailEl.textContent = text;
            else if (/^Loading page\b/i.test(text)) detailEl.textContent = text;
            else if (/^Loading pages\b/i.test(text)) detailEl.textContent = text;
            else if (/^Preparing page\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing page/i, "Capturing page");
            else if (/^Preparing pages\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing pages/i, "Capturing");
            else if (/^Preparing your PDF/i.test(text)) detailEl.textContent = "Preparing PDF…";
            else detailEl.textContent = text;
        }
        if (typeof percent === "number") {
            const safePercent = Math.max(0, Math.min(100, percent));
            const ring = root.querySelector("#psd-inpage-ring");
            if (ring) ring.style.strokeDashoffset = `${106.8 - (106.8 * safePercent / 100)}`;
        }
    }
    function logProgressEvent(text) {
        postExtensionMessage("info", {
            log: text
        });
    }
    let unsupportedTimer = null;
    function reportProgress(status, detail, percent = null, count = null) {
        postExtensionMessage("info", {
            status,
            detail,
            done: count,
            total: currentTotalHint || count,
            percent
        });
        updateInPageOverlay(status, detail, percent);
    }
    function showUnsupportedFile() {
        clearTimeout(unsupportedTimer);
        running = false;
        ready = false;
        completed = false;
        setButtons();
        showInPageOverlay(true);
        const root = document.getElementById("psd-inpage-overlay");
        if (root) {
            root.classList.remove("completed", "cancelled", "minimized");
            root.classList.add("unsupported");
            const title = root.querySelector("#psd-inpage-title");
            const detail = root.querySelector("#psd-inpage-detail");
            const spinner = root.querySelector("#psd-inpage-spinner");
            const actions = root.querySelector("#psd-inpage-actions");
            if (title) title.textContent = "File type not supported";
            if (detail) detail.textContent = "";
            if (spinner) spinner.style.display = "none";
            if (actions) actions.style.display = "none";
        }
        postExtensionMessage("info", {
            status: "File type not supported", detail: "", done: 0, total: 0, percent: 0
        });
        unsupportedTimer = setTimeout(() => {
            const current = document.getElementById("psd-inpage-overlay");
            if (current) {
                current.classList.remove("unsupported");
                current.style.display = "none";
            }
        }, 2000);
    }
    function setButtons() {
        postExtensionMessage("state", {
            running, ready, completed
        });
        updateWindowControl();
    }
    function findPageInput(force = false) {
        const now = performance.now();
        if (!force && pageInputCache && now - pageInputCacheAt < 250 && pageInputCache.isConnected) {
            return pageInputCache;
        }
        const inputs = document.querySelectorAll('input');
        let fallback = null;
        for (const input of inputs) {
            if (!input.offsetParent) continue;
            const value = input.value?.trim();
            if (!/^\d+$/.test(value || '')) continue;
            const a = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('title') || ''} ${input.className || ''}`.toLowerCase();
            if (/page/.test(a)) {
                pageInputCache = input;
                pageInputCacheAt = now;
                return input;
            }
            if (!fallback && input.clientWidth < 120) fallback = input;
        }
        pageInputCache = fallback;
        pageInputCacheAt = now;
        return fallback;
    }
    function getPageInput(force = false) {
        const input = findPageInput(force);
        if (!input) return null;
        return {
            input, current: Number(input.value), max: Number(input.max) || getPageCountHint()
        };
    }
    const pageInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    async function goToPage(pageNumber) {
        const target = String(pageNumber);
        for (let attempt = 0;
        attempt < 3;
        attempt++) {
            const info = getPageInput(true);
            if (!info) {
                await sleep(80);
                continue;
            }
            const input = info.input;
            try {
                input.focus();
            }catch (_) {
            }
            if (pageInputSetter) pageInputSetter.call(input, target);
            else input.value = target;
            input.dispatchEvent(new Event('input', {
                bubbles: true
            }));
            input.dispatchEvent(new Event('change', {
                bubbles: true
            }));
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
            }));
            input.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
            }));
            const deadline = performance.now() + Math.max(300, scrollDelay + 260);
            while (performance.now() < deadline) {
                const current = getPageInput();
                if (current?.current === pageNumber) return true;
                await sleep(15);
            }
        }
        return false;
    }
    let scrollRootsCache = null;
    let scrollRootsCacheAt = 0;
    function getScrollableElements(force = false) {
        const now = performance.now();
        if (!force && scrollRootsCache && now - scrollRootsCacheAt < 500) return scrollRootsCache;
        const result = [];
        const all = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll('*')];
        for (const el of all) {
            if (!el) continue;
            const canScroll = el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'hidden';
            if (canScroll) result.push(el);
        }
        scrollRootsCache = [...new Set(result)].sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        scrollRootsCacheAt = now;
        return scrollRootsCache;
    }
    function scrollViewerStep(roots = getScrollableElements()) {
        let moved = false;
        for (const root of roots.slice(0, 4)) {
            const before = root.scrollTop;
            const amount = Math.max(500, Math.floor(root.clientHeight * 0.9));
            root.scrollTop = Math.min(root.scrollTop + amount, root.scrollHeight - root.clientHeight);
            if (root.scrollTop !== before) moved = true;
        }
        return moved;
    }
    function resetCaptureState() {
        pages.clear();
        capturedPages.clear();
        currentTotalHint = null;
        orderCounter = 0;
    }
    function rememberCapturedPage(pageNumber, image) {
        const src = image?.currentSrc || image?.src || "";
        if (!src) return false;
        const page = {
            src,
            w: image.naturalWidth,
            h: image.naturalHeight,
            order: pageNumber - 1,
            pageNumber
        };
        capturedPages.set(pageNumber, page);
        if (!pages.has(src)) {
            pages.set(src, {
                ...page,
                order: orderCounter++
            });
        }
        return true;
    }
    async function capturePagesByNumber(totalHint) {
        if (!totalHint) return;
        reportProgress("Preparing…", `Checking first page / ${totalHint}`, 0, 0);
        await goToPage(1);
        const firstImage = await waitForFirstPageReady();
        if (firstImage) {
            rememberCapturedPage(1, firstImage);
            logProgressEvent(`✓ First page verified and captured — 1/${totalHint}`);
        } else {
            logProgressEvent("⚠ First page did not finish rendering during preflight; it will be retried in recovery.");
        }
        logProgressEvent("✓ Starting single-pass capture…");
        for (let pageNumber = 2; pageNumber <= totalHint && !stopRequested; pageNumber++) {
            await capturePageWithRetry(pageNumber, totalHint);
        }
    }
    async function capturePageWithRetry(pageNumber, totalHint) {
        const previousImage = getCurrentPageImage();
        const previousSrc = previousImage?.currentSrc || previousImage?.src || "";
        let captured = false;
        for (let attempt = 0; attempt < 2 && !stopRequested && !captured; attempt++) {
            reportProgress(
                "Preparing…",
                `Capturing page ${pageNumber} / ${totalHint}`,
                Math.floor((pageNumber - 1) / totalHint * 50),
                capturedPages.size
            );
            const navigated = await goToPage(pageNumber);
            if (!navigated) {
                logProgressEvent(`⚠ Could not navigate to page ${pageNumber} (attempt ${attempt + 1}/2)`);
                continue;
            }
            const timeout = attempt === 0 ? IMAGE_WAIT_FAST : IMAGE_WAIT_RECOVERY;
            const image = await waitForCurrentPageImage(pageNumber, previousSrc, timeout);
            if (!image) continue;
            const src = image.currentSrc || image.src || "";
            if (!src || image.naturalWidth < MIN_W || image.naturalHeight < MIN_H) {
                continue;
            }
            captured = rememberCapturedPage(pageNumber, image);
        }
        if (!captured) {
            logProgressEvent(`⚠ Could not resolve the rendered image for page ${pageNumber}`);
        }
        const percent = Math.floor(pageNumber / totalHint * 50);
        reportProgress(
            "Preparing…",
            `Capturing page ${pageNumber} / ${totalHint}`,
            percent,
            capturedPages.size
        );
        if (pageNumber % 10 === 0 || pageNumber === totalHint) {
            logProgressEvent(
                `✓ Page ${pageNumber}/${totalHint} — ` +
                `${capturedPages.size}/${totalHint} pages captured`
            );
        }
    }
    async function capturePagesByScrolling(totalHint) {
        logProgressEvent("Page-number control not found. Using automatic scrolling fallback…");
        let roots = getScrollableElements(true);
        for (let step = 0; step < 3000 && !stopRequested; step++) {
            if (step % 12 === 0) {
                roots = getScrollableElements(true);
            }
            let atBottom = roots.length > 0;
            for (const root of roots.slice(0, 4)) {
                atBottom = atBottom &&
                    root.scrollTop >= root.scrollHeight - root.clientHeight - 10;
            }
            const pagesBeforeScroll = pages.size;
            const moved = scrollViewerStep(roots);
            await sleep(scrollDelay);
            scanRenderedPages();
            const percent = totalHint
                ? Math.min(
                    50,
                    Math.floor(Math.min(pages.size, totalHint) / totalHint * 50)
                )
                : Math.min(50, Math.floor(step / 1000 * 50));
            reportProgress(
                "Preparing…",
                `Capturing ${pages.size}${totalHint ? " / " + totalHint : ""}`,
                percent,
                pages.size
            );
            if (pages.size > pagesBeforeScroll) {
                logProgressEvent(
                    `✓ ${pages.size}${totalHint ? "/" + totalHint : ""} page images found`
                );
            }
            if ((!moved || atBottom) && pages.size === pagesBeforeScroll) {
                await sleep(150);
                scanRenderedPages();
                if (pages.size === pagesBeforeScroll) {
                    break;
                }
            }
        }
    }
    async function recoverMissingPages(totalHint) {
        if (!totalHint || capturedPages.size >= totalHint) return;
        const missingPages = [];
        for (let pageNumber = 1; pageNumber <= totalHint; pageNumber++) {
            if (!capturedPages.has(pageNumber)) {
                missingPages.push(pageNumber);
            }
        }
        logProgressEvent(`⚠ ${missingPages.length} pages not yet captured. Running recovery check…`);
        for (let index = 0; index < missingPages.length && !stopRequested; index++) {
            const pageNumber = missingPages[index];
            const previousImage = getCurrentPageImage();
            const previousSrc = previousImage?.currentSrc || previousImage?.src || "";
            await goToPage(pageNumber);
            const image = await waitForCurrentPageImage(
                pageNumber,
                previousSrc,
                IMAGE_WAIT_RECOVERY
            );
            if (image) {
                rememberCapturedPage(pageNumber, image);
            }
            const progress = 50 + Math.floor(
                (index + 1) / Math.max(1, missingPages.length) * 25
            );
            reportProgress(
                "Preparing…",
                `Capturing page ${pageNumber} / ${totalHint}`,
                progress,
                capturedPages.size
            );
        }
    }
    function finishCancelledCapture() {
        showScrollDim(false);
        running = false;
        setButtons();
        const root = document.getElementById("psd-inpage-overlay");
        if (root) {
            root.classList.add("cancelled");
            root.querySelector("#psd-inpage-title").textContent = "Download cancelled";
            setTimeout(() => showInPageOverlay(false), 800);
        }
        logProgressEvent("Preload stopped.");
    }
    async function preparePDFCapture() {
        if (running || !isDrivePage()) return;
        if (!currentDriveFileIsPDF()) {
            running = false;
            ready = false;
            setButtons();
            showUnsupportedFile();
            return;
        }
        running = true;
        stopRequested = false;
        ready = false;
        resetCaptureState();
        resetProgressUI();
        const overlay = document.getElementById("psd-inpage-overlay");
        overlay?.classList.remove("minimized");
        setButtons();
        showScrollDim(true);
        reportProgress("Preparing…", "Reading page count…", 0, 0);
        const pageInfo = await waitForPageInfo();
        const totalHint = pageInfo?.max || getPageCountHint();
        currentTotalHint = totalHint;
        logProgressEvent(`Detected page count: ${totalHint || "unknown"}`);
        if (pageInfo && totalHint) {
            await capturePagesByNumber(totalHint);
        } else {
            await capturePagesByScrolling(totalHint);
        }
        if (stopRequested) {
            finishCancelledCapture();
            return;
        }
        await recoverMissingPages(totalHint);
        if (pageInfo && totalHint && !stopRequested) {
            await goToPage(1);
            await waitForCurrentPageImage(1, "", IMAGE_WAIT_FAST);
        }
        showScrollDim(false);
        const capturedCount = totalHint ? capturedPages.size : pages.size;
        const total = totalHint || capturedCount;
        ready = capturedCount > 0 && (!totalHint || capturedCount >= totalHint);
        running = false;
        setButtons();
        const detail = ready
            ? `${capturedCount} / ${total} page images captured`
            : `${capturedCount} / ${total || "?"} page images captured. Try Start again.`;
        const percent = ready
            ? 100
            : Math.min(99, Math.floor(capturedCount / Math.max(1, total) * 100));
        reportProgress(
            ready ? "Ready to process PDF" : "Some pages were not captured",
            detail,
            percent,
            capturedCount
        );
        logProgressEvent(
            ready
                ? "✓ Capture complete — all pages captured. Starting OCR/PDF processing…"
                : "⚠ Capture ended before all pages were captured."
        );
        if (ready && !stopRequested) {
            await generatePDF();
        }
    }
    function getPDFDownloadFilename() {
        let title = document.querySelector('meta[itemprop="name"]')?.content || document.title || "download.pdf";
        title = title.replace(/\s*-\s*Google Drive\s*$/i, "").trim();
        if (!/\.pdf$/i.test(title)) title += ".pdf";
        return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    }
    let ocrWorker = null;
    let ocrRequestId = 0;
    const ocrRequests = new Map();
    function getOCRWorker() {
        if (ocrWorker) return ocrWorker;
        const workerURL = chrome.runtime.getURL("vendor/ocr-worker.js");
        ocrWorker = new Worker(workerURL);
        ocrWorker.onmessage = event => {
            const message = event.data || {
            };
            if (message.type === "progress") {
                ocrProgress = Math.max(0, Math.min(1, Number(message.progress) || 0));
                return;
            }
            if (message.type !== "result" && message.type !== "error") return;
            const request = ocrRequests.get(message.id);
            if (!request) return;
            ocrRequests.delete(message.id);
            if (message.type === "error") request.reject(new Error(message.message || "OCR failed."));
            else request.resolve(message.words || []);
        };
        ocrWorker.onerror = event => {
            const error = new Error(event.message || "Offline OCR worker failed.");
            for (const request of ocrRequests.values()) request.reject(error);
            ocrRequests.clear();
            try {
                ocrWorker?.terminate();
            }catch (_) {
            }
            ocrWorker = null;
        };
        return ocrWorker;
    }
    async function shutdownOCRWorker() {
        if (!ocrWorker) return;
        for (const request of ocrRequests.values()) {
            request.reject(new Error("OCR worker stopped."));
        }
        ocrRequests.clear();
        try {
            ocrWorker.terminate();
        }catch (_) {
        }
        ocrWorker = null;
    }
    let ocrProgress = 0;
    async function runOCROnPage(imageBytes) {
        const worker = getOCRWorker();
        ocrProgress = 0;
        const id = ++ ocrRequestId;
        return new Promise((resolve, reject) => {
            ocrRequests.set(id, {
                resolve, reject
            });
            try {
                worker.postMessage({
                    type: "recognize", id, image: imageBytes
                }, [imageBytes.buffer]);
            }catch (error) {
                ocrRequests.delete(id);
                reject(error);
            }
        });
    }
    async function encodePageAsJPEG(page) {
        let img = [...document.images].find(i => (i.currentSrc || i.src) === page.src);
        if (!img) {
            img = new Image();
            img.src = page.src;
        }
        if (!img.complete) await img.decode();

        const canvas = document.createElement("canvas");
        canvas.width = page.w;
        canvas.height = page.h;
        canvas.getContext("2d", { alpha: false }).drawImage(img, 0, 0, page.w, page.h);

        const blob = await new Promise((resolve, reject) =>
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("JPEG encoding failed")), "image/jpeg", 0.92)
        );
        return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            width: page.w,
            height: page.h
        };
    }
    function pdfEscapeText(text) {
        return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[\r\n]+/g, " ");
    }
    function makePDFWriter(total) {
        const chunks = [];
        let pos = 0;
        const enc = new TextEncoder();
        const pushBytes = b => {
            chunks.push(b);
            pos += b.length;
        };
        const pushStr = str => pushBytes(enc.encode(str));
        const pageObj = i => 3 + i * 3;
        const imageObj = i => 4 + i * 3;
        const contentObj = i => 5 + i * 3;
        const fontObj = 3 + total * 3;
        const maxObj = fontObj;
        pushStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
        const xref = new Array(maxObj + 1).fill(0);
        const beginObj = n => {
            xref[n] = pos;
            pushStr(`${n} 0 obj\n`);
        };
        const endObj = () => pushStr("\nendobj\n");
        beginObj(1);
        pushStr(`<< /Type /Catalog /Pages 2 0 R >>`);
        endObj();
        beginObj(2);
        pushStr(`<< /Type /Pages /Kids [${Array.from({length: total}, (_, i) => pageObj(i) + " 0 R").join(" ")}] /Count ${total} >>`);
        endObj();
        return {
            addPage: (i, im) => {
                const w = im.width, h = im.height;
                beginObj(pageObj(i));
                pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i + 1} ${imageObj(i)} 0 R >> /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
                endObj();
                const bytes = im.bytes;
                beginObj(imageObj(i));
                pushStr(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
                pushBytes(bytes);
                pushStr("\nendstream");
                endObj();
                let content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im${i + 1} Do\nQ\n`;
                if (Array.isArray(im.words) && im.words.length) {
                    content += "BT\n/F1 10 Tf\n3 Tr\n";
                    for (const word of im.words) {
                        const height = Math.max(4, word.y1 - word.y0);
                        const size = Math.max(4, Math.min(72, height * 0.9));
                        const x = word.x0;
                        const y = h - word.y1 + Math.max(0, (word.y1 - word.y0) * 0.12);
                        content += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n/F1 ${size.toFixed(2)} Tf\n(${pdfEscapeText(word.text)}) Tj\n`;
                    }
                    content += "0 Tr\nET\n";
                }
                const contentBytes = enc.encode(content);
                beginObj(contentObj(i));
                pushStr(`<< /Length ${contentBytes.length} >>\nstream\n`);
                pushBytes(contentBytes);
                pushStr("endstream");
                endObj();
            }, finish: () => {
                beginObj(fontObj);
                pushStr(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
                endObj();
                const xrefPos = pos;
                pushStr(`xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`);
                for (let n = 1;
                n <= maxObj;
                n++) pushStr(String(xref[n]).padStart(10, "0") + " 00000 n \n");
                pushStr(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);
                return new Blob(chunks, {
                    type: "application/pdf"
                });
            }
        };
    }
    function getOrderedCapturedPages() {
        return [...(capturedPages.size ? capturedPages : pages).values()].sort((a, b) =>
            (a.pageNumber ?? a.order) - (b.pageNumber ?? b.order)
        );
    }
    async function convertPageToPDF(writer, page, index, total) {
        const jpeg = await encodePageAsJPEG(page);
        let words = [];

        if (enableOCR) {
            reportProgress(
                "Preparing…",
                `OCR page ${index + 1} / ${total}`,
                50 + Math.floor(((index + 0.35) / total) * 48),
                index
            );

            try {
                words = await runOCROnPage(jpeg.bytes.slice());
            } catch (ocrError) {
                logProgressEvent(`⚠ OCR unavailable (${ocrError.message}). Continuing without OCR.`);
            }
        } else {
            reportProgress(
                "Preparing…",
                `Processing page ${index + 1} / ${total}`,
                50 + Math.floor((index / total) * 48),
                index
            );
        }

        writer.addPage(index, {
            width: jpeg.width,
            height: jpeg.height,
            bytes: jpeg.bytes,
            words
        });
    }
    function showPDFCancelledState() {
        const root = document.getElementById("psd-inpage-overlay");
        if (!root) return;
        root.classList.add("cancelled");
        root.querySelector("#psd-inpage-title").textContent = "Download cancelled";
        setTimeout(() => showInPageOverlay(false), 800);
    }
    async function finishPDFDownload(writer, converted) {
        reportProgress("Preparing…", "Finalizing the PDF file", 99, converted);
        await shutdownOCRWorker();
        const blob = writer.finish();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = getPDFDownloadFilename();
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        running = false;
        completed = true;
        ready = false;
        resetCaptureState();
        setButtons();
        reportProgress("File downloaded", "", 100, converted);
        const doneRoot = document.getElementById("psd-inpage-overlay");
        if (doneRoot) {
            doneRoot.classList.remove("cancelled", "unsupported");
            doneRoot.classList.add("completed");
            const doneSpinner = doneRoot.querySelector("#psd-inpage-spinner");
            const doneCheck = doneRoot.querySelector("#psd-inpage-check");
            const doneActions = doneRoot.querySelector("#psd-inpage-actions");
            const doneTitle = doneRoot.querySelector("#psd-inpage-title");
            const doneDetail = doneRoot.querySelector("#psd-inpage-detail");
            if (doneSpinner) doneSpinner.style.display = "none";
            if (doneCheck) doneCheck.style.display = "block";
            if (doneActions) doneActions.style.display = "none";
            if (doneTitle) doneTitle.textContent = "File downloaded";
            if (doneDetail) doneDetail.textContent = "";
        }
        updateWindowControl();
        logProgressEvent(`✓ Downloaded ${getPDFDownloadFilename()}`);
    }
    async function generatePDF() {
        if (running || (!capturedPages.size && !pages.size)) return;
        running = true;
        stopRequested = false;
        const overlay = document.getElementById("psd-inpage-overlay");
        if (overlay) {
            overlay.classList.remove("quiet", "idle");
        }
        setButtons();
        const orderedPages = getOrderedCapturedPages();
        const total = orderedPages.length;
        const writer = makePDFWriter(total);
        reportProgress("Preparing…", `${enableOCR ? "OCR" : "Processing"} page 1 / ${total}`, 50, 0);
        logProgressEvent(`Generating ${total}-page PDF…`);
        let converted = 0;
        for (let index = 0; index < orderedPages.length; index++) {
            if (stopRequested) break;
            try {
                await convertPageToPDF(writer, orderedPages[index], index, total);
                converted++;
                if ((index + 1) % 5 === 0 || index === orderedPages.length - 1) {
                    logProgressEvent(`✓ Processed ${index + 1}/${total}`);
                }
                if ((index + 1) % 5 === 0) await sleep(0);
            } catch (error) {
                logProgressEvent(`✕ Page ${index + 1}: ${error.message}`);
            }
        }
        if (stopRequested || converted !== total) {
            running = false;
            setButtons();
            if (stopRequested) {
                showPDFCancelledState();
                await shutdownOCRWorker();
                logProgressEvent("PDF generation stopped.");
            } else {
                reportProgress(
                    "PDF incomplete",
                    `${converted} of ${total} pages were converted. No download was made.`,
                    0,
                    converted
                );
            }
            return;
        }
        await finishPDFDownload(writer, converted);
    }
async function startPDFDownload(options = {}) {
        if (running) return;
        if (Object.prototype.hasOwnProperty.call(options, "enableOCR")) {
            enableOCR = !!options.enableOCR;
        }else {
            try {
                const pref = await chrome.storage.local.get({
                    ocrEnabled: true
                });
                enableOCR = pref.ocrEnabled !== false;
            }catch (_) {
                enableOCR = true;
            }
        }
        completed = false;
        resetProgressUI();
        await preparePDFCapture();
    }
    function handlePDFCommand(msg) {
        if (msg.type === "init") {
            setButtons();
            if (!isDrivePage()) {
                const root = document.getElementById("psd-inpage-overlay");
                if (root) root.remove();
                return;
            }else if (!currentDriveFileIsPDF()) {
                showUnsupportedFile();
            }else {
                reportProgress("Ready", "", ready  ? 100: null, ready  ? 0: 0);
            }
        }
        if (msg.type === "start") startPDFDownload();
        if (msg.type === "stop") stopRequested = true;
        if (msg.type === "openOverlay") {
            showInPageOverlay(true);
            updateWindowControl();
        }
    }
    // Extension messaging
    chrome.runtime.onConnect.addListener(port => {
        if (port.name !== "pdf-downloader") return;
        activePort = port;
        port.onMessage.addListener(handlePDFCommand);
        port.onDisconnect.addListener(() => {
            if (activePort === port) activePort = null;
            // Do not reopen the overlay when the popup/port disconnects.
            updateWindowControl();
        });
        updateWindowControl();
        handlePDFCommand({
            type: "init"
        });
    });
    // Video processing overlay: intentionally mirrors the compact PDF downloader UI.
    // Video overlay states:
    //   Downloading -> Merging -> Processing download -> Download has started -> Video Downloaded
    const videoOverlay = window.GDriveVideoOverlay;
    if (!videoOverlay) throw new Error("Video overlay module failed to load.");
    const videoStageTypes = new Set(["videoStagePreload", "videoStageStarted", "videoStageStatus", "videoStageProgress", "videoStageMergeProgress", "videoStageDownloadStarted", "videoStageFinished", "videoStageError", "videoStageCancelled"]);
    const setVideoBusy = busy => { videoDownloadInProgress = busy; updateVideoMenuState(); };
    chrome.runtime.onMessage.addListener(msg => {
        if (window.top !== window.self || !videoStageTypes.has(msg?.type)) return;
        if (msg.type === "videoStagePreload") {
            const job = videoOverlay.getJobId(), stage = videoOverlay.getStage();
            if ((job && job !== msg.jobId && !["ready", "cancelled", "error"].includes(stage)) || (job === msg.jobId && stage !== "download")) return;
            return videoOverlay.show(true, msg.jobId || null, msg.videoBytes || 0, msg.audioBytes || 0);
        }
        const activeJob = videoOverlay.getJobId();
        if (activeJob && msg.jobId && activeJob !== msg.jobId) return;
        switch (msg.type) {
            case "videoStageStatus":
                if (msg.stage === "staged" || msg.stage === "merge") videoOverlay.update({ stage: "merge", progress: msg.stage === "staged" ? 0 : undefined });
                else if (msg.stage === "processing") videoOverlay.update({ stage: "processing" });
                break;
            case "videoStageStarted":
                videoOverlay.setJob(msg.jobId || activeJob, msg.videoBytes || 0, msg.audioBytes || 0);
                break;
            case "videoStageProgress":
                videoOverlay.update({ label: msg.label, received: msg.received, total: msg.total });
                break;
            case "videoStageMergeProgress":
                videoOverlay.update({ stage: "merge", progress: msg.progress });
                break;
            case "videoStageDownloadStarted":
                videoOverlay.update({ stage: "started" });
                break;
            case "videoStageFinished":
                setVideoBusy(false); videoOverlay.update({ stage: "ready" });
                break;
            case "videoStageError":
                videoOverlay.clearJob(); setVideoBusy(false); videoOverlay.update({ stage: "error", message: msg.message || "Video processing failed." });
                break;
            case "videoStageCancelled":
                videoOverlay.clearJob(); setVideoBusy(false); videoOverlay.update({ stage: "cancel" });
                break;
        }
    });
    // Keep one consistent in-page controller. It never hides when the extension popup opens.
    // Install this in every content-script frame so Drive's actual player can
    // report playback back to the top-level menu document.
    installFramePlaybackRelay();
    if (isDrivePage()) {
        createInPageOverlay();
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => watchDriveMenus(), {
                once: true
            });
        }else {
            watchDriveMenus();
        }
    }
    // If Start was pressed from a Classroom PDF preview, resume automatically
    // after the page has navigated into Google Drive.
    if (location.hostname.endsWith("drive.google.com")) {
        consumeAutoStart().then(pending => {
            if (pending) {
                const waitForViewer = () => {
                    if (currentDriveFileIsPDF()) startPDFDownload();
                    else setTimeout(waitForViewer, 100);
                };
                waitForViewer();
            }
        });
    }
})();
