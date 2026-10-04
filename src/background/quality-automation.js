// ============================================================================
// FILE: src/background/quality-automation.js
// PURPOSE: High-level UI automation routines for interacting with the Google Drive
//          embedded video player. Simulates user interactions to open Settings,
//          navigate to Quality, select resolution labels, and resume video playback.
// ============================================================================

/**
 * Ensures video playback continues after switching qualities.
 *
 * PURPOSE:
 * When switching quality in Google Drive's player, the video may pause or stall
 * while buffering new chunks. This function triggers `resumePlayback` in the content
 * script to unpause the HTML5 `<video>` element if needed.
 *
 * @param {number} tabId - Target tab ID
 * @returns {Promise<boolean>} True if playback was successfully resumed in any frame
 */
async function resumePlaybackAfterQualitySwitch(tabId) {
    try {
        // Broadcast 'resumePlayback' action to all frames containing video elements
        const rows = await runQualityDom(tabId, 'resumePlayback');
        // Return true if any frame confirmed the video is playing
        return (rows || []).some(r => r?.value?.ok || r?.value === true);
    } catch (_) {
        // Return false on communication or script execution failure
        return false;
    }
}

/**
 * Repeatedly attempts to find and click a specific UI menu item by text label.
 *
 * HOW IT WORKS:
 * 1. Computes an absolute timestamp deadline (at least 1500ms, default 7000ms).
 * 2. Scopes execution to `preferredFrameId` if provided; otherwise searches all frames.
 * 3. Polling loop:
 *    - Optionally calls `revealControls` to simulate mouse movement over player.
 *    - Dispatches `clickLabel` with target label strings.
 *    - If clicked successfully (`firstOk`), returns immediately with the frameId and label.
 *    - Otherwise sleeps 120ms before retrying.
 * 4. Returns `{ ok: false }` if deadline expires without success.
 *
 * COMPLICATION & CAN BE WRITTEN IN A BETTER WAY:
 * - Fixed polling (120ms sleep): If the menu is slow to render (e.g. slow connection),
 *   this sends up to ~58 `executeScript` IPC messages per 7 seconds. An event-driven
 *   or MutationObserver callback from the content script would be more efficient than
 *   repeated polling from the background worker.
 *
 * @param {number} tabId - Browser tab ID
 * @param {Array<string>} labels - List of label variants to match (e.g. ["Quality", "Calidad", "Qualité"])
 * @param {string} labelName - Display name used for diagnostic error messages
 * @param {number} timeoutMs - Max duration to retry
 * @param {boolean} [reveal=false] - Whether to simulate mouse hover to reveal player controls
 * @param {number|null} [preferredFrameId=null] - Specific frame containing player
 * @returns {Promise<{ok: boolean, frameId?: number, label?: string, method?: string, reason?: string}>}
 */
async function clickMenuLikeMini(tabId, labels, labelName, timeoutMs, reveal = false, preferredFrameId = null) {
    // Calculate expiration timestamp
    const deadline = Date.now() + Math.max(1500, Number(timeoutMs) || 7000);
    // Narrow scope to preferred frame if already known
    const frameScope = Number.isInteger(preferredFrameId) ? { frameId: Number(preferredFrameId) } : {};

    // Polling retry loop
    while (Date.now() < deadline) {
        // If controls auto-hide, trigger mouse hover event to display overlay controls
        if (reveal) {
            try { await runQualityDom(tabId, 'revealControls', {}, frameScope); } catch (_) {}
        }

        // Attempt to find and click any element matching the target labels
        const rows = await runQualityDom(tabId, 'clickLabel', {
            labels,
            reveal: !!reveal
        }, frameScope);

        // Check if any frame reported a successful click
        const hit = firstOk(rows);
        if (hit?.value?.ok || hit?.value === true) {
            return {
                ok: true,
                frameId: hit.frameId,
                label: hit.value?.label || labelName,
                method: 'clickLabel'
            };
        }

        // Wait 120ms between DOM queries to avoid hammering the main thread
        await sleep(120);
    }

    // Timeout exceeded without finding the menu item
    return { ok: false, reason: `Could not find ${labelName}.` };
}

/**
 * Automates opening Settings, expanding the Quality sub-menu, and clicking a specific resolution.
 *
 * HOW IT WORKS:
 * 1. Sets a deadline (min 1500ms, default 7000ms).
 * 2. Calls `clickQuality` via `runQualityDom`, passing the desired resolution height (e.g. 1080) and label.
 * 3. The content script handles opening the gear icon, locating the quality item, and clicking it.
 * 4. If confirmed clicked, pauses 200ms to allow Google Drive's player to register the click,
 *    then returns success with the target frameId.
 * 5. If not yet clicked, sleeps 150ms and retries until timeout.
 *
 * @param {number} tabId - Target tab ID
 * @param {string} label - Target quality text (e.g. "1080p", "720p HD", "360p")
 * @param {number} height - Vertical resolution in pixels (e.g. 1080, 720)
 * @param {number} timeoutMs - Timeout duration in milliseconds
 * @param {number|null} [preferredFrameId=null] - Known frameId for the player
 * @returns {Promise<{ok: boolean, frameId?: number, label?: string, method?: string, reason?: string}>}
 */
async function selectQualityVerified(tabId, label, height, timeoutMs, preferredFrameId = null) {
    const deadline = Date.now() + Math.max(1500, Number(timeoutMs) || 7000);
    const frameScope = Number.isInteger(preferredFrameId) ? { frameId: Number(preferredFrameId) } : {};

    while (Date.now() < deadline) {
        // clickQuality in quality-trigger.js opens Settings → Quality → option with direct fallbacks
        const viaQuality = firstOk(await runQualityDom(tabId, 'clickQuality', {
            height: Number(height) || 0,
            label,
        }, frameScope));

        // If the quality option was successfully clicked
        if (viaQuality?.value?.ok) {
            // Short grace period for Drive player's menu animation and network event initiation
            await sleep(200);
            return {
                ok: true,
                frameId: viaQuality.frameId,
                label: viaQuality.value.label || label,
                method: 'clickQuality'
            };
        }

        // Wait 150ms before polling again
        await sleep(150);
    }

    return { ok: false, reason: `Could not select ${label}.` };
}
