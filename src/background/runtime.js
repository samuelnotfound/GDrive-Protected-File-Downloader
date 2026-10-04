// ============================================================================
// FILE: src/background/runtime.js
// PURPOSE: Low-level runtime helper functions for asynchronous delays,
//          inter-process messaging (tabs and offscreen documents), and UI badge updates.
// ============================================================================

/**
 * Creates a Promise that resolves after a specified duration in milliseconds.
 *
 * HOW IT WORKS:
 * Wraps the browser's standard `setTimeout` callback in an ES6 Promise.
 * Used for debouncing, polling intervals, and waiting for DOM transitions.
 *
 * CAN BE WRITTEN IN A BETTER WAY:
 * Does not support an AbortSignal. If a tab closes or a job is cancelled while
 * sleeping, the timer will still fire. An abortable sleep pattern:
 * `const sleep = (ms, signal) => new Promise((resolve, reject) => { ... })`
 * would allow immediate cancellation when operations are aborted.
 *
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends a message from the background service worker to a specific browser tab.
 *
 * HOW IT WORKS:
 * 1. Validates that tabId is a legitimate integer.
 * 2. Uses `chrome.tabs.sendMessage` to transmit the JSON payload to content scripts in that tab.
 * 3. Catches and swallows any errors (e.g. "Receiving end does not exist" when tab has navigated).
 *
 * COMPLICATIONS & CAN BE WRITTEN IN A BETTER WAY:
 * - Silent error swallowing (`catch (_) {}`) makes it impossible to know if the message
 *   actually reached the content script or if the tab was closed/discarded.
 * - Better way: Return a boolean or result indicating success/failure:
 *   ```javascript
 *   const sendTab = async (tabId, message) => {
 *       if (!Number.isInteger(tabId)) return false;
 *       try {
 *           await chrome.tabs.sendMessage(tabId, message);
 *           return true;
 *       } catch (err) {
 *           // Optional debug log: console.debug(`Failed to send message to tab ${tabId}:`, err);
 *           return false;
 *       }
 *   };
 *   ```
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} message - Serialized JSON message object
 */
const sendTab = async (tabId, message) => {
    // Guard against non-integer, undefined, or NaN tab IDs
    if (!Number.isInteger(tabId)) return;
    try {
        // Asynchronously dispatch the message to content scripts
        await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
        // Tab may have navigated, closed, or does not have content script injected yet
    }
};

/**
 * Sends a message to the extension's offscreen document (used for MP4 remuxing / canvas).
 *
 * HOW IT WORKS:
 * In Manifest V3, service workers lack DOM/Canvas/WebCodecs access, so an "offscreen document"
 * is created to handle binary processing. Messages to offscreen use `chrome.runtime.sendMessage`
 * with a routing target: `'video-offscreen'`.
 *
 * CAN BE WRITTEN IN A BETTER WAY:
 * Notice `.catch?.(() => {})` with optional chaining. `chrome.runtime.sendMessage` returns a Promise
 * in modern Chrome (MV3), but can throw synchronously if the context is invalid.
 * The nested try-catch and optional chaining is defensive, but could cleanly return the promise:
 * `return chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch(() => {});`
 *
 * @param {Object} message - Payload to send to offscreen document
 */
const sendOffscreen = message => {
    try {
        // Tag with target 'video-offscreen' so only offscreen listener reacts, ignore rejection if offscreen is closed
        chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch?.(() => {});
    } catch (_) {
        // Extension context invalidated or service worker shutting down
    }
};

/**
 * Updates the text badge and background color on the extension action icon in Chrome toolbar.
 *
 * HOW IT WORKS:
 * 1. Sets badge text via `chrome.action.setBadgeText`.
 * 2. If text is non-empty, sets background color to green (#4CAF50).
 * 3. Wrapped in try-catch to avoid throwing in contexts where action API is unavailable.
 *
 * @param {string} text - Short string (usually 1-4 characters, e.g. "HD", "OK", "100%", or "" to clear)
 */
const setBadge = text => {
    try {
        // Set the badge text (empty string clears the badge)
        chrome.action.setBadgeText({ text });
        // Set brand green color when displaying an active badge
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {
        // Guard against action API errors or headless test environments
    }
};
