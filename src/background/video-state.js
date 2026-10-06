// ============================================================================
// FILE: src/background/video-state.js
// PURPOSE: Manages download session persistence, download jobs queue, and
//          sequential FIFO lock queues for chrome.storage read-modify-write safety.
// ============================================================================

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
