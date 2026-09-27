(() => {
    if (window.__PSD_MEDIA_MUTE_GUARD__) return;
    window.__PSD_MEDIA_MUTE_GUARD__ = true;

    const COMMAND = 'PSD_MEDIA_MUTE_GUARD';
    const originalPlay = HTMLMediaElement.prototype.play;
    let enabled = false;
    let restorePlay = null;
    let cleanupListeners = null;

    function mute(media) {
        if (!(media instanceof HTMLMediaElement)) return;
        try {
            media.muted = true;
            media.defaultMuted = true;
            media.volume = 0;
            media.setAttribute('muted', '');
        } catch (_) {}
    }

    function collectRoots(root = document, roots = []) {
        if (!root?.querySelectorAll) return roots;
        roots.push(root);
        for (const host of root.querySelectorAll('*')) {
            if (host.shadowRoot) collectRoots(host.shadowRoot, roots);
        }
        return roots;
    }

    function muteAllMedia(root = document) {
        if (!root?.querySelectorAll) return;
        try {
            for (const media of root.querySelectorAll('video, audio')) mute(media);
        } catch (_) {}
    }

    function installPlayHook() {
        if (restorePlay) return;

        const hookedPlay = function (...args) {
            if (enabled) mute(this);
            const result = originalPlay.apply(this, args);
            if (enabled && result?.then) {
                result.then(() => mute(this), () => {});
            }
            return result;
        };

        try {
            HTMLMediaElement.prototype.play = hookedPlay;
            restorePlay = () => {
                HTMLMediaElement.prototype.play = originalPlay;
                restorePlay = null;
            };
        } catch (_) {}
    }

    function start() {
        if (enabled) return;
        enabled = true;
        installPlayHook();

        const mediaEvents = event => {
            if (enabled) mute(event.target);
        };

        const roots = new Set();
        const bindRoots = () => {
            for (const root of collectRoots()) {
                if (roots.has(root)) continue;
                try {
                    root.addEventListener('play', mediaEvents, true);
                    root.addEventListener('playing', mediaEvents, true);
                    root.addEventListener('volumechange', mediaEvents, true);
                    root.addEventListener('loadedmetadata', mediaEvents, true);
                    root.addEventListener('canplay', mediaEvents, true);
                    roots.add(root);
                } catch (_) {}
            }
            muteAllMedia();
        };

        bindRoots();
        const observer = new MutationObserver(bindRoots);
        observer.observe(document.documentElement || document, { subtree: true, childList: true });

        cleanupListeners = () => {
            for (const root of roots) {
                try {
                    root.removeEventListener('play', mediaEvents, true);
                    root.removeEventListener('playing', mediaEvents, true);
                    root.removeEventListener('volumechange', mediaEvents, true);
                    root.removeEventListener('loadedmetadata', mediaEvents, true);
                    root.removeEventListener('canplay', mediaEvents, true);
                } catch (_) {}
            }
            observer.disconnect();
            cleanupListeners = null;
        };
    }

    function stop() {
        if (!enabled) return;
        enabled = false;
        cleanupListeners?.();
        restorePlay?.();
    }

    window.addEventListener('message', event => {
        if (event.source !== window) return;
        if (event.data?.type !== COMMAND) return;
        if (event.data.enabled) start();
        else stop();
    });
})();
