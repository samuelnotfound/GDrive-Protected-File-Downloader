/**
 * Player menu automation — Settings → Quality → click label.
 * Matches Drive Quality Trigger style (no full ladder).
 */

async function resumePlaybackAfterQualitySwitch(tabId) {
    try {
        const rows = await runQualityDom(tabId, 'resumePlayback');
        return (rows || []).some(r => r?.value?.ok || r?.value === true);
    } catch (_) {
        return false;
    }
}

async function clickMenuLikeMini(tabId, labels, labelName, timeoutMs, reveal = false, preferredFrameId = null) {
    const deadline = Date.now() + Math.max(1500, Number(timeoutMs) || 7000);
    const frameScope = Number.isInteger(preferredFrameId) ? { frameId: Number(preferredFrameId) } : {};
    while (Date.now() < deadline) {
        if (reveal) {
            try { await runQualityDom(tabId, 'revealControls', {}, frameScope); } catch (_) {}
        }
        const rows = await runQualityDom(tabId, 'clickLabel', {
            labels,
            contains: false,
            reveal: !!reveal
        }, frameScope);
        const hit = firstOk(rows);
        if (hit?.value?.ok || hit?.value === true) {
            return {
                ok: true,
                frameId: hit.frameId,
                label: hit.value?.label || labelName,
                method: 'clickLabel'
            };
        }
        await sleep(120);
    }
    return { ok: false, reason: `Could not find ${labelName}.` };
}

async function selectQualityVerified(tabId, label, height, timeoutMs, preferredFrameId = null) {
    const candidates = [label, `${label} resolution`, `${label} quality`, height ? `${height}p` : '']
        .filter(Boolean);
    const deadline = Date.now() + Math.max(1500, Number(timeoutMs) || 7000);
    const frameScope = Number.isInteger(preferredFrameId) ? { frameId: Number(preferredFrameId) } : {};

    while (Date.now() < deadline) {
        const viaQuality = firstOk(await runQualityDom(tabId, 'clickQuality', {
            height: Number(height) || 0,
            label,
            mode: 'click'
        }, frameScope));
        if (viaQuality?.value?.ok) {
            await sleep(250);
            return {
                ok: true,
                frameId: viaQuality.frameId,
                label: viaQuality.value.label || label,
                method: 'clickQuality'
            };
        }

        const viaLabel = firstOk(await runQualityDom(tabId, 'clickLabel', {
            labels: candidates,
            contains: false,
            reveal: false
        }, frameScope));
        if (viaLabel?.value?.ok) {
            await sleep(250);
            return {
                ok: true,
                frameId: viaLabel.frameId,
                label: viaLabel.value.label || label,
                method: 'clickLabel'
            };
        }
        await sleep(120);
    }
    return { ok: false, reason: `Could not select ${label}.` };
}
