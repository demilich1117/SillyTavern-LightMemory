import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeSettings, checkedTokens, emptyState, buildRounds, chooseWindow, pendingWork,
    shouldSummarize, planBatch, parseSummary, reconcileState, coveredIndices, compressionPlan, buildInjection,
    rankMemories, prefixWithin, safeExport, importState, fingerprint } from '../src/core.js';
import { vectorChunks, collectionFor } from '../src/vectors.js';
import { count, recordsFor, response } from './helpers.js';

test('settings preserve unrelated fields, clamp real limits, reject future schemas', () => {
    const input = { unknown: { retained: true }, batchTarget: 9000, batchMax: 3000, recentTokens: NaN };
    const settings = normalizeSettings(input);
    assert.equal(settings.batchTarget, 3000);
    assert.equal(settings.recentTokens, 12000);
    settings.unknown.retained = false;
    assert.equal(input.unknown.retained, true);
    assert.throws(() => normalizeSettings({ schemaVersion: 900 }), /更新版本/);
});

test('zero/NaN token counts for nonempty body never authorize compression', () => {
    for (const n of [NaN, Infinity, -1, 0]) assert.throws(() => checkedTokens(n, '正文'));
    assert.equal(checkedTokens(0, ''), 0);
});

test('long, short and mixed RP use token budgets and complete rounds', () => {
    const long = chooseWindow(buildRounds(recordsFor(30)), DEFAULTS);
    const short = chooseWindow(buildRounds(recordsFor(30, 300)), DEFAULTS);
    const mixedRounds = buildRounds(recordsFor(30, i => i % 4 === 1 ? 300 : 1500));
    const mixed = chooseWindow(mixedRounds, DEFAULTS);
    assert.equal(long.rounds, 8);
    assert.equal(short.rounds, 30);
    assert.ok(mixed.rounds > long.rounds && mixed.rounds < short.rounds);
    assert.ok(mixedRounds[mixed.start].records[0].isUser);
});

test('minimum rounds is a soft protection, hard host space and latest turn win', () => {
    const rounds = buildRounds(recordsFor(12));
    assert.equal(chooseWindow(rounds, { ...DEFAULTS, recentTokens: 3000, minRounds: 4 }, 100000).rounds, 4);
    const small = chooseWindow(rounds, DEFAULTS, 3500);
    assert.equal(small.rounds, 2);
    assert.equal(small.conflict, true);
    assert.equal(chooseWindow(rounds, DEFAULTS, 100).rounds, 1);
});

test('group replies stay in one turn and a pending user message is retained', () => {
    const records = recordsFor(4);
    records.splice(2, 0, { ...records[1], index: 99, name: '另一位角色' });
    records.push({ ...records[0], index: 100 });
    const rounds = buildRounds(records);
    assert.equal(rounds.length, 5);
    assert.equal(rounds[0].records.length, 3);
    assert.equal(rounds.at(-1).complete, false);
});

test('only pending content outside the recent window triggers summary; either threshold works', async () => {
    const records = recordsFor(11);
    const rounds = buildRounds(records);
    const work = await pendingWork(rounds, chooseWindow(rounds, DEFAULTS), [], count);
    assert.equal(work.roundCount, 3);
    assert.equal(shouldSummarize(work, DEFAULTS), true);
    assert.equal(shouldSummarize({ roundCount: 7, tokens: 100 }, DEFAULTS), false);
    assert.equal(shouldSummarize({ roundCount: 8, tokens: 100 }, DEFAULTS), true);
    assert.equal(shouldSummarize({ roundCount: 0, tokens: 0 }, DEFAULTS, true), false);
});

test('oversized reply spans are complete, non-overlapping; half a message is not compressible', async () => {
    const records = recordsFor(6, 9000);
    const rounds = buildRounds(records);
    const window = { start: 1 };
    const state = emptyState('test');
    let iterations = 0;
    while (true) {
        const work = await pendingWork(rounds, window, state.segments, count);
        if (!work.roundCount) break;
        const batch = await planBatch(work, { ...DEFAULTS, batchTarget: 1200, batchMax: 2000 }, 2000, count);
        state.segments.push(parseSummary(response(batch), batch));
        assert.ok(batch.tokens <= 2000);
        if (!iterations) assert.equal(coveredIndices(state.segments, records).has(1), false);
        iterations++;
        assert.ok(iterations < 20);
    }
    const spans = state.segments.flatMap(s => s.spans).filter(s => s.index === 1);
    assert.equal(spans[0].from, 0);
    assert.equal(spans.at(-1).to, records[1].text.length);
    spans.slice(1).forEach((s, i) => assert.equal(s.from, spans[i].to));
    assert.equal(compressionPlan(rounds, window, state, records).removed.size, 2);
});

test('attachments protect an entire turn from summary/compression', async () => {
    const records = recordsFor(11); records[0].protected = true;
    const rounds = buildRounds(records);
    const work = await pendingWork(rounds, chooseWindow(rounds, DEFAULTS), [], count);
    assert.ok(work.rounds.every(r => r.records.every(m => m.index > 1)));
});

