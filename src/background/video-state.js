const activeStreamWarmups = new Map();
function startStreamWarmup(jobId, label, url, durationMs = 10000) {
    if (!jobId || !url) return;
    const key = `${jobId}:${label}`;
    const controller = new AbortController();
    activeStreamWarmups.set(key, controller);
    const timer = setTimeout(() => controller.abort(), durationMs);
    fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
    }).then(response => {
        if (!response.ok || !response.body) return;
        return (async () => {
            const reader = response.body.getReader();
            try {
                while (!(await reader.read()).done) {}
            } finally {
                try { await reader.cancel(); } catch (_) {}
            }
        })();
    }).catch(() => {}).finally(() => {
        clearTimeout(timer);
        activeStreamWarmups.delete(key);
    });
}
function stopStreamWarmups(jobId) {
    const prefix = `${jobId}:`;
    for (const [key, controller] of activeStreamWarmups) {
        if (!key.startsWith(prefix)) continue;
        try { controller.abort(); } catch (_) {}
        activeStreamWarmups.delete(key);
    }
}

/** Slow-start policy: after 10s warmup, sample 2s of progress. Restart only if
 *  almost no bytes arrived OR sustained speed is under 1 Mbps. */
const WARMUP_DURATION_MS = 10000;
const SPEED_CHECK_WINDOW_MS = 2000;
const MIN_SPEED_BPS = 125000; // 1 Mbps
const MAX_SLOW_RESTARTS = 2;
const activeDownloadMonitors = new Map();

function clearDownloadMonitor(jobId) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor) return;
    for (const timer of monitor.timers || []) clearTimeout(timer);
    activeDownloadMonitors.delete(jobId);
}

function startDownloadWarmupMonitor(jobId, tabId, request = {}, attempt = 0) {
    if (!jobId || !Number.isInteger(tabId)) return;
    clearDownloadMonitor(jobId);

    const monitor = {
        tabId,
        request: { ...(request || {}) },
        attempt: Number(attempt) || 0,
        timers: [],
        received: { video: 0, audio: 0 },
        bytesAtWarmupEnd: null,
        finished: false
    };
    activeDownloadMonitors.set(jobId, monitor);

    const totalSec = Math.round(WARMUP_DURATION_MS / 1000);
    for (let remaining = totalSec; remaining >= 1; remaining--) {
        const timer = setTimeout(() => {
            if (!activeDownloadMonitors.has(jobId)) return;
            sendTab(tabId, {
                type: 'videoStageWarmup',
                jobId,
                remainingSec: remaining,
                totalSec
            }).catch?.(() => {});
        }, (totalSec - remaining) * 1000);
        monitor.timers.push(timer);
    }

    const warmupDone = setTimeout(() => {
        const current = activeDownloadMonitors.get(jobId);
        if (!current || current.finished) return;
        current.bytesAtWarmupEnd =
            (current.received.video || 0) + (current.received.audio || 0);
        sendTab(tabId, {
            type: 'videoStageWarmup',
            jobId,
            remainingSec: 0,
            totalSec,
            phase: 'checking'
        }).catch?.(() => {});
        const check = setTimeout(() => {
            evaluateSlowStartAndMaybeRestart(jobId);
        }, SPEED_CHECK_WINDOW_MS);
        current.timers.push(check);
    }, WARMUP_DURATION_MS);
    monitor.timers.push(warmupDone);
}

function noteDownloadProgress(jobId, label, received) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor || monitor.finished) return;
    const key = label === 'audio' ? 'audio' : 'video';
    const value = Number(received) || 0;
    if (value > monitor.received[key]) monitor.received[key] = value;
}

