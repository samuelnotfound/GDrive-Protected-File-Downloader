function chooseProbeCandidate(candidates, height = 0) {
    const list = Array.isArray(candidates) ? candidates.filter(x => x?.url) : [];
    if (!list.length) return null;
    const h = Number(height || 0);
    const matching = h ? list.filter(x => Number(x.height || 0) === h) : [];
    const source = matching.length ? matching : list;
    return source.slice().sort((a, b) => bySizeDesc(a, b) || (Number(b.capturedAt || 0) - Number(a.capturedAt || 0)))[0] || null;
}

async function resumePlaybackAfterQualitySwitch(tabId) {
    const rows = await runQualityDom(tabId, 'resumePlayback');
    return rows.some(row => row.value?.ok);
}

async function waitForQualityMenuClosed(tabId, timeoutMs = 900) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    do {
        last = await listQualityOptions(tabId);
        if (!last.length) return { closed: true };
        await sleep(80);
    } while (Date.now() < deadline);
    return { closed: false, stillListed: last.map(o => Number(o.height)) };
}

async function activateQualityRow(tabId, targetHeight, freshOptions = [], opts = {}) {
    const height = Number(targetHeight);
    const waitMenuMs = Number(opts?.waitMenuMs) > 0 ? Number(opts.waitMenuMs) : 900;
    const immediateSuccess = opts?.immediateSuccess === true;

    let options = await listQualityOptions(tabId);
    if (!options.length) options = Array.isArray(freshOptions) ? freshOptions : [];
    const target = options.find(x => Number(x.height) === height);
    if (!target) return { ok: false, reason: `${height}p is not in the live Quality menu.`, attempts: [] };

    const attempts = [];
    for (const mode of ['click', 'keyboard', 'events']) {
        let result;
        try { result = await clickQualityRowInDom(tabId, target, height, mode); }
        catch (error) { result = { ok: false, reason: error?.message || String(error) }; }
        const entry = { method: mode, ...result };
        attempts.push(entry);
        if (!result?.ok) continue;
        if (immediateSuccess) return { ok: true, method: mode, height, attempts };
        const wait = await waitForQualityMenuClosed(tabId, mode === 'click' ? waitMenuMs : Math.min(waitMenuMs, 260));
        entry.menuClosed = wait.closed;
        if (wait.closed) return { ok: true, method: mode, height, attempts };
    }
    return {
        ok: false, height, attempts,
        reason: `${height}p was not activated: the Quality menu stayed open after ${attempts.map(a => a.method).join(', ')}.`
    };
}

async function openQualitySubmenu(tabId, menuWaitMs = 2500) {
    let options = await listQualityOptions(tabId);
    if (options.length) return { ok: true, options, path: 'already-open' };

    let settings = null;
    let menu = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        settings = await openPlayerSettingsMenu(tabId);
        if (!settings?.ok) {
            await sleep(FAST_SCAN.retrySettleMs);
            continue;
        }

        menu = settings.afterSettings || null;
        if (!menu?.qualityTarget?.ok) {
            menu = await waitForQualityMenuRow(tabId, menuWaitMs);
        }
        if (!menu?.qualityTarget?.ok) {
            await sleep(FAST_SCAN.retrySettleMs);
            continue;
        }

        const opened = await clickQualityMenuRow(tabId, menu.qualityTarget);
        if (!opened?.ok) {
            await sleep(FAST_SCAN.retrySettleMs);
            continue;
        }

        const deadline = Date.now() + Math.max(menuWaitMs, FAST_SCAN.menuTimeoutMs);
        do {
            options = await listQualityOptions(tabId);
            if (options.length) {
                return {
                    ok: true,
                    options,
                    settings,
                    menu,
                    opened,
                    path: 'settings-click',
                    attempt
                };
            }
            await sleep(FAST_SCAN.menuPollMs);
        } while (Date.now() < deadline);
    }

    return {
        ok: false,
        reason: settings?.ok
            ? 'Settings opened, but the Quality submenu did not expose any resolution options.'
            : 'The Drive Settings control could not be clicked.',
        settings,
        menu
    };
}
