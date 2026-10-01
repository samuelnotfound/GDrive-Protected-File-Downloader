const PICKER_SNAPSHOT_KEY = 'psdQualityPickerSnapshots';

const invalidTabResponse = () => ({ success: false, error: 'Invalid Drive tab.' });
const sessionChangedResponse = () => ({ success: false, error: 'The current Drive video session changed.' });

const requireDriveTab = (handler, unauthorizedResponse = invalidTabResponse) =>
    ctx => (Number.isInteger(ctx.tabId) ? handler(ctx) : unauthorizedResponse());

async function getSessionForFile(tabId, requestedFileId) {
    const session = await getStoredSession(tabId);
    const fileId = String(requestedFileId || session?.fileId || '').trim();
    const isCurrent = session && fileId && (!session.fileId || session.fileId === fileId);
    return isCurrent ? { session, fileId } : null;
}


async function readPickerSnapshots(storageArea) {
    const data = await storageArea.get(PICKER_SNAPSHOT_KEY);
    const snapshots = data?.[PICKER_SNAPSHOT_KEY];
    return snapshots && typeof snapshots === 'object' ? snapshots : {};
}

async function writePickerSnapshot(storageArea, fileId, snapshot) {
    const snapshots = await readPickerSnapshots(storageArea);
    snapshots[fileId] = snapshot;
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

async function deletePickerSnapshot(storageArea, fileId) {
    const snapshots = { ...await readPickerSnapshots(storageArea) };
    delete snapshots[fileId];
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

async function handleSaveQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId || !request.snapshot?.formats) return { success: false, error: 'No quality snapshot.' };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try {
            await writePickerSnapshot(storageArea, fileId, request.snapshot);
            return { success: true };
        } catch (error) {
            if (storageArea === chrome.storage.local) return { success: false, error: error?.message || String(error) };
        }
    }
}

async function handleLoadQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: false, error: 'Missing file id.' };
    try {
        const snapshot = (await readPickerSnapshots(chrome.storage.session))[fileId] || null;
        if (snapshot) return { success: true, snapshot };
    } catch (_) {}
    try {
        return { success: true, snapshot: (await readPickerSnapshots(chrome.storage.local))[fileId] || null };
    } catch (error) {
        return { success: false, snapshot: null, error: error?.message || String(error) };
    }
}

async function handleClearQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: true };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try { await deletePickerSnapshot(storageArea, fileId); } catch (_) {}
    }
    return { success: true };
}


