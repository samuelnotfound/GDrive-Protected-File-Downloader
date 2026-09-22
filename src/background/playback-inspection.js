
function inspectPlaybackVideos({ strictPlaying = true } = {}) {
    const roots = [];
    const seen = new Set();
    const queue = [document];

    while (queue.length) {
        const root = queue.shift();
        if (!root || seen.has(root)) continue;
        seen.add(root);
        roots.push(root);

        try {
            for (const element of root.querySelectorAll('*')) {
                if (element.shadowRoot) queue.push(element.shadowRoot);
            }
        } catch (_) {}
    }

    const videos = [];
    for (const root of roots) {
        try { videos.push(...root.querySelectorAll('video')); } catch (_) {}
    }

    return [...new Set(videos)].map(video => {
        try {
            const rect = video.getBoundingClientRect();
            const style = getComputedStyle(video);

            if (
                rect.width <= 2 ||
                rect.height <= 2 ||
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0' ||
                video.ended
            ) return null;

            const readyState = Number(video.readyState || 0);
            const currentTime = Number(video.currentTime || 0);

            return {
                playing: strictPlaying
                    ? !video.paused && (currentTime > 0 || readyState >= 2)
                    : !video.paused,
                ready: readyState,
                currentTime,
                width: Number(video.videoWidth || 0),
                height: Number(video.videoHeight || 0),
                area: rect.width * rect.height
            };
        } catch (_) {
            return null;
        }
    }).filter(Boolean).sort((a, b) =>
        Number(b.playing) - Number(a.playing) ||
        b.ready - a.ready ||
        b.area - a.area
    );
}

async function getPlaybackVideos(tabId, strictPlaying = true) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: inspectPlaybackVideos,
            args: [{ strictPlaying }]
        });
        return (results || []).flatMap(result =>
            Array.isArray(result?.result) ? result.result : []
        );
    } catch (_) {
        return [];
    }
}

async function getPlayingVideoHeight(tabId) {
    const videos = await getPlaybackVideos(tabId, false);
    return Number(videos.find(video => video.playing)?.height || 0);
}

async function detectExistingPlayback(tabId) {
    const videos = await getPlaybackVideos(tabId, false);
    return videos.some(video => video.playing);
}

async function verifyPlaybackStarted(tabId, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const videos = await getPlaybackVideos(tabId);
        const playing = videos.find(video => video.playing);
        if (playing) return playing;
        await sleep(120);
    }

    return { playing: false };
}
