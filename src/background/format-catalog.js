function cleanURL(url) {
    if (!url) return null;
    const value = String(url);
    const rangeIndex = value.search(/[?&]range=/i);
    return rangeIndex === -1 ? value : value.slice(0, rangeIndex);
}


const AUDIO_ITAG_PATTERN = /^(139|140|141|249|250|251)$/;

function isAudioStream(stream) {
    return /audio/i.test(String(stream?.mime || '')) || AUDIO_ITAG_PATTERN.test(String(stream?.itag || ''));
}

const bySizeDesc = (a, b) => Number(b.contentLength || 0) - Number(a.contentLength || 0);
const byHeightThenSize = (a, b) => (Number(b.height || 0) - Number(a.height || 0)) || bySizeDesc(a, b);
const byHeightWidthThenSize = (a, b) =>
    (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.width || 0) - Number(a.width || 0)) || bySizeDesc(a, b);


function sanitizeVideoFilename(name) {
    let value = String(name || '').trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/[\x00-\x1F]/g, '')
        .trim();
    if (!value) value = 'gdrive-video';
    return /\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value) ? value : `${value}.mp4`;
}

function emptySession(fileId = '', filename = '', viewerSessionId = '') {
    return {
        fileId: String(fileId || ''),
        filename: String(filename || 'gdrive-video'),
        viewerSessionId: String(viewerSessionId || ''),
        pageBridgeId: '',
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
        activeQualityProbe: null,
        probeCandidates: []
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
        const dims = ITAG_DIMS[itag] || [0, 0];
        const urlWidth = Number(p.get('width')) || 0;
        const urlHeight = Number(p.get('height')) || 0;
        // Prefer explicit width/height query params. Only fall back to the itag
        // table when the URL itself does not declare dimensions — and mark that
        // source so the picker can refuse to treat it as a confirmed quality.
        const fromUrl = urlWidth > 0 || urlHeight > 0;
        const width = urlWidth || Number(dims[0]) || 0;
        const height = urlHeight || Number(dims[1]) || 0;
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
            heightSource: height ? (fromUrl ? 'url' : (itag && dims[1] ? 'itag' : '')) : '',
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
        const isAudio = isAudioStream(item);
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