async function handleSetVideoContext({ request, tabId }) {
    const fileId = String(request.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();
    const filename = String(request.filename || '').trim();

    const current = await getStoredSession(tabId);
    const changed = !current
        || current.fileId !== fileId
        || current.viewerSessionId !== viewerSessionId
        || (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId);

    const next = changed
        ? emptySession(fileId, filename || 'gdrive-video', viewerSessionId)
        : {
            ...current,
            fileId: fileId || current.fileId,
            filename: filename || current.filename,
            viewerSessionId: viewerSessionId || current.viewerSessionId,
            pageBridgeId: pageBridgeId || current.pageBridgeId || ''
        };

    // Capture is on for the active viewer session immediately, so several quality URLs the user has
    // already generated before pressing Download are retained.
    next.streamCaptureEnabled = true;
    if (!changed && pageBridgeId) next.pageBridgeId = pageBridgeId;

    await setStoredSession(tabId, next);
    if (changed) setBadge('');
    return { success: true, changed, session: next };
}

async function handleUpdateFilename({ request, tabId }) {
    const filename = String(request.filename || '').trim();
    await queueSessionMutation(tabId, session => {
        if (!filename || session.filename === filename) return false;
        session.filename = filename;
        return session;
    });
    return { success: true };
}

async function handleVideoPlaybackIntent({ request, tabId }) {
    await queueSessionMutation(tabId, session => {
        if (request.fileId && session.fileId && request.fileId !== session.fileId) return false;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

async function handleVideoPlaybackStarted({ tabId }) {
    await queueSessionMutation(tabId, session => {
        if (session.playbackStarted) return false;
        session.playbackStarted = true;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}


function validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate }) {
    if (!session || !fileId || !viewerSessionId) return { success: false, error: 'No active Drive viewer session.' };
    if (session.fileId && fileId !== session.fileId) return { success: false, error: 'Drive file/session mismatch.' };
    if (session.viewerSessionId && viewerSessionId !== session.viewerSessionId) return { success: false, error: 'Drive viewer session mismatch.' };
    if (session.pageBridgeId && pageBridgeId && session.pageBridgeId !== pageBridgeId) return { success: false, error: 'Stale page bridge.' };
    const candidateFileId = String(candidate?.fileId || '').trim();
    if (candidateFileId && session.fileId && candidateFileId !== session.fileId) {
        return { success: false, error: 'Playback URL belongs to another Drive file.' };
    }
    return null;
}

function addCapturedStreamToSession(session, candidate, isAudio) {
    const kind = isAudio ? 'audio' : 'video';
    session[kind] = candidate.url;
    session[`${kind}Original`] = candidate.originalUrl;
    session[`${kind}Candidates`] = addUniqueCandidate(session[`${kind}Candidates`], candidate, 16);

    const format = {
        ...candidate,
        id: `captured:${candidate.itag || formatHash(candidate.url)}`,
        kind,
        acodec: isAudio ? candidate.codecs || '' : '',
        vcodec: isAudio ? '' : candidate.codecs || '',
        url: candidate.url,
        originalUrl: candidate.originalUrl
    };
    session.formats = {
        ...session.formats,
        [kind]: mergeFormatLists(session.formats?.[kind], [format], isAudio ? bySizeDesc : byHeightThenSize),
        [isAudio ? 'video' : 'audio']: session.formats?.[isAudio ? 'video' : 'audio'] || [],
        progressive: session.formats?.progressive || []
    };
}

async function handlePageStreamDetected({ request, tabId }) {
    const url = String(request.url || '').trim();
    if (!url || !url.includes('/videoplayback')) return { success: false, error: 'Not a Drive playback URL.' };

    const parsed = parseStreamCandidate(url, url);
    if (!parsed) return { success: false, error: 'Could not parse Drive playback URL.' };

    // Tag into the in-memory probe buffer FIRST (same as webRequest path).
    // waitForQualityStream polls memory; waiting on the storage queue was the
    // main reason quality-click streams were missed during automated scans.
    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    const candidate = {
        ...parsed,
        pageBridgeId: String(request.pageBridgeId || ''),
        frameUrl: String(request.frameUrl || ''),
        source: String(request.source || 'page-bridge'),
        capturedAt: Date.now()
    };
    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    const session = await getStoredSession(tabId);
    const fileId = String(request.fileId || session?.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || session?.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();

    const rejection = validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate: parsed });
    if (rejection) return rejection;

    candidate.pageBridgeId = pageBridgeId || session.pageBridgeId || '';

    let latest = null;
    await queueSessionMutation(tabId, current => {
        if (current.fileId !== session.fileId || current.viewerSessionId !== session.viewerSessionId) return false;
        if (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId) return false;
        if (!current.pageBridgeId && pageBridgeId) current.pageBridgeId = pageBridgeId;

        const probe = current.activeQualityProbe;
        if (probe) {
            candidate.probeQuality = probe.label || candidate.probeQuality || '';
            candidate.probeToken = probe.token || candidate.probeToken || '';
            const labelHeight = Number(String(probe.label || '').match(/(\d{3,4})p/i)?.[1] || 0);
            if (labelHeight && !isAudioStream(candidate)) {
                candidate.qualityHeight = labelHeight;
                candidate.probeHeight = labelHeight;
            }
            current.probeCandidates = [candidate, ...(Array.isArray(current.probeCandidates) ? current.probeCandidates : [])].slice(0, 32);
        }

        // Simple-plugin classification: mime=audio in URL, else itag/isAudioStream.
        const rawUrl = String(candidate.originalUrl || candidate.url || '');
        const isAudio = rawUrl.includes('mime=audio') || isAudioStream(candidate);
        if (isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('audio', candidate, rawUrl);
        } else if (!isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('video', candidate, rawUrl);
        }
        addCapturedStreamToSession(current, candidate, isAudio);
        current.playbackStarted = true;
        current.streamCaptureEnabled = true;
        latest = current;
        return current;
    });
    if (!latest) return { success: false, error: 'The current Drive viewer changed.' };

    setBadge('ON');
    await sendTab(tabId, {
        type: 'videoStreamDetected',
        fileId: latest.fileId,
        viewerSessionId: latest.viewerSessionId,
        stream: candidate,
        formats: latest.formats
    });
    return { success: true, session: latest, stream: candidate };
}



async function handleListPlayerQualityLabels({ request, tabId }) {
    // Labels do not require a fully seeded session — only a Drive tab.
    // Share the quality-scan lock with capture so Settings→Quality DOM work never races.
    const existing = QUALITY_SCAN_TAB_LOCK.get(tabId);
    if (existing?.promise) {
        return { success: false, error: 'Another quality operation is already running on this tab.', options: [] };
    }

    const work = (async () => {
    const found = await getSessionForFile(tabId, request.fileId);
    const fileId = String(found?.fileId || request.fileId || '').trim();

    const SETTINGS = ['settings', 'settings menu', 'player settings', 'video settings', 'open settings'];
    const QUALITY = ['quality', 'video quality', 'quality settings'];

    try {
        await runQualityDom(tabId, 'enableMuteGuard');

        // Playback is the user's job — no autoplay. Open Settings → Quality and
        // read every quality row at once (same as Drive Quality Trigger).

        let options = [];
        let lastError = '';

        for (let attempt = 0; attempt < 3 && !options.length; attempt++) {
            await closePlayerMenu(tabId);
            await sleep(200 + attempt * 150);
            try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}
            await sleep(200);

            const settings = await clickMenuLikeMini(tabId, SETTINGS, 'Settings', 8000, true);
            if (!settings?.ok) {
                lastError = settings?.reason || 'Could not open Settings.';
                continue;
            }
            await sleep(500);

            const quality = await clickMenuLikeMini(
                tabId, QUALITY, 'Quality', 8000, false,
                Number.isInteger(settings.frameId) ? settings.frameId : null
            );
            if (!quality?.ok) {
                lastError = quality?.reason || 'Could not open Quality menu.';
                continue;
            }
            await sleep(500);

            // Scan ALL quality labels at once while the submenu is open (all frames).
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
            const rows = await runQualityDom(tabId, 'scanQualities');
            const byHeight = new Map();
            for (const row of rows || []) {
                const value = row?.value;
                // Our content returns { ok, options, labels }
                const list = Array.isArray(value?.options) ? value.options
                    : Array.isArray(value) ? value
                    : [];
                for (const opt of list) {
                    if (typeof opt === 'string') {
                        const height = Number(String(opt).match(/(\d{3,4})p/i)?.[1] || 0);
                        if (!height) continue;
                        byHeight.set(height, {
                            height,
                            label: String(opt).trim(),
                            selected: false
                        });
                        continue;
                    }
                    const height = Number(opt?.height || 0);
                    if (!height) continue;
                    const label = String(opt.text || opt.label || `${height}p`).trim();
                    const prev = byHeight.get(height);
                    if (!prev || opt.selected) {
                        byHeight.set(height, { height, label, selected: !!opt.selected });
                    }
                }
                // Also accept plain labels array from content
                for (const lab of (value?.labels || [])) {
                    const height = Number(String(lab).match(/(\d{3,4})p/i)?.[1] || 0);
                    if (!height) continue;
                    if (!byHeight.has(height)) {
                        byHeight.set(height, { height, label: String(lab).trim(), selected: false });
                    }
                }
            }
            options = [...byHeight.values()].sort((a, b) => b.height - a.height);
                if (options.length) break;
                await sleep(120);
            }

            await closePlayerMenu(tabId);
            if (options.length) break;
            lastError = lastError || 'No quality options were found in the menu.';
            await sleep(300);
        }

        if (!options.length) {
            try { await closePlayerMenu(tabId); } catch (_) {}
            return {
                success: false,
                error: lastError || 'No quality options were found in the menu.',
                options: []
            };
        }

        return {
            success: true,
            fileId,
            options,
            formats: {
                video: options.map(o => ({
                    id: `label:${o.height}`,
                    height: o.height,
                    qualityHeight: o.height,
                    probeQuality: o.label,
                    menuLabel: o.label,
                    labelOnly: true,
                    url: ''
                })),
                audio: [],
                progressive: []
            }
        };
    } catch (error) {
        return { success: false, error: error?.message || 'Failed to list quality labels.', options: [] };
    } finally {
        try { await runQualityDom(tabId, 'releaseMuteGuard'); } catch (_) {}
    }
    })();

    QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: work, finishedAt: 0 });
    try {
        return await work;
    } finally {
        QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: null, finishedAt: Date.now() });
    }
}

