// ============================================================================
// FILE: src/background/lifecycle.js
// PURPOSE: Manages the lifecycle of Google Drive tabs and extension state.
//          Detects page loads, Single Page App (SPA) navigations, explicit reloads,
//          and tab closures. Cleans up active video download jobs, network capture
//          buffers, and session/local storage records when a file session ends.
// ============================================================================

/**
 * Last known URL per tab — used to detect navigation, SPA route changes, and reloads.
 *
 * HOW IT WORKS:
 * Key: tabId (number), Value: url (string).
 *
 * ARCHITECTURAL NOTE / CAN BE WRITTEN IN A BETTER WAY:
 * In Manifest V3, background service workers are ephemeral and will terminate
 * after ~30 seconds of inactivity. When the service worker restarts, in-memory
 * Maps like TAB_URL_BY_ID are reset to empty. If an update occurs after worker
 * restart, `previousUrl` will be empty.
 * Better way: Store tab URLs in `chrome.storage.session` so that last-known URLs
 * survive service worker idle termination cycles across the lifetime of the tab.
 */
const TAB_URL_BY_ID = new Map();

/**
 * Extracts a Google Drive file ID from a viewer URL when possible.
 *
 * HOW IT WORKS & PURPOSE:
 * 1. Checks if the URL belongs to google drive (e.g. drive.google.com).
 * 2. Parses path for the canonical format: "/file/d/<FILE_ID>/view".
 * 3. Falls back to query parameter patterns: "?id=<FILE_ID>" or "?fileId=<FILE_ID>".
 *
 * @param {string} url - The URL to inspect
 * @returns {string} The extracted file ID, or '' if not found / invalid
 */
function driveFileIdFromUrl(url) {
    // Coerce input into a string safely, guarding against null or undefined
    const value = String(url || '');
    // Immediate return if empty string
    if (!value) return '';

    try {
        // Parse into a standard WHATWG URL object; throws TypeError if malformed
        const parsed = new URL(value);
        // Extract hostname in lowercase
        const host = parsed.hostname || '';
        // Validate that this URL actually belongs to Google Drive domain or subdomain
        if (host !== 'drive.google.com' && !host.endsWith('.drive.google.com')) return '';

        // Match canonical Google Drive preview path: /file/d/<FILE_ID>(/...)
        const fromPath = parsed.pathname.match(/\/file\/d\/([^/]+)/i);
        // If matched and capture group 1 exists, return the file ID
        if (fromPath?.[1]) return fromPath[1];

        // Fallback for older Drive URLs or viewer parameters: ?id=... or ?fileId=...
        const id = parsed.searchParams.get('id') || parsed.searchParams.get('fileId') || '';
        // Clean whitespace and return
        return String(id || '').trim();
    } catch (_) {
        // Return empty string on URL parsing failure
        return '';
    }
}

/**
 * Checks if a given URL belongs to Google Drive.
 *
 * PURPOSE:
 * Quickly verifies whether a navigation target is within Google Drive ecosystem.
 *
 * CAN BE WRITTEN IN A BETTER WAY:
 * `driveFileIdFromUrl` and `isDriveHost` duplicate the hostname check.
 * `isDriveHost` can be reused inside `driveFileIdFromUrl` to keep the logic DRY.
 *
 * @param {string} url - URL to check
 * @returns {boolean} True if Google Drive hostname
 */
function isDriveHost(url) {
    try {
        const host = new URL(String(url || '')).hostname || '';
        // Matches "drive.google.com" and subdomains like "docs.drive.google.com"
        return host === 'drive.google.com' || host.endsWith('.drive.google.com');
    } catch (_) {
        // Malformed URL or non-URL string
        return false;
    }
}

/**
 * Clear ALL capture state for a tab:
 * - Active video chunk downloading / remuxing jobs
 * - Stored session format entries
 * - In-memory stream capture rings/buffers
 * - Quality probing concurrency locks
 * - Global stream cache (if requested)
 * - Quality picker UI state snapshots
 * - Extension badge text
 *
 * PURPOSE:
 * Called on page refresh, tab closure, and when leaving/changing a Drive file to
 * ensure stale buffers and orphaned download processes do not leak memory or persist.
 *
 * @param {number} tabId - ID of the browser tab being cleared
 * @param {Object} options
 * @param {boolean} [options.clearGlobal=true] - Whether to clear global stream references
 * @param {string} [options.fileId=''] - Specific file ID whose picker snapshots should be removed
 */