async function evaluateSlowStartAndMaybeRestart(jobId) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor || monitor.finished) return;
    monitor.finished = true;

    const total =
        (monitor.received.video || 0) + (monitor.received.audio || 0);
    const atEnd =
        monitor.bytesAtWarmupEnd == null ? 0 : monitor.bytesAtWarmupEnd;
    const delta = Math.max(0, total - atEnd);
    const speedBps = delta / (SPEED_CHECK_WINDOW_MS / 1000);

    const markDone = () => {
        clearDownloadMonitor(jobId);
        sendTab(monitor.tabId, {
            type: 'videoStageWarmup',
            jobId,
            remainingSec: 0,
            phase: 'done'
        }).catch?.(() => {});
    };

    // Keep going if speed is acceptable OR we already have meaningful data.
    if (speedBps >= MIN_SPEED_BPS || total >= MIN_SPEED_BPS) {
        markDone();
        return;
    }

    // Restart only when nearly empty and still under 1 Mbps.
    if (monitor.attempt >= MAX_SLOW_RESTARTS) {
        markDone();
        return;
    }

    const tabId = monitor.tabId;
    const request = { ...monitor.request };
    const nextAttempt = monitor.attempt + 1;
    clearDownloadMonitor(jobId);

    try {
        sendTab(tabId, {
            type: 'videoStageWarmup',
            jobId,
            remainingSec: 0,
            phase: 'restarting',
            attempt: nextAttempt
        }).catch?.(() => {});
        const job = (await getStoredJobs())[jobId];
        await cancelVideoStage(jobId, job, { silent: true });
        await new Promise(resolve => setTimeout(resolve, 400));
        await startVideoDownload(tabId, {
            ...request,
            _restartAttempt: nextAttempt
        });
    } catch (error) {
        console.error('[GDrive SW] Slow-start restart failed:', error);
    }
}

let sessionsCache = null;
let sessionsQueue = Promise.resolve();
let jobsCache = null;
let jobsQueue = Promise.resolve();

async function loadSessions() {
    if (!sessionsCache) {
        const result = await chrome.storage.local.get({ [STREAM_STORE_KEY]: {} });
        sessionsCache = result[STREAM_STORE_KEY] || {};
    }
    return sessionsCache;
}

function queueSessionMutation(tabId, mutator) {
    const key = String(Number(tabId));
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        const current = sessions[key] || emptySession();
        const next = await mutator(current);
        if (next === false) return sessions;
        sessions[key] = next || current;
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
        return sessions;
    });
    sessionsQueue = task.catch(error => console.error('[GDrive SW] Session storage update failed:', error));
    return task;
}

async function getStoredSession(tabId) {
    if (!Number.isInteger(tabId)) return null;
    await sessionsQueue.catch(() => {});
    const sessions = await loadSessions();
    return sessions[String(tabId)] || null;
}

async function setStoredSession(tabId, value) {
    if (!Number.isInteger(tabId)) return null;
    const key = String(tabId);
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        sessions[key] = value || emptySession();
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
        return sessions[key];
    });
    sessionsQueue = task.catch(error => console.error('[GDrive SW] Session storage update failed:', error));
    return task;
}

async function clearStoredSession(tabId) {
    if (!Number.isInteger(tabId)) return;
    const key = String(tabId);
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        delete sessions[key];
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
    });
    sessionsQueue = task.catch(error => console.error('[GDrive SW] Session storage update failed:', error));
    return task;
}

async function loadJobs() {
    if (jobsCache) return jobsCache;
    const result = await chrome.storage.local.get({ [JOB_STORE_KEY]: {} });
    jobsCache = result[JOB_STORE_KEY] || {};
    return jobsCache;
}

function queueJobMutation(mutator) {
    const task = jobsQueue.then(async () => {
        const jobs = await loadJobs();
        const changed = await mutator(jobs);
        if (changed !== false) await chrome.storage.local.set({ [JOB_STORE_KEY]: jobs });
        return jobs;
    });
    jobsQueue = task.catch(error => console.error('[GDrive SW] Stage job storage update failed:', error));
    return task;
}

async function getStoredJobs() {
    await jobsQueue.catch(() => {});
    return loadJobs();
}

function getBestAudioURL(streams) {
    const candidates = streams?.audioCandidates?.length
        ? streams.audioCandidates.filter(candidate => candidate?.url)
        : streams?.audio
            ? [{ url: streams.audioOriginal || streams.audio }]
            : [];
    const best = candidates.reduce(
        (current, candidate) => getStreamBytes(candidate.url) > getStreamBytes(current?.url) ? candidate : current,
        null
    );
    return best?.url || null;
}
