/* Offline Tesseract.js OCR worker.
 * Uses the bundled Tesseract.js Core LSTM WASM build and local English traineddata.
 * No remote resources are requested.
 */
"use strict";

let modulePromise = null;
let tessModule = null;
let api = null;
let nextJobId = 0;

function postProgress(progress) {
  self.postMessage({
    type: "progress",
    progress: Math.max(0, Math.min(1, Number(progress) || 0))
  });
}

async function getModule() {
  if (modulePromise) return modulePromise;

  modulePromise = (async () => {
    postProgress(0.02);
    importScripts("./tesseract-core-lstm.wasm.js");

    if (typeof self.TesseractCore !== "function") {
      throw new Error("Bundled Tesseract core failed to load.");
    }

    const mod = await self.TesseractCore({
      TesseractProgress(percent) {
        // Core reports recognition progress as 0..100.
        postProgress(0.10 + (Math.max(0, Math.min(100, percent)) / 100) * 0.85);
      }
    });

    postProgress(0.08);

    const response = await fetch("./eng.traineddata", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Bundled English language data could not be loaded (${response.status}).`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    mod.FS.writeFile("/eng.traineddata", data);

    const instance = new mod.TessBaseAPI();
    const status = instance.Init(null, "eng", 1); // OEM.LSTM_ONLY
    if (status === -1) {
      instance.End();
      throw new Error("Tesseract failed to initialize with the bundled English language data.");
    }

    tessModule = mod;
    api = instance;
    postProgress(0.10);
    return mod;
  })().catch(error => {
    modulePromise = null;
    throw error;
  });

  return modulePromise;
}

function parseTSV(tsv) {
  const words = [];
  const lines = String(tsv || "").split(/\r?\n/);

  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    // TSV word rows are level 5:
    // level,page,block,par,line,word,left,top,width,height,conf,text
    if (cols.length < 12 || cols[0] !== "5") continue;

    const text = String(cols[11] || "").trim();
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const confidence = Number(cols[10]);

    if (!text || !Number.isFinite(left) || !Number.isFinite(top)
      || !Number.isFinite(width) || !Number.isFinite(height)
      || width <= 0 || height <= 0 || confidence < 25) {
      continue;
    }

    words.push({
      text,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height
    });
  }

  return words;
}

async function recognize(image) {
  await getModule();

  if (!tessModule || !api) throw new Error("OCR engine is not initialized.");

  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  tessModule.FS.writeFile("/input", bytes);

  const setResult = api.SetImageFile(1, 0);
  if (setResult === 1) throw new Error("Tesseract could not read the captured page image.");

  api.Recognize(null);
  const tsv = api.GetTSVText();
  return parseTSV(tsv);
}

self.addEventListener("message", async event => {
  const message = event.data || {};
  if (message.type !== "recognize") return;

  const id = message.id ?? (++nextJobId);

  try {
    const words = await recognize(message.image);
    self.postMessage({type: "result", id, words});
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error?.message || String(error)
    });
  }
});
