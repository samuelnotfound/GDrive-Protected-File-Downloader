(() => {
  if (window.__PSD_DRIVE_AUTOPLAY_V24__) return;
  window.__PSD_DRIVE_AUTOPLAY_V24__ = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ==========================
  // V3 AUTOPLAY — KEEP UNCHANGED
  // ==========================
  function isVisibleVideoElement(video) {
    if (!video) return false;
    try {
      const r = video.getBoundingClientRect();
      if (!r || r.width <= 1 || r.height <= 1) return false;
      const style = getComputedStyle(video);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    } catch (_) { return false; }
  }

  function collectVideoElements(root = document, out = []) {
    try {
      if (root.querySelectorAll) {
        out.push(...root.querySelectorAll("video"));
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) collectVideoElements(el.shadowRoot, out);
        }
      }
    } catch (_) {}
    return out;
  }

  function muteVideo(video) {
    try { video.muted = true; video.defaultMuted = true; video.volume = 0; } catch (_) {}
  }

  function getVideoCandidates() {
    const videos = collectVideoElements();
    const visible = videos.filter(isVisibleVideoElement);
    const candidates = (visible.length ? visible : videos).sort((a,b) => {
      const ap = (!a.paused && !a.ended) ? 1 : 0;
      const bp = (!b.paused && !b.ended) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      try {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      } catch (_) { return 0; }
    });
    for (const video of videos) muteVideo(video);
    return { videos, candidates };
  }

  function buttonText(el) {
    return [el.getAttribute?.("aria-label") || "", el.getAttribute?.("data-tooltip") || "", el.getAttribute?.("title") || "", el.textContent || ""].join(" ").trim();
  }

  function findPlayButton() {
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(el => {
      try {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      } catch (_) { return false; }
    });
    return buttons.find(el => /(^|\b)(play|play video|start playback)(\b|$)/i.test(buttonText(el))) || null;
  }

  async function tryDirectVideoPlayback(videos) {
    for (const video of videos) {
      try {
        const before = Number(video.currentTime || 0);
        muteVideo(video);
        const playPromise = video.play();
        if (playPromise?.then) await playPromise;
        await sleep(250);
        muteVideo(video);
        if (!video.paused && !video.ended) {
          return { success:true, direct:true, before, after:Number(video.currentTime || 0), muted:video.muted === true && video.volume === 0 };
        }
      } catch (_) {}
    }
    return null;
  }

  async function clickPlayFallback(videos) {
    try {
      const playButton = findPlayButton();
      if (playButton) {
        playButton.click();
        await sleep(300);
        for (const video of videos) muteVideo(video);
        return { clicked:true, playing:videos.some(v=>!v.paused && !v.ended) };
      }
    } catch (_) {}
    return { clicked:false, playing:videos.some(v=>!v.paused && !v.ended) };
  }

  async function autoplayUsingSourceMethod() {
    let videos = [];
    try {
      const found = getVideoCandidates();
      videos = found.videos;
      videos.forEach(muteVideo);
      const directResult = await tryDirectVideoPlayback(found.candidates);
      if (directResult) return { ...directResult, playbackDetected:true, method:"source direct video.play()" };
    } catch (_) {}
    const clickResult = await clickPlayFallback(videos);
    if (clickResult.playing) return { ...clickResult, success:true, playbackDetected:true, method:"source Play-button fallback" };
    await sleep(500);
    const started = collectVideoElements().some(video => isVisibleVideoElement(video) && !video.paused && !video.ended && (video.currentTime > 0 || video.readyState >= 3));
    if (started) return { success:true, playbackDetected:true, method:"play event/state confirmation" };
    return { success:false, playbackDetected:false, method:"source method exhausted", error:"The player did not enter a confirmed playing state." };
  }


  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PSD_RUN_V24_AUTOPLAY') {
      autoplayUsingSourceMethod()
        .then(playback => sendResponse({ ok:true, result:{ playback } }))
        .catch(error => sendResponse({ ok:false, error:String(error) }));
      return true;
    }
  });
})();
