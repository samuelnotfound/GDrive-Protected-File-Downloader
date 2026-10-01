/**
 * Mux worker: merge video + audio MP4 streams with mp4-remux (stream copy).
 * Source and output data stay in OPFS instead of being transferred as giant Blobs.
 */
importScripts('../src/offscreen/video-stage-storage.js');
importScripts('mp4-remux.iife.js');

const storage = self.GDriveVideoStageStorage;
const remux = self.mp4Remux;

function postStatus(message) {
  postMessage({ type: 'status', message: String(message) });
}

function postProgress(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return;
  postMessage({
    type: 'ffmpeg-progress',
    progress: Math.max(0, Math.min(1, value)),
    time: 0,
    duration: 0,
    frame: 0
  });
}

function trackedStream(stream, totalSize, onBytes) {
  const reader = stream.getReader();
  let seen = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value?.byteLength) {
        seen += value.byteLength;
        onBytes(seen, totalSize);
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

async function writeOutputStream(jobId, stream) {
  const writer = await storage.openWriter(jobId, 'merged');
  let closed = false;
  try {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) await writer.write(value);
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    await writer.close();
    closed = true;
  } catch (error) {
    if (!closed) {
      try { await writer.abort(); } catch (_) {}
    }
    throw error;
  }
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.type !== 'mux') return;

  try {
    const videoStream = await storage.openReadStream(data.videoJobId, data.videoLabel);
    const audioStream = await storage.openReadStream(data.audioJobId, data.audioLabel);
    const videoFile = await storage.getFile(data.videoJobId, data.videoLabel);
    const audioFile = await storage.getFile(data.audioJobId, data.audioLabel);

    postStatus('Processing video…');
    const totalBytes = videoFile.size + audioFile.size;
    let videoRead = 0;
    let audioRead = 0;
    const report = () => {
      if (totalBytes > 0) postProgress((videoRead + audioRead) / totalBytes);
    };

    const trackedVideo = trackedStream(videoStream, videoFile.size, (n) => {
      videoRead = n;
      report();
    });
    const trackedAudio = trackedStream(audioStream, audioFile.size, (n) => {
      audioRead = n;
      report();
    });

    const result = await remux(trackedVideo, trackedAudio);
    if (!(result instanceof ReadableStream)) {
      throw new Error('Remuxer did not return a readable stream.');
    }

    await writeOutputStream(data.videoJobId, result);
    postProgress(1);

    // Source files are no longer needed once the merged file is safely written.
    await storage.removeStream(data.videoJobId, data.videoLabel);
    await storage.removeStream(data.audioJobId, data.audioLabel);
    postMessage({ type: 'done' });
  } catch (error) {
    postMessage({
      type: 'error',
      message: error?.message || String(error)
    });
  }
};
