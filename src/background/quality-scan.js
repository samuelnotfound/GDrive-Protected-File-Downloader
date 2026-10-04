/**
 * Slim quality helpers for the label → click → capture pipeline.
 * Full ladder probing was removed; download captures one quality at a time.
 */

function streamUrlKey(stream) {
    const raw = String(stream?.originalUrl || stream?.url || '');
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const itag = u.searchParams.get('itag') || '';
        const id = u.searchParams.get('id') || '';
        return itag ? `itag:${itag}|id:${id}` : cleanURL(raw) || raw;
    } catch (_) {
        return cleanURL(raw) || raw;
    }
}

/**
 * Wait for a video stream after a quality click.
 * Prefers probe-tagged / post-clickAt captures; falls back to recent video URLs.
 */
async function waitForQualityStream(tabId, probeToken, height, waitMs, usedUrls = new Set(), clickAt = 0) {
    const deadline = Date.now() + Math.max(800, Number(waitMs) || 2500);
    const h = Number(height) || 0;
    const minAt = Number(clickAt) || 0;

    while (Date.now() < deadline) {
        const state = streamCaptureState(tabId);
        const recent = Array.isArray(state?.recentStreams) ? state.recentStreams : [];
        const probeBuf = Array.isArray(state?.probeBuffer) ? state.probeBuffer : [];

        const pool = [...probeBuf, ...recent]
            .filter(s => s?.url && !isAudioStream(s))
            .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));

        for (const stream of pool) {
            if (minAt && Number(stream.capturedAt || 0) < minAt - 50) continue;
            if (probeToken && stream.probeToken && stream.probeToken !== probeToken) continue;
            const key = streamUrlKey(stream);
            if (key && usedUrls.has(key)) continue;
            // Height is optional — same-itag reselect may not retag height.
            if (h && Number(stream.qualityHeight || stream.height || 0) > 0) {
                const sh = Number(stream.qualityHeight || stream.height || 0);
                if (sh !== h && Math.abs(sh - h) > 8) continue;
            }
            return stream;
        }
        await sleep(200);
    }
    return null;
}

async function nudgePlaybackAfterQualitySwitch(tabId) {
    try { await runQualityDom(tabId, 'nudgePlayback', { seconds: 1 }); } catch (_) {}
    try { await resumePlaybackAfterQualitySwitch(tabId); } catch (_) {}
}

async function lockSharedAudioOnSession(tabId, audio) {
    if (!audio?.url) return;
    const cleaned = cleanURL(audio.originalUrl || audio.url) || audio.url;
    await queueSessionMutation(tabId, current => {
        if (!current) return false;
        current.audio = cleaned;
        current.audioOriginal = audio.originalUrl || audio.url;
        current.audioCandidates = addUniqueCandidate(
            Array.isArray(current.audioCandidates) ? current.audioCandidates : [],
            { ...audio, url: cleaned },
            8
        );
        current.formats = current.formats || { video: [], audio: [], progressive: [] };
        current.formats.audio = [{
            ...audio,
            url: cleaned,
            originalUrl: audio.originalUrl || audio.url,
            id: audio.id || `audio:${audio.itag || ''}`
        }];
        return current;
    });
}
