// ============================================================================
// FILE: src/background/video-state.js
// PURPOSE: Manages download session persistence, download jobs queue, CDN slow-start
//          warmup monitoring, edge-server speed sampling & automatic restarts,
//          and sequential FIFO lock queues for chrome.storage read-modify-write safety.
// ============================================================================

/**
 * Map tracking active pre-fetch stream warmup abort controllers.
 * Key: `${jobId}:${label}`, Value: AbortController instance
 */
const activeStreamWarmups = new Map();

/**
 * Initiates an early HTTP stream pre-fetch ("warmup") to establish TCP/TLS handshakes
 * and pre-buffer Google CDN edge caches before the chunk downloader begins.
 *
 * HOW IT WORKS:
 * 1. Creates an AbortController with a timeout (default 10,000ms).
 * 2. Issues an un-cached fetch with user credentials included (cookies/auth).
 * 3. Drains the response stream body chunks via a ReadableStream reader.
 * 4. Cleans up the timer and controller in a finally block.
 *
 * @param {string} jobId - Video download job ID
 * @param {string} label - Stream label ("video" or "audio")
 * @param {string} url - Direct media stream URL
 * @param {number} [durationMs=10000] - Max warmup duration before aborting
 */
function startStreamWarmup(jobId, label, url, durationMs = 10000) {
    if (!jobId || !url) return;
    const key = `${jobId}:${label}`;
    const controller = new AbortController();
    activeStreamWarmups.set(key, controller);

    // Automatically abort warmup when timer expires
    const timer = setTimeout(() => controller.abort(), durationMs);

    fetch(url, {
        credentials: 'include', // Pass Drive session cookies
        cache: 'no-store',       // Bypass browser HTTP cache to hit edge CDN directly
        redirect: 'follow',
        signal: controller.signal
    }).then(response => {
        if (!response.ok || !response.body) return;
        return (async () => {
            const reader = response.body.getReader();
            try {
                // Drain stream chunks continuously until done or aborted
                while (!(await reader.read()).done) {}
            } finally {
                // Ensure reader lock is released
                try { await reader.cancel(); } catch (_) {}
            }
        })();
    }).catch(() => {
        // Fetch aborted or network disconnected; expected on timeout
    }).finally(() => {
        clearTimeout(timer);
        activeStreamWarmups.delete(key);
    });
}

/**
 * Aborts and cancels all active warmup stream fetches for a specified job.
 *
 * @param {string} jobId - Video download job ID
 */
function stopStreamWarmups(jobId) {
    const prefix = `${jobId}:`;
    for (const [key, controller] of activeStreamWarmups) {
        if (!key.startsWith(prefix)) continue;
        try { controller.abort(); } catch (_) {}
        activeStreamWarmups.delete(key);
    }
}

/**
 * SLOW-START CDN RETRY POLICY:
 * Google Drive's CDN sometimes routes requests to severely throttled or overloaded
 * edge nodes (e.g. capped at < 500 Kbps).
 *
 * THE STRATEGY:
 * 1. Warmup window (10s): UI shows warmup countdown.
 * 2. Measure window (at 15s for 2s): Calculates transfer speed in bytes per second.
 * 3. Threshold check: If speed < 1 Mbps (125,000 bytes/sec) and retries remain (< 2):
 *    - Abort the stalled job.
 *    - Re-initiate download after 500ms delay.
 *    - Google's Anycast DNS/CDN balancer usually routes the new request to a faster edge server!
 */
const WARMUP_DURATION_MS = 10000; // 10 seconds initial warmup
const SPEED_CHECK_AT_MS = 15000;  // Start speed sampling at 15s after download starts
const SPEED_CHECK_MS = 2000;      // Duration of speed sample (2s)
const MIN_SPEED_BPS = 125000;     // 125 KB/s = 1 Mbps minimum acceptable speed
const MAX_SLOW_RESTARTS = 2;      // Maximum number of speed-based restarts permitted

/** In-memory map of active download speed monitors keyed by jobId */
const activeDownloadMonitors = new Map();

/**
 * Cancels all timers and removes the speed monitor for a job.
 *
 * @param {string} jobId - Video download job ID
 */
function clearDownloadMonitor(jobId) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor) return;
    for (const timer of monitor.timers || []) clearTimeout(timer);
    activeDownloadMonitors.delete(jobId);
}

/**
 * Starts the slow-start warmup monitor and schedules the 15-second speed check.
 *
 * @param {string} jobId - Video download job ID
 * @param {number} tabId - Browser tab ID
 * @param {Object} [request={}] - Download request parameters
 * @param {number} [attempt=0] - Current restart attempt count
 */
