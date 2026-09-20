// Legacy player quality detection retained for compatibility.

async function runAutomatedQualityScan(tabId, fileId) {
    const target = { tabId, allFrames: true };
    const locate = function() {
        const visible = el => {
            if (!el || !(el instanceof Element)) return false;
            const r = el.getBoundingClientRect?.();
            if (!r || r.width < 2 || r.height < 2) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const walk = (root, out = []) => {
            const nodes = root?.querySelectorAll ? [...root.querySelectorAll('*')] : [];
            for (const n of nodes) {
                out.push(n);
                if (n.shadowRoot) walk(n.shadowRoot, out);
            }
            return out;
        };
        const nodes = [document, ...walk(document)];
        const videos = nodes.filter(n => n?.tagName === 'VIDEO' && visible(n));
        const player = document.querySelector('section[aria-label*="Video Player" i], [role="dialog"] video') || videos[0] || null;
        if (!player) return { found: false };
        const root = document.querySelector('section[aria-label*="Video Player" i]') || player.parentElement || document.body;
        const rootNodes = [root, ...walk(root)];
        const settings = rootNodes.find(el => {
            if (!visible(el)) return false;
            if (!/^(button|div|span)$/.test(String(el.tagName || '').toLowerCase()) && !el.getAttribute('role')) return false;
            const label = [el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('data-tooltip')].filter(Boolean).join(' ');
            return /\bsettings\b/i.test(label);
        });
        return { found: true, hasSettings: !!settings, frameUrl: location.href };
    };

    // The Drive player and its controls can move between frames. Rather than
    // selecting a frame using a brittle Settings-label heuristic, execute the
    // real scan in every accessible frame and choose the successful player frame.

    const scanFunc = async (fileIdArg) => {
        const sleepLocal = ms => new Promise(r => setTimeout(r, ms));
        const visible = el => {
            if (!el || !(el instanceof Element)) return false;
            const r = el.getBoundingClientRect?.();
            if (!r || r.width < 2 || r.height < 2) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const walk = (root, out = []) => {
            const nodes = root?.querySelectorAll ? [...root.querySelectorAll('*')] : [];
            for (const n of nodes) {
                out.push(n);
                if (n.shadowRoot) walk(n.shadowRoot, out);
            }
            return out;
        };
        const all = () => [document, ...walk(document)];
        const labelOf = el => [el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('data-tooltip'), el?.textContent]
            .filter(Boolean).map(v => String(v).replace(/\s+/g, ' ').trim()).join(' ');
        const isOurUi = el => !!el?.closest?.('#psd-video-quality-picker');
        const getPlayer = () => {
            const sectionVideos = [];
            for (const section of document.querySelectorAll('section[aria-label*="Video Player" i], [role="dialog"][aria-label*="Showing viewer" i]')) {
                for (const el of section.querySelectorAll('video')) if (visible(el) && !isOurUi(el)) sectionVideos.push(el);
                for (const host of section.querySelectorAll('*')) {
                    if (host.shadowRoot) {
                        try { for (const el of host.shadowRoot.querySelectorAll('video')) if (visible(el) && !isOurUi(el)) sectionVideos.push(el); } catch (_) {}
                    }
                }
            }
            if (sectionVideos.length) return sectionVideos[0];
            const direct = [...document.querySelectorAll('[role="dialog"] video')].find(v => visible(v) && !isOurUi(v));
            if (direct) return direct;
            for (const el of all()) if (el?.tagName === 'VIDEO' && visible(el) && !isOurUi(el)) return el;
            return null;
        };
        const findPlayButton = player => {
            const roots = [];
            const section = player?.closest?.('section[aria-label*="Video Player" i], [role="dialog"]');
            if (section) roots.push(section);
            roots.push(player?.parentElement || document, document);
            const candidates = [];
            const collect = root => {
                try {
                    for (const el of root.querySelectorAll('[role="button"],button,[tabindex]')) {
                        if (isOurUi(el) || !visible(el)) continue;
                        const label = labelOf(el);
                        if (/^\s*(play|play video|play\/pause)\s*$/i.test(label)) candidates.push(el);
                    }
                    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot);
                } catch (_) {}
            };
            for (const root of roots) collect(root);
            return candidates[0] || null;
        };

        const clickLikeUser = el => {
            if (!el || isOurUi(el)) return false;
            try { el.scrollIntoView?.({block:'center', inline:'center'}); } catch (_) {}
            try { el.focus?.(); } catch (_) {}
            try { el.click(); return true; } catch (_) {}
            try {
                for (const type of ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click']) {
                    el.dispatchEvent(new MouseEvent(type, {bubbles:true,cancelable:true,view:window}));
                }
                return true;
            } catch (_) { return false; }
        };
        const qualityNumber = text => {
            const m = String(text || '').match(/(?:^|\s)(\d{3,4})p(?:\b|$)/i);
            return m ? Number(m[1]) : 0;
        };
        const isAuto = text => /^\s*auto(?:\s|$)/i.test(String(text || ''));
        const revealControls = player => {
            try { player.scrollIntoView?.({block:'center', inline:'center'}); } catch (_) {}
            try { player.focus?.(); } catch (_) {}
            const r = player.getBoundingClientRect?.();
            if (r) {
                const init = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2, view:window};
                for (const type of ['pointermove','mousemove','mouseover','mouseenter']) {
                    try { player.dispatchEvent(new MouseEvent(type, init)); } catch (_) {}
                }
                try { player.parentElement?.dispatchEvent(new MouseEvent('mousemove', init)); } catch (_) {}
            }
        };
        const playerRoot = () => {
            const section = [...document.querySelectorAll('section[aria-label*="Video Player" i]')].find(visible);
            const player = getPlayer();
            return section || player?.closest?.('[role="dialog"]') || player?.parentElement || document.body;
        };
        const getSettings = () => {
            const root = playerRoot();
            const nodes = [root, ...walk(root)];
            let candidate = nodes.find(el => !isOurUi(el) && visible(el) &&
                /^(BUTTON|DIV|SPAN)$/.test(String(el.tagName || '').toUpperCase()) &&
                /\bsettings\b/i.test(labelOf(el)));
            if (candidate) return candidate;
            candidate = nodes.find(el => !isOurUi(el) &&
                /\bsettings\b/i.test(labelOf(el)) &&
                (/^(BUTTON|DIV|SPAN)$/.test(String(el.tagName || '').toUpperCase()) || el.getAttribute('role')));
            if (candidate) return candidate;

            // Drive sometimes portals the bottom-right player controls outside the
            // Video Player section. Fall back to visible labelled Settings controls
            // on the page, preferring controls nearest the video rectangle.
            const rect = player?.getBoundingClientRect?.();
            const globals = all().filter(el => !isOurUi(el) && visible(el) &&
                /\bsettings\b/i.test(labelOf(el)) &&
                (/^(BUTTON|DIV|SPAN)$/.test(String(el.tagName || '').toUpperCase()) || el.getAttribute('role')));
            globals.sort((a, b) => {
                const distance = el => {
                    if (!rect) return 0;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return Number.MAX_SAFE_INTEGER;
                    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                    const px = rect.left + rect.width, py = rect.top + rect.height;
                    return Math.hypot(cx - px, cy - py);
                };
                return distance(a) - distance(b);
            });
            return globals[0] || null;
        };
        const getQualityTrigger = () => {
            const nodes = all();
            const candidates = nodes.filter(el => {
                if (isOurUi(el) || !visible(el)) return false;
                const role = String(el.getAttribute?.('role') || '').toLowerCase();
                const inMenu = !!el.closest?.('[role="menu"], [role="listbox"], .goog-menu, [data-menu-root]');
                const text = labelOf(el);
                return /^\s*quality(?:\s*[>›]|$)/i.test(text) && (role === 'menuitem' || role === 'menuitemradio' || role === 'option' || role === 'button' || inMenu);
            });
            // Prefer the actual menu item whose accessible/text label begins with Quality.
            return candidates.sort((a,b) => {
                const ae = /^(?:\s*)quality(?:\s*[>›]|$)/i.test(labelOf(a)) ? 0 : 1;
                const be = /^(?:\s*)quality(?:\s*[>›]|$)/i.test(labelOf(b)) ? 0 : 1;
                return ae-be;
            })[0] || null;
        };
        const getQualityOptions = () => {
            const nodes = all().filter(visible);
            const found = new Map();
            for (const el of nodes) {
                if (isOurUi(el)) continue;
                const text = labelOf(el);
                const q = qualityNumber(text);
                if (!q && !isAuto(text)) continue;
                const role = String(el.getAttribute?.('role') || '').toLowerCase();
                const ancestor = el.closest?.('[role="menu"], [role="listbox"], .goog-menu, [data-menu-root]');
                if (!ancestor && role !== 'menuitemradio' && role !== 'menuitem' && role !== 'option' && role !== 'button' && el.getAttribute('tabindex') == null) continue;
                const candidate = el.closest?.('[role="menuitemradio"], [role="menuitem"], [role="option"], button, [tabindex]') || el;
                if (isOurUi(candidate) || !visible(candidate)) continue;
                const key = q ? `q:${q}` : 'auto';
                if (!found.has(key) || labelOf(candidate).length < labelOf(found.get(key)).length) found.set(key, candidate);
            }
            return [...found.values()];
        };
        const openQuality = async player => {
            revealControls(player);
            let options = getQualityOptions();
            if (options.length) return true;
            let quality = getQualityTrigger();
            if (!quality) {
                const settings = getSettings();
                if (!settings) return false;
                clickLikeUser(settings);
                await sleepLocal(220);
                quality = getQualityTrigger();
            }
            if (!quality) {
                await sleepLocal(400);
                quality = getQualityTrigger();
            }
            if (!quality) {
                // Some player revisions expose Settings only after controls are hovered a
                // second time. Re-open the player controls once before giving up.
                revealControls(player);
                await sleepLocal(350);
                const settings = getSettings();
                if (settings) { clickLikeUser(settings); await sleepLocal(250); }
                quality = getQualityTrigger();
            }
            if (!quality) return false;
            clickLikeUser(quality);
            const deadline = Date.now() + 1600;
            while (Date.now() < deadline) {
                if (getQualityOptions().length) return true;
                await sleepLocal(90);
            }
            return false;
        };

        const player = getPlayer();
        if (!player) return { success: false, error: 'Drive video element was not found.' };
        let wasPaused = true;
        try { wasPaused = !!player.paused; } catch (_) {}
        try {
            player.muted = true;
            player.defaultMuted = true;
            player.setAttribute('muted', '');
            player.volume = 0;
            player.playbackRate = 1;
        } catch (_) {}
        try { performance.setResourceTimingBufferSize?.(10000); } catch (_) {}

        const originalInfo = { paused: wasPaused, width: player.videoWidth || 0, height: player.videoHeight || 0 };
        const discovered = [];
        const audioDiscovered = [];

        const sendProbe = (action, label, token) => new Promise(resolve => {
            try {
                chrome.runtime.sendMessage({ action, fileId: fileIdArg, label, token }, response => resolve(response || {}));
            } catch (_) { resolve({}); }
        });

        // Start playback under a temporary AUTO probe. This is the user's requested fallback:
        // let Drive initialize its real player before we inspect/switch the quality menu.
        const autoProbe = await sendProbe('beginQualityProbe', 'AUTO');
        try { await player.play(); } catch (_) {}
        if (player.paused) {
            const playButton = findPlayButton(player);
            if (playButton) clickLikeUser(playButton);
        }
        const autoDeadline = Date.now() + 6000;
        while (Date.now() < autoDeadline) {
            if ((player.readyState >= 2 && (player.videoWidth || player.videoHeight)) ||
                performance.getEntriesByType('resource').some(e => String(e.name || '').includes('/videoplayback'))) break;
            await sleepLocal(120);
            if (player.paused) {
                const playButton = findPlayButton(player);
                if (playButton) clickLikeUser(playButton);
            }
        }
        const autoResult = await sendProbe('endQualityProbe', 'AUTO', autoProbe.token);
        const autoVideo = autoResult?.video || [];
        const autoAudio = autoResult?.audio || [];
        for (const item of autoAudio) audioDiscovered.push({...item});
        if (autoVideo.length) {
            const actualHeight = Number(player.videoHeight || 0);
            const actualWidth = Number(player.videoWidth || 0);
            const item = autoVideo[0];
            discovered.push({...item, height: Number(item.height || actualHeight || 0), width: Number(item.width || actualWidth || 0), probeQuality: actualHeight ? `${actualHeight}p` : 'AUTO'});
        }

        // Open Settings -> Quality using the real Drive controls.
        if (!(await openQuality(player))) {
            if (wasPaused) { try { player.pause(); } catch (_) {} }
            return { success: false, error: 'Drive Settings → Quality could not be opened. The video was started, but its player controls were not available to automate.' };
        }

        let options = getQualityOptions();
        const ordered = options
            .map(el => ({ el, height: qualityNumber(labelOf(el)), auto: isAuto(labelOf(el)), text: labelOf(el) }))
            .filter(x => x.height || x.auto)
            .sort((a,b) => (b.height || 0) - (a.height || 0));
        const originalOption = ordered.find(x => x.el.getAttribute('aria-checked') === 'true' || x.el.getAttribute('aria-selected') === 'true') ||
            ordered.find(x => x.height && originalInfo.height && x.height === originalInfo.height) ||
            ordered.find(x => x.auto && originalInfo.height === 0);

        for (const entry of ordered) {
            if (!entry.height) continue;
            // Settings/Quality closes after selection, so reopen it before each quality.
            await openQuality(player);
            options = getQualityOptions();
            const fresh = options.find(el => qualityNumber(labelOf(el)) === entry.height);
            if (!fresh) continue;

            const probe = await sendProbe('beginQualityProbe', `${entry.height}p`);
            clickLikeUser(fresh);

            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) {
                const currentHeight = Number(player.videoHeight || 0);
                const entriesNow = performance.getEntriesByType('resource').some(e => String(e.name || '').includes('/videoplayback'));
                if (currentHeight === entry.height || entriesNow) {
                    await sleepLocal(350);
                    break;
                }
                await sleepLocal(150);
            }
            const result = await sendProbe('endQualityProbe', `${entry.height}p`, probe.token);
            for (const item of result?.audio || []) audioDiscovered.push({...item});
            const videoItems = result?.video || [];
            if (videoItems.length) {
                const actualHeight = Number(player.videoHeight || 0);
                const actualWidth = Number(player.videoWidth || 0);
                const chosen = videoItems[0];
                discovered.push({...chosen, height: entry.height || Number(chosen.height || actualHeight || 0), width: Number(chosen.width || actualWidth || 0), probeQuality: `${entry.height}p`});
            } else {
                // If Drive reused an existing resource rather than emitting a new request,
                // record the quality switch itself; the service worker may already hold the
                // corresponding candidate under this file session.
                const currentHeight = Number(player.videoHeight || 0);
                if (currentHeight === entry.height) {
                    discovered.push({ url: '', originalUrl: '', itag: '', mime: 'video/mp4', height: entry.height, width: player.videoWidth || 0, contentLength: 0, probeQuality: `${entry.height}p`, noFreshRequest: true });
                }
            }
        }

        // Restore the player's original selection, then stop playback if the user had it paused.
        await openQuality(player);
        const restoreOptions = getQualityOptions();
        if (originalOption) {
            const restore = originalOption.height
                ? restoreOptions.find(el => qualityNumber(labelOf(el)) === originalOption.height)
                : restoreOptions.find(el => isAuto(labelOf(el)));
            if (restore) { clickLikeUser(restore); await sleepLocal(250); }
        }
        if (wasPaused) { try { player.pause(); } catch (_) {} }

        // Return only real stream URLs; placeholders are just hints that the player switched.
        const uniqVideo = new Map();
        for (const item of discovered) {
            if (!item?.url) continue;
            const key = item.itag ? `itag:${item.itag}` : `${item.height}|${item.width}|${item.contentLength}`;
            if (!uniqVideo.has(key) || Number(item.capturedAt || 0) > Number(uniqVideo.get(key)?.capturedAt || 0)) uniqVideo.set(key, item);
        }
        const uniqAudio = new Map();
        for (const item of audioDiscovered) {
            if (!item?.url) continue;
            const key = item.itag ? `itag:${item.itag}` : `${item.contentLength}|${item.mime}`;
            uniqAudio.set(key, item);
        }
        return {
            success: true,
            formats: dedupeScannedFormats({ video: [...uniqVideo.values()], audio: [...uniqAudio.values()] }),
            observedQualityLabels: ordered.filter(x => x.height).map(x => `${x.height}p`),
            originalInfo
        };
    };

    try {
        const results = await chrome.scripting.executeScript({ target: {tabId, allFrames: true}, world: 'MAIN', func: scanFunc, args: [fileId] });
        const outputs = (Array.isArray(results) ? results : []).map(item => item?.result).filter(Boolean);
        const output = outputs.find(item => item?.success && (item.formats?.video?.length || item.observedQualityLabels?.length)) ||
            outputs.find(item => item?.success) || null;
        if (!output) {
            const error = outputs.find(item => item?.error)?.error || 'Could not locate the Drive video player controls in an accessible frame.';
            return { success: false, error };
        }
        return output;
    } catch (error) {
        return { success: false, error: error?.message || 'Automated Drive quality scan failed.' };
    }
}