/**
 * Phase 2 — user picked a label. Click that quality on the player, wait for ONE
 * unique stream URL, pair with shared audio, return both for download.
 */
async function handleCaptureQualityForDownload({ request, tabId }) {
    const height = Number(request.qualityHeight || request.height || 0);
    const label = String(request.qualityLabel || request.label || (height ? `${height}p` : '')).trim();
    if (!height && !label) {
        return { success: false, error: 'No quality selected.' };
    }

    const found = await getSessionForFile(tabId, request.fileId);
    if (!found) return sessionChangedResponse();
    const { fileId } = found;

    // Tab lock so we never stack two clicks.
    const existing = QUALITY_SCAN_TAB_LOCK.get(tabId);
    if (existing?.promise) {
        return { success: false, error: 'Another quality capture is already running.' };
    }

    const work = (async () => {
        try {
            await runQualityDom(tabId, 'enableMuteGuard');

            // Same as Drive Quality Trigger applyQuality:
            // Settings → Quality → click the exact label the user picked.
            const SETTINGS = ['settings', 'settings menu', 'player settings', 'video settings', 'open settings'];
            const QUALITY = ['quality', 'video quality', 'quality settings'];
            const clickAt = Date.now();

            await closePlayerMenu(tabId);
            await sleep(120);
            try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}

            const settings = await clickMenuLikeMini(tabId, SETTINGS, 'Settings', 7000, true);
            if (!settings?.ok) {
                return { success: false, error: settings?.reason || 'Could not open Settings.' };
            }
            await sleep(400);

            const quality = await clickMenuLikeMini(
                tabId, QUALITY, 'Quality', 7000, false,
                Number.isInteger(settings.frameId) ? settings.frameId : null
            );
            if (!quality?.ok) {
                return { success: false, error: quality?.reason || 'Could not open Quality menu.' };
            }
            await sleep(350);

            // Click the exact menu label (e.g. "720p", "720p HD").
            const names = [label, `${label} resolution`, `${label} quality`, height ? `${height}p` : '']
                .filter(Boolean);
            const selected = await selectQualityVerified(
                tabId, label || `${height}p`, height, 7000,
                Number.isInteger(quality.frameId) ? quality.frameId : (Number.isInteger(settings.frameId) ? settings.frameId : null)
            );
            if (!selected?.ok) {
                // Fallback: clickLabel with candidates
                let clicked = false;
                const end = Date.now() + 5000;
                while (Date.now() < end && !clicked) {
                    const rows = await runQualityDom(tabId, 'clickLabel', { labels: names });
                    clicked = (rows || []).some(r => r?.value?.ok || r?.value === true);
                    if (!clicked) await sleep(120);
                }
                if (!clicked) {
                    return { success: false, error: `Could not find ${label || height + 'p'} in the quality menu.` };
                }
            }

            // Harvest whatever is ALREADY playing (same quality → Drive may not
            // fire a new request when we re-select the active row).
            const harvestCurrentVideo = () => {
                const recent = (streamCaptureState(tabId)?.recentStreams || [])
                    .filter(s => s?.url && !isAudioStream(s))
                    .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
                if (recent[0]?.url) return recent[0];
                return null;
            };
            const alreadyPlaying = harvestCurrentVideo();

            // Nudge/seek so Drive often re-requests a segment even for the same itag.
            try { await nudgePlaybackAfterQualitySwitch(tabId); } catch (_) {}

            const probe = await beginQualityProbe(tabId, fileId, label || `${height}p`);
            if (probe && probe.accepted === false) {
                return { success: false, error: 'Session changed during quality capture. Open the video again and retry.' };
            }
            let video = null;
            try {
                // Short wait for a fresh post-click URL (quality change case).
                video = await waitForQualityStream(tabId, probe.token, height, (typeof FAST_SCAN !== "undefined" ? FAST_SCAN.streamWaitMs : 1500), new Set(), clickAt);
                if (!video?.url) {
                    const recentAfter = (streamCaptureState(tabId)?.recentStreams || [])
                        .filter(s => s?.url && !isAudioStream(s) && Number(s.capturedAt || 0) >= clickAt - 50)
                        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
                    video = recentAfter[0] || null;
                }
                // Same quality already playing: no new network request — reuse current stream.
                if (!video?.url && alreadyPlaying?.url) {
                    video = alreadyPlaying;
                }
                // Session last video as last resort (per-tab only). Avoid global cross-tab leak.
                if (!video?.url) {
                    const session = await getStoredSession(tabId);
                    if (session?.video) {
                        const h = Number(
                            session.formats?.video?.[0]?.qualityHeight
                            || session.formats?.video?.[0]?.height
                            || session.videoCandidates?.[0]?.height
                            || 0
                        );
                        video = {
                            url: session.video,
                            originalUrl: session.videoOriginal || session.video,
                            height: h,
                            qualityHeight: h
                        };
                    } else {
                        video = harvestCurrentVideo();
                    }
                }
            } finally {
                try { await endQualityProbe(tabId, probe.token); } catch (_) {}
            }

            if (!video?.url) {
                return {
                    success: false,
                    error: `${label || height + 'p'} is selected but no video stream URL is available. Seek the video a bit, then try Download again.`
                };
            }

            // Only apply the requested height when the stream was probe-tagged for
            // this capture or already reports that height. Never relabel a leftover.
            const actualH = Number(video.height || video.qualityHeight || 0);
            const probeMatched = (
                video.probeToken
                || Number(video.probeHeight || 0) === height
                || video.heightSource === 'probe'
                || (actualH && actualH === height)
            );
            const stampedHeight = probeMatched
                ? (actualH || height)
                : (actualH || 0);
            video = {
                ...video,
                height: stampedHeight,
                qualityHeight: stampedHeight,
                probeQuality: label || video.probeQuality || '',
                url: cleanURL(video.originalUrl || video.url) || video.url,
                originalUrl: video.originalUrl || video.url
            };
            if (!stampedHeight && height) {
                // Still record the requested label for UI, but do not claim the URL is that tier.
                video.requestedHeight = height;
                video.requestedLabel = label;
            }

            // Shared audio — session / recent / global.
            let audio = await getCurrentSessionAudioCandidate(tabId);
            if (!audio?.url) {
                audio = (streamCaptureState(tabId)?.recentStreams || []).find(isAudioStream)
                    || (typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null);
            }
            if (audio?.url) {
                audio = {
                    ...audio,
                    url: cleanURL(audio.originalUrl || audio.url) || audio.url,
                    originalUrl: audio.originalUrl || audio.url
                };
                try { await lockSharedAudioOnSession(tabId, audio); } catch (_) {}
            }

            // Persist this video onto the session so startVideoDownload can find it.
            // Reject if the tab navigated to a different Drive file mid-capture.
            await queueSessionMutation(tabId, current => {
                if (!current) return false;
                if (fileId && current.fileId && current.fileId !== fileId) return false;
                current.formats = current.formats || { video: [], audio: [], progressive: [] };
                current.formats.video = mergeFormatLists(
                    current.formats.video || [],
                    [video],
                    byHeightWidthThenSize,
                    48
                );
                if (audio?.url) {
                    current.formats.audio = [audio];
                    current.audio = audio.url;
                    current.audioOriginal = audio.originalUrl;
                }
                current.video = video.url;
                current.videoOriginal = video.originalUrl;
                current.videoCandidates = addUniqueCandidate(current.videoCandidates || [], video, 24);
                current.streamCaptureEnabled = true;
                return current;
            });

            return {
                success: true,
                video,
                audio: audio?.url ? audio : null,
                height,
                label
            };
        } finally {
            try { await runQualityDom(tabId, 'releaseMuteGuard'); } catch (_) {}
            try { await closePlayerMenu(tabId); } catch (_) {}
        }
    })();

    QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: work, finishedAt: 0 });
    try {
        return await work;
    } finally {
        QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: null, finishedAt: Date.now() });
    }
}

