// Trusted Drive player/menu automation. No new capabilities added.


function cleanURL(url) {
    if (!url) return null;
    const value = String(url);
    const rangeIndex = value.search(/[?&]range=/i);
    return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
}

// ===== Restored V24 trusted Drive player click path =====
function trustedV24GetFrames(tabId) {
  return new Promise(resolve => {
    chrome.webNavigation.getAllFrames({ tabId }, frames => resolve(frames || []));
  });
}

function trustedV24SendToFrame(tabId, frameId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, response => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

async function trustedV24RunAutoplay(tabId, frames = []) {
  // The confirmed V24 path is attempted first. Drive can create the player iframe
  // after getAllFrames() returns, so we rescan frames and retry once more after boot.
  const ids = new Set();
  const candidates = [];
  for (const frame of frames) { if (frame && !ids.has(frame.frameId)) { ids.add(frame.frameId); candidates.push(frame); } }
  for (const frame of candidates) {
    const response = await trustedV24SendToFrame(tabId, frame.frameId, { type: 'PSD_RUN_V24_AUTOPLAY' });
    if (response?.ok && response.result?.playback?.playbackDetected) {
      return { frameId: frame.frameId, url: frame.url, ...response.result.playback };
    }
  }
  await sleep(650);
  const lateFrames = await trustedV24GetFrames(tabId);
  for (const frame of lateFrames) {
    if (ids.has(frame.frameId)) continue;
    ids.add(frame.frameId);
    const response = await trustedV24SendToFrame(tabId, frame.frameId, { type: 'PSD_RUN_V24_AUTOPLAY' });
    if (response?.ok && response.result?.playback?.playbackDetected) {
      return { frameId: frame.frameId, url: frame.url, ...response.result.playback };
    }
  }
  return null;
}

async function trustedV24ForceAutoplayViaInjectedScript(tabId) {
  // Directly run the same core V24 autoplay logic in every frame instead of
  // relying solely on an already-installed content-script listener. This fixes
  // cases where the Drive media iframe appears after document_idle or where the
  // player is hosted in a frame that was not ready when the message was sent.
  const func = async function() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const roots = () => {
      const out = [], seen = new Set(), queue = [document];
      while (queue.length) {
        const root = queue.shift();
        if (!root || seen.has(root)) continue;
        seen.add(root); out.push(root);
        try {
          if (root.querySelectorAll) {
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) queue.push(el.shadowRoot);
          }
        } catch (_) {}
      }
      return out;
    };
    const all = (selector) => {
      const out = [];
      for (const root of roots()) {
        try { out.push(...root.querySelectorAll(selector)); } catch (_) {}
      }
      return [...new Set(out)];
    };
    const visible = el => {
      try {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      } catch (_) { return false; }
    };
    const mute = v => { try { v.muted = true; v.defaultMuted = true; v.volume = 0; v.setAttribute('muted',''); } catch (_) {} };
    const label = el => [el?.getAttribute?.('aria-label') || '', el?.getAttribute?.('data-tooltip') || '', el?.getAttribute?.('title') || '', el?.textContent || ''].join(' ').replace(/\s+/g,' ').trim();
    const absoluteRect = el => {
      let x = 0, y = 0;
      let win = window;
      try {
        while (win && win !== win.top) {
          const fe = win.frameElement;
          if (!fe) break;
          const r = fe.getBoundingClientRect();
          x += r.left;
          y += r.top;
          win = fe.ownerDocument.defaultView;
        }
        const r = el.getBoundingClientRect();
        return { x: x + r.left, y: y + r.top, width:r.width, height:r.height };
      } catch (_) { return null; }
    };
    const videos = all('video').filter(visible);
    const ordered = [...videos].sort((a,b) => {
      const ap = (!a.paused && !a.ended) ? 1 : 0, bp = (!b.paused && !b.ended) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      try { const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect(); return (br.width*br.height)-(ar.width*ar.height); } catch (_) { return 0; }
    });
    for (const v of videos) mute(v);
    for (const v of ordered) {
      try {
        const before = Number(v.currentTime || 0);
        const promise = v.play();
        if (promise?.then) await promise.catch(()=>{});
        await sleep(250);
        mute(v);
        if (!v.paused && !v.ended) {
          return { playing:true, method:'injected video.play()', before, after:Number(v.currentTime || 0), videoRect:absoluteRect(v) };
        }
      } catch (_) {}
    }
    // Find the Drive player's visible Play control as the fallback target. We
    // return its absolute coordinates so the service worker can generate a
    // trusted CDP mouse click rather than an untrusted DOM .click().
    const buttons = all('button,[role="button"],[tabindex]').filter(visible);
    const scored = buttons.map(el => ({ el, text:label(el), r:el.getBoundingClientRect() })).filter(x => /(^|\b)(play|play video|start playback)(\b|$)/i.test(x.text));
    const best = scored.sort((a,b) => (b.r.width*b.r.height)-(a.r.width*a.r.height))[0];
    if (best) return { playing:false, method:'play-button-target', playRect:absoluteRect(best), label:best.text };
    const anyPlaying = videos.find(v => !v.paused && !v.ended);
    if (anyPlaying) return { playing:true, method:'existing playing video', videoRect:absoluteRect(anyPlaying) };
    return { playing:false, method:'no-player-or-play-control', videoCount:videos.length };
  };
  try {
    const results = await chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func });
    const outputs = (results || []).map(r => r?.result).filter(Boolean);
    const playing = outputs.find(r => r.playing);
    if (playing) return { ...playing, success:true };
    const playTarget = outputs.find(r => r.playRect);
    if (playTarget) return { ...playTarget, success:false, needsTrustedClick:true };
    return outputs[0] || { success:false, method:'no-injected-autoplay-result' };
  } catch (error) {
    return { success:false, method:'injected-autoplay-error', error:error?.message || String(error) };
  }
}

