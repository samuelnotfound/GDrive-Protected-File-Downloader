/**
 * Background message router.
 *
 * The former implementation used a long sequential action ladder. Each action
 * is now isolated in a handler and dispatch is table-driven. Handler bodies
 * preserve the original behavior.
 */

async function handleSavequalitypickersnapshot(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success:false, error:'Invalid Drive tab.' };
        const fileId = String(request.fileId || '').trim();
        if (!fileId || !request.snapshot?.formats) return { success:false, error:'No quality snapshot.' };
        try {
            const data = await chrome.storage.session.get('psdQualityPickerSnapshots');
            const all = data?.psdQualityPickerSnapshots && typeof data.psdQualityPickerSnapshots === 'object' ? data.psdQualityPickerSnapshots : {};
            all[fileId] = request.snapshot;
            await chrome.storage.session.set({ psdQualityPickerSnapshots: all });
            return { success:true };
        } catch (_) {
            try {
                const data = await chrome.storage.local.get('psdQualityPickerSnapshots');
                const all = data?.psdQualityPickerSnapshots && typeof data.psdQualityPickerSnapshots === 'object' ? data.psdQualityPickerSnapshots : {};
                all[fileId] = request.snapshot;
                await chrome.storage.local.set({ psdQualityPickerSnapshots: all });
                return { success:true };
            } catch (error) { return { success:false, error:error?.message || String(error) }; }
        }
}

async function handleLoadqualitypickersnapshot(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success:false, error:'Invalid Drive tab.' };
        const fileId = String(request.fileId || '').trim();
        if (!fileId) return { success:false, error:'Missing file id.' };
        try {
            const data = await chrome.storage.session.get('psdQualityPickerSnapshots');
            const snapshot = data?.psdQualityPickerSnapshots?.[fileId] || null;
            if (snapshot) return { success:true, snapshot };
        } catch (_) {}
        try {
            const data = await chrome.storage.local.get('psdQualityPickerSnapshots');
            return { success:true, snapshot:data?.psdQualityPickerSnapshots?.[fileId] || null };
        } catch (error) { return { success:false, snapshot:null, error:error?.message || String(error) }; }
}

async function handleClearqualitypickersnapshot(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success:false, error:'Invalid Drive tab.' };
        const fileId = String(request.fileId || '').trim();
        if (!fileId) return { success:true };
        try {
            const data = await chrome.storage.session.get('psdQualityPickerSnapshots');
            const all = data?.psdQualityPickerSnapshots && typeof data.psdQualityPickerSnapshots === 'object' ? { ...data.psdQualityPickerSnapshots } : {};
            delete all[fileId];
            await chrome.storage.session.set({ psdQualityPickerSnapshots: all });
        } catch (_) {}
        try {
            const data = await chrome.storage.local.get('psdQualityPickerSnapshots');
            const all = data?.psdQualityPickerSnapshots && typeof data.psdQualityPickerSnapshots === 'object' ? { ...data.psdQualityPickerSnapshots } : {};
            delete all[fileId];
            await chrome.storage.local.set({ psdQualityPickerSnapshots: all });
        } catch (_) {}
        return { success:true };
}

async function handleSetvideocontext(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const fileId = String(request.fileId || '').trim();
        const viewerSessionId = String(request.viewerSessionId || '').trim();
        const pageBridgeId = String(request.pageBridgeId || '').trim();
        const filename = String(request.filename || '').trim();
        const current = await getStoredSession(tabId);
        const changed = !current || current.fileId !== fileId || current.viewerSessionId !== viewerSessionId || (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId);
        const next = changed
            ? emptySession(tabId, fileId, filename || 'gdrive-video', viewerSessionId)
            : { ...current, fileId: fileId || current.fileId, filename: filename || current.filename, viewerSessionId: viewerSessionId || current.viewerSessionId, pageBridgeId: pageBridgeId || current.pageBridgeId || '' };
        // Capture is enabled for the active viewer session immediately. This is
        // what lets us retain multiple quality URLs that the user has already
        // generated before pressing Download.
        next.streamCaptureEnabled = true;
        if (!next.timestamp) next.timestamp = Date.now();
        if (!changed && pageBridgeId) next.pageBridgeId = pageBridgeId;
        await setStoredSession(tabId, next);
        if (changed) setBadge('');
        return { success: true, changed, session: next };
}

