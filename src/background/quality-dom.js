// ============================================================================
// FILE: src/background/quality-dom.js
// PURPOSE: Cross-frame DOM bridge. Dispatches UI automation actions from the
//          background service worker into the target browser tab and its iframes
//          using chrome.scripting.executeScript.
//
// WHY THIS EXISTS:
// In Google Drive, video preview players are frequently rendered inside nested
// iframes. Background scripts cannot access page DOM directly. This module queries
// frames in the tab and invokes methods on `window.__driveQualityActions` (registered
// by src/content/automation/quality-trigger.js in the content script world).
// ============================================================================

/**
 * Injection function executed directly in the content script context of a target frame.
 *
 * HOW IT WORKS:
 * 1. Checks if `window.__driveQualityActions` was exposed by the content script.
 * 2. If the action method exists, invokes it with the supplied arguments.
 * 3. Wraps the return value in a Promise and returns `{ found: true, value }`.
 * 4. Catches errors and returns `{ found: true, error: message }`.
 *
 * NOTE ON SERIALIZATION:
 * Chrome's `scripting.executeScript` automatically awaits returned Promises
 * before sending the result back to the background worker. The return value
 * must be JSON-cloneable.
 *
 * @param {string} actionName - The method name to execute on window.__driveQualityActions
 * @param {Array<*>} actionArgs - Arguments to spread into the action function
 * @returns {Promise<{found: boolean, value?: *, error?: string}>|{found: boolean}}
 */
function psdCallTriggerAction(actionName, actionArgs) {
    // Reference the global bridge object created by content/automation/quality-trigger.js
    const api = window.__driveQualityActions;
    // If the content script isn't loaded in this frame or doesn't support this action, exit
    if (!api || typeof api[actionName] !== 'function') return { found: false };

    try {
        // Execute the action with unpacked arguments
        const value = api[actionName](...(actionArgs || []));
        // Await potential Promise and format standardized success response
        return Promise.resolve(value).then(v => ({ found: true, value: v }));
    } catch (e) {
        // Return standardized error response instead of crashing script execution
        return { found: true, error: e?.message || String(e) };
    }
}

/**
 * Injects and runs `psdCallTriggerAction` in a specific frame using Chrome Scripting API.
 *
 * @param {number} tabId - Browser tab ID
 * @param {number} frameId - Specific frame ID (0 is top window)
 * @param {string} action - Action name (e.g. "clickQuality", "scanQualities")
 * @param {Array<*>} args - Arguments to pass
 * @returns {Promise<{found: boolean, value?: *, error?: string}>}
 */
async function invokeTrigger(tabId, frameId, action, args) {
    try {
        // Execute the function in the specified frame
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: psdCallTriggerAction,
            args: [action, args]
        });
        // executeScript returns an array of InjectionResult objects; result property contains return value
        return results?.[0]?.result || { found: false };
    } catch (_) {
        // Frame might have been removed, detached, or access restricted by CSP
        return { found: false };
    }
}

/**
 * Helper that invokes an action in a frame and packages frameId with the result.
 *
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} action
 * @param {Array<*>} args
 * @returns {Promise<{frameId: number, value: *, error: string}|null>}
 */
async function callTriggerInFrame(tabId, frameId, action, args) {
    const result = await invokeTrigger(tabId, frameId, action, args);
    // If content script was not found in this frame, skip it
    if (!result?.found) return null;
    return { frameId, value: result.value, error: result.error };
}

/**
 * Resolves which frame IDs to target: either a specific frameId or all frames in the tab.
 *
 * @param {number} tabId - Browser tab ID
 * @param {number|undefined} frameId - Specific frame ID if known
 * @returns {Promise<Array<number>>} List of frame IDs to target
 */
async function getTargetFrameIds(tabId, frameId) {
    // If a specific integer frame was requested, target only that frame
    if (Number.isInteger(frameId)) return [frameId];
    try {
        // Query webNavigation for all active frames (main frame + iframes) in this tab
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        return (frames || []).map(f => f.frameId);
    } catch (_) {
        // Fallback to main top-level frame (frameId 0) if webNavigation fails
        return [0];
    }
}

/**
 * Executes a quality automation DOM action across one or all frames in a tab.
 *
 * COMPLICATION & CAN BE WRITTEN IN A BETTER WAY:
 * Notice the ternary argument builder below (lines 118-124). It contains references
 * to `'enableMuteGuard'` and `'releaseMuteGuard'`, which are legacy actions that were
 * removed from the codebase in recent refactorings.
 * Better way: Use a Set or simple lookup dictionary for zero-argument actions:
 *   const NO_ARG_ACTIONS = new Set(['closeMenu', 'revealControls', 'scanQualities', 'resumePlayback']);
 *   const finalArgs = NO_ARG_ACTIONS.has(action) ? [] : [params];
 *
 * @param {number} tabId - Target tab ID
 * @param {string} action - Method name to call
 * @param {Object} [params={}] - Parameters passed to the DOM action
 * @param {Object} [options={}] - Options including optional frameId
 * @returns {Promise<Array<{frameId: number, value: *, error?: string}>>}
 */
async function runQualityDom(tabId, action, params = {}, options = {}) {
    // Determine target frame IDs (either single preferred frame or all frames)
    const frameIds = await getTargetFrameIds(tabId, options.frameId);

    // Determine argument structure based on action name
    const finalArgs = (action === 'clickLabel' || action === 'clickQuality' || action === 'nudgePlayback')
        ? [params]
        : (action === 'enableMuteGuard' || action === 'releaseMuteGuard' || action === 'closeMenu' || action === 'revealControls'
            || action === 'scanQualities' || action === 'resumePlayback')
            ? []
            : [params];

    // Whether this action simulates user clicking on the player UI
    const isClickAction = action === 'clickLabel' || action === 'clickQuality';
    const rows = [];

    // Iterate through all candidate frames
    for (const frameId of frameIds) {
        const row = await callTriggerInFrame(tabId, frameId, action, finalArgs);
        if (row) {
            rows.push(row);
            // CRITICAL SHORT-CIRCUIT:
            // When broadcasting to all frames, stop immediately after the first successful
            // click to prevent duplicate clicks on player controls across multiple nested frames!
            if (isClickAction && (row.value?.ok || row.value === true) && !Number.isInteger(options.frameId)) {
                break;
            }
        }
    }
    return rows;
}

/**
 * Finds the first successful frame response in a list of frame execution results.
 *
 * @param {Array<Object>} rows - Array of results from runQualityDom
 * @returns {Object|null} The first successful result row or null
 */
function firstOk(rows) {
    return (rows || []).find(r => r?.value?.ok || r?.value === true) || null;
}

/**
 * Closes the Drive player's Settings / Quality popup menu if it is currently open.
 *
 * @param {number} tabId - Target tab ID
 */
async function closePlayerMenu(tabId) {
    try {
        await runQualityDom(tabId, 'closeMenu');
    } catch (_) {
        // Ignore errors if menu is already closed or tab is unresponsive
    }
}
