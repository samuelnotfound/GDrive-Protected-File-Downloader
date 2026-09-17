const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createBackgroundContext() {
    const storage = {};
    const storageArea = {
        async get(query) {
            if (Array.isArray(query)) {
                return Object.fromEntries(query.map(key => [key, storage[key]]));
            }
            return Object.fromEntries(
                Object.entries(query).map(([key, fallback]) => [
                    key,
                    Object.hasOwn(storage, key) ? storage[key] : fallback
                ])
            );
        },
        async set(values) {
            Object.assign(storage, values);
        }
    };
    const listeners = {};
    const sentTabMessages = [];
    const chrome = {
        action: {
            setBadgeBackgroundColor() {},
            setBadgeText() {}
        },
        offscreen: {
            async closeDocument() {},
            async createDocument() {}
        },
        runtime: {
            getContexts: async () => [],
            getURL: value => `chrome-extension://test/${value}`,
            onMessage: {
                addListener(listener) {
                    listeners.runtime = listener;
                }
            },
            async sendMessage() {
                return { accepted: true };
            }
        },
        scripting: {
            async executeScript() {
                return [];
            }
        },
        storage: {
            local: storageArea,
            session: storageArea
        },
        tabs: {
            async sendMessage(tabId, message) {
                sentTabMessages.push({ tabId, message });
            }
        },
        webRequest: {
            onBeforeRequest: {
                addListener(listener, filter) {
                    listeners.webRequest = listener;
                    listeners.webRequestFilter = filter;
                }
            }
        }
    };
    const context = vm.createContext({
        AbortController,
        URL,
        chrome,
        console,
        fetch,
        setTimeout,
        clearTimeout
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'background.js' });
    return { context, listeners, sentTabMessages, storage };
}

test('cleanURL removes only the range parameter', () => {
    const { context } = createBackgroundContext();
    const input = 'https://example.test/videoplayback?id=1&range=10-20&sig=a~b%2Fc%20d&n=x%2fy#fragment';
    const cleaned = context.cleanURL(input);

    assert.equal(
        cleaned,
        'https://example.test/videoplayback?id=1&sig=a~b%2Fc%20d&n=x%2fy#fragment'
    );
});

test('stream diagnostics omit signed query parameters', () => {
    const { context } = createBackgroundContext();
    const description = context.describeStreamURL(
        'https://r1.googlevideo.com/videoplayback?mime=video%2Fmp4&clen=42&sig=secret'
    );

    assert.deepEqual(
        JSON.parse(JSON.stringify(description)),
        {
            host: 'r1.googlevideo.com',
            path: '/videoplayback',
            mime: 'video/mp4',
            bytes: 42
        }
    );
});

test('offscreen start reports a missing message acknowledgement', async () => {
    const { context } = createBackgroundContext();
    context.chrome.runtime.sendMessage = () => Promise.reject(
        new Error('The message port closed before a response was received.')
    );
    context.fetch = () => Promise.reject(new Error('warm-up unavailable'));

    await assert.rejects(
        context.startVideoStaging('job-1', 'https://video.test', 'https://audio.test')
    );
});

test('offscreen creation waits for an in-progress close', async () => {
    const { context } = createBackgroundContext();
    let releaseClose;
    let created = false;
    context.chrome.offscreen.closeDocument = () => new Promise(resolve => {
        releaseClose = resolve;
    });
    context.chrome.offscreen.createDocument = async () => {
        created = true;
    };

    const closing = context.closeVideoOffscreen();
    await new Promise(resolve => setImmediate(resolve));
    const ensuring = context.ensureVideoOffscreen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(created, false);

    releaseClose();
    await Promise.all([closing, ensuring]);
    assert.equal(created, true);
});

test('audio wait reads a stream captured after download starts', async () => {
    const { context } = createBackgroundContext();
    const waiting = context.waitForAudioStream({}, 300);
    setTimeout(() => {
        context.queueStorageMutation('streams', 'capturedStreams', streams => {
            streams.audio = 'https://audio.test/late';
        });
    }, 10);

    const streams = await waiting;
    assert.equal(streams.audio, 'https://audio.test/late');
});

test('network capture keeps requests without a tab association', async () => {
    const { context, listeners, storage } = createBackgroundContext();
    listeners.webRequest({
        tabId: -1,
        url: 'https://r1.googlevideo.com/videoplayback?mime=video&clen=10'
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(storage.capturedStreams.video.includes('videoplayback'), true);
    assert.equal(listeners.webRequestFilter.urls.includes('<all_urls>'), true);
});

test('captured video and audio reach the offscreen staging path', async () => {
    const { context, listeners, storage } = createBackgroundContext();
    context.fetch = async () => ({
        ok: true,
        body: {
            getReader: () => ({ read: async () => ({ done: true }) })
        }
    });
    listeners.webRequest({
        tabId: -1,
        url: 'https://media.example.test/videoplayback?mime=video%2Fmp4&clen=100&range=0-9&sig=video'
    });
    listeners.webRequest({
        tabId: -1,
        url: 'https://media.example.test/videoplayback?mime=audio%2Fmp4&clen=20&range=0-9&sig=audio'
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const response = await context.handleRuntimeMessage(
        { action: 'downloadVideo', filename: 'example' },
        { tab: { id: 12 } }
    );

    assert.equal(response.success, true);
    assert.equal(response.staging, true);
    assert.equal(storage.videoStageJobs[response.jobId].sourceTabId, 12);
    assert.equal(storage.videoStageJobs[response.jobId].videoUrl.includes('range='), false);
    assert.equal(storage.videoStageJobs[response.jobId].audioUrl.includes('range='), false);
});
