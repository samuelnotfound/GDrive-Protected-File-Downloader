// Frame-aware Settings -> Quality discovery and verified option activation.

function trustedV24InspectQualityOptionTargets() {
    const roots = () => {
        const out = [], seen = new Set(), queue = [document];
        while (queue.length) {
            const root = queue.shift();
            if (!root || seen.has(root)) continue;
            seen.add(root); out.push(root);
            try {
                if (root.querySelectorAll) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) queue.push(el.shadowRoot);
            } catch (_) {}
        }
        return out;
    };
    const visible = el => {
        try {
            if (!el || el.closest?.('#psd-video-quality-picker')) return false;
            const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
            return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
        } catch (_) { return false; }
    };
    const labelOf = el => [
        el?.getAttribute?.('aria-label') || '',
        el?.getAttribute?.('title') || '',
        el?.getAttribute?.('data-tooltip') || '',
        el?.textContent || ''
    ].filter(Boolean).map(v => String(v).replace(/\s+/g,' ').trim()).join(' ').trim();
    const rectOf = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
    const isClickable = el => {
        const tag = String(el?.tagName || '').toLowerCase();
        const role = el?.getAttribute?.('role') || '';
        let cursor = '';
        try { cursor = getComputedStyle(el).cursor; } catch (_) {}
        return tag === 'button' || role === 'menuitemradio' || role === 'menuitem' || role === 'option' || role === 'button' || el?.tabIndex >= 0 || cursor === 'pointer';
    };
    const qre = /^\s*(\d{3,4})p(?:\s|$|\()/i;
    const candidates = [];
    for (const root of roots()) {
        try {
            for (const el of root.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"],[tabindex]')) {
                if (!visible(el) || !isClickable(el)) continue;
                const text = labelOf(el);
                const m = text.match(qre);
                if (!m) continue;
                const height = Number(m[1]);
                const role = el.getAttribute('role') || '';
                const r = rectOf(el);
                const area = r.width * r.height;
                const exact = new RegExp('^\\s*' + height + 'p(?:\\s*.*)?\\s*$', 'i').test(text);
                const score = (exact ? 80 : 0) + (/menuitemradio|menuitem|option|button/i.test(role) ? 40 : 0) + (el.tagName === 'BUTTON' ? 20 : 0) - Math.min(area / 10000, 20);
                candidates.push({ el, height, label: `${height}p`, text, role, rect: r, score,
                    selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' });
            }
        } catch (_) {}
    }
    const byHeight = new Map();
    for (const c of candidates.sort((a,b) => b.score - a.score)) if (!byHeight.has(c.height)) byHeight.set(c.height, c);
    return {
        ok: byHeight.size > 0,
        options: [...byHeight.values()].sort((a,b) => b.height - a.height).map(({el, ...rest}) => rest),
        original: [...byHeight.values()].find(x => x.selected) || null
    };
}

async function trustedV24ClickRectAttached(tabId, rect) {
    if (!rect) return { ok:false, reason:'Missing click rectangle.' };
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
    await sleep(90);
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
    await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
    return { ok:true, x, y };
}

async function trustedV24OpenSettingsAttached(tabId) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const target = await trustedV24ExecuteInTopFrame(tabId, trustedV24DiscoverDriveSettingsTarget);
        if (target?.ok && target.settings?.rect) {
            if (target.hoverPoint) {
                await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x:target.hoverPoint.x, y:target.hoverPoint.y, button:'none' });
                await sleep(220);
            }
            const clicked = await trustedV24ClickRectAttached(tabId, target.settings.rect);
            if (!clicked.ok) return clicked;
            await sleep(380);
            const menu = await trustedV24WaitForQualityMenu(tabId, 2200);
            if (menu) return { ok:true, target, menu };
        }
        await sleep(220);
    }
    return { ok:false, reason:'Drive player Settings control was not detected.' };
}

async function trustedV24OpenQualityAttached(tabId) {
    const settings = await trustedV24OpenSettingsAttached(tabId);
    if (!settings?.ok) return settings;
    let menu = settings.menu;
    if (!menu?.qualityTarget?.ok) menu = await trustedV24WaitForQualityMenu(tabId, 3500);
    if (!menu?.qualityTarget?.ok) return { ok:false, reason:'Drive Settings opened, but Quality was not found.' };
    const clicked = await trustedV24ClickRectAttached(tabId, menu.qualityTarget.rect);
    if (!clicked.ok) return clicked;
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 4000) {
        const options = await trustedV24ExecuteInTopFrame(tabId, trustedV24InspectQualityOptionTargets);
        last = options;
        if (options?.options?.length) return { ok:true, options, settings, menu };
        await sleep(140);
    }
    return { ok:false, reason:'Quality submenu opened but no concrete resolution options were detected.', settings, menu, options:last };
}

function chooseProbeCandidate(candidates, height = 0, label = '') {
    const list = Array.isArray(candidates) ? candidates.filter(x => x?.url) : [];
    if (!list.length) return null;
    const h = Number(height || 0);
    const matching = h ? list.filter(x => Number(x.height || 0) === h) : [];
    const source = matching.length ? matching : list;
    return source.slice().sort((a,b) => (b.contentLength-a.contentLength) || (b.capturedAt-a.capturedAt))[0] || null;
}