async function handleClearTabCaptureState({ tabId }) {
    if (!Number.isInteger(tabId) || tabId < 0) return { success: false };
    try {
        if (typeof clearTabMediaState === 'function') {
            await clearTabMediaState(tabId, { clearGlobal: true });
        } else {
            await clearStoredSession(tabId);
            clearStreamCaptureState(tabId);
            try {
                if (typeof GLOBAL_LAST_AUDIO !== 'undefined') GLOBAL_LAST_AUDIO = null;
                if (typeof GLOBAL_LAST_VIDEO !== 'undefined') GLOBAL_LAST_VIDEO = null;
            } catch (_) {}
            try { await chrome.storage.session.remove(['psdGlobalStreams']); } catch (_) {}
        }
    } catch (_) {}
    return { success: true };
}

const handleGetStreams = async ({ tabId }) => {
    if (typeof loadGlobalStreamsFromStorage === 'function') {
        await loadGlobalStreamsFromStorage();
    }

    let session = Number.isInteger(tabId) ? await getStoredSession(tabId) : null;
    const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    const globalVideo = typeof getGlobalLastVideo === 'function' ? getGlobalLastVideo() : null;
    const recent = (Number.isInteger(tabId) && typeof streamCaptureState === 'function')
        ? (streamCaptureState(tabId)?.recentStreams || [])
        : [];

    // Harvest anything already playing: recent ring + globals, even with no formal session.
    const recentVideo = recent.filter(s => s?.url && !isAudioStream(s));
    const recentAudio = recent.filter(s => s?.url && isAudioStream(s));

    // Ensure a minimal session object so the current Drive tab always has state to read from.
    if (!session) {
        session = {
            fileId: '',
            filename: '',
            formats: { video: [], audio: [], progressive: [] },
            videoCandidates: [],
            audioCandidates: [],
            streamCaptureEnabled: true
        };
    }
    session.formats = session.formats || { video: [], audio: [], progressive: [] };
    session.videoCandidates = Array.isArray(session.videoCandidates) ? session.videoCandidates : [];
    session.audioCandidates = Array.isArray(session.audioCandidates) ? session.audioCandidates : [];

    // Merge recent video into candidates + formats (current playing quality).
    for (const stream of recentVideo) {
        session.videoCandidates = addUniqueCandidate(session.videoCandidates, stream, 24);
        if (isMuxedStream(stream)) {
            session.formats.progressive = mergeFormatLists(
                session.formats.progressive || [],
                [{ ...stream, progressive: true }],
                byHeightWidthThenSize,
                24
            );
        } else {
            session.formats.video = mergeFormatLists(
                session.formats.video || [],
                [stream],
                byHeightWidthThenSize,
                48
            );
        }
        if (!session.video) {
            session.video = stream.url;
            session.videoOriginal = stream.originalUrl || stream.url;
        }
    }
    // Global last video if still empty.
    if (globalVideo?.url && !(session.formats.video || []).length && !(session.formats.progressive || []).length) {
        session.videoCandidates = addUniqueCandidate(session.videoCandidates, globalVideo, 24);
        session.formats.video = mergeFormatLists(session.formats.video || [], [globalVideo], byHeightWidthThenSize, 48);
        session.video = globalVideo.url;
        session.videoOriginal = globalVideo.originalUrl || globalVideo.url;
    }

    // Audio: recent → global → session
    for (const stream of recentAudio) {
        session.audioCandidates = addUniqueCandidate(session.audioCandidates, stream, 8);
        if (!session.audio) {
            session.audio = stream.url;
            session.audioOriginal = stream.originalUrl || stream.url;
        }
    }
    if (!session.audio && globalAudio?.url) {
        session.audio = globalAudio.url;
        session.audioOriginal = globalAudio.originalUrl || globalAudio.url;
        session.audioCandidates = addUniqueCandidate(session.audioCandidates, globalAudio, 8);
    }
    if (session.audio) {
        const a = session.audioCandidates[0] || globalAudio || recentAudio[0] || {
            url: session.audio,
            originalUrl: session.audioOriginal || session.audio,
            mime: 'audio/mp4'
        };
        session.formats.audio = [{
            ...a,
            url: cleanURL(a.originalUrl || a.url) || a.url,
            originalUrl: a.originalUrl || a.url,
            id: a.id || `audio:${a.itag || ''}`
        }];
    }

    // Persist merge when we have a real tab session key.
    if (Number.isInteger(tabId) && tabId >= 0 && (session.fileId || session.video || session.audio)) {
        try {
            const existing = await getStoredSession(tabId);
            if (existing) {
                await queueSessionMutation(tabId, current => {
                    if (!current) return false;
                    current.video = current.video || session.video;
                    current.videoOriginal = current.videoOriginal || session.videoOriginal;
                    current.audio = current.audio || session.audio;
                    current.audioOriginal = current.audioOriginal || session.audioOriginal;
                    current.videoCandidates = mergeFormatLists(
                        current.videoCandidates || [], session.videoCandidates || [], byHeightWidthThenSize, 48
                    );
                    current.audioCandidates = addUniqueCandidate(
                        current.audioCandidates || [], session.audioCandidates?.[0], 8
                    );
                    current.formats = current.formats || { video: [], audio: [], progressive: [] };
                    current.formats.video = mergeFormatLists(
                        current.formats.video || [], session.formats.video || [], byHeightWidthThenSize, 48
                    );
                    current.formats.audio = (current.formats.audio?.length ? current.formats.audio : session.formats.audio) || [];
                    current.formats.progressive = mergeFormatLists(
                        current.formats.progressive || [], session.formats.progressive || [], byHeightWidthThenSize, 24
                    );
                    current.streamCaptureEnabled = true;
                    return current;
                });
                session = await getStoredSession(tabId) || session;
            }
        } catch (_) {}
    }

    return {
        streams: session,
        globalAudio: session.formats?.audio?.[0] || globalAudio || null,
        globalVideo: (session.formats?.video || [])[0] || globalVideo || null,
        recentCount: recent.length
    };
};

