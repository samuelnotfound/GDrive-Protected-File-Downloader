// Runs in the PAGE (MAIN) world at document_start.
// Purpose: observe the real page's fetch/XHR/resource timing traffic before Drive
// has a chance to create the video playback requests. It forwards only
// videoplayback URLs to the extension's isolated-world content script via
// window.postMessage; it does not modify requests or response bodies.
(() => {
    if (window.__PSD_GDRIVE_NETWORK_BRIDGE__) return;
    window.__PSD_GDRIVE_NETWORK_BRIDGE__ = true;

    const bridgeId = `psd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const seen = new Map();
    const MAX_SEEN = 120;
    let lastReadyReply = 0;
    const TARGET = '*';
    const trustedHost = host => {
        const h = String(host || '').toLowerCase();
        return h === 'drive.google.com' || h.endsWith('.drive.google.com') ||
            h.endsWith('.googleusercontent.com') || h === 'googleusercontent.com';
    };

    const isPlaybackUrl = url => {
        try {
            const value = String(url || '');
            if (!value.includes('videoplayback')) return false;
            const parsed = new URL(value, location.href);
            return trustedHost(parsed.hostname);
        } catch (_) {
            return false;
        }
    };

    function post(url, source = 'network') {
        if (!isPlaybackUrl(url)) return;
        const value = String(url);
        const key = value.replace(/([?&](?:range|rn|rbuf|cpn|cver|srfvp|ump|alr)=[^&]*)/gi, '');
        if (seen.has(key)) return;
        seen.set(key, Date.now());
        while (seen.size > MAX_SEEN) {
            const first = seen.keys().next().value;
            if (first === undefined) break;
            seen.delete(first);
        }
        try {
            window.top.postMessage({
                type: 'PSD_GDRIVE_STREAM_DETECTED',
                url: value,
                source,
                bridgeId,
                frameUrl: location.href,
                pageOrigin: location.origin,
                capturedAt: Date.now()
            }, TARGET);
        } catch (_) {}
    }

    function scanPerformanceEntries() {
        try {
            for (const entry of performance.getEntriesByType('resource')) {
                if (entry?.name) post(entry.name, 'performance');
            }
        } catch (_) {}
    }

    try {
        const OriginalXHR = window.XMLHttpRequest;
        const originalOpen = OriginalXHR.prototype.open;
        OriginalXHR.prototype.open = function(method, url) {
            try { if (typeof url === 'string') post(url, 'xhr'); } catch (_) {}
            return originalOpen.apply(this, arguments);
        };
    } catch (_) {}

    try {
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            try {
                const url = typeof input === 'string' ? input : input?.url;
                if (url) post(url, 'fetch');
            } catch (_) {}
            return originalFetch.apply(this, arguments);
        };
    } catch (_) {}

    try {
        const OriginalRequest = window.Request;
        if (OriginalRequest) {
            const WrappedRequest = function(input, init) {
                try {
                    const url = typeof input === 'string' ? input : input?.url;
                    if (url) post(url, 'request');
                } catch (_) {}
                return new OriginalRequest(input, init);
            };
            WrappedRequest.prototype = OriginalRequest.prototype;
            try { Object.setPrototypeOf(WrappedRequest, OriginalRequest); } catch (_) {}
            window.Request = WrappedRequest;
        }
    } catch (_) {}

    try {
        const OriginalPO = window.PerformanceObserver;
        if (OriginalPO) {
            const observer = new OriginalPO(list => {
                for (const entry of list.getEntries()) post(entry?.name, 'performance-observer');
            });
            observer.observe({ type: 'resource', buffered: true });
        }
    } catch (_) {
        try {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) post(entry?.name, 'performance-observer');
            });
            observer.observe({ entryTypes: ['resource'] });
        } catch (_) {}
    }

    try {
        document.addEventListener('play', event => {
            const target = event.target;
            if (target && String(target.tagName || '').toLowerCase() === 'video') {
                scanPerformanceEntries();
                setTimeout(scanPerformanceEntries, 150);
                setTimeout(scanPerformanceEntries, 600);
                setTimeout(scanPerformanceEntries, 1500);
            }
        }, true);
    } catch (_) {}

    try {
        window.addEventListener('message', event => {
            const data = event?.data;
            if (!data || data.type !== 'PSD_GDRIVE_STREAM_REPLAY') return;
            if (event.source !== window.top && event.source !== window) return;
            scanPerformanceEntries();
            // A replay requested in answer to our own READY must never be answered with another
            // READY, or the bridge and the controller ping-pong forever (a busy loop that starved
            // the whole tab). Also never announce more than twice a second.
            if (data.fromReady) return;
            const now = Date.now();
            if (now - lastReadyReply < 500) return;
            lastReadyReply = now;
            try { window.top.postMessage({ type: 'PSD_GDRIVE_PAGE_BRIDGE_READY', bridgeId, frameUrl: location.href }, TARGET); } catch (_) {}
        });
    } catch (_) {}

    // The isolated-world content script may be injected later (document_idle),
    // so advertise the bridge more than once during initial viewer startup.
    const advertise = () => {
        try {
            window.top.postMessage({ type: 'PSD_GDRIVE_PAGE_BRIDGE_READY', bridgeId, frameUrl: location.href }, TARGET);
        } catch (_) {}
        scanPerformanceEntries();
    };
    advertise();
    setTimeout(advertise, 150);
    setTimeout(advertise, 600);
    setTimeout(advertise, 1500);
    setTimeout(scanPerformanceEntries, 3000);
})();
