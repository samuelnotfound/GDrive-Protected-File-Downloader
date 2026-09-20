// Video playback metadata, staging jobs, and download selection.


async function fetchDrivePlaybackFormats(fileId, tabId) {
    const id = String(fileId || '').trim();
    if (!id) throw new Error('Drive file ID was not detected.');
    const endpoint = `https://content-workspacevideo-pa.googleapis.com/v1/drive/media/${encodeURIComponent(id)}/playback?key=${encodeURIComponent(DRIVE_PLAYBACK_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://drive.google.com/',
        headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`Drive playback metadata request failed (${response.status}).`);
    const payload = await response.json();
    const rawFormats = parsePlaybackFormats(payload);
    const session = await getStoredSession(tabId);
    const combined = {
        video: mergeFormatLists(session?.formats?.video, rawFormats.video, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength)),
        audio: mergeFormatLists(session?.formats?.audio, rawFormats.audio, (a,b) => b.contentLength-a.contentLength),
        progressive: mergeFormatLists(session?.formats?.progressive, rawFormats.progressive, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength))
    };
    const formats = await validateFormatSet(combined, id);
    if (!formats.video.length && !formats.audio.length && !formats.progressive.length) {
        throw new Error('Drive returned no currently playable playback formats.');
    }

    if (session && (!session.fileId || session.fileId === id)) {
        session.fileId = id;
        session.formats = formats;
        session.formatsFetchedAt = Date.now();
        await setStoredSession(tabId, session);
        await sendTab(tabId, { type: 'videoFormatsDetected', formats, fileId: id, viewerSessionId: session.viewerSessionId });
    }
    return formats;
}

async function ensureVideoOffscreen() {
    const url = chrome.runtime.getURL('video-offscreen.html');
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
        });
        if (contexts.length) return;
    }
    await chrome.offscreen.createDocument({
        url: 'video-offscreen.html',
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
    }).catch(error => {
        if (!String(error?.message || '').includes('already exists')) throw error;
    });
}

async function closeVideoOffscreen() {
    try {
        const jobs = await getStoredJobs();
        if (Object.keys(jobs).length) return;
        await chrome.offscreen.closeDocument();
    } catch (_) {}
}

async function createVideoStageJob(tabId, session, mode, payload) {
    const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await queueJobMutation(jobs => {
        jobs[jobId] = {
            jobId,
            sourceTabId: Number.isInteger(tabId) ? tabId : null,
            fileId: session?.fileId || '',
            viewerSessionId: session?.viewerSessionId || '',
            filename: payload.filename,
            mode,
            videoUrl: payload.videoUrl || null,
            audioUrl: payload.audioUrl || null,
            mediaUrl: payload.mediaUrl || null,
            videoBytes: payload.videoBytes || 0,
            audioBytes: payload.audioBytes || 0,
            mediaBytes: payload.mediaBytes || 0,
            mediaMime: payload.mediaMime || 'video/mp4',
            createdAt: Date.now()
        };
    });
    return jobId;
}

async function removeVideoStageJob(jobId) {
    await queueJobMutation(jobs => {
        delete jobs[jobId];
        return true;
    });
}

function selectFormats(session, request) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id) : null;

    const selectedProgressive = find(formats.progressive, request.progressiveFormatId);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    let video = find(formats.video, request.videoFormatId);
    let audio = find(formats.audio, request.audioFormatId);
    if (!video && formats.video?.length) video = formats.video[0];
    if (!audio && formats.audio?.length) audio = formats.audio[0];
    if (video?.url && audio?.url) return { mode: 'adaptive', video, audio };

    const capturedVideo = Array.isArray(session?.videoCandidates) ? session.videoCandidates[0] : null;
    const capturedAudioUrl = getBestAudioURL(session);
    if (capturedVideo?.url && capturedAudioUrl) {
        return {
            mode: 'adaptive',
            video: { url: capturedVideo.url, originalUrl: capturedVideo.originalUrl, contentLength: capturedVideo.contentLength },
            audio: { url: cleanURL(capturedAudioUrl), originalUrl: capturedAudioUrl, contentLength: getStreamBytes(capturedAudioUrl) }
        };
    }
    return null;
}

async function startVideoDownload(tabId, request = {}) {
    let session = await getStoredSession(tabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    // The selected stream must belong to the current tab/file/viewer session.
    // This is the important fix for cross-video and cross-tab contamination.
    if (request.fileId && session.fileId && String(request.fileId) !== String(session.fileId)) {
        return { success: false, error: 'The Drive file changed before download. Please open the quality menu again.' };
    }
    if (request.viewerSessionId && session.viewerSessionId && String(request.viewerSessionId) !== String(session.viewerSessionId)) {
        return { success: false, error: 'The Drive viewer changed before download. Please open the quality menu again.' };
    }

    // Playback URLs are signed/ephemeral. Refresh metadata before starting a
    // download when the selected formats are stale, while keeping the same
    // stable format ids so the user's quality choice survives the refresh.
    const formatAge = Date.now() - Number(session.formatsFetchedAt || 0);
    if (session.fileId && formatAge > 45_000) {
        try {
            await fetchDrivePlaybackFormats(session.fileId, tabId);
            session = await getStoredSession(tabId) || session;
        } catch (_) {
            // Keep the current session as a fallback; the normal capture path
            // may still have a usable stream.
        }
    }

    const selected = selectFormats(session, request);
    if (!selected) {
        return {
            success: false,
            error: 'No usable video/audio stream is ready. Let quality detection finish or play the video once as a fallback.'
        };
    }

    const finalFilename = sanitizeVideoFilename(request.filename || session.filename || 'gdrive-video');
    let jobId;
    if (selected.mode === 'single') {
        jobId = await createVideoStageJob(tabId, session, 'single', {
            filename: finalFilename,
            mediaUrl: cleanURL(selected.media.url),
            mediaBytes: selected.media.contentLength || getStreamBytes(selected.media.url),
            mediaMime: selected.media.mime || 'video/mp4'
        });
    } else {
        jobId = await createVideoStageJob(tabId, session, 'adaptive', {
            filename: finalFilename,
            videoUrl: cleanURL(selected.video.originalUrl || selected.video.url),
            audioUrl: cleanURL(selected.audio.originalUrl || selected.audio.url),
            videoBytes: selected.video.contentLength || getStreamBytes(selected.video.url),
            audioBytes: selected.audio.contentLength || getStreamBytes(selected.audio.url)
        });
    }

    try {
        await ensureVideoOffscreen();
        await sendTab(tabId, {
            type: 'videoStagePreload',
            jobId,
            videoBytes: selected.mode === 'adaptive' ? (selected.video.contentLength || getStreamBytes(selected.video.url)) : 0,
            audioBytes: selected.mode === 'adaptive' ? (selected.audio.contentLength || getStreamBytes(selected.audio.url)) : 0,
            mediaBytes: selected.mode === 'single' ? (selected.media.contentLength || getStreamBytes(selected.media.url)) : 0
        });
        await sendTab(tabId, { type: 'videoStageStarted', jobId,
            videoBytes: selected.mode === 'adaptive' ? (selected.video.contentLength || getStreamBytes(selected.video.url)) : 0,
            audioBytes: selected.mode === 'adaptive' ? (selected.audio.contentLength || getStreamBytes(selected.audio.url)) : 0,
            mediaBytes: selected.mode === 'single' ? (selected.media.contentLength || getStreamBytes(selected.media.url)) : 0
        });

        if (selected.mode === 'adaptive') {
            startStreamWarmup(jobId, 'video', selected.video.originalUrl || selected.video.url);
            startStreamWarmup(jobId, 'audio', selected.audio.originalUrl || selected.audio.url);
        } else {
            startStreamWarmup(jobId, 'media', selected.media.originalUrl || selected.media.url);
        }

        sendOffscreen({ type: 'videoStageStart', jobId });
        return {
            success: true,
            staging: true,
            jobId,
            mode: selected.mode,
            videoBytes: selected.mode === 'adaptive' ? (selected.video.contentLength || getStreamBytes(selected.video.url)) : 0,
            audioBytes: selected.mode === 'adaptive' ? (selected.audio.contentLength || getStreamBytes(selected.audio.url)) : 0,
            mediaBytes: selected.mode === 'single' ? (selected.media.contentLength || getStreamBytes(selected.media.url)) : 0
        };
    } catch (error) {
        stopStreamWarmups(jobId);
        await removeVideoStageJob(jobId);
        return { success: false, error: error?.message || 'Could not start local video staging.' };
    }
}
