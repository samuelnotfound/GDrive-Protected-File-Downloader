const STREAM_STORE_KEY = 'videoSessions';
const JOB_STORE_KEY = 'videoStageJobs';

const STREAM_CAPTURE_TABS = new Map();
const QUALITY_SCAN_TAB_LOCK = new Map(); // tabId -> { promise, finishedAt }

// Only timings still referenced by the current one-quality-at-a-time flow.
const FAST_SCAN = Object.freeze({
    streamWaitMs: 1500,
});
