const DRIVE_PLAYBACK_API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';
const STREAM_STORE_KEY = 'videoSessions';
const JOB_STORE_KEY = 'videoStageJobs';
const FORMAT_PROBE_TIMEOUT_MS = 6500;

const STREAM_CAPTURE_TABS = new Map();
const QUALITY_SCAN_RUNNING = new Map();

const FAST_SCAN = Object.freeze({
    menuPollMs: 120,
    settingsTimeoutMs: 5000,
    qualityTimeoutMs: 4000,
    menuTimeoutMs: 3000,
    streamWaitMs: 650,
    finalStreamWaitMs: 250,
    streamPollMs: 35,
    qualitySwitchDwellMs: 250,
    finalQualitySwitchDwellMs: 0,
    finalMenuCloseWaitMs: 220,
    retrySettleMs: 140,
});
