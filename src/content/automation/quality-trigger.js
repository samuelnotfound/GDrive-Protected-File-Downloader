(() => {
  if (window.__driveQualityTriggerLoaded) return;
  window.__driveQualityTriggerLoaded = true;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();

  const OWN_UI = '#psd-video-quality-picker,#psd-video-scan-blocker,#psd-video-page-blocker,#psd-inpage-overlay';

  function allRoots(root = document, seen = new Set()) {
    if (!root || seen.has(root)) return [];
    seen.add(root);
    const roots = [root];
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot) roots.push(...allRoots(node.shadowRoot, seen));
      }
    } catch (_) {}
    return roots;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  }

  const isOwnUi = (el) => { try { return !!el.closest?.(OWN_UI); } catch (_) { return false; } };

  function elements() {
    const found = [];
    for (const root of allRoots()) {
      try {
        found.push(...root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],li,[tabindex]'));
      } catch (_) {}
    }
    return [...new Set(found)].filter(el => !isOwnUi(el) && isVisible(el));
  }

  function descriptor(el) {
    return [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('data-tooltip'),
      el.getAttribute?.('title'),
      el.textContent
    ].map(norm).filter(Boolean);
  }

  const labelOf = (el) => descriptor(el).join(' ');

  function findExact(labels, pool) {
    const wanted = labels.map(norm);
    return (pool || elements()).find(el => descriptor(el).some(v => wanted.includes(v))) || null;
  }

  function findContains(texts, pool) {
    const wanted = texts.map(norm);
    return (pool || elements()).find(el => descriptor(el).some(v => wanted.some(w => v === w || v.includes(w)))) || null;
  }

  function clickHuman(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { el.focus?.({ preventScroll: true }); } catch (_) {}
    try { el.click(); return true; } catch (_) {}
    return dispatchClick(el);
  }

  function dispatchClick(el) {
    if (!el) return false;
    let x = 0, y = 0;
    try { const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } catch (_) {}
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        const extra = Ctor === MouseEvent ? {} : { pointerId: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new Ctor(type, { ...base, ...extra, buttons: type.includes('down') ? 1 : 0 }));
      } catch (_) {}
    }
    return true;
  }

  function pressEnter(el) {
    if (!el) return false;
    try { el.focus?.({ preventScroll: true }); } catch (_) {}
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try { el.dispatchEvent(new KeyboardEvent(type, init)); } catch (_) {}
    }
    return true;
  }

  function mediaElements(selector = 'video') {
    const out = [];
    for (const root of allRoots()) {
      try { out.push(...(root.querySelectorAll?.(selector) || [])); } catch (_) {}
    }
    return [...new Set(out)];
  }

  const areaOf = (el) => { try { const r = el.getBoundingClientRect(); return r.width * r.height; } catch (_) { return 0; } };
  const mute = (v) => { try { v.muted = true; v.defaultMuted = true; v.volume = 0; v.setAttribute('muted', ''); } catch (_) {} };

  function muteAllMediaNow() {
    for (const media of mediaElements('video, audio')) mute(media);
  }

  let muteGuardCleanup = null;

  function setMainWorldMuteGuard(enabled) {
    try {
      window.postMessage({ type: 'PSD_MEDIA_MUTE_GUARD', enabled }, '*');
    } catch (_) {}
  }

  function enableMuteGuard() {
    if (muteGuardCleanup) return;
    setMainWorldMuteGuard(true);

    const boundRoots = new Set();
    const mutePlayback = event => {
      if (event?.target?.tagName === 'VIDEO') mute(event.target);
    };

    const bindRoots = () => {
      for (const root of allRoots()) {
        if (boundRoots.has(root)) continue;
        try {
          root.addEventListener('play', mutePlayback, true);
          root.addEventListener('playing', mutePlayback, true);
          root.addEventListener('volumechange', mutePlayback, true);
          boundRoots.add(root);
        } catch (_) {}
      }
      for (const video of mediaElements('video')) mute(video);
    };

    bindRoots();
    const observer = new MutationObserver(bindRoots);
    observer.observe(document.documentElement || document, { subtree: true, childList: true });

    muteGuardCleanup = () => {
      for (const root of boundRoots) {
        try {
          root.removeEventListener('play', mutePlayback, true);
          root.removeEventListener('playing', mutePlayback, true);
          root.removeEventListener('volumechange', mutePlayback, true);
        } catch (_) {}
      }
      observer.disconnect();
      muteGuardCleanup = null;
    };
  }

  function releaseMuteGuard() {
    muteGuardCleanup?.();
    setMainWorldMuteGuard(false);
  }

  function biggestVideo() {
    return mediaElements('video').filter(isVisible).sort((a, b) => areaOf(b) - areaOf(a))[0] || null;
  }

  function revealControls() {
    const video = biggestVideo();
    if (!video) return false;
    const targets = [video];
    let parent = video.parentElement;
    for (let i = 0; i < 5 && parent; i++, parent = parent.parentElement) targets.push(parent);
    for (const target of targets) {
      let x = 0, y = 0;
      try {
        const r = target.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.bottom - Math.min(28, r.height / 4);
      } catch (_) {}
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
      for (const type of ['pointerover', 'pointermove', 'mouseover', 'mousemove']) {
        try {
          const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          const extra = Ctor === MouseEvent ? {} : { pointerId: 1, pointerType: 'mouse', isPrimary: true };
          target.dispatchEvent(new Ctor(type, { ...base, ...extra }));
        } catch (_) {}
      }
    }
    return true;
  }

  const QUALITY_PATTERNS = [
    /^\d{3,4}p(\s*hd)?$/i,   // 144p, 360p, 720p, 720p hd
    /^\d{3,4}p\d{2,3}$/i,    // 1080p60
    /^auto(\s*\(.*\))?$/i,   // Auto, Auto (720p)
    /^4k$/i,
    /^2160p$/i
  ];

  function qualityLabel(el) {
    for (const raw of descriptor(el)) {
      const t = raw.trim();
      if (t && QUALITY_PATTERNS.some(p => p.test(t))) return t;
    }
    return null;
  }

  const heightOfLabel = (label) => {
    const text = String(label || '');
    if (/^4k$/i.test(text.trim())) return 2160;
    return Number(text.match(/(\d{3,4})p/i)?.[1] || 0);
  };

  function qualityPool() {
    const all = elements();
    const menuRoles = all.filter(el => {
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      return role === 'menuitemradio' || role === 'menuitem' || role === 'option';
    });
    return menuRoles.length ? menuRoles : all;
  }

  function qualityRows() {
    const rows = [];
    for (const el of qualityPool()) {
      const label = qualityLabel(el);
      if (!label) continue;
      rows.push({
        el,
        label,
        height: heightOfLabel(label),
        role: String(el.getAttribute?.('role') || '').toLowerCase(),
        selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true',
        area: areaOf(el)
      });
    }
    return rows;
  }

  async function play() {
    enableMuteGuard();
    const videos = mediaElements('video');
    for (const v of videos) mute(v);

    const ordered = videos.slice().sort((a, b) => {
      const ap = (!a.paused && !a.ended) ? 1 : 0, bp = (!b.paused && !b.ended) ? 1 : 0;
      return (bp - ap) || (areaOf(b) - areaOf(a));
    });
    if (ordered.some(v => !v.paused && !v.ended)) return { ok: true, playing: true, method: 'already playing' };

    for (const v of ordered) {
      try {
        mute(v);
        const promise = v.play();
        if (promise?.then) await promise.catch(() => {});
        await sleep(250);
        mute(v);
        if (!v.paused && !v.ended) {
          return { ok: true, playing: true, method: 'video.play()', currentTime: Number(v.currentTime || 0) };
        }
      } catch (_) {}
    }

    const playButton = findExact(['play', 'play video', 'playback', 'start playback']);
    if (playButton) {
      clickHuman(playButton);
      await sleep(350);
      for (const v of mediaElements('video')) mute(v);
      if (mediaElements('video').some(v => !v.paused && !v.ended)) {
        return { ok: true, playing: true, method: 'Play-button click' };
      }
    }

    await sleep(400);
    const started = mediaElements('video').some(v => !v.paused && !v.ended && (v.currentTime > 0 || v.readyState >= 3));
    return { ok: started, playing: started, method: started ? 'play state confirmation' : 'exhausted', videoCount: videos.length };
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'PSD_MUTE_MEDIA_NOW') muteAllMediaNow();
  });

  window.__driveQualityActions = {
    ping: () => ({ ok: true, url: location.href, videoCount: mediaElements('video').length, controls: elements().length }),

    play,

    revealControls: () => ({ ok: revealControls() }),

    clickLabel: ({ labels = [], contains = false, reveal = false } = {}) => {
      if (reveal) revealControls();
      const el = contains ? findContains(labels) : findExact(labels);
      if (!el) return { ok: false, found: false };
      return { ok: clickHuman(el), found: true, label: labelOf(el).slice(0, 60) };
    },

    findLabel: ({ labels = [], contains = false, reveal = false } = {}) => {
      if (reveal) revealControls();
      const el = contains ? findContains(labels) : findExact(labels);
      return { ok: !!el, found: !!el, label: el ? labelOf(el).slice(0, 60) : '' };
    },

    scanQualities: () => {
      const byLabel = new Map();
      for (const row of qualityRows()) {
        const key = row.label.toLowerCase();
        const previous = byLabel.get(key);
        if (!previous || row.selected) {
          byLabel.set(key, { label: row.label, text: row.label, height: row.height, role: row.role, selected: row.selected });
        }
      }
      const options = [...byLabel.values()];
      return {
        ok: true,
        options: options.filter(o => o.height > 0).sort((a, b) => b.height - a.height),
        labels: options.map(o => o.label)
      };
    },

    clickQuality: ({ height = 0, label = '', mode = 'click' } = {}) => {
      const wantedHeight = Number(height) || heightOfLabel(label);
      const names = label ? [label, `${label} resolution`, `${label} quality`]
        : [`${wantedHeight}p`, `${wantedHeight}p resolution`, `${wantedHeight}p quality`];

      let el = findExact(names, qualityPool());
      if (!el) {
        const matching = qualityRows().filter(row => row.height === wantedHeight);
        matching.sort((a, b) => {
          const rank = r => r.role === 'menuitemradio' ? 0 : r.role === 'menuitem' ? 1 : r.role === 'option' ? 2 : 3;
          return rank(a) - rank(b) || a.area - b.area;
        });
        el = matching[0]?.el || null;
      }
      if (!el) return { ok: false, found: false, reason: `${wantedHeight}p is not listed in this frame.` };

      const done = mode === 'keyboard' ? pressEnter(el) : mode === 'events' ? dispatchClick(el) : clickHuman(el);
      return { ok: !!done, found: true, mode, label: labelOf(el).slice(0, 60) };
    },

    closeMenu: () => {
      const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
      try { document.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (_) {}
      try { document.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (_) {}
      return { ok: true };
    },

    resumePlayback: () => {
      enableMuteGuard();
      const videos = mediaElements('video');
      for (const v of videos) {
        try {
          mute(v);
          if (v.paused) { const p = v.play(); if (p?.catch) p.catch(() => {}); }
        } catch (_) {}
      }
      return { ok: videos.some(v => !v.paused && !v.ended) };
    },

    releaseMuteGuard: () => {
      releaseMuteGuard();
      return { ok: true };
    }
  };
})();