async function trustedV24ClickPlayWithDebugger(tabId, playRect) {
  if (!playRect) return { ok:false, reason:'No trusted Play target was found.' };
  const x = Number(playRect.x) + Number(playRect.width || 0) / 2;
  const y = Number(playRect.y) + Number(playRect.height || 0) / 2;
  try {
    await trustedV24AttachDebugger(tabId);
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
    await sleep(20);
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
    await sleep(140);
    return { ok:true, x, y };
  } catch (error) {
    return { ok:false, reason:error?.message || String(error) };
  }
}

async function trustedV24VerifyPlayback(tabId, timeoutMs = 2500) {
  const func = () => {
    const roots = () => {
      const out=[], seen=new Set(), q=[document];
      while(q.length){ const r=q.shift(); if(!r||seen.has(r))continue; seen.add(r); out.push(r); try{ if(r.querySelectorAll) for(const el of r.querySelectorAll('*')) if(el.shadowRoot) q.push(el.shadowRoot);}catch(_){} }
      return out;
    };
    const videos=[];
    for(const root of roots()) try{ videos.push(...root.querySelectorAll('video')); }catch(_){}
    const unique=[...new Set(videos)];
    const playing=unique.find(v=>{try{return !v.paused&&!v.ended&&(v.currentTime>0||v.readyState>=2)}catch(_){return false}});
    return playing ? {playing:true,currentTime:Number(playing.currentTime||0),readyState:Number(playing.readyState||0),width:Number(playing.videoWidth||0),height:Number(playing.videoHeight||0)} : {playing:false};
  };
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    try{
      const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func});
      const found=(results||[]).map(r=>r?.result).find(r=>r?.playing);
      if(found) return found;
    }catch(_){ }
    await sleep(120);
  }
  return {playing:false};
}

async function trustedV24ExecuteInTopFrame(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func,
    args
  });
  return result?.[0]?.result || null;
}

async function trustedV24AttachDebugger(tabId) {
  const existing = DEBUGGER_NETWORK_TABS.get(Number(tabId));
  if (existing?.attached) return { alreadyAttached:true, networkEnabled:!!existing.networkEnabled };
  await chrome.debugger.attach({ tabId }, '1.3');
  DEBUGGER_NETWORK_TABS.set(Number(tabId), {
    attached:true,
    networkEnabled:false,
    runtimeEnabled:false,
    qualityScanKeepAttached:false,
    activeProbe:null,
    probeBuffer:[],
    recentStreams:[],
    qualityContexts:new Map(),
    seenNetworkEvents:new Set()
  });
  try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
      const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
      if (state) { state.networkEnabled = true; state.runtimeEnabled = true; }
  } catch (error) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      DEBUGGER_NETWORK_TABS.delete(Number(tabId));
      throw error;
  }
  return { attached:true, networkEnabled:true };
}

