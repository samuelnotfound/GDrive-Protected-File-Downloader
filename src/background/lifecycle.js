
/** Last known URL per tab — used to avoid wiping session on SPA "loading" noise. */
const TAB_URL_BY_ID = new Map();

/**
 * Extract a Drive file id from a viewer URL when possible.
 * Examples:
 *   https://drive.google.com/file/d/FILE_ID/view
 *   https://drive.google.com/open?id=FILE_ID
 */
function driveFileIdFromUrl(url) {
    const value = String(url || '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        const host = parsed.hostname || '';
        if (host !== 'drive.google.com' && !host.endsWith('.drive.google.com')) return '';

        const fromPath = parsed.pathname.match(/\/file\/d\/([^/]+)/i);
        if (fromPath?.[1]) return fromPath[1];

        const id = parsed.searchParams.get('id') || parsed.searchParams.get('fileId') || '';
        return String(id || '').trim();
    } catch (_) {
        return '';
    }
}

function isDriveHost(url) {
    try {
        const host = new URL(String(url || '')).hostname || '';
        return host === 'drive.google.com' || host.endsWith('.drive.google.com');
    } catch (_) {
        return false;
    }
}

/**
 * True when navigation should drop captured formats / stream state.
 * Same Drive file (including SPA reloads that only set status=loading) → keep.
 */
function shouldClearSessionForNavigation(previousUrl, nextUrl) {
    if (!nextUrl) return false;

    // Left Drive entirely.
    if (previousUrl && isDriveHost(previousUrl) && !isDriveHost(nextUrl)) return true;

    const prevId = driveFileIdFromUrl(previousUrl);
    const nextId = driveFileIdFromUrl(nextUrl);

    // Different Drive files.
    if (prevId && nextId && prevId !== nextId) return true;

    // Was on a specific file, now on Drive without that file id (e.g. folder list).
    if (prevId && isDriveHost(nextUrl) && !nextId) return true;

    // First URL we see for this tab on a non-matching path — only clear if we
    // already had session-worthy state implied by a previous file id.
    return false;
}

function clearTabMediaState(tabId) {
    clearStoredSession(tabId).catch(() => {});
    clearStreamCaptureState(tabId);
    setBadge('');
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Prefer explicit URL changes; also note status=loading with tab.url for SPA noise checks.
    const nextUrl = String(changeInfo?.url || tab?.url || '').trim();
    if (!nextUrl) return;

    const previousUrl = TAB_URL_BY_ID.get(tabId) || '';

    // Always remember the latest URL for this tab.
    if (changeInfo?.url) {
        TAB_URL_BY_ID.set(tabId, nextUrl);
    } else if (!previousUrl && tab?.url) {
        TAB_URL_BY_ID.set(tabId, String(tab.url));
    }

    const trackedUrl = TAB_URL_BY_ID.get(tabId) || nextUrl;

    // Only clear when the navigation meaningfully changes the Drive file context.
    // Ignore pure status=loading events that keep the same file id (Drive SPA).
    if (changeInfo?.url) {
        if (shouldClearSessionForNavigation(previousUrl, changeInfo.url)) {
            clearTabMediaState(tabId);
        }
        return;
    }

    // status-only updates: clear only if the tab URL we know already implies a file change
    // (e.g. we missed a url event). Same file → no-op.
    if (changeInfo?.status === 'loading') {
        if (previousUrl && shouldClearSessionForNavigation(previousUrl, trackedUrl)) {
            clearTabMediaState(tabId);
        }
    }
});

chrome.tabs.onRemoved.addListener(tabId => {
    TAB_URL_BY_ID.delete(tabId);
    clearTabMediaState(tabId);
});
