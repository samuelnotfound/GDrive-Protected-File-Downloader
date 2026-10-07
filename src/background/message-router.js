// ============================================================================
// FILE: src/background/message-router.js
// PURPOSE: Central IPC (Inter-Process Communication) message router and action
//          dispatch table. Receives messages from content scripts, popup/overlays,
//          and the offscreen remuxer document; coordinates quality probing,
//          format harvesting, UI snapshots, and video download stages.
// ============================================================================

/** Storage key under chrome.storage for caching quality picker UI snapshots */
const PICKER_SNAPSHOT_KEY = 'psdQualityPickerSnapshots';

/** Standardized response factory for unauthorized or missing tab contexts */
const invalidTabResponse = () => ({ success: false, error: 'Invalid Drive tab.' });

/** Standardized response factory when a Drive file changes mid-operation */
const sessionChangedResponse = () => ({ success: false, error: 'The current Drive video session changed.' });

/**
 * Higher-order middleware function ensuring a valid integer `tabId` exists in context.
 *
 * HOW IT WORKS:
 * Wraps an action handler with a check: `Number.isInteger(ctx.tabId)`.
 * If valid, delegates to `handler(ctx)`. Otherwise, returns `unauthorizedResponse()`.
 *
 * @param {Function} handler - Inner handler function
 * @param {Function} [unauthorizedResponse=invalidTabResponse] - Fallback response generator
 * @returns {Function}
 */
const requireDriveTab = (handler, unauthorizedResponse = invalidTabResponse) =>
    ctx => (Number.isInteger(ctx.tabId) ? handler(ctx) : unauthorizedResponse());

/**
 * Helper to fetch and validate the tab session for a specific Drive file ID.
 *
 * @param {number} tabId - Browser tab ID
 * @param {string} requestedFileId - Target Google Drive file ID
 * @returns {Promise<{session: Object, fileId: string}|null>} Session and resolved fileId or null
 */
async function getSessionForFile(tabId, requestedFileId) {
    const session = await getStoredSession(tabId);
    const fileId = String(requestedFileId || session?.fileId || '').trim();
    // Valid if session exists, fileId is non-empty, and matches session fileId
    const isCurrent = session && fileId && (!session.fileId || session.fileId === fileId);
    return isCurrent ? { session, fileId } : null;
}

// ============================================================================
// QUALITY PICKER UI SNAPSHOT STORAGE
// ============================================================================
// PURPOSE:
// Once the extension scans available qualities (e.g. 1080p, 720p, 360p) for a video,
// it saves a snapshot in storage. When the user re-opens the download modal,
// the options are displayed instantly from cache without re-opening Settings menu!
// ============================================================================

/**
 * Reads quality picker snapshots dictionary from a specified storage area.
 *
 * @param {chrome.storage.StorageArea} storageArea - session or local storage
 * @returns {Promise<Object>} Map of snapshots keyed by fileId
 */
async function readPickerSnapshots(storageArea) {
    const data = await storageArea.get(PICKER_SNAPSHOT_KEY);
    const snapshots = data?.[PICKER_SNAPSHOT_KEY];
    return snapshots && typeof snapshots === 'object' ? snapshots : {};
}

/**
 * Writes or updates a snapshot for a specific fileId.
 *
 * @param {chrome.storage.StorageArea} storageArea
 * @param {string} fileId
 * @param {Object} snapshot
 */
async function writePickerSnapshot(storageArea, fileId, snapshot) {
    const snapshots = await readPickerSnapshots(storageArea);
    snapshots[fileId] = snapshot;
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

/**
 * Deletes snapshot for a specific fileId.
 *
 * @param {chrome.storage.StorageArea} storageArea
 * @param {string} fileId
 */
async function deletePickerSnapshot(storageArea, fileId) {
    const snapshots = { ...await readPickerSnapshots(storageArea) };
    delete snapshots[fileId];
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

/**
 * Action: saveQualityPickerSnapshot
 * Persists quality options snapshot into session storage (falling back to local storage).
 */
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

/**
 * Action: loadQualityPickerSnapshot
 * Reads cached quality options snapshot for a fileId.
 */
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

/**
 * Action: clearQualityPickerSnapshot
 * Removes cached snapshot for a fileId from both storage areas.
 */
async function handleClearQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: true };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try { await deletePickerSnapshot(storageArea, fileId); } catch (_) {}
    }
    return { success: true };
}

