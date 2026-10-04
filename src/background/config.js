// ============================================================================
// FILE: src/background/config.js
// PURPOSE: Central configuration constants and shared in-memory data structures
//          for background video session tracking, download jobs, and scan locks.
// ============================================================================

/**
 * Storage key under chrome.storage.session / chrome.storage.local where video sessions
 * (captured formats, active stream candidates, audio/video metadata) are persisted.
 */
const STREAM_STORE_KEY = 'videoSessions';

/**
 * Storage key under chrome.storage.session / chrome.storage.local where video stage jobs
 * (active downloads, chunk offsets, total bytes, progress) are tracked.
 */
const JOB_STORE_KEY = 'videoStageJobs';

/**
 * In-memory map of active stream capture states per tab.
 * Key: tabId (number), Value: { recentStreams: Array, probeBuffer: Array, activeProbe: Object, ... }
 *
 * HOW IT WORKS:
 * Holds fast ephemeral ring buffers of captured network requests so background listeners
 * do not have to write to chrome.storage on every single video chunk packet.
 *
 * ARCHITECTURAL NOTE / CAN BE WRITTEN IN A BETTER WAY:
 * In MV3, background service workers terminate on idle. While in-memory Map provides zero-latency
 * reads/writes, any state in STREAM_CAPTURE_TABS is lost if the worker restarts.
 * Critical session state is synced to chrome.storage.session via video-state.js, but
 * high-frequency raw request logs remain in memory.
 */
const STREAM_CAPTURE_TABS = new Map();

/**
 * In-memory concurrency lock preventing simultaneous quality scans on the same tab.
 * Key: tabId (number), Value: { promise: Promise, finishedAt: number }
 *
 * PURPOSE:
 * Prevents race conditions where two simultaneous UI actions attempt to automate
 * the Drive player's Settings -> Quality menu at the exact same moment.
 */
const QUALITY_SCAN_TAB_LOCK = new Map();

/**
 * Timing configurations for quality probing.
 *
 * HOW IT WORKS:
 * - streamWaitMs: Max milliseconds to wait for a new network stream to appear
 *   after clicking a quality label in the player menu before timing out.
 * - Object.freeze: Prevents runtime accidental modification of config properties.
 *
 * CAN BE WRITTEN IN A BETTER WAY:
 * Earlier versions of this codebase contained complex multi-ladder timings.
 * Now only streamWaitMs remains. If dynamic network speed adjustments are needed,
 * making this configurable based on slow network connections would improve reliability.
 */
const FAST_SCAN = Object.freeze({
    streamWaitMs: 1500,
});
