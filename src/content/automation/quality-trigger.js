(() => {
  if (window.__driveQualityTriggerLoaded) return;
  window.__driveQualityTriggerLoaded = true;

  const { sleep, allRoots, isVisible, mediaElements, areaOf } = window.__PSD_CONTENT_UTILS;
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

  // ---- Prototype-style DOM find + full pointer press (menu + quality changer) ----
  const visibleEl = (el) => {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
      }
    } catch (_) {}
    return isVisible(el);
  };

  const ownText = (el) =>
    [...(el?.childNodes || [])]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue)
      .join('')
      .trim();

  // Visible elements whose *own* text passes `test` (skips long JSON/script blobs).
  const findAllByOwnText = (test) => {
    const found = [];
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        if (node.nodeValue.length > 80) continue;
        const el = node.parentElement;
        if (!el || isOwnUi(el)) continue;
        const t = node.nodeValue.trim();
        if (test(t) && visibleEl(el)) found.push(el);
      }
    } catch (_) {}
    return found;
  };

  const findQualityItem = () => findAllByOwnText((t) => t === 'Quality')[0] || null;

  const findOption = (quality, qualityItem) => {
    const row = qualityItem?.closest?.('[role^=menuitem], [role=option], li');
    const pick = (test) =>
      findAllByOwnText(test).filter((el) => !row?.contains?.(el)).at(-1) || null;
    const q = String(quality || '').trim();
    return pick((t) => t === q) || pick((t) => t.startsWith(q));
  };

  const waitFor = (find, { ms = 2000, giveUp } = {}) =>
    new Promise((resolve) => {
      let frame = 0;
      const observer = new MutationObserver(() => {
        frame ||= requestAnimationFrame(check);
      });
      const timer = setTimeout(() => done(find()), ms);
      const done = (value) => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        try { observer.disconnect(); } catch (_) {}
        resolve(value);
      };
      const check = () => {
        frame = 0;
        const el = find();
        if (el || giveUp?.()) done(el);
      };
      try {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded'],
        });
      } catch (_) {}
      check();
    });

  /**
   * Full hover → down → up → click at element centre, aimed at whatever is
   * actually on top there (wrapper inner button). Matches quality-changer press().
   */
  function press(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    let left = 0, top = 0, width = 0, height = 0;
    try {
      const r = el.getBoundingClientRect();
      left = r.left; top = r.top; width = r.width; height = r.height;
    } catch (_) {}
    const x = left + width / 2;
    const y = top + height / 2;
    let target = el;
    try {
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit)) target = hit;
    } catch (_) {}
    const fire = (Type, type, init) => {
      try {
        target.dispatchEvent(
          new Type(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            ...init,
          })
        );
      } catch (_) {}
    };
    fire(PointerEvent, 'pointerover');
    fire(MouseEvent, 'mouseover');
    fire(PointerEvent, 'pointermove');
    fire(MouseEvent, 'mousemove');
    fire(PointerEvent, 'pointerdown', { buttons: 1 });
    fire(MouseEvent, 'mousedown', { buttons: 1 });
    fire(PointerEvent, 'pointerup');
    fire(MouseEvent, 'mouseup');
    fire(MouseEvent, 'click', { detail: 1 });
    return true;
  }

  // Prefer prototype press; keep name clickHuman for existing call sites.
  function clickHuman(el) {
    if (!el) return false;
    try { el.focus?.({ preventScroll: true }); } catch (_) {}
    return press(el);
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

    // Full gear → Quality → resolution click, matching the quality-changer prototype.
    // Async so waitFor can settle menus between presses.
    clickQuality: async ({ height = 0, label = '' } = {}) => {
      const wantedHeight = Number(height) || heightOfLabel(label);
      const qualityText = String(label || (wantedHeight ? `${wantedHeight}p` : '')).trim();
      if (!qualityText && !wantedHeight) {
        return { ok: false, found: false, reason: 'No quality label or height provided.' };
      }

      // If Quality submenu is already open, just press the option.
      let qualityItem = findQualityItem();
      if (!qualityItem) {
        // Open Settings gear, then wait for Quality row (up to a few tries).
        for (let attempt = 0; attempt < 4 && !qualityItem; attempt++) {
          const gears = [...document.querySelectorAll('[aria-label="Settings"]')];
          const gear = gears.find(visibleEl) || gears[0];
          if (!gear) break;
          press(gear);
          qualityItem = await waitFor(findQualityItem, { ms: attempt === 0 ? 500 : 700 });
          if (!qualityItem) {
            qualityItem = await waitFor(findQualityItem, { ms: 150 });
          }
        }
      }

      if (!qualityItem) {
        // Fallback: old path — find option directly if submenu already open via background.
        const names = label
          ? [label, `${label} resolution`, `${label} quality`]
          : [`${wantedHeight}p`, `${wantedHeight}p resolution`, `${wantedHeight}p quality`];
        let el = findExact(names, qualityPool());
        if (!el) {
          const matching = qualityRows().filter(row => row.height === wantedHeight);
          matching.sort((a, b) => {
            const rank = r => (r.role === 'menuitemradio' ? 0 : r.role === 'menuitem' ? 1 : r.role === 'option' ? 2 : 3);
            return rank(a) - rank(b) || a.area - b.area;
          });
          el = matching[0]?.el || null;
        }
        if (!el) {
          return { ok: false, found: false, reason: `${qualityText || wantedHeight + 'p'} is not listed in this frame.` };
        }
        const done = press(el);
        return {
          ok: !!done,
          found: true,
          label: labelOf(el).slice(0, 60),
          height: wantedHeight,
          method: 'direct-option'
        };
      }

      // Press Quality, wait for the resolution option, press it.
      press(qualityItem);
      const optionText = qualityText || `${wantedHeight}p`;
      let option = await waitFor(() => findOption(optionText, qualityItem), { ms: 2000 });
      if (!option && wantedHeight) {
        option = await waitFor(() => findOption(`${wantedHeight}p`, qualityItem), { ms: 800 });
      }
      // Also try matching by height via qualityRows if own-text miss.
      if (!option && wantedHeight) {
        const matching = qualityRows().filter(row => row.height === wantedHeight);
        matching.sort((a, b) => {
          const rank = r => (r.role === 'menuitemradio' ? 0 : r.role === 'menuitem' ? 1 : r.role === 'option' ? 2 : 3);
          return rank(a) - rank(b) || a.area - b.area;
        });
        option = matching[0]?.el || null;
      }
      if (!option) {
        return {
          ok: false,
          found: false,
          reason: `Opened Quality but could not find ${optionText}.`,
          method: 'setQuality'
        };
      }
      press(option);
      return {
        ok: true,
        found: true,
        label: (ownText(option) || labelOf(option) || optionText).slice(0, 60),
        height: wantedHeight,
        method: 'setQuality'
      };
    },

    // After a quality switch, nudge currentTime so the player must fetch a new
    // media segment for the newly selected itag instead of reusing the buffer.
    nudgePlayback: ({ seconds = 0.35 } = {}) => {
      // Auto-mute disabled; still nudge playback to force segment fetch.
      let nudged = false;
      const step = Math.max(0.25, Number(seconds) || 0.35);
      for (const v of mediaElements('video')) {
        try {
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
      // Auto-mute disabled
      const videos = mediaElements('video');
      for (const v of videos) {
        try {
          if (v.paused) { const p = v.play(); if (p?.catch) p.catch(() => {}); }
        } catch (_) {}
      }
      return { ok: videos.some(v => !v.paused && !v.ended) };
    },

  };
})();
