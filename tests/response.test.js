import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryResponseText } from '../src/network.js';
import { parseSummary, normalizeSettings } from '../src/core.js';
import { MemoryEngine } from '../src/engine.js';
import { fakeHost, fakeVectors, response } from './helpers.js';

const extract = data => data.choices[0].message.content;
const batch = { spans: [{ index: 0 }] };

test('length stop is reported before JSON parsing; reasoning never repairs truncated content', () => {
    const result = { choices: [{ finish_reason: 'length', message: {
        content: '```json\n{"summary":"旅人将钥匙', reasoning_content: response(batch),
    } }], usage: { prompt_tokens: 4989, completion_tokens: 79, total_tokens: 7033 } };
    assert.throws(() => summaryResponseText(result, () => assert.fail('must reject before extracting'), 2048),
        error => error.name === 'SummaryTruncatedError' && /2,048/.test(error.message));
});

test('complete fenced JSON with separate reasoning continues to validate normally', () => {
    const result = { choices: [{ finish_reason: 'stop', message: {
        content: `\`\`\`json\n${response(batch)}\n\`\`\``, reasoning_content: 'DO_NOT_SAMPLE_THINKING',
    } }] };
    const parsed = parseSummary(summaryResponseText(result, extract, 4096), batch);
    assert.match(parsed.summary, /银钥匙/);
    assert.ok(!JSON.stringify(parsed).includes('DO_NOT_SAMPLE_THINKING'));
});

test('native max token stop variants reject even syntactically valid partial results', () => {
    for (const data of [{ stop_reason: 'max_tokens' }, { candidates: [{ finishReason: 'MAX_TOKENS' }] }]) {
        assert.throws(() => summaryResponseText(data, () => response(batch), 4096), { name: 'SummaryTruncatedError' });
    }
});

test('truncated response does not save or advance coverage in the engine', async () => {
    const host = fakeHost(); const engine = new MemoryEngine(host, fakeVectors());
    host.send = () => summaryResponseText({ choices: [{ finish_reason: 'length' }] }, extract, 2048);
    await engine.run(true);
    assert.equal(host.local, null);
    assert.equal(host.calls.filter(call => call.type === 'save').length, 0);
    assert.match(engine.status.error, /摘要输出达到上限/);
});

test('new output default is larger without overriding existing explicit budgets', () => {
    assert.equal(normalizeSettings({}).summaryOutput, 4096);
    assert.equal(normalizeSettings({ summaryOutput: 2048 }).summaryOutput, 2048);
    assert.equal(normalizeSettings({ summaryOutput: 8192, summaryContext: 16384 }).summaryOutput, 8192);
});