async function trustedV24DetachDebugger(tabId, force = false) {
  const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
  // During a quality scan we normally stay attached between Drive menu actions.
  // Terminal cleanup paths pass force=true so an early return/error can never
  // leave Chrome's "started debugging" banner attached indefinitely.
  if (state?.qualityScanKeepAttached && !force) return { keptAttached:true };
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  DEBUGGER_NETWORK_TABS.delete(Number(tabId));
  return { detached:true };
}

async function trustedV24Cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function setVideoAutomationBlocker(tabId, visible) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'videoAutomationBlocker', visible: !!visible });
  } catch (_) {}
}

// Runs in the Drive page's MAIN world. The function deliberately avoids
// aria-label, SVG-path matching, YouTube-specific selectors, and quality logic.
// It finds the modern Drive player control row from geometry and button ordering.
function trustedV24DiscoverDriveSettingsTarget() {
  const sleepLocal = ms => new Promise(r => setTimeout(r, ms));

  const roots = () => {
    const out = [], seen = new Set(), queue = [document];
    while (queue.length) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      out.push(root);
      try {
        if (root.querySelectorAll) {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) queue.push(el.shadowRoot);
          }
        }
      } catch (_) {}
    }
    return out;
  };

  const visible = el => {
    try {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 2 && r.height >= 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (_) { return false; }
  };

  const rect = el => {
    try { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; }
    catch (_) { return null; }
  };

  const all = selector => {
    const out = [];
    for (const root of roots()) {
      try { out.push(...root.querySelectorAll(selector)); } catch (_) {}
    }
    return [...new Set(out)];
  };

  const isClickable = el => {
    if (!visible(el)) return false;
    try {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const tab = el.getAttribute('tabindex');
      const type = el.getAttribute('type') || '';
      const cursor = getComputedStyle(el).cursor;
      return tag === 'button' || tag === 'a' || role === 'button' || role === 'menuitem' || role === 'option' || tab !== null || cursor === 'pointer' || type === 'button';
    } catch (_) { return false; }
  };

  const label = el => [
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('data-tooltip') || '',
    el.getAttribute?.('title') || '',
    el.textContent || ''
  ].join(' ').replace(/\s+/g, ' ').trim();

  // Media anchors: prefer the actual video, then the largest visible iframe.
  const mediaAnchors = [];
  for (const v of all('video')) {
    if (visible(v)) mediaAnchors.push({ el:v, kind:'video', r:rect(v) });
  }
  for (const f of all('iframe')) {
    if (visible(f)) mediaAnchors.push({ el:f, kind:'iframe', r:rect(f) });
  }
  mediaAnchors.sort((a,b) => ((b.r?.width||0)*(b.r?.height||0)) - ((a.r?.width||0)*(a.r?.height||0)));

  const candidates = all('button,[role="button"],a,[tabindex],[type="button"]').filter(isClickable).map(el => ({ el, r:rect(el), text:label(el) }));

  function within(r, box, margin = 16) {
    const cx = r.x + r.width/2, cy = r.y + r.height/2;
    return cx >= box.x - margin && cx <= box.right + margin && cy >= box.y - margin && cy <= box.bottom + margin;
  }

  function buildClusters(list) {
    const sorted = [...list].sort((a,b) => (a.r.y + a.r.height/2) - (b.r.y + b.r.height/2));
    const clusters = [];
    for (const item of sorted) {
      const cy = item.r.y + item.r.height/2;
      let cluster = clusters.find(c => Math.abs(c.cy - cy) <= Math.max(18, Math.min(36, item.r.height * 0.75)));
      if (!cluster) {
        cluster = { cy, items: [] };
        clusters.push(cluster);
      }
      cluster.items.push(item);
      cluster.cy = cluster.items.reduce((s,x) => s + x.r.y + x.r.height/2, 0) / cluster.items.length;
    }
    return clusters.filter(c => c.items.length >= 3);
  }

  function scoreCluster(cluster, anchor) {
    const xs = cluster.items.map(x => x.r.x + x.r.width/2);
    const ys = cluster.items.map(x => x.r.y + x.r.height/2);
    const maxX = Math.max(...xs), minX = Math.min(...xs);
    const span = maxX - minX;
    let score = cluster.items.length * 10;
    if (anchor?.r) {
      const nearBottom = Math.abs((anchor.r.bottom - 34) - cluster.cy);
      score += Math.max(0, 120 - nearBottom);
      const centerX = anchor.r.x + anchor.r.width/2;
      if (maxX <= anchor.r.right + 30 && minX >= anchor.r.x - 30) score += 60;
      if (Math.abs((minX + maxX)/2 - centerX) < anchor.r.width * 0.25) score += 20;
      if (span > anchor.r.width * 0.2 && span < anchor.r.width * 0.95) score += 20;
    }
    return score;
  }

  let anchor = mediaAnchors[0] || null;
  const clusters = buildClusters(candidates.map(x => x));
  clusters.sort((a,b) => scoreCluster(b, anchor) - scoreCluster(a, anchor));

  let best = clusters[0] || null;
  if (anchor && best) {
    const filtered = clusters.filter(c => c.items.some(x => within(x.r, anchor.r, 28)));
    if (filtered.length) {
      filtered.sort((a,b) => scoreCluster(b, anchor) - scoreCluster(a, anchor));
      best = filtered[0];
    }
  }

  // Fallback: detect the modern right-side player group by its characteristic
  // ordering: playback-speed button -> Settings -> fullscreen.
  if (best) {
    best.items.sort((a,b) => a.r.x - b.r.x);
    const speedIndex = best.items.findIndex(x => /^\s*(?:0\.?\d+|1(?:\.\d+)?|2(?:\.\d+)?)x\s*$/i.test(x.text));
    const rightmostIndex = best.items.length - 1;

    let fullscreenIndex = best.items.findIndex(x => /full.?screen/i.test(x.text));
    if (fullscreenIndex < 0 && rightmostIndex >= 0) fullscreenIndex = rightmostIndex;

    let settingsIndex = -1;
    if (fullscreenIndex > 0) {
      const beforeFullscreen = best.items.slice(0, fullscreenIndex);
      if (speedIndex >= 0) {
        const afterSpeed = beforeFullscreen.filter((_, i) => i > speedIndex);
        if (afterSpeed.length) {
          const target = afterSpeed[afterSpeed.length - 1];
          settingsIndex = best.items.indexOf(target);
        }
      }
      if (settingsIndex < 0 && beforeFullscreen.length) settingsIndex = beforeFullscreen.length - 1;
    }

    if (settingsIndex >= 0) {
      const settings = best.items[settingsIndex];
      const hover = anchor?.r ? { x: anchor.r.x + anchor.r.width/2, y: anchor.r.y + anchor.r.height/2 } : {
        x: settings.r.x + settings.r.width/2,
        y: settings.r.y + settings.r.height/2
      };
      return {
        ok: true,
        frameUrl: location.href,
        anchor: anchor ? { kind: anchor.kind, rect: anchor.r } : null,
        cluster: best.items.map(x => ({ text:x.text, rect:x.r, tag:x.el.tagName, cls:String(x.el.className || '').slice(0,180) })),
        settings: { rect:settings.r, text:settings.text, tag:settings.el.tagName, cls:String(settings.el.className || '').slice(0,180) },
        speedIndex,
        fullscreenIndex,
        settingsIndex,
        hoverPoint: hover,
        buttonCount: candidates.length,
        note: 'Drive parent-player control row; no Quality detection.'
      };
    }
  }

  return {
    ok:false,
    frameUrl:location.href,
    anchor: anchor ? { kind: anchor.kind, rect: anchor.r } : null,
    buttonCount:candidates.length,
    clusters:clusters.map(c => c.items.map(x => ({ text:x.text, rect:x.r, tag:x.el.tagName }))).slice(0,8),
    note:'Could not isolate the modern Drive player control row.'
  };
}

