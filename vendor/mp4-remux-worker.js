/**
 * Mux worker: merge video + audio MP4 streams with mp4-remux (stream copy).
 * Protocol: { type: 'mux', video: Blob, audio: Blob }
 * Out: { type: 'status' | 'ffmpeg-progress' | 'done' | 'error', ... }
 */
importScripts('mp4-remux.iife.js');

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

function trackedStream(blob, onBytes) {
  const reader = blob.stream().getReader();
  let seen = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      onBytes(seen, blob.size);
      controller.enqueue(value);
    },
    cancel() {
      return reader.cancel();
    }
  });
}

async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.type !== 'mux') return;

  try {
    const videoBlob = data.video;
    const audioBlob = data.audio;
    if (!(videoBlob instanceof Blob) || !(audioBlob instanceof Blob)) {
      throw new Error('Mux requires video and audio Blobs.');
    }

    postStatus('Processing video…');
    const totalBytes = videoBlob.size + audioBlob.size;
    let videoRead = 0;
    let audioRead = 0;
    const report = () => {
      if (totalBytes > 0) postProgress((videoRead + audioRead) / totalBytes);
    };

    const videoStream = trackedStream(videoBlob, (n) => {
      videoRead = n;
      report();
    });
    const audioStream = trackedStream(audioBlob, (n) => {
      audioRead = n;
      report();
    });

    const result = await remux(videoStream, audioStream);
    const buffer =
      result instanceof ArrayBuffer
        ? result
        : result?.buffer instanceof ArrayBuffer
          ? result.buffer
          : await streamToArrayBuffer(result);

    postProgress(1);
    postMessage({ type: 'done', buffer }, [buffer]);
  } catch (error) {
    postMessage({
      type: 'error',
      message: error?.message || String(error)
    });
  }
};
