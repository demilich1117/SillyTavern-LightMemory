import { MODULE, DEFAULTS, normalizeSettings, segmentText } from './core.js';

// Design brief: an RP reader glances here between replies. The focal point is the history ribbon:
// remembered / waiting / recent, followed by a short status sentence. Use ST's paper/ink/muted
// palette, one restrained accent, inherited type, subtle borders and a 4px spacing grid.
const numericFields = [
    ['recentTokens', '近期上下文目标', 'tokens', '仅计算聊天内容，不含预设、角色卡、世界书和记忆。', 256, 2000000],
    ['minRounds', '至少保留完整回合', '轮', '一次用户输入及后续角色回复为一轮；空间不足时为软保护。', 1, 1000],
    ['memoryTokens', '记忆注入预算', 'tokens', '概览、固定记忆及召回内容共用此预算。', 128, 32000],
    ['triggerTokens', '待整理文本量阈值', 'tokens', '只计算近期窗口外尚未整理的清理后正文。', 128, 100000],
    ['triggerRounds', '待整理回合阈值', '轮', '文本量或回合数达到任一阈值，即开始一批整理。', 1, 1000],
    ['batchTarget', '单批摘要输入目标', 'tokens', '优先沿完整回合分批；过长内容按段落拆分。', 128, 100000],
    ['batchMax', '单批摘要输入上限', 'tokens', '实际批次还受摘要 API 上下文额度限制。', 256, 100000],
    ['recallLimit', '最多召回条数', '条', '相关记忆按预算择优；固定记忆优先，不静默截断。', 1, 50],
    ['summaryContext', '摘要 API 上下文额度', 'tokens', '指令、概览、输入正文和输出预留的总额度。', 2048, 2000000],
    ['summaryOutput', '摘要输出预留', 'tokens', '建议 2,048；JSON 被截断时本批不会保存。', 512, 16000],
    ['requestTimeout', '摘要／索引请求超时', '秒', '取消或超时不会提前省略原文。', 10, 600],
    ['vectorTimeout', '语义召回等待上限', '秒', '达到上限后，本次回复自动使用本地检索。', 1, 60],
    ['vectorChunkTokens', '向量块保守预算', 'tokens', '未知嵌入分词器按 UTF-8 字节上界估算，避免长正文尾部被截断。', 32, 512],
];

function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key in node && !key.startsWith('aria')) node[key] = value;
        else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
}