function trustedV24ClickElementInMainWorld(el) {
  try {
    el.focus?.({ preventScroll:true });
    el.click?.();
    return { clicked:true, tag:el.tagName, text:(el.textContent||'').trim() };
  } catch (e) {
    return { clicked:false, error:String(e) };
  }
}

function clickAtCoordinates(x, y) {
  return { x, y };
}

async function trustedV24WaitForQualityMenu(tabId, timeoutMs = FAST_SCAN.menuTimeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const state = await trustedV24ExecuteInTopFrame(tabId, trustedV24InspectDriveMenusForQuality);
    if (state) last = state;
    if (state?.qualityTarget?.ok) return state;
    await sleep(FAST_SCAN.menuPollMs);
  }
  return last || { ok:false, reason:'Timed out waiting for the Settings menu / Quality row.' };
}

function trustedV24InspectDriveMenusForQuality() {
  const roots = () => {
    const out = [], seen = new Set(), queue = [document];
    while (queue.length) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root); out.push(root);
      try {
        if (root.querySelectorAll) {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) queue.push(el.shadowRoot);
          }
        }
      } catch (_) {}
    }
    return out;
  };
  const visible = el => {
    try {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (_) { return false; }
  };
  const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const text = el => (el.textContent || '').replace(/\s+/g,' ').trim();
  const role = el => el.getAttribute?.('role') || '';

  const all = [];
  for (const root of roots()) {
    try {
      all.push(...root.querySelectorAll('body *'));
    } catch (_) {}
  }
  const unique = [...new Set(all)].filter(visible).filter(el => !el.closest?.('#psd-video-quality-picker'));

  // Identify overlay/menu-like containers from common semantics or fixed/absolute positioning.
  const menuContainers = unique.filter(el => {
    const r = role(el);
    const cls = String(el.className || '').toLowerCase();
    let pos = '';
    try { pos = getComputedStyle(el).position; } catch (_) {}
    return r === 'menu' || r === 'listbox' || r === 'dialog' || r === 'menuitem' ||
      /menu|popup|popover|tooltip|listbox|settings|quality/.test(cls) || pos === 'fixed' || pos === 'absolute';
  });

  // Prefer concise clickable-looking text nodes matching Quality.
  const qualityCandidates = unique.filter(el => {
    const t = text(el);
    if (!/^quality$/i.test(t) && !/\bquality\b/i.test(t)) return false;
    const r = role(el);
    const tag = (el.tagName || '').toLowerCase();
    let cursor = '';
    try { cursor = getComputedStyle(el).cursor; } catch (_) {}
    return t.length <= 80 && (tag === 'button' || r === 'menuitem' || r === 'button' || r === 'option' || el.tabIndex >= 0 || cursor === 'pointer');
  }).sort((a,b) => {
    const ta=text(a), tb=text(b);
    return (ta.toLowerCase() === 'quality' ? -1 : 0) - (tb.toLowerCase() === 'quality' ? -1 : 0);
  });

  // If the visible Quality text is on a non-clickable wrapper, climb to a clickable parent.
  let quality = qualityCandidates[0] || null;
  let qualityTarget = null;
  if (quality) {
    let cur = quality;
    for (let i=0; i<6 && cur; i++, cur=cur.parentElement) {
      if (!visible(cur)) continue;
      const tag=(cur.tagName||'').toLowerCase();
      const rr=role(cur);
      let cursor=''; try { cursor=getComputedStyle(cur).cursor; } catch (_) {}
      if (tag === 'button' || rr === 'button' || rr === 'menuitem' || rr === 'option' || cur.tabIndex >= 0 || cursor === 'pointer') {
        qualityTarget = cur; break;
      }
    }
    if (!qualityTarget) qualityTarget = quality;
  }

  // Gather likely quality option labels currently visible. Keep this conservative so
  // unrelated text like timestamps does not get reported.
  const optionEls = unique.filter(el => {
    const t = text(el);
    if (!t || t.length > 40) return false;
    if (!(/^(auto|[0-9]{3,4}p(?:\s*\(.*\))?|[0-9]{3,4}p\s*(?:HD|SD)?|[0-9]{3,4}p\s*\+?\s*HDR)$/i.test(t))) return false;
    const r = role(el), tag=(el.tagName||'').toLowerCase();
    let cursor=''; try { cursor=getComputedStyle(el).cursor; } catch (_) {}
    return tag === 'button' || r === 'menuitem' || r === 'option' || r === 'button' || el.tabIndex >= 0 || cursor === 'pointer';
  });

  // De-duplicate by label, retain screen order.
  const labels=[];
  const seen=new Set();
  optionEls.sort((a,b) => {
    const ra=rect(a), rb=rect(b);
    return ra.y-rb.y || ra.x-rb.x;
  });
  for (const el of optionEls) {
    const t=text(el);
    if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); labels.push(t); }
  }

  const visibleText = unique.map(el => text(el)).filter(t => t && t.length <= 120);
  return {
    ok: true,
    qualityTarget: qualityTarget ? {
      ok:true,
      text:text(qualityTarget),
      tag:qualityTarget.tagName,
      role:qualityTarget.getAttribute('role') || '',
      cls:String(qualityTarget.className || '').slice(0,180),
      rect:rect(qualityTarget)
    } : { ok:false },
    qualityOptions: labels,
    menuEvidence: menuContainers.slice(0,30).map(el => ({ role:role(el), text:text(el).slice(0,160), rect:rect(el), tag:el.tagName, cls:String(el.className||'').slice(0,120) })),
    visibleQualityLikeText: visibleText.filter(t => /quality|auto|\d{3,4}p/i.test(t)).slice(0,80)
  };
}