async function clearTabMediaState(tabId, { clearGlobal = true, fileId = '' } = {}) {
    // 1. Cancel active chunk downloading/remuxing jobs for this tab to avoid background resource leaks
    try {
        if (typeof cancelJobsForTab === 'function') await cancelJobsForTab(tabId);
    } catch (_) {}

    // 2. Clear persisted session data for this tab (formats, probe tokens, etc.)
    try { await clearStoredSession(tabId); } catch (_) {}

    // 3. Clear in-memory network stream capture buffers for this tab
    try { clearStreamCaptureState(tabId); } catch (_) {}

    // 4. Release quality scan lock so subsequent quality checks are not blocked indefinitely
    try {
        if (typeof QUALITY_SCAN_TAB_LOCK !== 'undefined') QUALITY_SCAN_TAB_LOCK.delete(tabId);
    } catch (_) {}

    // 5. Clear global streams cache across all tabs if clearGlobal is true
    if (clearGlobal) {
        try {
            if (typeof clearGlobalStreams === 'function') clearGlobalStreams();
            else await chrome.storage.local.remove(['psdGlobalStreams']);
        } catch (_) {}
    }

    // 6. Wipe quality picker cached snapshots from both session storage and local storage
    try {
        // Iterate through storage areas (session for short-term, local for persistence)
        for (const area of [chrome.storage.session, chrome.storage.local]) {
            const data = await area.get('psdQualityPickerSnapshots');
            const snapshots = data?.psdQualityPickerSnapshots;
            // Guard against uninitialized or invalid storage data
            if (!snapshots || typeof snapshots !== 'object') continue;

            if (fileId && snapshots[fileId]) {
                // If a specific fileId was provided, only delete snapshots for that file
                delete snapshots[fileId];
                await area.set({ psdQualityPickerSnapshots: snapshots });
            } else if (!fileId) {
                // If no fileId was specified, wipe all quality picker snapshots
                await area.remove('psdQualityPickerSnapshots');
            }
        }
    } catch (_) {}

    // 7. Clear the badge text on the extension action icon (e.g. format count or download status)
    try { setBadge(''); } catch (_) {}
}

/**
 * Decides whether a navigation event should drop captured formats and stream state.
 *
 * PURPOSE & BUSINESS LOGIC:
 * - If user explicitly reloaded the page -> ALWAYS clear (reset state).
 * - If target URL is missing -> DO NOT clear.
 * - If user navigated away from Google Drive to an external site -> CLEAR.
 * - If user navigated from one Drive file to a DIFFERENT Drive file -> CLEAR.
 * - If user navigated from a Drive file to a folder list/dashboard -> CLEAR.
 * - If user stays on the SAME Drive file (e.g., hash change, query param update,
 *   or quality probe triggering internal URL tweaks) -> KEEP session intact!
 *
 * @param {string} previousUrl - Previous URL of the tab
 * @param {string} nextUrl - Next URL after navigation
 * @param {Object} [options]
 * @param {boolean} [options.isReload=false] - Whether this navigation is an explicit reload
 * @returns {boolean} True if media state should be wiped
 */
function shouldClearSessionForNavigation(previousUrl, nextUrl, { isReload = false } = {}) {
    // An explicit reload (F5 / Ctrl+R / reload button) always warrants a fresh slate
    if (isReload) return true;
    // Missing destination URL means navigation is incomplete or unknown; keep state
    if (!nextUrl) return false;

    // Transition from Google Drive to an external domain -> clear state
    if (previousUrl && isDriveHost(previousUrl) && !isDriveHost(nextUrl)) return true;

    // Extract file IDs from both previous and new URLs
    const prevId = driveFileIdFromUrl(previousUrl);
    const nextId = driveFileIdFromUrl(nextUrl);

    // If both URLs point to valid file IDs, but they differ -> user opened another file -> clear
    if (prevId && nextId && prevId !== nextId) return true;

    // If previously on a file, and now on a Drive page without a file ID (e.g. folder, home) -> clear
    if (prevId && isDriveHost(nextUrl) && !nextId) return true;

    // Otherwise, it is the same file and not an explicit reload.
    // KEEP the session so ongoing quality probing or stream captures are not wiped.
    return false;
}

