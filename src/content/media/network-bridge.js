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
    // Drive adaptive streams are served from *.googlevideo.com (not drive.google.com).
    // Without this host, every real videoplayback URL is silently dropped.
    const trustedHost = host => {
        const h = String(host || '').toLowerCase();
        return h === 'drive.google.com' || h.endsWith('.drive.google.com') ||
            h === 'googlevideo.com' || h.endsWith('.googlevideo.com') ||
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


    // ---- Playback-API quality list (from Drive /playback responses) -----------------
    // Same idea as the "menu + quality changer" prototype: parse mediaStreamingData
    // so the extension knows available heights without opening Settings → Quality.
    const LABEL_BY_ITAG = {
        18: 360, 22: 720, 37: 1080, 59: 480,
        133: 240, 134: 360, 135: 480, 136: 720, 137: 1080, 160: 144,
        242: 240, 243: 360, 244: 480, 247: 720, 248: 1080, 278: 144,
        264: 1440, 266: 2160, 271: 1440, 298: 720, 299: 1080, 313: 2160
    };
    const PLAYBACK_RE = /workspacevideo\S*\/media\/([\w-]+)\/playback/;
    const FILE_ID_RE = /\/d\/([\w-]+)|[?&]id=([\w-]+)/;
    const playbackById = Object.create(null);

    function parseGoogleJson(text) {
        try {
            return JSON.parse(String(text || '').replace(/^\)\]\}'\n?/, ''));
        } catch (_) {
            return null;
        }
    }

    function heightsFromPlayback(json) {
        const data = json?.mediaStreamingData?.formatStreamingData;
        if (!data) return [];
        const heights = new Set();
        for (const list of [data.adaptiveTranscodes || [], data.progressiveTranscodes || []]) {
            for (const t of list) {
                const h = LABEL_BY_ITAG[t.itag] || t.transcodeMetadata?.height;
                if (h) heights.add(Number(h));
            }
        }
        return [...heights].filter(Boolean).sort((a, b) => b - a);
    }

    function postPlaybackQualities(id, json) {
        if (!json?.mediaStreamingData) return;
        playbackById[id] = json;
        const heights = heightsFromPlayback(json);
        if (!heights.length) return;
        try {
            window.top.postMessage({
                type: 'PSD_GDRIVE_PLAYBACK_QUALITIES',
                fileId: id,
                heights,
                labels: heights.map(h => `${h}p`),
                bridgeId,
                frameUrl: location.href,
                capturedAt: Date.now()
            }, TARGET);
        } catch (_) {}
    }

    function storePlaybackFromResponse(url, textOrJson) {
        const id = String(url || '').match(PLAYBACK_RE)?.[1];
        if (!id) return;
        const json = typeof textOrJson === 'string' ? parseGoogleJson(textOrJson) : textOrJson;
        postPlaybackQualities(id, json);
    }

    // Wrap fetch again for body inspection (after the URL-only wrap above).
    try {
        const prevFetch = window.fetch;
        window.fetch = async function (...args) {
            const res = await prevFetch.apply(this, args);
            try {
                const url = res?.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url);
                if (url && PLAYBACK_RE.test(String(url))) {
                    res.clone().text().then(text => storePlaybackFromResponse(url, text), () => {});
                }
            } catch (_) {}
            return res;
        };
    } catch (_) {}

    try {
        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            try { this.__psdPlaybackUrl = String(url || ''); } catch (_) {}
            return nativeOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...args) {
            try {
                if (this.__psdPlaybackUrl && PLAYBACK_RE.test(this.__psdPlaybackUrl)) {
                    this.addEventListener('load', () => {
                        try {
                            if (this.responseType === 'json' && this.response) {
                                storePlaybackFromResponse(this.__psdPlaybackUrl, this.response);
                            } else if (this.responseType === '' || this.responseType === 'text') {
                                storePlaybackFromResponse(this.__psdPlaybackUrl, this.responseText);
                            }
                        } catch (_) {}
                    });
                }
            } catch (_) {}
            return nativeSend.apply(this, args);
        };
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
