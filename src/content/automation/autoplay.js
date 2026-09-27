
(() => {
    if (window.__PSD_DRIVE_AUTOPLAY__) return;
    window.__PSD_DRIVE_AUTOPLAY__ = true;

    const { isVisible, mediaElements, areaOf, muteMedia } = window.__PSD_CONTENT_UTILS;

    function waitForPlayingVideo(videos, timeoutMs = 900) {
        const targets = Array.isArray(videos) ? videos : [];
        const deadline = Date.now() + timeoutMs;

        return new Promise(resolve => {
            const check = () => {
                const playing = targets.find(video => video && !video.paused && !video.ended);
                if (playing) return resolve(playing);
                if (Date.now() >= deadline) return resolve(null);
                setTimeout(check, 50);
            };
            check();
        });
    }

    function getVideoCandidates() {
        const videos = mediaElements('video');
        const visible = videos.filter(isVisible);
        const candidates = (visible.length ? visible : videos).sort((a, b) => {
            const aPlaying = !a.paused && !a.ended;
            const bPlaying = !b.paused && !b.ended;
            if (aPlaying !== bPlaying) return bPlaying - aPlaying;
            return areaOf(b) - areaOf(a);
        });

        videos.forEach(muteMedia);
        return { videos, candidates };
    }

    function buttonText(element) {
        return [
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('data-tooltip'),
            element.getAttribute?.('title'),
            element.textContent
        ].filter(Boolean).join(' ').trim();
    }

    function findPlayButton() {
        return [...document.querySelectorAll('button,[role="button"]')].find(element => {
            if (!isVisible(element, false)) return false;
            return /(^|\b)(play|play video|start playback)(\b|$)/i.test(buttonText(element));
        }) || null;
    }

    function startMuteGuard() {
        const mutePlayback = event => {
            if (event?.target?.tagName === 'VIDEO') muteMedia(event.target);
        };

        for (const type of ['play', 'playing', 'volumechange']) {
            document.addEventListener(type, mutePlayback, true);
        }

        const observer = new MutationObserver(() => mediaElements('video').forEach(muteMedia));
        observer.observe(document.documentElement || document, { subtree: true, childList: true });

        return () => {
            for (const type of ['play', 'playing', 'volumechange']) {
                document.removeEventListener(type, mutePlayback, true);
            }
            observer.disconnect();
        };
    }

    async function tryDirectVideoPlayback(videos) {
        for (const video of videos) {
            try {
                const before = Number(video.currentTime || 0);
                muteMedia(video);

                const playPromise = video.play();
                if (playPromise?.then) await playPromise;

                const playing = await waitForPlayingVideo([video], 600);
                muteMedia(video);
                if (!playing) continue;

                return {
                    success: true,
                    direct: true,
                    before,
                    after: Number(video.currentTime || 0),
                    muted: video.muted === true && video.volume === 0
                };
            } catch (_) {}
        }
        return null;
    }

    async function clickPlayFallback(videos) {
        try {
            const playButton = findPlayButton();
            if (playButton) {
                playButton.click();
                const playing = await waitForPlayingVideo(videos, 900);
                videos.forEach(muteMedia);
                return { clicked: true, playing: !!playing };
            }
        } catch (_) {}

        return {
            clicked: false,
            playing: !!videos.find(video => video && !video.paused && !video.ended)
        };
    }

    async function autoplayUsingSourceMethod() {
        const releaseMuteGuard = startMuteGuard();
        let videos = [];

        try {
            const found = getVideoCandidates();
            videos = found.videos;

            const directResult = await tryDirectVideoPlayback(found.candidates);
            if (directResult) {
                return { ...directResult, playbackDetected: true, method: 'source direct video.play()' };
            }

            const clickResult = await clickPlayFallback(videos);
            if (clickResult.playing) {
                return { ...clickResult, success: true, playbackDetected: true, method: 'source Play-button fallback' };
            }

            const detectedVideo = await waitForPlayingVideo(mediaElements('video'), 900);
            if (detectedVideo) {
                return { success: true, playbackDetected: true, method: 'play event/state confirmation' };
            }

            return {
                success: false,
                playbackDetected: false,
                method: 'source method exhausted',
                error: 'The player did not enter a confirmed playing state.'
            };
        } finally {
            mediaElements('video').forEach(muteMedia);
            releaseMuteGuard();
        }
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== 'PSD_RUN_AUTOPLAY') return;

        autoplayUsingSourceMethod()
            .then(playback => sendResponse({ ok: true, result: { playback } }))
            .catch(error => sendResponse({ ok: false, error: String(error) }));

        return true;
    });
})();
