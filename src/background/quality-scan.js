const SCAN_MAX_ATTEMPTS_PER_QUALITY = 2;

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
    if (await detectExistingPlayback(tabId)) {
        return { success: true, playing: true, playbackDetected: true, method: 'already-playing-current-drive-video' };
    }

    // 1) The content script already loaded in each frame (drive-autoplay.js).
    const autoplay = await startAutoplayInFrames(tabId, frames);
    if (autoplay?.playbackDetected) return autoplay;

    // 2) The same trigger logic injected directly, for frames the player created late.
    const injected = await playWithDom(tabId, frames);
    if (injected?.playbackDetected) return injected;

    // 3) Last check: the player may have started between the two sweeps.
    const verified = await verifyPlaybackStarted(tabId, 1500);
    return {
        ...injected,
        ...verified,
        success: verified.playing,
        playbackDetected: verified.playing,
        method: verified.playing ? 'play state confirmation' : (injected?.method || 'dom-trigger autoplay exhausted')
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

async function waitForQualityStream(tabId, probeToken, height, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        const candidates = await getQualityProbeCandidates(tabId, probeToken);
        if ((candidates.video || []).some(stream => Number(stream?.height || 0) === height)) return;
        await sleep(FAST_SCAN.streamPollMs);
    }
}

async function activateQualityAndCollect({ tabId, fileId, height, label, options, isFinalQuality, report }) {
    const probe = await beginQualityProbe(tabId, fileId, label);
    const switchedAt = Date.now();
    let click = null;
    let result = { video: [], audio: [] };
    try {
        click = await activateQualityRow(
            tabId,
            height,
            options,
            isFinalQuality ? { waitMenuMs: FAST_SCAN.finalMenuCloseWaitMs, immediateSuccess: true } : {}
        );
        report.method = click?.method || report.method;
        report.activated = !!click?.ok;
        report.steps = (click?.attempts || []).map(attempt => ({
            method: attempt.method, ok: !!attempt.ok, menuClosed: attempt.menuClosed, hitOk: attempt.hitOk, reason: attempt.reason || ''
        }));
        if (click?.ok) {
            await resumePlaybackAfterQualitySwitch(tabId);
            await waitForQualityStream(tabId, probe.token, height, isFinalQuality ? FAST_SCAN.finalStreamWaitMs : FAST_SCAN.streamWaitMs);
        }
    } finally {
        result = await finishProbe(tabId, probe, switchedAt, isFinalQuality);
    }
    return { click, result };
}

async function finishProbe(tabId, probe, switchedAt, isFinalQuality) {
    const dwellMs = isFinalQuality ? FAST_SCAN.finalQualitySwitchDwellMs : FAST_SCAN.qualitySwitchDwellMs;
    const remaining = Math.max(0, dwellMs - (Date.now() - switchedAt));
    if (remaining > 0) await sleep(remaining);
    return endQualityProbe(tabId, probe.token);
}

async function pickStreamForQuality({ tabId, height, label, streams, activated }) {
    const strict = streams.filter(stream => Number(stream.height || 0) === height && (stream.heightSource !== 'probe' || activated));
    const strictMatch = chooseProbeCandidate(strict, height);
    if (strictMatch) return { chosen: strictMatch, how: 'stream requested after the click', playingHeight: 0 };
    if (!activated) return { chosen: null, how: '', playingHeight: 0 };

    const playingHeight = await getPlayingVideoHeight(tabId);
    if (playingHeight === height && streams.length) {
        const newest = streams.slice().sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0))[0];
        return { chosen: newest, how: 'newest request; player confirmed at this height', playingHeight };
    }

    const alreadyRequested = (streamCaptureState(tabId)?.recentStreams || [])
        .filter(stream => stream?.url && /video/i.test(String(stream.mime || '')) && !isAudioStream(stream) &&
            Number(stream.height || 0) === height && stream.heightSource !== 'probe');
    const chosen = chooseProbeCandidate(alreadyRequested, height);
    return { chosen, how: chosen ? 'stream Drive had already requested for this height' : '', playingHeight };
}

/** One attempt at one quality. Returns 'captured', 'retry' or 'stop'. */
async function attemptQualityProbe({ tabId, fileId, option, isFinalQuality, capture, report }) {
    const height = Number(option.height);
    const label = `${height}p`;

    const submenu = await openQualitySubmenu(tabId);
    if (!submenu.ok) {
        report.reason = submenu.reason;
        return 'retry';
    }
    if (!submenu.options.some(item => Number(item.height) === height)) {
        report.reason = `${label} is no longer listed in the Quality menu.`;
        return 'stop';
    }

    const { click, result } = await activateQualityAndCollect({
        tabId, fileId, height, label, options: submenu.options, isFinalQuality, report
    });

    const streams = (result.video || []).filter(stream => stream?.url);
    const { chosen, how, playingHeight } = await pickStreamForQuality({ tabId, height, label, streams, activated: report.activated });

    for (const audio of (result.audio || [])) capture.discoveredAudio.push({ ...audio, probeQuality: label });

    if (!chosen?.url) {
        report.reason = report.activated
            ? `${label} was activated but Drive sent no stream request for it.`
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
    return 'captured';
}

async function probeQualityOption({ tabId, fileId, option, isFinalQuality, capture }) {
    const height = Number(option.height);
    const report = { height, label: `${height}p`, attempts: 0, method: '', activated: false, captured: false, how: '', reason: '', steps: [] };

    if (hasCapturedStream(capture, height)) {
        report.captured = true;
        report.how = 'reused the stream Drive was already playing';
        return report;
    }

    for (let attempt = 1; attempt <= SCAN_MAX_ATTEMPTS_PER_QUALITY && !report.captured; attempt++) {
        report.attempts = attempt;
        const outcome = await attemptQualityProbe({ tabId, fileId, option, isFinalQuality, capture, report });
        if (outcome === 'stop') break;
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
    const qualityVideos = [...capture.pairsByHeight.values()].map(pair => pair?.video).filter(Boolean);
    const qualityHeightOf = stream => Number(stream.qualityHeight || stream.height || 0);
    const video = dedupeCapturedStreams([...qualityVideos, ...capture.discoveredVideo], 'video')
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
        console.warn('[GDrive SW] Settings -> Quality could not be opened:', opened.reason, frameInfo);
        return {
            success: false, error: `Drive quality menu: ${opened.reason}`,
            playback, settings, frames: frameInfo, quality: { menu: opened.menu || null, open: opened }
        };
    }
    const optionList = opened.options;
    console.log('[GDrive SW] Quality options found:', optionList.map(option => option.text || `${option.height}p`).join(', '));

    await captureCurrentQualityStream(tabId, await detectPlayingQualityHeight(tabId, optionList), capture);

    const numericOptions = optionList
        .filter(option => Number(option?.height) > 0)
        .sort((a, b) => Number(b.height) - Number(a.height));
    const scanReport = [];
    for (const [index, option] of numericOptions.entries()) {
        const isFinalQuality = index === numericOptions.length - 1;
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
