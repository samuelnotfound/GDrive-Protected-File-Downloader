// Stream parsing, normalization, and format catalog operations.

function sanitizeVideoFilename(name) {
    let value = String(name || '').trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/[\x00-\x1F]/g, '')
        .trim();
    if (!value) value = 'gdrive-video';
    return /\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value) ? value : `${value}.mp4`;
}

function emptySession(tabId = null, fileId = '', filename = '', viewerSessionId = '') {
    return {
        tabId: Number.isInteger(tabId) ? tabId : null,
        fileId: String(fileId || ''),
        filename: String(filename || 'gdrive-video'),
        viewerSessionId: String(viewerSessionId || ''),
        pageBridgeId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        playbackStarted: false,
        streamCaptureEnabled: false,
        video: null,
        audio: null,
        videoOriginal: null,
        audioOriginal: null,
        audioCandidates: [],
        videoCandidates: [],
        formats: {
            video: [],
            audio: [],
            progressive: []
        },
        formatsFetchedAt: 0,
        legacyFormatsFetchedAt: 0,
        activeQualityProbe: null,
        probeCandidates: [],
        qualityStreams: [],
        timestamp: null
    };
}

function getStreamBytes(url) {
    if (!url) return 0;
    try {
        const bytes = Number(new URL(url).searchParams.get('clen'));
        return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    } catch (_) {
        return 0;
    }
}

function formatHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < String(value || '').length; i++) {
        hash ^= String(value)[i].charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function parseStreamCandidate(url, originalUrl = url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const p = parsed.searchParams;
        const mime = p.get('mime') || '';
        const clen = getStreamBytes(url);
        const itag = p.get('itag') || '';
        const ITAG_DIMS = {
            '160':[256,144], '133':[426,240], '134':[640,360], '135':[854,480],
            '136':[1280,720], '137':[1920,1080], '264':[2560,1440], '266':[3840,2160],
            '242':[426,240], '243':[640,360], '244':[854,480], '247':[1280,720], '248':[1920,1080],
            '298':[1280,720], '299':[1920,1080], '18':[640,360], '22':[1280,720],
            // Drive's muxed/legacy itags. 37 (1080p) and 59 (480p) were missing, so those
            // requests had no height of their own and could be mislabelled during a probe.
            '34':[640,360], '35':[854,480], '37':[1920,1080], '43':[640,360],
            '44':[854,480], '45':[1280,720], '46':[1920,1080], '59':[854,480]
        };
        const dims = ITAG_DIMS[itag] || [0,0];
        const width = Number(p.get('width')) || Number(dims[0]) || 0;
        const height = Number(p.get('height')) || Number(dims[1]) || 0;
        const streamFileId = p.get('driveid') || p.get('driveId') || p.get('fileid') || p.get('fileId') || p.get('docid') || '';
        return {
            id: `captured:${p.get('itag') || ''}:${formatHash(cleanURL(url))}`,
            url: cleanURL(url),
            originalUrl,
            fileId: streamFileId,
            mime,
            itag,
            width,
            height,
            heightSource: height ? 'url' : '',
            contentLength: clen,
            codecs: p.get('codecs') || '',
            capturedAt: Date.now()
        };
    } catch (_) {
        return {
            id: `captured:${formatHash(cleanURL(url))}`,
            url: cleanURL(url),
            originalUrl,
            fileId: '',
            mime: '',
            itag: '',
            width: 0,
            height: 0,
            contentLength: getStreamBytes(url),
            codecs: '',
            capturedAt: Date.now()
        };
    }
}

function addUniqueCandidate(list, candidate, max = 12) {
    if (!candidate?.url) return Array.isArray(list) ? list.slice(0, max) : [];
    const existing = Array.isArray(list) ? list : [];
    const identity = item => {
        const itag = String(item?.itag || '').trim();
        const isAudio = /audio/i.test(String(item?.mime || '')) || /^(139|140|141|249|250|251)$/.test(itag);
        if (itag) {
            const quality = Number(item?.height || 0);
            const width = Number(item?.width || 0);
            const probeQuality = String(item?.probeQuality || '').trim().toLowerCase();
            return `${isAudio ? 'audio' : 'video'}|itag:${itag}|q:${quality || 0}|w:${width}|probe:${probeQuality}`;
        }
        return `url:${cleanURL(item?.url || '')}`;
    };
    const key = identity(candidate);
    return [candidate, ...existing.filter(item => identity(item) !== key)].slice(0, max);
}


