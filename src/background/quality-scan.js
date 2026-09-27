const SCAN_MAX_ATTEMPTS_PER_QUALITY = 1;

function createScanCapture(preexistingSession, recentStreams, fileId) {
    const capture = {
        discoveredVideo: Array.isArray(preexistingSession?.videoCandidates) ? preexistingSession.videoCandidates.slice() : [],
        discoveredAudio: Array.isArray(preexistingSession?.audioCandidates) ? preexistingSession.audioCandidates.slice() : [],
        pairsByHeight: new Map()
    };

    for (const stream of recentStreams) {
        if (!stream?.url) continue;
        if (stream.fileId && fileId && stream.fileId !== fileId) continue;
        (isAudioStream(stream) ? capture.discoveredAudio : capture.discoveredVideo).push(stream);
    }
    return capture;
}

function hasCapturedStream(capture, height) {
    return !!capture.pairsByHeight.get(height)?.video?.url;
}

function recordQualityPair(capture, { height, video, audio, extra }) {
    capture.discoveredVideo.push(video);
    if (audio?.url) capture.discoveredAudio.push(audio);
    capture.pairsByHeight.set(height, { height, video, audio, capturedAt: Date.now(), ...extra });
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
    while (Date.now() < deadline) {
        const candidates = await getQualityProbeCandidates(tabId, probeToken);
        const found = (candidates.video || []).some(stream => {
            if (!stream?.url || isAudioStream(stream)) return false;
            const key = streamUrlKey(stream);
            if (key && usedUrls.has(key)) return false;
            return true; // any new unique video URL counts
        });
        if (found) return true;
        await sleep(FAST_SCAN.streamPollMs);
    }
    return false;
}

async function nudgePlaybackAfterQualitySwitch(tabId) {
    try { await runQualityDom(tabId, 'nudgePlayback', { seconds: 0.35 }); } catch (_) {}
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
    }
    return { click, result, probeStartedAt: probe.startedAt || switchedAt, sawNewStream };
}

async function finishProbe(tabId, probe, switchedAt, isFinalQuality) {
    const dwellMs = isFinalQuality ? FAST_SCAN.finalQualitySwitchDwellMs : FAST_SCAN.qualitySwitchDwellMs;
    const remaining = Math.max(0, dwellMs - (Date.now() - switchedAt));
    if (remaining > 0) await sleep(remaining);
    return endQualityProbe(tabId, probe.token);
}

function streamUrlKey(stream) {
    try { return cleanURL(stream?.url || stream?.originalUrl || ''); } catch (_) { return String(stream?.url || ''); }
}

/**
 * After a successful menu click, the click is the authority for which quality
 * the stream belongs to. Prefer:
 *   1) unique URL with matching itag/url height
 *   2) newest unique URL captured during this probe (even if itag height differs)
 * Never reuse a URL already stored for another quality.
 */
async function pickStreamForQuality({ tabId, height, label, streams, activated, usedUrls = new Set(), probeStartedAt = 0 }) {
    const h = Number(height || 0);
    const available = (Array.isArray(streams) ? streams : []).filter(stream => {
        if (!stream?.url || isAudioStream(stream)) return false;
        const key = streamUrlKey(stream);
        if (key && usedUrls.has(key)) return false;
        return true;
    });

    // Prefer real itag/url height match among unique URLs.
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

    // Next: any unique stream captured after this probe started (click is authority).
    const afterProbe = available
        .filter(s => Number(s.capturedAt || 0) >= (probeStartedAt || 0) - 100)
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
    if (afterProbe[0]) {
        return {
            chosen: { ...afterProbe[0], height: h, qualityHeight: h, probeQuality: label },
            how: 'newest unique stream after quality click',
            playingHeight: 0
        };
    }

    // Any unique stream in the probe buffer after a successful click.
    if (available[0] && activated) {
        const newest = available.slice().sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0))[0];
        return {
            chosen: { ...newest, height: h, qualityHeight: h, probeQuality: label },
            how: 'unique stream from probe buffer',
            playingHeight: 0
        };
    }

    // Re-clicked the already-selected quality: Drive may not fire a new request.
    // Use a session stream whose real itag/url height matches (still unique).
    if (activated) {
        const recent = (streamCaptureState(tabId)?.recentStreams || [])
            .filter(s => s?.url && !isAudioStream(s) && /video/i.test(String(s.mime || '')))
            .filter(s => {
                const key = streamUrlKey(s);
                if (key && usedUrls.has(key)) return false;
                return Number(s.height || 0) === h && String(s.heightSource || '') !== 'probe';
            })
            .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
        if (recent[0]) {
            return {
                chosen: { ...recent[0], height: h, qualityHeight: h, probeQuality: label },
                how: 'session stream matching itag height after re-click',
                playingHeight: 0
            };
        }
    }

    return { chosen: null, how: '', playingHeight: 0 };
}

/** One attempt at one quality. Returns 'captured', 'retry' or 'stop'. */
async function attemptQualityProbe({ tabId, fileId, option, isFinalQuality, capture, report }) {
    const height = Number(option.height);
    // Prefer the live menu label ("480p", "720p HD") over a reconstructed one.
    const label = String(option.text || option.label || `${height}p`).trim() || `${height}p`;

    // URLs already claimed by another menu height must not be reused.
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

    for (const audio of (result.audio || [])) capture.discoveredAudio.push({ ...audio, probeQuality: label });

    // Reject if the chosen URL is already stored for another height (belt and suspenders).
    const chosenKey = streamUrlKey(chosen);
    if (chosenKey && usedUrls.has(chosenKey)) {
        report.reason = `${label} resolved to a stream URL already used by another quality.`;
        return 'retry';
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
    const audio = (result.audio || []).find(item => String(item?.probeQuality || '').toLowerCase() === label.toLowerCase())
        || chooseProbeCandidate(result.audio, 0)
        || await getCurrentSessionAudioCandidate(tabId);
    recordQualityPair(capture, {
        height, video, audio: audio?.url ? { ...audio, probeQuality: label } : audio, extra: { verifiedBy: how }
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
    const seenUrls = new Set();
    const qualityVideos = [...capture.pairsByHeight.values()]
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
        .map(pair => {
            const video = pair?.video;
            if (!video?.url) return null;
            const height = Number(pair.height || video.qualityHeight || video.height || 0);
            if (!height) return null;
            let key = '';
            try { key = cleanURL(video.url); } catch (_) { key = String(video.url); }
            if (key && seenUrls.has(key)) return null;
            if (key) seenUrls.add(key);
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
    const video = dedupeCapturedStreams([...qualityVideos, ...extras], 'video')
        .sort((a, b) => (qualityHeightOf(b) - qualityHeightOf(a)) || bySizeDesc(a, b));
    const audio = dedupeAudioFormats(dedupeCapturedStreams(capture.discoveredAudio, 'audio')).sort(bySizeDesc);
    // No size probing here: it would delay the hand-off long enough for Drive to rebuild its File menu.
    return { video: video.filter(stream => stream?.url), audio: audio.filter(stream => stream?.url) };
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
            formats: { video: formats.video, audio: formats.audio, progressive: [] },
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
