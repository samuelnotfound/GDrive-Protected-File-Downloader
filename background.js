async function shouldLog(){try{const result = await chrome.storage.local.get(['debugMode']);return result.debugMode === true;}catch(error){return false;}}async function logDebug(message,data = null){if(await shouldLog()){if(data)console.log(`[GDrive SW] ${message}`,data);else console.log(`[GDrive SW] ${message}`);}}function cleanURL(url){if(!url)return null;const rangeIndex = url.indexOf('&range=');if(rangeIndex !== -1)return url.substring(0,rangeIndex);const queryRangeIndex = url.indexOf('?range=');if(queryRangeIndex !== -1)return url.substring(0,queryRangeIndex);return url;}function sanitizeVideoFilename(name){let value = String(name || '').trim();value = value.replace(/[\\/:*?"<>|]+/g, '_').replace(/[\x00-\x1F]/g, '').trim();
  if (!value) value = 'gdrive-video';
  // If Drive already supplied a real media extension, keep the filename
  // exactly as supplied. Otherwise Chrome gets an MP4 extension.
  if (!/\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value)) value += '.mp4';
  return value;
}

const EMPTY_STREAMS = {
  video: null,
  audio: null,
  videoOriginal: null,
  audioOriginal: null,
  audioCandidates: [],
  videoCandidates: [],
  playbackStarted: false,
  filename: 'gdrive-video',
  timestamp: null
};



function getStreamBytes(url) {
  if (!url) return 0;
  try {
    const n = Number(new URL(url).searchParams.get('clen'));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch (_) { return 0; }
}

function getBestAudioURL(streams) {
  const list = Array.isArray(streams?.audioCandidates) && streams.audioCandidates.length
    ? streams.audioCandidates.slice()
    : (streams?.audio ? [streams.audioOriginal || streams.audio] : []);
  return list.sort((a,b) => getStreamBytes(b) - getStreamBytes(a))[0] || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Disposable speed-prime: access the exact captured videoplayback URLs in the
// service worker without creating a visible Chrome download. The response is
// streamed and discarded. This is intentionally short-lived and never becomes
// one of the user's files.
const activePrimeControllers = new Map();
const STORAGE_QUEUE = {streams: Promise.resolve(), jobs: Promise.resolve()};
const SERVICE_WORKER_START = Date.now();
const requestStats = {total: 0, video: 0, audio: 0, lastError: null};

function queueStorageMutation(kind, key, mutator) {
  const queueKey = kind === 'jobs' ? 'jobs' : 'streams';
  const task = STORAGE_QUEUE[queueKey].then(async () => {
    const defaults = key === 'capturedStreams' ? {...EMPTY_STREAMS, audioCandidates: [], videoCandidates: []} : {};
    const result = await chrome.storage.local.get({[key]: defaults});
    const value = result[key] || defaults;
    await mutator(value);
    await chrome.storage.local.set({[key]: value});
    return value;
  });
  STORAGE_QUEUE[queueKey] = task.catch(error => { requestStats.lastError = error?.message || String(error); });
  return task;
}


async function primeStreamInBackground(jobId, label, url, durationMs = 10000) {
  if (!jobId || !url) return;
  const key = `${jobId}:${label}`;
  const controller = new AbortController();
  activePrimeControllers.set(key, controller);
  const timer = setTimeout(() => controller.abort(), durationMs);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    while (true) {
      const {done} = await reader.read();
      if (done) break;
    }
  } catch (_) {
    // Expected when the 10-second prime is aborted.
  } finally {
    clearTimeout(timer);
    try { activePrimeControllers.delete(key); } catch (_) {}
  }
}

function stopBackgroundPrimes(jobId) {
  const prefix = `${jobId}:`;
  for (const [key, controller] of activePrimeControllers.entries()) {
    if (!key.startsWith(prefix)) continue;
    try { controller.abort(); } catch (_) {}
    activePrimeControllers.delete(key);
  }
}

let videoOffscreenCreating = null;
async function ensureVideoOffscreen() {
  const url = chrome.runtime.getURL('video-stager.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[url]});
    if (contexts.length) return;
  }
  if (!videoOffscreenCreating) {
    videoOffscreenCreating = chrome.offscreen.createDocument({
      url: 'video-stager.html',
      reasons: ['BLOBS', 'WORKERS'],
      justification: 'Process and merge captured Google Drive video and audio streams without opening a visible tab.'
    }).finally(() => { videoOffscreenCreating = null; });
  }
  await videoOffscreenCreating;
}
async function closeVideoOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (_) {}
}

async function startVideoDownload(tabId, streams, requestedFilename = '') {
  let current = streams || {};
  const candidates = Array.isArray(current.videoCandidates) && current.videoCandidates.length
    ? current.videoCandidates
    : (current.video ? [current.video] : []);
  if (!candidates.length) return {success:false,error:'No video captured. Play the video first.'};

  if (!(current.audio || (Array.isArray(current.audioCandidates) && current.audioCandidates.length))) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(200);
      current = await getStoredStreams();
      if (current.audio || (Array.isArray(current.audioCandidates) && current.audioCandidates.length)) break;
    }
  }

  const audioOriginal = getBestAudioURL(current);
  if (!audioOriginal) return {success:false,error:'Audio stream was not captured yet. Keep the video playing for a moment and try again.'};

  const finalFilename = sanitizeVideoFilename(requestedFilename || current.filename || 'gdrive-video');
  const videoOriginal = current.videoOriginal || candidates[0];
  const videoFetchURL = cleanURL(videoOriginal);
  const audioFetchURL = cleanURL(audioOriginal);
  const videoBytes = getStreamBytes(videoOriginal);
  const audioBytes = getStreamBytes(audioOriginal);
  const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  await queueStorageMutation('jobs', 'videoStageJobs', async (jobs) => {
    jobs[jobId] = {
      sourceTabId: Number.isInteger(tabId) ? tabId : null,
      filename: finalFilename,
      videoUrl: videoFetchURL,
      audioUrl: audioFetchURL,
      videoBytes,
      audioBytes,
      createdAt: Date.now()
    };
  });

  if (Number.isInteger(tabId)) {
    try { await chrome.tabs.sendMessage(tabId, {type:'videoStagePreload', jobId, videoBytes, audioBytes}); } catch (_) {}
  }

  try {
    // Use a hidden MV3 offscreen document for the heavy DOM/Worker work.
    // This keeps the existing staging pipeline but removes the visible tab.
    await ensureVideoOffscreen();
    if (Number.isInteger(tabId)) {
      try { await chrome.tabs.sendMessage(tabId, {type:'videoStageStarted', jobId, videoBytes, audioBytes}); } catch (_) {}
    }

    // Start one disposable second request for each captured stream.
    // It is intentionally consumed and aborted after 10s; the offscreen
    // request remains the only download that produces the final file.
    void Promise.all([
      primeStreamInBackground(jobId, 'video', videoOriginal, 10000),
      primeStreamInBackground(jobId, 'audio', audioOriginal, 10000)
    ]).catch(() => {});

    chrome.runtime.sendMessage({target:'video-offscreen', type:'videoStageStart', jobId}).catch?.(() => {});
    logDebug(`⚡ Speed-prime started for 10s: ${jobId}`);
    return {success:true, staging:true, jobId, videoBytes, audioBytes};
  } catch (error) {
    stopBackgroundPrimes(jobId);
    await queueStorageMutation('jobs', 'videoStageJobs', async (jobs) => { delete jobs[jobId]; });
    return {success:false,error:error?.message||'Could not start local video staging.'};
  }
}

