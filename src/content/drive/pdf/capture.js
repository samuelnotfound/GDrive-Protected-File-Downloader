(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const IMAGE_SELECTOR = 'img[src^="blob:"]';
    const MIN_WIDTH = 500;
    const MIN_HEIGHT = 300;
    const WAIT_FOR_VIEWER = 12000;
    const WAIT_FOR_IMAGE = 6000;
    const RING_CIRCUMFERENCE = 2 * Math.PI * 17;

    pdf.runId ??= 0;
    pdf.cancelOverlayTimer ??= null;

    const report = (status, detail, percent = null) =>
        app.ui.updateInPageOverlay(status, detail, percent);

    const isCurrentRun = runId => runId === pdf.runId && !pdf.stopRequested;

    function resetProgressUI() {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        const ring = root.querySelector('#psd-inpage-ring');
        if (ring) {
            ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
        }
        root.classList.remove('cancelled', 'completed', 'unsupported');
    }

    function showUnsupportedFile() {
        clearTimeout(pdf.unsupportedTimer);
        pdf.status = 'idle';
        app.ui.updateWindowControl();
        app.ui.showInPageOverlay(true);

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('unsupported');
        root.querySelector('#psd-inpage-title')?.replaceChildren(
            document.createTextNode('File type not supported')
        );
        root.querySelector('#psd-inpage-detail')?.replaceChildren();
        root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'none');
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');

        pdf.unsupportedTimer = setTimeout(() => app.ui.showInPageOverlay(false), 2000);
    }

    function getFirstPageImage() {
        return [...document.querySelectorAll(IMAGE_SELECTOR)].find(img =>
            img.naturalWidth >= MIN_WIDTH && img.naturalHeight >= MIN_HEIGHT
        ) || null;
    }

    function sameClassSet(a, b) {
        if (a.tagName !== b.tagName || a.classList.length !== b.classList.length) return false;
        return [...a.classList].every(name => b.classList.contains(name));
    }

    function getPages() {
        const image = getFirstPageImage();
        const page = image?.parentElement;
        const container = page?.parentElement;
        if (!page || !container) throw new Error('Could not find PDF pages');

        return [...container.children].filter(candidate => sameClassSet(page, candidate));
    }

    function getPageImage(page) {
        return [...page.querySelectorAll(IMAGE_SELECTOR)].find(img =>
            img.complete && img.naturalWidth >= MIN_WIDTH && img.naturalHeight >= MIN_HEIGHT
        ) || null;
    }

    function waitForPageImage(page, runId) {
        const ready = getPageImage(page);
        if (ready) return Promise.resolve(ready);

        page.scrollIntoView({ block: 'center' });

        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (error, image) => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearInterval(poll);
                clearTimeout(timer);
                error ? reject(error) : resolve(image);
            };

            const check = () => {
                if (!isCurrentRun(runId)) {
                    finish(new Error('Capture cancelled.'));
                    return;
                }

                const image = getPageImage(page);
                if (image) finish(null, image);
            };

            const observer = new MutationObserver(check);
            const poll = setInterval(check, 100);
            const timer = setTimeout(
                () => finish(new Error('Timed out waiting for page image')),
                WAIT_FOR_IMAGE
            );

            observer.observe(page, { childList: true, attributes: true, subtree: true });
            check();
        });
    }

    function waitForFirstPage(runId) {
        const ready = getFirstPageImage();
        if (ready) return Promise.resolve(ready);

        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (error, image) => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearInterval(poll);
                clearTimeout(timer);
                error ? reject(error) : resolve(image);
            };

            const check = () => {
                if (!isCurrentRun(runId)) {
                    finish(new Error('Capture cancelled.'));
                    return;
                }

                const image = getFirstPageImage();
                if (image) finish(null, image);
            };

            const observer = new MutationObserver(check);
            const poll = setInterval(check, 150);
            const timer = setTimeout(
                () => finish(new Error('Could not find rendered PDF pages')),
                WAIT_FOR_VIEWER
            );

            observer.observe(document.body, { childList: true, subtree: true });
            check();
        });
    }

    async function imageToJPEG(image, runId) {
        if (!isCurrentRun(runId)) throw new Error('Capture cancelled.');

        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!image.complete || width < MIN_WIDTH || height < MIN_HEIGHT) {
            throw new Error('A PDF page image is not ready.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        try {
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) throw new Error('Could not create PDF canvas.');

            context.drawImage(image, 0, 0, width, height);

            const blob = await new Promise((resolve, reject) =>
                canvas.toBlob(value => {
                    if (value) resolve(value);
                    else reject(new Error('JPEG encoding failed.'));
                }, 'image/jpeg', 0.92)
            );

            if (!isCurrentRun(runId)) throw new Error('Capture cancelled.');

            return {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                width,
                height
            };
        } finally {
            canvas.width = canvas.height = 1;
        }
    }

    async function capturePages(pages, runId) {
        for (let index = 0; index < pages.length; index++) {
            if (!isCurrentRun(runId)) return false;

            const pageNumber = index + 1;
            report(
                'Capturing',
                `Capturing page ${pageNumber} / ${pages.length}`,
                (index / pages.length) * 50
            );

            try {
                const image = await waitForPageImage(pages[index], runId);
                const jpeg = await imageToJPEG(image, runId);
                pdf.capturedPages.set(pageNumber, jpeg);
            } catch (error) {
                if (!isCurrentRun(runId)) return false;

                report(
                    'Capture incomplete',
                    `Could not capture page ${pageNumber} / ${pages.length}`,
                    (index / pages.length) * 50
                );
                console.warn('[Drive Media Saver] PDF page capture failed:', error);
                return false;
            }
        }

        report('Capturing', `Captured ${pages.length} pages`, 50);
        return true;
    }

    function finishCancelledCapture() {
        clearTimeout(pdf.cancelOverlayTimer);
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        app.ui.updateWindowControl();

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('cancelled');
        root.querySelector('#psd-inpage-title').textContent = 'Download cancelled';
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
        pdf.cancelOverlayTimer = setTimeout(() => {
            if (pdf.status === 'cancelled') app.ui.showInPageOverlay(false);
        }, 800);
    }

    function beginCapture() {
        clearTimeout(pdf.cancelOverlayTimer);
        const runId = ++pdf.runId;
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
        }

        app.ui.updateWindowControl();
        app.ui.showScrollDim(true);
        report('Preparing…', 'Waiting for pages to load…', 0);
        return runId;
    }

    function resetCaptureState() {
        pdf.capturedPages.clear();
    }

    async function prepare() {
        if (pdf.status === 'capturing' || pdf.status === 'processing' || !app.isDrivePage()) return;
        if (!app.pdf?.currentDriveFileIsPDF?.()) {
            showUnsupportedFile();
            return;
        }

        const runId = beginCapture();

        try {
            await waitForFirstPage(runId);
            if (!isCurrentRun(runId)) return;

            const pages = getPages();
            if (!pages.length) throw new Error('Could not find PDF pages');

            report('Preparing…', `Found ${pages.length} page${pages.length === 1 ? '' : 's'}`, 0);
            const captured = await capturePages(pages, runId);

            if (!isCurrentRun(runId)) return;
            if (!captured || pdf.capturedPages.size !== pages.length) return;

            app.ui.showScrollDim(false);
            pdf.status = 'ready';
            app.ui.updateWindowControl();
            await app.pdfWriter.generate(runId);
        } catch (error) {
            if (!isCurrentRun(runId)) return;

            app.ui.showScrollDim(false);
            pdf.status = 'idle';
            app.ui.updateWindowControl();
            report('Capture incomplete', error.message || 'Could not capture the PDF.', 0);
            console.warn('[Drive Media Saver] PDF capture failed:', error);
        }
    }

    app.pdfCapture = {
        prepare,
        resetProgressUI,
        resetCaptureState,
        finishCancelledCapture,
        getOrderedCapturedPages: () =>
            [...pdf.capturedPages.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, page]) => page)
    };
})();
