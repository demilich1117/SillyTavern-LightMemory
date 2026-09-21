import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, buildRounds, chooseWindow, pendingWork, shouldSummarize, planBatch } from '../src/core.js';
test('30k trial: 60 idealized 1200-token turns compact around 35,45,55', async()=>{
    const records=[],segments=[],at=[];
    const count=async s=>s.length;
    for(let turn=1;turn<=60;turn++){
        for(const isUser of [true,false]) records.push({index:records.length,isUser,name:'test',text:isUser?'':'文'.repeat(1200),promptTokens:isUser?0:1200,rawHash:String(records.length),cleanHash:String(records.length),protected:false});
        const rounds=buildRounds(records),window=chooseWindow(rounds,DEFAULTS);
        const work=await pendingWork(rounds,window,segments,count);
        if(shouldSummarize(work,DEFAULTS)){
            const batch=await planBatch(work,DEFAULTS,DEFAULTS.batchMax,count);
            segments.push({spans:batch.spans});at.push(turn);
        }
    }
    assert.deepEqual(at,[35,45,55]);
    const rounds=buildRounds(records),window=chooseWindow(rounds,DEFAULTS);
    assert.equal(window.rounds,25);
    assert.equal((await pendingWork(rounds,window,segments,count)).totalRounds,5);
});