const getStoredStreams = () => new Promise((resolve) => {
  chrome.storage.local.get(['capturedStreams'], (result) => {
    resolve(result.capturedStreams || {...EMPTY_STREAMS});
  });
});

// ============================================================================
// NETWORK LISTENER — same videoplayback detection logic as the supplied app
// ============================================================================

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (!url.includes('videoplayback')) return;
    requestStats.total += 1;

    const hasMimeVideo = url.includes('mime=video');
    const hasMimeAudio = url.includes('mime=audio');
    const isGenericVideo = !hasMimeVideo && !hasMimeAudio;

    if (hasMimeVideo || hasMimeAudio || isGenericVideo) {
      if (hasMimeVideo || isGenericVideo) requestStats.video += 1;
      if (hasMimeAudio) requestStats.audio += 1;
      logDebug('🔎 Network traffic detected:', url.substring(0, 100) + '...');

      queueStorageMutation('streams', 'capturedStreams', async (currentData) => {
        const timestamp = Date.now();
        let updated = false;

        if ((hasMimeVideo || isGenericVideo) && currentData.videoOriginal !== url) {
          // A real videoplayback request is the reliable fallback when the
          // Drive player lives in a frame that our content script cannot see.
          // The supplied downloader uses this network signal as its playback
          // detection path as well.
          currentData.playbackStarted = true;
          const cleaned = cleanURL(url);
          logDebug('🎥 NEW VIDEO STREAM FOUND!');
          currentData.videoOriginal = url;
          currentData.video = cleaned;
          currentData.videoCandidates = Array.isArray(currentData.videoCandidates) ? currentData.videoCandidates : [];
          currentData.videoCandidates = [cleaned, ...currentData.videoCandidates.filter(item => item && item !== cleaned)].slice(0, 6);
          currentData.timestamp = timestamp;
          updated = true;
        }

        if (hasMimeAudio) {
          const cleaned = cleanURL(url);
          const audioList = Array.isArray(currentData.audioCandidates) ? currentData.audioCandidates : [];
          const nextAudioList = [cleaned, ...audioList.filter(item => item && item !== cleaned)].slice(0, 8);
          if (currentData.audioOriginal !== url || JSON.stringify(audioList) !== JSON.stringify(nextAudioList)) {
            logDebug('🎵 NEW AUDIO STREAM FOUND!');
            currentData.audioOriginal = url;
            currentData.audio = cleaned;
            currentData.audioCandidates = nextAudioList;
            currentData.timestamp = timestamp;
            updated = true;
          }
        }

        if (updated) {
          logDebug('✅ Data saved to storage.');
          try {
            chrome.action.setBadgeText({text: 'ON'});
            chrome.action.setBadgeBackgroundColor({color: '#4CAF50'});
          } catch (_) {}
        }
      }).catch(error => { requestStats.lastError = error?.message || String(error); });
    }
  },
  {urls: ['<all_urls>']}
);