async function backgroundProbeCapturedFormat(format, expectedFileId) {
    if (!format?.originalUrl && !format?.url) return { ok:false, reason:'No signed URL.' };
    const url = format.originalUrl || format.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(url, {
            method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow',
            referrer: 'https://drive.google.com/',
            headers: { Range:'bytes=0-0', Accept:'*/*' }, signal: controller.signal
        });
        const type = String(response.headers.get('content-type') || '').toLowerCase();
        const range = String(response.headers.get('content-range') || '');
        const m = range.match(/\/([0-9]+)/);
        const total = m ? Number(m[1]) : 0;
        return { ok: [200,206].includes(response.status), status: response.status, contentType:type, totalBytes:Number.isFinite(total)?total:0 };
    } catch (error) {
        // Do not reject a stream that Drive itself already requested successfully.
        return { ok:false, reason:String(error?.message || error) };
    } finally { clearTimeout(timer); }
}

async function trustedV24ExecuteAllFrames(tabId, func, args = []) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func,
            args
        });
        return Array.isArray(results) ? results : [];
    } catch (_) {
        return [];
    }
}

async function trustedV24FindAndOpenQualityInAnyFrame(tabId, preferredFrameId = null) {
    const finder = async function() {
        const sleepLocal = ms => new Promise(r => setTimeout(r, ms));
        const roots = () => {
            const out = [], seen = new Set(), q = [document];
            while (q.length) {
                const root = q.shift();
                if (!root || seen.has(root)) continue;
                seen.add(root); out.push(root);
                try {
                    if (root.querySelectorAll) {
                        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) q.push(el.shadowRoot);
                    }
                } catch (_) {}
            }
            return out;
        };
        const visible = el => {
            try {
                const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
                return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
            } catch (_) { return false; }
        };
        const isOurUi = el => !!el?.closest?.('#psd-video-quality-picker');
        const label = el => [el?.getAttribute?.('aria-label') || '', el?.getAttribute?.('data-tooltip') || '', el?.getAttribute?.('title') || '', el?.textContent || '']
            .join(' ').replace(/\s+/g, ' ').trim();
        const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
        const clickable = el => {
            if (!visible(el) || isOurUi(el)) return false;
            const tag = String(el.tagName || '').toLowerCase();
            const role = String(el.getAttribute?.('role') || '').toLowerCase();
            let cursor = '';
            try { cursor = getComputedStyle(el).cursor; } catch (_) {}
            return tag === 'button' || tag === 'a' || role === 'button' || role === 'menuitem' || role === 'menuitemradio' || role === 'option' || el.tabIndex >= 0 || cursor === 'pointer';
        };
        const all = sel => {
            const out=[];
            for (const root of roots()) try { out.push(...root.querySelectorAll(sel)); } catch (_) {}
            return [...new Set(out)];
        };
        const player = (() => {
            const candidates = all('video').filter(v => visible(v) && !isOurUi(v));
            if (!candidates.length) return null;
            return candidates.sort((a,b) => {
                const ap = !a.paused && !a.ended ? 1 : 0, bp = !b.paused && !b.ended ? 1 : 0;
                if (ap !== bp) return bp-ap;
                const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
                return (br.width*br.height)-(ar.width*ar.height);
            })[0];
        })();
        if (!player) return { ok:false, stage:'no-video', error:'No visible Drive video element in this frame.' };

        // Make Drive reveal its control bar. This is intentionally done before
        // searching for Settings so hidden controls do not cause a false miss.
        try {
            player.scrollIntoView?.({block:'center', inline:'center'});
            player.focus?.();
            const r = player.getBoundingClientRect();
            const init = { bubbles:true, cancelable:true, view:window, clientX:r.left+r.width/2, clientY:r.top+r.height/2 };
            for (const type of ['pointermove','mousemove','mouseover','mouseenter']) {
                try { player.dispatchEvent(new MouseEvent(type, init)); } catch (_) {}
            }
        } catch (_) {}
        await sleepLocal(180);

        function findSettings() {
            const nodes = all('button,[role="button"],[role="menuitem"],[tabindex],[title],[data-tooltip],[aria-label]')
                .filter(clickable);
            const labelled = nodes.filter(el => /\bsettings\b/i.test(label(el)));
            if (labelled.length) {
                const pr = player.getBoundingClientRect();
                labelled.sort((a,b) => {
                    const dist = el => { const r=el.getBoundingClientRect(); return Math.hypot((r.left+r.width/2)-(pr.right-40), (r.top+r.height/2)-(pr.bottom-40)); };
                    return dist(a)-dist(b);
                });
                return labelled[0];
            }

            // V24 geometry fallback: find a compact control cluster near the
            // lower part of the actual video player. Drive's modern player keeps
            // Settings between the other right-side controls even when its label
            // is not exposed in the accessible DOM.
            const pr = player.getBoundingClientRect();
            const controls = nodes.map(el => ({el,r:el.getBoundingClientRect()}))
                .filter(x => x.r.bottom >= pr.bottom-100 && x.r.top <= pr.bottom+10 && x.r.right <= pr.right+30 && x.r.left >= pr.left-30);
            controls.sort((a,b) => a.r.left-b.r.left);
            for (let i=0;i<controls.length;i++) {
                const cluster = controls.slice(Math.max(0,i-5), Math.min(controls.length,i+6));
                if (cluster.length < 3) continue;
                const candidate = cluster[cluster.length-2]?.el || cluster[cluster.length-1]?.el;
                if (candidate && clickable(candidate)) return candidate;
            }
            return null;
        }

        const safeClick = el => {
            if (!el) return false;
            try { el.scrollIntoView?.({block:'center',inline:'center'}); } catch (_) {}
            try { el.focus?.({preventScroll:true}); } catch (_) {}
            try { HTMLElement.prototype.click.call(el); return true; } catch (_) {}
            try {
                for (const type of ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click']) {
                    el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
                }
                return true;
            } catch (_) { return false; }
        };

        function qualityTrigger() {
            const nodes = all('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[tabindex]')
                .filter(clickable);
            const qs = nodes.filter(el => {
                const t = label(el);
                const role = String(el.getAttribute?.('role')||'').toLowerCase();
                const inMenu = !!el.closest?.('[role="menu"],[role="listbox"],.goog-menu,[data-menu-root]');
                return /(^|\s)quality(?:\s*[>›]|$)/i.test(t) && (inMenu || ['menuitem','menuitemradio','option','button'].includes(role));
            });
            return qs[0] || null;
        }

        function qualityOptions() {
            const nodes = all('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[tabindex]')
                .filter(clickable);
            const found = new Map();
            for (const el of nodes) {
                const t = label(el);
                const m = t.match(/(?:^|\s)(\d{3,4})p(?:\b|$)/i);
                if (!m) continue;
                const h = Number(m[1]);
                if (!h) continue;
                const role = String(el.getAttribute?.('role')||'').toLowerCase();
                const inMenu = !!el.closest?.('[role="menu"],[role="listbox"],.goog-menu,[data-menu-root]');
                if (!inMenu && !['menuitem','menuitemradio','option','button'].includes(role) && el.getAttribute('tabindex') == null) continue;
                const r = rect(el);
                const current = found.get(h);
                if (!current || (t.length < current.text.length)) found.set(h,{height:h,text:t,rect:r,selected:el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-selected')==='true'});
            }
            return [...found.values()].sort((a,b)=>b.height-a.height);
        }

        let settings = findSettings();
        if (!settings) {
            // One more hover/reveal pass, then re-scan.
            try { player.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,clientX:player.getBoundingClientRect().right-40,clientY:player.getBoundingClientRect().bottom-40})); } catch (_) {}
            await sleepLocal(260);
            settings = findSettings();
        }
        if (!settings) return {ok:false, stage:'settings-not-found', playerRect:rect(player)};

        const settingsLabel = label(settings);
        const clickedSettings = safeClick(settings);
        await sleepLocal(420);

        let q = qualityOptions();
        if (!q.length) {
            let trigger = qualityTrigger();
            if (!trigger) {
                // Sometimes Settings opens but the Quality row appears a moment later.
                await sleepLocal(300);
                trigger = qualityTrigger();
            }
            if (trigger) {
                safeClick(trigger);
                await sleepLocal(420);
                q = qualityOptions();
            }
        }

        return {
            ok: clickedSettings && q.length > 0,
            stage: q.length ? 'quality-open' : 'settings-open-quality-not-found',
            settingsLabel,
            qualityOptions:q,
            playerRect:rect(player),
            diagnostics:{settingsFound:true,settingsClicked:clickedSettings,qualityCount:q.length}
        };
    };

    const execute = async (frameIds) => {
        const target = frameIds?.length ? {tabId, frameIds} : {tabId, allFrames:true};
        return chrome.scripting.executeScript({target,world:'MAIN',func:finder});
    };

    // First try the current preferred frame when one exists, then all frames.
    if (preferredFrameId !== null && preferredFrameId !== undefined) {
        try {
            const one = await execute([Number(preferredFrameId)]);
            const hit = one?.find?.(x => x?.result?.ok || x?.result?.stage === 'settings-open-quality-not-found');
            if (hit?.result) return { frameId:Number(hit.frameId), ...hit.result };
        } catch (_) {}
    }
    try {
        const results = await execute(null);
        const ranked = (results||[]).map(r=>({frameId:Number(r.frameId),...(r.result||{})}))
            .filter(x=>x.stage==='quality-open' || x.stage==='settings-open-quality-not-found')
            .sort((a,b)=>(b.qualityOptions?.length||0)-(a.qualityOptions?.length||0));
        return ranked[0] || {ok:false,stage:'no-frame-opened'};
    } catch (error) {
        return {ok:false,stage:'execute-error',error:error?.message||String(error)};
    }
}

