const SCAN_MAX_ATTEMPTS_PER_QUALITY = 1;

function createScanCapture(preexistingSession, recentStreams, fileId) {
    const seedAudio = [];
    if (preexistingSession?.audio) {
        seedAudio.push({
            url: preexistingSession.audio,
            originalUrl: preexistingSession.audioOriginal || preexistingSession.audio,
            mime: 'audio/mp4'
        });
    }
    for (const a of (preexistingSession?.audioCandidates || [])) {
        if (a?.url) seedAudio.push(a);
    }
    for (const a of (preexistingSession?.formats?.audio || [])) {
        if (a?.url) seedAudio.push(a);
    }

    const capture = {
        discoveredVideo: Array.isArray(preexistingSession?.videoCandidates) ? preexistingSession.videoCandidates.slice() : [],
        // Prefer a single shared audio entry when seeding.
        discoveredAudio: seedAudio.length ? [seedAudio[0]] : [],
        pairsByHeight: new Map()
    };

    for (const stream of recentStreams) {
        if (!stream?.url) continue;
        if (stream.fileId && fileId && stream.fileId !== fileId) continue;
        if (isAudioStream(stream)) {
            if (!capture.discoveredAudio[0]?.url) capture.discoveredAudio = [stream];
        } else {
            capture.discoveredVideo.push(stream);
        }
    }
    return capture;
}

function hasCapturedStream(capture, height) {
    return !!capture.pairsByHeight.get(height)?.video?.url;
}

function recordQualityPair(capture, { height, video, audio, extra }) {
    capture.discoveredVideo.push(video);
    // Audio is shared — keep at most the best single track on the capture object.
    if (audio?.url) {
        const existing = capture.discoveredAudio[0];
        if (!existing?.url || Number(audio.contentLength || 0) >= Number(existing.contentLength || 0)) {
            capture.discoveredAudio = [audio];
        }
    }
    // Pair always references the shared audio (same URL for every height).
    const sharedAudio = capture.discoveredAudio[0] || audio || null;
    capture.pairsByHeight.set(height, {
        height,
        video,
        audio: sharedAudio,
        capturedAt: Date.now(),
        ...extra
    });
}


async function ensurePlayback(tabId, frames) {
    // Fast path: already playing — do not wait.
    if (await detectExistingPlayback(tabId)) {
        return { success: true, playing: true, playbackDetected: true, method: 'already-playing' };
    }

    const autoplay = await startAutoplayInFrames(tabId, frames);
    if (autoplay?.playbackDetected) return autoplay;

    const injected = await playWithDom(tabId, frames);
    if (injected?.playbackDetected) return injected;

    // Original post-play confirmation window.
    const verified = await verifyPlaybackStarted(tabId, 1500);
    return {
        ...injected,
        ...verified,
        success: !!verified.playing,
        playbackDetected: !!verified.playing,
        method: verified.playing ? 'play state confirmation' : (injected?.method || 'autoplay exhausted')
    };
}

/**
 * Audio is ONE shared track for the whole file — not per quality.
 * Grab it as soon as playback starts so every probed video quality can pair with it.
 */
async function waitForSharedAudio(tabId, waitMs = 4000) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        // Session first (webRequest already persisted it).
        const fromSession = await getCurrentSessionAudioCandidate(tabId);
        if (fromSession?.url) return fromSession;

        // In-memory recent ring (may land before storage finishes).
        const recent = (streamCaptureState(tabId)?.recentStreams || [])
            .filter(isAudioStream)
            .filter(s => s?.url)
            .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
        if (recent[0]?.url) return recent[0];

        await sleep(80);
    }
    return getCurrentSessionAudioCandidate(tabId);
}

async function lockSharedAudioOnSession(tabId, audio) {
    if (!audio?.url) return null;
    await queueSessionMutation(tabId, current => {
        if (!current) return false;
        current.audio = cleanURL(audio.originalUrl || audio.url) || audio.url;
        current.audioOriginal = audio.originalUrl || audio.url;
        current.audioCandidates = addUniqueCandidate(
            Array.isArray(current.audioCandidates) ? current.audioCandidates : [],
            audio,
            8
        );
        current.formats = current.formats || { video: [], audio: [], progressive: [] };
        // Single audio entry for the picker / download — replace, don't accumulate qualities.
        current.formats.audio = [{
            ...audio,
            url: current.audio,
            originalUrl: current.audioOriginal,
            id: audio.id || `audio:${audio.itag || formatHash(current.audio)}`
        }];
        current.streamCaptureEnabled = true;
        return current;
    });
    return audio;
}

