
(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const PREFIX = 'blob:https://drive.google.com/';
    const MIN_W = 500;
    const MIN_H = 300;
    const IMAGE_WAIT_FAST = 700;
    const IMAGE_WAIT_RECOVERY = 1800;
    const PAGE_COUNT_WAIT = 800;
    const POLL_INTERVAL = 35;
    const IMAGE_STABLE_MS = 40;
    const PAGE_NAV_WAIT = 250;
    const SCROLL_SETTLE = 60;
    const RING_CIRCUMFERENCE = 2 * Math.PI * 17;

    const reportProgress = (status, detail, percent = null) =>
        app.ui.updateInPageOverlay(status, detail, percent);

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
            if (!current) return;
            current.classList.remove('unsupported');
            current.style.display = 'none';
        }, 2000);
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
        return [...getViewerImageRoot().querySelectorAll('img')].filter(img => {
            const src = img.currentSrc || img.src || '';
            return src.startsWith(PREFIX) && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
        });
    }

    function scanRenderedPages(pageNumber = null) {
        let added = 0;

        for (const img of allImages()) {
            const src = img.currentSrc || img.src || '';
            if (!pdf.pages.has(src)) {
                pdf.pages.set(src, {
                    src,
                    w: img.naturalWidth,
                    h: img.naturalHeight,
                    order: pdf.orderCounter++,
                    pageNumber
                });
                added++;
                continue;
            }

            if (pageNumber != null) {
                const page = pdf.pages.get(src);
                if (page && page.pageNumber == null) page.pageNumber = pageNumber;
            }
        }

        return added;
    }

    function getCurrentPageImage() {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const vh = window.innerHeight || document.documentElement.clientHeight || 1;
        const cx = vw / 2;
        const cy = vh / 2;
        let best = null;
        let bestScore = -Infinity;

        for (const img of allImages()) {
            const rect = img.getBoundingClientRect();
            const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
            const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
            if (visibleW < 50 || visibleH < 50) continue;

            const area = visibleW * visibleH;
            const fullArea = Math.max(1, rect.width * rect.height);
            const distance = Math.hypot(
                rect.left + rect.width / 2 - cx,
                rect.top + rect.height / 2 - cy
            );
            const score = area * 2 + fullArea - distance * 500;

            if (score > bestScore) {
                bestScore = score;
                best = img;
            }
        }

        return best;
    }

    async function waitForCurrentPageImage(
        pageNumber,
        previousSrc = '',
        timeout = IMAGE_WAIT_FAST,
        allowSameSrc = false
    ) {
        const deadline = performance.now() + timeout;
        let stableSrc = '';
        let stableSince = 0;

        while (!pdf.stopRequested && performance.now() < deadline) {
            const info = getPageInput();

            if (info?.current === pageNumber) {
                const img = getCurrentPageImage();
                const src = img?.currentSrc || img?.src || '';
                const valid =
                    img &&
                    img.complete &&
                    src.startsWith(PREFIX) &&
                    img.naturalWidth >= MIN_W &&
                    img.naturalHeight >= MIN_H &&
                    (allowSameSrc || src !== previousSrc);

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

                        const finalSrc = img.currentSrc || img.src || '';
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

        const viewer = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]');
        const text = viewer?.textContent || document.body?.innerText || '';
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
        if (!force && pageInputCache?.isConnected && now - pageInputCacheAt < 500) {
            return pageInputCache;
        }

        const preferred = document.querySelector('input[aria-label*="page" i], input[title*="page" i]');
        if (preferred && preferred.offsetParent) {
            pageInputCache = preferred;
            pageInputCacheAt = now;
            return preferred;
        }

        let fallback = null;
        for (const input of document.querySelectorAll('input')) {
            if (!input.offsetParent || !/^\d+$/.test(input.value?.trim() || '')) continue;

            const hint = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('title') || ''} ${input.className || ''}`.toLowerCase();
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
        return {
            input,
            current: Number(input.value),
            max: Number(input.max) || getPageCountHint()
        };
    }

    const pageInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

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

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true
        }));
        input.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true
        }));

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
        const candidates = [
            document.scrollingElement,
            document.documentElement,
            document.body,
            ...document.querySelectorAll('*')
        ];

        for (const element of candidates) {
            if (!element || element.scrollHeight <= element.clientHeight + 50) continue;
            if (getComputedStyle(element).overflowY === 'hidden') continue;
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

            root.scrollTop = Math.min(
                max,
                before + Math.max(500, Math.floor(root.clientHeight * 0.88))
            );
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
        const src = image?.currentSrc || image?.src || '';
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
            pdf.pages.set(src, { ...page, order: pdf.orderCounter++ });
        }

        return true;
    }

    async function capturePage(
        pageNumber,
        imageWaitMs,
        navigateWaitMs = PAGE_NAV_WAIT,
        allowSameImageIfAlreadyCurrent = false
    ) {
        const currentPage = getPageInput()?.current || 0;
        const previous = getCurrentPageImage();
        const previousSrc = previous?.currentSrc || previous?.src || '';

        if (!(await goToPage(pageNumber, navigateWaitMs))) return false;

        const allowSameSrc =
            allowSameImageIfAlreadyCurrent &&
            currentPage === pageNumber &&
            previousSrc !== '';

        const image = await waitForCurrentPageImage(
            pageNumber,
            previousSrc,
            imageWaitMs,
            allowSameSrc
        );
        return !!(image && rememberCapturedPage(pageNumber, image));
    }

    async function capturePagesByNumber(totalHint) {
        if (!totalHint || pdf.stopRequested) return;

        for (let pageNumber = 1; pageNumber <= totalHint && !pdf.stopRequested; pageNumber++) {
            const captured = await capturePage(pageNumber, IMAGE_WAIT_FAST);

            reportProgress(
                'Preparing…',
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
            noNewPasses = added ? 0 : noNewPasses + 1;

            const percent = totalHint
                ? Math.min(50, Math.floor(Math.min(pdf.pages.size, totalHint) / totalHint * 50))
                : Math.min(50, Math.floor(step / 1200 * 50));

            reportProgress(
                'Preparing…',
                `Capturing ${pdf.pages.size}${totalHint ? ` / ${totalHint}` : ''}`,
                percent
            );

            if (!moved && noNewPasses >= 3) break;
            if (
                roots.length &&
                roots.every(root => root.scrollTop >= root.scrollHeight - root.clientHeight - 10) &&
                noNewPasses >= 3
            ) break;
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

            const capturePercent = Math.min(
                50,
                Math.floor(pdf.capturedPages.size / totalHint * 50)
            );

            reportProgress(
                'Preparing…',
                `Recovery ${i + 1} / ${missing.length} — page ${pageNumber}`,
                capturePercent
            );
        }
    }

    function finishCancelledCapture() {
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        app.ui.updateWindowControl();

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('cancelled');
        root.querySelector('#psd-inpage-title').textContent = 'Download cancelled';
        setTimeout(() => app.ui.showInPageOverlay(false), 800);
    }

    function beginCapture() {
        pdf.status = 'capturing';
        pdf.stopRequested = false;
        resetCaptureState();
        resetProgressUI();

        document.getElementById('psd-inpage-overlay')?.classList.remove('minimized');
        app.ui.updateWindowControl();
        app.ui.showScrollDim(true);
        reportProgress('Preparing…', 'Reading page count…', 0);
    }

    async function captureDocumentPages(pageInfo, totalHint) {
        if (pageInfo && totalHint) await capturePagesByNumber(totalHint);
        else await capturePagesByScrolling(totalHint);

        if (pdf.stopRequested) {
            finishCancelledCapture();
            return false;
        }

        await recoverMissingPages(totalHint);
        if (pageInfo && totalHint && !pdf.stopRequested) {
            await goToPage(1);
            await waitForCurrentPageImage(1, '', IMAGE_WAIT_FAST);
        }
        return true;
    }

    async function finishCapture(totalHint) {
        app.ui.showScrollDim(false);

        const capturedCount = totalHint ? pdf.capturedPages.size : pdf.pages.size;
        const total = totalHint || capturedCount;
        const ready = capturedCount > 0 && (!totalHint || capturedCount >= totalHint);

        pdf.status = ready ? 'ready' : 'idle';
        app.ui.updateWindowControl();

        const detail = ready
            ? `${capturedCount} / ${total} page images captured`
            : `${capturedCount} / ${total || '?'} page images captured. Try Start again.`;
        const percent = ready ? 100 : Math.min(99, Math.floor(capturedCount / Math.max(1, total) * 100));

        reportProgress(
            ready ? 'Ready to process PDF' : 'Some pages were not captured',
            detail,
            percent
        );

        if (ready && !pdf.stopRequested) await app.pdfWriter.generate();
    }

    async function prepare() {
        if (pdf.status === 'capturing' || pdf.status === 'processing' || !app.isDrivePage()) return;
        if (!app.pdf?.currentDriveFileIsPDF?.()) {
            showUnsupportedFile();
            return;
        }

        beginCapture();
        const pageInfo = await waitForPageInfo();
        const totalHint = pageInfo?.max || getPageCountHint();
        if (await captureDocumentPages(pageInfo, totalHint)) await finishCapture(totalHint);
    }

    app.pdfCapture = {
        prepare,
        resetProgressUI,
        resetCaptureState,
        rememberCapturedPage,
        getOrderedCapturedPages: () =>
            [...(pdf.capturedPages.size ? pdf.capturedPages : pdf.pages).values()].sort((a, b) =>
                (a.pageNumber ?? a.order) - (b.pageNumber ?? b.order)
            ),
        finishCancelledCapture
    };
})();