async function trustedV24FindQualityOptionInFrame(tabId, frameId, height) {
    const finder = function(heightArg) {
        const roots = () => {
            const out = [], seen = new Set(), q = [document];
            while (q.length) {
                const r = q.shift(); if (!r || seen.has(r)) continue;
                seen.add(r); out.push(r);
                try { if (r.querySelectorAll) for (const el of r.querySelectorAll('*')) if (el.shadowRoot) q.push(el.shadowRoot); } catch (_) {}
            }
            return out;
        };
        const visible = el => {
            try {
                const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            } catch (_) { return false; }
        };
        const our = el => !!el?.closest?.('#psd-video-quality-picker');
        const label = el => [el?.getAttribute?.('aria-label') || '', el?.getAttribute?.('title') || '', el?.getAttribute?.('data-tooltip') || '', el?.textContent || '']
            .join(' ').replace(/\s+/g, ' ').trim();
        const items = [];
        for (const root of roots()) {
            try {
                for (const el of root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[tabindex]')) {
                    if (our(el) || !visible(el)) continue;
                    const t = label(el);
                    const m = t.match(/(?:^|\s)(\d{3,4})p(?:\b|$)/i);
                    if (!m || Number(m[1]) !== Number(heightArg)) continue;
                    const r = el.getBoundingClientRect();
                    const role = String(el.getAttribute('role') || '').toLowerCase();
                    const inMenu = !!el.closest?.('[role="menu"],[role="listbox"],.goog-menu,[data-menu-root]');
                    if (!inMenu && !['menuitem','menuitemradio','option','button'].includes(role) && el.getAttribute('tabindex') == null) continue;
                    items.push({
                        label: t,
                        rect: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
                        selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
                    });
                }
            } catch (_) {}
        }
        items.sort((a, b) => (a.label.length - b.label.length) || (Number(b.selected) - Number(a.selected)));
        const item = items[0];
        if (!item) return { ok: false, reason: `${heightArg}p option not found in frame.` };
        return { ok: true, ...item };
    };
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [Number(frameId)] }, world: 'MAIN', func: finder, args: [Number(height)]
        });
        return res?.[0]?.result || { ok: false, reason: 'No quality option result.' };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
}