async function detectPlayingQualityHeight(tabId, options) {
    let height = 0;
    try { height = await getPlayingVideoHeight(tabId); } catch (_) {}
    if (!height) height = Number(options.find(option => option.selected)?.height || 0);
    return options.some(option => Number(option.height) === Number(height)) ? height : 0;
}

async function captureCurrentQualityStream(tabId, height, capture) {
    if (!height) return;
    const label = `${height}p`;
    const isVideoStream = stream => stream?.url && /video/i.test(String(stream.mime || '')) && !isAudioStream(stream);
    const pool = [...capture.discoveredVideo, ...(streamCaptureState(tabId)?.recentStreams || [])].filter(isVideoStream);
    const exactHeight = pool.filter(stream => Number(stream.height || 0) === height && stream.heightSource !== 'probe');
    const unknownHeight = pool.filter(stream => !Number(stream.height || 0));
    const currentVideo = chooseProbeCandidate(exactHeight.length ? exactHeight : unknownHeight, height);
    const currentAudio = await getCurrentSessionAudioCandidate(tabId);
    if (!currentVideo?.url) return;

    const video = { ...currentVideo, height, qualityHeight: height, probeQuality: label };
    const audio = currentAudio ? { ...currentAudio, probeQuality: label } : null;
    recordQualityPair(capture, { height, video, audio, extra: { existing: true } });
}

async function waitForQualityStream(tabId, probeToken, height, waitMs, usedUrls = new Set()) {
    const deadline = Date.now() + waitMs;
    const want = Number(height) || 0;
    while (Date.now() < deadline) {
        const candidates = await getQualityProbeCandidates(tabId, probeToken);
        const found = (candidates.video || []).some(stream => {
            if (!stream?.url || isAudioStream(stream)) return false;
            const key = streamUrlKey(stream);
            if (key && usedUrls.has(key)) return false;
            return true; // any new unique video URL counts
        });
        if (found) return true;

        // Fallback: a recent stream tagged with this probe height / qualityHeight
        // that landed outside the token filter (page-bridge race before tagging).
        if (want) {
            const recent = streamCaptureState(tabId)?.recentStreams || [];
            const match = recent.some(stream => {
                if (!stream?.url || isAudioStream(stream)) return false;
                const key = streamUrlKey(stream);
                if (key && usedUrls.has(key)) return false;
                const h = Number(stream.qualityHeight || stream.probeHeight || 0);
                return h === want;
            });
            if (match) return true;
        }
        await sleep(FAST_SCAN.streamPollMs);
    }
    return false;
}

async function nudgePlaybackAfterQualitySwitch(tabId) {
    // Seek far enough that Drive must fetch a fresh segment for the new itag.
    try { await runQualityDom(tabId, 'nudgePlayback', { seconds: 1.25 }); } catch (_) {}
    await resumePlaybackAfterQualitySwitch(tabId);
    // Second nudge after a short settle — covers players that ignore the first seek.
    await sleep(120);
    try { await runQualityDom(tabId, 'nudgePlayback', { seconds: 0.5 }); } catch (_) {}
    await resumePlaybackAfterQualitySwitch(tabId);
}

