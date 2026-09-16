const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('cancelling one staging job does not cancel another', () => {
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
    const respond = response => responses.push(response);
    runtimeListener({ target: 'video-offscreen', type: 'videoStageStart', jobId: 'first' }, {}, respond);
    runtimeListener({ target: 'video-offscreen', type: 'videoStageStart', jobId: 'second' }, {}, respond);
    runtimeListener({ target: 'video-offscreen', type: 'videoStageCancelInternal', jobId: 'first' }, {}, respond);

    assert.equal(states.get('first').cancelled, true);
    assert.equal(states.get('second').cancelled, false);
    assert.deepEqual(JSON.parse(JSON.stringify(responses)), [
        { accepted: true },
        { accepted: true },
        { accepted: true }
    ]);
});