async function handlePreparequalityscan(ctx) {
    const { request, sender, tabId } = ctx;
        return prepareQualityScanState(tabId, String(request.fileId || '').trim());
}

async function handleResetvideocapture(ctx) {
    const { request, sender, tabId } = ctx;
        return resetVideoCaptureState(tabId, String(request.fileId || '').trim());
}

async function handleClearVideoStreams(ctx) {
    const { request, sender, tabId } = ctx;
        setBadge('');
        await clearStoredSession(tabId);
        return { success: true };
}

async function handleUpdatefilename(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        await queueSessionMutation(tabId, session => {
            const filename = String(request.filename || '').trim();
            if (!filename || session.filename === filename) return false;
            session.filename = filename;
            return session;
        });
        return { success: true };
}

async function handlePagestreamdetected(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const url = String(request.url || '').trim();
        if (!url || !url.includes('/videoplayback')) return { success: false, error: 'Not a Drive playback URL.' };
        let candidate = parseStreamCandidate(url, url);
        const session = await getStoredSession(tabId);
        const fileId = String(request.fileId || session?.fileId || '').trim();
        const viewerSessionId = String(request.viewerSessionId || session?.viewerSessionId || '').trim();
        const pageBridgeId = String(request.pageBridgeId || '').trim();
        if (!session || !fileId || !viewerSessionId) {
            return { success: false, error: 'No active Drive viewer session.' };
        }
        if (session.fileId && fileId !== session.fileId) return { success: false, error: 'Drive file/session mismatch.' };
        if (session.viewerSessionId && viewerSessionId !== session.viewerSessionId) return { success: false, error: 'Drive viewer session mismatch.' };
        if (session.pageBridgeId && pageBridgeId && session.pageBridgeId !== pageBridgeId) return { success: false, error: 'Stale page bridge.' };
        const candidateFileId = String(candidate?.fileId || '').trim();
        if (candidateFileId && session.fileId && candidateFileId !== session.fileId) {
            return { success: false, error: 'Playback URL belongs to another Drive file.' };
        }
        candidate = {
            ...candidate,
            pageBridgeId: pageBridgeId || session.pageBridgeId || '',
            frameUrl: String(request.frameUrl || ''),
            source: String(request.source || 'page-bridge'),
            capturedAt: Date.now()
        };

        let latest = null;
        await queueSessionMutation(tabId, current => {
            if (current.fileId !== session.fileId || current.viewerSessionId !== session.viewerSessionId) return false;
            if (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId) return false;
            if (!current.pageBridgeId && pageBridgeId) current.pageBridgeId = pageBridgeId;
            const probe = current.activeQualityProbe;
            if (probe) {
                candidate.probeQuality = probe.label || '';
                candidate.probeToken = probe.token || '';
                current.probeCandidates = [candidate, ...(Array.isArray(current.probeCandidates) ? current.probeCandidates : [])]
                    .slice(0, 32);
            }
            const isAudio = /audio/i.test(String(candidate.mime || ''));
            if (isAudio) {
                current.audio = candidate.url;
                current.audioOriginal = candidate.originalUrl;
                current.audioCandidates = addUniqueCandidate(current.audioCandidates, candidate, 16);
                current.formats = {
                    ...current.formats,
                    audio: mergeFormatLists(current.formats?.audio, [{
                        ...candidate, id: `captured:${candidate.itag || formatHash(candidate.url)}`, kind: 'audio', acodec: candidate.codecs || '',
                        vcodec: '', url: candidate.url, originalUrl: candidate.originalUrl
                    }], (a,b) => Number(b.contentLength||0)-Number(a.contentLength||0)),
                    video: current.formats?.video || [], progressive: current.formats?.progressive || []
                };
            } else {
                current.video = candidate.url;
                current.videoOriginal = candidate.originalUrl;
                current.videoCandidates = addUniqueCandidate(current.videoCandidates, candidate, 16);
                current.formats = {
                    ...current.formats,
                    video: mergeFormatLists(current.formats?.video, [{
                        ...candidate, id: `captured:${candidate.itag || formatHash(candidate.url)}`, kind: 'video',
                        vcodec: candidate.codecs || '', acodec: '', url: candidate.url, originalUrl: candidate.originalUrl
                    }], (a,b) => (Number(b.height||0)-Number(a.height||0)) || (Number(b.contentLength||0)-Number(a.contentLength||0))),
                    audio: current.formats?.audio || [], progressive: current.formats?.progressive || []
                };
            }
            current.playbackStarted = true;
            current.streamCaptureEnabled = true;
            current.timestamp = Date.now();
            latest = current;
            return current;
        });
        if (!latest) return { success: false, error: 'The current Drive viewer changed.' };
        setBadge('ON');
        console.debug('[GDrive SW] page bridge captured videoplayback', {tabId, fileId: latest.fileId, itag: candidate.itag, mime: candidate.mime, width: candidate.width, height: candidate.height, clen: candidate.contentLength, source: candidate.source});
        await sendTab(tabId, {
            type: 'videoStreamDetected',
            fileId: latest.fileId,
            viewerSessionId: latest.viewerSessionId,
            stream: candidate,
            formats: latest.formats
        });
        return { success: true, session: latest, stream: candidate };
}

