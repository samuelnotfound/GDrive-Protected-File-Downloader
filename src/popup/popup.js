(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status-line'),
    fileName: $('file-name'),
    fileId: $('file-id'),
    videoList: $('video-list'),
    audioList: $('audio-list'),
    videoCount: $('video-count'),
    audioCount: $('audio-count'),
  };

  function cleanPlayableUrl(url) {
    if (!url) return '';
    const value = String(url);
    const rangeIndex = value.search(/[?&]range=/i);
    return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
  }

  function heightOf(stream) {
    return Number(stream?.qualityHeight || stream?.height || 0) || 0;
  }

  function labelOf(stream) {
    const h = heightOf(stream);
    if (h) return `${h}p`;
    if (stream?.probeQuality) return String(stream.probeQuality);
    if (stream?.itag) return `itag ${stream.itag}`;
    return 'Current video';
  }

  function shortUrl(url) {
    const s = String(url || '');
    if (s.length <= 52) return s;
    return `${s.slice(0, 28)}…${s.slice(-16)}`;
  }

  async function copyText(text, button) {
    const value = String(text || '');
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (button) {
      const prev = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = prev;
        button.classList.remove('copied');
      }, 1100);
    }
  }

  function openUrl(url) {
    const cleaned = cleanPlayableUrl(url);
    if (!cleaned) return;
    chrome.tabs.create({ url: cleaned, active: false });
  }

  function dedupeVideoStreams(list) {
    const map = new Map();
    for (const stream of list || []) {
      const raw = stream?.originalUrl || stream?.url;
      if (!raw) continue;
      const url = cleanPlayableUrl(raw);
      if (!url) continue;
      const h = heightOf(stream);
      const key = h > 0 ? `h:${h}` : (stream.itag ? `itag:${stream.itag}` : `url:${url}`);
      const prev = map.get(key);
      if (!prev || Number(stream.capturedAt || 0) >= Number(prev.capturedAt || 0)) {
        map.set(key, { ...stream, url, originalUrl: raw });
      }
    }
    return [...map.values()].sort((a, b) => heightOf(b) - heightOf(a));
  }

  function dedupeAudioStreams(list) {
    let best = null;
    for (const stream of list || []) {
      const raw = stream?.originalUrl || stream?.url;
      if (!raw) continue;
      const url = cleanPlayableUrl(raw);
      if (!url) continue;
      if (!best || Number(stream.capturedAt || 0) >= Number(best.capturedAt || 0)) {
        best = { ...stream, url, originalUrl: raw };
      }
    }
    return best ? [best] : [];
  }

  function streamRow(stream, { title, tag }) {
    const url = stream.url;
    const item = document.createElement('div');
    item.className = 'stream-item';

    const meta = document.createElement('div');
    meta.className = 'stream-meta';

    const label = document.createElement('div');
    label.className = 'stream-label';
    label.append(document.createTextNode(title));
    if (tag) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = tag;
      label.appendChild(pill);
    }

    const urlLine = document.createElement('div');
    urlLine.className = 'stream-url';
    const link = document.createElement('a');
    link.href = url;
    link.textContent = shortUrl(url);
    link.title = url;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openUrl(url);
    });
    urlLine.appendChild(link);
    meta.append(label, urlLine);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'chip-btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => openUrl(url));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chip-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyText(url, copyBtn));

    actions.append(openBtn, copyBtn);
    item.append(meta, actions);
    return item;
  }

  function collectStreams(payload) {
    const session = payload?.streams || {};
    const formats = session.formats || { video: [], audio: [], progressive: [] };

    let videos = [...(formats.video || []), ...(formats.progressive || [])];
    if (!videos.length) {
      videos = [...(session.videoCandidates || [])];
      if (session.video) {
        videos.push({
          url: session.video,
          originalUrl: session.videoOriginal || session.video,
          height: 0
        });
      }
      if (payload?.globalVideo?.url) videos.push(payload.globalVideo);
    }

    let audios = [...(formats.audio || [])];
    if (!audios.length) {
      if (payload?.globalAudio?.url) audios.push(payload.globalAudio);
      if (session.audio) {
        audios.push({
          url: session.audio,
          originalUrl: session.audioOriginal || session.audio,
          mime: 'audio/mp4'
        });
      }
      for (const a of (session.audioCandidates || [])) {
        if (a?.url) audios.push(a);
      }
    }

    return {
      session,
      videos: dedupeVideoStreams(videos),
      audios: dedupeAudioStreams(audios)
    };
  }

  function render(payload) {
    const { session, videos, audios } = collectStreams(payload);

    els.fileName.textContent = session.filename || '—';
    els.fileId.textContent = session.fileId || '—';
    els.fileId.title = session.fileId || '';
    els.videoCount.textContent = String(videos.length);
    els.audioCount.textContent = String(audios.length);

    els.videoList.replaceChildren();
    if (!videos.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Play a video and switch quality to capture URLs.';
      els.videoList.appendChild(empty);
    } else {
      for (const v of videos) {
        els.videoList.appendChild(streamRow(v, {
          title: labelOf(v),
          tag: v.itag ? `itag ${v.itag}` : (v.progressive ? 'muxed' : '')
        }));
      }
    }

    els.audioList.replaceChildren();
    if (!audios.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No audio URL yet.';
      els.audioList.appendChild(empty);
    } else {
      const a = audios[0];
      els.audioList.appendChild(streamRow(a, {
        title: 'Audio track',
        tag: a.itag ? `itag ${a.itag}` : 'shared'
      }));
    }

    const total = videos.length + audios.length;
    if (!session?.fileId && total === 0) {
      els.status.textContent = 'Open a Google Drive video tab';
    } else if (total === 0) {
      els.status.textContent = 'Play the video, then switch quality';
    } else if (videos.length && !audios.length) {
      els.status.textContent = `${videos.length} video · waiting for audio`;
    } else {
      els.status.textContent = `${videos.length} video · ${audios.length} audio`;
    }
  }

  async function getActiveDriveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (tab?.id && /drive\.google\.com/i.test(String(tab.url || ''))) return tab;
    const all = await chrome.tabs.query({ currentWindow: true });
    return all.find(t => /drive\.google\.com/i.test(String(t.url || ''))) || tab || null;
  }

  async function refreshStreams() {
    try {
      const tab = await getActiveDriveTab();
      if (!tab?.id) {
        els.status.textContent = 'No active tab found';
        render({ streams: null });
        return;
      }
      if (!/drive\.google\.com/i.test(String(tab.url || ''))) {
        els.status.textContent = 'Switch to a Google Drive tab';
        render({ streams: null });
        return;
      }
      const response = await chrome.runtime.sendMessage({
        action: 'getStreams',
        tabId: tab.id
      });
      render(response || {});
    } catch (e) {
      els.status.textContent = e?.message || 'Could not read streams';
    }
  }

  refreshStreams();
  const poll = setInterval(() => {
    if (document.hidden) return;
    refreshStreams();
  }, 2000);
  window.addEventListener('unload', () => clearInterval(poll));
})();
