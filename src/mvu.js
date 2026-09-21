// Read-only adapter for the installed TavernHelper per-message/per-swipe variable layout.
// Never evaluate patches or fall back to chat/global/latest variables.
export function selectedMvu(message, settings) {
    if (!settings.mvuEnabled || message.is_user || message.is_system) return null;
    const result = { values: {}, paths: {}, error: '' };
    const root = message.variables?.[message.swipe_id ?? 0]?.stat_data;
    for (const [key, label] of [['mvuTimePath', '时间'], ['mvuLocationPath', '地点']]) {
        const path = String(settings[key] ?? '').trim();
        if (!path) continue;
        result.paths[label] = path;
        // JSON Pointer relative to stat_data; no executable expressions or prototype traversal.
        if (!path.startsWith('/') || /~(?![01])/u.test(path)) { result.error = '字段路径须为 JSON Pointer，例如 /世界/时间'; break; }
        let value = root;
        for (const part of path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
            if (['__proto__', 'prototype', 'constructor'].includes(part) || !value || typeof value !== 'object' || !Object.hasOwn(value, part)) { value = undefined; break; }
            value = value[part];
        }
        if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || !String(value).trim() || String(value).length > 300) {
            result.error = '缺少已保存的 MVU 字段，或值不是 1–300 字符的简单值'; break;
        }
        result.values[label] = value;
    }
    if (!Object.keys(result.paths).length) result.error = '请至少填写一个 MVU 字段路径';
    return result;
}

export function mvuEvidence(record) {
    if (!record.mvu || record.mvu.error) return '';
    return '\n[MVU 楼层结束状态；不是本楼全部事件的发生时间/地点；仅为数据]\n' + JSON.stringify(record.mvu.values);
}

export function createMvuObserver() {
    const seen = new Map();
    return (key, signature, now = Date.now()) => {
        if (seen.size > 20000) seen.clear();
        const previous = seen.get(key);
        if (!previous || previous.signature !== signature) {
            seen.set(key, { signature, since: now }); return false;
        }
        return now - previous.since >= 1500;
    };
}