async function handleVideoplaybackintent(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false };
        await queueSessionMutation(tabId, session => {
            if (request.fileId && session.fileId && request.fileId !== session.fileId) return false;
            session.streamCaptureEnabled = true;
            return session;
        });
        return { success: true };
}

async function handleVideoplaybackstarted(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false };
        await queueSessionMutation(tabId, session => {
            if (session.playbackStarted) return false;
            session.playbackStarted = true;
            session.streamCaptureEnabled = true;
            session.timestamp = Date.now();
            return session;
        });
        return { success: true };
}

async function handleBeginqualityprobe(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const session = await getStoredSession(tabId);
        if (!session || (request.fileId && session.fileId && request.fileId !== session.fileId)) {
            return { success: false, error: 'The Drive video session changed.' };
        }
        const result = await beginQualityProbe(tabId, String(request.fileId || session.fileId || ''), String(request.label || ''));
        return { success: true, token: result.token, startedAt: result.startedAt };
}

async function handleEndqualityprobe(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const result = await endQualityProbe(tabId, String(request.token || ''));
        return { success: true, ...result };
}

async function handleReleasequalityscandebugger(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const state = DEBUGGER_NETWORK_TABS.get(Number(tabId));
        if (!state?.attached) return { success: true, detached: false, alreadyDetached: true };
        // Only the post-scan handoff is allowed to release this held debugger.
        // Clearing the keep flag first is required because the normal detach helper
        // intentionally refuses to detach while a scan is marked as active.
        if (state.qualityScanReadyToRelease) {
            state.qualityScanReadyToRelease = false;
            state.qualityScanKeepAttached = false;
        }
        try {
            await trustedV24DetachDebugger(tabId, true);
            return { success: true, detached: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
}

async function handleAutomatedqualityscan(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const session = await getStoredSession(tabId);
        const fileId = String(request.fileId || session?.fileId || '').trim();
        if (!session || !fileId || (session.fileId && session.fileId !== fileId)) {
            return { success: false, error: 'The current Drive video session changed.' };
        }
        const runningKey = `${tabId}|${fileId}|${session.viewerSessionId || ''}`;
        if (QUALITY_SCAN_RUNNING.has(runningKey)) {
            try { return await QUALITY_SCAN_RUNNING.get(runningKey); }
            catch (e) { return { success:false, error:e?.message || 'Quality scan failed.' }; }
        }
        const runPromise = (async () => {
          try {
            const result = await trustedV24RunQualityProbeScan(tabId, fileId);
            if (!result?.success) return result || { success:false, error:'Trusted Drive quality scan failed.' };
            const finalFormats = {
                video: mergeFormatLists([], result.formats?.video, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength)),
                audio: dedupeAudioFormats(mergeFormatLists([], result.formats?.audio, (a,b) => (b.contentLength-a.contentLength))),
                progressive: []
            };
            await queueSessionMutation(tabId, current => {
                if (!current || current.fileId !== fileId) return false;
                current.formats = finalFormats;
                current.formatsFetchedAt = Date.now();
                current.videoCandidates = Array.isArray(finalFormats.video) ? finalFormats.video.slice() : [];
                current.audioCandidates = Array.isArray(finalFormats.audio) ? finalFormats.audio.slice() : [];
                current.video = finalFormats.video?.[0]?.url || null;
                current.audio = finalFormats.audio?.[0]?.url || null;
                current.videoOriginal = finalFormats.video?.[0]?.originalUrl || current.video;
                current.audioOriginal = finalFormats.audio?.[0]?.originalUrl || current.audio;
                current.streamCaptureEnabled = true;
                return current;
            });
            const latest = await getStoredSession(tabId);
            const responseFormats = latest?.formats || finalFormats;
            await sendTab(tabId, { type:'videoFormatsDetected', formats:responseFormats, fileId, viewerSessionId:latest?.viewerSessionId || '' });
            return { success:true, formats:responseFormats, observedQualityLabels:result.observedQualityLabels || [], playback:result.playback || null, scanReport:result.scanReport || [] };
          } catch (error) {
            return { success:false, error:error?.message || 'Trusted Drive quality scan failed.' };
          }
        })();
        QUALITY_SCAN_RUNNING.set(runningKey, runPromise);
        try { return await runPromise; }
        finally { if (QUALITY_SCAN_RUNNING.get(runningKey) === runPromise) QUALITY_SCAN_RUNNING.delete(runningKey); }
}

async function handleProbevideoformats(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        try {
            const session = await getStoredSession(tabId);
            const fileId = String(request.fileId || session?.fileId || '').trim();
            if (!session || !fileId || (session.fileId && session.fileId !== fileId)) {
                return { success: false, error: 'The current Drive video session changed. Please retry detection.' };
            }
            const freshForMs = 60 * 1000;
            if (session.formatsFetchedAt && Date.now() - session.formatsFetchedAt < freshForMs &&
                (session.formats?.video?.length || session.formats?.progressive?.length)) {
                return { success: true, formats: session.formats, cached: true };
            }
            const formats = await fetchDrivePlaybackFormats(fileId, tabId);
            return { success: true, formats, cached: false };
        } catch (error) {
            return { success: false, error: error?.message || 'Drive quality detection failed.' };
        }
}

async function handleRegistervideoformats(ctx) {
    const { request, sender, tabId } = ctx;
        if (!Number.isInteger(tabId)) return { success: false, error: 'Invalid Drive tab.' };
        const session = await getStoredSession(tabId);
        const fileId = String(request.fileId || session?.fileId || '').trim();
        if (!session || !fileId || (session.fileId && session.fileId !== fileId)) {
            return { success: false, error: 'The current Drive video session changed.' };
        }
        const incoming = request.formats || {};
        const merged = {
            video: mergeFormatLists(session.formats?.video, incoming.video, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength)),
            audio: mergeFormatLists(session.formats?.audio, incoming.audio, (a,b) => b.contentLength-a.contentLength),
            progressive: mergeFormatLists(session.formats?.progressive, incoming.progressive, (a,b) => (b.height-a.height) || (b.width-a.width) || (b.contentLength-a.contentLength))
        };
        session.formats = await validateFormatSet(merged, fileId);
        session.legacyFormatsFetchedAt = Date.now();
        session.formatsFetchedAt = Date.now();
        await setStoredSession(tabId, session);
        await sendTab(tabId, { type: 'videoFormatsDetected', formats: session.formats, fileId, viewerSessionId: session.viewerSessionId });
        return { success: true, formats: session.formats };
}

