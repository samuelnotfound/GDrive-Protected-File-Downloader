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
            async sendMessage() {}
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
            onRemoved: {
                addListener(listener) {
                    listeners.tabRemoved = listener;
                }
            },
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
    const cleaned = new URL(context.cleanURL(
        'https://example.test/videoplayback?id=1&range=10-20&signature=keep&clen=42'
    ));

    assert.equal(cleaned.searchParams.has('range'), false);
    assert.equal(cleaned.searchParams.get('signature'), 'keep');
    assert.equal(cleaned.searchParams.get('clen'), '42');
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

test('captured streams remain isolated by browser tab', async () => {
    const { context } = createBackgroundContext();
    await context.mutateStoredStreams(7, streams => {
        streams.video = 'https://video.test/one';
        streams.timestamp = 1;
    });
    await context.mutateStoredStreams(8, streams => {
        streams.audio = 'https://audio.test/two';
        streams.timestamp = 2;
    });

    const first = await context.handleRuntimeMessage({ action: 'getStreams' }, { tab: { id: 7 } });
    const second = await context.handleRuntimeMessage({ action: 'getStreams' }, { tab: { id: 8 } });

    assert.equal(first.streams.video, 'https://video.test/one');
    assert.equal(first.streams.audio, null);
    assert.equal(second.streams.video, null);
    assert.equal(second.streams.audio, 'https://audio.test/two');
});

test('audio wait reads updates from the requested tab', async () => {
    const { context } = createBackgroundContext();
    const waiting = context.waitForAudioStream({}, 9, 300);
    setTimeout(() => {
        context.mutateStoredStreams(9, streams => {
            streams.audio = 'https://audio.test/late';
        });
    }, 10);

    const streams = await waiting;
    assert.equal(streams.audio, 'https://audio.test/late');
});

test('network capture ignores extension requests and uses scoped URL filters', async () => {
    const { context, listeners, storage } = createBackgroundContext();
    listeners.webRequest({
        tabId: -1,
        url: 'https://r1.googlevideo.com/videoplayback?mime=video&clen=10'
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(storage.capturedStreamsByTab, undefined);

    listeners.webRequest({
        tabId: 3,
        url: 'https://r1.googlevideo.com/videoplayback?mime=video&range=0-9&clen=10&sig=keep'
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const streams = await context.getStoredStreams(3);
    assert.equal(streams.video.includes('range='), false);
    assert.equal(new URL(streams.video).searchParams.get('sig'), 'keep');
    assert.equal(listeners.webRequestFilter.urls.includes('<all_urls>'), false);
});

test('closing a tab removes only that tab stream state', async () => {
    const { context, listeners } = createBackgroundContext();
    await context.mutateStoredStreams(1, streams => { streams.video = 'one'; });
    await context.mutateStoredStreams(2, streams => { streams.video = 'two'; });

    listeners.tabRemoved(1);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal((await context.getStoredStreams(1)).video, null);
    assert.equal((await context.getStoredStreams(2)).video, 'two');
});