// ============================================================================
// MESSAGE LISTENER
// ============================================================================


async function playVideoInAllFrames(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return {success:false, error:'Invalid Drive tab.'};
  }

  const playRoutine = async () => {
    const videos = [];
    const seen = new Set();

    const collect = (root) => {
      try {
        if (!root?.querySelectorAll) return;
        for (const video of root.querySelectorAll('video')) {
          if (!seen.has(video)) {
            seen.add(video);
            videos.push(video);
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) collect(el.shadowRoot);
        }
      } catch (_) {}
    };

    collect(document);

    const visible = videos.filter(video => {
      try {
        const r = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        return r.width > 1 && r.height > 1 && style.display !== 'none' &&
               style.visibility !== 'hidden' && style.opacity !== '0';
      } catch (_) { return false; }
    });

    const candidates = (visible.length ? visible : videos).sort((a, b) => {
      const ap = (!a.paused && !a.ended) ? 1 : 0;
      const bp = (!b.paused && !b.ended) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      try {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      } catch (_) { return 0; }
    });

    // Mute every discovered media element first. Drive may expose more than
    // one <video> while switching between the thumbnail and the real player.
    for (const video of videos) {
      try {
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
      } catch (_) {}
    }

    const results = [];
    for (const video of candidates) {
      try {
        const before = Number(video.currentTime || 0);
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;

        let playError = '';
        try {
          const promise = video.play();
          if (promise?.then) await promise;
        } catch (error) {
          playError = error?.message || String(error);
        }

        // Give the media element a moment to transition out of paused state.
        await new Promise(resolve => setTimeout(resolve, 250));
        // Re-apply mute after play(); some players reset volume/muted while
        // initializing the MediaSource pipeline.
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;

        const after = Number(video.currentTime || 0);
        const playing = !video.paused && !video.ended && !video.error;
        results.push({
          attempted:true,
          before,
          after,
          playing,
          muted:video.muted === true && video.volume === 0,
          error:playError || (video.error ? `MediaError ${video.error.code || ''}`.trim() : '')
        });
        if (playing) break;
      } catch (error) {
        results.push({attempted:true, playing:false, error:error?.message || String(error)});
      }
    }

    // Some Drive player versions expose a Play control around the media
    // element. Click it only if direct play() did not produce playback.
    if (!results.some(r => r.playing)) {
      try {
        const buttons = [...document.querySelectorAll('button,[role="button"]')];
        const playButton = buttons.find(el => {
          const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.textContent || ''}`.toLowerCase();
          return /(^|\b)(play|play video|start playback)(\b|$)/i.test(text);
        });
        if (playButton) {
          playButton.click();
          await new Promise(resolve => setTimeout(resolve, 300));
          for (const video of videos) {
            try {
              video.muted = true;
              video.defaultMuted = true;
              video.volume = 0;
            } catch (_) {}
          }
          results.push({clicked:true, playing:videos.some(v => !v.paused && !v.ended)});
        }
      } catch (_) {}
    }

    return {
      attempted:results.some(r => r.attempted || r.clicked),
      playing:videos.some(v => !v.paused && !v.ended),
      muted:videos.length > 0 && videos.every(v => v.muted === true && v.volume === 0),
      errors:results.map(r => r.error).filter(Boolean).slice(0, 3)
    };
  };

  try {
    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames:true},
      func: playRoutine
    });
    const attempted = results.some(r => r?.result?.attempted === true);
    const playing = results.some(r => r?.result?.playing === true);
    const muted = results.some(r => r?.result?.muted === true);
    const errors = results.flatMap(r => Array.isArray(r?.result?.errors) ? r.result.errors : []).filter(Boolean);
    if (!playing) {
      const detail = errors.length ? ` ${errors[0]}` : '';
      return {success:false, error:`Could not start the current Drive video.${detail}`, attempted, muted};
    }
    return {success:true, attempted, playing, muted};
  } catch (error) {
    return {success:false, error:error?.message || 'Could not access the Drive video player.'};
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'playCurrentVideo') {
    playVideoInAllFrames(sender.tab?.id).then(sendResponse);
    return true;
  }

  if (request.action === 'clearVideoStream') {
    const empty = {...EMPTY_STREAMS, playbackStarted:false};
    chrome.storage.local.set({capturedStreams: empty}, () => {
      try { chrome.action.setBadgeText({text: ''}); } catch (_) {}
      sendResponse({success:true});
    });
    return true;
  }

  if (request.action === 'updateFilename') {
    logDebug('📝 Filename update request:', request.filename);
    queueStorageMutation('streams', 'capturedStreams', async (currentData) => {
      currentData.filename = request.filename;
    }).then(() => sendResponse({success:true})).catch(error => sendResponse({success:false,error:error?.message || 'Could not update filename.'}));
    return true;
  }

  if (request.action === 'videoPlaybackStarted') {
    queueStorageMutation('streams', 'capturedStreams', async (currentData) => {
      currentData.playbackStarted = true;
      currentData.timestamp = Date.now();
    }).then(() => {
      logDebug('▶️ Main-page video playback detected.');
      sendResponse({success:true});
    }).catch(error => sendResponse({success:false,error:error?.message || 'Could not save playback state.'}));
    return true;
  }

  if (request.action === 'getStreams') {
    getStoredStreams().then((streams) => {
      sendResponse({ streams });
    });
    return true;
  }


  if (request.action === 'downloadVideo') {
    logDebug('⬇️ Received request to download VIDEO');
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    getStoredStreams().then(async (streams) => {
      const result = await startVideoDownload(
        tabId,
        streams,
        request.filename || streams.filename || ''
      );
      sendResponse(result);
    }).catch(error => sendResponse({success:false, error:error?.message || 'Could not start the video download.'}));
    return true;
  }

  if (request.type === 'getVideoStageJob') {
    chrome.storage.local.get({videoStageJobs:{}}).then(result => {
      const all = result.videoStageJobs || {};
      const job = all[request.jobId];
      if (!job) sendResponse({success:false, error:'Staging job not found.'});
      else sendResponse({success:true, job});
    }).catch(error => sendResponse({success:false, error:error?.message || 'Could not read staging job.'}));
    return true;
  }

  if (request.type && request.type.startsWith('videoStage')) {
    chrome.storage.local.get({videoStageJobs:{}}).then(async result => {
      const all = result.videoStageJobs || {};
      const job = all[request.jobId];
      if (job?.sourceTabId != null) {
        try { await chrome.tabs.sendMessage(job.sourceTabId, {type:request.type, ...request}); } catch (_) {}
      }

      if (request.type === 'videoStageCancel') {
        try {
          chrome.runtime.sendMessage({target:'video-offscreen', type:'videoStageCancelInternal', jobId:request.jobId}).catch?.(() => {});
        } catch (_) {}
        stopBackgroundPrimes(request.jobId);
        if (job?.sourceTabId != null) {
          try { await chrome.tabs.sendMessage(job.sourceTabId, {type:'videoStageCancelled', jobId:request.jobId}); } catch (_) {}
        }
        setTimeout(() => closeVideoOffscreen(), 100);
        delete all[request.jobId];
        try { await chrome.storage.local.set({videoStageJobs:all}); } catch (_) {}
        sendResponse({success:true});
        return;
      }

      if (request.type === 'videoStageFinished' || request.type === 'videoStageError') {
        stopBackgroundPrimes(request.jobId);
        setTimeout(() => closeVideoOffscreen(), 1200);
        delete all[request.jobId];
        try { await chrome.storage.local.set({videoStageJobs:all}); } catch (_) {}
      }
      sendResponse({success:true});
    }).catch(error => sendResponse({success:false, error:error?.message || 'Could not relay video progress.'}));
    return true;
  }

  if (request.action === 'cancelVideoDownload') {
    const id = Number(request.downloadId);
    if (!Number.isInteger(id)) { sendResponse({success:false,error:'Invalid download id'}); return true; }

    chrome.downloads.cancel(id, () => {
      sendResponse({success: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message});
    });
    return true;
  }

  if (request.action === 'clearStreams') {
    logDebug('🧹 Clearing streams...');
    chrome.action.setBadgeText({ text: '' });
    const empty = { video: null, audio: null, videoOriginal: null, audioOriginal: null, audioCandidates: [], videoCandidates: [], playbackStarted: false, filename: 'gdrive-video', timestamp: null };
    chrome.storage.local.set({ capturedStreams: empty }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'ping') {
    getStoredStreams().then((streams) => {
      sendResponse({ success: true, serviceWorkerAlive: true, monitoring: { active: true, totalRequests: 'Auto', videosCaptured: streams.video ? 1 : 0, audiosCaptured: streams.audio ? 1 : 0 } });
    });
    return true;
  }

  if (request.action === 'getDiagnostics') {
    getStoredStreams().then((streams) => {
      sendResponse({ success: true, diagnostics: { serviceWorkerStartTime: SERVICE_WORKER_START, lastActivity: streams.timestamp || Date.now(), totalRequestsMonitored: requestStats.total, videoRequestsCaptured: requestStats.video, audioRequestsCaptured: requestStats.audio, webRequestListenerActive: true, lastError: requestStats.lastError, uptime: Date.now() - SERVICE_WORKER_START } });
    });
    return true;
  }

  return true;
});

console.log('[GDrive SW] Service Worker Initialized');
