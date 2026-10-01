(() => {
  if (window.__driveQualityTriggerLoaded) return;
  window.__driveQualityTriggerLoaded = true;

  const { sleep, allRoots, isVisible, mediaElements, areaOf, muteMedia } = window.__PSD_CONTENT_UTILS;
  const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();

  const OWN_UI = '#psd-video-quality-picker,#psd-video-scan-blocker,#psd-video-page-blocker,#psd-inpage-overlay';

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

  function muteAllMediaNow() {
    for (const media of mediaElements('video, audio')) muteMedia(media);
  }

  let muteGuardCleanup = null;

  function setMainWorldMuteGuard(enabled) {
    try {
      window.postMessage({ type: 'PSD_MEDIA_MUTE_GUARD', enabled }, '*');
    } catch (_) {}
  }

  // Auto-release if background never calls releaseMuteGuard (MV3 SW death mid-flow).
  const MUTE_GUARD_MAX_MS = 45000;
  let muteGuardAutoTimer = null;

  function enableMuteGuard() {
    if (muteGuardCleanup) {
      // Refresh auto-release deadline on repeated enable.
      if (muteGuardAutoTimer) clearTimeout(muteGuardAutoTimer);
      muteGuardAutoTimer = setTimeout(() => { try { releaseMuteGuard(); } catch (_) {} }, MUTE_GUARD_MAX_MS);
      return;
    }
    setMainWorldMuteGuard(true);

    const boundRoots = new Set();
    const mutePlayback = event => {
      if (event?.target?.tagName === 'VIDEO') muteMedia(event.target);
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
      for (const video of mediaElements('video')) muteMedia(video);
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
    if (muteGuardAutoTimer) clearTimeout(muteGuardAutoTimer);
    muteGuardAutoTimer = setTimeout(() => { try { releaseMuteGuard(); } catch (_) {} }, MUTE_GUARD_MAX_MS);
  }

  function releaseMuteGuard() {
    if (muteGuardAutoTimer) {
      clearTimeout(muteGuardAutoTimer);
      muteGuardAutoTimer = null;
    }
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

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'PSD_MUTE_MEDIA_NOW') muteAllMediaNow();
  });

  window.__driveQualityActions = {
    revealControls: () => ({ ok: revealControls() }),

    clickLabel: ({ labels = [], reveal = false } = {}) => {
      if (reveal) revealControls();
      const el = findExact(labels);
      if (!el) return { ok: false, found: false };
      return { ok: clickHuman(el), found: true, label: labelOf(el).slice(0, 60) };
    },

    // Mirror Drive Quality Trigger: read the live Quality submenu labels
    // (menuitemradio / menuitem / option) instead of assuming fixed heights.
    scanQualities: () => {
      const byLabel = new Map();
      for (const row of qualityRows()) {
        const key = row.label.toLowerCase();
        const previous = byLabel.get(key);
        if (!previous || row.selected) {
          byLabel.set(key, {
            label: row.label,
            text: row.label,
            height: row.height,
            role: row.role,
            selected: row.selected
          });
        }
      }
      const options = [...byLabel.values()];
      // Downloadable rows only (numeric heights). "Auto" stays in labels for diagnostics.
      const downloadable = options
        .filter(o => Number(o.height) > 0)
        .sort((a, b) => Number(b.height) - Number(a.height));
      return {
        ok: true,
        options: downloadable,
        labels: options.map(o => o.label)
      };
    },

    clickQuality: ({ height = 0, label = '' } = {}) => {
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

      // Fire exactly one click sequence. Native .click() first; only fall back to
      // a full synthetic pointer/mouse sequence when native click throws.
      const done = clickHuman(el);

      // aria-checked is updated asynchronously by Drive — do not treat a same-tick
      // read as authoritative. Callers should rely on ok/found, not selected.
      const selected = el.getAttribute('aria-checked') === 'true'
        || el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('aria-current') === 'true';
      return {
        ok: !!done,
        found: true,
        label: labelOf(el).slice(0, 60),
        selected, // best-effort snapshot only; may lag Drive's own handlers
        height: wantedHeight,
        wasAlreadySelected: selected
      };
    },

    // After a quality switch, nudge currentTime so the player must fetch a new
    // media segment for the newly selected itag instead of reusing the buffer.
    nudgePlayback: ({ seconds = 0.35 } = {}) => {
      enableMuteGuard();
      let nudged = false;
      const step = Math.max(0.25, Number(seconds) || 0.35);
      for (const v of mediaElements('video')) {
        try {
          muteMedia(v);
          const duration = Number(v.duration);
          const current = Number(v.currentTime || 0);
          if (Number.isFinite(duration) && duration > 1) {
            // Prefer jumping forward; if near the end, jump backward so a
            // segment fetch is still forced for the new itag.
            let next = current + step;
            if (next >= duration - 0.1) {
              next = Math.max(0, Math.min(current - step, duration - 0.5));
            }
            if (Math.abs(next - current) > 0.05) {
              v.currentTime = next;
              nudged = true;
            }
          } else if (Number.isFinite(current)) {
            // Unknown duration — still poke currentTime to trigger a fetch.
            v.currentTime = current + step;
            nudged = true;
          }
          if (v.paused) {
            const p = v.play();
            if (p?.catch) p.catch(() => {});
          }
        } catch (_) {}
      }
      return { ok: true, nudged };
    },

    closeMenu: () => {
      const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
      try { document.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (_) {}
      try { document.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (_) {}
      try { document.body?.click(); } catch (_) {}
      return { ok: true };
    },

    resumePlayback: () => {
      enableMuteGuard();
      const videos = mediaElements('video');
      for (const v of videos) {
        try {
          muteMedia(v);
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
