function isPlaybackURL(raw) {
  try {
    const u = new URL(String(raw || ''));
    const host = u.hostname.toLowerCase();
    const trusted =
      host === 'drive.google.com' || host.endsWith('.drive.google.com') ||
      host === 'googlevideo.com' || host.endsWith('.googlevideo.com') ||
      host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
    return trusted && u.pathname.includes('videoplayback');
  } catch (_) {
    return false;
  }
}

function cleanURL(raw) {
  const u = new URL(String(raw || ''));
  u.searchParams.delete('range');
  return u.toString();
}

function classify(u) {
  const mime = (u.searchParams.get('mime') || '').toLowerCase();
  return mime.includes('audio') ? 'audio' : 'video';
}

function codecsFromURL(u) {
  return [
    u.searchParams.get('codecs'),
    u.searchParams.get('codec')
  ].filter(Boolean).join(' ');
}

function hasVideoCodec(value) {
  return /avc|av01|hev1|hvc1|vp8|vp9|vp09|theora/i.test(String(value || ''));
}

function hasAudioCodec(value) {
  return /mp4a|aac|opus|vorbis|vorb|ac-3|ec-3|flac|alaw|ulaw|pcm/i.test(String(value || ''));
}

function streamMode(video, audio) {
  if (video?.kind === 'video') {
    const codecs = video.codecs || '';
    if (hasVideoCodec(codecs) && hasAudioCodec(codecs)) return 'MUXED';
  }
  return audio ? 'SEPARATE' : 'UNKNOWN';
}

function parseCandidate(rawURL) {
  try {
    const u = new URL(String(rawURL));
    const kind = classify(u);
    const itag = u.searchParams.get('itag') || '';
    const mime = u.searchParams.get('mime') || '';
    const codecs = codecsFromURL(u);
    return {
      kind,
      url: cleanURL(rawURL),
      itag,
      mime,
      codecs,
      capturedAt: Date.now()
    };
  } catch (_) {
    return null;
  }
}

const tabs = new Map();

function getState(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = { video: null, audio: null, mode: 'UNKNOWN', session: 0 };
    tabs.set(tabId, state);
  }
  return state;
}

function persist(tabId, state) {
  chrome.storage.session.set({ [`gdrive:${tabId}`]: state }).catch(() => {});
}

async function loadState(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  try {
    const result = await chrome.storage.session.get(`gdrive:${tabId}`);
    const state = result[`gdrive:${tabId}`] || { video: null, audio: null, mode: 'UNKNOWN', session: 0 };
    tabs.set(tabId, state);
    return state;
  } catch (_) {
    return getState(tabId);
  }
}

function resetCurrentPlayback(tabId) {
  const state = getState(tabId);
  state.video = null;
  state.audio = null;
  state.mode = 'UNKNOWN';
  state.session = Date.now();
  persist(tabId, state);
}

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    const tabId = Number(details.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) return;
    if (!isPlaybackURL(details.url)) return;

    const candidate = parseCandidate(details.url);
    if (!candidate) return;

    const state = getState(tabId);
    if (candidate.capturedAt < state.session) return;

    if (candidate.kind === 'audio') {
      state.audio = candidate;
    } else {
      state.video = candidate;
    }

    state.mode = streamMode(state.video, state.audio);
    persist(tabId, state);
  },
  { urls: ['<all_urls>'] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'playbackStarted') {
    const tabId = Number(sender.tab?.id);
    if (Number.isInteger(tabId) && tabId >= 0) resetCurrentPlayback(tabId);
    return;
  }

  if (message?.type !== 'getCurrentGDriveURLs') return;

  const tabId = Number(message.tabId);
  loadState(tabId).then(state => {
    sendResponse({
      ok: true,
      video: state.video?.url || '',
      audio: state.audio?.url || '',
      mode: state.mode || state.video?.mode || 'UNKNOWN',
      videoItag: state.video?.itag || '',
      audioItag: state.audio?.itag || '',
      videoMime: state.video?.mime || '',
      audioMime: state.audio?.mime || '',
      videoCodecs: state.video?.codecs || '',
      audioCodecs: state.audio?.codecs || ''
    });
  }).catch(() => sendResponse({ ok: false, video: '', audio: '', mode: 'UNKNOWN' }));

  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabs.delete(tabId);
  chrome.storage.session.remove(`gdrive:${tabId}`).catch(() => {});
});
