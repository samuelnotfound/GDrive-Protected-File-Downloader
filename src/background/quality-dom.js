/**
 * Bridge to content-script __driveQualityActions across all frames.
 */

function psdCallTriggerAction(actionName, actionArgs) {
    const api = window.__driveQualityActions;
    if (!api || typeof api[actionName] !== 'function') return { found: false };
    try {
        const value = api[actionName](...(actionArgs || []));
        return Promise.resolve(value).then(v => ({ found: true, value: v }));
    } catch (e) {
        return { found: true, error: e?.message || String(e) };
    }
}

async function invokeTrigger(tabId, frameId, action, args) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: psdCallTriggerAction,
            args: [action, args]
        });
        return results?.[0]?.result || { found: false };
    } catch (_) {
        return { found: false };
    }
}

async function callTriggerInFrame(tabId, frameId, action, args) {
    const result = await invokeTrigger(tabId, frameId, action, args);
    if (!result?.found) return null;
    return { frameId, value: result.value, error: result.error };
}

async function getTargetFrameIds(tabId, frameId) {
    if (Number.isInteger(frameId)) return [frameId];
    try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        return (frames || []).map(f => f.frameId);
    } catch (_) {
        return [0];
    }
}

async function runQualityDom(tabId, action, params = {}, options = {}) {
    const frameIds = await getTargetFrameIds(tabId, options.frameId);
    // Actions that take a single options object vs no args.
    const finalArgs = (action === 'clickLabel' || action === 'clickQuality' || action === 'findLabel'
        || action === 'nudgePlayback')
        ? [params]
        : (action === 'enableMuteGuard' || action === 'releaseMuteGuard' || action === 'ping'
            || action === 'play' || action === 'closeMenu' || action === 'revealControls'
            || action === 'scanQualities' || action === 'resumePlayback')
            ? []
            : [params];

    // When a preferred frame is known, only that frame is targeted (getTargetFrameIds).
    // When broadcasting, stop after the first successful click-like action so we do not
    // click Settings/Quality in multiple frames.
    const isClickAction = action === 'clickLabel' || action === 'clickQuality' || action === 'findLabel';
    const rows = [];
    for (const frameId of frameIds) {
        const row = await callTriggerInFrame(tabId, frameId, action, finalArgs);
        if (row) {
            rows.push(row);
            if (isClickAction && (row.value?.ok || row.value === true) && !Number.isInteger(options.frameId)) {
                break;
            }
        }
    }
    return rows;
}

function firstOk(rows) {
    return (rows || []).find(r => r?.value?.ok || r?.value === true) || null;
}

async function closePlayerMenu(tabId) {
    try { await runQualityDom(tabId, 'closeMenu'); } catch (_) {}
}
