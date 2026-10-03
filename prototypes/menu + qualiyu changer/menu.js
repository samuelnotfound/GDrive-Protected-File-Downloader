// Adds a "Quality" section under "Share" in Drive's file menu. Until a video has played it is a
// disabled item reading "Play video first"; afterwards it shows a dropdown of the available
// resolutions with a "Set" button, which replays what a person would do in the player:
// gear -> Quality -> that resolution.
// Runs in the page's world (MAIN) so it can use window.__gdq from hook.js.
(() => {
  // ---- finding things ---------------------------------------------------------------
  const visible = (el) => el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  const ownText = (el) =>
    [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
  const findLabel = (root, text) => [root, ...root.querySelectorAll('*')].find((el) => ownText(el) === text);

  // Visible elements whose own text passes `test`, in document order. Never our own controls.
  const findAll = (test) => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      if (node.nodeValue.length > 80) continue; // labels are short; skips script/JSON blobs
      const el = node.parentElement;
      if (el && test(node.nodeValue.trim()) && !el.closest('[data-gdq]') && visible(el)) found.push(el);
    }
    return found;
  };

  const findQualityItem = () => findAll((t) => t === 'Quality')[0];

  const findOption = (quality, qualityItem) => {
    // The Quality row may show the current value ("720p") itself, so ignore matches inside it.
    const row = qualityItem.closest('[role^=menuitem], [role=option], li');
    const pick = (test) => findAll(test).filter((el) => !row?.contains(el)).at(-1);
    return pick((t) => t === quality) ?? pick((t) => t.startsWith(quality));
  };

  // Resolves the moment `find()` returns something, re-checking (at most once per frame)
  // whenever the DOM changes. `giveUp` lets a caller stop waiting early.
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
        observer.disconnect();
        resolve(value);
      };
      const check = () => {
        frame = 0;
        const el = find();
        if (el || giveUp?.()) done(el);
      };
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded'],
      });
      check();
    });

  // ---- clicking things --------------------------------------------------------------
  // Full hover -> down -> up -> click sequence at the element's centre, aimed at whatever
  // is actually on top there (a wrapper's inner button, say).
  const press = (el) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const hit = document.elementFromPoint(x, y);
    const target = hit && el.contains(hit) ? hit : el;
    const fire = (Type, type, init) =>
      target.dispatchEvent(
        new Type(type, {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          ...init,
        })
      );
    fire(PointerEvent, 'pointerover'); fire(MouseEvent, 'mouseover');
    fire(PointerEvent, 'pointermove'); fire(MouseEvent, 'mousemove');
    fire(PointerEvent, 'pointerdown', { buttons: 1 }); fire(MouseEvent, 'mousedown', { buttons: 1 });
    fire(PointerEvent, 'pointerup'); fire(MouseEvent, 'mouseup');
    fire(MouseEvent, 'click', { detail: 1 });
  };

  let busy = false;
  // `fromRow` is our control row inside Drive's file menu (when pressed from there).
  const setQuality = async (quality, fromRow) => {
    if (busy || !quality) return;
    busy = true;
    try {
      let item = findQualityItem(); // the player's settings menu may already be open
      for (let attempt = 0; !item && attempt < 4; attempt++) {
        const gears = [...document.querySelectorAll('[aria-label="Settings"]')];
        const gear = gears.find(visible) ?? gears[0];
        if (!gear) return;
        const fileMenuOpen = fromRow && visible(fromRow);
        press(gear);
        // While the file menu is open, the press is spent closing it. Stop waiting as soon as
        // that menu is gone...
        item = await waitFor(findQualityItem, {
          ms: 500,
          giveUp: fileMenuOpen ? () => !visible(fromRow) : undefined,
        });
        // ...but let Drive settle before pressing again: a press made while the menu is still
        // closing is swallowed, and one made just after the player menu opened would shut it.
        if (!item) item = await waitFor(findQualityItem, { ms: 150 });
      }
      if (!item) return;

      press(item);
      const option = await waitFor(() => findOption(quality, item));
      if (option) press(option);
    } finally {
      busy = false;
    }
  };

  // ---- our rows ---------------------------------------------------------------------
  const STRIP = /^(id|role|tabindex|js.*|data-.*|aria-.*)$/;
  let played = false; // a video has played at least once this session
  let chosen = ''; // the resolution picked in the dropdown; survives the menu being rebuilt

  // A native-looking, inert copy of the Share row with different text.
  const makeLabelRow = (template, text, enabled) => {
    const row = template.cloneNode(true);
    for (const el of [row, ...row.querySelectorAll('*')]) {
      for (const { name } of [...el.attributes]) if (STRIP.test(name)) el.removeAttribute(name);
    }
    const label = findLabel(row, 'Share');
    label.textContent = text;
    for (const el of row.querySelectorAll('*')) {
      el.style.pointerEvents = 'none'; // the row itself is always the click target
      if (!el.contains(label) && !label.contains(el)) el.style.visibility = 'hidden';
    }
    row.style.pointerEvents = 'auto';
    row.style.cursor = 'default';
    if (!enabled) row.style.opacity = '.5';
    row.setAttribute('data-gdq', '');
    // An icon in the slot Share's icon uses (align() puts it in the right place).
    const icon = svg(HD, 24);
    Object.assign(icon.style, {
      position: 'absolute', top: '50%', transform: 'translateY(-50%)', left: '16px',
      pointerEvents: 'none', color: getComputedStyle(findLabel(template, 'Share')).color,
    });
    row.style.position = 'relative';
    row.append(icon);
    row._gdqIcon = icon;
    return row;
  };

  // A row of our own. Its indent is set by align() once it is in the page.
  const makeBlock = (item, shareLabel) => {
    const style = getComputedStyle(shareLabel);
    const block = document.createElement('div');
    block.setAttribute('data-gdq', '');
    Object.assign(block.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '2px 16px 8px 56px', color: style.color, fontFamily: style.fontFamily,
      fontSize: '13px', cursor: 'default',
    });
    return block;
  };

  const makeCaption = (item, shareLabel) => {
    const caption = makeBlock(item, shareLabel);
    caption.textContent = 'Play video first';
    Object.assign(caption.style, { fontSize: '11px', opacity: '.6', paddingTop: '0' });
    return caption;
  };

  // The dropdown + "Set" button, styled as a pill dropdown with a custom list and an outlined
  // pill button (a native <select> can't be restyled). The list lives on <body> so the
  // menu can't clip it. Built with DOM calls only (no innerHTML: Drive enforces Trusted Types).
  const svg = (d, size) => {
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size);
    el.setAttribute('height', size);
    el.setAttribute('fill', 'currentColor');
    el.style.flex = 'none';
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    el.append(path);
    return el;
  };
  const CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
  const HD = 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM6.5 9H8v2h2V9h1.5v6H10v-2.5H8V15H6.5V9zM13 9v6h2.5c.83 0 1.5-.67 1.5-1.5v-3c0-.83-.67-1.5-1.5-1.5H13zm1.5 1.5H15.5v3H14.5v-3z';
  const CHEVRON = 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z';

  let popup = null; // the open resolution list: { el, trigger, chevron, move(), choose() }
  const closePopup = () => {
    if (!popup) return;
    popup.el.remove();
    popup.chevron.style.transform = '';
    popup = null;
  };
  const hover = (el, on, off) => {
    el.addEventListener('mouseenter', () => Object.assign(el.style, on));
    el.addEventListener('mouseleave', () => Object.assign(el.style, off));
  };
  // Click targets carry their handler; the window-level click listener below runs it.
  const action = (el, fn) => {
    el.setAttribute('data-gdq-action', '');
    el._gdqAction = fn;
  };

  const makeControlRow = (item, shareLabel, labels) => {
    const row = makeBlock(item, shareLabel);
    row.style.alignItems = 'center';
    const [r, g, b] = row.style.color.match(/[\d.]+/g).map(Number);
    const dark = r + g + b > 382; // light text => dark menu
    // dark values are sampled from the reference screenshots
    const theme = dark
      ? { fill: '#3c4043', hover: '#44474a', border: '#54575a', borderHover: '#65676a',
          list: '#3c4043', item: '#4b4f52' }
      : { fill: '#f1f3f4', hover: '#e8eaed', border: '#dadce0', borderHover: '#bdc1c6',
          list: '#fff', item: '#f1f3f4' };

    let value = labels.includes(chosen) ? chosen : labels[0];

    // pill dropdown button
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    const text = document.createElement('span');
    text.textContent = value;
    const chevron = svg(CHEVRON, 20);
    chevron.style.transition = 'transform .15s';
    trigger.append(text, chevron);
    Object.assign(trigger.style, {
      flex: '1 1 0', minWidth: '84px', maxWidth: '120px', height: '32px', padding: '0 8px 0 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
      font: 'inherit', fontSize: '14px', fontWeight: '500', color: 'inherit',
      boxSizing: 'border-box', background: theme.fill, border: `1px solid ${theme.border}`,
      borderRadius: '16px', cursor: 'pointer',
    });
    const rest = { background: theme.fill, borderColor: theme.border };
    const lit = { background: theme.hover, borderColor: theme.borderHover };
    hover(trigger, lit, rest);

    const pick = (label) => {
      value = chosen = label;
      text.textContent = label;
      closePopup();
    };

    const openList = () => {
      closePopup();
      const box = trigger.getBoundingClientRect();
      const list = document.createElement('div');
      list.setAttribute('data-gdq', '');
      list.setAttribute('role', 'listbox');
      Object.assign(list.style, {
        position: 'fixed', zIndex: '2147483647', boxSizing: 'border-box',
        minWidth: `${Math.max(box.width, 120)}px`, padding: '6px 0', borderRadius: '12px',
        background: theme.list, border: `1px solid ${theme.border}`, color: row.style.color,
        fontFamily: row.style.fontFamily, fontSize: '14px',
      });

      let index = labels.indexOf(value);
      let active = false; // an item is highlighted (hover or arrow keys)
      const options = labels.map((label, i) => {
        const opt = document.createElement('div');
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', String(label === value));
        const t = document.createElement('span');
        t.textContent = label;
        opt.append(t);
        if (label === value) opt.append(svg(CHECK, 18));
        Object.assign(opt.style, {
          height: '40px', padding: '0 16px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: '16px', cursor: 'pointer',
          fontWeight: label === value ? '700' : '400',
        });
        action(opt, () => pick(label));
        opt.addEventListener('mouseenter', () => { index = i; active = true; paint(); });
        opt.addEventListener('mouseleave', () => { active = false; paint(); });
        return opt;
      });
      const paint = () =>
        options.forEach((o, i) => (o.style.background = active && i === index ? theme.item : 'transparent'));
      list.append(...options);

      document.body.append(list);
      const below = box.bottom + 4;
      const height = list.offsetHeight;
      list.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - list.offsetWidth - 8))}px`;
      list.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, box.top - 4 - height) : below}px`;
      chevron.style.transform = 'rotate(180deg)';

      popup = {
        el: list, trigger, chevron,
        move(delta) { index = (index + delta + labels.length) % labels.length; active = true; paint(); },
        choose() { pick(labels[index]); },
      };
    };
    action(trigger, () => (popup?.trigger === trigger ? closePopup() : openList()));

    // outlined pill button
    const set = document.createElement('button');
    set.type = 'button';
    const setText = document.createElement('span');
    setText.textContent = 'Set';
    set.append(svg(CHECK, 18), setText);
    Object.assign(set.style, {
      flex: 'none', height: '32px', padding: '0 14px 0 10px', display: 'flex', alignItems: 'center',
      gap: '6px', font: 'inherit', fontSize: '14px', fontWeight: '500', color: 'inherit',
      boxSizing: 'border-box', background: theme.fill, border: `1px solid ${theme.border}`,
      borderRadius: '16px', cursor: 'pointer',
    });
    hover(set, lit, rest);
    action(set, () => setQuality(value, row));

    row.append(trigger, set);
    return row;
  };

  // Lines our rows up with Share: text under its label, icon where its icon is. Measured on
  // screen after insertion (the menu may be inset, or mid-animation under a scale transform).
  const align = (item, shareLabel, labelRow, blocks) => {
    if (!labelRow.isConnected) return;
    const box = item.getBoundingClientRect();
    if (!box.width) return; // menu not laid out yet; a later pass will do it
    const scale = (item.offsetWidth ? box.width / item.offsetWidth : 1) || 1;
    const range = document.createRange();
    range.selectNodeContents(shareLabel);
    const textLeft = range.getBoundingClientRect().left;
    for (const block of blocks) {
      const dx = (textLeft - block.getBoundingClientRect().left) / scale;
      if (dx >= 8 && dx <= 160) block.style.paddingLeft = `${dx}px`;
    }
    const icon = labelRow._gdqIcon;
    const glyph = [...item.querySelectorAll('svg, img')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 12 && r.right <= textLeft + 1;
    });
    if (icon && glyph) {
      const g = glyph.getBoundingClientRect();
      const size = Math.round(Math.min(g.width / scale, 24));
      icon.setAttribute('width', size);
      icon.setAttribute('height', size);
      icon.style.left = `${(g.left - labelRow.getBoundingClientRect().left) / scale}px`;
    }
  };

  const sync = () => {
    if (popup && !popup.trigger.isConnected) closePopup();
    if (!/\/d\//.test(location.pathname)) return;
    const labels = window.__gdq.labels().map((p) => `${p}p`);
    const unlocked = played && labels.length > 0;
    const key = `${unlocked}${labels.join()}`;
    for (const item of document.querySelectorAll('[role=menuitem]')) {
      const shareLabel = findLabel(item, 'Share');
      if (!shareLabel) continue;
      if (item.nextElementSibling?.getAttribute('data-gdq-key') === key) continue;
      while (item.nextElementSibling?.matches('[data-gdq]')) item.nextElementSibling.remove();
      const rows = unlocked
        ? [makeLabelRow(item, 'Quality', true), makeControlRow(item, shareLabel, labels)]
        : [makeLabelRow(item, 'Quality', false), makeCaption(item, shareLabel)];
      rows.forEach((row) => row.setAttribute('data-gdq-key', key));
      item.after(...rows);
      const place = () => align(item, shareLabel, rows[0], rows.slice(1));
      place();
      setTimeout(place, 300); // again once the menu has finished animating
    }
  };

  // ---- events -----------------------------------------------------------------------
  // Drive's menu closes or swallows events it doesn't recognise (focus moves, outside presses,
  // arrow keys). So events on our rows are handled in the capture phase on window, before any
  // Drive listener sees them. Our controls run their own handlers from the click listener below
  // (and the open list handles its own keys), so nothing needs to reach Drive.
  const inRow = (n) => (n instanceof Element ? n.closest('[data-gdq]') : null);
  const rowOf = (e) => inRow(e.target);

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    window.addEventListener(
      type,
      (e) => {
        if (type === 'pointerdown' && popup && !popup.el.contains(e.target) && !popup.trigger.contains(e.target)) {
          closePopup();
        }
        if (!rowOf(e)) return;
        e.stopImmediatePropagation();
        if (type === 'mousedown') e.preventDefault(); // keep focus where it is
      },
      true
    );
  }
  window.addEventListener(
    'keydown',
    (e) => {
      if (!popup) return;
      if (e.key === 'Escape') closePopup();
      else if (e.key === 'ArrowDown') popup.move(1);
      else if (e.key === 'ArrowUp') popup.move(-1);
      else if (e.key === 'Enter' || e.key === ' ') popup.choose();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let Escape/arrows reach Drive's menu
    },
    true
  );
  window.addEventListener('resize', () => closePopup());
  window.addEventListener('scroll', () => closePopup(), true);
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (rowOf(e) && e.key !== 'Escape') e.stopImmediatePropagation();
      },
      true
    );
  }
  for (const type of ['focusin', 'focusout', 'focus', 'blur']) {
    window.addEventListener(
      type,
      (e) => {
        if (inRow(e.target) || inRow(e.relatedTarget)) e.stopImmediatePropagation();
      },
      true
    );
  }
  window.addEventListener(
    'click',
    (e) => {
      const row = rowOf(e);
      if (!row) return;
      e.stopImmediatePropagation();
      e.target.closest('[data-gdq-action]')?._gdqAction?.();
    },
    true
  );

  let queued = 0;
  const schedule = () => {
    queued ||= requestAnimationFrame(() => {
      queued = 0;
      sync();
    });
  };
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  window.addEventListener('gdq:playback', schedule);
  window.addEventListener('message', (e) => { // sent by playback.js, which runs inside the player's frame
    if (e.data?.type !== 'GDQ:VIDEO_PLAYED') return;
    played = true;
    schedule();
  });
})();