test('malformed/truncated model output and invented source IDs fail closed', () => {
    const batch = { spans: [{ index: 2 }] };
    assert.throws(() => parseSummary('{"summary":', batch), /JSON/);
    assert.throws(() => parseSummary(JSON.stringify({ summary: '摘要', overview: '概览', memories: [{ kind: '事实', text: '事实', sources: [900] }] }), batch), /来源/);
    const valid = parseSummary(response(batch), batch);
    assert.equal(valid.memories[0].sources[0], 3);
});

async function threeSegments() {
    const records = recordsFor(20);
    const rounds = buildRounds(records);
    const state = emptyState('A');
    for (let i = 0; i < 3; i++) {
        const work = await pendingWork(rounds, { start: 10 }, state.segments, count);
        const batch = await planBatch(work, DEFAULTS, 6000, count);
        state.segments.push(parseSummary(response(batch), batch));
    }
    return { records, rounds, state };
}

test('editing an old source revokes its batch and every dependent later overview', async () => {
    const { records, state } = await threeSegments();
    const index = state.segments[1].spans[0].index;
    records[index].rawHash = 'swipe changed';
    const result = reconcileState(state, records, 'A');
    assert.equal(result.state.segments.length, 1);
    assert.equal(result.invalidated, 2);
    assert.equal(state.segments.length, 3);
});

test('regex-only changes invalidate memory and new branches rekey vector collections', async () => {
    const { records, state } = await threeSegments();
    const branch = reconcileState(state, records, 'B').state;
    assert.equal(branch.segments.length, 3);
    assert.notEqual(collectionFor(branch, DEFAULTS), collectionFor(state, DEFAULTS));
    records[0].cleanHash = 'changed regex';
    assert.equal(reconcileState(state, records, 'A').state.segments.length, 0);
});

test('expanding recent window restores originals and excludes overlapping retrieval', async () => {
    const { records, rounds, state } = await threeSegments();
    const small = compressionPlan(rounds, chooseWindow(rounds, DEFAULTS), state, records);
    const large = compressionPlan(rounds, chooseWindow(rounds, { ...DEFAULTS, recentTokens: 100000 }), state, records);
    assert.ok(small.removed.size > 0);
    assert.equal(large.removed.size, 0);
    assert.equal(large.eligible.length, 0);
});

test('manual exclusions restore sources; corrected summaries cannot leak through dependent overviews', async () => {
    const { records, rounds, state } = await threeSegments();
    state.segments[0].excluded = true;
    const plan = compressionPlan(rounds, { start: 10 }, state, records);
    assert.ok(state.segments[0].spans.every(s => !plan.removed.has(s.index)));
    assert.equal(plan.overview, '');
    state.segments[0].excluded = false; state.segments[0].overrideText = '用户纠正：钥匙已经归还。';
    assert.equal(compressionPlan(rounds, { start: 10 }, state, records).overview, '');
});

test('Chinese aliases and explicit IDs are retrieved without a vector service', async () => {
    const { state } = await threeSegments();
    state.segments[1].memories = [{ kind: '人物', text: '林鸦的别名是夜鹭，任务编号 AX-317。', entities: ['林鸦', '夜鹭', 'AX-317'], sources: [1] }];
    const ranked = rankMemories(state.segments, '夜鹭上次那个 AX-317 任务怎么办？');
    assert.equal(ranked[0].id, state.segments[1].id);
    assert.equal(rankMemories(state.segments, '完全无关的新词', [state.segments[2].id])[0].id, state.segments[2].id);
});

test('injection stays within token budget and oversized pinned memory fails closed', async () => {
    const { state } = await threeSegments();
    const plan = { eligible: state.segments, overview: '历史概览。'.repeat(500) };
    const result = await buildInjection(plan, state.segments, { ...DEFAULTS, memoryTokens: 500, recallLimit: 1 }, count);
    assert.ok(result.tokens <= 500);
    assert.ok(result.selected.length <= 1);
    state.segments[0].pinned = true; state.segments[0].overrideText = '重要'.repeat(1000);
    await assert.rejects(buildInjection(plan, state.segments, { ...DEFAULTS, memoryTokens: 500 }, count), /固定记忆/);
});

test('vector chunks cover the tail of long Chinese replies and do not split surrogate pairs', async () => {
    const text = '风吹过旧港。'.repeat(300) + '🗝️最后的银钥匙藏在地窖。';
    const chunks = await vectorChunks(text, 256);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.at(-1).to, text.length);
    assert.ok(chunks.at(-1).text.includes('地窖'));
    for (const c of chunks) assert.ok(new TextEncoder().encode(c.text).length <= 256);
    assert.equal((await prefixWithin('甲😀乙', 2, count)), '甲');
});

test('exports contain memory only; mismatching import does not overwrite a chat', async () => {
    const { state, records } = await threeSegments();
    const exported = safeExport(state);
    assert.equal(JSON.stringify(exported).includes('secretId'), false);
    assert.equal(importState(exported, records, 'A').segments.length, 3);
    records[0].rawHash = fingerprint('different chat');
    assert.throws(() => importState(exported, records, 'A'), /不匹配/);
});
