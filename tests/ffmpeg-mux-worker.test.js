const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('mux worker accepts transferred inputs and transfers the exact MP4 bytes back', async () => {
    const messages = [];
    const outputView = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
    const core = {
        FS: {
            unlink() {},
            writeFile() {},
            readFile() { return outputView; }
        },
        exec() { return 0; },
        setLogger() {},
        setProgress() {}
    };
    const context = vm.createContext({
        ArrayBuffer,
        console,
        createFFmpegCore: () => Promise.resolve(core),
        importScripts() {},
        postMessage(message, transfer = []) {
            messages.push({ message, transfer });
        },
        self: { location: { href: 'chrome-extension://test/vendor/ffmpeg-mux-worker.js' } },
        URL,
        Uint8Array
    });
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'vendor', 'ffmpeg-mux-worker.js'),
        'utf8'
    );
    vm.runInContext(source, context, { filename: 'ffmpeg-mux-worker.js' });

    await context.self.onmessage({
        data: {
            type: 'mux',
            video: new Uint8Array([10]).buffer,
            audio: new Uint8Array([11]).buffer,
            audioCodec: 'aac'
        }
    });

    const done = messages.find(({ message }) => message.type === 'done');
    assert.ok(done);
    assert.deepEqual(Array.from(new Uint8Array(done.message.buffer)), [1, 2, 3]);
    assert.equal(done.transfer.length, 1);
    assert.equal(done.transfer[0], done.message.buffer);
});
