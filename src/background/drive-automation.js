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
