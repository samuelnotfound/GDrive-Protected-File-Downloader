(() => {
  let played = false;
  const unlock = (e) => {
    if (played || !(e.target instanceof HTMLVideoElement)) return;
    played = true;
    window.top.postMessage({ type: 'GDQ:VIDEO_PLAYED' }, '*');
  };
  document.addEventListener('play', unlock, true);
  document.addEventListener('playing', unlock, true);
})();