// One entry per distinct audio FILE. Re-captures of the same track (after a reload, or once per
// probed quality) carry different signed URLs and probe labels but the same itag and size, so
// they must not be listed twice. The newest URL is kept because signed URLs expire.
function dedupeAudioFormats(list) {
    const items = (Array.isArray(list) ? list : []).filter(x => x?.url);
    const idOf = x => String(x.itag || '').trim() || `${String(x.mime || '').toLowerCase()}|${String(x.acodec || x.codecs || '').toLowerCase()}`;
    const groups = new Map();
    for (const x of items) {
        const k = idOf(x);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
    }
    const newer = (a, b) => Number(a?.capturedAt || 0) >= Number(b?.capturedAt || 0);
    const out = [];
    for (const arr of groups.values()) {
        const byLen = new Map();
        for (const x of arr) {
            const len = Number(x.contentLength || 0);
            const prev = byLen.get(len);
            if (!prev || newer(x, prev)) byLen.set(len, x);
        }
        const known = [...byLen.keys()].filter(l => l > 0);
        const unknown = byLen.get(0);
        byLen.delete(0);
        if (known.length) {
            // A copy with no size yet is the same file as the sized one of the same itag.
            if (unknown && known.length === 1) {
                const sized = byLen.get(known[0]);
                if (!newer(sized, unknown)) byLen.set(known[0], { ...unknown, contentLength: known[0] });
            }
        } else if (unknown) {
            byLen.set(0, unknown);
        }
        out.push(...byLen.values());
    }
    return out;
}

function stableFormatKey(format) {
    if (!format) return '';
    const kind = (format.acodec && !format.height && !format.width) ? 'audio' : (Number(format.height || 0) > 0 || /video/i.test(String(format.mime || '')) ? 'video' : String(format.kind || 'format'));
    const itag = String(format.itag || '').trim();
    const width = Number(format.width) || 0;
    const height = Number(format.height) || 0;
    // itag alone is not reliable for Drive quality-switch captures. Include the
    // representation dimensions/quality label so each activated quality remains distinct.
    const probeQuality = String(format.probeQuality || '').trim().toLowerCase();
    if (itag) return `${kind}|itag:${itag}|${width}x${height}|probe:${probeQuality}`;
    const mime = String(format.mime || '').toLowerCase();
    const vcodec = String(format.vcodec || format.videoCodecString || '').toLowerCase();
    const acodec = String(format.acodec || format.audioCodecString || '').toLowerCase();
    const bytes = Number(format.contentLength) || 0;
    return `${kind}|${width}x${height}|${mime}|${vcodec}|${acodec}|${bytes}`;
}

function mergeFormatLists(first, second, sortFn, max = 24) {
    const map = new Map();
    for (const item of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
        if (!item?.url) continue;
        const key = stableFormatKey(item) || item.url;
        const existing = map.get(key);
        if (!existing || Number(item.capturedAt || 0) >= Number(existing.capturedAt || 0)) map.set(key, item);
    }
    return [...map.values()].sort(sortFn).slice(0, max);
}

async function probePlaybackURL(url, expectedFileId = '') {
    if (!url) return false;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return false; }
    const params = parsed.searchParams;
    const streamFileId = params.get('driveid') || params.get('driveId') || params.get('fileid') || params.get('fileId') || '';
    if (expectedFileId && streamFileId && streamFileId !== expectedFileId) return false;
    const expire = Number(params.get('expire') || 0);
    if (expire && Date.now() / 1000 >= expire - 5) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORMAT_PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            referrer: 'https://drive.google.com/',
            headers: {
                'Range': 'bytes=0-0',
                'Accept': '*/*'
            },
            signal: controller.signal
        });
        const type = String(response.headers.get('content-type') || '').toLowerCase();
        return (response.status === 200 || response.status === 206) &&
            (!type || /^(video|audio)\//.test(type) || /octet-stream/.test(type));
    } catch (_) {
        return false;
    } finally {
        clearTimeout(timer);
        try { controller.abort(); } catch (_) {}
    }
}