async function handleMuteMediaNow({ tabId }) {
    if (!Number.isInteger(tabId)) return { success: false, error: 'No active Drive tab.' };
    await sendTab(tabId, { type: 'PSD_MUTE_MEDIA_NOW' });
    return { success: true };
}

const handleDownloadVideo = ({ request, tabId }) => startVideoDownload(tabId, request || {});

async function handleGetVideoStageJob({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
}

const FINISHED_STAGE_TYPES = new Set(['videoStageFinished', 'videoStageError', 'videoStageCancelled']);

async function cancelVideoStage(jobId, job, options = {}) {
    stopStreamWarmups(jobId);
    clearDownloadMonitor(jobId);
    sendOffscreen({ type: 'videoStageCancelInternal', jobId });
    if (!options.silent && job?.sourceTabId != null) {
        await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId });
    }
    await removeVideoStageJob(jobId);
    setTimeout(closeVideoOffscreen, 100);
    return { success: true };
}

async function handleVideoStageMessage({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    const isCancel = request.type === 'videoStageCancel';

    if (request.type === 'videoStageProgress' && request.jobId) {
        noteDownloadProgress(request.jobId, request.label, request.received);
    }

    if (job?.sourceTabId != null && !isCancel) await sendTab(job.sourceTabId, { type: request.type, ...request });
    if (isCancel) return cancelVideoStage(request.jobId, job);

    if (FINISHED_STAGE_TYPES.has(request.type)) {
        stopStreamWarmups(request.jobId);
        clearDownloadMonitor(request.jobId);
        await queueJobMutation(currentJobs => {
            if (!currentJobs[request.jobId]) return false;
            delete currentJobs[request.jobId];
            return true;
        });
        setTimeout(closeVideoOffscreen, 1200);
    }
    return { success: true };
}


const ACTION_HANDLERS = Object.freeze({
    saveQualityPickerSnapshot: requireDriveTab(handleSaveQualityPickerSnapshot),
    loadQualityPickerSnapshot: requireDriveTab(handleLoadQualityPickerSnapshot),
    clearQualityPickerSnapshot: requireDriveTab(handleClearQualityPickerSnapshot),
    setVideoContext: requireDriveTab(handleSetVideoContext),
    updateFilename: requireDriveTab(handleUpdateFilename),
    pageStreamDetected: requireDriveTab(handlePageStreamDetected),
    videoPlaybackIntent: requireDriveTab(handleVideoPlaybackIntent, () => ({ success: false })),
    videoPlaybackStarted: requireDriveTab(handleVideoPlaybackStarted, () => ({ success: false })),
    listPlayerQualityLabels: requireDriveTab(handleListPlayerQualityLabels),
    captureQualityForDownload: requireDriveTab(handleCaptureQualityForDownload),
    clearTabCaptureState: requireDriveTab(handleClearTabCaptureState),
    getStreams: handleGetStreams,
    muteMediaNow: handleMuteMediaNow,
    downloadVideo: handleDownloadVideo
});

const TYPE_HANDLERS = Object.freeze({
    getVideoStageJob: handleGetVideoStageJob
});

async function handleRuntimeMessage(request = {}, sender = {}) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    const ctx = { request, sender, tabId };

    const actionHandler = ACTION_HANDLERS[String(request.action || '')];
    if (actionHandler) return actionHandler(ctx);

    const type = String(request.type || '');
    const typeHandler = TYPE_HANDLERS[type];
    if (typeHandler) return typeHandler(ctx);
    if (type.startsWith('videoStage')) return handleVideoStageMessage(ctx);

    return undefined;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
});
