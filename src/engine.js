import { MODULE, newId, emptyState, readState, reconcileState, buildRounds, chooseWindow,
    pendingWork, shouldSummarize, planBatch, parseSummary, compressionPlan, rankMemories,
    buildInjection, prefixWithin, fingerprint, safeExport, importState } from './core.js';
import { boundedRequest, summaryMessages } from './network.js';
import { ledgerContext, replayLedger } from './ledger.js';

export class MemoryEngine {
    constructor(host, vectors) {
        this.host = host;
        this.vectors = vectors;
        this.listeners = new Set();
        this.confirmed = new Set();
        this.controller = null;
        this.job = null;
        this.timer = null;
        this.serial = 0;
        this.idleWaiters = new Set();
        this.status = { phase: 'idle', message: '打开聊天后启用轻忆。', error: '', warning: '', trace: null, metrics: null, snapshot: null, state: null };
    }

    subscribe(listener) { this.listeners.add(listener); listener(this.status); return () => this.listeners.delete(listener); }
    emit(patch) { Object.assign(this.status, patch); for (const listener of this.listeners) listener(this.status); }
    fail(error) {
        if (error?.name === 'AbortError') return;
        this.emit({ error: error?.name === 'TimeoutError' ? '请求超时，已保留原上下文；可稍后重试。' : String(error?.message ?? error), phase: 'error' });
    }
    cancel(message = '任务已暂停。') {
        clearTimeout(this.timer);
        this.serial++;
        this.controller?.abort(new DOMException(message, 'AbortError'));
        this.host.inject('');
        if (this.job) this.emit({ phase: 'paused', message });
    }
    generationStarted() {
        if (!this.host.settings().backgroundDuringChat) this.cancel('正在生成角色回复，暂停后台整理。');
        else { this.serial++; this.host.inject(''); }
        this.emit({});
    }
    generationEnded() {
        this.emit({});
        for (const check of this.idleWaiters) check();
        if (!this.job) { this.scheduleRefresh(); this.schedule(); }
    }
    stopBackground(message = '已停止本次后台整理；自动整理仍按开关执行。') {
        clearTimeout(this.timer);
        this.controller?.abort(new DOMException(message, 'AbortError'));
        // A foreground prompt may already have dropped covered messages. Keep its injection.
        this.emit({ phase: 'paused', message });
    }
    async waitForIdle(signal) {
        signal.throwIfAborted();
        if (!this.host.isGenerating()) return;
        this.emit({ phase: 'waiting', message: '摘要任务等待角色回复结束后核对并保存；聊天继续正常使用已确认的记忆。' });
        await new Promise((resolve, reject) => {
            let interval, timeout;
            const clean = () => { clearInterval(interval); clearTimeout(timeout); this.idleWaiters.delete(check); signal.removeEventListener('abort', abort); };
            const check = () => { if (!this.host.isGenerating()) { clean(); resolve(); } };
            const abort = () => { clean(); reject(signal.reason); };
            this.idleWaiters.add(check); signal.addEventListener('abort', abort, { once: true });
            // ST can emit per-character completion before the group-generation flag resets.
            // Events are primary; bounded polling covers that missing whole-group-idle event.
            interval = setInterval(check, 250);
            timeout = setTimeout(() => { clean(); reject(new Error('等待聊天空闲超过 10 分钟，已停止任务并保留原文。')); }, 600000);
            if (signal.aborted) abort(); else check();
        });
    }
    changed() {
        this.cancel('聊天或配置上下文已改变。');
        this.emit({ trace: null, metrics: null, snapshot: null, state: null, error: '', warning: '', startedAt: null, completedBatches: 0, phase: 'idle' });
        this.scheduleRefresh();
    }
    scheduleRefresh() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            if (!this.host.isGenerating()) this.refresh().catch(e => this.fail(e));
        }, 250);
    }
    schedule() {
        clearTimeout(this.timer);
        if (!this.host.settings().enabled || !this.host.settings().auto) return;
        this.timer = setTimeout(() => {
            if (!this.host.isGenerating()) this.run(false).catch(e => this.fail(e));
        }, 600);
    }

    async inspect(coreChat = null, type = 'normal', maxPrompt = this.host.maxPromptTokens()) {
        const settings = this.host.settings();
        const snapshot = await this.host.capture(coreChat, type);
        const original = readState(snapshot.state, snapshot.owner);
        const reconciled = reconcileState(original, snapshot.records, snapshot.owner);
        const state = reconciled.state;
        const rounds = buildRounds(snapshot.records);
        const allowance = await this.host.availableHistory(settings, maxPrompt);
        const window = chooseWindow(rounds, settings, allowance.available);
        const work = await pendingWork(rounds, window, state.segments, this.host.count);
        const plan = compressionPlan(rounds, window, state, snapshot.records);
        const metrics = { totalRounds: rounds.length, recentRounds: window.rounds, recentTokens: window.tokens,
            target: window.target, pendingTokens: work.tokens, pendingRounds: work.roundCount,
            segments: state.segments.length, coveredMessages: plan.removed.size,
            allowance, conflict: window.conflict, batchMax: null };
        this.host.assertSnapshot(snapshot);
        return { settings, snapshot, state, reconciled, rounds, window, work, plan, metrics };
    }

    async refresh() {
        if (this.host.isGenerating()) return;
        if (!this.host.identity()) { this.emit({ metrics: null, snapshot: null, state: null, message: '请打开角色聊天或群聊。', phase: 'idle' }); return; }
        const data = await this.inspect();
        this.publish(data);
        if (!this.job) this.emit({ phase: data.state.paused ? 'paused' : 'idle', message: data.settings.enabled ? '准备就绪。' : '轻忆未启用，聊天输入保持正常。' });
        return data;
    }

    publish(data) {
        this.emit({ metrics: data.metrics, snapshot: data.snapshot, state: data.state,
            warning: data.reconciled.invalidated ? `${data.reconciled.invalidated} 批记忆的来源已改变，受影响原文恢复保留。` :
                data.window.conflict ? '上下文空间不足以满足最低回合保护；最终输入仍由酒馆裁剪。' : '' });
    }

    async confirm(snapshot, signal) {
        if (!snapshot.state) return;
        const key = `${snapshot.owner}:${snapshot.state.revision}:${fingerprint(snapshot.state)}`;
        if (this.confirmed.has(key)) return;
        const saved = await boundedRequest(s => this.host.remoteState(snapshot, s), { seconds: 12, signal });
        this.host.assertSnapshot(snapshot);
        if (fingerprint(saved) !== fingerprint(snapshot.state)) throw new Error('当前记忆尚未通过服务端读回确认；保留原文，请重新加载聊天。');
        if (this.confirmed.size > 100) this.confirmed.clear();
        this.confirmed.add(key);
    }

    async save(data, next, signal) {
        this.host.assertSnapshot(data.snapshot);
        const state = { ...next, revision: newId() };
        const saved = await boundedRequest(s => this.host.persist(data.snapshot, state, data.snapshot.state?.revision ?? null, s), { seconds: 30, signal });
        this.confirmed.add(`${data.snapshot.owner}:${saved.revision}:${fingerprint(saved)}`);
        return saved;
    }

    async intercept(coreChat, maxPrompt, type) {
        this.host.inject('');
        if (!this.host.settings().enabled || ![undefined, '', 'normal', 'swipe', 'regenerate', 'continue'].includes(type)) return;
        if (!this.host.settings().backgroundDuringChat) this.controller?.abort(new DOMException('正在生成回复，暂停后台整理。', 'AbortError'));
        const serial = ++this.serial;
        try {
            const data = await this.inspect(coreChat, type, maxPrompt);
            this.publish(data);
            await this.confirm(data.snapshot);
            const clean = data.snapshot.records.filter(r => !r.protected);
            const latestUser = clean.findLast(r => r.isUser)?.text ?? '';
            const contextText = clean.slice(-4).map(r => `${r.name}: ${r.text}`).join('\n');
            let query = `${latestUser}\n${contextText}`;
            for (const person of Object.values(replayLedger(data.state.segments).people)) {
                if ([person.name, ...person.aliases].some(name => name.length > 1 && query.includes(name))) query += `\n${person.id} ${person.name}`;
            }
            let vectorIds = [], fallback = '';
            if (data.settings.recallMode === 'semantic' && data.plan.eligible.length) {
                try {
                    vectorIds = await this.vectors.query(data.state, data.snapshot.records, data.settings, query, new Set(data.plan.eligible.map(s => s.id)));
                    if (!vectorIds.length) fallback = '语义索引暂无相关结果，使用本地检索。';
                } catch (error) { fallback = '向量服务不可用或超时，本次使用本地检索。'; }
            }
            const ranked = rankMemories(data.plan.eligible, query, vectorIds);
            const injection = await buildInjection(data.plan, ranked, data.settings, this.host.count, query);
            this.host.assertSnapshot(data.snapshot);
            if (serial !== this.serial || !this.host.settings().enabled) return;
            // Only filter ST's prompt array. Never edit messages, nested extra objects, or persisted swipes.
            const mapped = new Map(data.snapshot.records.map(r => [r.hostIndex, r]));
            const removed = injection.text ? data.plan.removed : new Set();
            const retained = coreChat.filter(m => {
                const r = mapped.get(m.index);
                return !r || r.name !== m.name || r.isUser !== Boolean(m.is_user) || !removed.has(r.index);
            });
            const retainedTokens = await this.host.count(retained.map(m => m.mes ?? '').join('\n')) + retained.length * 4;
            this.host.assertSnapshot(data.snapshot);
            if (serial !== this.serial || !this.host.settings().enabled) return;
            this.host.inject(injection.text);
            coreChat.splice(0, coreChat.length, ...retained);
            this.emit({ error: '', warning: fallback || this.status.warning, trace: { owner: data.snapshot.owner, at: new Date().toISOString(),
                text: injection.text, selected: injection.selected, tokens: injection.tokens, retainedTokens,
                removedMessages: data.snapshot.records.filter(r => removed.has(r.index)).map(r => r.index + 1),
                retainedMessages: retained.length, mode: data.settings.recallMode, fallback } });
        } catch (error) {
            if (serial === this.serial) { this.host.inject(''); this.fail(error); }
        }
    }

    async observePrompt(event, kind = 'chat') {
        if (event?.dryRun || !this.status.trace || this.status.trace.owner !== this.host.identity()) return;
        const text = kind === 'chat' ? (event.chat ?? []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n') : String(event.prompt ?? '');
        try { await this.host.observePrompt(text, this.status.trace.retainedTokens, this.status.trace.tokens); } catch { /* Next request keeps the conservative estimate. */ }
    }

    async run(force = false) {
        if (this.job) return this.job;
        if (!this.host.settings().enabled) throw new Error('请先启用轻忆。');
        if (this.host.isGenerating()) throw new Error('角色正在回复，请在回复结束后整理。');
        const owner = this.host.identity();
        if (!owner) throw new Error('请先打开聊天。');
        const controller = new AbortController();
        this.controller = controller;
        const execute = async () => {
            try { await this.process(force, controller.signal); }
            catch (error) {
                if (this.host.identity() !== owner) return;
                if (error?.name === 'AbortError') this.emit({ phase: 'paused', message: '后台任务已停止，已保存的记忆仍然有效。' });
                else this.fail(error);
            } finally { if (this.controller === controller) this.controller = null; }
        };
        const locks = globalThis.navigator?.locks;
        this.job = (locks ? locks.request(`lightmemory:${owner}`, { ifAvailable: true }, async lock => {
            if (!lock) { this.emit({ phase: 'paused', message: '另一页签正在整理这个聊天。' }); return; }
            return execute();
        }) : execute()).finally(() => { this.job = null; });
        return this.job;
    }

    async process(force, signal) {
        this.emit({ error: '', phase: 'preparing', message: '正在核对正文、来源和预算…', startedAt: Date.now(), completedBatches: 0 });
        let batches = 0;
        let last = null;
        while (true) {
            signal.throwIfAborted();
            await this.waitForIdle(signal);
            let data = await this.inspect();
            if (!data.settings.enabled || (!force && (!data.settings.auto || data.state.paused))) break;
            this.publish(data);
            await this.confirm(data.snapshot, signal);
            if (data.reconciled.changed || (force && data.state.paused)) {
                await this.save(data, { ...data.state, paused: force ? false : data.state.paused }, signal);
                continue;
            }
            last = data;
            if (!shouldSummarize(data.work, data.settings, force)) break;
            const api = await this.host.prepareApi(data.settings);
            const overview = data.state.segments.at(-1)?.overview ?? '';
            const registry = ledgerContext(data.state.segments);
            const envelope = summaryMessages(overview, '', registry);
            const overhead = await api.count(envelope.map(m => m.content).join('\n')) + 64;
            const effectiveMax = Math.min(data.settings.batchMax, api.limit - api.output - overhead - Math.max(256, Math.ceil(api.limit * 0.08)));
            const batch = await planBatch(data.work, data.settings, effectiveMax, api.count);
            const messages = summaryMessages(overview, batch.text, registry);
            if (await api.count(messages.map(m => m.content).join('\n')) + api.output + 64 > api.limit) throw new Error('摘要请求超出预算；已保留原文。');
            this.host.assertSnapshot(data.snapshot);
            this.emit({ phase: 'summarizing', message: `正在整理第 ${Math.min(...batch.spans.map(s => s.index)) + 1}–${Math.max(...batch.spans.map(s => s.index)) + 1} 楼…`,
                metrics: { ...data.metrics, batchMax: effectiveMax, batchTokens: batch.tokens, tokenizerEstimated: api.tokenizerEstimated } });
            const raw = await boundedRequest(s => api.send(messages, s), { seconds: data.settings.requestTimeout, retries: 1, signal });
            signal.throwIfAborted();
            const segment = parseSummary(raw, batch, data.state.segments);
            await this.waitForIdle(signal);
            const fresh = await this.inspect();
            signal.throwIfAborted();
            // Appended turns are allowed. Existing memory and every source used by this batch
            // must still match, including regex depth effects and selected swipes.
            const current = new Map(fresh.snapshot.records.map(r => [r.index, r]));
            if (fresh.snapshot.owner !== data.snapshot.owner || !fresh.settings.enabled ||
                fingerprint(fresh.snapshot.state) !== fingerprint(data.snapshot.state) || fresh.reconciled.changed ||
                batch.spans.some(span => { const r = current.get(span.index); return !r || r.rawHash !== span.rawHash || r.cleanHash !== span.cleanHash || r.protected; })) {
                throw new Error('摘要期间来源、清理结果或记忆已改变；本批结果已丢弃，原文继续保留。');
            }
            if (this.host.isGenerating()) throw new DOMException('核对时开始新的角色回复，未保存本批。', 'AbortError');
            data = fresh;
            const next = { ...data.state, segments: [...data.state.segments, segment] };
            this.emit({ phase: 'saving', message: '正在保存并读回确认…' });
            await this.save(data, next, signal);
            batches++;
            this.emit({ completedBatches: batches });
            // Yield between completed transactions, allowing edits, generation and pause to take priority.
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (last && last.settings.recallMode === 'semantic' && last.state.segments.length) {
            try {
                this.emit({ phase: 'indexing', message: '正在补齐可重建的向量索引…' });
                await this.vectors.sync(last.state, last.snapshot.records, last.settings, signal, (done, total) => {
                    this.emit({ message: `正在建立向量索引 ${done} / ${total}`, vectorProgress: { done, total } });
                });
            } catch (error) {
                if (signal.aborted) throw error;
                this.emit({ warning: '记忆已保存；向量索引暂未完成，关键词召回仍可用。' });
            }
        }
        await this.refresh();
        this.emit({ phase: 'idle', message: batches ? `已完成 ${batches} 批整理。` : '待整理内容尚未达到条件，近期正文继续保留。' });
    }

    async editState(transform) {
        this.cancel('正在修改记忆。');
        if (this.job) await this.job;
        if (this.host.isGenerating()) throw new Error('请在角色回复结束后修改记忆。');
        const data = await this.inspect();
        await this.confirm(data.snapshot);
        await this.save(data, await transform(structuredClone(data.state), data));
        this.host.inject('');
        this.vectors.clearCache();
        await this.refresh();
    }

    async pause(paused = true) {
        await this.editState(state => ({ ...state, paused }));
        this.emit({ phase: paused ? 'paused' : 'idle', message: paused ? '自动整理已暂停；已有记忆仍参与召回。' : '自动整理已恢复。' });
        if (!paused) this.schedule();
    }
    async rebuild() {
        await this.editState((state, data) => emptyState(data.snapshot.owner));
        return this.run(true);
    }
    async rebuildVectors() {
        await this.editState(state => ({ ...state, vectorEpoch: newId() }));
        return this.run(false);
    }
    async updateSegment(id, patch) {
        await this.editState(state => {
            const segment = state.segments.find(s => s.id === id);
            if (!segment) throw new Error('这条记忆的来源已变化，请刷新列表。');
            if ('overrideText' in patch) {
                const value = String(patch.overrideText).trim();
                if (!value || value.length > 20000) throw new Error('记忆正文应为 1–20,000 个字符。');
                segment.overrideText = value;
            }
            for (const key of ['pinned', 'excluded']) if (key in patch) segment[key] = Boolean(patch[key]);
            return state;
        });
    }
    async export() { const data = await this.inspect(); return safeExport(data.state); }
    async import(data) { await this.editState((_, view) => importState(data, view.snapshot.records, view.snapshot.owner)); }
    async testApi() {
        const settings = this.host.settings();
        const api = await this.host.prepareApi(settings);
        const batch = { spans: [{ index: 0, from: 0, to: 20, rawHash: 'test', cleanHash: 'test' }] };
        const raw = await boundedRequest(s => api.send(summaryMessages('', '[楼层 1 | 角色 旅人]\n旅人将银色钥匙交给旅店老板保管，并约定次日取回。'), s), { seconds: settings.requestTimeout });
        parseSummary(raw, batch);
        return '连接、摘要结构与来源校验通过。';
    }
    destroy() { this.cancel('轻忆已关闭。'); this.listeners.clear(); }
}
