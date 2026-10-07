(() => {
    const NS = 'GDriveVideoOverlay';
    const CIRCUMFERENCE = 106.81415022205297;
    const DOWNLOAD_WEIGHT = 1;
    /** No new bytes for this long during download → offer the Restart button. */
    const STALL_MS = 6000;
    /** No progress for this long while merging/finalizing → treat the job as dead so a new download isn't blocked forever. */
    const MERGE_STALL_MS = 20000;
    const state = {
        jobId: null,
        stage: 'download',
        merge: 0,
        qualityLabel: '',
        lastProgressAt: Date.now(),
        stalled: false,
        note: '',
        video: { received: 0, total: 0 },
        audio: { received: 0, total: 0 }
    };
    const OVERLAY_HTML = `
      <style>
#psd-video-progress-overlay {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 2147483646;
    pointer-events: none;
    color: #e3e3e3;
    font: 14px/1.4 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
}
#psd-video-progress-card {
    width: 360px;
    max-width: calc(100vw - 32px);
    box-sizing: border-box;
    background: #28292a;
    border-radius: 20px;
    box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.2);
    overflow: hidden;
    pointer-events: auto;
}
#psd-video-progress-body {
    padding: 16px 18px;
    box-sizing: border-box;
}
#psd-video-progress-head {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    column-gap: 14px;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
}
#psd-video-progress-spinner,         #psd-video-progress-check,         #psd-video-progress-cancel-icon {
    grid-column: 1;
    grid-row: 1;
}
#psd-video-progress-title-wrap {
    grid-column: 2;
    grid-row: 1;
}
#psd-video-progress-cancel,         #psd-video-progress-close {
    grid-column: 3;
    grid-row: 1;
}
#psd-video-progress-spinner,         #psd-video-progress-check,         #psd-video-progress-cancel-icon {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: grid;
    place-items: center;
}
#psd-video-progress-spinner svg,         #psd-video-progress-check svg,         #psd-video-progress-cancel-icon svg {
    width: 36px;
    height: 36px;
    display: block;
}
#psd-video-progress-spinner svg {
    transform: rotate(-90deg);
}
#psd-video-progress-spinner .bg {
    fill: none;
    stroke: #444746;
    stroke-width: 3.5;
}
#psd-video-progress-spinner .ring {
    fill: none;
    stroke: #a8c7fa;
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-dasharray: ${CIRCUMFERENCE};
    stroke-dashoffset: ${CIRCUMFERENCE};
    transition: stroke-dashoffset .16s linear;
}
#psd-video-progress-check {
    display: none;
}
#psd-video-progress-check circle {
    fill: none;
    stroke: #81c995;
    stroke-width: 3.5;
}
#psd-video-progress-check path {
    fill: none;
    stroke: #81c995;
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}
#psd-video-progress-cancel-icon {
    display: none;
}
#psd-video-progress-cancel-icon circle {
    fill: none;
    stroke: #f28b82;
    stroke-width: 3.5;
}
#psd-video-progress-cancel-icon path {
    fill: none;
    stroke: #f28b82;
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}
#psd-video-progress-title-wrap {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
}
#psd-video-progress-title {
    min-width: 0;
    font-size: 15px;
    line-height: 20px;
    font-weight: 500;
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
}
#psd-video-progress-detail {
    min-width: 0;
    margin-top: 3px;
    font-size: 13px;
    line-height: 18px;
    color: #c4c7c5;
    white-space: pre-line;
    overflow-wrap: anywhere;
}
#psd-video-progress-detail .psd-stream-line {
    display: block;
}
#psd-video-progress-cancel,         #psd-video-progress-close {
    border: 0;
    box-sizing: border-box;
    align-self: center;
}
#psd-video-progress-cancel {
    border-radius: 18px;
    padding: 8px 17px;
    background: rgba(168,199,250,.12);
    color: #a8c7fa;
    font: 500 13px/16px 'Google Sans', Roboto, sans-serif;
    cursor: pointer;
    white-space: nowrap;
}
#psd-video-progress-cancel:hover {
    background: rgba(168,199,250,.20);
}
#psd-video-progress-cancel:disabled {
    opacity: .55;
    cursor: default;
}
#psd-video-progress-restart {
    grid-column: 3;
    grid-row: 2;
    justify-self: stretch;
    display: none;
    margin-top: 8px;
    border: 0;
    box-sizing: border-box;
    border-radius: 18px;
    padding: 8px 17px;
    background: rgba(253,214,99,.14);
    color: #fdd663;
    font: 500 13px/16px 'Google Sans', Roboto, sans-serif;
    cursor: pointer;
    white-space: nowrap;
}
#psd-video-progress-restart:hover {
    background: rgba(253,214,99,.24);
}
#psd-video-progress-restart:disabled {
    opacity: .55;
    cursor: default;
}
#psd-video-progress-close {
    display: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: transparent;
    color: #c4c7c5;
    font: 18px/28px Arial, sans-serif;
    cursor: pointer;
    padding: 0;
    text-align: center;
}
#psd-video-progress-close:hover {
    background: rgba(255,255,255,.08);
    color: #e3e3e3;
}
#psd-video-progress-overlay.processing #psd-video-progress-spinner,         #psd-video-progress-overlay.completed #psd-video-progress-spinner,         #psd-video-progress-overlay.cancelled #psd-video-progress-spinner,         #psd-video-progress-overlay.error #psd-video-progress-spinner {
    visibility: hidden;
}
#psd-video-progress-overlay.completed #psd-video-progress-check {
    display: grid;
}
#psd-video-progress-overlay.cancelled #psd-video-progress-cancel-icon,
#psd-video-progress-overlay.error #psd-video-progress-cancel-icon {
    display: grid;
}
#psd-video-progress-overlay.completed #psd-video-progress-cancel {
    display: none;
}
#psd-video-progress-overlay.completed #psd-video-progress-close {
    display: block;
}
#psd-video-progress-overlay.completed #psd-video-progress-head {
    grid-template-columns: 36px minmax(0,1fr) 28px;
}
#psd-video-progress-overlay.cancelled #psd-video-progress-cancel,
#psd-video-progress-overlay.error #psd-video-progress-cancel {
    display: none;
}
#psd-video-progress-overlay.cancelled #psd-video-progress-close,
#psd-video-progress-overlay.error #psd-video-progress-close {
    display: block;
}
#psd-video-progress-overlay.cancelled #psd-video-progress-head,
#psd-video-progress-overlay.error #psd-video-progress-head {
    grid-template-columns: 36px minmax(0,1fr) 28px;
}
      </style>
      <div id="psd-video-progress-card">
        <div id="psd-video-progress-body">
          <div id="psd-video-progress-head">
            <div id="psd-video-progress-spinner" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle class="bg" cx="20" cy="20" r="17"></circle>
                <circle id="psd-video-progress-ring" class="ring" cx="20" cy="20" r="17"></circle>
              </svg>
            </div>
            <div id="psd-video-progress-check" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17"></circle>
                <path d="M11.5 20.5 17 26l11.5-12"></path>
              </svg>
            </div>
            <div id="psd-video-progress-cancel-icon" aria-hidden="true">
              <svg viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17"></circle>
                <path d="M14 14 26 26"></path>
                <path d="M26 14 14 26"></path>
              </svg>
            </div>
            <div id="psd-video-progress-title-wrap">
              <div id="psd-video-progress-title">Downloading Stream</div>
              <div id="psd-video-progress-detail"></div>
            </div>
            <button id="psd-video-progress-cancel" type="button">Cancel</button>
            <button id="psd-video-progress-restart" type="button">Restart</button>
            <button id="psd-video-progress-close" type="button" aria-label="Close">×</button>
          </div>
        </div>
      </div>`;

    /** Tell video.js a job ended right now, so it doesn't sit waiting on a message that may never arrive. */
    function announceLocalEnd() {
        try { document.dispatchEvent(new CustomEvent('psd-video-stage-local-end')); } catch (_) {}
    }
    function createOverlayRoot() {
        const root = document.createElement("div");
        root.id = "psd-video-progress-overlay";
        root.innerHTML = OVERLAY_HTML;
        return root;
    }
    function bindOverlayEvents(root) {
        const cancelButton = root.querySelector("#psd-video-progress-cancel");
        const closeButton = root.querySelector("#psd-video-progress-close");
        cancelButton.addEventListener("click", () => {
            const jobId = state.jobId;
            if (!jobId || cancelButton.disabled) return;
            cancelButton.disabled = true;
            state.jobId = null;
            setState("cancelled");
            announceLocalEnd();
            try {
                chrome.runtime.sendMessage({
                    type: "videoStageCancel",
                    jobId
                });
            } catch (_) {
                // The page can disappear while a download is being cancelled.
            }
            setTimeout(() => {
                const currentRoot = document.getElementById(
                    "psd-video-progress-overlay"
                );
                if (currentRoot) currentRoot.style.display = "none";
            }, 700);
        });
        closeButton.addEventListener("click", () => {
            const jobId = state.jobId;
            state.jobId = null;
            root.style.display = "none";
            announceLocalEnd();
            if (jobId) {
                try {
                    chrome.runtime.sendMessage({ type: "videoStageCancel", jobId });
                } catch (_) {
                    // The page can disappear while we're cleaning up.
                }
            }
        });
        const restartButton = root.querySelector("#psd-video-progress-restart");
        restartButton.addEventListener("click", () => {
            const jobId = state.jobId;
            if (!jobId || restartButton.disabled) return;
            // Give the restarted download a fresh grace period before the
            // button can reappear, and tell the user something is happening.
            state.lastProgressAt = Date.now();
            state.note = "Restarting download…";
            syncRestart();
            refreshDetail();
            try {
                const pending = chrome.runtime.sendMessage({
                    type: "videoStageRestart",
                    jobId
                });
                pending?.catch?.(() => {});
            } catch (_) {
                // The page can disappear while restarting.
            }
        });
    }
    /**
     * Merging/finalizing has no retry UI of its own — if it stalls (e.g. a
     * worker wedged on a malformed stream) the overlay would otherwise sit
     * on "Processing: 100%" forever and the stale jobId would keep blocking
     * every future download attempt. Give up after MERGE_STALL_MS and
     * release the lock so the user can simply try again.
     */
    function checkMergeStall() {
        if (!state.jobId) return;
        if (state.stage !== 'merge' && state.stage !== 'processing') return;
        if (Date.now() - state.lastProgressAt < MERGE_STALL_MS) return;

        const jobId = state.jobId;
        state.jobId = null;
        setState('error', 'This was taking too long and was stopped. Please try downloading again.', true);
        announceLocalEnd();
        try {
            chrome.runtime.sendMessage({ type: 'videoStageCancel', jobId });
        } catch (_) {
            // The page can disappear while we're cleaning up.
        }
    }
    /** Show the Restart button only while a download has made no progress. */
    function syncRestart() {
        const root = document.getElementById("psd-video-progress-overlay");
        if (!root) return;
        const button = root.querySelector("#psd-video-progress-restart");
        if (!button) return;
        const show = !!state.jobId
            && state.stage === "download"
            && root.style.display !== "none"
            && Date.now() - state.lastProgressAt >= STALL_MS;
        const changed = show !== state.stalled;
        state.stalled = show;
        button.style.display = show ? "inline-flex" : "none";
        if (changed) refreshDetail();
    }
    function refreshDetail() {
        const root = document.getElementById("psd-video-progress-overlay");
        const info = root?.querySelector("#psd-video-progress-detail");
        if (info && state.stage === "download") info.textContent = formatSeparateProgress();
    }
    let stallTimer = null;
    function ensure() {
        if (window.top !== window.self) return null;
        let root = document.getElementById("psd-video-progress-overlay");
        if (root) return root;
        root = createOverlayRoot();
        (document.body || document.documentElement).appendChild(root);
        root.style.display = "none";
        bindOverlayEvents(root);
        if (!stallTimer) stallTimer = setInterval(() => { syncRestart(); checkMergeStall(); }, 1000);
        return root;
    }
    function combinedTotal() {
        const videoTotal = Math.max(0, Number(state.video.total) || 0);
        const audioTotal = Math.max(0, Number(state.audio.total) || 0);
        return videoTotal + audioTotal;
    }
    function combinedReceived() {
        const videoReceived = Math.max(0, Number(state.video.received) || 0);
        const audioReceived = Math.max(0, Number(state.audio.received) || 0);
        return videoReceived + audioReceived;
    }
    function streamLine(label, received, total) {
        const r = Math.max(0, Number(received) || 0);
        // Drive often under-reports clen / Content-Range; never show received > total.
        const t = Math.max(0, Number(total) || 0, r);
        if (t > 0) return `${label}: ${formatBytes(r)} / ${formatBytes(t)}`;
        if (r > 0) return `${label}: ${formatBytes(r)}`;
        return `${label}: —`;
    }
    function formatSeparateProgress() {
        const lines = formatStreamLines();
        if (state.stalled) return (lines ? lines + '\n' : '') + 'No data received. Try Restart.';
        if (state.note) return (lines ? lines + '\n' : '') + state.note;
        return lines;
    }
    function formatStreamLines() {
        const hasVideo = (state.video.total > 0) || (state.video.received > 0);
        const hasAudio = (state.audio.total > 0) || (state.audio.received > 0);
        // Progressive / single-stream downloads only report under "video".
        if (hasVideo && !hasAudio) {
            return streamLine('Video', state.video.received, state.video.total);
        }
        if (!hasVideo && hasAudio) {
            return streamLine('Audio', state.audio.received, state.audio.total);
        }
        if (hasVideo && hasAudio) {
            return (
                streamLine('Video', state.video.received, state.video.total) +
                '\n' +
                streamLine('Audio', state.audio.received, state.audio.total)
            );
        }
        return '';
    }
    function downloadOverallPercent() {
        const combinedSize = combinedTotal();
        if (!combinedSize) return 0;
        const combinedDownloaded = Math.min(combinedSize, combinedReceived());
        return Math.max(0, Math.min(1, combinedDownloaded / combinedSize));
    }
    function setRing(overallPercent) {
        const root = ensure();
        if (!root) return;
        const ring = root.querySelector('#psd-video-progress-ring');
        const progress = Math.max(0, Math.min(100, Number(overallPercent) || 0)) / 100;
        if (ring) {
            ring.style.strokeDasharray = String(CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));
        }
    }
    function stageRank(stage) {
        return({
            download: 1, merge: 2, processing: 3, started: 4, ready: 5, cancel: 99, cancelled: 99, error: 99
        })[stage] || 0;
    }
    function setState(stage, detail = null, force = false) {
        const root = ensure();
        if (!root) return false;
        if (!force && stageRank(stage) < stageRank(state.stage)) return false;
        root.classList.remove('processing', 'started', 'completed', 'cancelled', 'error');
        const title = root.querySelector('#psd-video-progress-title');
        const info = root.querySelector('#psd-video-progress-detail');
        const cancel = root.querySelector('#psd-video-progress-cancel');
        if (stage !== 'download') {
            const restartBtn = root.querySelector('#psd-video-progress-restart');
            if (restartBtn) restartBtn.style.display = 'none';
            state.stalled = false;
            state.note = '';
        }
        if (stage === 'download') {
            title.textContent = state.qualityLabel
                ? `Downloading ${state.qualityLabel}`
                : 'Downloading Stream';
            info.textContent = formatSeparateProgress();
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
            // A previous job may have left the ring in the indeterminate/full
            // state. Force every new download back to an empty progress ring.
            const ring = root.querySelector('#psd-video-progress-ring');
            if (ring) {
                ring.style.animation = 'none';
                ring.style.strokeDasharray = String(CIRCUMFERENCE);
                ring.style.strokeDashoffset = String(CIRCUMFERENCE);
            }
        }else if (stage === 'merge') {
            title.textContent = 'Processing video';
            const percent = Math.round(Math.max(0, Math.min(1, Number(state.merge) || 0)) * 100);
            info.textContent = `Processing: ${percent}%`;
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
            setRing(percent);
        }else if (stage === 'processing') {
            title.textContent = 'Finalizing download';
            info.textContent = 'Please wait..';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
            root.classList.add('processing');
            setRing(0);
        }else if (stage === 'started') {
            title.textContent = 'Download has started';
            info.textContent = '';
            cancel.style.display = 'none';
            // Chrome now owns the final file download. There is no reliable
            // byte-progress event here, so start this stage with an empty ring
            // instead of leaving the processing ring full or showing a fake
            // progress segment.
            setRing(0);
        }else if (stage === 'ready') {
            title.textContent = 'Video downloaded';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('completed');
            setRing(100);
        }else if (stage === 'cancel' || stage === 'cancelled') {
            title.textContent = 'Download Cancelled';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('cancelled');
            stage = 'cancelled';
        }else if (stage === 'error') {
            title.textContent = 'Video download failed';
            info.textContent = detail || 'The video could not be downloaded.';
            cancel.style.display = 'none';
            root.classList.add('error');
        }
        state.stage = stage;
        return true;
    }
    function formatBytes(bytes) {
        const n = Math.max(0, Number(bytes) || 0);
        if (n < 1024) return `${Math.round(n)} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = n;
        let unit = 'B';
        for (const next of units) {
            if (value < 1024) break;
            value /= 1024;
            unit = next;
        }
        const digits = value >= 100  ? 0: value >= 10  ? 1: 2;
        return `${value.toFixed(digits)} ${unit}`;
    }
    function show(visible = true, jobId = null, videoTotal = 0, audioTotal = 0, qualityLabel = '') {
        const root = ensure();
        if (!root) return;
        if (!visible) {
            root.style.display = 'none';
            return;
        }
        // Same active job → just keep the overlay visible (don't reset progress).
        // Different job or finished stage → full reset.
        const sameActiveJob =
            jobId &&
            state.jobId === jobId &&
            !['ready', 'cancelled', 'error'].includes(state.stage);
        if (sameActiveJob) {
            root.style.display = 'block';
            if (qualityLabel) {
                state.qualityLabel = qualityLabel;
                const title = root.querySelector('#psd-video-progress-title');
                if (title && state.stage === 'download') {
                    title.textContent = `Downloading ${qualityLabel}`;
                }
            }
            return;
        }
        root.style.display = 'block';
        state.jobId = jobId || null;
        state.stage = 'download';
        state.merge = 0;
        state.lastProgressAt = Date.now();
        state.stalled = false;
        state.note = '';
        state.qualityLabel = qualityLabel || state.qualityLabel || '';
        state.video.total = Math.max(0, Number(videoTotal) || 0);
        state.audio.total = Math.max(0, Number(audioTotal) || 0);
        state.video = { received: 0, total: state.video.total };
        state.audio = { received: 0, total: state.audio.total };
        setState('download', null, true);
        // Reset again after the state/class change so no stale visual state
        // from the previous job can flash as a full circle.
        setRing(0);
    }
    function setJob(jobId, videoTotal = 0, audioTotal = 0) {
        state.jobId = jobId || state.jobId;
        if (videoTotal) state.video.total = Number(videoTotal) || state.video.total;
        if (audioTotal) state.audio.total = Number(audioTotal) || state.audio.total;
        setState(state.stage);
    }
    function update(msg = {
    }) {
        const root = ensure();
        if (!root) return;

        if (msg.label === 'video' || msg.label === 'audio') {
            // Ignore late progress after the job has already finished/cancelled.
            // clearJob() nulls jobId before the terminal stage update, so without
            // this guard the overlay keeps rewriting numbers after "Video downloaded".
            if (['ready', 'cancelled', 'error'].includes(state.stage)) return;

            const bucket = state[msg.label];
            // Any progress message with a new byte count proves data is flowing
            // (after a resume the count restarts below the old maximum).
            const incoming = Number(msg.received) || 0;
            if (incoming > 0 && incoming !== bucket.lastMsgReceived) {
                bucket.lastMsgReceived = incoming;
                state.lastProgressAt = Date.now();
                state.note = '';
                if (state.stalled) {
                    state.stalled = false;
                    const restartBtn = root.querySelector('#psd-video-progress-restart');
                    if (restartBtn) restartBtn.style.display = 'none';
                }
            }
            bucket.received = Math.max(bucket.received, incoming);
            const reportedTotal = Math.max(0, Number(msg.total) || 0);
            // Prefer a larger total whenever one arrives (Content-Range often
            // corrects an undersized clen from the original stream URL).
            if (reportedTotal > bucket.total) bucket.total = reportedTotal;
            // Keep total at least as large as received so the UI never shows inverted figures.
            if (bucket.received > bucket.total) bucket.total = bucket.received;

            const percent = downloadOverallPercent();
            if (state.stage === 'download') setRing(percent * DOWNLOAD_WEIGHT * 100);

            const detail = root.querySelector('#psd-video-progress-detail');
            if (detail) detail.textContent = formatSeparateProgress();
            return;
        }
        if (msg.stage === 'download') {
            if (state.stage === 'download') {
                const percent = downloadOverallPercent();
                setRing(percent * DOWNLOAD_WEIGHT * 100);
            }
            return;
        }
        if (msg.stage === 'merge') {
            state.merge = Math.max(0, Math.min(1, Number(msg.progress) || 0));
            state.lastProgressAt = Date.now();
            if (!setState('merge')) return;
            const percent = state.merge * 100;
            const info = root.querySelector('#psd-video-progress-detail');
            if (info) info.textContent = `Processing: ${Math.round(percent)}%`;
            setRing(percent);
            return;
        }
        if (msg.stage === 'processing') {
            state.lastProgressAt = Date.now();
            setState('processing');
            return;
        }
        if (msg.stage === 'started') {
            setState('started');
            return;
        }
        if (msg.stage === 'ready') {
            setState('ready', null, true);
            return;
        }
        if (msg.stage === 'cancel') {
            state.jobId = null;
            setState('cancel', null, true);
            setTimeout(() => {
                const current = document.getElementById('psd-video-progress-overlay');
                if (current) current.style.display = 'none';
            }, 700);
            return;
        }
        if (msg.stage === 'error') {
            state.jobId = null;
            setState('error', msg.message || '', true);
        }
    }
    /** Offscreen confirmed a restart. reset=true means it began again from byte 0. */
    function markRestarted(reset = false) {
        state.lastProgressAt = Date.now();
        state.note = '';
        if (reset) {
            state.video = { received: 0, total: state.video.total, lastMsgReceived: 0 };
            state.audio = { received: 0, total: state.audio.total, lastMsgReceived: 0 };
        }
        syncRestart();
        refreshDetail();
    }
    window[NS] = {
        show, setJob, update, markRestarted, getJobId: () => state.jobId, getStage: () => state.stage, clearJob: () => {
            state.jobId = null;
            /* keep qualityLabel for display continuity */
        }
    };
})();