function startDownloadWarmupMonitor(jobId, tabId, request = {}, attempt = 0) {
    if (!jobId || !Number.isInteger(tabId)) return;
    clearDownloadMonitor(jobId);

    const monitor = {
        tabId,
        request: { ...(request || {}) },
        attempt: Number(attempt) || 0,
        timers: [],
        received: { video: 0, audio: 0 },
        bytesAtCheckStart: 0,
        finished: false
    };
    activeDownloadMonitors.set(jobId, monitor);

    // Timer 1: End of warmup phase (10s) -> Notify UI
    const afterWarmup = setTimeout(() => {
        const current = activeDownloadMonitors.get(jobId);
        if (!current || current.finished) return;
        sendTab(tabId, {
            type: 'videoStageWarmup',
            jobId,
            remainingSec: 0,
            totalSec: Math.round(WARMUP_DURATION_MS / 1000),
            phase: 'done'
        }).catch?.(() => {});
    }, WARMUP_DURATION_MS);
    monitor.timers.push(afterWarmup);

    // Timer 2: Start 2-second speed sample at 15s
    const startSample = setTimeout(() => {
        const current = activeDownloadMonitors.get(jobId);
        if (!current || current.finished) return;

        // Snapshot total bytes received at the beginning of the 2-second sample window
        current.bytesAtCheckStart =
            (current.received.video || 0) + (current.received.audio || 0);

        // Timer 3: Evaluate speed after 2-second sampling interval
        const evaluateTimer = setTimeout(() => {
            void evaluateSlowStartAndMaybeRestart(jobId);
        }, SPEED_CHECK_MS);
        current.timers.push(evaluateTimer);
    }, SPEED_CHECK_AT_MS);
    monitor.timers.push(startSample);
}

/**
 * Updates recorded byte counts for an active download monitor.
 *
 * @param {string} jobId - Video download job ID
 * @param {string} label - "video" or "audio"
 * @param {number} received - Total bytes received so far
 */
function noteDownloadProgress(jobId, label, received) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor || monitor.finished) return;
    const key = label === 'audio' ? 'audio' : 'video';
    const value = Number(received) || 0;
    // Keep monotonically increasing maximum byte value
    if (value > monitor.received[key]) monitor.received[key] = value;
}

/**
 * Evaluates measured speed against MIN_SPEED_BPS and restarts download if throttled.
 *
 * @param {string} jobId - Video download job ID
 */
async function evaluateSlowStartAndMaybeRestart(jobId) {
    const monitor = activeDownloadMonitors.get(jobId);
    if (!monitor || monitor.finished) return;

    // Lock immediately to prevent duplicate evaluations
    monitor.finished = true;

    // Calculate delta bytes transferred over the sample window
    const total = (monitor.received.video || 0) + (monitor.received.audio || 0);
    const atStart = monitor.bytesAtCheckStart || 0;
    const delta = Math.max(0, total - atStart);
    // Convert to bytes per second
    const speedBps = delta / (SPEED_CHECK_MS / 1000);

    const tabId = monitor.tabId;
    const request = { ...monitor.request };
    const attempt = monitor.attempt;

    // If speed is satisfactory (>= 1 Mbps) or retry attempts exhausted, continue normally
    if (speedBps >= MIN_SPEED_BPS || attempt >= MAX_SLOW_RESTARTS) {
        clearDownloadMonitor(jobId);
        return;
    }

    // Speed was throttled by CDN (< 1 Mbps); execute automatic restart
    const nextAttempt = attempt + 1;
    clearDownloadMonitor(jobId);

    try {
        // Inform UI overlay that download is restarting due to slow connection
        sendTab(tabId, {
            type: 'videoStageWarmup',
            jobId,
            remainingSec: 0,
            phase: 'restarting',
            attempt: nextAttempt
        }).catch?.(() => {});

        // Fetch current job record, cancel silently without showing error UI
        const job = (await getStoredJobs())[jobId];
        await cancelVideoStage(jobId, job, { silent: true });
        // Brief pause to allow sockets to close
        await new Promise(resolve => setTimeout(resolve, 500));
        // Restart download with incremented attempt counter
        await startVideoDownload(tabId, {
            ...request,
            _restartAttempt: nextAttempt
        });
    } catch (error) {
        // If restart fails, job was already cancelled or tab was closed
    }
}

// ============================================================================
// ASYNC STORAGE SEQUENTIAL MUTATION QUEUES
// ============================================================================
// PROBLEM SOLVED:
// Chrome storage API (chrome.storage.local) is asynchronous. If two background
// events execute `get()` -> mutate -> `set()` concurrently, the second `set()`
// will overwrite and erase changes made by the first (classic lost-update race condition).
//
// SOLUTION:
// Chain all mutations onto a sequential Promise queue (`sessionsQueue` / `jobsQueue`).
// Every read-modify-write operation waits for the previous operation to complete.
// ============================================================================

let sessionsCache = null;
let sessionsQueue = Promise.resolve();
let jobsCache = null;
let jobsQueue = Promise.resolve();

let sessionsLoadPromise = null;

/**
 * Loads video session records from chrome.storage.local with in-memory caching
 * and concurrent in-flight promise deduplication.
 *
 * @returns {Promise<Object>} Map of sessions keyed by tabId
 */
