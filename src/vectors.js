import { fingerprint, prefixWithin } from './core.js';
import { boundedRequest } from './network.js';

export function vectorConfig(settings) {
    const config = { source: settings.vectorSource };
    if (settings.vectorSource === 'openai') config.model = settings.vectorModel || 'text-embedding-3-small';
    if (settings.vectorSource === 'siliconflow') {
        config.model = settings.vectorModel || 'Qwen/Qwen3-Embedding-0.6B';
        config.siliconflow_endpoint = settings.siliconflowEndpoint;
    }
    if (settings.vectorSource === 'ollama') {
        if (!settings.vectorModel) throw new Error('请填写 Ollama 嵌入模型名称。');
        let url;
        try { url = new URL(settings.vectorUrl || 'http://127.0.0.1:11434'); } catch { throw new Error('Ollama 地址无效。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Ollama 地址须为不含密码的 HTTP(S) 地址。');
        config.model = settings.vectorModel;
        config.apiUrl = url.toString();
        config.keep = true;
    }
    return config;
}

export const collectionFor = (state, settings) => `lightmemory-${fingerprint(state.owner)}-${fingerprint([state.vectorEpoch, vectorConfig(settings), settings.vectorChunkTokens])}`;

// Unknown embedding tokenizers must not silently truncate long Chinese messages. A byte-based
// upper estimate intentionally makes chunks smaller; all offsets address the cleaned text.
export async function vectorChunks(text, budget) {
    const chunks = [];
    const count = async value => new TextEncoder().encode(value).length;
    let offset = 0;
    while (offset < text.length) {
        const part = await prefixWithin(text.slice(offset), budget, count);
        if (!part) throw new Error('向量切块预算不足。');
        chunks.push({ from: offset, to: offset + part.length, text: part });
        if (offset + part.length === text.length) break;
        const overlap = Math.min(16, Math.floor(part.length / 8));
        offset += Math.max(1, part.length - overlap);
        if (/[\uDC00-\uDFFF]/u.test(text[offset])) offset++;
    }
    return chunks;
}

export function createVectorService(host) {
    const inventories = new Map();
    async function inventory(state, records, settings) {
        const collectionId = collectionFor(state, settings);
        const key = `${collectionId}:${state.revision}`;
        if (inventories.has(key)) return inventories.get(key);
        const recordMap = new Map(records.map(r => [r.index, r]));
        const items = [], lookup = new Map();
        for (const segment of state.segments) {
            if (segment.excluded) continue;
            for (const span of segment.spans) {
                const record = recordMap.get(span.index);
                if (!record || record.cleanHash !== span.cleanHash || record.rawHash !== span.rawHash) continue;
                for (const chunk of await vectorChunks(record.text.slice(span.from, span.to), settings.vectorChunkTokens)) {
                    const hash = parseInt(fingerprint([segment.id, span.index, span.from + chunk.from, span.from + chunk.to, chunk.text]).slice(0, 13), 16);
                    if (lookup.has(hash)) throw new Error('向量标识冲突，已回退关键词检索。');
                    items.push({ hash, text: chunk.text, index: span.index });
                    lookup.set(hash, { segmentId: segment.id, source: span.index, from: span.from + chunk.from, to: span.from + chunk.to });
                }
            }
        }
        const result = { collectionId, items, lookup };
        if (inventories.size > 12) inventories.clear();
        inventories.set(key, result);
        return result;
    }

    async function request(route, body, settings, signal, timeout = settings.vectorTimeout) {
        return boundedRequest(s => host.post(`/api/vector/${route}`, { ...vectorConfig(settings), ...body }, s), { seconds: timeout, signal });
    }

    async function sync(state, records, settings, signal, progress = () => {}) {
        const data = await inventory(state, records, settings);
        if (!data.items.length) return { indexed: 0, total: 0 };
        const saved = await request('list', { collectionId: data.collectionId }, settings, signal, 15);
        if (!Array.isArray(saved)) throw new Error('向量索引列表格式无效。');
        const hashes = new Set(saved);
        const missing = data.items.filter(i => !hashes.has(i.hash));
        const size = ['transformers', 'ollama'].includes(settings.vectorSource) ? 1 : 5;
        let done = data.items.length - missing.length;
        progress(done, data.items.length);
        for (let i = 0; i < missing.length; i += size) {
            signal?.throwIfAborted();
            await request('insert', { collectionId: data.collectionId, items: missing.slice(i, i + size) }, settings, signal, settings.requestTimeout);
            done += missing.slice(i, i + size).length;
            progress(done, data.items.length);
        }
        return { indexed: done, total: data.items.length };
    }

    async function query(state, records, settings, text, eligibleIds, signal) {
        const data = await inventory(state, records, settings);
        if (!data.items.length || !text.trim()) return [];
        const searchText = await prefixWithin(text, settings.vectorChunkTokens, async t => new TextEncoder().encode(t).length);
        const result = await request('query', { collectionId: data.collectionId, searchText, topK: Math.min(100, settings.recallLimit * 6), threshold: 0.2 }, settings, signal);
        if (!Array.isArray(result?.hashes)) throw new Error('向量召回结果格式无效。');
        return [...new Set(result.hashes.map(hash => data.lookup.get(hash)?.segmentId).filter(id => eligibleIds.has(id)))];
    }

    async function test(settings, signal) {
        const collectionId = `lightmemory-test-${globalThis.crypto.randomUUID()}`;
        try {
            await request('insert', { collectionId, items: [{ hash: 1, text: '旅人将银色钥匙交给旅店老板。', index: 0 }] }, settings, signal, settings.requestTimeout);
            const result = await request('query', { collectionId, searchText: '银钥匙现在由谁保管？', topK: 1, threshold: 0 }, settings, signal, settings.requestTimeout);
            if (!result?.hashes?.includes(1)) throw new Error('测试文档未被召回，请检查嵌入模型。');
            return '向量写入与召回测试通过。';
        } finally {
            try { await boundedRequest(s => host.post('/api/vector/purge', { collectionId }, s), { seconds: 10 }); } catch { /* Only this synthetic collection can remain for later cleanup. */ }
        }
    }
    return { sync, query, test, clearCache: () => inventories.clear() };
}