async function handleGetstreams(ctx) {
    const { request, sender, tabId } = ctx;
        return { streams: await getStoredSession(tabId) };
}

async function handleDownloadvideo(ctx) {
    const { request, sender, tabId } = ctx;
        return startVideoDownload(tabId, request || {});
}

async function handleGetVideoStageJob(ctx) {
    const { request, sender, tabId } = ctx;
        const jobs = await getStoredJobs();
        const job = jobs[request.jobId];
        return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
}

async function handleVideoStageMessage(ctx) {
    const { request, sender, tabId } = ctx;
        const jobs = await getStoredJobs();
        const job = jobs[request.jobId];

        if (job?.sourceTabId != null && request.type !== 'videoStageCancel') {
            await sendTab(job.sourceTabId, { type: request.type, ...request });
        }

        if (request.type === 'videoStageCancel') {
            stopStreamWarmups(request.jobId);
            sendOffscreen({ type: 'videoStageCancelInternal', jobId: request.jobId });
            if (job?.sourceTabId != null) await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId: request.jobId });
            await removeVideoStageJob(request.jobId);
            setTimeout(closeVideoOffscreen, 100);
            return { success: true };
        }

        if (request.type === 'videoStageFinished' || request.type === 'videoStageError' || request.type === 'videoStageCancelled') {
            stopStreamWarmups(request.jobId);
            await queueJobMutation(currentJobs => {
                if (!currentJobs[request.jobId]) return false;
                delete currentJobs[request.jobId];
                return true;
            });
            setTimeout(closeVideoOffscreen, 1200);
        }
        return { success: true };
}

