import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../src/engine.js';
import { fakeHost, fakeVectors, recordsFor, response } from './helpers.js';

async function until(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('Expected background phase was not reached');
}

test('in-flight summary survives appended chat; waits for idle and commits validated sources', async t => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    t.after(() => engine.cancel());
    let generating = false, finish;
    host.isGenerating = () => generating;
    host.send = messages => new Promise(resolve => { finish = () => resolve(response({ spans: [{ index: Number(messages.at(-1).content.match(/\[楼层 (\d+)/)[1]) - 1 }] })); });
    const job = engine.run(false);
    await until(() => finish);
    generating = true; engine.generationStarted();
    assert.equal(engine.controller.signal.aborted, false);
    host.append(recordsFor(31).slice(-2));
    host.setSettings({ auto: false }); // Finish current transaction, don't start another batch.
    finish(); await until(() => engine.status.phase === 'waiting');
    assert.equal(host.local, null);
    generating = false; engine.generationEnded(); await job;
    assert.equal(host.local.segments.length, 1);
    assert.equal(engine.status.error, '');
    assert.equal(engine.idleWaiters.size, 0);
});

test('edited batch source is rejected even when new turns are permitted', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    host.send = () => { host.edit(0); return response({ spans: [{ index: 0 }] }); };
    await engine.run(true);
    assert.equal(host.local, null);
    assert.match(engine.status.error, /来源、清理结果或记忆已改变/);
});

test('turning background concurrency off preserves generation cancellation', async t => {
    const host = fakeHost(recordsFor(30), { backgroundDuringChat: false });
    const engine = new MemoryEngine(host, fakeVectors()); t.after(() => engine.cancel());
    host.send = () => new Promise(() => {});
    const job = engine.run(true); await until(() => engine.status.phase === 'summarizing');
    engine.generationStarted(); await job;
    assert.equal(host.local, null);
});

test('cancel removes pending idle wait without persisting anything', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    host.isGenerating = () => true;
    const controller = new AbortController();
    const waiting = engine.waitForIdle(controller.signal);
    controller.abort(new DOMException('cancel', 'AbortError'));
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(engine.idleWaiters.size, 0);
    assert.equal(host.local, null);
});

test('stopping background work keeps the memory injection already prepared for foreground generation', () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    engine.controller = new AbortController(); host.inject('confirmed memory');
    engine.stopBackground();
    assert.equal(engine.controller.signal.aborted, true);
    assert.deepEqual(host.injections, ['confirmed memory']);
});
