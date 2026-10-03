async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function setValue(id, value, placeholder = 'Not available') {
  const el = document.getElementById(id);
  el.value = value || '';
  el.placeholder = value ? '' : placeholder;
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

async function refresh() {
  const tab = await currentTab();
  if (!tab?.id) return;

  const result = await chrome.runtime.sendMessage({
    type: 'getCurrentGDriveURLs',
    tabId: tab.id
  });

  if (!result?.ok) return;

  setValue('video', result.video);
  setValue('audio', result.audio);

  const mode = result.mode || 'UNKNOWN';
  setText('mode', `Stream: ${mode}`);
  setText('videoMeta', `Video itag: ${result.videoItag || '—'}`);
  setText('audioMeta', `Audio itag: ${result.audioItag || '—'}`);
  setText('audioStatus', mode === 'MUXED'
    ? 'MUXED: audio is joined into the video URL.'
    : mode === 'SEPARATE'
      ? 'SEPARATE: audio and video use different URLs.'
      : 'UNKNOWN: no separate audio URL and no joined audio codec was declared.'
  );
}

refresh();
const timer = setInterval(refresh, 1000);
window.addEventListener('unload', () => clearInterval(timer));

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;

  const input = document.getElementById(button.dataset.copy);
  if (!input?.value) return;

  try {
    await navigator.clipboard.writeText(input.value);
  } catch (_) {}
});
