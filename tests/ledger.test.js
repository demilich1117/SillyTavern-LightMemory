import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary, readState, emptyState, reconcileState, buildRounds, chooseWindow, compressionPlan, buildInjection, formatMemory, importState, safeExport } from '../src/core.js';
import { replayLedger, ledgerContext } from '../src/ledger.js';
import { fakeHost, fakeVectors, recordsFor } from './helpers.js';
import { MemoryEngine } from '../src/engine.js';

const records = recordsFor(30);
const batch = index => ({ spans: [{ index, from: 0, to: records[index].text.length, rawHash: records[index].rawHash, cleanHash: records[index].cleanHash }] });
const proposal = (floor = 1) => ({ ledgerVersion: 1, summary: '旅人获得钥匙，并约定次日归还。', overview: '旅人持有钥匙，归还待完成。',
    people: [{ ref: 'new_person_a', name: '旅人', sources: [floor] }],
    events: [{ ref: 'new_event_a', text: '旅人获得钥匙并承诺次日归还。', people: ['new_person_a'], certainty: 'explicit', time: null, sources: [floor] }],
    states: [{ id: null, subject: 'new_person_a', key: '持有物品', value: '银钥匙', event: 'new_event_a', sources: [floor] }],
    tasks: [{ id: null, text: '旅人归还银钥匙', people: ['new_person_a'], status: 'pending', time: { label: '取得钥匙的次日', anchorSource: floor }, event: 'new_event_a', sources: [floor] }],
});
const parse = (data, index = 0, previous = []) => parseSummary(JSON.stringify(data), batch(index), previous);
const first = () => parse(proposal());
const multiBatch = () => ({ spans: [0, 2, 4, 6].flatMap(i => batch(i).spans) });

test('additional corroborating sources survive parse, saved replay and export/import', () => {
    const data = proposal(3);
    data.states[0].sources = [3, 5];
    data.tasks[0].sources = [3, 5, 7];
    const segment = parseSummary(JSON.stringify(data), multiBatch());
    assert.deepEqual(segment.ledger.events[0].sources, [3]);
    assert.deepEqual(segment.ledger.states[0].sources, [3, 5]);
    assert.deepEqual(segment.ledger.tasks[0].sources, [3, 5, 7]);
    const state = { ...emptyState('A'), segments: [segment] };
    assert.equal(reconcileState(state, records, 'A').invalidated, 0);
    assert.deepEqual(importState(safeExport(state), records, 'A').segments, [segment]);
});

test('disjoint, out-of-batch and inferred supporting events remain invalid', () => {
    for (const key of ['states', 'tasks']) {
        const data = proposal(3);
        data[key][0].sources = [5, 7];
        assert.throws(() => parseSummary(JSON.stringify(data), multiBatch()), /第1项来源第5、7楼.*new_event_a.*第3楼.*没有共同来源/);
        data[key][0].sources = [3, 50];
        assert.throws(() => parseSummary(JSON.stringify(data), multiBatch()), /本批正文/);
        data[key][0].sources = [3, 5];
        data.events[0].certainty = 'inferred';
        assert.throws(() => parseSummary(JSON.stringify(data), multiBatch()), /明确发生/);
    }
    const segment = parseSummary(JSON.stringify(proposal(3)), multiBatch());
    segment.ledger.tasks[0].sources = [5, 7];
    const state = { ...emptyState('A'), segments: [segment] };
    assert.equal(reconcileState(state, records, 'A').invalidated, 1);
    assert.throws(() => importState(safeExport(state), records, 'A'), /不匹配/);
});

const update = () => ({ ledgerVersion: 1, summary: '旅人已归还钥匙。', overview: '归还约定已完成。', people: [],
    events: [{ ref: 'new_event_b', text: '旅人归还钥匙。', people: ['P001'], certainty: 'explicit', time: { label: '翌日', anchorSource: 1 }, sources: [2] }],
    states: [{ id: 'S001', subject: 'P001', key: '持有物品', value: '已归还银钥匙', event: 'new_event_b', sources: [2] }],
    tasks: [{ id: 'T001', text: '旅人归还银钥匙', people: ['P001'], status: 'done', event: 'new_event_b', sources: [2] }],
});

