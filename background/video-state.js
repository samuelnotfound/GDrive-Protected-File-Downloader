// Per-tab video session/job state and stream warmup.

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
        const current = sessions[key] || emptySession(Number(tabId));
        const next = await mutator(current);
        if (next === false) return sessions;
        sessions[key] = next || current;
        sessions[key].updatedAt = Date.now();
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
        sessions[key] = value || emptySession(tabId);
        sessions[key].updatedAt = Date.now();
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
        ? streams.audioCandidates
        : streams?.audio
            ? [streams.audioOriginal || streams.audio]
            : [];
    return candidates.reduce(
        (best, url) => getStreamBytes(url) > getStreamBytes(best) ? url : best,
        null
    );
}
