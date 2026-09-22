
(() => {
    const app = window.__PSD;

    let worker = null;
    let requestId = 0;
    let pageIndex = 0;
    let pageTotal = 0;
    let progress = 0;
    const requests = new Map();

    function updateProgress() {
        if (pageTotal <= 0) return;

        const overall = 50 + ((pageIndex + progress) / pageTotal) * 50;
        app.ui.updateInPageOverlay(
            'Preparing…',
            `OCR page ${pageIndex + 1} / ${pageTotal}`,
            overall
        );
    }

    function rejectPendingRequests(error) {
        for (const request of requests.values()) request.reject(error);
        requests.clear();
    }

    function getWorker() {
        if (worker) return worker;

        worker = new Worker(chrome.runtime.getURL('vendor/ocr-worker.js'));
        worker.onmessage = event => {
            const message = event.data || {};

            if (message.type === 'progress') {
                progress = Math.max(0, Math.min(1, Number(message.progress) || 0));
                updateProgress();
                return;
            }

            if (message.type !== 'result' && message.type !== 'error') return;

            const request = requests.get(message.id);
            if (!request) return;

            requests.delete(message.id);
            if (message.type === 'error') {
                request.reject(new Error(message.message || 'OCR failed.'));
            } else {
                request.resolve(message.words || []);
            }
        };

        worker.onerror = event => {
            const error = new Error(event.message || 'Offline OCR worker failed.');
            rejectPendingRequests(error);
            try { worker?.terminate(); } catch (_) {}
            worker = null;
        };

        return worker;
    }

    async function shutdown() {
        if (!worker) return;

        rejectPendingRequests(new Error('OCR worker stopped.'));
        try { worker.terminate(); } catch (_) {}
        worker = null;
    }

    function run(imageBytes, index, total) {
        const currentWorker = getWorker();
        pageIndex = index;
        pageTotal = total;
        progress = 0;

        const id = ++requestId;
        return new Promise((resolve, reject) => {
            requests.set(id, { resolve, reject });

            try {
                currentWorker.postMessage(
                    { type: 'recognize', id, image: imageBytes },
                    [imageBytes.buffer]
                );
            } catch (error) {
                requests.delete(id);
                reject(error);
            }
        });
    }

    app.pdfOcr = { run, shutdown };
})();