async function trustedV24GetFrameTree(tabId) {
    try {
        const result = await trustedV24Cdp(tabId, 'Page.getFrameTree', {});
        const map = new Map();
        const walk = (node, parentFrameId = -1) => {
            const id = String(node?.frame?.id || '');
            if (!id) return;
            map.set(id, { parentFrameId, url: String(node?.frame?.url || '') });
            for (const child of (node.childFrames || [])) walk(child, id);
        };
        if (result?.frameTree) walk(result.frameTree, -1);
        return map;
    } catch (_) { return new Map(); }
}

async function trustedV24GetFrameOffsetInMainViewport(tabId, frameId) {
    const targetId = String(frameId);
    if (targetId === '0' || targetId === '') return { ok: true, x: 0, y: 0 };
    const tree = await trustedV24GetFrameTree(tabId);
    let current = targetId;
    let offsetX = 0, offsetY = 0;
    const seen = new Set();
    try {
        await trustedV24Cdp(tabId, 'DOM.enable', {});
        while (current && current !== '0' && !seen.has(current)) {
            seen.add(current);
            const owner = await trustedV24Cdp(tabId, 'DOM.getFrameOwner', { frameId: current });
            const backendNodeId = owner?.backendNodeId;
            if (!backendNodeId) return { ok: false, reason: `Could not resolve frame owner for frame ${current}.` };
            const box = await trustedV24Cdp(tabId, 'DOM.getBoxModel', { backendNodeId });
            const quad = box?.model?.border || box?.model?.content;
            if (!quad || quad.length < 8) return { ok: false, reason: `Could not resolve frame box for frame ${current}.` };
            // CDP DOM boxes are expressed in the parent/main-page viewport for this target.
            offsetX += Number(quad[0]) || 0;
            offsetY += Number(quad[1]) || 0;
            const parent = tree.get(current)?.parentFrameId;
            if (parent == null || Number(parent) < 0) break;
            current = String(parent);
        }
        return { ok: true, x: offsetX, y: offsetY };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
}

async function trustedV24ResumePlaybackAfterQuality(tabId) {
    try {
        const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:()=>{
            const videos=[...document.querySelectorAll('video')];
            for(const v of videos){
                try{ v.muted=true; v.defaultMuted=true; v.volume=0; if(v.paused){ const p=v.play(); if(p?.catch) p.catch(()=>{}); } }catch(_){}
            }
            return videos.some(v=>!v.paused&&!v.ended);
        }});
        return (results||[]).some(r=>r?.result===true);
    } catch (_) { return false; }
}