async function trustedV24ClickQualityViaCDP(tabId, qualityTarget) {
  if (!qualityTarget?.rect) return { ok:false, reason:'No Quality target rectangle.' };
  const r = qualityTarget.rect;
  const x = r.x + r.width/2, y = r.y + r.height/2;
  try {
    await trustedV24AttachDebugger(tabId);
    await setVideoAutomationBlocker(tabId, false);
    try {
      await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
      await sleep(FAST_SCAN.qualityHoverMs);
      await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
      await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
      await sleep(FAST_SCAN.qualityClickSettleMs);
    } finally {
      await setVideoAutomationBlocker(tabId, true);
    }
    return { ok:true, x, y, method:'trusted-trustedV24Cdp-quality-click' };
  } finally {
    const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
    if (!state?.qualityScanKeepAttached) await trustedV24DetachDebugger(tabId);
  }
}

async function trustedV24OpenDrivePlayerSettings(tabId) {
  // Keep the V16 Settings detection/click path that the user confirmed works.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const initial = await trustedV24ExecuteInTopFrame(tabId, trustedV24DiscoverDriveSettingsTarget);
    if (initial?.ok) {
      try {
        await trustedV24AttachDebugger(tabId);
        if (initial.hoverPoint) {
          await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x:initial.hoverPoint.x, y:initial.hoverPoint.y, button:'none' });
          await sleep(FAST_SCAN.settingsHoverMs);
        }
        const refreshed = await trustedV24ExecuteInTopFrame(tabId, trustedV24DiscoverDriveSettingsTarget);
        const target = refreshed?.ok ? refreshed : initial;
        const r = target.settings.rect;
        const x = r.x + r.width/2, y = r.y + r.height/2;
        await setVideoAutomationBlocker(tabId, false);
        try {
          await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
          await sleep(FAST_SCAN.settingsHoverMs);
          await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
          await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
          await sleep(FAST_SCAN.settingsClickSettleMs);
        } finally {
          await setVideoAutomationBlocker(tabId, true);
        }
        const heldState = DEBUGGER_NETWORK_TABS.get(Number(tabId));
        if (!heldState?.qualityScanKeepAttached) await trustedV24DetachDebugger(tabId);

        const afterSettings = await trustedV24WaitForQualityMenu(tabId, FAST_SCAN.menuTimeoutMs);
        // Quality may not be exposed until Settings is fully open. Return the current state;
        // caller will perform the Quality click and then re-inspect the resulting submenu.
        return { ok:true, method:'trusted-trustedV24Cdp-parent-drive-settings-click', attempts:attempt, target, afterSettings };
      } catch (e) {
        const heldState = DEBUGGER_NETWORK_TABS.get(Number(tabId));
        if (!heldState?.qualityScanKeepAttached) await trustedV24DetachDebugger(tabId);
        await sleep(FAST_SCAN.retrySettleMs);
      }
    }
    await sleep(FAST_SCAN.retrySettleMs);
  }
  return { ok:false, reason:'Modern Drive parent-player control row was not detected in the top frame.' };
}


// ===== Extended trusted quality-option targeting/probing =====