async function activateQualityAndCollect({ tabId, fileId, height, label, options, isFinalQuality, report, usedUrls = new Set() }) {
    const probe = await beginQualityProbe(tabId, fileId, label);
    const switchedAt = Date.now();
    let click = null;
    let result = { video: [], audio: [] };
    let sawNewStream = false;
    try {
        click = await activateQualityRow(tabId, height, options, {});
        report.method = click?.method || report.method;
        report.activated = !!click?.ok;
        report.steps = (click?.attempts || []).map(a => ({
            method: a.method, ok: !!a.ok, reason: a.reason || '', step: a.step || ''
        }));
        if (click?.ok) {
            await nudgePlaybackAfterQualitySwitch(tabId);
            const waitMs = isFinalQuality ? FAST_SCAN.finalStreamWaitMs : FAST_SCAN.streamWaitMs;
            sawNewStream = await waitForQualityStream(tabId, probe.token, height, waitMs, usedUrls);
            report.sawNewStream = !!sawNewStream;
        }
    } finally {
        result = await finishProbe(tabId, probe, switchedAt, isFinalQuality);
        // Fold any recent streams tagged for this probe height into the result
        // (covers webRequest that landed slightly after endQualityProbe cleared the buffer).
        const want = Number(height) || 0;
        const recent = streamCaptureState(tabId)?.recentStreams || [];
        for (const stream of recent) {
            if (!stream?.url) continue;
            if (isAudioStream(stream)) {
                result.audio = result.audio || [];
                if (!result.audio.some(s => streamUrlKey(s) === streamUrlKey(stream))) {
                    result.audio.push(stream);
                }
                continue;
            }
            const h = Number(stream.qualityHeight || stream.probeHeight || stream.height || 0);
            const tagged = stream.probeToken === probe.token || (want && h === want);
            if (!tagged) continue;
            result.video = result.video || [];
            if (!result.video.some(s => streamUrlKey(s) === streamUrlKey(stream))) {
                result.video.push({
                    ...stream,
                    height: want || h,
                    qualityHeight: want || h,
                    probeQuality: label
                });
            }
        }
    }
    return { click, result, probeStartedAt: probe.startedAt || switchedAt, sawNewStream };
}

async function finishProbe(tabId, probe, switchedAt, isFinalQuality) {
    const dwellMs = isFinalQuality ? FAST_SCAN.finalQualitySwitchDwellMs : FAST_SCAN.qualitySwitchDwellMs;
    const remaining = Math.max(0, dwellMs - (Date.now() - switchedAt));
    if (remaining > 0) await sleep(remaining);
    return endQualityProbe(tabId, probe.token);
}

/**
 * Identity for "is this the same video stream as another quality?"
 * Prefer itag (stable adaptive format id). Fall back to cleaned URL.
 * Two heights must never share the same key.
 */
function streamUrlKey(stream) {
    const itag = String(stream?.itag || '').trim();
    if (itag) return `itag:${itag}`;
    try {
        const cleaned = cleanURL(stream?.url || stream?.originalUrl || '');
        // Strip volatile signing bits so the same file maps to one key.
        return cleaned
            .replace(/([?&](?:signature|sig|lsig|expire|ei|cpn|cver|rn|rbuf|ump|alr|n)=[^&]*)/gi, '')
            .replace(/[?&]$/, '');
    } catch (_) {
        return String(stream?.url || '');
    }
}

function streamIsAvailable(stream, usedUrls) {
    if (!stream?.url || isAudioStream(stream)) return false;
    const key = streamUrlKey(stream);
    if (key && usedUrls.has(key)) return false;
    return true;
}

/**
 * Strict pick: only accept a stream that is unique vs already-claimed qualities
 * AND either (a) probe-tagged for this height, or (b) real itag/url height match.
 * Never fall back to "newest any stream" — that is what reused 720 for 1080.
 */
async function pickStreamForQuality({ tabId, height, label, streams, activated, usedUrls = new Set(), probeStartedAt = 0 }) {
    const h = Number(height || 0);
    const recent = (streamCaptureState(tabId)?.recentStreams || [])
        .filter(s => s?.url && !isAudioStream(s));
    const merged = [...(Array.isArray(streams) ? streams : []), ...recent];
    const available = merged.filter(s => streamIsAvailable(s, usedUrls));

    // 1) Probe-tagged for this height, captured during this probe window.
    const probeTagged = available
        .filter(s => Number(s.qualityHeight || s.probeHeight || 0) === h)
        .filter(s => Number(s.capturedAt || 0) >= (probeStartedAt || 0) - 200)
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
    if (probeTagged[0]) {
        return {
            chosen: { ...probeTagged[0], height: h, qualityHeight: h, probeQuality: label },
            how: 'unique probe-tagged stream',
            playingHeight: 0
        };
    }

    // 2) Real height from itag/url (not our probe label) matching this menu row.
    const heightMatch = available
        .filter(s => Number(s.height || 0) === h && String(s.heightSource || '') !== 'probe')
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
    if (heightMatch[0]) {
        return {
            chosen: { ...heightMatch[0], height: h, qualityHeight: h, probeQuality: label },
            how: 'unique stream with matching itag/url height',
            playingHeight: 0
        };
    }

    // 3) New stream after click whose real height is unknown (0) — only if unique
    //    and not already claimed. Still refuse if its itag was used for another height.
    const afterProbeUnknown = available
        .filter(s => Number(s.capturedAt || 0) >= (probeStartedAt || 0) - 100)
        .filter(s => !Number(s.height || 0) || Number(s.height || 0) === h)
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
    if (afterProbeUnknown[0] && activated) {
        // Reject if real height is a *different* known quality (e.g. still 720 while probing 1080).
        const realH = Number(afterProbeUnknown[0].height || 0);
        if (realH && realH !== h) {
            return { chosen: null, how: '', playingHeight: realH };
        }
        return {
            chosen: { ...afterProbeUnknown[0], height: h, qualityHeight: h, probeQuality: label },
            how: 'unique new stream after quality click',
            playingHeight: 0
        };
    }

    return { chosen: null, how: '', playingHeight: 0 };
}