async function trustedV24GetQualityOptionsWithFrames(tabId) {
    const finder = function() {
        const roots=()=>{const out=[],seen=new Set(),q=[document];while(q.length){const r=q.shift();if(!r||seen.has(r))continue;seen.add(r);out.push(r);try{if(r.querySelectorAll)for(const el of r.querySelectorAll('*'))if(el.shadowRoot)q.push(el.shadowRoot)}catch(_){}}return out;};
        const visible=el=>{try{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'}catch(_){return false;}};
        const label=el=>[el?.getAttribute?.('aria-label')||'',el?.getAttribute?.('title')||'',el?.getAttribute?.('data-tooltip')||'',el?.textContent||''].join(' ').replace(/\s+/g,' ').trim();
        const our=el=>!!el?.closest?.('#psd-video-quality-picker');
        const items=[]; const seen=new Set();
        for(const root of roots()){
            try{for(const el of root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[tabindex]')){
                if(our(el)||!visible(el)||seen.has(el)) continue;
                const t=label(el); const hs=new Set(); { const re=/(?:^|\s)(\d{3,4})p(?:\b|$)/gi; let mm; while((mm=re.exec(t))) hs.add(Number(mm[1])); }
                // A menu row names exactly ONE quality. A wrapper/menu that lists 1080p 720p 360p
                // also "starts with" the first one and used to be returned as that quality's row.
                if(hs.size!==1) continue;
                const h=[...hs][0]; if(!h) continue;
                const role=String(el.getAttribute?.('role')||'').toLowerCase();
                const inMenu=!!el.closest?.('[role="menu"],[role="listbox"],.goog-menu,[data-menu-root]');
                if(!inMenu && !['menuitem','menuitemradio','option','button'].includes(role) && el.getAttribute('tabindex')==null) continue;
                seen.add(el); const r=el.getBoundingClientRect();
                items.push({height:h,text:t,selected:el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-selected')==='true',role,rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}});
            }}catch(_){ }
        }
        const byHeight=new Map();
        for(const item of items){const prev=byHeight.get(item.height);if(!prev||item.selected||(!prev.selected&&item.text.length<prev.text.length))byHeight.set(item.height,item);}
        return [...byHeight.values()].sort((a,b)=>b.height-a.height);
    };
    try {
        // The V24 path opens the player menu in the top document. Prefer it before
        // considering any child frame so we cannot pick a duplicate/stale row.
        try{
            const top=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:finder});
            const opts=top?.[0]?.result||[];
            if(opts.length){
                let cdpFrameId=''; try{const tree=await trustedV24Cdp(tabId,'Page.getFrameTree',{});cdpFrameId=String(tree?.frameTree?.frame?.id||'');}catch(_){ }
                return opts.map(o=>({...o,frameId:0,cdpFrameId}));
            }
        }catch(_){ }

        // Child-frame fallback. Keep the webNavigation frame id and its separate
        // CDP Page.FrameId side by side; they are different id namespaces.
        const frames=await trustedV24GetFrames(tabId); const tree=await trustedV24GetFrameTree(tabId);
        const cdpNodes=[]; const walk=(node,parentId=null)=>{const f=node?.frame;if(!f?.id)return;cdpNodes.push({id:String(f.id),parentId:parentId?String(parentId):null,url:String(f.url||'')});for(const c of node.childFrames||[])walk(c,f.id);};
        if(tree?.frameTree)walk(tree.frameTree,null);
        const norm=u=>String(u||'').split('#')[0]; const used=new Set(); const map=new Map();
        const rootCdp=String(tree?.frameTree?.frame?.id||''); if(rootCdp){map.set(0,rootCdp);used.add(rootCdp);}
        const pending=(frames||[]).filter(f=>Number(f.frameId)!==0).map(f=>({...f})); let progressed=true;
        while(pending.length&&progressed){progressed=false;for(let i=pending.length-1;i>=0;i--){const f=pending[i];const parent=map.get(Number(f.parentFrameId));let c=cdpNodes.filter(n=>!used.has(n.id)&&n.parentId===parent);if(f.url)c=c.filter(n=>norm(n.url)===norm(f.url));const pick=c[0]||null;if(pick){map.set(Number(f.frameId),pick.id);used.add(pick.id);pending.splice(i,1);progressed=true;}}}
        const out=[];
        for(const f of frames||[]){if(Number(f.frameId)===0)continue;try{const r=await chrome.scripting.executeScript({target:{tabId,frameIds:[Number(f.frameId)]},world:'MAIN',func:finder});for(const item of (r?.[0]?.result||[]))out.push({...item,frameId:Number(f.frameId),cdpFrameId:map.get(Number(f.frameId))||'',frameUrl:f.url||''});}catch(_){}}
        const best=new Map(); for(const item of out){const prev=best.get(item.height);if(!prev||item.selected||(!prev.selected&&item.text.length<prev.text.length))best.set(item.height,item);} return [...best.values()].sort((a,b)=>b.height-a.height);
    }catch(_){return[];}
}

async function trustedV24GetQualityOptionForHeight(tabId,height){const options=await trustedV24GetQualityOptionsWithFrames(tabId);return options.find(x=>Number(x.height)===Number(height))||null;}

async function trustedV24GetMainViewportOffsetForCdpFrame(tabId,cdpFrameId){
    const target=String(cdpFrameId||''); if(!target)return{ok:false,reason:'Missing CDP frame id.'};
    try{
        const tree=await trustedV24Cdp(tabId,'Page.getFrameTree',{});const frameMap=new Map();
        const walk=(node,parentId=null)=>{const f=node?.frame;if(!f?.id)return;frameMap.set(String(f.id),{parentId:parentId?String(parentId):null});for(const c of node.childFrames||[])walk(c,f.id);};
        if(tree?.frameTree)walk(tree.frameTree,null); let current=target,offsetX=0,offsetY=0;const seen=new Set();await trustedV24Cdp(tabId,'DOM.enable',{});
        while(current&&!seen.has(current)&&frameMap.has(current)){seen.add(current);const parent=frameMap.get(current)?.parentId;if(!parent)break;const owner=await trustedV24Cdp(tabId,'DOM.getFrameOwner',{frameId:current});const backend=owner?.backendNodeId;if(!backend)return{ok:false,reason:`Could not resolve frame owner for ${current}.`};const box=await trustedV24Cdp(tabId,'DOM.getBoxModel',{backendNodeId:backend});const quad=box?.model?.border||box?.model?.padding||box?.model?.content;if(!quad||quad.length<8)return{ok:false,reason:`Could not resolve frame box for ${current}.`};offsetX+=Number(quad[0])||0;offsetY+=Number(quad[1])||0;current=String(parent);}return{ok:true,x:offsetX,y:offsetY};
    }catch(error){return{ok:false,reason:error?.message||String(error)};}
}

// ===== v1.81: reliable Quality-row activation =====================================
//
// History: the pointer path highlighted a row without committing it, so it was replaced
// by keyboard/Arrow navigation. Two real defects were behind that, and both are fixed here:
//
//  1. The pointer click never hid the page blocker. Every other trusted click (Settings gear,
//     Quality row) is wrapped in setVideoAutomationBlocker(false/true) so the click reaches
//     Drive instead of our own full-page veil; the option-row click was not, so the click was
//     swallowed by the veil while row.focus() made it *look* selected.
//  2. The keyboard path picked "the largest element whose text matches N p". The menu wrapper
//     starts with the first row's text ("1080p 720p 360p"), so for the FIRST/highest row it
//     focused the wrapper, and Enter on a wrapper does nothing.
//
// Activation is now a verified ladder: trusted mouse click -> keyboard Enter -> DOM events.
// A step only counts if the Quality submenu actually closes afterwards, and the next rung is
// tried only when it did not, so a successful click is never repeated.

// Runs INSIDE the Drive page (MAIN world, a single frame). Must stay self-contained.
function trustedV24QualityRowPageAction(heightArg, action) {
    const H = Number(heightArg);
    const ROW_SEL = 'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[tabindex]';
    const CLICKABLE = '[role="menuitemradio"],[role="menuitem"],[role="option"],[role="button"],button';
    const OWN_UI = '#psd-video-quality-picker,#psd-video-scan-blocker,#psd-video-page-blocker,#psd-inpage-overlay';

    const roots = [], seenRoots = new Set(), queue = [document];
    while (queue.length) {
        const r = queue.shift();
        if (!r || seenRoots.has(r)) continue;
        seenRoots.add(r); roots.push(r);
        try { for (const el of r.querySelectorAll('*')) if (el.shadowRoot) queue.push(el.shadowRoot); } catch (_) {}
    }
    const visible = el => {
        try {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        } catch (_) { return false; }
    };
    const labelOf = el => [el.getAttribute('aria-label') || '', el.getAttribute('title') || '',
        el.getAttribute('data-tooltip') || '', el.textContent || ''].join(' ').replace(/\s+/g, ' ').trim();
    const heightsOf = text => {
        const set = new Set(); const re = /(?:^|\s)(\d{3,4})p(?:\b|$)/gi; let m;
        while ((m = re.exec(text))) set.add(Number(m[1]));
        return set;
    };
    const rankOf = el => {
        const role = String(el.getAttribute('role') || '').toLowerCase();
        return role === 'menuitemradio' ? 0 : role === 'menuitem' ? 1 : role === 'option' ? 2
            : (role === 'button' || el.tagName === 'BUTTON') ? 3 : 4;
    };
    const rows = () => {
        const out = [], seen = new Set();
        for (const root of roots) {
            try {
                for (const el of root.querySelectorAll(ROW_SEL)) {
                    if (seen.has(el) || !visible(el) || el.closest(OWN_UI)) continue;
                    seen.add(el);
                    const hs = heightsOf(labelOf(el));
                    if (hs.size !== 1) continue;            // a row names exactly one quality; wrappers name several
                    const r = el.getBoundingClientRect();
                    out.push({
                        el, h: [...hs][0], rank: rankOf(el), area: r.width * r.height,
                        checked: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
                    });
                }
            } catch (_) {}
        }
        return out;
    };
    const pick = () => {
        const list = rows().filter(r => r.h === H);
        const usable = list.filter(r => r.area >= 16 * 10);
        const pool = usable.length ? usable : list;
        pool.sort((a, b) => a.rank - b.rank || a.area - b.area);
        return pool[0] || null;
    };
    const hitTest = (el, x, y) => {
        try {
            const root = el.getRootNode?.();
            const doc = (root && root.elementFromPoint) ? root : document;
            const hit = doc.elementFromPoint(x, y);
            return !!hit && (hit === el || el.contains(hit) || hit.closest?.(CLICKABLE) === el);
        } catch (_) { return false; }
    };

    if (action === 'state') {
        const all = rows();
        return { heights: [...new Set(all.map(r => r.h))].sort((a, b) => b - a), checked: all.filter(r => r.checked).map(r => r.h) };
    }

    const target = pick();
    if (!target) return { found: false };
    const el = target.el;

    if (action === 'locate') {
        try { el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
        const r = el.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        const pts = [
            { x: r.left + r.width / 2, y: cy },
            { x: r.left + Math.min(32, r.width / 2), y: cy },
            { x: r.right - Math.min(32, r.width / 2), y: cy }
        ];
        const good = pts.find(p => hitTest(el, p.x, p.y));
        const p = good || pts[0];
        let hitLabel = '';
        try {
            const root = el.getRootNode?.(); const doc = (root && root.elementFromPoint) ? root : document;
            const hit = doc.elementFromPoint(p.x, p.y);
            hitLabel = hit ? `${hit.tagName}:${String(hit.id || hit.getAttribute?.('role') || '')}`.slice(0, 60) : '';
        } catch (_) {}
        return { found: true, x: p.x, y: p.y, hitOk: !!good, hit: hitLabel, role: el.getAttribute('role') || el.tagName, checked: target.checked };
    }

    if (action === 'focus') {
        try { el.focus({ preventScroll: true }); } catch (_) {}
        const rootNode = el.getRootNode?.();
        const active = (rootNode && rootNode.activeElement) || document.activeElement;
        return { found: true, focused: active === el || el.contains(active) };
    }

    if (action === 'domclick') {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
        const fire = (type, Ctor, extra) => { try { el.dispatchEvent(new Ctor(type, { ...base, ...extra })); } catch (_) {} };
        const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
        fire('pointerover', PointerEvent, { ...ptr, buttons: 0 });
        fire('mouseover', MouseEvent, { buttons: 0 });
        fire('pointerdown', PointerEvent, { ...ptr, buttons: 1 });
        fire('mousedown', MouseEvent, { buttons: 1 });
        fire('pointerup', PointerEvent, { ...ptr, buttons: 0 });
        fire('mouseup', MouseEvent, { buttons: 0 });
        fire('click', MouseEvent, { buttons: 0 });
        return { found: true, dispatched: true };
    }
    return { found: false, reason: `unknown action ${action}` };
}

async function trustedV24RunQualityPageAction(tabId, frameId, height, action) {
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [Number(frameId) || 0] }, world: 'MAIN',
            func: trustedV24QualityRowPageAction, args: [Number(height), String(action)]
        });
        return res?.[0]?.result || null;
    } catch (_) { return null; }
}

