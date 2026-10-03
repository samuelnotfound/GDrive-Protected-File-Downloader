(() => {
  let activeVideo = null;
  let notifiedVideo = null;

  const startSession = video => {
    if (!video || video.paused || video.ended) return;
    if (video === notifiedVideo) return;
    notifiedVideo = video;
    chrome.runtime.sendMessage({ type: 'playbackStarted' }).catch(() => {});
  };

  document.addEventListener('play', event => {
    if (event.target instanceof HTMLVideoElement) {
      activeVideo = event.target;
      startSession(activeVideo);
    }
  }, true);

  document.addEventListener('ended', event => {
    if (event.target === activeVideo) {
      activeVideo = null;
      notifiedVideo = null;
    }
  }, true);

  setInterval(() => {
    const playing = [...document.querySelectorAll('video')]
      .find(video => !video.paused && !video.ended && video.readyState > 0);

    if (!playing) return;
    activeVideo = playing;
    startSession(playing);
  }, 500);
})();