export function mountUI(host, engine) {
    document.getElementById('lightmemory-settings')?.remove();
    const root = el('section', { id: 'lightmemory-settings', class: 'lightmemory' });
    const drawer = el('div', { class: 'inline-drawer' });
    const toggle = el('div', { class: 'inline-drawer-toggle inline-drawer-header' });
    toggle.append(el('b', {}, '轻忆 · LightMemory'), el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }));
    const content = el('div', { class: 'inline-drawer-content lm-content' });
    drawer.append(toggle, content); root.append(drawer);
    (document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings')).append(root);

    const controls = new Map();
    const initial = host.settings();
    const statusBox = el('div', { class: 'lm-status', 'aria-live': 'polite' });
    const headline = el('div', { class: 'lm-headline' }, '让故事记得来路。');
    const message = el('p', { class: 'lm-message' }, '打开聊天后启用轻忆。');
    const ribbon = el('div', { class: 'lm-ribbon', role: 'img', 'aria-label': '记忆整理进度' });
    const remembered = el('span', { class: 'lm-ribbon-remembered' });
    const waiting = el('span', { class: 'lm-ribbon-waiting' });
    const recent = el('span', { class: 'lm-ribbon-recent' });
    ribbon.append(remembered, waiting, recent);
    const metrics = el('div', { class: 'lm-metrics' });
    const metricNodes = ['记忆批次', '待整理', '近期保留'].map(label => {
        const box = el('div'); const value = el('strong', {}, '—');
        box.append(value, el('span', {}, label)); metrics.append(box); return value;
    });
    const detail = el('p', { class: 'lm-help lm-tabular' });
    const error = el('p', { class: 'lm-notice lm-error', hidden: true, role: 'alert' });
    const warning = el('p', { class: 'lm-notice', hidden: true });
    statusBox.append(headline, message, ribbon, metrics, detail, error, warning);
    content.append(statusBox);

    function check(key, label, parent = content) {
        const row = el('label', { class: 'lm-check' });
        const input = el('input', { type: 'checkbox', id: `lm-${key}`, checked: initial[key] });
        row.append(input, el('span', {}, label)); parent.append(row); controls.set(key, input);
        input.addEventListener('change', save); return input;
    }
    const switches = el('div', { class: 'lm-switches' }); content.append(switches);
    check('enabled', '启用轻忆', switches); check('auto', '自动整理', switches);

    function section(title, open = false) {
        const node = el('details', { class: 'lm-section', open });
        node.append(el('summary', {}, title));
        const body = el('div', { class: 'lm-section-body' }); node.append(body); content.append(node); return body;
    }
    function field(key, label, input, help, parent) {
        input.id = `lm-${key}`;
        const row = el('div', { class: 'lm-field' });
        row.append(el('label', { htmlFor: input.id }, label), input);
        if (help) row.append(el('small', { class: 'lm-help' }, help));
        parent.append(row); controls.set(key, input);
        input.addEventListener('change', save); return input;
    }
    function number(key, parent) {
        const [, label, unit, help, min, max] = numericFields.find(f => f[0] === key);
        field(key, `${label} · ${unit}`, el('input', { type: 'number', class: 'text_pole', min, max, step: 1, value: initial[key] }), help, parent);
    }
    function select(key, label, choices, help, parent) {
        const input = el('select', { class: 'text_pole' });
        for (const [value, text] of choices) input.append(el('option', { value }, text));
        input.value = initial[key]; return field(key, label, input, help, parent);
    }
    function textField(key, label, help, parent, placeholder = '') {
        return field(key, label, el('input', { type: 'text', class: 'text_pole', value: initial[key], placeholder, autocomplete: 'off' }), help, parent);
    }
    function button(label, action, parent = content, className = '') {
        const node = el('button', { type: 'button', class: `menu_button lm-button ${className}` }, label);
        node.addEventListener('click', async () => {
            node.disabled = true;
            try { await action(); } catch (e) { engine.fail(e); }
            finally { node.disabled = false; }
        });
        parent.append(node); return node;
    }

    const common = section('上下文预算', true);
    for (const key of ['recentTokens', 'minRounds', 'memoryTokens']) number(key, common);

    const api = section('摘要 API');
    select('apiMode', '摘要连接', [['main', '沿用酒馆主 API'], ['custom', '独立 OpenAI 兼容 API']], '摘要只发送整理指令和采集正文，不使用角色扮演提示词。', api);
    const custom = el('div', { class: 'lm-custom' }); api.append(custom);
    textField('customUrl', 'Base URL', '通常以 /v1 结尾，不填写 /chat/completions。', custom, 'https://example.com/v1');
    textField('customModel', '模型名称', '', custom, '服务商提供的模型 ID');
    const secret = select('secretId', '酒馆密钥', [['', '选择 Custom（OpenAI-compatible）密钥']], '在酒馆密钥管理器中新增或管理；轻忆只保存所选 ID，不保存密钥正文。', custom);
    async function refreshSecrets() {
        const selected = host.settings().secretId;
        const options = await host.secretOptions();
        secret.replaceChildren(el('option', { value: '' }, '请选择密钥'));
        for (const option of options) secret.append(el('option', { value: option.id }, option.label));
        if (selected && !options.some(o => o.id === selected)) secret.append(el('option', { value: selected }, '之前选择的密钥已不可用'));
        secret.value = selected;
    }
    button('刷新密钥列表', refreshSecrets, custom);
    button('测试摘要连接', async () => { engine.emit({ message: '正在使用简短测试文本检查摘要 API…', error: '' }); engine.emit({ message: await engine.testApi() }); }, api);

    const retrieval = section('记忆召回');
    select('recallMode', '召回方式', [['keyword', '本地关键词'], ['semantic', '语义向量 + 关键词']], '语义服务超时会退回本地检索，继续正常回复。', retrieval);
    const semantic = el('div'); retrieval.append(semantic);
    select('vectorSource', '向量来源', [['transformers', '酒馆本地 Transformers'], ['openai', 'OpenAI'], ['siliconflow', '硅基流动'], ['ollama', 'Ollama']], '复用酒馆服务端和已有密钥；本地来源首次可能需要下载模型。', semantic);
    textField('vectorModel', '嵌入模型', '本地 Transformers 使用 config.yaml 的模型；OpenAI / 硅基流动留空使用默认模型；Ollama 必填。', semantic);
    textField('vectorUrl', 'Ollama 地址', '其他来源不使用此地址。', semantic, 'http://127.0.0.1:11434');
    select('siliconflowEndpoint', '硅基流动端点', [['cn', '中国站'], ['com', '国际站']], '', semantic);
    const vectorButtons = el('div', { class: 'lm-actions' }); semantic.append(vectorButtons);
    button('测试向量连接', async () => { engine.emit({ message: '正在测试向量写入与召回…', error: '' }); engine.emit({ message: await engine.vectors.test(host.settings()) }); }, vectorButtons);
    button('重建向量索引', () => engine.rebuildVectors(), vectorButtons);

    const advanced = section('高级设置');
    for (const [key] of numericFields.slice(3)) number(key, advanced);
    button('恢复参数默认值', () => {
        const next = { ...host.settings() };
        for (const [key] of numericFields) next[key] = DEFAULTS[key];
        host.saveSettings(next); syncControls(); engine.host.inject(''); engine.scheduleRefresh();
    }, advanced);

    const actions = el('div', { class: 'lm-actions' }); content.append(actions);
    button('整理历史', () => engine.run(true), actions, 'lm-primary');
    const pauseButton = button('暂停整理', () => engine.pause(!engine.status.state?.paused), actions);
    button('查看记忆', () => showMemories(), actions);
    button('采集预览', () => showSources(), actions);
    button('上次注入', () => showText('上次注入', engine.status.trace?.text || '尚无记忆注入。'), actions);
    const backups = section('备份与重建');
    button('导出记忆', async () => {
        const data = await engine.export();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = el('a', { href: url, download: `lightmemory-${new Date().toISOString().slice(0, 10)}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, backups);
    const upload = el('input', { type: 'file', accept: '.json,application/json', hidden: true }); backups.append(upload);
    button('导入匹配本聊天的记忆', () => upload.click(), backups);
    upload.addEventListener('change', async () => {
        try {
            const file = upload.files?.[0]; if (!file) return;
            if (file.size > 20 * 1024 * 1024) throw new Error('导入文件超过 20 MB。');
            const data = JSON.parse(await file.text());
            if (await confirm('导入会替换当前聊天的轻忆记忆。聊天原文不变，建议先导出当前记忆。')) await engine.import(data);
        } catch (e) { engine.fail(e); } finally { upload.value = ''; }
    });
    button('从正文重建全部记忆', async () => {
        if (await confirm('这会清除轻忆生成的记忆及手动修改，再从清理后的正文整理。聊天原文不变；建议先导出记忆。')) await engine.rebuild();
    }, backups);

    content.append(el('p', { class: 'lm-footer' }, '轻忆 0.1.0 · 原文保留，记忆可追溯'));

    async function confirm(text) {
        const ctx = host.context();
        const node = el('p', {}, text);
        return Boolean(await ctx.callGenericPopup(node, ctx.POPUP_TYPE.CONFIRM, ''));
    }
    async function showText(title, text) {
        const body = el('div', { class: 'lightmemory lm-dialog' });
        body.append(el('h3', {}, title), el('pre', { class: 'lm-source' }, text));
        return host.context().callGenericPopup(body, host.context().POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    }
    async function showSources(indices = null) {
        const snapshot = await host.capture();
        const records = indices ? snapshot.records.filter(r => indices.includes(r.index)) : snapshot.records;
        return showText('实际采集正文', records.map(r => `第 ${r.index + 1} 楼 · ${r.name}${r.protected ? '（含附件或工具数据，保护不压缩）' : ''}\n${r.text || '（清理后为空）'}`).join('\n\n────────\n\n'));
    }
    async function showMemories() {
        const view = await engine.inspect();
        const body = el('div', { class: 'lightmemory lm-dialog' });
        body.append(el('h3', {}, `记忆档案 · ${view.state.segments.length} 批`));
        if (!view.state.segments.length) body.append(el('p', { class: 'lm-help' }, '尚未整理出记忆。近期窗口外内容达到阈值后会自动开始，也可以点击“整理历史”。'));
        for (const s of [...view.state.segments].reverse()) {
            const item = el('details', { class: 'lm-memory', open: false });
            const indices = s.spans.map(p => p.index + 1);
            item.append(el('summary', {}, `第 ${Math.min(...indices)}–${Math.max(...indices)} 楼${s.pinned ? ' · 固定' : ''}${s.excluded ? ' · 已排除' : ''}`));
            const text = el('textarea', { class: 'text_pole lm-memory-text', value: segmentText(s), rows: 7, 'aria-label': '记忆正文' });
            item.append(text);
            const buttons = el('div', { class: 'lm-actions' }); item.append(buttons);
            button('保存修改', async () => { await engine.updateSegment(s.id, { overrideText: text.value }); engine.emit({ message: '记忆修改已保存；依赖旧文本的概览已停用。' }); }, buttons);
            const pinned = el('input', { type: 'checkbox', checked: s.pinned });
            const pinLabel = el('label', { class: 'lm-check' }); pinLabel.append(pinned, el('span', {}, '固定')); buttons.append(pinLabel);
            pinned.addEventListener('change', () => engine.updateSegment(s.id, { pinned: pinned.checked }).catch(e => engine.fail(e)));
            const excluded = el('input', { type: 'checkbox', checked: s.excluded });
            const exLabel = el('label', { class: 'lm-check' }); exLabel.append(excluded, el('span', {}, '排除')); buttons.append(exLabel);
            excluded.addEventListener('change', () => engine.updateSegment(s.id, { excluded: excluded.checked }).catch(e => engine.fail(e)));
            button('查看来源', () => showSources(s.spans.map(p => p.index)), buttons);
            body.append(item);
        }
        await host.context().callGenericPopup(body, host.context().POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    }

    function syncControls() {
        const settings = host.settings();
        for (const [key, input] of controls) {
            if (input.type === 'checkbox') input.checked = settings[key]; else input.value = settings[key];
        }
        custom.hidden = settings.apiMode !== 'custom';
        semantic.hidden = settings.recallMode !== 'semantic';
    }
    function save() {
        const settings = { ...host.settings() };
        for (const [key, input] of controls) {
            if (input.type === 'number' && !input.checkValidity()) { input.reportValidity(); return; }
            settings[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        }
        host.saveSettings(normalizeSettings(settings));
        syncControls();
        if (!settings.enabled) engine.cancel('轻忆已关闭。');
        else { host.inject(''); engine.scheduleRefresh(); }
        if (settings.enabled && settings.auto) engine.schedule();
    }
    const unsubscribe = engine.subscribe(state => {
        message.textContent = state.message;
        statusBox.dataset.phase = state.phase;
        error.hidden = !state.error; error.textContent = state.error;
        const disabled = host.context().extensionSettings.disabledExtensions ?? [];
        const conflict = !disabled.includes('third-party/st-memory-enhancement') && Boolean(host.context().extensionSettings['memoryEnhancement'] ||
            Object.keys(host.context().extensionSettings).some(k => /memory.*enhance|st.memory|table.*memory/i.test(k)));
        const notice = [state.warning, conflict ? '检测到其他记忆功能，请避免同一聊天被两套自动记忆同时接管。' : ''].filter(Boolean).join('\n');
        warning.hidden = !notice; warning.textContent = notice;
        pauseButton.textContent = state.state?.paused ? '恢复整理' : '暂停整理';
        const m = state.metrics;
        metricNodes[0].textContent = m ? String(m.segments) : '—';
        metricNodes[1].textContent = m ? `${m.pendingRounds} 轮` : '—';
        metricNodes[2].textContent = m ? `${m.recentRounds} 轮` : '—';
        detail.textContent = m ? `近期 ${m.recentTokens.toLocaleString()} / 目标 ${Math.round(m.target).toLocaleString()} tokens · 待整理 ${m.pendingTokens.toLocaleString()}${m.batchMax !== null ? ` · 本批上限 ${m.batchMax.toLocaleString()}` : ''}\n角色卡／世界书等预留为估算，酒馆执行最终上下文限制。` : '原文不会被轻忆删除。';
        const total = Math.max(1, m?.totalRounds ?? 1);
        const pending = m?.pendingRounds ?? 0, latest = m?.recentRounds ?? 0;
        remembered.style.flex = String(Math.max(0, total - pending - latest));
        waiting.style.flex = String(pending); recent.style.flex = String(latest || 1);
        ribbon.setAttribute('aria-label', m ? `近期 ${latest} 轮，待整理 ${pending} 轮，已有 ${m.segments} 批记忆` : '尚未读取聊天');
    });
    syncControls();
    refreshSecrets().catch(() => {});
    return { root, syncControls, destroy: () => { unsubscribe(); root.remove(); } };
}
