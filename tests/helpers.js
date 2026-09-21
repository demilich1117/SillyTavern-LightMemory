import { DEFAULTS, fingerprint } from '../src/core.js';

export const count = async text => String(text).length;
export function recordsFor(roundCount, replyLength = 1420) {
    return Array.from({ length: roundCount * 2 }, (_, index) => {
        const isUser = index % 2 === 0;
        const text = isUser ? `用户第${index / 2 + 1}轮的行动。`.padEnd(80, '行') : `第${(index + 1) / 2}轮：旅人与店主交谈。`.padEnd(typeof replyLength === 'function' ? replyLength(index) : replyLength, '文');
        return { index, hostIndex: index, isUser, name: isUser ? '旅人' : '店主', text,
            rawHash: fingerprint([index, text]), cleanHash: fingerprint(text), promptTokens: text.length, protected: false };
    });
}
export function response(batch) {
    return JSON.stringify({ summary: '旅人把银钥匙交给店主保管，约定次日取回。', overview: '旅人仍在寻找遗失的信件。店主保管银钥匙，尚待归还。',
        memories: [{ kind: '物品', text: '银钥匙由店主保管。', entities: ['银钥匙', '店主', '旅人'], sources: [batch.spans[0].index + (batch.sourceBase ?? 1)] }] });
}
export function fakeHost(records = recordsFor(30), overrides = {}) {
    let settings = { ...DEFAULTS, enabled: true, ...overrides };
    let local = null, remote = null, owner = 'chat-A', signature = 'unchanged';
    const calls = [], injections = [];
    const host = {
        calls, injections, settings: () => structuredClone(settings), setSettings: patch => { settings = { ...settings, ...patch }; },
        identity: () => owner, isGenerating: () => false, maxPromptTokens: () => 200000,
        count, availableHistory: async () => ({ available: 100000, overhead: 0, reserve: 0 }),
        context: () => ({ chatMetadata: { lightmemory: local } }),
        capture: async () => ({ owner, signature, state: structuredClone(local), records: structuredClone(records), rulesKey: 'rules' }),
        assertSnapshot: snapshot => { if (snapshot.owner !== owner || snapshot.signature !== signature) throw new DOMException('stale', 'AbortError'); },
        inject: text => injections.push(text), remoteState: async () => structuredClone(remote),
        persist: async (snapshot, next, expected) => {
            host.assertSnapshot(snapshot);
            if ((remote?.revision ?? null) !== expected) throw new Error('revision conflict');
            if (host.failSave) throw new Error('save failed');
            local = structuredClone(next); remote = structuredClone(next); calls.push({ type: 'save', state: next });
            return remote;
        },
        prepareApi: async () => ({ limit: 16384, output: 2048, count, send: async messages => {
            calls.push({ type: 'api', messages });
            if (host.send) return host.send(messages);
            const source = Number(messages.at(-1).content.match(/\[楼层 (\d+)/)?.[1]);
            return response({ spans: [{ index: source - 1 }] });
        } }),
        switchChat: () => { owner = 'chat-B'; signature = 'changed'; local = null; remote = null; },
        append: more => { records.push(...more); signature = fingerprint(records.map(r => r.rawHash)); },
        edit: index => { signature = 'edited'; records[index].text += '编辑'; records[index].rawHash = fingerprint(records[index].text); records[index].cleanHash = fingerprint(records[index].text); },
        get local() { return local; }, get remote() { return remote; },
    };
    return host;
}
export const fakeVectors = () => ({ sync: async () => {}, query: async () => [], clearCache: () => {} });
