// Structured changes are stored with each source batch. Replaying the retained batches
// restores identities and state without a second mutable database or destructive migration.
export const emptyLedger = () => ({ people: {}, events: {}, states: {}, tasks: {} });
const copy = value => structuredClone(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(`结构化记忆校验失败：${message}；本批未保存。`); };
const text = (value, max = 600) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max = 24) => Array.isArray(value) && value.length <= max;

export function replayLedger(segments) {
    const ledger = emptyLedger();
    for (const segment of segments) {
        // Free text corrections cannot safely be interpreted as structured updates.
        if (segment.excluded || typeof segment.overrideText === 'string') break;
        if (!segment.ledger) continue;
        for (const key of ['people', 'events', 'states', 'tasks']) {
            for (const record of segment.ledger[key]) ledger[key][record.id] = copy(record);
        }
    }
    return ledger;
}

export function parseLedger(data, batch, segments = []) {
    requireThat(data.ledgerVersion === 1, '缺少 ledgerVersion: 1');
    const base = replayLedger(segments), next = copy(base), delta = { people: [], events: [], states: [], tasks: [] };
    const allowed = new Set(batch.spans.map(s => s.index + 1));
    const anchors = new Set([...segments.flatMap(s => s.spans.map(p => p.index + 1)), ...allowed]);
    const refs = new Map();
    const reserved = new Set(segments.flatMap(s => s.ledger ? Object.values(s.ledger).flatMap(rows => rows.map(r => r.id)) : []));
    const allocate = (key, prefix) => {
        let n = 1;
        while (next[key][`${prefix}${String(n).padStart(3, '0')}`] || reserved.has(`${prefix}${String(n).padStart(3, '0')}`)) n++;
        return `${prefix}${String(n).padStart(3, '0')}`;
    };
    const sources = value => {
        requireThat(list(value) && value.length > 0 && value.every(n => Number.isInteger(n) && allowed.has(n)), '来源必须来自本批正文');
        return [...new Set(value)];
    };
    const time = value => {
        if (value == null) return { label: '', anchorSource: null };
        requireThat(typeof value === 'object' && typeof value.label === 'string' && value.label.length <= 160, '剧情时间格式无效');
        requireThat(value.label.trim() ? Number.isInteger(value.anchorSource) && anchors.has(value.anchorSource) : value.anchorSource == null, '剧情时间缺少有效参照楼层');
        return { label: value.label.trim(), anchorSource: value.anchorSource ?? null };
    };
    for (const key of Object.keys(delta)) requireThat(list(data[key]), `${key} 必须是最多 24 项的数组`);
    requireThat(Object.values(delta).length && ['people', 'events', 'states', 'tasks'].reduce((n, k) => n + data[k].length, 0) <= 48, '单批更新过多，请减少批次输入');
    for (const p of data.people) {
        requireThat(p && text(p.ref, 80) && text(p.name, 120) && !refs.has(p.ref), '人物引用或名字无效');
        const previous = /^P\d+$/.test(p.ref) ? base.people[p.ref] : null;
        requireThat(previous || /^new_person_[a-zA-Z0-9]+$/.test(p.ref), '新人物须使用临时引用，正式 ID 由插件分配');
        requireThat(p.aliases === undefined || (list(p.aliases, 12) && p.aliases.every(a => text(a, 120))), '别名必须是可选的字符串数组');
        const id = previous?.id ?? allocate('people', 'P');
        const record = { id, name: p.name.trim(), aliases: [...new Set([...(previous?.aliases ?? []), ...(p.aliases ?? [])])], sources: sources(p.sources) };
        requireThat(record.aliases.length <= 24, '人物别名过多');
        refs.set(p.ref, id); next.people[id] = record; delta.people.push(record);
    }
    const person = ref => {
        const id = refs.get(ref) ?? ref;
        requireThat(typeof id === 'string' && /^P\d+$/.test(id) && Object.hasOwn(next.people, id), '引用了不存在的人物 ID'); return id;
    };
    const people = value => {
        requireThat(list(value, 12), '事件或待办人物列表无效'); return [...new Set(value.map(person))];
    };
    const eventRefs = new Map();
    for (const e of data.events) {
        requireThat(e && /^new_event_[a-zA-Z0-9]+$/.test(e.ref) && !eventRefs.has(e.ref) && text(e.text), '事件格式或临时引用无效');
        requireThat(['explicit', 'inferred'].includes(e.certainty), '事件必须区分明确证据与推测');
        const id = allocate('events', 'E');
        const record = { id, text: e.text.trim(), people: people(e.people), time: time(e.time), certainty: e.certainty, sources: sources(e.sources) };
        eventRefs.set(e.ref, id); next.events[id] = record; delta.events.push(record);
    }
    const evidence = (ref, recordSources, label) => {
        const event = next.events[eventRefs.get(ref)];
        requireThat(event && event.certainty === 'explicit', '状态或任务更新必须关联本批明确发生的事件');
        // Later floors may corroborate a state or promise without belonging to its initiating event.
        requireThat(recordSources.some(n => event.sources.includes(n)), `${label}来源第${recordSources.join('、')}楼与关联事件 ${ref}（第${event.sources.join('、')}楼）没有共同来源`); return event.id;
    };
    const seen = new Set();
    for (const s of data.states) {
        requireThat(s && text(s.key, 80) && text(s.value), '状态属性或内容无效');
        const subject = person(s.subject), source = sources(s.sources);
        const previous = typeof s.id === 'string' && /^S\d+$/.test(s.id) ? base.states[s.id] : null;
        requireThat(!s.id || previous, '待更新状态 ID 不存在');
        requireThat(!previous || (previous.subject === subject && previous.key === s.key.trim()), '状态 ID 不可更换主体或属性');
        const slot = `${subject}:${s.key.trim()}`;
        requireThat(!seen.has(slot), '同批对同一状态重复更新'); seen.add(slot);
        requireThat(previous || !Object.values(base.states).some(r => r.subject === subject && r.key === s.key.trim()), '已有状态须按原 ID 更新');
        const id = previous?.id ?? allocate('states', 'S');
        const record = { id, subject, key: s.key.trim(), value: s.value.trim(), event: evidence(s.event, source, `状态第${delta.states.length + 1}项`), sources: source };
        next.states[id] = record; delta.states.push(record);
    }
    for (const t of data.tasks) {
        requireThat(t && text(t.text) && ['pending', 'active', 'done', 'cancelled', 'uncertain'].includes(t.status), '待办内容或进度无效');
        const previous = typeof t.id === 'string' && /^T\d+$/.test(t.id) ? base.tasks[t.id] : null;
        requireThat(!t.id || previous, '待更新任务 ID 不存在');
        requireThat(!t.id || !seen.has(t.id), '同批重复更新任务'); seen.add(t.id);
        requireThat(!previous || !['done', 'cancelled'].includes(previous.status) || t.status === previous.status, '已结束任务不可静默重启，请另建任务');
        const source = sources(t.sources), participants = people(t.people);
        requireThat(previous || !Object.values(next.tasks).some(r => r.text === t.text.trim() && JSON.stringify(r.people) === JSON.stringify(participants)), '相同任务应沿用原 ID');
        const id = previous?.id ?? allocate('tasks', 'T');
        const record = { id, text: t.text.trim(), people: participants, status: t.status, time: t.time === undefined && previous ? previous.time : time(t.time), event: evidence(t.event, source, `任务第${delta.tasks.length + 1}项`), sources: source };
        next.tasks[id] = record; delta.tasks.push(record);
    }
    return delta;
}

