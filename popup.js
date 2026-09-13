const $ = id => document.getElementById(id);
let port = null;
let tabId = null;
let currentRunning = false;
let completed = false;

function setProgress(done, total) {
  const p = total ? Math.floor(done / total * 100) : 0;
  $('bar').style.width = p + '%';
  $('percent').textContent = p + '%';
  $('count').textContent = `${done} / ${total || '?'}`;
}

function renderState(running) {
  currentRunning = !!running;
  $('toggle').disabled = false;
  $('toggle').textContent = currentRunning ? 'Stop' : 'Start download';
  $('toggle').classList.toggle('stop', currentRunning);
}


function handle(m) {
  if (m.type === 'info') {
    if (m.title) $('doc').textContent = m.title;
    if (m.status) $('status').textContent = m.status;
    if (m.detail !== null && m.detail !== undefined) $('detail').textContent = m.detail;
    if (typeof m.done === 'number' || typeof m.total === 'number') setProgress(m.done || 0, m.total || 0);
  }
  if (m.type === 'state') { completed = !!m.completed; renderState(!!m.running); }
}

async function connect() {
  try {
    port = chrome.tabs.connect(tabId, {name: 'pdf-downloader'});
    port.onMessage.addListener(handle);
    port.onDisconnect.addListener(() => {
      port = null;
    });
    port.postMessage({type: 'init'});
    return true;
  } catch (e) {
    port = null;
    return false;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  tabId = tab?.id;
  $('doc').textContent = tab?.title || 'No active tab';
  if (!tabId) return;

  try {
    const url = new URL(tab.url || "");
    if (url.hostname !== "drive.google.com" || !/^\/file(?:\/|$)/.test(url.pathname)) {
      $('status').textContent = 'Not a Drive file';
      $('detail').textContent = 'Open a PDF at drive.google.com/file/... to use PDF Downloader.';
      renderState(false);
      return;
    }
  } catch (_) {
    return;
  }

  let ok = await connect();
  if (!ok) {
    try {
      await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});
      await new Promise(r => setTimeout(r, 100));
      await connect();
    } catch (e) {
      $('status').textContent = 'Fily type not supported';
      $('detail').textContent = 'This file is not a supported PDF viewer.';
      renderState(false);
    }
  }
}

$('toggle').onclick = () => {
  if (completed && !currentRunning) { window.close(); return; }
  if (!port) return;
  port.postMessage({type: currentRunning ? 'stop' : 'start'});
};

init();