async function loadSessions() {
    if (sessionsCache) return sessionsCache;
    // Deduplicate concurrent cold-start calls so only one chrome.storage.local.get occurs
    if (!sessionsLoadPromise) {
        sessionsLoadPromise = chrome.storage.local.get({ [STREAM_STORE_KEY]: {} })
            .then(result => {
                sessionsCache = result[STREAM_STORE_KEY] || {};
                return sessionsCache;
            })
            .finally(() => { sessionsLoadPromise = null; });
    }
    return sessionsLoadPromise;
}

/**
 * Serializes mutations to the stored tab session through a FIFO Promise queue.
 *
 * @param {number} tabId - Browser tab ID
 * @param {Function} mutator - Synchronous or asynchronous callback `(session) => session|false`
 * @returns {Promise<Object>} Updated sessions dictionary
 */
function queueSessionMutation(tabId, mutator) {
    const key = String(Number(tabId));
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        const current = sessions[key] || emptySession();
        // Mutator returns false if mutation was rejected/aborted
        const next = await mutator(current);
        if (next === false) return sessions;
        sessions[key] = next || current;
        // Persist back to storage
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
        return sessions;
    });
    // Ensure rejected tasks don't break the promise chain
    sessionsQueue = task.catch(() => {});
    return task;
}

/**
 * Retrieves the stored session object for a specific tab ID.
 *
 * @param {number} tabId - Target tab ID
 * @returns {Promise<Object|null>} Session object or null
 */
async function getStoredSession(tabId) {
    if (!Number.isInteger(tabId)) return null;
    // Wait for any pending session mutations to flush
    await sessionsQueue.catch(() => {});
    const sessions = await loadSessions();
    return sessions[String(tabId)] || null;
}

/**
 * Sets the stored session object for a specific tab ID.
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} value - New session state object
 * @returns {Promise<Object>}
 */
async function setStoredSession(tabId, value) {
    if (!Number.isInteger(tabId)) return null;
    const key = String(tabId);
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        sessions[key] = value || emptySession();
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
        return sessions[key];
    });
    sessionsQueue = task.catch(() => {});
    return task;
}

/**
 * Deletes the stored session record for a tab ID.
 *
 * @param {number} tabId - Browser tab ID
 * @returns {Promise<void>}
 */
async function clearStoredSession(tabId) {
    if (!Number.isInteger(tabId)) return;
    const key = String(tabId);
    const task = sessionsQueue.then(async () => {
        const sessions = await loadSessions();
        delete sessions[key];
        await chrome.storage.local.set({ [STREAM_STORE_KEY]: sessions });
    });
    sessionsQueue = task.catch(() => {});
    return task;
}

let jobsLoadPromise = null;

/**
 * Loads video stage jobs from chrome.storage.local with in-flight deduplication.
 *
 * @returns {Promise<Object>} Map of active jobs keyed by jobId
 */
async function loadJobs() {
    if (jobsCache) return jobsCache;
    if (!jobsLoadPromise) {
        jobsLoadPromise = chrome.storage.local.get({ [JOB_STORE_KEY]: {} })
            .then(result => {
                jobsCache = result[JOB_STORE_KEY] || {};
                return jobsCache;
            })
            .finally(() => { jobsLoadPromise = null; });
    }
    return jobsLoadPromise;
}

/**
 * Serializes mutations to the video jobs dictionary.
 *
 * @param {Function} mutator - Callback `(jobs) => jobs|false`
 * @returns {Promise<Object>}
 */
function queueJobMutation(mutator) {
    const task = jobsQueue.then(async () => {
        const jobs = await loadJobs();
        const changed = await mutator(jobs);
        if (changed !== false) await chrome.storage.local.set({ [JOB_STORE_KEY]: jobs });
        return jobs;
    });
    jobsQueue = task.catch(() => {});
    return task;
}

/**
 * Retrieves all stored video download jobs after flushing the mutation queue.
 *
 * @returns {Promise<Object>}
 */
async function getStoredJobs() {
    await jobsQueue.catch(() => {});
    return loadJobs();
}

/**
 * Selects the audio stream URL with the largest byte size from candidate streams.
 *
 * PURPOSE:
 * Larger byte size corresponds to higher bitrate / uncompressed audio quality.
 *
 * @param {Object} streams - Stream candidates container
 * @returns {string|null} Best audio stream URL or null
 */
function getBestAudioURL(streams) {
    const candidates = streams?.audioCandidates?.length
        ? streams.audioCandidates.filter(candidate => candidate?.url)
        : streams?.audio
            ? [{ url: streams.audioOriginal || streams.audio }]
            : [];

    // Reduce over candidates, keeping candidate with largest clen byte count
    const best = candidates.reduce(
        (current, candidate) => getStreamBytes(candidate.url) > getStreamBytes(current?.url) ? candidate : current,
        null
    );
    return best?.url || null;
}
