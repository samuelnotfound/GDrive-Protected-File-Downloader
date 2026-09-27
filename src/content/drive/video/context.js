(() => {
    if (window.__PSD_VIDEO_CONTEXT__) return;
    window.__PSD_VIDEO_CONTEXT__ = true;

    const app = window.__PSD;
    const video = app.videoState;
    const utils = window.__PSD_CONTENT_UTILS;

    function sendRuntime(message) {
        return new Promise(resolve => {
            try {
                chrome.runtime.sendMessage(message, response => {
                    if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
                    else resolve(response || { success: false, error: 'No response.' });
                });
            } catch (error) {
                resolve({ success: false, error: error?.message || String(error) });
            }
        });
    }

    function hasUsableFormats(formats) {
        return !!(formats && (
            formats.video?.some?.(item => item?.url) ||
            formats.audio?.some?.(item => item?.url) ||
            formats.progressive?.some?.(item => item?.url)
        ));
    }

    function cloneFormats(formats = {}) {
        return {
            video: Array.isArray(formats.video) ? formats.video.map(item => ({ ...item })) : [],
            audio: Array.isArray(formats.audio) ? formats.audio.map(item => ({ ...item })) : [],
            progressive: Array.isArray(formats.progressive) ? formats.progressive.map(item => ({ ...item })) : []
        };
    }

    async function saveQualitySnapshot() {
        const fileId = String(video.fileId || '').trim();
        if (!fileId || !video.pickerFormats) return;

        try {
            await sendRuntime({
                action: 'saveQualityPickerSnapshot',
                fileId,
                snapshot: {
                    fileId,
                    viewerSessionId: String(video.viewerSessionId || ''),
                    formats: cloneFormats(video.pickerFormats),
                    savedAt: Date.now()
                }
            });
        } catch (_) {}
    }

    async function restoreQualitySnapshot(fileId = video.fileId) {
        const id = String(fileId || '').trim();
        if (!id) return false;

        try {
            const response = await sendRuntime({ action: 'loadQualityPickerSnapshot', fileId: id });
            const snapshot = response?.success ? response.snapshot : null;
            if (!snapshot?.formats || !hasUsableFormats(snapshot.formats)) return false;
            if (snapshot.savedAt && Date.now() - Number(snapshot.savedAt) > 30 * 60 * 1000) return false;

            video.pickerFormats = cloneFormats(snapshot.formats);
            video.formats = cloneFormats(video.pickerFormats);
            video.scanCache = {
                fileId: id,
                at: Number(snapshot.savedAt) || Date.now(),
                heightCount: new Set([
                    ...video.pickerFormats.video,
                    ...video.pickerFormats.progressive
                ].map(format => Number(format.height) || 0).filter(Boolean)).size,
                note: ''
            };
            return true;
        } catch (_) {
            return false;
        }
    }

    function isVideoViewerOpen() {
        const viewer = document.querySelector('div[role="dialog"][aria-label="Showing viewer."]');
        const player = document.querySelector('section[aria-label="Video Player"]');
        return !!(viewer && player && viewer.getAttribute('aria-hidden') !== 'true');
    }

    function readActiveItemInfo() {
        const json = document.querySelector('#drive-active-item-info');
        if (!json?.textContent) return null;
        try { return JSON.parse(json.textContent); } catch (_) { return null; }
    }

    function getCurrentDriveFileContext() {
        const data = readActiveItemInfo();
        const pathnameId = location.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/i)?.[1] || '';
        const fileId = String(
            data?.id || data?.fileId || data?.file_id || data?.resourceId || pathnameId || ''
        ).trim();
        return { fileId, filename: getCurrentDriveFileName(data) };
    }

    function getCurrentDriveFileName(dataOverride = null) {
        const candidates = [];
        const data = dataOverride || readActiveItemInfo();
        if (data) candidates.push(data?.title, data?.name);
        candidates.push(document.querySelector('meta[itemprop="name"]')?.content || '');

        const selectors = [
            '[aria-label^="File name"]',
            '[data-tooltip^="File name"]',
            '[aria-label][role="heading"]',
            'h1[aria-label]',
            '[data-tooltip][role="heading"]'
        ];
        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                candidates.push(
                    element.getAttribute('aria-label'),
                    element.getAttribute('data-tooltip'),
                    element.textContent
                );
            }
        }

        candidates.push(String(document.title || '').replace(/\s*-\s*Google Drive\s*$/i, ''));
        for (const value of candidates) {
            const name = String(value || '').replace(/^File name\s*[:\-]?\s*/i, '').trim();
            if (!name || /^Google Drive$/i.test(name) || /^(File name|Showing viewer|Video Player)$/i.test(name)) continue;
            return name;
        }
        return '';
    }

    function createViewerSessionId(fileId) {
        return `${fileId || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    function isVisibleVideoElement(element) {
        return !!element && utils.isVisible(element, false);
    }

    function collectVideoElements() {
        return utils.mediaElements('video');
    }

    function findDrivePlayerElement() {
        const candidates = [];
        const sections = [...document.querySelectorAll(
            'section[aria-label*="Video Player" i], [role="dialog"][aria-label*="Showing viewer" i]'
        )];

        for (const section of sections) {
            for (const element of section.querySelectorAll('video')) {
                if (isVisibleVideoElement(element)) candidates.push(element);
            }
            for (const host of section.querySelectorAll('*')) {
                if (!host.shadowRoot) continue;
                try {
                    for (const element of host.shadowRoot.querySelectorAll('video')) {
                        if (isVisibleVideoElement(element)) candidates.push(element);
                    }
                } catch (_) {}
            }
        }

        for (const element of collectVideoElements()) {
            if (isVisibleVideoElement(element) && !candidates.includes(element)) candidates.push(element);
        }
        return candidates[0] || null;
    }

    function getAccessibleLabel(element) {
        return [
            element?.getAttribute?.('aria-label'),
            element?.getAttribute?.('title'),
            element?.getAttribute?.('data-tooltip')
        ].filter(Boolean).map(value => String(value).replace(/\s+/g, ' ').trim()).join(' ');
    }

    function findDrivePlayButton(player) {
        const root = player?.closest?.('section[aria-label*="Video Player" i], [role="dialog"]') ||
            player?.parentElement || document;
        const candidates = [];

        const collectButtons = currentRoot => {
            try {
                for (const element of currentRoot.querySelectorAll('[role="button"], button, [tabindex]')) {
                    if (!isVisibleVideoElement(element)) continue;
                    const label = getAccessibleLabel(element);
                    const text = String(element.textContent || '').trim();
                    if (/^\s*(play|play video|play\/pause)\s*$/i.test(label) || /^\s*play\s*$/i.test(text)) {
                        candidates.push(element);
                    }
                }
                for (const host of currentRoot.querySelectorAll('*')) {
                    if (host.shadowRoot) collectButtons(host.shadowRoot);
                }
            } catch (_) {}
        };

        collectButtons(root);
        collectButtons(document);
        return candidates[0] || null;
    }

    function startDrivePlayerFromUserGesture() {
        const player = findDrivePlayerElement();
        if (!player) return { player: null, started: false };

        utils.muteMedia(player);
        const enforceMute = () => utils.muteMedia(player);
        player.addEventListener('play', enforceMute, { once: true });
        player.addEventListener('playing', enforceMute, { once: true });

        let started = false;
        try {
            const promise = player.play();
            started = true;
            if (promise?.catch) promise.catch(() => {
                try { findDrivePlayButton(player)?.click(); } catch (_) {}
            });
        } catch (_) {}

        if (player.paused) {
            try { findDrivePlayButton(player)?.click(); } catch (_) {}
        }
        return { player, started };
    }

    function resetVideoContextForFileChange() {
        app.videoQuality?.stopWatch?.();
        video.playbackStarted = false;
        video.restorePickerOnFileMenuOpen = false;
        video.formats = cloneFormats({});
        video.pickerFormats = null;
        video.scanCache = null;
    }

    function applyContextResponse(response) {
        if (!response?.success) return;
        const sessionFormats = response.session?.formats;
        if (hasUsableFormats(sessionFormats) || !video.pickerFormats) {
            video.formats = sessionFormats || cloneFormats({});
        }
    }

    async function syncViewerContext(force = false) {
        const { fileId, filename } = getCurrentDriveFileContext();
        if (!fileId && !isVideoViewerOpen()) return null;

        const contextKey = String(fileId || video.fileId || '');
        if (!force && contextKey && contextKey === String(video.fileId || '') && video.viewerSessionId) {
            if (filename) video.lastFilenameSent = filename;
            return { fileId: video.fileId, filename, viewerSessionId: video.viewerSessionId };
        }

        const changed = !!fileId && !!video.fileId && String(fileId) !== String(video.fileId);
        if (changed || !video.viewerSessionId || !video.fileId) video.viewerSessionId = createViewerSessionId(fileId);
        if (fileId) video.fileId = fileId;
        if (changed) resetVideoContextForFileChange();

        video.lastFilenameSent = filename || video.lastFilenameSent || '';
        const response = await sendRuntime({
            action: 'setVideoContext',
            fileId,
            filename: filename || 'gdrive-video',
            viewerSessionId: video.viewerSessionId,
            pageBridgeId: video.pageBridgeId
        });

        applyContextResponse(response);
        if (!video.pickerFormats && fileId) await restoreQualitySnapshot(fileId);
        app.video?.updateMenuState?.();
        return { fileId, filename, viewerSessionId: video.viewerSessionId };
    }

    function updateCapturedVideoFilename() {
        const name = getCurrentDriveFileName();
        if (!name || name === video.lastFilenameSent) return name;
        video.lastFilenameSent = name;
        app.sendAction('updateFilename', { filename: name });
        return name;
    }

    function muteMediaImmediately() {
        try { utils.muteAllMedia(); } catch (_) {}
        try { window.postMessage({ type: 'PSD_MEDIA_MUTE_NOW' }, '*'); } catch (_) {}
        void sendRuntime({ action: 'muteMediaNow' });
    }

    function setVideoPlaybackStarted(started = true) {
        if (!started || video.playbackStarted) return;
        video.playbackStarted = true;
        app.video?.updateMenuState?.();
        app.sendAction('videoPlaybackStarted');
    }

    function isCurrentVideoMessage(message) {
        const sameFile = !message?.fileId || !video.fileId || message.fileId === video.fileId;
        const sameViewer = !message?.viewerSessionId || !video.viewerSessionId ||
            message.viewerSessionId === video.viewerSessionId;
        return sameFile && sameViewer;
    }

    function isTrustedPageOrigin(origin) {
        const value = String(origin || '').toLowerCase();
        let hostname = '';
        try { hostname = new URL(value).hostname; } catch (_) {}
        return hostname === 'drive.google.com' ||
            hostname.endsWith('.drive.google.com') ||
            hostname === location.hostname ||
            hostname.endsWith('.googleusercontent.com');
    }

    function sendDownload(request) {
        return sendRuntime({
            action: 'downloadVideo',
            filename: getCurrentDriveFileName() || undefined,
            fileId: video.fileId || undefined,
            viewerSessionId: video.viewerSessionId || undefined,
            ...request
        });
    }

    app.videoCore = {
        sendRuntime,
        hasUsableFormats,
        cloneFormats,
        saveQualitySnapshot,
        restoreQualitySnapshot,
        isVideoViewerOpen,
        getCurrentDriveFileContext,
        getCurrentDriveFileName,
        createViewerSessionId,
        findDrivePlayerElement,
        findDrivePlayButton,
        startDrivePlayerFromUserGesture,
        syncViewerContext,
        updateCapturedVideoFilename,
        isVisibleVideoElement,
        collectVideoElements,
        muteMediaImmediately,
        setVideoPlaybackStarted,
        isCurrentVideoMessage,
        isTrustedPageOrigin,
        sendDownload
    };
})();
