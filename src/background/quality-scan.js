// ============================================================================
// FILE: src/background/quality-scan.js
// PURPOSE: Handles stream detection and capture matching following a quality switch.
//          Waits for Google Drive's video player to initiate new HTTP chunk requests
//          matching the requested resolution, nudges playback if stalled, and binds
//          the corresponding audio stream to the download session.
// ============================================================================

/**
 * Generates a stable unique deduplication key for a video/audio stream URL.
 *
 * HOW IT WORKS:
 * 1. Checks if the stream URL contains Google video stream parameters:
 *    - `itag`: Google's media format identifier (e.g. 137 for 1080p, 140 for 128k audio)
 *    - `id`: Unique media session identifier
 * 2. If present, returns `itag:<itag>|id:<id>`.
 * 3. Otherwise, strips range/query noise using `cleanURL` and returns the normalized URL.
 *
 * PURPOSE:
 * Google Drive requests video in small ranged segments (e.g. range=0-1000000).
 * Different chunks of the exact same video stream have identical `itag` and `id`.
 * This key ensures we treat all chunks of the same stream as one logical format.
 *
 * @param {Object} stream - Stream object containing url or originalUrl
 * @returns {string} Unique stream key or cleaned URL
 */
function streamUrlKey(stream) {
    const raw = String(stream?.originalUrl || stream?.url || '');
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const itag = u.searchParams.get('itag') || '';
        const id = u.searchParams.get('id') || '';
        // If Google stream params exist, use them as canonical key
        return itag ? `itag:${itag}|id:${id}` : cleanURL(raw) || raw;
    } catch (_) {
        // Fallback to URL stripped of query parameters
        return cleanURL(raw) || raw;
    }
}

/**
 * Polls for an incoming video stream captured after a quality click was performed.
 *
 * HOW IT WORKS:
 * 1. Calculates a deadline (min 800ms, default 2500ms).
 * 2. Pulls captured streams from both `state.probeBuffer` and `state.recentStreams`.
 * 3. Filters out audio streams, sorting newest first.
 * 4. Filters by:
 *    - Captured timestamp: Must be captured after `clickAt - 50ms` (grace period for slight clock drift).
 *    - Probe token: Must match active probe token if one was tagged.
 *    - usedUrls: Excludes previously matched streams.
 *    - Height matching: Checks if vertical resolution matches requested height.
 *
 * COMPLICATION & ARCHITECTURAL DETAIL:
 * Why `Math.abs(sh - h) > 8`?
 * Video encoding standards (AVC/H.264) often require dimensions to be divisible by
 * macroblock boundaries (16x16 pixels). For example, a 1080p stream may report an
 * encoded height of 1088px. The 8-pixel tolerance prevents false negatives.
 *
 * @param {number} tabId - Browser tab ID
 * @param {string} probeToken - Unique probe token
 * @param {number} height - Target height in pixels (e.g. 1080, 720)
 * @param {number} waitMs - Max duration to wait
 * @param {Set<string>} [usedUrls=new Set()] - Set of stream keys already consumed
 * @param {number} [clickAt=0] - Timestamp when user clicked the quality option
 * @returns {Promise<Object|null>} Matching stream object or null if timed out
 */
async function waitForQualityStream(tabId, probeToken, height, waitMs, usedUrls = new Set(), clickAt = 0) {
    const deadline = Date.now() + Math.max(800, Number(waitMs) || 2500);
    const h = Number(height) || 0;
    const minAt = Number(clickAt) || 0;

    while (Date.now() < deadline) {
        const state = streamCaptureState(tabId);
        const recent = Array.isArray(state?.recentStreams) ? state.recentStreams : [];
        const probeBuf = Array.isArray(state?.probeBuffer) ? state.probeBuffer : [];

        // Combine probe buffer and recent captures, filter out audio, sort newest first
        const pool = [...probeBuf, ...recent]
            .filter(s => s?.url && !isAudioStream(s))
            .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));

        for (const stream of pool) {
            // Ignore streams captured before the user initiated the quality switch
            if (minAt && Number(stream.capturedAt || 0) < minAt - 50) continue;
            // Ignore streams belonging to a different concurrent probe
            if (probeToken && stream.probeToken && stream.probeToken !== probeToken) continue;

            const key = streamUrlKey(stream);
            // Skip streams that were already downloaded or consumed
            if (key && usedUrls.has(key)) continue;

            // Height matching with 8-pixel macroblock tolerance
            if (h && Number(stream.qualityHeight || stream.height || 0) > 0) {
                const sh = Number(stream.qualityHeight || stream.height || 0);
                if (sh !== h && Math.abs(sh - h) > 8) continue;
            }

            // Stream matched all criteria!
            return stream;
        }

        // Wait 200ms before checking buffer again
        await sleep(200);
    }

    return null;
}

/**
 * Seeks video playback forward by 1 second to force Google Drive to buffer new segments.
 *
 * PURPOSE:
 * Sometimes when switching quality, the player keeps playing out of its old buffer
 * and does not request new chunks immediately. Nudging playback forces an eviction
 * of the buffer and triggers immediate network requests for the new resolution.
 *
 * @param {number} tabId - Target tab ID
 */
async function nudgePlaybackAfterQualitySwitch(tabId) {
    try { await runQualityDom(tabId, 'nudgePlayback', { seconds: 1 }); } catch (_) {}
    try { await resumePlaybackAfterQualitySwitch(tabId); } catch (_) {}
}

/**
 * Attaches the shared audio stream to the tab's active video session.
 *
 * HOW IT WORKS & PURPOSE:
 * Google Drive uses adaptive DASH/separate streams for video and audio.
 * A 1080p video stream has no embedded audio. The downloader must pair the video
 * stream with an audio stream to produce a complete MP4 file.
 * This function persists the selected audio track to `session.audio`, adds it to
 * `audioCandidates`, and establishes `formats.audio` in storage.
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} audio - Captured audio stream descriptor
 */
async function lockSharedAudioOnSession(tabId, audio) {
    if (!audio?.url) return;
    // Clean query parameters like byte range limits from the URL
    const cleaned = cleanURL(audio.originalUrl || audio.url) || audio.url;

    // Atomically update session in storage
    await queueSessionMutation(tabId, current => {
        if (!current) return false;
        current.audio = cleaned;
        current.audioOriginal = audio.originalUrl || audio.url;

        // Add to candidate list (max 8 entries)
        current.audioCandidates = addUniqueCandidate(
            Array.isArray(current.audioCandidates) ? current.audioCandidates : [],
            { ...audio, url: cleaned },
            8
        );

        // Initialize formats container if missing
        current.formats = current.formats || { video: [], audio: [], progressive: [] };

        // Save canonical audio format entry
        current.formats.audio = [{
            ...audio,
            url: cleaned,
            originalUrl: audio.originalUrl || audio.url,
            id: audio.id || `audio:${audio.itag || ''}`
        }];

        return current;
    });
}
