
(() => {
    if (window.__PSD_CONTENT_UTILS) return;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function allRoots(root = document, seen = new Set()) {
        if (!root || seen.has(root)) return [];
        seen.add(root);

        const roots = [root];
        try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.shadowRoot) roots.push(...allRoots(node.shadowRoot, seen));
            }
        } catch (_) {}

        return roots;
    }

    function isVisible(element, respectAriaHidden = true) {
        if (!element || !(element instanceof Element)) return false;
        try {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            if (respectAriaHidden && element.getAttribute?.('aria-hidden') === 'true') return false;

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    }

    function mediaElements(selector = 'video') {
        const media = [];
        for (const root of allRoots()) {
            try { media.push(...(root.querySelectorAll?.(selector) || [])); } catch (_) {}
        }
        return [...new Set(media)];
    }

    function areaOf(element) {
        try {
            const rect = element.getBoundingClientRect();
            return rect.width * rect.height;
        } catch (_) {
            return 0;
        }
    }

    function muteMedia(element) {
        try {
            element.muted = true;
            element.defaultMuted = true;
            element.volume = 0;
            element.setAttribute('muted', '');
        } catch (_) {}
    }

    function muteAllMedia() {
        for (const media of mediaElements('video, audio')) muteMedia(media);
    }

    function requestRuntime(message) {
        return new Promise(resolve => {
            try {
                chrome.runtime.sendMessage(message, response => {
                    if (chrome.runtime.lastError) {
                        resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                        resolve(response || { success: false, error: 'No response.' });
                    }
                });
            } catch (error) {
                resolve({ success: false, error: error?.message || String(error) });
            }
        });
    }

    async function waitUntil(check, timeoutMs, intervalMs = 25) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const result = await check();
            if (result) return result;
            await sleep(intervalMs);
        }
        return await check();
    }

    window.__PSD_CONTENT_UTILS = Object.freeze({
        sleep,
        allRoots,
        isVisible,
        mediaElements,
        areaOf,
        muteMedia,
        muteAllMedia,
        requestRuntime,
        waitUntil
    });
})();