/** One attempt at one quality. Returns 'captured', 'retry' or 'stop'. */
async function attemptQualityProbe({ tabId, fileId, option, isFinalQuality, capture, report }) {
    const height = Number(option.height);
    // Prefer the live menu label ("480p", "720p HD") over a reconstructed one.
    const label = String(option.text || option.label || `${height}p`).trim() || `${height}p`;

    // URLs / itags already claimed by another menu height must not be reused.
    const usedUrls = new Set(
        [...capture.pairsByHeight.values()]
            .map(pair => streamUrlKey(pair?.video))
            .filter(Boolean)
    );

    // One mini-plugin sequence per attempt: Settings → Quality → click label.
    const { click, result, probeStartedAt, sawNewStream } = await activateQualityAndCollect({
        tabId, fileId, height, label, options: [option], isFinalQuality, report, usedUrls
    });

    const streams = (result.video || []).filter(stream => stream?.url);
    const { chosen, how, playingHeight } = await pickStreamForQuality({
        tabId, height, label, streams, activated: report.activated, usedUrls, probeStartedAt
    });

    // Shared audio only — never invent per-quality audio. Top up if play-start miss.
    if (!capture.discoveredAudio[0]?.url) {
        const late = (result.audio || []).find(a => a?.url) || await getCurrentSessionAudioCandidate(tabId);
        if (late?.url) capture.discoveredAudio = [late];
    }

    const chosenKey = streamUrlKey(chosen);
    // Hard uniqueness: same itag or cleaned URL as another height → reject.
    if (chosenKey && usedUrls.has(chosenKey)) {
        report.reason = `${label} resolved to a stream already used by another quality.`;
        return 'retry';
    }
    // Also reject if any other pair already has this exact clean URL string.
    if (chosen?.url) {
        const chosenClean = (() => { try { return cleanURL(chosen.url); } catch (_) { return chosen.url; } })();
        for (const pair of capture.pairsByHeight.values()) {
            if (!pair?.video?.url) continue;
            let otherClean = '';
            try { otherClean = cleanURL(pair.video.url); } catch (_) { otherClean = pair.video.url; }
            if (chosenClean && otherClean && chosenClean === otherClean) {
                report.reason = `${label} stream URL is identical to ${pair.height}p.`;
                return 'retry';
            }
            if (chosen.itag && pair.video.itag && String(chosen.itag) === String(pair.video.itag)) {
                report.reason = `${label} itag ${chosen.itag} already used by ${pair.height}p.`;
                return 'retry';
            }
        }
    }

    if (!chosen?.url) {
        report.reason = report.activated
            ? (sawNewStream
                ? `${label} was activated but no distinct stream URL was captured.`
                : `${label} was activated but Drive sent no distinct stream URL for it.`)
            : (click?.reason || 'The click could not be performed.');
        return report.activated && playingHeight === height ? 'stop' : 'retry';
    }

    const video = { ...chosen, height, qualityHeight: height, probeQuality: label };
    const audio = capture.discoveredAudio[0] || null;
    recordQualityPair(capture, {
        height, video, audio, extra: { verifiedBy: how }
    });
    report.captured = true;
    report.how = how;
    report.reason = '';
    report.urlKey = chosenKey || '';
    report.itag = chosen.itag || '';
    return 'captured';
}

