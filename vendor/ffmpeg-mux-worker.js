importScripts('ffmpeg-core.js');

let corePromise = null;
let ffmpegDurationUs = 0;

function log(message) {
  if (message) postMessage({ type: 'ffmpeg-log', message: String(message) });
}

function status(message) {
  postMessage({ type: 'status', message: String(message) });
}

function parseTimeToUs(value) {
  const m = String(value || '').trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1e6);
}

function handleFfmpegLog(message) {
  const text = String(message || '').trim();
  if (!text) return;

  // FFmpeg -progress pipe:1 emits key/value lines such as out_time_us=...;
  // normal stderr emits a Duration line and, on older builds, stats with time=.
  const durationMatch = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/i);
  if (durationMatch) {
    const durationUs = parseTimeToUs(durationMatch[1]);
    if (durationUs > 0) ffmpegDurationUs = durationUs;
  }

  const frameMatch = text.match(/(?:^|\s)frame=(\d+)/);
  const frame = frameMatch ? Number(frameMatch[1]) : 0;

  const outTimeUs = text.match(/(?:^|\s)out_time_us=(\d+)/);
  const outTime = outTimeUs ? Number(outTimeUs[1]) : 0;
  if (outTime > 0 && ffmpegDurationUs > 0) {
    postMessage({ type: 'ffmpeg-progress', progress: Math.max(0, Math.min(1, outTime / ffmpegDurationUs)), time: outTime, duration: ffmpegDurationUs, frame });
  }

  const outTimeStr = text.match(/(?:^|\s)out_time=([^\s]+)/);
  if (!outTime && outTimeStr && ffmpegDurationUs > 0) {
    const parsed = parseTimeToUs(outTimeStr[1]);
    if (parsed > 0) {
      postMessage({ type: 'ffmpeg-progress', progress: Math.max(0, Math.min(1, parsed / ffmpegDurationUs)), time: parsed, duration: ffmpegDurationUs, frame });
    }
  }

  const statsTime = text.match(/(?:^|\s)time=(\d+:\d+:\d+(?:\.\d+)?)/);
  if (!outTime && statsTime && ffmpegDurationUs > 0) {
    const parsed = parseTimeToUs(statsTime[1]);
    if (parsed > 0) {
      postMessage({ type: 'ffmpeg-progress', progress: Math.max(0, Math.min(1, parsed / ffmpegDurationUs)), time: parsed, duration: ffmpegDurationUs, frame });
    }
  }

  const useful = /^(Duration:|Stream|frame=|size=|time=|Error|Input|Output)/i.test(text);
  if (useful) postMessage({ type: 'ffmpeg-log', message: text });
}


function getCore() {
  if (!corePromise) {
    status('Loading FFmpeg engine…');
    corePromise = createFFmpegCore({
      locateFile: (path) => new URL(path, self.location.href).href,
      logger: ({ type, message }) => {
        if (!message) return;
        const text = String(message).trim();
        if (!text) return;
        // Forward useful FFmpeg diagnostics and parse progress lines when
        // available. FFmpeg's synchronous core can emit both stdout and stderr.
        handleFfmpegLog(text);
      },
      progress: ({ progress, time }) => {
        const value = Number(progress);
        if (Number.isFinite(value)) {
          postMessage({
            type: 'ffmpeg-progress',
            progress: Math.max(0, Math.min(1, value)),
            time: Number(time) || 0,
            frame: 0
          });
        }
      },
      onAbort: (reason) => {
        log(`FFmpeg aborted: ${reason || 'unknown reason'}`);
      }
    }).then(core => {
      // Explicitly install the callbacks as well. This makes the code work
      // with FFmpeg cores that expose setLogger/setProgress but do not consume
      // those callbacks from the factory options consistently.
      if (typeof core.setLogger === 'function') {
        core.setLogger(({ type, message }) => {
          if (!message) return;
          const text = String(message).trim();
          if (text) handleFfmpegLog(text);
        });
      }
      if (typeof core.setProgress === 'function') {
        core.setProgress(({ progress, time }) => {
          const value = Number(progress);
          if (Number.isFinite(value)) {
            postMessage({
              type: 'ffmpeg-progress',
              progress: Math.max(0, Math.min(1, value)),
              time: Number(time) || 0,
            frame: 0
            });
          }
        });
      }
      status('FFmpeg engine loaded. Preparing inputs…');
      return core;
    }).catch(error => {
      log(`FFmpeg engine failed to load: ${error?.message || String(error)}`);
      throw error;
    });
  }
  return corePromise;
}

