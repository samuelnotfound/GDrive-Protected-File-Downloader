
(() => {
    if (!window.__PSD_LOADED || window.__PSD_PDF_LOADED) return;
    window.__PSD_PDF_LOADED = true;
    const app = window.__PSD;
    const pdf = app.pdfState;
    const PREFIX = 'blob:https://drive.google.com/';
    const MIN_W = 500;
    const MIN_H = 300;
    // Normal capture is intentionally short. Missed pages are handled by the recovery pass.
    const IMAGE_WAIT_FAST = 700;
    const IMAGE_WAIT_RECOVERY = 1800;
    const PAGE_COUNT_WAIT = 800;
    const POLL_INTERVAL = 35;
    const IMAGE_STABLE_MS = 40;
    const PAGE_NAV_WAIT = 250;
    const SCROLL_SETTLE = 60;

    const reportProgress = (status, detail, percent = null) =>
        app.ui.updateInPageOverlay(status, detail, percent);
    const RING_CIRCUMFERENCE = 2 * Math.PI * 17;
    function resetProgressUI() {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;
        const ring = root.querySelector('#psd-inpage-ring');
        if (ring) {
            ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
        }
        root.classList.remove('cancelled', 'completed');
    }
    function showUnsupportedFile() {
        clearTimeout(pdf.unsupportedTimer);
        pdf.status = 'idle';
        app.ui.updateWindowControl();
        app.ui.showInPageOverlay(true);
        const root = document.getElementById('psd-inpage-overlay');
        if (root) {
            root.classList.remove('completed', 'cancelled', 'minimized');
            root.classList.add('unsupported');
            const title = root.querySelector('#psd-inpage-title');
            const detail = root.querySelector('#psd-inpage-detail');
            const spinner = root.querySelector('#psd-inpage-spinner');
            const actions = root.querySelector('#psd-inpage-actions');
            if (title) title.textContent = 'File type not supported';
            if (detail) detail.textContent = '';
            if (spinner) spinner.style.display = 'none';
            if (actions) actions.style.display = 'none';
        }
        pdf.unsupportedTimer = setTimeout(() => {
            const current = document.getElementById('psd-inpage-overlay');
            if (current) {
                current.classList.remove('unsupported');
                current.style.display = 'none';
            }
        }, 2000);
    }

    const addProtectedPDFMenuDescription = item => app.ui.addMenuDescription(item, "psd-pdf-menu-label", "psd-pdf-menu-info", "GDrive Protected File Downloader");
    function activateProtectedPDFDownload(event) {
        event.preventDefault();
        event.stopPropagation();
        app.ui.closeDriveFileMenu();
        app.ui.showInPageOverlay(true);
        const root = document.getElementById("psd-inpage-overlay");
        root?.classList.remove("quiet", "idle", "completed", "cancelled");
        root?.querySelector("#psd-inpage-title")?.replaceChildren(
            document.createTextNode("Preparing download")
        );
        root?.querySelector("#psd-inpage-detail")?.replaceChildren(
            document.createTextNode("")
        );
        void start();
    }
    function scanMenu(menu) {
        if (!app.isDrivePage() || !document.body || !currentDriveFileIsPDF()) return;
        if (menu.querySelector(`#${app.ids.pdfMenu}`)) return;
        const nativeDownload = app.ui.findMenuRow(menu, 'Download');
        const nativeDisabled = !!nativeDownload && (
            nativeDownload.getAttribute('aria-disabled') === 'true' ||
            nativeDownload.hasAttribute('disabled') ||
            nativeDownload.dataset.disabled === 'true' ||
            nativeDownload.classList.contains('disabled')
        );
        if (nativeDownload && !nativeDisabled) return;
        const templateRow =
            app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') ||
            app.ui.findMenuRow(menu, 'Security limitations') ||
            nativeDownload;
        if (!templateRow) return;
        const item = app.ui.makeStandaloneMenuRow(templateRow, app.ids.pdfMenu, 'Download');
        if (!item) return;
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item);
        addProtectedPDFMenuDescription(item);
        item.addEventListener('click', activateProtectedPDFDownload);
        app.ui.handleMenuKeyboardActivation(item, activateProtectedPDFDownload);
        app.ui.insertAfterReference(menu, item, app.ui.findShareRow(menu));
    }

    function looksLikePDFName(value = "") {
        return /\.pdf(?:$|[?#])/i.test(value) || /\bpdf\b/i.test(value) && /\.pdf\b/i.test(value);
    }

    function currentDriveFileIsPDF() {
        if (!location.hostname.endsWith("drive.google.com")) return false;
        const title = document.title || "";
        if (looksLikePDFName(title)) return true;

        const info = document.querySelector("#drive-active-item-info");
        if (info?.textContent) {
            try {
                const data = JSON.parse(info.textContent);
                if (/application\/pdf/i.test(data?.mimeType || data?.mime_type || "") || looksLikePDFName(data?.title || "")) return true;
            } catch (_) {}
        }

        return !!document.querySelector('[aria-label*=".pdf" i], [title*=".pdf" i], [data-tooltip*=".pdf" i]');
    }

    let viewerImageRoot = null;
    let viewerImageRootAt = 0;

    function getViewerImageRoot() {
        const now = performance.now();
        if (viewerImageRoot?.isConnected && now - viewerImageRootAt < 1000) return viewerImageRoot;
        viewerImageRoot = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]') || document;
        viewerImageRootAt = now;
        return viewerImageRoot;
    }

    function allImages() {
        return [...getViewerImageRoot().querySelectorAll("img")].filter(img => {
            const src = img.currentSrc || img.src || "";
            return src.startsWith(PREFIX) && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
        });
    }

    function scanRenderedPages(pageNumber = null) {
        let added = 0;
        for (const img of allImages()) {
            const src = img.currentSrc || img.src || "";
            if (!pdf.pages.has(src)) {
                pdf.pages.set(src, {
                    src, w: img.naturalWidth, h: img.naturalHeight, order: pdf.orderCounter++, pageNumber
                });
                added++;
            } else if (pageNumber != null) {
                const page = pdf.pages.get(src);
                if (page && page.pageNumber == null) page.pageNumber = pageNumber;
            }
        }
        return added;
    }

    function getCurrentPageImage() {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const vh = window.innerHeight || document.documentElement.clientHeight || 1;
        const cx = vw / 2, cy = vh / 2;
        let best = null, bestScore = -Infinity;

        for (const img of allImages()) {
            const r = img.getBoundingClientRect();
            const visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            if (visibleW < 50 || visibleH < 50) continue;
            const area = visibleW * visibleH;
            const fullArea = Math.max(1, r.width * r.height);
            const distance = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
            const score = area * 2 + fullArea - distance * 500;
            if (score > bestScore) {
                bestScore = score;
                best = img;
            }
        }
        return best;
    }

    async function waitForCurrentPageImage(pageNumber, previousSrc = "", timeout = IMAGE_WAIT_FAST, allowSameSrc = false) {
        const deadline = performance.now() + timeout;
        let stableSrc = "";
        let stableSince = 0;

        while (!pdf.stopRequested && performance.now() < deadline) {
            const info = getPageInput();
            if (info?.current === pageNumber) {
                const img = getCurrentPageImage();
                const src = img?.currentSrc || img?.src || "";
                const valid = !!(img && img.complete && src.startsWith(PREFIX) && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H && (allowSameSrc || src !== previousSrc));

                if (valid) {
                    if (src !== stableSrc) {
                        stableSrc = src;
                        stableSince = performance.now();
                    } else if (performance.now() - stableSince >= IMAGE_STABLE_MS) {
                        try {
                            await img.decode();
                        } catch (_) {
                            return null;
                        }
                        const finalSrc = img.currentSrc || img.src || "";
                        if (finalSrc === src && Number(getPageInput()?.current) === pageNumber) return img;
                    }
                }
            }
            await app.sleep(POLL_INTERVAL);
        }
        return null;
    }

    let pageCountCache = null;
    let pageCountCacheAt = 0;

    function getPageCountHint() {
        const now = performance.now();
        if (now - pageCountCacheAt < 250) return pageCountCache;
        const text = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]')?.textContent || document.body?.innerText || "";
        const match = text.match(/Page\s+\d+\s*(?:\/|of)\s*(\d+)/i);
        pageCountCache = match ? Number(match[1]) : null;
        pageCountCacheAt = now;
        return pageCountCache;
    }

    async function waitForPageInfo(timeout = PAGE_COUNT_WAIT) {
        const deadline = performance.now() + timeout;
        let lastMax = null;
        let firstCheck = true;
        while (!pdf.stopRequested && performance.now() < deadline) {
            const info = getPageInput(firstCheck);
            firstCheck = false;
            const max = info?.max || getPageCountHint();
            if (info?.current >= 1 && max >= 1) {
                if (max === lastMax) return { ...info, max };
                lastMax = max;
            }
            await app.sleep(40);
        }
        return null;
    }

    let pageInputCache = null;
    let pageInputCacheAt = 0;

    function findPageInput(force = false) {
        const now = performance.now();
        if (!force && pageInputCache?.isConnected && now - pageInputCacheAt < 500) return pageInputCache;

        const preferred = document.querySelector('input[aria-label*="page" i], input[title*="page" i]');
        if (preferred && preferred.offsetParent) {
            pageInputCache = preferred;
            pageInputCacheAt = now;
            return preferred;
        }

        let fallback = null;
        for (const input of document.querySelectorAll("input")) {
            if (!input.offsetParent || !/^\d+$/.test(input.value?.trim() || "")) continue;
            const hint = `${input.getAttribute("aria-label") || ""} ${input.getAttribute("title") || ""} ${input.className || ""}`.toLowerCase();
            if (/page/.test(hint)) {
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
        return { input, current: Number(input.value), max: Number(input.max) || getPageCountHint() };
    }

    const pageInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    async function goToPage(pageNumber, waitMs = PAGE_NAV_WAIT) {
        if (pdf.stopRequested) return false;
        let info = getPageInput();
        if (!info) info = getPageInput(true);
        if (!info) return false;

        const input = info.input;
        const target = String(pageNumber);
        try { input.focus(); } catch (_) {}
        if (pageInputSetter) pageInputSetter.call(input, target);
        else input.value = target;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));

        const deadline = performance.now() + waitMs;
        while (!pdf.stopRequested && performance.now() < deadline) {
            if (getPageInput()?.current === pageNumber) return true;
            await app.sleep(POLL_INTERVAL);
        }
        return getPageInput()?.current === pageNumber;
    }

    let scrollRootsCache = null;
    let scrollRootsCacheAt = 0;

    function getScrollableElements(force = false) {
        const now = performance.now();
        if (!force && scrollRootsCache && now - scrollRootsCacheAt < 1000) return scrollRootsCache;
        const roots = [];
        for (const element of [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("*")]) {
            if (!element || element.scrollHeight <= element.clientHeight + 50) continue;
            if (getComputedStyle(element).overflowY === "hidden") continue;
            roots.push(element);
        }
        scrollRootsCache = [...new Set(roots)].sort((a, b) =>
            (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
        );
        scrollRootsCacheAt = now;
        return scrollRootsCache;
    }

    function scrollViewerStep(roots = getScrollableElements()) {
        for (const root of roots.slice(0, 2)) {
            const before = root.scrollTop;
            const max = root.scrollHeight - root.clientHeight;
            if (max <= before + 2) continue;
            root.scrollTop = Math.min(max, before + Math.max(500, Math.floor(root.clientHeight * 0.88)));
            if (root.scrollTop !== before) return true;
        }
        return false;
    }

    function resetCaptureState() {
        pdf.pages.clear();
        pdf.capturedPages.clear();
        pdf.orderCounter = 0;
        pageInputCache = null;
        pageCountCache = null;
        viewerImageRoot = null;
    }
    function rememberCapturedPage(pageNumber, image) {
        const src = image?.currentSrc || image?.src || "";
        if (!src) return false;
        const page = {
            src,
            image,
            w: image.naturalWidth,
            h: image.naturalHeight,
            order: pageNumber - 1,
            pageNumber
        };
        pdf.capturedPages.set(pageNumber, page);
        if (!pdf.pages.has(src)) {
            pdf.pages.set(src, {
                ...page,
                order: pdf.orderCounter++
            });
        }
        return true;
    }
    async function capturePage(pageNumber, imageWaitMs, navigateWaitMs = PAGE_NAV_WAIT, allowSameImageIfAlreadyCurrent = false) {
        const currentPage = getPageInput()?.current || 0;
        const previous = getCurrentPageImage();
        const previousSrc = previous?.currentSrc || previous?.src || "";
        if (!(await goToPage(pageNumber, navigateWaitMs))) return false;

        const allowSameSrc = allowSameImageIfAlreadyCurrent && currentPage === pageNumber && previousSrc !== "";
        const image = await waitForCurrentPageImage(pageNumber, previousSrc, imageWaitMs, allowSameSrc);
        return !!(image && rememberCapturedPage(pageNumber, image));
    }

    async function capturePagesByNumber(totalHint) {
        if (!totalHint || pdf.stopRequested) return;

        for (let pageNumber = 1; pageNumber <= totalHint && !pdf.stopRequested; pageNumber++) {
            const captured = await capturePage(pageNumber, IMAGE_WAIT_FAST);
            reportProgress(
                "Preparing…",
                captured
                    ? `Captured page ${pageNumber} / ${totalHint}`
                    : `Capturing page ${pageNumber} / ${totalHint}`,
                Math.floor(pageNumber / totalHint * 50)
            );
        }
    }

    async function capturePagesByScrolling(totalHint) {
        let roots = getScrollableElements(true);
        let noNewPasses = 0;

        for (let step = 0; step < 1200 && !pdf.stopRequested; step++) {
            if (step % 20 === 0) roots = getScrollableElements(true);

            const before = pdf.pages.size;
            const moved = scrollViewerStep(roots);
            await app.sleep(SCROLL_SETTLE);
            scanRenderedPages();

            const added = pdf.pages.size - before;
            if (added) noNewPasses = 0;
            else noNewPasses++;

            const percent = totalHint
                ? Math.min(50, Math.floor(Math.min(pdf.pages.size, totalHint) / totalHint * 50))
                : Math.min(50, Math.floor(step / 1200 * 50));
            reportProgress("Preparing…", `Capturing ${pdf.pages.size}${totalHint ? ` / ${totalHint}` : ""}`, percent);


            if (!moved && noNewPasses >= 3) break;
            if (roots.length && roots.every(root => root.scrollTop >= root.scrollHeight - root.clientHeight - 10) && noNewPasses >= 3) break;
        }
    }

    async function recoverMissingPages(totalHint) {
        if (!totalHint || pdf.capturedPages.size >= totalHint || pdf.stopRequested) return;

        const missing = [];
        for (let pageNumber = 1; pageNumber <= totalHint; pageNumber++) {
            if (!pdf.capturedPages.has(pageNumber)) missing.push(pageNumber);
        }
        if (!missing.length) return;
        for (let i = 0; i < missing.length && !pdf.stopRequested; i++) {
            const pageNumber = missing[i];
            await capturePage(pageNumber, IMAGE_WAIT_RECOVERY, 500, true);
            const capturePercent = totalHint
                ? Math.min(50, Math.floor(pdf.capturedPages.size / totalHint * 50))
                : 50;
            reportProgress(
                "Preparing…",
                `Recovery ${i + 1} / ${missing.length} — page ${pageNumber}`,
                capturePercent
            );
        }
    }

    function finishCancelledCapture() {
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        app.ui.updateWindowControl();

        const root = document.getElementById("psd-inpage-overlay");
        if (root) {
            root.classList.add("cancelled");
            root.querySelector("#psd-inpage-title").textContent = "Download cancelled";
            setTimeout(() => app.ui.showInPageOverlay(false), 800);
        }
    }
    async function preparePDFCapture() {
        if (pdf.status === 'capturing' || pdf.status === 'processing' || !app.isDrivePage()) return;
        if (!currentDriveFileIsPDF()) {
            pdf.status = 'idle';
            app.ui.updateWindowControl();
            showUnsupportedFile();
            return;
        }
        pdf.status = 'capturing';
        pdf.stopRequested = false;
        resetCaptureState();
        resetProgressUI();
        const overlay = document.getElementById("psd-inpage-overlay");
        overlay?.classList.remove("minimized");
        app.ui.updateWindowControl();
        app.ui.showScrollDim(true);
        reportProgress("Preparing…", "Reading page count…", 0);
        const pageInfo = await waitForPageInfo();
        const totalHint = pageInfo?.max || getPageCountHint();
        if (pageInfo && totalHint) {
            await capturePagesByNumber(totalHint);
        } else {
            await capturePagesByScrolling(totalHint);
        }
        if (pdf.stopRequested) {
            finishCancelledCapture();
            return;
        }
        await recoverMissingPages(totalHint);
        if (pageInfo && totalHint && !pdf.stopRequested) {
            await goToPage(1);
            await waitForCurrentPageImage(1, "", IMAGE_WAIT_FAST);
        }
        app.ui.showScrollDim(false);
        const capturedCount = totalHint ? pdf.capturedPages.size : pdf.pages.size;
        const total = totalHint || capturedCount;
        const ready = capturedCount > 0 && (!totalHint || capturedCount >= totalHint);
        pdf.status = ready ? 'ready' : 'idle';
        app.ui.updateWindowControl();
        const detail = ready
            ? `${capturedCount} / ${total} page images captured`
            : `${capturedCount} / ${total || "?"} page images captured. Try Start again.`;
        const percent = ready
            ? 100
            : Math.min(99, Math.floor(capturedCount / Math.max(1, total) * 100));
        reportProgress(
            ready ? "Ready to process PDF" : "Some pages were not captured",
            detail,
            percent
        );
        if (ready && !pdf.stopRequested) await generatePDF();
    }
    function getPDFDownloadFilename() {
        let title = document.querySelector('meta[itemprop="name"]')?.content || document.title || "download.pdf";
        title = title.replace(/\s*-\s*Google Drive\s*$/i, "").trim();
        if (!/\.pdf$/i.test(title)) title += ".pdf";
        return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    }
    let ocrWorker = null;
    let ocrRequestId = 0;
    let ocrPageIndex = 0;
    let ocrPageTotal = 0;
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
                if (ocrPageTotal > 0) {
                    const overall = 50 + ((ocrPageIndex + ocrProgress) / ocrPageTotal) * 50;
                    app.ui.updateInPageOverlay(
                        "Preparing…",
                        `OCR page ${ocrPageIndex + 1} / ${ocrPageTotal}`,
                        overall
                    );
                }
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
    async function loadImageForConversion(page) {
        const current = page.image;
        const currentSrc = current?.currentSrc || current?.src || "";
        if (current && currentSrc === page.src && current.complete && current.naturalWidth >= MIN_W && current.naturalHeight >= MIN_H) {
            return current;
        }

        const img = new Image();
        img.decoding = "async";
        const loaded = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out loading page ${page.pageNumber || "unknown"}`)), 5000);
            img.onload = () => { clearTimeout(timer); resolve(); };
            img.onerror = () => { clearTimeout(timer); reject(new Error(`Could not load page ${page.pageNumber || "unknown"}`)); };
        });
        img.src = page.src;
        if (!img.complete) await loaded;
        if (img.naturalWidth < MIN_W || img.naturalHeight < MIN_H) {
            throw new Error(`Invalid page image: ${page.pageNumber || "unknown"}`);
        }
        return img;
    }

    async function encodePageAsJPEG(page) {
        if (pdf.stopRequested) throw new Error("PDF generation cancelled.");
        const img = await loadImageForConversion(page);
        if (pdf.stopRequested) throw new Error("PDF generation cancelled.");

        const canvas = document.createElement("canvas");
        canvas.width = page.w;
        canvas.height = page.h;
        const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
        if (!context) throw new Error(`Could not create canvas for page ${page.pageNumber || "unknown"}`);
        context.drawImage(img, 0, 0, page.w, page.h);

        const blob = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out encoding page ${page.pageNumber || "unknown"}`)), 10000);
            canvas.toBlob(result => {
                clearTimeout(timer);
                result ? resolve(result) : reject(new Error(`JPEG encoding failed on page ${page.pageNumber || "unknown"}`));
            }, "image/jpeg", 0.92);
        });
        canvas.width = canvas.height = 1;
        page.image = null;
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: page.w, height: page.h };
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
        return [...(pdf.capturedPages.size ? pdf.capturedPages : pdf.pages).values()].sort((a, b) =>
            (a.pageNumber ?? a.order) - (b.pageNumber ?? b.order)
        );
    }
    async function convertPageToPDF(writer, page, index, total) {
        const jpeg = await encodePageAsJPEG(page);
        ocrPageIndex = index;
        ocrPageTotal = total;
        reportProgress(
            "Preparing…",
            `OCR page ${index + 1} / ${total}`,
            50 + ((index / total) * 50)
        );

        let words = [];
        try {
            words = await runOCROnPage(jpeg.bytes.slice());
        } catch (error) {
            // OCR is optional: keep the captured image when text extraction fails.
            console.warn('[GDrive PDF] OCR failed for page', index + 1, error);
        }

        writer.addPage(index, {
            width: jpeg.width,
            height: jpeg.height,
            bytes: jpeg.bytes,
            words
        });
    }
    async function finishPDFDownload(writer) {
        reportProgress("Preparing…", "Finalizing the PDF file", 99);
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
        pdf.status = 'completed';
        resetCaptureState();
        app.ui.updateWindowControl();
        reportProgress("File downloaded", "", 100);
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
        app.ui.updateWindowControl();
    }
    async function convertCapturedPages(writer, pages) {
        const total = pages.length;
        reportProgress("Preparing…", `OCR page 1 / ${total}`, 50);
        let converted = 0;
        let error = null;

        for (let index = 0; index < total; index++) {
            if (pdf.stopRequested) break;
            try {
                await convertPageToPDF(writer, pages[index], index, total);
                converted++;
                reportProgress(
                    "Preparing…",
                    `OCR page ${index + 1} / ${total}`,
                    50 + ((index + 1) / total) * 50
                );
            } catch (conversionError) {
                error = conversionError;
                break;
            }
        }
        return { converted, error };
    }

    async function generatePDF() {
        if (pdf.status === 'capturing' || pdf.status === 'processing' || (!pdf.capturedPages.size && !pdf.pages.size)) return;
        pdf.status = 'processing';
        pdf.stopRequested = false;
        document.getElementById("psd-inpage-overlay")?.classList.remove("quiet", "idle");
        app.ui.updateWindowControl();

        const pages = getOrderedCapturedPages();
        const writer = makePDFWriter(pages.length);
        const { converted, error } = await convertCapturedPages(writer, pages);

        if (pdf.stopRequested || converted !== pages.length) {
            pdf.status = 'idle';
            app.ui.updateWindowControl();
            await shutdownOCRWorker();
            if (pdf.stopRequested) {
                finishCancelledCapture();
            } else {
                const reason = error?.message || "A page could not be converted.";
                reportProgress(
                    "PDF conversion failed",
                    `Page ${converted + 1} of ${pages.length}: ${reason}`,
                    Math.floor(converted / Math.max(1, pages.length) * 100)
                );
                document.getElementById("psd-inpage-overlay")?.classList.remove("completed", "cancelled");
            }
            return;
        }

        await finishPDFDownload(writer);
    }
    async function start() {
        if (pdf.status === 'capturing' || pdf.status === 'processing') return;
        pdf.status = 'idle';
        resetProgressUI();
        await preparePDFCapture();
    }
    function cancel() {
        if (pdf.status !== 'capturing' && pdf.status !== 'processing') return;
        pdf.stopRequested = true;
        void shutdownOCRWorker();
    }

    app.pdf = { currentDriveFileIsPDF, start, cancel, scanMenu };
})();
