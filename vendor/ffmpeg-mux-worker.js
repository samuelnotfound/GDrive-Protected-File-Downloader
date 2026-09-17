importScripts('ffmpeg-core.js');

let corePromise = null;
let ffmpegDurationUs = 0;
let lastFfmpegError = '';

function status(message) {
  postMessage({ type: 'status', message: String(message) });
}

function parseTimeToUs(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const [hours, minutes, seconds] = match.slice(1).map(Number);
  return [hours, minutes, seconds].every(Number.isFinite)
    ? Math.round((hours * 3600 + minutes * 60 + seconds) * 1e6)
    : 0;
}

function reportProgress(progress, time = 0, duration = ffmpegDurationUs, frame = 0) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return;
  postMessage({
    type: 'ffmpeg-progress',
    progress: Math.max(0, Math.min(1, value)),
    time: Number(time) || 0,
    duration: Number(duration) || 0,
    frame: Number(frame) || 0
  });
}

function handleFfmpegLog(message) {
  const text = String(message || '').trim();
  if (!text) return;

  const durationMatch = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/i);
  if (durationMatch) {
    const durationUs = parseTimeToUs(durationMatch[1]);
    if (durationUs > 0) ffmpegDurationUs = durationUs;
  }

  const frameMatch = text.match(/(?:^|\s)frame=(\d+)/);
  const frame = frameMatch ? Number(frameMatch[1]) : 0;
  const outTimeUs = text.match(/(?:^|\s)out_time_us=(\d+)/);
  const outTime = outTimeUs
    ? Number(outTimeUs[1])
    : parseTimeToUs(text.match(/(?:^|\s)out_time=([^\s]+)/)?.[1])
      || parseTimeToUs(text.match(/(?:^|\s)time=(\d+:\d+:\d+(?:\.\d+)?)/)?.[1]);

  if (outTime > 0 && ffmpegDurationUs > 0) {
    reportProgress(outTime / ffmpegDurationUs, outTime, ffmpegDurationUs, frame);
  }

  if (/\b(Error|Invalid|Unknown|Could not)\b/i.test(text)) lastFfmpegError = text;
}

function handleFfmpegProgress({ progress, time } = {}) {
  reportProgress(progress, time);
}

function handleFfmpegMessage({ message } = {}) {
  if (message) handleFfmpegLog(message);
}


function getCore() {
  if (!corePromise) {
    status('Loading FFmpeg engine…');
    corePromise = createFFmpegCore({
      locateFile: (path) => new URL(path, self.location.href).href,
      logger: handleFfmpegMessage,
      progress: handleFfmpegProgress
    }).then(core => {
      // Explicitly install the callbacks as well. This makes the code work
      // with FFmpeg cores that expose setLogger/setProgress but do not consume
      // those callbacks from the factory options consistently.
      if (typeof core.setLogger === 'function') {
        core.setLogger(handleFfmpegMessage);
      }
      if (typeof core.setProgress === 'function') {
        core.setProgress(handleFfmpegProgress);
      }
      status('FFmpeg engine loaded. Preparing inputs…');
      return core;
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

    // The streams were already downloaded locally by video-stream-downloader.js. Read both
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
    lastFfmpegError = '';
    postMessage({ type: 'ffmpeg-progress', progress: 0, time: 0, duration: 0 });
    status('Merging video and audio…');
    const audioCodec = String(data.audioCodec || '').toLowerCase();
    const copyAudio = audioCodec === 'aac' || audioCodec === 'mp4a' || audioCodec.includes('mp4a');

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
    // +faststart rewrites the completed MP4 a second time. Keep it for
    // ordinary files, but skip that expensive second pass for large inputs.
    const useFaststart = data.video.size + data.audio.size < 100 * 1024 * 1024;
    if (useFaststart) args.push('-movflags', '+faststart');
    args.push(
      '-shortest',
      '-progress', 'pipe:1',
      '/output.mp4'
    );

    const result = core.exec(...args);

    if (result !== 0) {
      throw new Error(lastFfmpegError || `FFmpeg failed with exit code ${result}.`);
    }

    const output = fs.readFile('/output.mp4');
    if (!output?.byteLength) throw new Error('FFmpeg produced an empty MP4.');

    postMessage({ type: 'ffmpeg-progress', progress: 1, time: ffmpegDurationUs, duration: ffmpegDurationUs, frame: 0 });
    const outputBuffer = output.byteOffset === 0 && output.byteLength === output.buffer.byteLength
      ? output.buffer
      : output.slice().buffer;
    postMessage({ type: 'done', buffer: outputBuffer }, [outputBuffer]);

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
