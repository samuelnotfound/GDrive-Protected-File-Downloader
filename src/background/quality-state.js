// ============================================================================
// FILE: src/background/quality-state.js
// PURPOSE: Manages video quality probing transactions. When the extension tests
//          or switches a resolution in Google Drive's video player, it marks
//          a time window with a unique probe token so network streams captured
//          during that window are attributed to the targeted quality level.
// ============================================================================

/**
 * Initiates a quality probe session for a given tab.
 *
 * HOW IT WORKS:
 * 1. Generates a unique probe token combining timestamp and random alphanumeric string.
 * 2. Queues a mutation to the persisted tab session in storage:
 *    - Validates fileId matches current session to prevent cross-file race conditions.
 *    - Stores `activeQualityProbe` metadata and clears old probe candidates.
 *    - Enables network stream capture flag.
 * 3. If storage mutation was accepted, initializes in-memory probe buffer in `streamCaptureState`.
 *
 * COMPLICATION & ARCHITECTURAL FIX:
 * Earlier versions updated the in-memory state unconditionally before the storage write.
 * If the storage mutation was rejected (e.g., fileId mismatch due to navigation),
 * memory and storage diverged. Setting memory only when `accepted === true` guarantees consistency.
 *
 * @param {number} tabId - Browser tab ID
 * @param {string} fileId - Google Drive file ID
 * @param {string} label - The human-readable quality label (e.g. "1080p", "720p", "Auto")
 * @returns {Promise<{token: string, startedAt: number, session: Object, accepted: boolean}>}
 */
async function beginQualityProbe(tabId, fileId, label) {
    // Unique identifier combining timestamp and random 6-character base-36 string
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Record start time to measure probe duration
    const startedAt = Date.now();
    // Retrieve in-memory capture state structure for this tab
    const state = streamCaptureState(tabId);
    let result = null;
    let accepted = false;

    // Concurrently safe mutation of persisted session in chrome.storage
    await queueSessionMutation(tabId, session => {
        // If fileId differs, tab navigated away from the requested file; reject mutation
        if (fileId && session.fileId && session.fileId !== fileId) return false;

        // Save active probe metadata
        session.activeQualityProbe = { token, label: String(label || ''), startedAt };
        // Ensure webRequest interceptor is capturing streams
        session.streamCaptureEnabled = true;
        // Reset candidate buffer for this fresh probe
        session.probeCandidates = [];
        result = session;
        accepted = true;
        return session;
    });

    // Only start the in-memory probe when the session mutation was accepted
    if (accepted) {
        state.activeProbe = { token, label: String(label || ''), startedAt };
        state.probeBuffer = [];
    }

    return { token, startedAt, session: result, accepted };
}

/**
 * Segregates stream candidates into video vs audio categories.
 *
 * HOW IT WORKS & PURPOSE:
 * 1. Filters items matching the active probe token (or keeps all if token is empty).
 * 2. Uses `isAudioStream` helper to distinguish audio from video.
 * 3. Identifies video candidates via mime type regex (`/video/i`), numeric height, or itag.
 *
 * COMPLICATION IN GOOGLE DRIVE:
 * Google Drive's video player often omits standard `Content-Type: video/mp4` headers
 * or returns generic mime types on chunk segments. Checking itags and non-zero height
 * ensures video streams are correctly classified even when mime headers are missing.
 *
 * @param {Array<Object>} all - Array of captured stream metadata objects
 * @param {string} token - Probe token to filter by
 * @returns {{video: Array<Object>, audio: Array<Object>}}
 */
function filterProbeCandidates(all = [], token = '') {
    // Normalize input to an array
    const list = Array.isArray(all) ? all : [];
    // Filter by probe token if one was specified
    const filtered = token ? list.filter(item => item?.probeToken === token) : list;

    return {
        // Exclude audio itags even when mime is missing (Drive often omits it)
        video: filtered.filter(item => {
            // Must have a valid URL and not be classified as an audio stream
            if (!item?.url || isAudioStream(item)) return false;
            // Video heuristics: mime mentions video, valid itag present, or height > 0
            return /video/i.test(String(item?.mime || '')) || !!item?.itag || Number(item?.height || 0) > 0;
        }),
        // Audio streams classified by isAudioStream helper
        audio: filtered.filter(isAudioStream)
    };
}

/**
 * Concludes an active quality probe, aggregating collected video and audio streams.
 *
 * HOW IT WORKS:
 * 1. Reads captured streams from the in-memory buffer (`state.probeBuffer`).
 * 2. Atomically updates stored session: checks probe token matches, combines stored
 *    and in-memory candidates, clears `activeQualityProbe`, and disables capture if playback not active.
 * 3. Clears in-memory active probe and buffer.
 * 4. Deduplicates and sorts the resulting video formats (by height then size) and audio formats (by size desc).
 *
 * @param {number} tabId - Browser tab ID
 * @param {string} token - The probe token to finalize
 * @returns {Promise<{video: Array<Object>, audio: Array<Object>}>} Deduplicated, sorted format lists
 */
async function endQualityProbe(tabId, token) {
    // Retrieve in-memory state
    const state = streamCaptureState(tabId);
    // Filter candidate streams captured in memory during the probe
    let result = filterProbeCandidates(Array.isArray(state.probeBuffer) ? state.probeBuffer : [], token);

    // Atomically merge with any candidates persisted to storage
    await queueSessionMutation(tabId, session => {
        const probe = session.activeQualityProbe;
        // If no active probe or token mismatch (probe was cancelled or superseded), abort
        if (!probe || (token && probe.token !== token)) return false;

        const stored = filterProbeCandidates(Array.isArray(session.probeCandidates) ? session.probeCandidates : [], token);
        // Combine in-memory and stored stream lists
        result = {
            video: [...result.video, ...stored.video],
            audio: [...result.audio, ...stored.audio]
        };

        // Reset probe fields
        session.activeQualityProbe = null;
        session.probeCandidates = [];
        // If video playback hasn't actively started, disable capture to save CPU
        if (!session.playbackStarted) session.streamCaptureEnabled = false;
        return session;
    });

    // Clear memory state if token matches
    if (state.activeProbe?.token === token) state.activeProbe = null;
    state.probeBuffer = [];

    // Return deduplicated, sorted format lists (max 48 formats each)
    return {
        video: mergeFormatLists([], result.video, byHeightThenSize, 48),
        audio: mergeFormatLists([], result.audio, bySizeDesc, 48)
    };
}

/**
 * Finds the best available audio stream candidate for the current tab session.
 *
 * HOW IT WORKS:
 * 1. Pools audio candidates from persisted storage (`session.audioCandidates`)
 *    and ephemeral in-memory streams (`state.recentStreams`).
 * 2. Filters out empty URLs and deduplicates via `dedupeAudioFormats`.
 * 3. Sorts by content length descending (highest bitrate/full file first),
 *    using captured timestamp as a tie-breaker.
 *
 * @param {number} tabId - Browser tab ID
 * @returns {Promise<Object|null>} The best audio stream candidate or null
 */
async function getCurrentSessionAudioCandidate(tabId) {
    const session = await getStoredSession(tabId);
    const state = streamCaptureState(tabId);

    // Pool candidates from both storage and memory
    const pool = [
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(Array.isArray(state?.recentStreams) ? state.recentStreams.filter(isAudioStream) : [])
    ].filter(item => item?.url);

    // Deduplicate and select highest quality candidate
    return dedupeAudioFormats(pool).sort((a, b) =>
        // Primary sort: highest Content-Length (larger audio payload)
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        // Secondary sort: most recently captured stream
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;
}