async function validateFormatSet(formats, fileId) {
    const input = formats || { video: [], audio: [], progressive: [] };
    const video = Array.isArray(input.video) ? input.video : [];
    const audio = Array.isArray(input.audio) ? input.audio : [];
    const progressive = Array.isArray(input.progressive) ? input.progressive : [];

    // Validate every representation returned by Drive in parallel, but only
    // keep one usable representation for a duplicate quality/itag.
    const [videoOk, audioOk, progressiveOk] = await Promise.all([
        Promise.all(video.map(async fmt => (await probePlaybackURL(fmt.originalUrl || fmt.url, fileId)) ? fmt : null)),
        Promise.all(audio.map(async fmt => (await probePlaybackURL(fmt.originalUrl || fmt.url, fileId)) ? fmt : null)),
        Promise.all(progressive.map(async fmt => (await probePlaybackURL(fmt.originalUrl || fmt.url, fileId)) ? fmt : null))
    ]);

    const sortVideo = (a, b) => (Number(b.height || 0) - Number(a.height || 0)) ||
        (Number(b.width || 0) - Number(a.width || 0)) ||
        (Number(b.contentLength || 0) - Number(a.contentLength || 0));
    const sortAudio = (a, b) => (Number(b.contentLength || 0) - Number(a.contentLength || 0));

    return {
        video: mergeFormatLists([], videoOk.filter(Boolean), sortVideo),
        audio: mergeFormatLists([], audioOk.filter(Boolean), sortAudio),
        progressive: mergeFormatLists([], progressiveOk.filter(Boolean), sortVideo)
    };
}

function numericValue(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
}

function normalizeApiFormat(raw, family, index) {
    const url = raw?.url || raw?.playbackUrl || raw?.playbackURL;
    if (!url) return null;
    const metadata = raw?.transcodeMetadata || raw?.transcode_metadata || raw?.metadata || {};
    let parsed;
    try { parsed = new URL(url); } catch (_) { parsed = null; }
    const params = parsed?.searchParams;
    const mime = String(metadata?.mimeType || metadata?.mime || params?.get('mime') || '').toLowerCase();
    const width = numericValue(metadata?.width, raw?.width, params?.get('width'));
    const height = numericValue(metadata?.height, raw?.height, params?.get('height'));
    const fps = numericValue(metadata?.videoFps, metadata?.fps, raw?.fps, params?.get('fps'));
    const contentLength = numericValue(
        metadata?.contentLength,
        raw?.contentLength,
        raw?.filesize,
        params?.get('clen')
    );
    const vcodec = String(metadata?.videoCodecString || raw?.videoCodecString || '').trim();
    const acodec = String(metadata?.audioCodecString || raw?.audioCodecString || '').trim();
    const itag = String(raw?.itag ?? raw?.formatId ?? params?.get('itag') ?? '').trim();
    const hasVideo = width > 0 || /(?:^|\/)video\//i.test(mime) || vcodec && vcodec.toLowerCase() !== 'none';
    const hasAudio = /(?:^|\/)audio\//i.test(mime) || acodec && acodec.toLowerCase() !== 'none';
    const kind = family === 'progressive' ? 'progressive' : (hasVideo && !hasAudio ? 'video' : (!hasVideo && hasAudio ? 'audio' : family));
    const cleaned = cleanURL(url);
    return {
        id: `api:${kind}:${itag || index}:${width || 0}x${height || 0}:${Math.round(fps || 0)}`,
        url: cleaned,
        originalUrl: url,
        family,
        kind,
        itag,
        mime,
        width,
        height,
        fps,
        contentLength,
        vcodec,
        acodec,
        capturedAt: Date.now()
    };
}

function flattenFormatList(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
}

function parsePlaybackFormats(payload) {
    const source = payload?.mediaStreamingData?.formatStreamingData || payload?.formatStreamingData || {};
    const adaptive = flattenFormatList(source?.adaptiveTranscodes);
    const progressive = flattenFormatList(source?.progressiveTranscodes);
    const result = { video: [], audio: [], progressive: [] };

    adaptive.forEach((raw, index) => {
        const fmt = normalizeApiFormat(raw, 'adaptive', index);
        if (!fmt) return;
        if (fmt.kind === 'audio' || (fmt.kind !== 'video' && fmt.acodec && !fmt.width && !fmt.height)) {
            result.audio.push(fmt);
        } else {
            result.video.push(fmt);
        }
    });

    progressive.forEach((raw, index) => {
        const fmt = normalizeApiFormat(raw, 'progressive', index);
        if (fmt) result.progressive.push(fmt);
    });

    const dedupe = list => {
        const seen = new Set();
        return list.filter(item => {
            if (!item?.url || seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
        });
    };

    result.video = dedupe(result.video).sort((a, b) =>
        (b.height - a.height) || (b.width - a.width) || (b.contentLength - a.contentLength)
    );
    result.audio = dedupe(result.audio).sort((a, b) => b.contentLength - a.contentLength);
    result.progressive = dedupe(result.progressive).sort((a, b) =>
        ((b.height || 0) - (a.height || 0)) || (b.contentLength - a.contentLength)
    );

    return result;
}

