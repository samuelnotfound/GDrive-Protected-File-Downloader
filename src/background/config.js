const STREAM_STORE_KEY = 'videoSessions';
const JOB_STORE_KEY = 'videoStageJobs';

const STREAM_CAPTURE_TABS = new Map();
const QUALITY_SCAN_RUNNING = new Map();
const QUALITY_SCAN_TAB_LOCK = new Map(); // tabId -> { promise, finishedAt }

// Timings from the original extension zip, plus settle keys used by the
// Settings → Quality click sequence.
const FAST_SCAN = Object.freeze({
    menuPollMs: 120,
    settingsTimeoutMs: 5000,
    qualityTimeoutMs: 4000,
    menuTimeoutMs: 3000,
    settingsClickSettleMs: 200,
    qualityClickSettleMs: 200,
    optionClickSettleMs: 450,
    optionSettleMs: 120,
    // Wait long enough for Drive to issue a NEW itag after a quality click.
    // Do not advance to the next quality until a unique URL is confirmed (or this budget is spent).
    streamWaitMs: 1500,
    finalStreamWaitMs: 2000,
    streamPollMs: 50,
    qualitySwitchDwellMs: 400,
    finalQualitySwitchDwellMs: 500,
    finalMenuCloseWaitMs: 220,
    retrySettleMs: 140,
});