export function ledgerContext(segments) {
    const ledger = replayLedger(segments);
    // Archived events are not a second copy of the entire conversation in every request.
    return JSON.stringify({ ...ledger, events: Object.fromEntries(Object.entries(ledger.events).slice(-12)) });
}

const progress = { pending: '未开始', active: '进行中', done: '已完成', cancelled: '已取消', uncertain: '待核实' };
const sourceText = r => `来源第${r.sources.map(n => n - 1).join('、')}楼`;
const timeText = r => r.time?.label ? `；时间：${r.time.label}（参照第${r.time.anchorSource - 1}楼）` : '';
export function ledgerLines(ledger, names = {}) {
    const name = id => `${id} ${ledger.people[id]?.name ?? names[id] ?? '身份待核对'}`;
    return {
        people: Object.values(ledger.people).map(p => `${p.id} ${p.name}${p.aliases.length ? `；已确认别名：${p.aliases.join('、')}` : ''}`),
        states: Object.values(ledger.states).map(s => `${s.id} ${name(s.subject)}｜${s.key}：${s.value}；截至${sourceText(s)}`),
        tasks: Object.values(ledger.tasks).map(t => `${t.id} [${progress[t.status]}] ${t.people.map(name).join('、')}｜${t.text}${timeText(t)}；${sourceText(t)}`),
        events: Object.values(ledger.events).map(e => `${e.id} [${e.certainty === 'explicit' ? '已发生/明确陈述' : '推测，未证实'}] ${e.people.map(name).join('、')}｜${e.text}${timeText(e)}；${sourceText(e)}`),
    };
}

