import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, emptyState, buildRounds, chooseWindow, pendingWork, planBatch, parseSummary, sourceRanges, formatSpan, compressionPlan, buildInjection, reconcileState, safeExport, importState } from '../src/core.js';
import { projectFacts } from '../src/facts.js';
import { recordsFor, count, fakeHost, fakeVectors } from './helpers.js';
import { MemoryEngine } from '../src/engine.js';
const records = recordsFor(18);
const batch = i => ({ sourceBase: 0, spans: [{ index: i, from: 0, to: records[i].text.length, rawHash: records[i].rawHash, cleanHash: records[i].cleanHash }] });
const data = facts => JSON.stringify({ memoryVersion: 1, summary: '旅人获赠钥匙，并约定归还。', overview: '旅人准备出发。', ...(facts === undefined ? {} : { key_memories: facts }) });
test('opening at message zero is separate from 18 user turns and excluded from round protection', async () => {
    const list = [{ ...records[1], index: 0 }, ...records.map(r => ({ ...r, index: r.index + 1 }))];
    const rounds = buildRounds(list); const w = chooseWindow(rounds, { ...DEFAULTS, recentTokens: 12000 });
    assert.equal(rounds.length, 19); assert.equal(rounds.filter(r => !r.opening).length, 18);
    assert.equal(w.rounds, 8);
    const work = await pendingWork(rounds, w, [], count);
    assert.equal(work.totalRounds + w.rounds, 18); assert.ok(work.openingPending);
    assert.match(formatSpan(list[0], 0, 10), /^\[楼层 0 /);
});
test('protected MVU rounds remain counted and later pending turns queue in order', async () => {
    const rs=recordsFor(18);rs[3].protected=true;
    const work=await pendingWork(buildRounds(rs), {start:10}, [], count);
    assert.equal(work.totalRounds,10);assert.equal(work.roundCount,1);assert.equal(work.blockedRounds,1);assert.equal(work.queuedRounds,8);
    const planned=await planBatch(work,DEFAULTS,6000,count);
    assert.deepEqual(planned.spans.map(p=>p.index),[0,1]);
    assert.equal(sourceRanges([{index:0},{index:1},{index:6},{index:8},{index:9}]),'0–1、6、8–9');
});
test('natural summaries accept no facts, strings and optional metadata without event IDs', () => {
    assert.deepEqual(parseSummary(data(),batch(0)).facts,[]);
    const a=parseSummary(data(['次日归还银钥匙']),batch(0));
    assert.equal(a.facts[0].id,'F001'); assert.deepEqual(a.facts[0].sources,[0]);
    const b=parseSummary(data([{id:'F001',text:'银钥匙已归还',status:'resolved'}]),batch(1),[a]);
    assert.equal(projectFacts([a,b]).F001.status,'resolved');
    const state={...emptyState('A'),segments:[a,b]};
    assert.deepEqual(importState(safeExport(state),records,'A').segments,[a,b]);
    assert.equal(reconcileState(state,[{...records[0],rawHash:'edit'},...records.slice(1)],'A').invalidated,2);
    assert.deepEqual(parseSummary(data([{text:'额外来源不采用',sources:[99]}]),batch(0)).facts[0].sources,[0]);
    assert.throws(()=>parseSummary(data([{id:'F999',text:'伪造更新'}]),batch(0)),/ID 不存在/);
});
test('resolved key memory exits active injection; matching old recall includes its resolution', async () => {
    const a=parseSummary(data([{text:'钥匙待归还',kind:'约定'}]),batch(0));
    const b=parseSummary(data([{id:'F001',text:'钥匙已归还',status:'resolved'}]),batch(1),[a]);
    const state={...emptyState('A'),segments:[a,b]};
    const plan=compressionPlan(buildRounds(records),{start:2},state,records);
    const unrelated=await buildInjection(plan,[],DEFAULTS,count);
    assert.ok(!unrelated.text.includes('后续结果：'));
    const related=await buildInjection(plan,[a],DEFAULTS,count,'钥匙');
    assert.match(related.text,/后续结果：.*已归还/);
});
test('engine sends simpler prompt and preserves fact IDs across batches', async()=>{
    const host=fakeHost(recordsFor(6),{recentTokens:256,minRounds:1,batchTarget:1000,batchMax:2000,triggerTokens:128});let calls=0;
    host.send=messages=>{calls++;if(calls>1){assert.match(messages[1].content,/F001/);host.setSettings({auto:false});}return data(calls===1?['保留约定']:[]);};
    const engine=new MemoryEngine(host,fakeVectors());await engine.run(false);
    assert.equal(engine.status.error,'');assert.ok(host.local.segments[0].facts.length);engine.destroy();
});

test('model-supplied source fields are ignored; internal batch provenance and clean display survive', async () => {
    const { factLine } = await import('../src/facts.js');
    for (const sources of [[99], ['第1楼'], [], null, '0-6', { wrong: true }]) {
        const segment = parseSummary(data([{ text: '归还钥匙', sources }]), batch(0));
        assert.deepEqual(segment.facts[0].sources, [0]);
        assert.ok(!factLine(segment.facts[0]).includes('来源'));
        const state = {...emptyState('A'),segments:[segment]};
        assert.deepEqual(importState(safeExport(state),records,'A').segments,[segment]);
        assert.equal(reconcileState(state,[{...records[0],rawHash:'edited'},...records.slice(1)],'A').invalidated,1);
    }
});