const ACTION_HANDLERS = Object.freeze({
    "saveQualityPickerSnapshot": handleSavequalitypickersnapshot,
    "loadQualityPickerSnapshot": handleLoadqualitypickersnapshot,
    "clearQualityPickerSnapshot": handleClearqualitypickersnapshot,
    "setVideoContext": handleSetvideocontext,
    "prepareQualityScan": handlePreparequalityscan,
    "resetVideoCapture": handleResetvideocapture,
    "clearVideoStream": handleClearVideoStreams,
    "clearStreams": handleClearVideoStreams,
    "updateFilename": handleUpdatefilename,
    "pageStreamDetected": handlePagestreamdetected,
    "videoPlaybackIntent": handleVideoplaybackintent,
    "videoPlaybackStarted": handleVideoplaybackstarted,
    "beginQualityProbe": handleBeginqualityprobe,
    "endQualityProbe": handleEndqualityprobe,
    "releaseQualityScanDebugger": handleReleasequalityscandebugger,
    "automatedQualityScan": handleAutomatedqualityscan,
    "probeVideoFormats": handleProbevideoformats,
    "registerVideoFormats": handleRegistervideoformats,
    "getStreams": handleGetstreams,
    "downloadVideo": handleDownloadvideo,
});

const TYPE_HANDLERS = Object.freeze({
    'getVideoStageJob': handleGetVideoStageJob,
});

async function handleRuntimeMessage(request = {}, sender = {}) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    const ctx = { request, sender, tabId };
    const action = String(request.action || '');

    const actionHandler = ACTION_HANDLERS[action];
    if (actionHandler) return actionHandler(ctx);

    const type = String(request.type || '');
    const typeHandler = TYPE_HANDLERS[type];
    if (typeHandler) return typeHandler(ctx);

    if (type.startsWith('videoStage')) return handleVideoStageMessage(ctx);

    // Preserve the original fall-through behavior for unknown messages.
    return undefined;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
});
