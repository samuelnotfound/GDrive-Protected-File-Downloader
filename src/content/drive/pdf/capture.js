
(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const PREFIX = 'blob:https://drive.google.com/';
    const MIN_W = 500;
    const MIN_H = 300;
    const IMAGE_WAIT_FAST = 1200;
    const IMAGE_WAIT_RECOVERY = 1800;
    // Wait long enough for Drive's viewer chrome (page input + total) to appear
    // when the user clicks Download before the document has finished loading.
    const PAGE_COUNT_WAIT = 12000;
    const VIEWER_READY_WAIT = 15000;
    const POLL_INTERVAL = 35;
    const IMAGE_STABLE_MS = 60;
    const PAGE_NAV_WAIT = 400;
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
        let stableHits = 0;
        let firstCheck = true;

        while (!pdf.stopRequested && performance.now() < deadline) {
            const info = getPageInput(firstCheck);
            firstCheck = false;
            const max = Number(info?.max || getPageCountHint() || 0);
            const current = Number(info?.current || 0);

            // Require a real page control with a known total (not 0 / NaN).
            if (info?.input && current >= 1 && max >= 1) {
                if (max === lastMax) {
                    stableHits += 1;
                    // Two stable reads so we do not start on a half-initialized max.
                    if (stableHits >= 2) return { ...info, current, max };
                } else {
                    lastMax = max;
                    stableHits = 1;
                }
            } else {
                lastMax = null;
                stableHits = 0;
            }

            await app.sleep(50);
        }

        return null;
    }

    /**
     * Wait until the Drive PDF viewer has both:
     *  - a confirmed page count (current + max on the page input), and
     *  - at least one rendered page image ready to capture.
     * Returns null if the viewer never becomes ready (do not scroll blindly).
     */
    async function waitForViewerReady(timeout = VIEWER_READY_WAIT) {
        const deadline = performance.now() + timeout;
        let lastReport = 0;

        while (!pdf.stopRequested && performance.now() < deadline) {
            const now = performance.now();
            if (now - lastReport > 400) {
                reportProgress('Preparing…', 'Waiting for pages to load…', 0);
                lastReport = now;
            }

            // Prefer a full waitForPageInfo slice so max stabilizes.
            const remaining = deadline - performance.now();
            if (remaining <= 0) break;

            const pageInfo = await waitForPageInfo(Math.min(1500, remaining));
            if (!pageInfo?.max) {
                await app.sleep(80);
                continue;
            }

            // Confirm at least one page image is actually rendered.
            scanRenderedPages(pageInfo.current);
            const img = getCurrentPageImage();
            const src = img?.currentSrc || img?.src || '';
            const imageReady =
                img &&
                img.complete &&
                src.startsWith(PREFIX) &&
                img.naturalWidth >= MIN_W &&
                img.naturalHeight >= MIN_H;

            if (imageReady) {
                return {
                    pageInfo,
                    totalHint: pageInfo.max,
                    firstImage: img
                };
            }

            await app.sleep(80);
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

    async function goToPage(pageNumber, waitMs = PAGE_NAV_WAIT, options = {}) {
        // Allow forced navigation (e.g. return to page 1 after cancel) even when stopRequested.
        if (pdf.stopRequested && !options.force) return false;

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

        // Single sequential pass: do not advance until the current page is captured.
        const MAX_TRIES = 8;

        for (let pageNumber = 1; pageNumber <= totalHint && !pdf.stopRequested; pageNumber++) {
            let captured = false;

            for (let tryN = 1; tryN <= MAX_TRIES && !captured && !pdf.stopRequested; tryN++) {
                reportProgress(
                    'Capturing',
                    `Capturing page ${pageNumber} / ${totalHint}`,
                    Math.floor(((pageNumber - 1) / totalHint) * 50)
                );

                const waitMs = IMAGE_WAIT_FAST + (tryN - 1) * 400;
                const navMs = PAGE_NAV_WAIT + (tryN - 1) * 100;
                captured = await capturePage(pageNumber, waitMs, navMs, tryN > 1);

                if (!captured && tryN < MAX_TRIES) {
                    await app.sleep(150 * tryN);
                }
            }

            if (!captured) {
                reportProgress(
                    'Capturing',
                    `Capturing page ${pageNumber} / ${totalHint}`,
                    Math.floor(((pageNumber - 1) / totalHint) * 50)
                );
                await goToPage(pageNumber, PAGE_NAV_WAIT * 2);
                await app.sleep(300);
                captured = await capturePage(pageNumber, IMAGE_WAIT_RECOVERY, PAGE_NAV_WAIT * 2, true);
            }

            if (!captured) {
                reportProgress(
                    'Capture incomplete',
                    `Could not capture page ${pageNumber} / ${totalHint}`,
                    Math.floor(((pageNumber - 1) / totalHint) * 50)
                );
                return;
            }

            reportProgress(
                'Capturing',
                `Capturing page ${pageNumber} / ${totalHint}`,
                Math.min(50, Math.floor((pageNumber / totalHint) * 50))
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


    function finishCancelledCapture() {
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        app.ui.updateWindowControl();

        // Return the Drive viewer to page 1 after cancel.
        void goToPage(1, PAGE_NAV_WAIT, { force: true }).catch?.(() => {});

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('cancelled');
        root.querySelector('#psd-inpage-title').textContent = 'Download cancelled';
        // Ensure cancel button is hidden on terminal cancel state.
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
        setTimeout(() => app.ui.showInPageOverlay(false), 800);
    }

    function beginCapture() {
        pdf.status = 'capturing';
        pdf.stopRequested = false;
        resetCaptureState();
        resetProgressUI();

        const root = document.getElementById('psd-inpage-overlay');
        if (root) {
            root.classList.remove('minimized', 'cancelled', 'completed', 'unsupported');
            root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'flex');
            root.querySelector('#psd-inpage-toggle')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-check')?.style.setProperty('display', 'none');
            const toggle = root.querySelector('#psd-inpage-toggle');
            if (toggle) {
                toggle.disabled = false;
                toggle.textContent = 'Cancel';
            }
        }
        app.ui.updateWindowControl();
        app.ui.showScrollDim(true);
        reportProgress('Preparing…', 'Reading page count…', 0);
    }

    async function captureDocumentPages(pageInfo, totalHint) {
        // Only capture by page number once the viewer reported a real total.
        // Blind scrolling without a page count is what ran when Download was
        // clicked before pages finished loading — that path is no longer used.
        if (!pageInfo || !totalHint || totalHint < 1) {
            reportProgress(
                'Viewer not ready',
                'Page count is not available yet. Wait for the document to load, then try again.',
                0
            );
            return false;
        }

        await capturePagesByNumber(totalHint);

        if (pdf.stopRequested) {
            finishCancelledCapture();
            return false;
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
        const percent = ready ? 50 : Math.min(49, Math.floor(capturedCount / Math.max(1, total) * 50));

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
        reportProgress('Preparing…', 'Waiting for pages to load…', 0);

        // Do not scroll or capture until Drive exposes a stable page total
        // and at least one page image is rendered.
        const ready = await waitForViewerReady();
        if (pdf.stopRequested) {
            finishCancelledCapture();
            return;
        }

        if (!ready?.pageInfo || !ready?.totalHint) {
            pdf.status = 'idle';
            app.ui.showScrollDim(false);
            app.ui.updateWindowControl();
            reportProgress(
                'Viewer not ready',
                'Could not read the number of pages. Wait until the document finishes loading, then try Download again.',
                0
            );
            const root = document.getElementById('psd-inpage-overlay');
            if (root) {
                root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
                setTimeout(() => app.ui.showInPageOverlay(false), 2500);
            }
            return;
        }

        const { pageInfo, totalHint } = ready;
        reportProgress('Preparing…', `Found ${totalHint} page${totalHint === 1 ? '' : 's'}`, 0);

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