test('plugin assigns IDs; aliases optional, same-name new people stay distinct', () => {
    const a = first(); assert.equal(a.ledger.people[0].id, 'P001'); assert.deepEqual(a.ledger.people[0].aliases, []);
    const b = parse(proposal(2), 1, [a]); assert.equal(b.ledger.people[0].id, 'P002');
    assert.equal(Object.keys(replayLedger([a, b]).people).length, 2);
});
test('state and task advance using existing IDs; deadline remains anchored and history preserved', () => {
    const a = first(), b = parse(update(), 1, [a]), ledger = replayLedger([a, b]);
    assert.equal(ledger.tasks.T001.status, 'done'); assert.equal(ledger.tasks.T001.time.anchorSource, 1);
    assert.equal(ledger.states.S001.value, '已归还银钥匙'); assert.equal(a.ledger.states[0].value, '银钥匙');
    assert.equal(b.ledgerNames.P001, '旅人'); assert.equal(Object.keys(ledger.events).length, 2);
});
test('invented IDs, wrong sources, unknown time anchors and inferred state changes reject', () => {
    const edits = [d => { d.people[0].ref = 'P999'; }, d => { d.events[0].people = ['P999']; },
        d => { d.states[0].sources = [50]; }, d => { d.tasks[0].time.anchorSource = 50; },
        d => { d.events[0].certainty = 'inferred'; }, d => { d.people[0].ref = '__proto__'; }];
    for (const edit of edits) { const data = proposal(); edit(data); assert.throws(() => parse(data), /校验失败/); }
});
test('cannot create duplicate slot, overwrite another subject, or reopen completed task silently', () => {
    const a = first(); const d = update(); d.states[0].id = null;
    assert.throws(() => parse(d, 1, [a]), /原 ID/);
    const b = parse(update(), 1, [a]); const c = update(); c.events[0].sources = [3]; c.states = []; c.tasks[0].sources = [3]; c.tasks[0].status = 'pending';
    assert.throws(() => parse(c, 2, [a, b]), /不可静默重启/);
});
test('source edit rolls back dependent updates; branch preserves retained character IDs', () => {
    const a = first(), b = parse(update(), 1, [a]); const state = { ...emptyState('A'), segments: [a, b] };
    const changed = structuredClone(records); changed[1].cleanHash = 'changed';
    const result = reconcileState(state, changed, 'B'); const ledger = replayLedger(result.state.segments);
    assert.equal(result.invalidated, 1); assert.equal(ledger.people.P001.name, '旅人'); assert.equal(ledger.tasks.T001.status, 'pending');
});
test('legacy import remains lossless and new exports reject broken structured dependencies', () => {
    const legacy = { ...emptyState('A'), schemaVersion: 1 };
    assert.equal(readState(legacy, 'A').schemaVersion, 2); assert.equal(legacy.schemaVersion, 1);
    const state = { ...emptyState('A'), segments: [first()] }; const file = safeExport(state);
    file.state.segments[0].ledger.states[0].subject = 'P999';
    assert.throws(() => importState(file, records, 'A'), /匹配/);
});
test('injection shows current state and no stale pending status in historical recall', async () => {
    const a = first(), b = parse(update(), 1, [a]); const state = { ...emptyState('A'), segments: [a, b] };
    const settings = { recentTokens: 12000, minRounds: 4, memoryTokens: 2000, recallLimit: 6 };
    const rounds = buildRounds(records), window = chooseWindow(rounds, settings);
    const plan = compressionPlan(rounds, window, state, records);
    const result = await buildInjection(plan, [a, b], settings, async t => t.length, '旅人的钥匙');
    assert.match(result.text, /P001 旅人/); assert.match(result.text, /已归还银钥匙/);
    assert.ok(!formatMemory(a).includes('[未开始]')); assert.ok(result.tokens <= 2000);
    assert.equal(compressionPlan(rounds, { start: 0 }, state, records).eligible.length, 0);
});
test('manual text override disables dependent state projection, preserving archived data', () => {
    const a = first(), b = parse(update(), 1, [a]); a.overrideText = '手工纠正的记录';
    assert.equal(Object.keys(replayLedger([a, b]).states).length, 0); assert.equal(b.ledger.tasks[0].status, 'done');
});
test('engine includes identity registry on next batch and commits structured updates', async () => {
    const host = fakeHost(recordsFor(6), { recentTokens: 256, minRounds: 1, batchMax: 2000, batchTarget: 1000, triggerTokens: 128 });
    let calls = 0;
    host.send = messages => {
        calls++;
        if (calls > 1) { assert.match(messages[1].content, /P001/); host.setSettings({ auto: false }); }
        const floor = Number(messages[1].content.match(/\[楼层 (\d+)/)[1]);
        const data = proposal(floor);
        if (calls > 1) { data.people = []; data.events[0].people = ['P001']; data.states = []; data.tasks = []; }
        return JSON.stringify(data);
    };
    const engine = new MemoryEngine(host, fakeVectors()); await engine.run(false);
    assert.equal(engine.status.error, ''); assert.ok(calls >= 2); assert.equal(host.local.schemaVersion, 2);
    assert.ok(ledgerContext(host.local.segments).includes('P001'));
});
