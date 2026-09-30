(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status-line'),
    videoList: $('video-list'),
    audioList: $('audio-list'),
    videoCount: $('video-count'),
    audioCount: $('audio-count'),
  };

  // Standard adaptive itags — used only when the URL/menu does not declare height.
  const ITAG_HEIGHT = {
    '160': 144, '133': 240, '134': 360, '135': 480,
    '136': 720, '137': 1080, '264': 1440, '266': 2160,
    '242': 240, '243': 360, '244': 480, '247': 720, '248': 1080,
    '298': 720, '299': 1080, '18': 360, '22': 720,
    '34': 360, '35': 480, '37': 1080, '43': 360,
    '44': 480, '45': 720, '46': 1080, '59': 480
  };

  function cleanPlayableUrl(url) {
    if (!url) return '';
    const value = String(url);
    const rangeIndex = value.search(/[?&]range=/i);
    return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
  }

  function paramsOf(url) {
    try { return new URL(String(url || '')).searchParams; }
    catch (_) { return null; }
  }

  /** Bytes from stream object or clen= on the URL (full track size, not a segment). */
  function streamBytes(stream) {
    const listed = Number(stream?.contentLength || 0);
    if (Number.isFinite(listed) && listed > 0) return listed;
    const p = paramsOf(stream?.originalUrl || stream?.url);
    if (!p) return 0;
    const clen = Number(p.get('clen') || 0);
    return Number.isSafeInteger(clen) && clen > 0 ? clen : 0;
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Resolve display height the same way the in-page quality picker prefers:
   *   1) explicit height/sz on the media URL
   *   2) menu / probe label ("720p", "720p HD")
   *   3) qualityHeight / height already stored on the candidate
   *   4) itag table (last resort)
   */
  function heightOf(stream) {
    const p = paramsOf(stream?.originalUrl || stream?.url);
    if (p) {
      const urlH = Number(p.get('height') || 0);
      if (urlH > 0) return urlH;
      // Some Drive URLs encode size as "1280x720"
      const sz = String(p.get('sz') || p.get('size') || '');
      const m = sz.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
      if (m) return Number(m[2]) || Number(m[1]) || 0;
    }

    const label = String(
      stream?.menuLabel || stream?.probeQuality || stream?.probeQualityLabel || ''
    );
    const fromLabel = Number(label.match(/(\d{3,4})\s*p/i)?.[1] || 0);
    if (fromLabel > 0) return fromLabel;

    // Prefer qualityHeight only when it came from a real probe/url, not a blind stamp.
    const qh = Number(stream?.qualityHeight || 0);
    const h = Number(stream?.height || 0);
    const source = String(stream?.heightSource || '');
    if (qh > 0 && (source === 'probe' || source === 'url' || stream?.probeToken)) return qh;
    if (h > 0) return h;
    if (qh > 0) return qh;

    const itag = String(stream?.itag || p?.get('itag') || '');
    if (itag && ITAG_HEIGHT[itag]) return ITAG_HEIGHT[itag];
    return 0;
  }

  function labelOf(stream) {
    // Prefer the exact menu text the player showed (e.g. "720p HD").
    const menu = String(stream?.menuLabel || stream?.probeQuality || '').trim();
    if (menu && /\d{3,4}\s*p/i.test(menu)) return menu.replace(/\s+/g, ' ');

    const h = heightOf(stream);
    if (h) return `${h}p`;
    if (stream?.itag) return `itag ${stream.itag}`;
    return 'Video';
  }

  function shortUrl(url) {
    const s = String(url || '');
    if (s.length <= 48) return s;
    return `${s.slice(0, 26)}…${s.slice(-14)}`;
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
      const itag = String(stream?.itag || paramsOf(raw)?.get('itag') || '');
      // Dedupe by height when known, else by itag, else by URL.
      const key = h > 0 ? `h:${h}` : (itag ? `itag:${itag}` : `url:${url}`);
      const prev = map.get(key);
      const bytes = streamBytes({ ...stream, url, originalUrl: raw });
      const prevBytes = prev ? streamBytes(prev) : 0;
      // Prefer larger clen (full track vs segment) and newer captures.
      const better = !prev
        || bytes > prevBytes
        || (bytes === prevBytes && Number(stream.capturedAt || 0) >= Number(prev.capturedAt || 0));
      if (better) {
        map.set(key, {
          ...stream,
          url,
          originalUrl: raw,
          height: h || Number(stream.height || 0),
          qualityHeight: h || Number(stream.qualityHeight || stream.height || 0),
          contentLength: bytes || Number(stream.contentLength || 0),
          itag: itag || stream.itag || ''
        });
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
      const bytes = streamBytes({ ...stream, url, originalUrl: raw });
      const candidate = {
        ...stream,
        url,
        originalUrl: raw,
        contentLength: bytes || Number(stream.contentLength || 0)
      };
      if (!best
        || bytes > streamBytes(best)
        || (bytes === streamBytes(best) && Number(stream.capturedAt || 0) >= Number(best.capturedAt || 0))) {
        best = candidate;
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
    const sizeText = formatSize(streamBytes(stream));
    if (sizeText) {
      const sizePill = document.createElement('span');
      sizePill.className = 'pill size';
      sizePill.textContent = sizeText;
      sizePill.title = 'Track size from stream URL (clen)';
      label.appendChild(sizePill);
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

    els.videoCount.textContent = String(videos.length);
    els.audioCount.textContent = String(audios.length);

    els.videoList.replaceChildren();
    if (!videos.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No video captured yet. Use File → Download on the Drive tab.';
      els.videoList.appendChild(empty);
    } else {
      for (const v of videos) {
        els.videoList.appendChild(streamRow(v, {
          title: labelOf(v),
          tag: v.progressive ? 'muxed' : ''
        }));
      }
    }

    els.audioList.replaceChildren();
    if (!audios.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No audio yet. Play the video for a moment, then try again.';
      els.audioList.appendChild(empty);
    } else {
      const a = audios[0];
      els.audioList.appendChild(streamRow(a, {
        title: 'Audio track',
        tag: ''
      }));
    }

    const total = videos.length + audios.length;
    if (!session?.fileId && total === 0) {
      els.status.textContent = 'Open a Google Drive video tab';
    } else if (total === 0) {
      els.status.textContent = 'Use File → Download on the Drive tab';
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
