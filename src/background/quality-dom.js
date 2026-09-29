const QUALITY_TRIGGER_FILE = 'src/content/automation/quality-trigger.js';

const TRIGGER_SETTINGS_LABELS = ['settings', 'settings menu', 'player settings', 'video settings', 'open settings'];
const TRIGGER_QUALITY_LABELS = ['quality', 'video quality', 'quality settings'];

function psdCallTriggerAction(actionName, actionArgs) {
    const api = window.__driveQualityActions;
    if (!api || typeof api[actionName] !== 'function') return { found: false };
    try {
        return Promise.resolve(api[actionName](...actionArgs)).then(
            value => ({ found: true, value }),
            error => ({ found: true, error: String((error && error.message) || error) })
        );
    } catch (error) {
        return { found: true, error: String((error && error.message) || error) };
    }
}

async function invokeTrigger(tabId, frameId, action, args) {
    const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [Number(frameId)] },
        func: psdCallTriggerAction,
        args: [String(action), args]
    });
    return results?.[0]?.result || null;
}

async function callTriggerInFrame(tabId, frameId, action, args) {
    let result = null;
    try { result = await invokeTrigger(tabId, frameId, action, args); }
    catch (_) { return null; }

    if (result && result.found === false) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId, frameIds: [Number(frameId)] },
                files: [QUALITY_TRIGGER_FILE]
            });
            result = await invokeTrigger(tabId, frameId, action, args);
        } catch (_) { return null; }
    }

    if (!result?.found || !result.value) return null;
    return { frameId: Number(frameId), value: result.value };
}

async function getTargetFrameIds(tabId, frameId) {
    if (Number.isInteger(frameId)) return [Number(frameId)];
    const frames = await listPageFrames(tabId);
    const ids = frames.map(frame => Number(frame.frameId));
    return ids.length ? ids : [0];
}

/**
 * Run a quality-trigger action across frames.
 * When options.frameId is set, only that frame is targeted.
 * When options.stopOnFirstOk is true (default for click actions), frames are
 * tried sequentially and the first success wins — avoids broadcasting a click
 * into every frame at once (open-in-one / close-in-another race).
 */
async function runQualityDom(tabId, action, params = {}, options = {}) {
    const frameIds = await getTargetFrameIds(tabId, options.frameId);
    const args = [params || {}];
    const stopOnFirstOk = options.stopOnFirstOk === true
        || /^(clickLabel|clickQuality|closeMenu)$/.test(String(action || ''));

    if (stopOnFirstOk && frameIds.length > 1 && !Number.isInteger(options.frameId)) {
        const hits = [];
        for (const frameId of frameIds) {
            try {
                const row = await callTriggerInFrame(tabId, frameId, action, args);
                if (row?.value) {
                    hits.push(row);
                    if (row.value.ok) return hits;
                }
            } catch (_) {}
        }
        return hits;
    }

    const settled = await Promise.allSettled(frameIds.map(frameId => callTriggerInFrame(tabId, frameId, action, args)));
    return settled
        .map(entry => (entry.status === 'fulfilled' ? entry.value : null))
        .filter(row => row && row.value);
}

function firstOk(rows) {
    return rows.find(row => row.value?.ok) || null;
}

async function playWithDom(tabId, frames = []) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const rows = await runQualityDom(tabId, 'play');
        const playing = rows.find(row => row.value?.playing);
        if (playing) {
            return {
                success: true, playing: true, playbackDetected: true,
                frameId: playing.frameId, method: `trigger ${playing.value.method}`
            };
        }
        if (attempt === 1) await sleep(500);
    }
    return {
        success: false, playing: false, playbackDetected: false,
        method: 'trigger autoplay exhausted',
        error: 'The Drive player did not enter a confirmed playing state.',
        frames: frames.length
    };
}

async function listQualityOptions(tabId) {
    const rows = await runQualityDom(tabId, 'scanQualities');
    const withOptions = rows.filter(row => (row.value?.options || []).length);
    if (!withOptions.length) return [];

    // The live Quality menu can move between frames as Drive rebuilds the player UI.
    const best = new Map();
    for (const row of withOptions) {
        for (const option of row.value.options) {
            const height = Number(option.height || 0);
            if (!height) continue;

            const candidate = {
                ...option,
                height,
                text: option.label || option.text || `${height}p`,
                frameId: row.frameId
            };
            const previous = best.get(height);
            if (!previous || candidate.selected || Number(previous.frameId) === 0 && Number(row.frameId) !== 0) {
                best.set(height, candidate);
            }
        }
    }

    return [...best.values()].sort((a, b) => b.height - a.height);
}

async function clickQualityRowInDom(tabId, target, height, mode) {
    const scope = Number.isInteger(target?.frameId) ? { frameId: Number(target.frameId) } : {};
    const params = { height: Number(height), label: target?.label || target?.text || '', mode };
    const done = firstOk(await runQualityDom(tabId, 'clickQuality', params, scope));
    if (done) return { ok: true, mode, frameId: done.frameId, label: done.value.label || '' };
    const anywhere = firstOk(await runQualityDom(tabId, 'clickQuality', params));
    if (anywhere) return { ok: true, mode, frameId: anywhere.frameId, label: anywhere.value.label || '' };
    return { ok: false, reason: `${height}p row not found.` };
}

async function closePlayerMenu(tabId) {
    await runQualityDom(tabId, 'closeMenu');
    await sleep(FAST_SCAN.optionSettleMs);
}

async function describePlayerFrames(tabId) {
    const rows = await runQualityDom(tabId, 'ping');
    return rows.map(row => ({
        frameId: row.frameId,
        url: String(row.value?.url || '').slice(0, 120),
        videoCount: Number(row.value?.videoCount || 0),
        controls: Number(row.value?.controls || 0)
    }));
}
