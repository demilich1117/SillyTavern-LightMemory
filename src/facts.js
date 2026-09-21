// Small optional fact updates; prose carries the story, IDs only track lasting changes.
export function projectFacts(segments) {
    const facts = {};
    for (const s of segments) {
        if (s.excluded || typeof s.overrideText === 'string') break;
        if (s.ledger) {
            const names = s.ledgerNames ?? {};
            for (const r of s.ledger.states) facts[r.id] = { id: r.id, text: (names[r.subject] ?? r.subject) + '：' + r.key + '，' + r.value, kind: '事实', status: 'active', sources: r.sources.map(n => n - 1) };
            for (const r of s.ledger.tasks) facts[r.id] = { id: r.id, text: r.text, kind: '约定', status: ['done','cancelled'].includes(r.status) ? 'resolved' : 'active', sources: r.sources.map(n => n - 1) };
        }
        for (const f of s.facts ?? []) facts[f.id] = structuredClone(f);
    }
    return facts;
}
export function parseFacts(input, batch, segments) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 40) throw new Error('关键记忆应为最多 40 项的列表，可留空。');
    const existing = projectFacts(segments), used = new Set(), reserved = new Set(segments.flatMap(s => (s.facts ?? []).map(f => f.id)));
    const allowed = [...new Set(batch.spans.map(p => p.index))];
    return input.map((item, index) => {
        const f = typeof item === 'string' ? { text: item } : item;
        const fail = message => { throw new Error('关键记忆第' + (index + 1) + '项：' + message + '；本批未保存。'); };
        if (!f || typeof f.text !== 'string' || !f.text.trim() || f.text.length > 3000) fail('缺少有效内容');
        let id = f.id;
        if (id != null && id !== '' && (typeof id !== 'string' || !Object.hasOwn(existing, id))) fail('更新 ID 不存在');
        if (!id) { let n = 1; do { id = 'F' + String(n++).padStart(3,'0'); } while (reserved.has(id) || Object.hasOwn(existing,id) || used.has(id)); }
        if (used.has(id)) fail('同批重复更新同一条目'); used.add(id);
        const sources = f.sources ?? allowed;
        if (!Array.isArray(sources) || !sources.length || sources.some(n => !Number.isInteger(n) || !allowed.includes(n))) fail('来源必须是本批酒馆消息 ID（从 0 开始）');
        if (existing[id] && Math.max(...sources) < Math.max(...existing[id].sources)) fail('旧来源不可覆盖较新状态');
        const status = f.status ?? existing[id]?.status ?? 'active';
        if (!['active','resolved','retracted'].includes(status)) fail('状态应为 active、resolved 或 retracted');
        return { id, text: f.text.trim(), sources: [...new Set(sources)], status,
            kind: ['事实','猜测','约定','未决'].includes(f.kind) ? f.kind : existing[id]?.kind ?? '事实' };
    });
}
export function validFacts(facts, spans) {
    return Array.isArray(facts) && facts.length <= 40 && new Set(facts.map(f => f?.id)).size === facts.length && facts.every(f =>
        f && typeof f.id === 'string' && /^[FST]\d+$/.test(f.id) && typeof f.text === 'string' && f.text.trim() && f.text.length <= 3000 &&
        ['active','resolved','retracted'].includes(f.status) && ['事实','猜测','约定','未决'].includes(f.kind) &&
        Array.isArray(f.sources) && f.sources.length && f.sources.every(n => Number.isInteger(n) && spans.some(p => p.index === n)));
}
export function factLine(f) { return f.id + ' [' + f.kind + '·' + ({active:'有效',resolved:'已解决',retracted:'已撤回'}[f.status]) + '] ' + f.text + '（来源消息 #' + f.sources.join('、#') + '）'; }

export function invalidFactsIndex(segments) {
    const last = {};
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment?.facts === undefined) continue;
        if (!Array.isArray(segment.spans) || !validFacts(segment.facts, segment.spans)) return i;
        for (const f of segment.facts) {
            const latest = Math.max(...f.sources);
            if (Object.hasOwn(last, f.id) && latest < last[f.id]) return i;
            last[f.id] = latest;
        }
    }
    return segments.length;
}