/**
 * Action: setVideoContext
 * Initializes or updates the active video session when content script binds to a Drive page.
 *
 * HOW IT WORKS:
 * 1. Checks if current tab session exists and whether fileId/viewerSessionId changed.
 * 2. If changed, resets to a fresh `emptySession()`.
 * 3. Immediately enables `streamCaptureEnabled = true` so pre-download playback captures formats.
 * 4. Clears toolbar action badge if context changed.
 */
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

    // Enable stream capture immediately for active viewer session
    next.streamCaptureEnabled = true;
    if (!changed && pageBridgeId) next.pageBridgeId = pageBridgeId;

    await setStoredSession(tabId, next);
    if (changed) setBadge('');
    return { success: true, changed, session: next };
}

/**
 * Action: updateFilename
 * Renames the file in the tab's active session.
 */
async function handleUpdateFilename({ request, tabId }) {
    const filename = String(request.filename || '').trim();
    await queueSessionMutation(tabId, session => {
        if (!filename || session.filename === filename) return false;
        session.filename = filename;
        return session;
    });
    return { success: true };
}

/**
 * Action: videoPlaybackIntent
 * Marks streamCaptureEnabled = true when user hovers or clicks play.
 */
async function handleVideoPlaybackIntent({ request, tabId }) {
    await queueSessionMutation(tabId, session => {
        if (request.fileId && session.fileId && request.fileId !== session.fileId) return false;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

/**
 * Action: videoPlaybackStarted
 * Sets playbackStarted = true and streamCaptureEnabled = true.
 */
async function handleVideoPlaybackStarted({ tabId }) {
    await queueSessionMutation(tabId, session => {
        if (session.playbackStarted) return false;
        session.playbackStarted = true;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

/**
 * Validates that an incoming page-bridge stream belongs to the active viewer session.
 */
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

/**
 * Helper to update format lists and current pointers when a stream is captured.
 */
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

/**
 * Action: pageStreamDetected
 * Receives stream detection messages from content script fetch/XHR hooks (network-bridge.js).
 *
 * HOW IT WORKS:
 * 1. Parses stream URL into structured candidate.
 * 2. Tags candidate into in-memory probe buffer immediately (ensures zero-latency matching).
 * 3. Validates against active session.
 * 4. Persists format into storage session.
 * 5. Updates badge to "ON" and broadcasts `videoStreamDetected` to tab UI.
 */
async function handlePageStreamDetected({ request, tabId }) {
    const url = String(request.url || '').trim();
    if (!url || !url.includes('/videoplayback')) return { success: false, error: 'Not a Drive playback URL.' };

    const parsed = parseStreamCandidate(url, url);
    if (!parsed) return { success: false, error: 'Could not parse Drive playback URL.' };

    // Tag into the in-memory probe buffer FIRST (same as webRequest path)
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
            tagCandidateWithProbe(candidate, probe);
            const limit = (typeof PROBE_BUFFER_LIMIT === 'number') ? PROBE_BUFFER_LIMIT : 48;
            current.probeCandidates = addUniqueCandidate(
                Array.isArray(current.probeCandidates) ? current.probeCandidates : [],
                candidate,
                limit
            );
        }

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

/**
 * Action: listPlayerQualityLabels
 * Opens the Drive video player's Settings -> Quality menu and reads all available resolution options.
 *
 * HOW IT WORKS:
 * 1. Checks `QUALITY_SCAN_TAB_LOCK` to ensure no other scan is executing concurrently.
 * 2. Reveals player controls, clicks "Settings", then clicks "Quality".
 * 3. Dispatches `scanQualities` DOM action into all frames to inspect popup list items.
 * 4. Extracts heights (e.g. 1080, 720, 480, 360) and labels.
 * 5. Closes the player menu so UI returns to normal.
 * 6. Returns list of available resolutions sorted highest first.
 */
async function handleListPlayerQualityLabels({ request, tabId }) {
    const existing = QUALITY_SCAN_TAB_LOCK.get(tabId);
    if (existing?.promise) {
        return { success: false, error: 'Another quality operation is already running on this tab.', options: [] };
    }

    const work = (async () => {
        const found = await getSessionForFile(tabId, request.fileId);
        const fileId = String(found?.fileId || request.fileId || '').trim();

        // Localized string variants for Settings and Quality buttons
        const SETTINGS = ['settings', 'settings menu', 'player settings', 'video settings', 'open settings'];
        const QUALITY = ['quality', 'video quality', 'quality settings'];

        try {
            let options = [];
            let lastError = '';

            for (let attempt = 0; attempt < 2 && !options.length; attempt++) {
                await closePlayerMenu(tabId);
                await sleep(150 + attempt * 100);
                try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}

                // Open Settings menu
                const settings = await clickMenuLikeMini(tabId, SETTINGS, 'Settings', 5000, true);
                if (!settings?.ok) {
                    lastError = settings?.reason || 'Could not open Settings.';
                    continue;
                }
                await sleep(300);

                // Open Quality submenu
                const quality = await clickMenuLikeMini(
                    tabId, QUALITY, 'Quality', 5000, false,
                    Number.isInteger(settings.frameId) ? settings.frameId : null
                );
                if (!quality?.ok) {
                    lastError = quality?.reason || 'Could not open Quality menu.';
                    continue;
                }
                await sleep(300);

                // Scan quality options while submenu is visible
                const deadline = Date.now() + 4000;
                while (Date.now() < deadline) {
                    const rows = await runQualityDom(tabId, 'scanQualities');
                    const byHeight = new Map();
                    for (const row of rows || []) {
                        const value = row?.value;
                        const list = Array.isArray(value?.options) ? value.options
                            : Array.isArray(value) ? value
                            : [];
                        for (const opt of list) {
                            if (typeof opt === 'string') {
                                const h = Number(String(opt).match(/(\d{3,4})p/i)?.[1] || 0);
                                if (h) byHeight.set(h, { height: h, label: String(opt).trim(), selected: false });
                                continue;
                            }
                            const h = Number(opt?.height || 0);
                            if (!h) continue;
                            const lab = String(opt.text || opt.label || `${h}p`).trim();
                            const prev = byHeight.get(h);
                            if (!prev || opt.selected) byHeight.set(h, { height: h, label: lab, selected: !!opt.selected });
                        }
                        for (const lab of (value?.labels || [])) {
                            const h = Number(String(lab).match(/(\d{3,4})p/i)?.[1] || 0);
                            if (h && !byHeight.has(h)) {
                                byHeight.set(h, { height: h, label: String(lab).trim(), selected: false });
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
        }
    })();

    // Store in lock Map
    QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: work, finishedAt: 0 });
    try {
        return await work;
    } finally {
        QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: null, finishedAt: Date.now() });
    }
}

/**
 * Action: captureQualityForDownload
 * When user selects a quality in the UI:
 * 1. Simulates click on that quality in the player.
 * 2. Nudges playback to force segment requests.
 * 3. Waits for the video stream URL for that quality.
 * 4. Resolves shared audio track.
 * 5. Returns both streams ready for download.
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

    // Concurrency lock
    const existing = QUALITY_SCAN_TAB_LOCK.get(tabId);
    if (existing?.promise) {
        return { success: false, error: 'Another quality capture is already running.' };
    }

    const work = (async () => {
        try {
            const clickAt = Date.now();

            await closePlayerMenu(tabId);
            await sleep(120);
            try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}
            await sleep(100);

            // Select quality verified in player menu
            const selected = await selectQualityVerified(
                tabId, label || `${height}p`, height, 8000, null
            );
            if (!selected?.ok) {
                return { success: false, error: `Could not find ${label || height + 'p'} in the quality menu.` };
            }

            // Snapshot stream currently playing (in case user re-selected current quality)
            const harvestCurrentVideo = () => {
                const recent = (streamCaptureState(tabId)?.recentStreams || [])
                    .filter(s => s?.url && !isAudioStream(s))
                    .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
                if (recent[0]?.url) return recent[0];
                return null;
            };
            const alreadyPlaying = harvestCurrentVideo();

            // Nudge playback to trigger HTTP segment request
            try { await nudgePlaybackAfterQualitySwitch(tabId); } catch (_) {}

            // Start quality probe transaction
            const probe = await beginQualityProbe(tabId, fileId, label || `${height}p`);
            if (probe && probe.accepted === false) {
                return { success: false, error: 'Session changed during quality capture. Open the video again and retry.' };
            }

            let video = null;
            try {
                // Wait for network capture matching probe
                video = await waitForQualityStream(tabId, probe.token, height, (typeof FAST_SCAN !== "undefined" ? FAST_SCAN.streamWaitMs : 1500), new Set(), clickAt);
                if (!video?.url) {
                    const recentAfter = (streamCaptureState(tabId)?.recentStreams || [])
                        .filter(s => s?.url && !isAudioStream(s) && Number(s.capturedAt || 0) >= clickAt - 50)
                        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
                    video = recentAfter[0] || null;
                }
                // Fallback to already playing stream if Drive didn't fire a new request
                if (!video?.url && alreadyPlaying?.url) {
                    video = alreadyPlaying;
                }
                // Final fallback to session video
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

            // Stamp verified height
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
                video.requestedHeight = height;
                video.requestedLabel = label;
            }

            // Prefer the freshest audio seen around this capture (stale session
            // audio URLs often return a ~1 KB error body on range download).
            const recentAudio = (streamCaptureState(tabId)?.recentStreams || [])
                .filter(s => s?.url && isAudioStream(s))
                .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
            const audioAfterClick = recentAudio.find(s => Number(s.capturedAt || 0) >= clickAt - 50) || null;
            let audio = audioAfterClick
                || recentAudio[0]
                || await getCurrentSessionAudioCandidate(tabId)
                || (typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null);
            if (audio?.url) {
                audio = {
                    ...audio,
                    url: cleanURL(audio.originalUrl || audio.url) || audio.url,
                    originalUrl: audio.originalUrl || audio.url
                };
                try { await lockSharedAudioOnSession(tabId, audio); } catch (_) {}
            }

            // Persist video and audio formats into stored session
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

/**
 * Action: clearTabCaptureState
 * Wipes capture state for a tab upon request.
 */
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
            try { await chrome.storage.local.remove(['psdGlobalStreams']); } catch (_) {}
        }
    } catch (_) {}
    return { success: true };
}

/**
 * Action: getStreams
 * Aggregates all discovered streams and formats for the tab, merging recent captures.
 */
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

    const recentVideo = recent.filter(s => s?.url && !isAudioStream(s));
    const recentAudio = recent.filter(s => s?.url && isAudioStream(s));

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

    // Merge recent video captures
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

    // Merge global fallback video
    if (globalVideo?.url && !(session.formats.video || []).length && !(session.formats.progressive || []).length) {
        session.videoCandidates = addUniqueCandidate(session.videoCandidates, globalVideo, 24);
        session.formats.video = mergeFormatLists(session.formats.video || [], [globalVideo], byHeightWidthThenSize, 48);
        session.video = globalVideo.url;
        session.videoOriginal = globalVideo.originalUrl || globalVideo.url;
    }

    // Merge recent audio captures
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

    // Persist merged state into storage
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

/**
 * Action: downloadVideo
 * Initiates the video download process.
 */
const handleDownloadVideo = ({ request, tabId }) => startVideoDownload(tabId, request || {});

/**
 * Type: getVideoStageJob
 * Retrieves staging job metadata requested by offscreen downloader.
 */
async function handleGetVideoStageJob({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
}

/** Set of terminal stage job event types */
const FINISHED_STAGE_TYPES = new Set(['videoStageFinished', 'videoStageError', 'videoStageCancelled']);

/**
 * Cancels an active video download staging job.
 *
 * @param {string} jobId - Job ID
 * @param {Object} job - Stored job object
 * @param {Object} [options]
 * @param {boolean} [options.silent=false] - If true, do not send cancellation event to tab
 */
async function cancelVideoStage(jobId, job, options = {}) {
    sendOffscreen({ type: 'videoStageCancelInternal', jobId });
    if (!options.silent && job?.sourceTabId != null) {
        await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId });
    }
    await removeVideoStageJob(jobId);
    // Schedule check to close offscreen document
    setTimeout(closeVideoOffscreen, 100);
    return { success: true };
}

/**
 * Restarts a stuck download job without losing progress.
 *
 * The job record (stream URLs, sizes) lives in storage, so this works even if
 * the offscreen document was closed/recreated while the download was stalled.
 * The offscreen side decides whether to resume the live run or start over.
 *
 * @param {string} jobId - Job ID
 */
async function restartVideoStage(jobId) {
    const job = (await getStoredJobs())[jobId];
    if (!job) return { success: false, error: 'This download is no longer active.' };
    try {
        await ensureVideoOffscreen();
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
    sendOffscreen({ type: 'videoStageRestartInternal', jobId });
    return { success: true };
}

/**
 * Relays progress and lifecycle messages from offscreen chunk downloader to tab UI.
 */
async function handleVideoStageMessage({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    const isCancel = request.type === 'videoStageCancel';

    // Restart comes from the tab's overlay; it is a command, not a status to relay back.
    if (request.type === 'videoStageRestart') return restartVideoStage(request.jobId);

    // Forward progress/status message to originating tab UI
    if (job?.sourceTabId != null && !isCancel) await sendTab(job.sourceTabId, { type: request.type, ...request });
    if (isCancel) return cancelVideoStage(request.jobId, job);

    // If job finished, errored, or cancelled, clean up resources
    if (FINISHED_STAGE_TYPES.has(request.type)) {
        await queueJobMutation(currentJobs => {
            if (!currentJobs[request.jobId]) return false;
            delete currentJobs[request.jobId];
            return true;
        });
        setTimeout(closeVideoOffscreen, 1200);
    }
    return { success: true };
}

/**
 * Map of actions keyed by `request.action`.
 */
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
    downloadVideo: handleDownloadVideo
});

/**
 * Map of handlers keyed by `request.type`.
 */
const TYPE_HANDLERS = Object.freeze({
    getVideoStageJob: handleGetVideoStageJob
});

/**
 * Central runtime message dispatcher.
 * Resolves target tabId from request or sender and routes to matching handler.
 *
 * @param {Object} request - Incoming JSON payload
 * @param {Object} sender - Sender metadata from Chrome
 * @returns {Promise<*>}
 */
async function handleRuntimeMessage(request = {}, sender = {}) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    const ctx = { request, sender, tabId };

    // 1. Check action-based handlers
    const actionHandler = ACTION_HANDLERS[String(request.action || '')];
    if (actionHandler) return actionHandler(ctx);

    // 2. Check type-based handlers
    const type = String(request.type || '');
    const typeHandler = TYPE_HANDLERS[type];
    if (typeHandler) return typeHandler(ctx);

    // 3. Check video stage messages (progress, cancel, finish) from offscreen
    if (type.startsWith('videoStage')) return handleVideoStageMessage(ctx);

    return undefined;
}

/**
 * Root Chrome Extension message listener.
 *
 * HOW IT WORKS:
 * - Registered on `chrome.runtime.onMessage`.
 * - Returning `true` informs Chrome that `sendResponse` will be called asynchronously!
 * - Catches any uncaught Promise rejections and replies with `{ success: false, error }`.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
    return true; // Keep message channel open for async response
});
