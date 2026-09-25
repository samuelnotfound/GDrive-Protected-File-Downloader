function listPageFrames(tabId) {
  return new Promise(resolve => {
    chrome.webNavigation.getAllFrames({ tabId }, frames => resolve(frames || []));
  });
}

function sendMessageToFrame(tabId, frameId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, response => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

async function startAutoplayInFrames(tabId, frames = []) {
  const ids = new Set();
  const candidates = [];
  for (const frame of frames) { if (frame && !ids.has(frame.frameId)) { ids.add(frame.frameId); candidates.push(frame); } }
  for (const frame of candidates) {
    const response = await sendMessageToFrame(tabId, frame.frameId, { type: 'PSD_RUN_AUTOPLAY' });
    if (response?.ok && response.result?.playback?.playbackDetected) {
      return { frameId: frame.frameId, url: frame.url, ...response.result.playback };
    }
  }
  const deadline = Date.now() + 900;
  while (Date.now() < deadline) {
    const lateFrames = await listPageFrames(tabId);
    for (const frame of lateFrames) {
      if (ids.has(frame.frameId)) continue;
      ids.add(frame.frameId);
      const response = await sendMessageToFrame(tabId, frame.frameId, { type: 'PSD_RUN_AUTOPLAY' });
      if (response?.ok && response.result?.playback?.playbackDetected) {
        return { frameId: frame.frameId, url: frame.url, ...response.result.playback };
      }
    }
    await sleep(80);
  }
  return null;
}

function inspectPlaybackVideos() {
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
      if (rect.width <= 2 || rect.height <= 2 ||
          style.display === 'none' || style.visibility === 'hidden' ||
          style.opacity === '0' || video.ended) {
        return null;
      }

      const readyState = Number(video.readyState || 0);
      const currentTime = Number(video.currentTime || 0);
      return {
        playing: !video.paused && (currentTime > 0 || readyState >= 2),
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

async function getPlaybackVideos(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: inspectPlaybackVideos
    });
    return (results || []).flatMap(result => Array.isArray(result?.result) ? result.result : []);
  } catch (_) {
    return [];
  }
}

async function getPlayingVideoHeight(tabId) {
  const videos = await getPlaybackVideos(tabId);
  return Number(videos.find(video => video.playing)?.height || 0);
}

async function detectExistingPlayback(tabId) {
  const videos = await getPlaybackVideos(tabId);
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
