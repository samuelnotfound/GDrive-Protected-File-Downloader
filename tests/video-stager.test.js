const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('cancelling one staging job rejects its merge before terminating its worker', () => {
    let runtimeListener;
    const chrome = {
        runtime: {
            getURL: value => value,
            onMessage: {
                addListener(listener) {
                    runtimeListener = listener;
                }
            },
            sendMessage() {
                return Promise.resolve();
            }
        }
    };
    const context = vm.createContext({
        AbortController,
        Blob,
        URL,
        chrome,
        console,
        document: {},
        fetch,
        performance,
        setTimeout,
        Worker: function Worker() {}
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'video-stager.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'video-stager.js' });

    const states = new Map();
    context.runStagingJob = (jobId, state) => {
        states.set(jobId, state);
        return new Promise(() => {});
    };

    const responses = [];
    const cancellationEvents = [];
    const respond = response => responses.push(response);
    runtimeListener({ target: 'video-offscreen', type: 'videoStageStart', jobId: 'first' }, {}, respond);
    runtimeListener({ target: 'video-offscreen', type: 'videoStageStart', jobId: 'second' }, {}, respond);
    states.get('first').rejectMerge = error => cancellationEvents.push(error.name);
    states.get('first').worker = {
        terminate() { cancellationEvents.push('terminate'); }
    };
    runtimeListener({ target: 'video-offscreen', type: 'videoStageCancelInternal', jobId: 'first' }, {}, respond);

    assert.equal(states.get('first').cancelled, true);
    assert.equal(states.get('second').cancelled, false);
    assert.deepEqual(cancellationEvents, ['AbortError', 'terminate']);
    assert.deepEqual(JSON.parse(JSON.stringify(responses)), [
        { accepted: true },
        { accepted: true },
        { accepted: true }
    ]);
});

test('does not start stream fetches for an already-cancelled job', async () => {
    let fetchCalls = 0;
    const context = vm.createContext({
        AbortController,
        Blob,
        URL,
        chrome: {
            runtime: {
                getURL: value => value,
                onMessage: { addListener() {} },
                sendMessage() { return Promise.resolve(); }
            }
        },
        console,
        document: {},
        fetch() { fetchCalls += 1; },
        performance,
        setTimeout,
        Worker: function Worker() {}
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'video-stager.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'video-stager.js' });

    await assert.rejects(
        context.downloadSourceStreams(
            'job',
            { videoUrl: 'video', audioUrl: 'audio' },
            { cancelled: true }
        ),
        { name: 'AbortError' }
    );
    assert.equal(fetchCalls, 0);
});

test('transfers staged stream buffers to the mux worker and rebuilds its MP4', async () => {
    let postedPayload;
    let transferredBuffers;
    let workerTerminated = false;
    class FakeWorker {
        postMessage(payload, transfer) {
            postedPayload = payload;
            transferredBuffers = transfer;
            const output = new Uint8Array([0, 1, 2, 3]).buffer;
            queueMicrotask(() => this.onmessage({
                data: { type: 'done', buffer: output }
            }));
        }

        terminate() {
            workerTerminated = true;
        }
    }
    const context = vm.createContext({
        AbortController,
        ArrayBuffer,
        Blob,
        URL,
        chrome: {
            runtime: {
                getURL: value => value,
                onMessage: { addListener() {} },
                sendMessage() { return Promise.resolve(); }
            }
        },
        console,
        document: {},
        fetch,
        performance,
        queueMicrotask,
        setTimeout,
        Uint8Array,
        Worker: FakeWorker
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'video-stager.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'video-stager.js' });

    const state = { worker: null };
    const output = await context.mergeStreams(
        'job',
        { audioUrl: 'https://example.test/audio?mime=audio%2Fmp4' },
        new Blob([new Uint8Array([10, 11])]),
        new Blob([new Uint8Array([12, 13])]),
        state
    );

    assert.equal(postedPayload.type, 'mux');
    assert.equal(postedPayload.video instanceof ArrayBuffer, true);
    assert.equal(postedPayload.audio instanceof ArrayBuffer, true);
    assert.equal(postedPayload.audioCodec, 'aac');
    assert.equal(transferredBuffers.length, 2);
    assert.deepEqual(Array.from(new Uint8Array(await output.arrayBuffer())), [0, 1, 2, 3]);
    assert.equal(output.type, 'video/mp4');
    assert.equal(workerTerminated, true);
    assert.equal(state.worker, null);
});
