(() => {
    if (window.__PSD_VIDEO_BRIDGE__) return;
    window.__PSD_VIDEO_BRIDGE__ = true;

    const app = window.__PSD;
    const video = app.videoState;
    const core = app.videoCore;
    const quality = app.videoQuality;

    function handleBridgeReady(data) {
        if (data.bridgeId) video.pageBridgeId = String(data.bridgeId);

        const bridgeKey = String(data.bridgeId || '');
        const now = Date.now();
        video.bridgeReplayAt = video.bridgeReplayAt || {};
        if (now - (video.bridgeReplayAt[bridgeKey] || 0) < 2000) return;

        video.bridgeReplayAt[bridgeKey] = now;
        try { window.postMessage({ type: 'PSD_GDRIVE_STREAM_REPLAY', fromReady: true }, '*'); }
        catch (_) {}
    }

    async function handleDetectedStream(data) {
        if (typeof data.url !== 'string' || !data.url.includes('videoplayback')) return;
        if (!core.isVideoViewerOpen()) return;
        if (!video.fileId || !video.viewerSessionId) await core.syncViewerContext(false);

        try {
            const response = await core.sendRuntime({
                action: 'pageStreamDetected',
                url: data.url,
                fileId: video.fileId,
                viewerSessionId: video.viewerSessionId,
                pageBridgeId: String(data.bridgeId || video.pageBridgeId || ''),
                source: data.source || 'page-bridge',
                frameUrl: data.frameUrl || ''
            });
            if (!response?.success) return;

            video.playbackStarted = true;
            if (response.session?.formats) video.formats = response.session.formats;
            app.video.updateMenuState();
            if (video.operation === 'picker') quality.update();
        } catch (_) {}
    }

    function handlePlaybackQualities(data) {
        const heights = Array.isArray(data.heights) ? data.heights.map(Number).filter(Boolean) : [];
        if (!heights.length) return;
        // Prefer the highest set we have seen for this page/session.
        const prev = Array.isArray(video.playbackQualityHeights) ? video.playbackQualityHeights : [];
        const merged = [...new Set([...prev, ...heights])].sort((a, b) => b - a);
        video.playbackQualityHeights = merged;
        video.playbackQualityLabels = merged.map(h => `${h}p`);
        video.playbackQualityFileId = String(data.fileId || video.playbackQualityFileId || '');
        video.playbackStarted = true;
        try { app.video?.updateMenuState?.(); } catch (_) {}
    }

    async function handlePageBridgeMessage(event) {
        const data = event?.data;
        if (!data || typeof data !== 'object' || window.top !== window) return;
        if (!core.isTrustedPageOrigin(event.origin)) return;
        if (data.type === 'PSD_GDRIVE_PAGE_BRIDGE_READY') {
            handleBridgeReady(data);
            return;
        }
        if (data.type === 'PSD_GDRIVE_STREAM_DETECTED') await handleDetectedStream(data);
        if (data.type === 'PSD_GDRIVE_PLAYBACK_QUALITIES') handlePlaybackQualities(data);
    }

    function installPageNetworkRelay() {
        if (window.top !== window || window.__PSD_PAGE_BRIDGE_RELAY) return;
        window.__PSD_PAGE_BRIDGE_RELAY = true;

        window.addEventListener('message', event => {
            handlePageBridgeMessage(event).catch(() => {});
        }, true);

        const replay = () => {
            try { window.postMessage({ type: 'PSD_GDRIVE_STREAM_REPLAY' }, '*'); } catch (_) {}
        };
        replay();
        setTimeout(replay, 1000);
    }

    function installFramePlaybackRelay() {
        if (window.__PSD_FRAME_PLAYBACK_RELAY) return;
        window.__PSD_FRAME_PLAYBACK_RELAY = true;

        const relay = event => {
            const target = event.target;
            if (String(target?.tagName || '').toLowerCase() !== 'video') return;
            if (!core.isVisibleVideoElement(target)) return;

            try { chrome.runtime.sendMessage({ action: 'videoPlaybackIntent', fileId: video.fileId }); }
            catch (_) {}
            core.setVideoPlaybackStarted();
        };

        document.addEventListener('play', relay, true);
        document.addEventListener('playing', relay, true);
    }

    function init() {
        installPageNetworkRelay();
        installFramePlaybackRelay();
    }

    app.videoBridge = { init };
})();
