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

async function clickMenuLikeMini(tabId, labels, labelName, timeoutMs, reveal = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (reveal) {
            try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}
        }
        const hit = firstOk(await runQualityDom(tabId, 'clickLabel', {
            labels, contains: false, reveal: !!reveal
        }));
        if (hit?.value?.ok) {
            return { ok: true, frameId: hit.frameId, label: hit.value.label || labelName };
        }
        await sleep(FAST_SCAN.menuPollMs);
    }
    return { ok: false, reason: `Could not find ${labelName}.` };
}

/**
 * Click a quality row and require it to actually select (aria-checked).
 * Uses both clickLabel and clickQuality for reliability.
 */
async function selectQualityVerified(tabId, label, height, timeoutMs) {
    const candidates = [label, `${label} resolution`, `${label} quality`, `${height}p`];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // Prefer dedicated clickQuality (role=menuitemradio matching).
        const viaQuality = firstOk(await runQualityDom(tabId, 'clickQuality', {
            height: Number(height) || 0,
            label,
            mode: 'click'
        }));
        if (viaQuality?.value?.ok) {
            await sleep(FAST_SCAN.optionClickSettleMs);
            // Confirm selected if the trigger reports it; otherwise accept the click.
            if (viaQuality.value.selected !== false) {
                return { ok: true, frameId: viaQuality.frameId, label: viaQuality.value.label || label, method: 'clickQuality' };
            }
        }

        const viaLabel = firstOk(await runQualityDom(tabId, 'clickLabel', {
            labels: candidates, contains: false, reveal: false
        }));
        if (viaLabel?.value?.ok) {
            await sleep(FAST_SCAN.optionClickSettleMs);
            return { ok: true, frameId: viaLabel.frameId, label: viaLabel.value.label || label, method: 'clickLabel' };
        }
        await sleep(FAST_SCAN.menuPollMs);
    }
    return { ok: false, reason: `Could not select ${label}.` };
}

/**
 * Full sequence for one quality — same shape as mini plugin, with verification.
 */
async function applyQualityLikeMini(tabId, label, height = 0) {
    await closePlayerMenu(tabId);
    await sleep(FAST_SCAN.optionSettleMs);

    try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}

    const settings = await clickMenuLikeMini(
        tabId, TRIGGER_SETTINGS_LABELS, 'Settings', FAST_SCAN.settingsTimeoutMs, true
    );
    if (!settings.ok) return { ok: false, step: 'settings', reason: settings.reason };
    await sleep(FAST_SCAN.settingsClickSettleMs);

    const quality = await clickMenuLikeMini(
        tabId, TRIGGER_QUALITY_LABELS, 'Quality', FAST_SCAN.qualityTimeoutMs, false
    );
    if (!quality.ok) return { ok: false, step: 'quality-row', reason: quality.reason };
    await sleep(FAST_SCAN.qualityClickSettleMs);

    // Confirm quality options are visible before clicking a row.
    const listed = await listQualityOptions(tabId);
    const want = Number(height) || 0;
    if (want && listed.length && !listed.some(o => Number(o.height) === want)) {
        return { ok: false, step: 'quality-missing', reason: `${label} not in open Quality menu.` };
    }

    const selected = await selectQualityVerified(tabId, label, height, FAST_SCAN.qualityTimeoutMs);
    if (!selected.ok) return { ok: false, step: 'quality-option', reason: selected.reason };

    return { ok: true, method: selected.method || 'mini-sequence', settings, quality, selected, label };
}

async function activateQualityRow(tabId, targetHeight, freshOptions = [], opts = {}) {
    const height = Number(targetHeight);
    const fromOptions = (Array.isArray(freshOptions) ? freshOptions : [])
        .find(x => Number(x.height) === height);
    const text = String(fromOptions?.text || fromOptions?.label || `${height}p`).trim();

    const applied = await applyQualityLikeMini(tabId, text, height);
    if (applied.ok) {
        return {
            ok: true,
            method: applied.method,
            height,
            label: text,
            attempts: [{ method: applied.method, ok: true, label: text }]
        };
    }
    return {
        ok: false,
        height,
        label: text,
        reason: applied.reason || `${text} could not be activated.`,
        attempts: [{ method: 'mini-sequence', ok: false, reason: applied.reason, step: applied.step }]
    };
}

async function openQualitySubmenu(tabId, menuWaitMs = 2500) {
    await closePlayerMenu(tabId);
    await sleep(FAST_SCAN.optionSettleMs);
    try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}

    const settings = await clickMenuLikeMini(
        tabId, TRIGGER_SETTINGS_LABELS, 'Settings', FAST_SCAN.settingsTimeoutMs, true
    );
    if (!settings.ok) {
        return { ok: false, reason: settings.reason || 'Settings not found.', settings };
    }
    await sleep(FAST_SCAN.settingsClickSettleMs);

    const quality = await clickMenuLikeMini(
        tabId, TRIGGER_QUALITY_LABELS, 'Quality', FAST_SCAN.qualityTimeoutMs, false
    );
    if (!quality.ok) {
        return { ok: false, reason: quality.reason || 'Quality row not found.', settings, quality };
    }
    await sleep(FAST_SCAN.qualityClickSettleMs);

    const deadline = Date.now() + Math.max(menuWaitMs, FAST_SCAN.menuTimeoutMs);
    let options = [];
    do {
        options = await listQualityOptions(tabId);
        if (options.length) {
            options = options.slice().sort((a, b) => Number(b.height) - Number(a.height));
            return { ok: true, options, settings, quality, path: 'mini-settings-quality' };
        }
        await sleep(FAST_SCAN.menuPollMs);
    } while (Date.now() < deadline);

    return {
        ok: false,
        reason: 'Quality submenu opened but no resolution options were found.',
        settings,
        quality
    };
}
