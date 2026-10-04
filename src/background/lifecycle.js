
/** Last known URL per tab — used to detect navigation / reload. */
const TAB_URL_BY_ID = new Map();

/**
 * Extract a Drive file id from a viewer URL when possible.
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
 * Clear ALL capture state for a tab: session formats, in-memory rings,
 * global last audio/video, and quality picker snapshots.
 * Called on page refresh and when leaving/changing the Drive file.
 */
async function clearTabMediaState(tabId, { clearGlobal = true, fileId = '' } = {}) {
    try { await clearStoredSession(tabId); } catch (_) {}
    try { clearStreamCaptureState(tabId); } catch (_) {}
    try {
        if (typeof QUALITY_SCAN_TAB_LOCK !== 'undefined') QUALITY_SCAN_TAB_LOCK.delete(tabId);
    } catch (_) {}

    if (clearGlobal) {
        try {
            if (typeof clearGlobalStreams === 'function') clearGlobalStreams();
            else await chrome.storage.local.remove(['psdGlobalStreams']);
        } catch (_) {}
    }

    // Wipe picker snapshots for this file (and all, if file unknown).
    try {
        for (const area of [chrome.storage.session, chrome.storage.local]) {
            const data = await area.get('psdQualityPickerSnapshots');
            const snapshots = data?.psdQualityPickerSnapshots;
            if (!snapshots || typeof snapshots !== 'object') continue;
            if (fileId && snapshots[fileId]) {
                delete snapshots[fileId];
                await area.set({ psdQualityPickerSnapshots: snapshots });
            } else if (!fileId) {
                await area.remove('psdQualityPickerSnapshots');
            }
        }
    } catch (_) {}

    try { setBadge(''); } catch (_) {}
}

/**
 * True when navigation should drop captured formats / stream state.
 * Same Drive file without an explicit reload → keep (quality probing must not reset).
 */
function shouldClearSessionForNavigation(previousUrl, nextUrl, { isReload = false } = {}) {
    if (isReload) return true;
    if (!nextUrl) return false;

    if (previousUrl && isDriveHost(previousUrl) && !isDriveHost(nextUrl)) return true;

    const prevId = driveFileIdFromUrl(previousUrl);
    const nextId = driveFileIdFromUrl(nextUrl);

    if (prevId && nextId && prevId !== nextId) return true;
    if (prevId && isDriveHost(nextUrl) && !nextId) return true;

    // Same file, not a reload → keep session so the quality ladder is not restarted.
    return false;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const nextUrl = String(changeInfo?.url || tab?.url || '').trim();
    if (!nextUrl) return;

    const previousUrl = TAB_URL_BY_ID.get(tabId) || '';

    if (changeInfo?.url) {
        TAB_URL_BY_ID.set(tabId, nextUrl);
    } else if (!previousUrl && tab?.url) {
        TAB_URL_BY_ID.set(tabId, String(tab.url));
    }

    const trackedUrl = TAB_URL_BY_ID.get(tabId) || nextUrl;
    const fileId = driveFileIdFromUrl(trackedUrl);

    if (changeInfo?.url) {
        if (shouldClearSessionForNavigation(previousUrl, changeInfo.url)) {
            clearTabMediaState(tabId, { clearGlobal: true, fileId });
        }
        return;
    }

    // Do NOT clear on status=loading — Drive SPA fires this during quality switches
    // and would wipe the session mid-probe, causing the ladder to restart.
});

// Explicit reload / typed navigation via webNavigation (more reliable than tabs.onUpdated).
try {
    chrome.webNavigation.onCommitted.addListener(details => {
        if (details.frameId !== 0) return;
        const tabId = Number(details.tabId);
        if (!Number.isInteger(tabId) || tabId < 0) return;

        const url = String(details.url || '');
        const isReload =
            details.transitionType === 'reload' ||
            (Array.isArray(details.transitionQualifiers) &&
                details.transitionQualifiers.includes('client_redirect') === false &&
                details.transitionType === 'reload');

        const previousUrl = TAB_URL_BY_ID.get(tabId) || '';
        TAB_URL_BY_ID.set(tabId, url);

        if (!isDriveHost(url) && !(previousUrl && isDriveHost(previousUrl))) return;

        if (isReload || shouldClearSessionForNavigation(previousUrl, url, { isReload })) {
            clearTabMediaState(tabId, {
                clearGlobal: true,
                fileId: driveFileIdFromUrl(url) || driveFileIdFromUrl(previousUrl)
            });
        }
    });
} catch (_) {}

chrome.tabs.onRemoved.addListener(tabId => {
    TAB_URL_BY_ID.delete(tabId);
    clearTabMediaState(tabId, { clearGlobal: true });
});