async function trustedV24WaitQualityMenuClosed(tabId, timeoutMs = 900) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    do {
        last = await trustedV24GetQualityOptionsWithFrames(tabId);
        if (!last.length) return { closed: true };
        await sleep(80);
    } while (Date.now() < deadline);
    return { closed: false, stillListed: last.map(o => Number(o.height)) };
}

async function trustedV24ClickQualityRowWithMouse(tabId, target, height) {
    const frameId = Number(target.frameId) || 0;
    let offset = { ok: true, x: 0, y: 0 };
    if (frameId !== 0) {
        offset = await trustedV24GetMainViewportOffsetForCdpFrame(tabId, target.cdpFrameId);
        if (!offset.ok) return { ok: false, reason: offset.reason || 'Could not resolve the player frame offset.' };
    }
    await trustedV24AttachDebugger(tabId);
    // Same treatment as the proven Settings / Quality-row clicks: let the pointer reach Drive.
    await setVideoAutomationBlocker(tabId, false);
    try {
        let loc = await trustedV24RunQualityPageAction(tabId, frameId, height, 'locate');
        if (!loc?.found) return { ok: false, reason: `${height}p row not found in frame ${frameId}.` };
        let x = loc.x + (offset.x || 0), y = loc.y + (offset.y || 0);
        await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await sleep(45);
        // Drive re-renders rows on hover. Re-measure so press/release land on the live row,
        // otherwise mousedown and mouseup hit different nodes and no click is generated.
        const again = await trustedV24RunQualityPageAction(tabId, frameId, height, 'locate');
        if (again?.found) { loc = again; x = again.x + (offset.x || 0); y = again.y + (offset.y || 0); }
        await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(30);
        await trustedV24Cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        return { ok: true, x, y, hitOk: !!loc.hitOk, hit: loc.hit || '' };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    } finally {
        await setVideoAutomationBlocker(tabId, true);
    }
}