/**
 * Event Listener: chrome.tabs.onUpdated
 *
 * PURPOSE:
 * Tracks tab URL changes and updates TAB_URL_BY_ID.
 * Handles in-page Single Page Application (SPA) navigation where webNavigation events
 * might not trigger a full page commitment.
 *
 * COMPLICATION & GOTCHA TO NOTE:
 * Drive's video player switches video qualities dynamically via internal XHRs/fetch,
 * occasionally triggering `changeInfo.status = 'loading'`. We explicitly avoid clearing
 * state on `status === 'loading'` because doing so would wipe the session mid-probe!
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Resolve destination URL from changeInfo (preferred) or tab object fallback
    const nextUrl = String(changeInfo?.url || tab?.url || '').trim();
    if (!nextUrl) return;

    // Retrieve last recorded URL for this tab
    const previousUrl = TAB_URL_BY_ID.get(tabId) || '';

    // If an explicit URL change occurred in changeInfo, update our tracking Map
    if (changeInfo?.url) {
        TAB_URL_BY_ID.set(tabId, nextUrl);
    } else if (!previousUrl && tab?.url) {
        // First time seeing this tab: seed initial URL
        TAB_URL_BY_ID.set(tabId, String(tab.url));
    }

    // Resolve current tracked URL and extract file ID
    const trackedUrl = TAB_URL_BY_ID.get(tabId) || nextUrl;
    const fileId = driveFileIdFromUrl(trackedUrl);

    // If the URL changed, evaluate whether we should clear media session state
    if (changeInfo?.url) {
        if (shouldClearSessionForNavigation(previousUrl, changeInfo.url)) {
            clearTabMediaState(tabId, { clearGlobal: true, fileId });
        }
        return;
    }

    // Note: Do NOT clear on status='loading' — Google Drive's SPA fires this during
    // quality switches and would wipe the session mid-probe, restarting the ladder.
});

/**
 * Event Listener: chrome.webNavigation.onCommitted
 *
 * PURPOSE:
 * Catches authoritative top-level page navigations, browser address bar URL submissions,
 * and user-triggered browser reloads (F5, reload button).
 * webNavigation is more reliable for detecting reload transition types than tabs.onUpdated.
 */
try {
    chrome.webNavigation.onCommitted.addListener(details => {
        // frameId === 0 represents the main/top-level browsing context (ignore iframes)
        if (details.frameId !== 0) return;

        // Ensure valid integer tab ID
        const tabId = Number(details.tabId);
        if (!Number.isInteger(tabId) || tabId < 0) return;

        // Safely extract URL
        const url = String(details.url || '');

        // ------------------------------------------------------------------------
        // CAN BE WRITTEN IN A BETTER WAY / REDUNDANCY COMMENT:
        // Originally written as:
        //   details.transitionType === 'reload' ||
        //   (Array.isArray(details.transitionQualifiers) &&
        //       details.transitionQualifiers.includes('client_redirect') === false &&
        //       details.transitionType === 'reload');
        // Notice that `details.transitionType === 'reload'` was present on both sides
        // of the || operator! In boolean logic: A || (B && C && A) is equivalent to A.
        // Simplified check:
        // ------------------------------------------------------------------------
        const isReload = details.transitionType === 'reload';

        // Retrieve previously recorded URL and update to current URL
        const previousUrl = TAB_URL_BY_ID.get(tabId) || '';
        TAB_URL_BY_ID.set(tabId, url);

        // Ignore navigations between unrelated non-Google Drive websites
        if (!isDriveHost(url) && !(previousUrl && isDriveHost(previousUrl))) return;

        // If it's a reload or a navigation away from the file, clear state
        if (isReload || shouldClearSessionForNavigation(previousUrl, url, { isReload })) {
            clearTabMediaState(tabId, {
                clearGlobal: true,
                fileId: driveFileIdFromUrl(url) || driveFileIdFromUrl(previousUrl)
            });
        }
    });
} catch (_) {
    // webNavigation API might not be supported in some environments or restricted contexts
}

/**
 * Event Listener: chrome.tabs.onRemoved
 *
 * PURPOSE:
 * Cleans up memory and halts active download/remux jobs when the user closes a tab.
 *
 * HOW IT WORKS:
 * 1. Removes tabId from URL tracking Map.
 * 2. Launches an async IIFE to abort active video chunk jobs and clear stored session.
 *
 * CAN BE WRITTEN IN A BETTER WAY:
 * Note that `clearTabMediaState(tabId)` already calls `cancelJobsForTab(tabId)`.
 * Calling `cancelJobsForTab(tabId)` directly before `clearTabMediaState` is redundant,
 * but keeps cancellation high-priority in case `clearTabMediaState` throws early.
 */
chrome.tabs.onRemoved.addListener(tabId => {
    // Free in-memory URL tracker for this tab
    TAB_URL_BY_ID.delete(tabId);

    // Asynchronously tear down active jobs and storage (fire-and-forget)
    (async () => {
        try {
            if (typeof cancelJobsForTab === 'function') await cancelJobsForTab(tabId);
        } catch (_) {}
        try {
            await clearTabMediaState(tabId, { clearGlobal: true });
        } catch (_) {}
    })();
});
