// End-to-end automated quality scan orchestration.


async function trustedV24RunQualityProbeScan(tabId, fileId) {
    let qualityScanDebuggerHeld = false;
    let qualityScanDebuggerReleased = false;
    try {
    const session = await getStoredSession(tabId);
    if (!session || (session.fileId && session.fileId !== fileId)) return { success:false, error:'The current Drive video session changed.' };

    await prepareQualityScanState(tabId, fileId);
    const frames = await trustedV24GetFrames(tabId);
    if (!frames.length) return { success:false, error:'No Drive frames were available for autoplay.' };

    // Seed the scan with streams already observed for this exact viewer session.
    // This is critical when the user has manually switched Drive through several
    // qualities before pressing Download; those URLs must not be erased.
    const preexisting = await getStoredSession(tabId);
    const recentForTab = debuggerNetworkState(tabId)?.recentStreams || [];
    const discoveredVideo=Array.isArray(preexisting?.videoCandidates) ? preexisting.videoCandidates.slice() : [];
    const discoveredAudio=Array.isArray(preexisting?.audioCandidates) ? preexisting.audioCandidates.slice() : [];
    // Recover URLs that the debugger saw before the storage queue finished.
    // This is especially important when the player emitted several quality URLs
    // in rapid succession while the user was already playing the video.
    for (const item of recentForTab) {
        if (!item?.url) continue;
        if (item.fileId && fileId && item.fileId !== fileId) continue;
        const isAudio = /audio/i.test(String(item.mime || '')) || /^(139|140|141|249|250|251)$/.test(String(item.itag || ''));
        (isAudio ? discoveredAudio : discoveredVideo).push(item);
    }
    let playback=null;
    // Keep one authoritative capture record per requested quality. The picker must
    // never be reduced to only the last quality visited by Drive.
    const qualityPairsByHeight=new Map();
    let settings=null;
    let qualityMenu=null;

    // Attach once before playback so the detector cannot miss the first fresh
    // media request; keep this same session through all quality switches.
    await trustedV24AttachDebugger(tabId);
    const qualityScanState = DEBUGGER_NETWORK_TABS.get(Number(tabId));
    if (qualityScanState) qualityScanState.qualityScanKeepAttached = true;
    qualityScanDebuggerHeld = true;

    // 1) If the user is already watching the video, use that state immediately.
    // Otherwise run the exact V24 autoplay path.
    if (await trustedV24DetectExistingPlayback(tabId)) {
        playback={success:true,playing:true,playbackDetected:true,method:'already-playing-current-drive-video'};
    } else {
        playback=await trustedV24RunAutoplay(tabId,frames);
    }
    if(!playback?.playbackDetected){
        const injected=await trustedV24ForceAutoplayViaInjectedScript(tabId);
        playback=injected;
        if(injected?.needsTrustedClick&&injected.playRect){
            const trustedClick=await trustedV24ClickPlayWithDebugger(tabId,injected.playRect);
            const verified=await trustedV24VerifyPlayback(tabId,3000);
            playback={...injected,...verified,success:verified.playing,playbackDetected:verified.playing,method:trustedClick?.ok?'exact-v24-debugger-play':'injected autoplay fallback'};
        }
    }
    if(!playback?.playbackDetected&&!playback?.playing){
        return {success:false,error:'Drive video did not start automatically.',playback};
    }

    // 2) Open Settings -> Quality. State-aware: it never toggles a menu that is already open
    // (the old unconditional gear click closed the just-opened submenu and skipped option #1).
    const opened=await trustedV24OpenQualitySubmenu(tabId, 5000);
    settings=opened.settings||null;
    qualityMenu=opened.menu||null;
    if(!opened.ok){
        return {success:false,error:`Drive quality menu: ${opened.reason}`,playback,settings,quality:{menu:qualityMenu,open:opened}};
    }
    let optionList=opened.options;

    // Do not trust Drive's aria-selected/aria-checked flag to identify the currently playing
    // representation; it can point at the first row while the video is still at another quality.
    let originalSelected=0;
    try { originalSelected = await trustedV24GetCurrentPlaybackHeight(tabId); } catch (_) {}
    if (!originalSelected) originalSelected=Number(optionList.find(x=>x.selected)?.height||0);
    // A non-16:9 video reports a videoHeight that is not a menu label (e.g. 804 for "1080p");
    // only treat it as a known quality when it really is one of the listed options.
    if (originalSelected && !optionList.some(x=>Number(x.height)===Number(originalSelected))) originalSelected=0;

    const scanReport=[];
    const isAudioFmt=x=>/audio/i.test(String(x?.mime||''))||/^(139|140|141|249|250|251)$/.test(String(x?.itag||''));

    // If the player is already on a numeric quality, keep that quality's existing playback URL.
    // Selecting the row that is already active just closes the menu and emits no new request.
    if (originalSelected) {
        const currentLabel = `${originalSelected}p`;
        const currentPool = [...discoveredVideo, ...(debuggerNetworkState(tabId)?.recentStreams||[])]
            .filter(x => x?.url && /video/i.test(String(x?.mime||'')) && !isAudioFmt(x));
        const exact = currentPool.filter(x => Number(x?.height||0) === Number(originalSelected) && x.heightSource !== 'probe');
        // A request with no height of its own (unmapped itag) that the player is making right now
        // is, by definition, the quality that is playing.
        const unknown = currentPool.filter(x => !Number(x?.height||0));
        const currentVideo = chooseProbeCandidate(exact.length ? exact : unknown, Number(originalSelected), currentLabel);
        const currentAudio = await getCurrentSessionAudioCandidate(tabId);
        if (currentVideo?.url) {
            const pairVideo = {...currentVideo, height:Number(originalSelected), qualityHeight:Number(originalSelected), probeQuality:currentLabel};
            const pairAudio = currentAudio ? {...currentAudio, probeQuality:currentLabel} : null;
            qualityPairsByHeight.set(Number(originalSelected), {height:Number(originalSelected), video:pairVideo, audio:pairAudio, capturedAt:Date.now(), existing:true});
            discoveredVideo.push(pairVideo);
            if (pairAudio?.url) discoveredAudio.push(pairAudio);
        }
    }

    // 3) Visit EVERY numeric option, highest first. For each one: make sure the Quality submenu
    // is open, start capture BEFORE activating (Drive can request the new stream immediately),
    // activate the row through the verified click ladder, then accept a stream only if it really
    // belongs to that resolution. Nothing is ever recorded under a quality that was not reached.
    const numericOptions = optionList
        .filter(option => Number(option?.height) > 0)
        .sort((a, b) => Number(b.height) - Number(a.height));

    for(let optionIndex = 0; optionIndex < numericOptions.length; optionIndex++){
        const option = numericOptions[optionIndex];
        const isFinalQuality = optionIndex === numericOptions.length - 1;
        const height=Number(option.height);
        const label=`${height}p`;
        const report={height,label,attempts:0,method:'',activated:false,captured:false,how:'',reason:'',steps:[]};
        scanReport.push(report);

        if(qualityPairsByHeight.get(height)?.video?.url){
            report.captured=true; report.how='reused the stream Drive was already playing';
            continue;
        }

        for(let attempt=1; attempt<=2 && !report.captured; attempt++){
            report.attempts=attempt;
            // A late final stream may require one retry. If the previous attempt already
            // released the debugger, re-arm the flag so a retry that reattaches it is also
            // detached cleanly.
            if (isFinalQuality && qualityScanDebuggerReleased) qualityScanDebuggerReleased = false;
            const submenu=await trustedV24OpenQualitySubmenu(tabId);
            if(!submenu.ok){ report.reason=submenu.reason; continue; }
            if(!submenu.options.some(o=>Number(o.height)===height)){ report.reason=`${label} is no longer listed in the Quality menu.`; break; }

            const probe=await beginQualityProbe(tabId,fileId,label);
            const switchedAt=Date.now();
            let click=null;
            let result={video:[],audio:[]};
            try{
                click=await trustedV24ActivateQualityByMenuNavigation(
                    tabId,
                    height,
                    submenu.options,
                    isFinalQuality ? { waitMenuMs: FAST_SCAN.finalMenuCloseWaitMs, immediateSuccess: true } : {}
                );
                report.method=click?.method||report.method;
                report.activated=!!click?.ok;
                report.steps=(click?.attempts||[]).map(a=>({method:a.method,ok:!!a.ok,menuClosed:a.menuClosed,hitOk:a.hitOk,reason:a.reason||''}));
                if(click?.ok){
                    // For the LAST quality, the debugger has done its job: the trusted click
                    // has been sent. Detach immediately so Chrome can dismiss the debugger
                    // banner. webRequest continues observing /videoplayback and will populate
                    // the probe buffer after detach if Drive emits the request a moment later.
                    if (isFinalQuality && qualityScanDebuggerHeld && !qualityScanDebuggerReleased) {
                        const held = DEBUGGER_NETWORK_TABS.get(Number(tabId));
                        if (held) {
                            held.qualityScanKeepAttached = false;
                            held.qualityScanReadyToRelease = false;
                        }
                        trustedV24DetachDebugger(tabId).catch(() => {});
                        qualityScanDebuggerReleased = true;
                    }
                    await trustedV24ResumePlaybackAfterQuality(tabId);
                    const waitMs = isFinalQuality ? FAST_SCAN.finalStreamWaitMs : FAST_SCAN.streamWaitMs;
                    const deadline=Date.now()+waitMs;
                    while(Date.now()<deadline){
                        const c=await getQualityProbeCandidates(tabId,probe.token);
                        if((c.video||[]).some(x=>Number(x?.height||0)===height)) break;
                        await sleep(FAST_SCAN.streamPollMs);
                    }
                }
            }finally{
                // Minimum dwell measured from the click itself, so the new representation can
                // start loading before the next switch.
                const dwellTarget = isFinalQuality ? FAST_SCAN.finalQualitySwitchDwellMs : FAST_SCAN.qualitySwitchDwellMs;
                const remaining=Math.max(0, dwellTarget - (Date.now()-switchedAt));
                if(remaining>0) await sleep(remaining);
                result=await endQualityProbe(tabId,probe.token);
            }

            const videos=(result.video||[]).filter(x=>x?.url);
            // Strict match on the request's own height. A height that was merely filled in from
            // the probe label (unmapped itag) is only trusted when the click was really activated.
            const strict=videos.filter(x=>Number(x.height||0)===height && (x.heightSource!=='probe' || report.activated));
            let chosen=chooseProbeCandidate(strict,height,label);
            let how=chosen?'stream requested after the click':'';
            let playingHeight=0;
            if(!chosen && report.activated){
                playingHeight=await trustedV24GetCurrentPlaybackHeight(tabId);
                if(playingHeight===height && videos.length){
                    chosen=videos.slice().sort((a,b)=>Number(b.capturedAt||0)-Number(a.capturedAt||0))[0];
                    how='newest request; player confirmed at this height';
                } else {
                    const recent=(debuggerNetworkState(tabId)?.recentStreams||[])
                        .filter(x=>x?.url && /video/i.test(String(x.mime||'')) && !isAudioFmt(x) && Number(x.height||0)===height && x.heightSource!=='probe');
                    chosen=chooseProbeCandidate(recent,height,label);
                    if(chosen) how='stream Drive had already requested for this height';
                }
            }

            for(const a of (result.audio||[])) discoveredAudio.push({...a,probeQuality:label});
            if(chosen?.url){
                const pairVideo={...chosen,height,qualityHeight:height,probeQuality:label};
                const pairAudio=(result.audio||[]).find(x=>String(x?.probeQuality||'').toLowerCase()===label.toLowerCase())
                    || chooseProbeCandidate(result.audio,0,'audio')
                    || await getCurrentSessionAudioCandidate(tabId);
                discoveredVideo.push(pairVideo);
                if(pairAudio?.url) discoveredAudio.push({...pairAudio,probeQuality:label});
                qualityPairsByHeight.set(height,{height,video:pairVideo,audio:pairAudio,capturedAt:Date.now(),verifiedBy:how});
                report.captured=true; report.how=how; report.reason='';
            } else {
                report.reason = report.activated
                    ? `${label} was activated but Drive sent no stream request for it.`
                    : (click?.reason || 'The click could not be performed.');
                // Activated and the player really is at this height: another click cannot help.
                if(report.activated && playingHeight===height) break;
            }
        }

        // Final-quality detach now happens immediately after the click above. Keep this
        // guard only for an unexpected path where the click failed before releasing.
        if (isFinalQuality && qualityScanDebuggerHeld && !qualityScanDebuggerReleased) {
            const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
            if (state) {
                state.qualityScanReadyToRelease = false;
                state.qualityScanKeepAttached = false;
            }
            await trustedV24DetachDebugger(tabId, true);
            qualityScanDebuggerReleased = true;
        }
    }

    // CRITICAL UI handoff: the final-quality click already released the debugger above.
    // Keep a synchronous safety guard for unexpected paths.
    if (qualityScanDebuggerHeld && !qualityScanDebuggerReleased) {
        const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
        if (state) {
            state.qualityScanReadyToRelease = false;
            state.qualityScanKeepAttached = false;
        }
        trustedV24DetachDebugger(tabId).catch(() => {});
        qualityScanDebuggerReleased = true;
    }

    // Do not restore the original quality here. The scan already visited every
    // numeric representation and restoring it would require another full
    // Settings -> Quality cycle and add another second or more of latency.

    const dedupe=(items,type)=>{
        const map=new Map();
        for(const item of items){
            if(!item?.url) continue;
            const key=item.itag
                ? `${type}|itag:${item.itag}|q:${Number(item.height||0)}|w:${Number(item.width||0)}|probe:${String(item.probeQuality || '').toLowerCase()}`
                : `${type}|${Number(item.height||0)}|${Number(item.width||0)}|${item.mime||''}|${String(item.probeQuality || '').toLowerCase()}`;
            const prev=map.get(key); if(!prev||Number(item.capturedAt||0)>=Number(prev.capturedAt||0)) map.set(key,item);
        }
        return [...map.values()];
    };

    // Build the displayed video list from the per-quality capture map first. This
    // makes the overlay independent of the rolling/last-candidate stream state.
    const qualityVideos=[...qualityPairsByHeight.values()]
        .map(pair => pair?.video)
        .filter(Boolean);
    const video=dedupe([...qualityVideos, ...discoveredVideo],'video')
        .sort((a,b)=>(Number(b.qualityHeight || b.height || 0)-Number(a.qualityHeight || a.height || 0))||(Number(b.contentLength||0)-Number(a.contentLength||0)));
    const audio=dedupeAudioFormats(dedupe(discoveredAudio,'audio')).sort((a,b)=>Number(b.contentLength||0)-Number(a.contentLength||0));

    // Do NOT perform background size probes before returning the scan result.
    // Those probes used to run after the debugger had already detached, but they
    // still delayed the handoff long enough for Drive to rebuild its File menu and
    // erase the freshly mounted selector contents. Keep the fast path strictly to
    // captured Drive metadata (clen/contentLength when available). Unknown sizes
    // can be resolved later by the normal download path without keeping the debugger
    // banner or the File-menu handoff open.
    const finalVideo=video.filter(x=>x?.url);
    const finalAudio=audio.filter(x=>x?.url);
    if(!finalVideo.length) return {success:false,error:'No usable videoplayback URL was captured for the current Drive viewer.',playback,settings,scanReport,quality:{options:optionList},existingFormats:{video:preexisting?.videoCandidates||[],audio:preexisting?.audioCandidates||[]}};
    const pairMap=new Map();
    for(const pair of qualityPairsByHeight.values()){
        if(!pair?.height || !pair.video?.url) continue;
        pairMap.set(Number(pair.height), pair);
    }
    const normalizedPairs=[...pairMap.values()].sort((a,b)=>Number(b.height||0)-Number(a.height||0));
    return {
        success:true,
        playback,
        settings,
        quality:{options:optionList},
        formats:{video:finalVideo,audio:finalAudio,progressive:[]},
        qualityStreams:normalizedPairs,
        scanReport,
        observedQualityLabels:finalVideo.map(x=>`${Number(x.height)||0}p`).filter(x=>x!=='0p'),
        captureCount:{video:finalVideo.length,audio:finalAudio.length,qualityPairs:normalizedPairs.length},
        captureMode:'continuous-session-quality-probe-menu-navigation-and-background-fetch',
        debuggerReleasePending:false
    };
    } finally {
        // Absolute safety net for EVERY scan exit path. Even after a successful
        // final-click release, force-detach once more if a retry/error path managed
        // to reattach the debugger. The helper is idempotent when already detached.
        if (qualityScanDebuggerHeld) {
            const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
            if (state) {
                state.qualityScanReadyToRelease = false;
                state.qualityScanKeepAttached = false;
            }
            await trustedV24DetachDebugger(tabId, true);
        }
    }
}