async function probeQualityOption({ tabId, fileId, option, isFinalQuality, capture }) {
    const height = Number(option.height);
    const label = String(option.text || option.label || `${height}p`).trim() || `${height}p`;
    const report = {
        height, label, attempts: 0, method: '', activated: false,
        captured: false, how: '', reason: '', steps: []
    };

    // ALWAYS run the click sequence — including when this quality is already
    // selected. Skipping "current" is what made 480p look like it never clicked.
    for (let attempt = 1; attempt <= SCAN_MAX_ATTEMPTS_PER_QUALITY && !report.captured; attempt++) {
        report.attempts = attempt;
        const outcome = await attemptQualityProbe({ tabId, fileId, option, isFinalQuality, capture, report });
        if (outcome === 'captured' || outcome === 'stop') break;
        if (report.activated && !report.captured) break;
        if (!report.captured) await closePlayerMenu(tabId);
    }

    return report;
}

function dedupeCapturedStreams(streams, kind) {
    const byIdentity = new Map();
    for (const stream of streams) {
        if (!stream?.url) continue;
        const probe = String(stream.probeQuality || '').toLowerCase();
        const height = Number(stream.height || 0);
        const width = Number(stream.width || 0);
        const identity = stream.itag
            ? `${kind}|itag:${stream.itag}|q:${height}|w:${width}|probe:${probe}`
            : `${kind}|${height}|${width}|${stream.mime || ''}|${probe}`;
        const previous = byIdentity.get(identity);
        if (!previous || Number(stream.capturedAt || 0) >= Number(previous.capturedAt || 0)) byIdentity.set(identity, stream);
    }
    return [...byIdentity.values()];
}

/** Video/audio lists for the picker: per-quality captures first, best quality first. */
function buildScanFormats(capture) {
    // Prefer streams that were explicitly paired to a live menu height during probing.
    // Rewrite height from the pair key / qualityHeight so itag guesses cannot stick.
    // One URL → one height. If two menu rows somehow claimed the same stream,
    // keep the pair whose raw itag/url height matches (or the first recorded).
    // Enforce one unique stream per height: same itag OR same cleaned URL → keep one.
    const seenKeys = new Set();
    const qualityVideos = [...capture.pairsByHeight.values()]
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
        .map(pair => {
            const video = pair?.video;
            if (!video?.url) return null;
            const height = Number(pair.height || video.qualityHeight || video.height || 0);
            if (!height) return null;
            const key = streamUrlKey(video);
            if (key && seenKeys.has(key)) return null;
            if (key) seenKeys.add(key);
            return {
                ...video,
                height,
                qualityHeight: height,
                probeQuality: video.probeQuality || `${height}p`
            };
        })
        .filter(Boolean);
    const pairedHeights = new Set(qualityVideos.map(s => Number(s.height)).filter(Boolean));
    const qualityHeightOf = stream => Number(stream.qualityHeight || stream.height || 0);
    const extras = capture.discoveredVideo.filter(stream => {
        const h = qualityHeightOf(stream);
        if (!h || !stream?.url) return false;
        if (pairedHeights.has(h)) return false;
        // Skip pure itag-table guesses that were never confirmed by a menu probe.
        if (String(stream.heightSource || '') === 'itag' && !stream.probeQuality) return false;
        return true;
    }).map(stream => {
        const h = qualityHeightOf(stream);
        return { ...stream, height: h, qualityHeight: h };
    });
    const allVideo = dedupeCapturedStreams([...qualityVideos, ...extras], 'video')
        .sort((a, b) => (qualityHeightOf(b) - qualityHeightOf(a)) || bySizeDesc(a, b))
        .filter(stream => stream?.url);
    // Split muxed (progressive) streams — they already contain audio.
    const progressive = allVideo.filter(isMuxedStream).map(s => ({ ...s, progressive: true }));
    const video = allVideo.filter(s => !isMuxedStream(s));
    // Exactly one audio track for the whole file.
    const audioList = dedupeAudioFormats(dedupeCapturedStreams(capture.discoveredAudio, 'audio'))
        .sort(bySizeDesc)
        .filter(stream => stream?.url);
    const audio = audioList.length ? [audioList[0]] : [];
    return { video, audio, progressive };
}

function listQualityPairs(capture) {
    const pairs = new Map();
    for (const pair of capture.pairsByHeight.values()) {
        if (!pair?.height || !pair.video?.url) continue;
        pairs.set(Number(pair.height), pair);
    }
    return [...pairs.values()].sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
}

