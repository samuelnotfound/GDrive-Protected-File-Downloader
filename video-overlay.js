(() => {
    const NS = 'GDriveVideoOverlay';
    const CIRCUMFERENCE = 106.81415022205297;
    const DOWNLOAD_WEIGHT = 0.75;
    const state = {
        jobId: null, stage: 'download', merge: 0, fixedTotals: {
            video: 0, audio: 0
        }, bytes: {
            video: {
                received: 0, total: 0
            }, audio: {
                received: 0, total: 0
            }
        }
    };
    function createOverlayRoot() {
        const root = document.createElement("div");
        root.id = "psd-video-progress-overlay";
        root.innerHTML = `
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
#psd-video-progress-spinner,         #psd-video-progress-check {
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
#psd-video-progress-spinner,         #psd-video-progress-check {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: grid;
    place-items: center;
}
#psd-video-progress-spinner svg,         #psd-video-progress-check svg {
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
    white-space: normal;
    overflow-wrap: anywhere;
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
#psd-video-progress-overlay.started #psd-video-progress-spinner {
    visibility: visible;
}
#psd-video-progress-overlay.started #psd-video-progress-spinner svg {
    animation: psd-video-indeterminate-spin .95s linear infinite;
}
#psd-video-progress-overlay.started #psd-video-progress-spinner .ring {
    stroke-dasharray: 30 77;
    stroke-dashoffset: 0;
    transition: none;
}
@keyframes psd-video-indeterminate-spin {
    to {
        transform: rotate(270deg);
    }
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
#psd-video-progress-overlay.cancelled #psd-video-progress-cancel,         #psd-video-progress-overlay.error #psd-video-progress-cancel {
    display: none;
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
            <div id="psd-video-progress-title-wrap">
              <div id="psd-video-progress-title">Downloading Stream</div>
              <div id="psd-video-progress-detail">Download will start slow, please wait!</div>
            </div>
            <button id="psd-video-progress-cancel" type="button">Cancel</button>
            <button id="psd-video-progress-close" type="button" aria-label="Close">×</button>
          </div>
        </div>
      </div>`;
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
            state.jobId = null;
            root.style.display = "none";
        });
    }
    function ensure() {
        if (window.top !== window.self) return null;
        let root = document.getElementById("psd-video-progress-overlay");
        if (root) return root;
        root = createOverlayRoot();
        (document.body || document.documentElement).appendChild(root);
        root.style.display = "none";
        bindOverlayEvents(root);
        return root;
    }
    function combinedTotal() {
        const videoTotal = Math.max(0, Number(state.fixedTotals.video) || 0);
        const audioTotal = Math.max(0, Number(state.fixedTotals.audio) || 0);
        return videoTotal + audioTotal;
    }
    function combinedReceived() {
        const videoReceived = Math.max(0, Number(state.bytes.video.received) || 0);
        const audioReceived = Math.max(0, Number(state.bytes.audio.received) || 0);
        return videoReceived + audioReceived;
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
            download: 1, merge: 2, processing: 3, started: 4, ready: 5, cancel: 99, error: 99
        })[stage] || 0;
    }
    function setState(stage, detail = null, force = false) {
        const root = ensure();
        if (!root) return;
        if (!force && stageRank(stage) < stageRank(state.stage)) return;
        root.classList.remove('processing', 'started', 'completed', 'cancelled', 'error');
        const title = root.querySelector('#psd-video-progress-title');
        const info = root.querySelector('#psd-video-progress-detail');
        const cancel = root.querySelector('#psd-video-progress-cancel');
        if (stage === 'download') {
            title.textContent = 'Downloading Stream';
            info.textContent = combinedTotal()  ? `Estimated Size: ${formatBytes(combinedTotal())}`: 'Download will start slow, please wait!';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
        }else if (stage === 'merge') {
            title.textContent = 'Merging video + audio';
            info.textContent = 'Download will begin shortly, please wait.';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
        }else if (stage === 'processing') {
            title.textContent = 'Finalizing download';
            info.textContent = 'Please wait..';
            cancel.style.display = 'inline-flex';
            cancel.disabled = false;
            root.classList.add('processing');
        }else if (stage === 'started') {
            title.textContent = 'Download has started';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('started');
            const ring = root.querySelector('#psd-video-progress-ring');
            if (ring) {
                ring.style.strokeDasharray = '30 77';
                ring.style.strokeDashoffset = '0';
            }
        }else if (stage === 'ready') {
            title.textContent = 'Video downloaded';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('completed');
            setRing(100);
        }else if (stage === 'cancel') {
            title.textContent = 'Download Cancelled';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('cancelled');
        }else if (stage === 'error') {
            title.textContent = 'Video download failed';
            info.textContent = '';
            cancel.style.display = 'none';
            root.classList.add('error');
        }
        state.stage = stage;
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
    function show(visible = true, jobId = null, videoTotal = 0, audioTotal = 0) {
        const root = ensure();
        if (!root) return;
        if (!visible) {
            root.style.display = 'none';
            return;
        }
        if (state.jobId && !['ready', 'cancelled', 'error'].includes(state.stage)) {
            root.style.display = 'block';
            return;
        }
        root.style.display = 'block';
        state.jobId = jobId || null;
        state.stage = 'download';
        state.merge = 0;
        state.fixedTotals.video = Math.max(0, Number(videoTotal) || 0);
        state.fixedTotals.audio = Math.max(0, Number(audioTotal) || 0);
        state.bytes.video = {
            received: 0, total: state.fixedTotals.video
        };
        state.bytes.audio = {
            received: 0, total: state.fixedTotals.audio
        };
        setRing(0);
        setState('download', null, true);
    }
    function setJob(jobId, videoTotal = 0, audioTotal = 0) {
        state.jobId = jobId || state.jobId;
        if (videoTotal) {
            state.fixedTotals.video = Number(videoTotal) || state.fixedTotals.video;
            state.bytes.video.total = state.fixedTotals.video;
        }
        if (audioTotal) {
            state.fixedTotals.audio = Number(audioTotal) || state.fixedTotals.audio;
            state.bytes.audio.total = state.fixedTotals.audio;
        }
        setState(state.stage);
    }
    function enterStage(stage) {
        const rank = stageRank(stage);
        const current = stageRank(state.stage);
        if (rank < current) return false;
        setState(stage);
        return state.stage === stage;
    }
    function update(msg = {
    }) {
        const root = ensure();
        if (!root) return;
        if (msg.label === 'video' || msg.label === 'audio') {
            const bucket = state.bytes[msg.label];
            bucket.received = Math.max(bucket.received, Number(msg.received) || 0);
            if (!state.fixedTotals[msg.label] && msg.total != null) {
                const fallbackTotal = Math.max(0, Number(msg.total) || 0);
                state.fixedTotals[msg.label] = fallbackTotal;
                bucket.total = fallbackTotal;
            }
            const percent = downloadOverallPercent();
            if (state.stage === 'download') setRing(percent * DOWNLOAD_WEIGHT * 100);
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
            if (stageRank('merge') < stageRank(state.stage)) return;
            state.merge = Math.max(0, Math.min(1, Number(msg.progress) || 0));
            if (!enterStage('merge')) return;
            if (state.stage === 'merge') {
                setRing(DOWNLOAD_WEIGHT * 100 + state.merge * (100 - DOWNLOAD_WEIGHT * 100));
            }
            return;
        }
        if (msg.stage === 'processing') {
            if (stageRank('processing') < stageRank(state.stage)) return;
            enterStage('processing');
            return;
        }
        if (msg.stage === 'started') {
            if (stageRank('started') < stageRank(state.stage)) return;
            if (!enterStage('started')) return;
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
    window[NS] = {
        ensure, show, setJob, update, getJobId: () => state.jobId, getStage: () => state.stage, getTotals: () => ({
            video: state.bytes.video.total, audio: state.bytes.audio.total
        }), clearJob: () => {
            state.jobId = null;
        }
    };
})();