async function trustedV24ActivateQualityRowByKeyboard(tabId, target, height) {
    const frameId = Number(target.frameId) || 0;
    try {
        await trustedV24AttachDebugger(tabId);
        const focus = await trustedV24RunQualityPageAction(tabId, frameId, height, 'focus');
        if (!focus?.found) return { ok: false, reason: `${height}p row not found for keyboard activation.` };
        await sleep(30);
        await trustedV24Cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await trustedV24Cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        return { ok: true, focused: !!focus.focused };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
}

async function trustedV24ActivateQualityByMenuNavigation(tabId, targetHeight, freshOptions = [], opts = {}) {
    const height = Number(targetHeight);
    const waitMenuMs = Number(opts?.waitMenuMs) > 0 ? Number(opts.waitMenuMs) : 900;
    const immediateSuccess = opts?.immediateSuccess === true;
    let options = await trustedV24GetQualityOptionsWithFrames(tabId);
    if (!options.length) options = Array.isArray(freshOptions) ? freshOptions : [];
    const target = options.find(x => Number(x.height) === height);
    if (!target) return { ok: false, reason: `${height}p is not in the live Quality menu.`, attempts: [] };

    const attempts = [];
    const rungs = [
        ['mouse', () => trustedV24ClickQualityRowWithMouse(tabId, target, height)],
        ['keyboard', () => trustedV24ActivateQualityRowByKeyboard(tabId, target, height)],
        ['dom-events', async () => {
            const r = await trustedV24RunQualityPageAction(tabId, Number(target.frameId) || 0, height, 'domclick');
            return r?.dispatched ? { ok: true } : { ok: false, reason: 'row not found for DOM activation.' };
        }]
    ];
    for (const [method, run] of rungs) {
        let result;
        try { result = await run(); } catch (error) { result = { ok: false, reason: error?.message || String(error) }; }
        const entry = { method, ...result };
        attempts.push(entry);
        if (!result?.ok) continue;
        // On the final quality, the click itself is the last debugger-dependent action.
        // Skip the menu-close poll so the caller can release chrome.debugger immediately.
        if (immediateSuccess) return { ok: true, method, height, attempts };
        const wait = await trustedV24WaitQualityMenuClosed(tabId, method === 'mouse' ? waitMenuMs : Math.min(waitMenuMs, 220));
        entry.menuClosed = wait.closed;
        if (wait.closed) return { ok: true, method, height, attempts };
    }
    return {
        ok: false, height, attempts,
        reason: `${height}p was not activated: the Quality menu stayed open after ${attempts.map(a => a.method).join(', ')}.`
    };
}

// State-aware opener. The scan loop used to click the Settings gear unconditionally; if the
// Quality submenu was already open (always true for the FIRST option, right after the initial
// open, and true after any failed activation) that click CLOSED the menu, the Quality row could
// not be found, and the option was skipped without ever being clicked.
async function trustedV24OpenQualitySubmenu(tabId, menuWaitMs = 2500) {
    let options = await trustedV24GetQualityOptionsWithFrames(tabId);
    if (new Set(options.map(o => Number(o.height))).size >= 2) return { ok: true, options, path: 'already-open' };

    let settings = null, menu = null;
    for (let i = 0; i < 2; i++) {
        settings = await trustedV24OpenDrivePlayerSettings(tabId);
        if (!settings?.ok) { await sleep(FAST_SCAN.retrySettleMs); continue; }
        menu = settings.afterSettings || null;
        if (!menu?.qualityTarget?.ok) menu = await trustedV24WaitForQualityMenu(tabId, menuWaitMs);
        if (menu?.qualityTarget?.ok) break;
        // A gear click that found Settings already open closes it; the next pass reopens it.
    }
    if (!settings?.ok) return { ok: false, reason: 'The Drive Settings button could not be clicked.', settings };
    if (!menu?.qualityTarget?.ok) return { ok: false, reason: 'Settings opened, but the Quality row was not found.', settings, menu };

    const opened = await trustedV24ClickQualityViaCDP(tabId, menu.qualityTarget);
    if (!opened?.ok) return { ok: false, reason: 'The Quality row click failed.', settings, menu, opened };
    await sleep(FAST_SCAN.optionSettleMs);
    options = await trustedV24GetQualityOptionsWithFrames(tabId);
    if (!options.length) { await sleep(FAST_SCAN.optionSettleMs * 2); options = await trustedV24GetQualityOptionsWithFrames(tabId); }
    if (!options.length) return { ok: false, reason: 'Quality submenu opened, but no resolution options were found.', settings, menu, opened };
    return { ok: true, options, settings, menu, opened, path: 'settings-click' };
}


async function trustedV24GetCurrentPlaybackHeight(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: () => {
                const roots=[]; const seen=new Set(); const q=[document];
                while(q.length){const root=q.shift(); if(!root||seen.has(root)) continue; seen.add(root); roots.push(root); try{for(const el of root.querySelectorAll('*')) if(el.shadowRoot) q.push(el.shadowRoot);}catch(_){} }
                const vals=[];
                for(const root of roots){
                    try{for(const v of root.querySelectorAll('video')){
                        const s=getComputedStyle(v),r=v.getBoundingClientRect();
                        if(r.width<=2||r.height<=2||s.display==='none'||s.visibility==='hidden'||s.opacity==='0') continue;
                        if(v.ended) continue;
                        const h=Number(v.videoHeight||0);
                        if(h>0) vals.push({h,playing:!v.paused,ready:Number(v.readyState||0),area:r.width*r.height});
                    }}catch(_){}
                }
                vals.sort((a,b)=>(Number(b.playing)-Number(a.playing))||(b.ready-a.ready)||(b.area-a.area));
                return vals[0]?.h || 0;
            }
        });
        for(const r of (results||[])){ const h=Number(r?.result||0); if(h>0) return h; }
    } catch (_) {}
    return 0;
}

async function trustedV24DetectExistingPlayback(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: () => {
                const roots=[]; const walk=root=>{ try { roots.push(root); for(const el of root.querySelectorAll?.('*')||[]) if(el.shadowRoot) walk(el.shadowRoot); } catch(_){} };
                walk(document);
                const videos=[];
                for(const root of roots) try { videos.push(...root.querySelectorAll('video')); } catch(_){}
                return [...new Set(videos)].some(v=>{ try { const r=v.getBoundingClientRect(),s=getComputedStyle(v); return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&!v.paused&&!v.ended; } catch(_){ return false; } });
            }
        });
        return (results||[]).some(r=>r?.result===true);
    } catch (_) { return false; }
}
