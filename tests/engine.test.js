import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../src/engine.js';
import { fakeHost, fakeVectors, recordsFor, response } from './helpers.js';

test('30 long turns: seven automatic batches cover first 21 turns; repeated run is idempotent', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    await engine.run(false);
    assert.equal(engine.status.error, '');
    assert.equal(host.local.segments.length, 7);
    const view = await engine.inspect();
    assert.equal(view.plan.removed.size, 42);
    assert.equal(view.work.roundCount, 1);
    await engine.run(false);
    assert.equal(host.local.segments.length, 7);
    assert.equal(host.calls.filter(c => c.type === 'api').length, 7);
});

test('failed persistence never authorizes dropping original messages', async () => {
    const host = fakeHost(); host.failSave = true;
    const engine = new MemoryEngine(host, fakeVectors());
    await engine.run(false);
    assert.equal(host.remote, null);
    assert.equal(host.local, null);
    const original = recordsFor(30).map(r => ({ index: r.hostIndex, name: r.name, is_user: r.isUser, mes: r.text, extra: { reasoning: 'keep' } }));
    const chat = structuredClone(original);
    await engine.intercept(chat, 200000, 'normal');
    assert.deepEqual(chat, original);
});

test('switching chats while the summary is in flight discards its result', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    host.send = async () => { host.switchChat(); return response({ spans: [{ index: 0 }] }); };
    await engine.run(false);
    assert.equal(host.calls.filter(c => c.type === 'save').length, 0);
    assert.equal(host.local, null);
});

test('malformed summaries are not persisted', async () => {
    const host = fakeHost(); host.send = async () => '{"summary":"truncated';
    const engine = new MemoryEngine(host, fakeVectors());
    await engine.run(false);
    assert.equal(host.local, null);
    assert.match(engine.status.error, /JSON/);
});

test('compression alters only the passed prompt array, never nested message data', async () => {
    const records = recordsFor(30); const host = fakeHost(records);
    const engine = new MemoryEngine(host, fakeVectors());
    await engine.run(false);
    const persistent = records.map(r => ({ index: r.hostIndex, name: r.name, is_user: r.isUser, mes: r.text, extra: { reasoning: 'thought', arbitrary: { untouched: true } } }));
    const before = structuredClone(persistent);
    const prompt = persistent.map(m => ({ ...m }));
    await engine.intercept(prompt, 200000, 'normal');
    assert.equal(prompt.length, 18);
    assert.deepEqual(persistent, before);
    assert.ok(host.injections.at(-1).includes('轻忆'));
    assert.equal(host.injections.at(-1).includes('thought'), false);
});

test('semantic service failure keeps local recall and normal generation working', async () => {
    const host = fakeHost(); const vectors = fakeVectors(); const engine = new MemoryEngine(host, vectors);
    await engine.run(false);
    host.setSettings({ recallMode: 'semantic' }); vectors.query = async () => { throw new Error('offline'); };
    const chat = recordsFor(30).map(r => ({ index: r.hostIndex, name: r.name, is_user: r.isUser, mes: r.text }));
    await engine.intercept(chat, 200000, 'normal');
    assert.equal(chat.length, 18);
    assert.match(engine.status.trace.fallback, /本地检索/);
});

test('larger window restores all original messages; disabled extension clears injection', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors()); await engine.run(false);
    host.setSettings({ recentTokens: 100000 });
    const chat = recordsFor(30).map(r => ({ index: r.hostIndex, name: r.name, is_user: r.isUser, mes: r.text }));
    await engine.intercept(chat, 200000, 'normal'); assert.equal(chat.length, 60);
    host.setSettings({ enabled: false }); await engine.intercept(chat, 200000, 'normal');
    assert.equal(host.injections.at(-1), '');
});

test('changing old text invalidates affected memories before prompt mutation', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors()); await engine.run(false);
    host.edit(0);
    const chat = recordsFor(30).map(r => ({ index: r.hostIndex, name: r.name, is_user: r.isUser, mes: r.text }));
    await engine.intercept(chat, 200000, 'normal'); assert.equal(chat.length, 60);
    assert.equal(engine.status.state.segments.length, 0);
});

test('a running request uses its settings snapshot; next batch observes updated settings', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    let requests = 0;
    host.send = async messages => {
        requests++; host.setSettings({ recentTokens: 100000 });
        const source = Number(messages.at(-1).content.match(/\[楼层 (\d+)/)?.[1]);
        return response({ spans: [{ index: source - 1 }] });
    };
    await engine.run(false);
    assert.equal(requests, 1); assert.equal(host.local.segments.length, 1);
});
