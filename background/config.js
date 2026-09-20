/**
 * Background Service Worker
 *
 * Video state is scoped to the Drive tab + viewer session/file.  The extension
 * can also ask Drive's current playback metadata endpoint for available
 * transcodes before playback starts, then use the selected stream URLs for the
 * local download/FFmpeg pipeline. Quality discovery can temporarily play the
 * muted Drive player so its real Settings -> Quality controls generate the
 * corresponding videoplayback requests.
 */

const DRIVE_PLAYBACK_API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';
const STREAM_STORE_KEY = 'videoSessions';
const JOB_STORE_KEY = 'videoStageJobs';
const FORMAT_PROBE_TIMEOUT_MS = 6500;

const DEBUGGER_NETWORK_TABS = new Map();
const QUALITY_SCAN_RUNNING = new Map();

// Fast quality-scan timing: keep the proven V24 interaction path, but remove
// unnecessary dwell time. Drive closes/rebuilds its menus after every quality
// selection, so these waits are short settle windows rather than fixed pauses.
const FAST_SCAN = Object.freeze({
    settingsHoverMs: 20,
    settingsClickSettleMs: 120,
    qualityHoverMs: 15,
    qualityClickSettleMs: 140,
    menuPollMs: 60,
    menuTimeoutMs: 800,
    optionSettleMs: 120,
    // Allow Drive enough time to emit the representation-specific media request.
    streamWaitMs: 650,
    // The final quality is detached from chrome.debugger immediately after the click.
    // webRequest remains active and can capture the signed videoplayback URL without
    // keeping Chrome's "started debugging" banner on screen.
    finalStreamWaitMs: 250,
    streamPollMs: 35,
    // Explicit dwell between resolutions so the current representation can start
    // loading before Drive is asked to switch again.
    qualitySwitchDwellMs: 250,
    // The final quality is already the last representation we need to capture.
    // Do not add a post-click dwell before releasing chrome.debugger; the quality
    // request has already been observed by the probe polling loop.
    finalQualitySwitchDwellMs: 0,
    // Do not spend the normal 900 ms menu-close verification on the last quality.
    // The click has already been delivered; webRequest confirms the resulting stream.
    finalMenuCloseWaitMs: 220,
    retrySettleMs: 140,
    finalProbeTimeoutMs: 1600
});


// Shared service-worker primitives.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendTab = async (tabId, message) => {
    if (!Number.isInteger(tabId)) return;
    try { await chrome.tabs.sendMessage(tabId, message); } catch (_) {}
};
const sendOffscreen = message => {
    try {
        chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch?.(() => {});
    } catch (_) {}
};
const setBadge = text => {
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {}
};

// Drive-specific speed optimization retained from the working version.