function cleanupFile(fs, path) {
  try { fs.unlink(path); } catch (_) {}
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== 'mux') return;

  try {
    if (!(data.video instanceof Blob) || !(data.audio instanceof Blob)) {
      throw new Error('FFmpeg did not receive the staged video and audio files.');
    }

    status(`Preparing staged inputs (${data.video.size} B video + ${data.audio.size} B audio)…`);

    // The streams were already downloaded locally by video-stager.js. Read both
    // blobs concurrently; do NOT fetch them again through blob URLs.
    const [videoBuffer, audioBuffer] = await Promise.all([
      data.video.arrayBuffer(),
      data.audio.arrayBuffer()
    ]);

    if (!videoBuffer.byteLength || !audioBuffer.byteLength) {
      throw new Error(`Empty FFmpeg input: video ${videoBuffer.byteLength} B, audio ${audioBuffer.byteLength} B.`);
    }

    const core = await getCore();
    const fs = core.FS;
    const video = new Uint8Array(videoBuffer);
    const audio = new Uint8Array(audioBuffer);

    cleanupFile(fs, '/input-video');
    cleanupFile(fs, '/input-audio');
    cleanupFile(fs, '/output.mp4');

    status(`Loading inputs into FFmpeg (${video.byteLength} B + ${audio.byteLength} B)…`);
    fs.writeFile('/input-video', video);
    fs.writeFile('/input-audio', audio);

    ffmpegDurationUs = 0;
    postMessage({ type: 'ffmpeg-progress', progress: 0, time: 0, duration: 0 });
    status('Merging video and audio…');
    log(`Input video: ${video.byteLength} bytes`);
    log(`Input audio: ${audio.byteLength} bytes`);

    const audioCodec = String(data.audioCodec || '').toLowerCase();
    const copyAudio = audioCodec === 'aac' || audioCodec === 'mp4a' || audioCodec.includes('mp4a');
    log(copyAudio ? 'Audio stream is AAC-compatible; copying audio without re-encoding.' : 'Audio stream will be encoded to AAC for MP4 compatibility.');

    const args = [
      '-hide_banner', '-loglevel', 'info',
      '-stats_period', '0.5',
      '-i', '/input-video',
      '-i', '/input-audio',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
    ];
    if (copyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
    args.push(
      '-movflags', '+faststart',
      '-shortest',
      '-progress', 'pipe:1',
      '/output.mp4'
    );

    const result = core.exec(...args);

    if (result !== 0) {
      throw new Error(`FFmpeg failed with exit code ${result}. Check the FFmpeg messages above for the input/codec error.`);
    }

    const output = fs.readFile('/output.mp4');
    if (!output?.byteLength) throw new Error('FFmpeg produced an empty MP4.');

    postMessage({ type: 'ffmpeg-progress', progress: 1, time: ffmpegDurationUs, duration: ffmpegDurationUs, frame: 0 });
    log(`Output MP4: ${output.byteLength} bytes`);
    postMessage({ type: 'done', blob: new Blob([output], { type: 'video/mp4' }) });

    cleanupFile(fs, '/input-video');
    cleanupFile(fs, '/input-audio');
    cleanupFile(fs, '/output.mp4');
  } catch (error) {
    postMessage({
      type: 'error',
      message: error?.message || String(error)
    });
  }
};