async function scanQualities(tabId, fileId) {
    const session = await getStoredSession(tabId);
    if (!session || (session.fileId && session.fileId !== fileId)) return { success: false, error: 'The current Drive video session changed.' };

    await prepareQualityScanState(tabId, fileId);
    const frames = await listPageFrames(tabId);
    if (!frames.length) return { success: false, error: 'No Drive frames were available for autoplay.' };

    const preexisting = await getStoredSession(tabId);
    const capture = createScanCapture(preexisting, streamCaptureState(tabId)?.recentStreams || [], fileId);

    try {
        await runQualityDom(tabId, 'enableMuteGuard');
        const playback = await ensurePlayback(tabId, frames);
    if (!playback?.playbackDetected && !playback?.playing) {
        return { success: false, error: 'Drive video did not start automatically.', playback };
    }

    // --- SHARED AUDIO (one track for the whole file) ---
    // Prefer: session → recent ring → global last audio (simple-plugin path).
    // Never block probing waiting for it.
    {
        const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
        const existing = capture.discoveredAudio.find(a => a?.url)
            || (streamCaptureState(tabId)?.recentStreams || []).find(isAudioStream)
            || await getCurrentSessionAudioCandidate(tabId)
            || (globalAudio?.url ? globalAudio : null);
        if (existing?.url) {
            capture.discoveredAudio = [existing];
            void lockSharedAudioOnSession(tabId, existing);
        }
    }

    const opened = await openQualitySubmenu(tabId, FAST_SCAN.menuTimeoutMs);
    const settings = opened.settings || null;
    if (!opened.ok) {
        const frameInfo = settings?.frames || await describePlayerFrames(tabId);
        return {
            success: false, error: `Drive quality menu: ${opened.reason}`,
            playback, settings, frames: frameInfo, quality: { menu: opened.menu || null, open: opened }
        };
    }
    const optionList = opened.options;

    // Close the discovery menu so each probe starts with a clean
    // Settings → Quality → row sequence (same as the mini plugin).
    await closePlayerMenu(tabId);
    await sleep(FAST_SCAN.optionSettleMs || 200);

    // Seed capture with any streams already seen (real itag heights only).
    // These can satisfy the fast-path reuse without a menu click.
    const recent = streamCaptureState(tabId)?.recentStreams || [];
    for (const stream of recent) {
        if (!stream?.url || isAudioStream(stream)) continue;
        if (stream.fileId && fileId && stream.fileId !== fileId) continue;
        const h = Number(stream.height || 0);
        const source = String(stream.heightSource || '');
        if (h > 0 && source !== 'probe') {
            capture.discoveredVideo.push(stream);
        }
    }

    // Highest → lowest.
    const numericOptions = optionList
        .filter(option => Number(option?.height) > 0)
        .sort((a, b) => Number(b.height) - Number(a.height));
    const scanReport = [];
    for (const [index, option] of numericOptions.entries()) {
        const isFinalQuality = index === numericOptions.length - 1;
        const name = option.text || option.label || `${option.height}p`;
        scanReport.push(await probeQualityOption({ tabId, fileId, option, isFinalQuality, capture }));
    }

    // Final shared-audio lock — also check global last audio from webRequest.
    if (!capture.discoveredAudio[0]?.url) {
        const late = await waitForSharedAudio(tabId, 600)
            || (typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null);
        if (late?.url) capture.discoveredAudio = [late];
    }
    if (capture.discoveredAudio[0]?.url) {
        await lockSharedAudioOnSession(tabId, capture.discoveredAudio[0]);
    }

    const formats = buildScanFormats(capture);
    if (!formats.video.length) {
        return {
            success: false,
            error: 'No usable videoplayback URL was captured for the current Drive viewer.',
            playback, settings, scanReport, quality: { options: optionList },
            existingFormats: { video: preexisting?.videoCandidates || [], audio: preexisting?.audioCandidates || [] }
        };
    }

    const qualityPairs = listQualityPairs(capture);
        return {
            success: true,
            playback,
            settings,
            quality: { options: optionList },
            formats: { video: formats.video, audio: formats.audio, progressive: formats.progressive || [] },
            qualityStreams: qualityPairs,
            scanReport,
            observedQualityLabels: formats.video.map(stream => `${Number(stream.height) || 0}p`).filter(label => label !== '0p'),
            captureCount: { video: formats.video.length, audio: formats.audio.length, qualityPairs: qualityPairs.length },
            captureMode: 'continuous-session-quality-probe-dom-menu-navigation'
        };
    } finally {
        await runQualityDom(tabId, 'releaseMuteGuard');
    }
}