export function formatLedger(ledger, includeEvents = true, names = {}) {
    const lines = ledgerLines(ledger, names);
    return [['人物', lines.people], ['最后确认的状态', lines.states], ['任务与约定', lines.tasks], ...(includeEvents ? [['历史事件', lines.events]] : [])]
        .filter(([, rows]) => rows.length).map(([title, rows]) => `【${title}】\n${rows.map(r => `- ${r}`).join('\n')}`).join('\n\n');
}

export function validateSavedLedger(delta) {
    if (!delta || !['people', 'events', 'states', 'tasks'].every(k => list(delta[k], 24))) return false;
    const sourceOK = r => r && list(r.sources) && r.sources.length && r.sources.every(n => Number.isInteger(n) && n > 0);
    const peopleOK = r => list(r.people, 12) && r.people.every(id => /^P\d+$/.test(id));
    const timeOK = r => r.time && typeof r.time.label === 'string' && r.time.label.length <= 160 && (r.time.label ? Number.isInteger(r.time.anchorSource) && r.time.anchorSource > 0 : r.time.anchorSource === null);
    return delta.people.every(r => sourceOK(r) && /^P\d+$/.test(r.id) && text(r.name, 120) && list(r.aliases) && r.aliases.every(a => text(a, 120))) &&
        delta.events.every(r => sourceOK(r) && /^E\d+$/.test(r.id) && text(r.text) && peopleOK(r) && timeOK(r) && ['explicit', 'inferred'].includes(r.certainty)) &&
        delta.states.every(r => sourceOK(r) && /^S\d+$/.test(r.id) && /^P\d+$/.test(r.subject) && /^E\d+$/.test(r.event) && text(r.key, 80) && text(r.value)) &&
        delta.tasks.every(r => sourceOK(r) && /^T\d+$/.test(r.id) && /^E\d+$/.test(r.event) && text(r.text) && peopleOK(r) && timeOK(r) && Object.hasOwn(progress, r.status));
}

export function invalidLedgerIndex(segments) {
    const current = emptyLedger(), anchors = new Set();
    for (const [index, segment] of segments.entries()) {
        if (!segment || !Array.isArray(segment.spans) || segment.spans.some(p => !p || !Number.isInteger(p.index) || p.index < 0)) return index;
        const allowed = new Set((segment.spans ?? []).map(p => p.index + 1));
        allowed.forEach(n => anchors.add(n));
        if (!segment.ledger) continue;
        const delta = segment.ledger;
        if (!validateSavedLedger(delta)) return index;
        for (const key of Object.keys(current)) {
            if (new Set(delta[key].map(r => r.id)).size !== delta[key].length) return index;
            if (delta[key].some(r => r.sources.some(n => !allowed.has(n)))) return index;
        }
        for (const p of delta.people) current.people[p.id] = p;
        const localEvents = new Map(delta.events.map(e => [e.id, e]));
        for (const e of delta.events) {
            if (current.events[e.id] || e.people.some(id => !current.people[id]) || (e.time.label && !anchors.has(e.time.anchorSource))) return index;
            current.events[e.id] = e;
        }
        for (const s of delta.states) {
            const event = localEvents.get(s.event), old = current.states[s.id];
            if (!current.people[s.subject] || !event || event.certainty !== 'explicit' || !s.sources.some(n => event.sources.includes(n)) ||
                (old && (old.subject !== s.subject || old.key !== s.key)) ||
                Object.values(current.states).some(r => r.id !== s.id && r.subject === s.subject && r.key === s.key)) return index;
            current.states[s.id] = s;
        }
        for (const t of delta.tasks) {
            const event = localEvents.get(t.event), old = current.tasks[t.id];
            if (t.people.some(id => !current.people[id]) || !event || event.certainty !== 'explicit' || !t.sources.some(n => event.sources.includes(n)) ||
                (t.time.label && !anchors.has(t.time.anchorSource)) ||
                (old && ['done', 'cancelled'].includes(old.status) && old.status !== t.status)) return index;
            current.tasks[t.id] = t;
        }
    }
    return segments.length;
}
