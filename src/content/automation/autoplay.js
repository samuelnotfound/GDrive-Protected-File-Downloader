(() => {
  if (window.__PSD_DRIVE_AUTOPLAY__) return;
  window.__PSD_DRIVE_AUTOPLAY__ = true;

  function waitForPlayingVideo(videos, timeoutMs = 900) {
    const targets = Array.isArray(videos) ? videos : [];
    const deadline = Date.now() + timeoutMs;

    return new Promise(resolve => {
      const check = () => {
        const playing = targets.find(video => video && !video.paused && !video.ended);
        if (playing) {
          resolve(playing);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function isVisibleVideoElement(video) {
    if (!video) return false;
    try {
      const rect = video.getBoundingClientRect();
      if (!rect || rect.width <= 1 || rect.height <= 1) return false;
      const style = getComputedStyle(video);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (_) {
      return false;
    }
  }

  function collectVideoElements(root = document, out = []) {
    try {
      if (!root.querySelectorAll) return out;
      out.push(...root.querySelectorAll('video'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collectVideoElements(element.shadowRoot, out);
      }
    } catch (_) {}
    return out;
  }

  function muteVideo(video) {
    try {
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
      video.setAttribute('muted', '');
    } catch (_) {}
  }

  function startMuteGuard() {
    const muteEventTarget = event => {
      if (event?.target?.tagName === 'VIDEO') muteVideo(event.target);
    };

    document.addEventListener('play', muteEventTarget, true);
    document.addEventListener('playing', muteEventTarget, true);
    document.addEventListener('volumechange', muteEventTarget, true);

    const observer = new MutationObserver(() => {
      for (const video of collectVideoElements()) muteVideo(video);
    });
    observer.observe(document.documentElement || document, { subtree: true, childList: true });

    return () => {
      document.removeEventListener('play', muteEventTarget, true);
      document.removeEventListener('playing', muteEventTarget, true);
      document.removeEventListener('volumechange', muteEventTarget, true);
      observer.disconnect();
    };
  }

  function getVideoCandidates() {
    const videos = collectVideoElements();
    const visible = videos.filter(isVisibleVideoElement);
    const candidates = (visible.length ? visible : videos).sort((a, b) => {
      const aPlaying = !a.paused && !a.ended;
      const bPlaying = !b.paused && !b.ended;
      if (aPlaying !== bPlaying) return bPlaying - aPlaying;

      try {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      } catch (_) {
        return 0;
      }
    });

    for (const video of videos) muteVideo(video);
    return { videos, candidates };
  }

  function buttonText(element) {
    return [
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('data-tooltip') || '',
      element.getAttribute?.('title') || '',
      element.textContent || ''
    ].join(' ').trim();
  }

  function findPlayButton() {
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element => {
      try {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      } catch (_) {
        return false;
      }
    });

    return buttons.find(element => /(^|\b)(play|play video|start playback)(\b|$)/i.test(buttonText(element))) || null;
  }

  async function tryDirectVideoPlayback(videos) {
    for (const video of videos) {
      try {
        const before = Number(video.currentTime || 0);
        muteVideo(video);
        const playPromise = video.play();
        if (playPromise?.then) await playPromise;

        const playing = await waitForPlayingVideo([video], 600);
        muteVideo(video);
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
        for (const video of videos) muteVideo(video);
        return { clicked: true, playing: !!playing };
      }
    } catch (_) {}
    return { clicked: false, playing: !!videos.find(video => video && !video.paused && !video.ended) };
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

      const detectedVideo = await waitForPlayingVideo(collectVideoElements(), 900);
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
      for (const video of collectVideoElements()) muteVideo(video);
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
