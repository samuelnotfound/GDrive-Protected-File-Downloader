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
            formats.video?.some?.(item => item?.url || item?.labelOnly || Number(item?.height || item?.qualityHeight || 0) > 0) ||
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
        const menuOptions = Array.isArray(video.qualityMenuOptions) ? video.qualityMenuOptions : [];
        // Persist labels even without stream URLs so Download can reopen the picker
        // after a finished job without re-scanning the player menu.
        if (!fileId || (!video.pickerFormats && !menuOptions.length)) return;

        const formats = video.pickerFormats
            ? cloneFormats(video.pickerFormats)
            : {
                video: menuOptions.map(o => ({
                    id: `label:${o.height}`,
                    height: Number(o.height) || 0,
                    qualityHeight: Number(o.height) || 0,
                    probeQuality: o.label || o.text || `${o.height}p`,
                    menuLabel: o.label || o.text || `${o.height}p`,
                    labelOnly: true,
                    url: ''
                })),
                audio: [],
                progressive: []
            };

        try {
            await sendRuntime({
                action: 'saveQualityPickerSnapshot',
                fileId,
                snapshot: {
                    fileId,
                    viewerSessionId: String(video.viewerSessionId || ''),
                    formats,
                    menuOptions: menuOptions.map(o => ({
                        height: Number(o.height) || 0,
                        label: String(o.label || o.text || '').trim(),
                        text: String(o.text || o.label || '').trim()
                    })),
                    savedAt: Date.now()
                }
            });
        } catch (_) {}
    }

    async function restoreQualitySnapshot(fileId = video.fileId) {
        const id = String(fileId || '').trim();
        // Prefer in-memory labels from this page session.
        if (Array.isArray(video.qualityMenuOptions) && video.qualityMenuOptions.length) {
            if (!video.pickerFormats) {
                video.pickerFormats = {
                    video: video.qualityMenuOptions.map(o => ({
                        id: `label:${o.height}`,
                        height: Number(o.height) || 0,
                        qualityHeight: Number(o.height) || 0,
                        probeQuality: o.label || o.text || `${o.height}p`,
                        menuLabel: o.label || o.text || `${o.height}p`,
                        labelOnly: true,
                        url: ''
                    })),
                    audio: (video.formats?.audio || []).slice(0, 1),
                    progressive: []
                };
            }
            return true;
        }
        if (hasUsableFormats(video.pickerFormats)) return true;
        if (!id) return false;

        try {
            const response = await sendRuntime({ action: 'loadQualityPickerSnapshot', fileId: id });
            const snap = response?.snapshot;
            if (!snap) return false;
            // Only restore label rows (no signed URLs) — URLs must be re-captured on download.
            const menu = Array.isArray(snap.menuOptions) ? snap.menuOptions : [];
            if (menu.length) {
                video.qualityMenuOptions = menu
                    .map(o => ({
                        height: Number(o.height) || 0,
                        label: String(o.label || o.text || '').trim(),
                        text: String(o.text || o.label || '').trim()
                    }))
                    .filter(o => o.height > 0);
            }
            const labelFormats = {
                video: (video.qualityMenuOptions || []).map(o => ({
                    id: `label:${o.height}`,
                    height: o.height,
                    qualityHeight: o.height,
                    probeQuality: o.label || `${o.height}p`,
                    menuLabel: o.label || `${o.height}p`,
                    labelOnly: true,
                    url: ''
                })),
                audio: [],
                progressive: []
            };
            video.pickerFormats = labelFormats;
            return !!(video.qualityMenuOptions?.length);
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

    function resetVideoContextForFileChange() {
        app.videoQuality?.stopWatch?.();
        video.playbackStarted = false;
        video.restorePickerOnFileMenuOpen = false;
        video.formats = cloneFormats({});
        video.pickerFormats = null;
        video.scanCache = null;
    }

    function applyContextResponse(response, expectedFileId = '', expectedViewerSessionId = '') {
        if (!response?.success) return;
        // Drop stale responses from a previous file/session (out-of-order async).
        if (expectedFileId && video.fileId && String(expectedFileId) !== String(video.fileId)) return;
        if (expectedViewerSessionId && video.viewerSessionId
            && String(expectedViewerSessionId) !== String(video.viewerSessionId)) return;
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

        const expectedFileId = fileId;
        const expectedViewerSessionId = video.viewerSessionId;
        video.lastFilenameSent = filename || video.lastFilenameSent || '';
        const response = await sendRuntime({
            action: 'setVideoContext',
            fileId,
            filename: filename || 'gdrive-video',
            viewerSessionId: expectedViewerSessionId,
            pageBridgeId: video.pageBridgeId
        });

        applyContextResponse(response, expectedFileId, expectedViewerSessionId);
        if (!video.pickerFormats && fileId
            && String(video.fileId || '') === String(fileId)) {
            await restoreQualitySnapshot(fileId);
        }
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
        // Auto-mute disabled per user request
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
