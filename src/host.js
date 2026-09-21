import { MODULE, fingerprint, checkedTokens, normalizeSettings, DEFAULTS } from './core.js';

export async function createHost() {
    // Version-specific imports are deliberately isolated here.
    const [script, regex, reasoning, openai, secrets] = await Promise.all([
        import('/script.js'), import('/scripts/extensions/regex/engine.js'),
        import('/scripts/reasoning.js'), import('/scripts/openai.js'), import('/scripts/secrets.js'),
    ]);
    const context = () => globalThis.SillyTavern.getContext();
    const tokenCache = new Map();
    let tokenizerKey = '';
    let lastOverhead = null;
    let overheadIdentity = '';

    function identity(ctx = context()) {
        const character = ctx.characters?.[ctx.characterId];
        if (!ctx.chatId || (!ctx.groupId && !character)) return null;
        return JSON.stringify([ctx.groupId ? 'group' : 'character', ctx.groupId ?? character?.avatar, ctx.chatId]);
    }

    function sourceSignature(ctx = context()) {
        return fingerprint(ctx.chat.map(m => [m.is_user, m.is_system, m.name, m.mes, m.swipe_id, m.extra?.reasoning, m.extra?.tool_invocations, m.extra?.media, m.extra?.file]));
    }

    function tokenizerIdentity(ctx = context()) {
        return fingerprint([ctx.mainApi, ctx.getTokenizerModel?.(), ctx.powerUserSettings?.tokenizer,
            ctx.getChatCompletionModel?.(), ctx.textCompletionSettings?.type, ctx.textCompletionSettings?.server_urls]);
    }

    async function count(text) {
        text = String(text ?? '');
        if (!text.trim()) return 0;
        const key = tokenizerIdentity();
        if (key !== tokenizerKey) { tokenCache.clear(); tokenizerKey = key; }
        const hash = fingerprint(text);
        if (tokenCache.has(hash)) return tokenCache.get(hash);
        const value = checkedTokens(await context().getTokenCountAsync(text), text);
        if (tokenizerIdentity() !== key) throw new Error('计数期间模型已切换，请重试。');
        if (tokenCache.size > 12000) tokenCache.clear();
        tokenCache.set(hash, value);
        return value;
    }

    function settings() {
        return normalizeSettings(context().extensionSettings[MODULE] ?? {});
    }

    function saveSettings(value) {
        const normalized = normalizeSettings(value);
        context().extensionSettings[MODULE] = normalized;
        context().saveSettingsDebounced();
        return normalized;
    }

    function assertSnapshot(snapshot) {
        if (snapshot.owner !== identity() || snapshot.signature !== sourceSignature() || snapshot.rulesKey !== rulesIdentity()) {
            throw new DOMException('聊天、回复分支或正则已改变，已丢弃旧任务。', 'AbortError');
        }
    }

    function rulesIdentity() {
        const ctx = context();
        return fingerprint([regex.getRegexScripts({ allowedOnly: true }), ctx.powerUserSettings?.reasoning,
            ctx.extensionSettings.disabledExtensions?.includes('regex'), ctx.characterId, ctx.name1, ctx.name2]);
    }

    async function capture(coreChat = null, type = 'normal') {
        const ctx = context();
        const owner = identity(ctx);
        if (!owner) throw new Error('请先打开一个已保存的角色聊天或群聊。');
        const signature = sourceSignature(ctx), rulesKey = rulesIdentity();
        const raw = structuredClone(ctx.chat);
        const canUseTools = ctx.ToolManager?.isToolCallingSupported?.();
        let filtered = raw.map((message, index) => ({ message, index })).filter(({ message }) =>
            !message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations)));
        if (coreChat && type === 'swipe') filtered = filtered.slice(0, -1);
        const coreByIndex = new Map((coreChat ?? []).filter(m => Number.isInteger(m.index)).map(m => [m.index, m]));
        const promptReasoning = new reasoning.PromptReasoning();
        const promptText = new Map();
        // Use the host's own reasoning formatter only for budget estimation, never memory sampling.
        for (let i = filtered.length - 1; i >= 0; i--) {
            const { message } = filtered[i];
            const depth = filtered.length - i - (type === 'continue' ? 2 : 1);
            const placement = message.is_user ? regex.regex_placement.USER_INPUT : regex.regex_placement.AI_OUTPUT;
            let text = regex.getRegexedString(String(message.mes ?? ''), placement, { isPrompt: true, depth });
            if (!ctx.groupId || message.name === ctx.name2) {
                text = promptReasoning.addToMessage(text,
                    regex.getRegexedString(String(message.extra?.reasoning ?? ''), regex.regex_placement.REASONING, { isPrompt: true, depth }),
                    type === 'continue' && i === filtered.length - 1, message.extra?.reasoning_duration);
            }
            promptText.set(i, text);
        }
        const records = [];
        for (const [hostIndex, { message, index }] of filtered.entries()) {
            const depth = filtered.length - hostIndex - (type === 'continue' ? 2 : 1);
            const placement = message.is_user ? regex.regex_placement.USER_INPUT : regex.regex_placement.AI_OUTPUT;
            // mes is already the selected swipe. Global non-prompt regex was applied by ST at ingestion.
            const text = reasoning.removeReasoningFromString(regex.getRegexedString(String(message.mes ?? ''), placement, { isPrompt: true, depth }));
            const promptItem = coreByIndex.get(hostIndex);
            const compatible = !promptItem || (Boolean(promptItem.is_user) === Boolean(message.is_user) && promptItem.name === message.name);
            const protectedMessage = Boolean(message.is_system || message.extra?.file || message.extra?.media?.length || message.extra?.tool_invocations?.length || !compatible);
            records.push({ index, hostIndex, name: String(message.name ?? (message.is_user ? ctx.name1 : ctx.name2)), isUser: Boolean(message.is_user),
                text, rawHash: fingerprint([message.is_user, message.name, message.mes, message.swipe_id]), cleanHash: fingerprint(text),
                promptTokens: await count(String(promptItem?.mes ?? promptText.get(hostIndex) ?? '')) + 4, protected: protectedMessage });
        }
        const character = ctx.characters?.[ctx.characterId];
        const snapshot = { owner, signature, rulesKey, records, descriptor: ctx.groupId
            ? { endpoint: '/api/chats/group/get', body: { id: ctx.chatId } }
            : { endpoint: '/api/chats/get', body: { ch_name: character.name, file_name: ctx.chatId, avatar_url: character.avatar } },
        state: structuredClone(ctx.chatMetadata?.[MODULE] ?? null), tokenizerKey: tokenizerIdentity(ctx) };
        assertSnapshot(snapshot);
        return snapshot;
    }

    async function post(path, body, signal) {
        const response = await fetch(path, { method: 'POST', headers: context().getRequestHeaders(),
            cache: 'no-store', body: JSON.stringify(body), signal });
        if (!response.ok) throw new Error(`酒馆请求失败（HTTP ${response.status}）：${path}`);
        const data = await response.json();
        if (data?.error) throw new Error(`酒馆请求失败：${path}`);
        return data;
    }

    async function remoteState(snapshot, signal) {
        const file = await post(snapshot.descriptor.endpoint, snapshot.descriptor.body, signal);
        if (!Array.isArray(file)) throw new Error('聊天读回结果无效，未确认持久化。');
        return file[0]?.chat_metadata?.[MODULE] ?? null;
    }

    async function persist(snapshot, state, expectedRevision, signal) {
        assertSnapshot(snapshot);
        const remote = await remoteState(snapshot, signal);
        assertSnapshot(snapshot);
        if ((remote?.revision ?? null) !== (expectedRevision ?? null)) throw new Error('聊天记忆已在其他窗口更新，请重新加载聊天后再整理。');
        const ctx = context();
        const old = ctx.chatMetadata[MODULE];
        ctx.chatMetadata[MODULE] = structuredClone(state);
        try {
            await ctx.saveMetadata(); // This ST version may swallow save errors: readback below is mandatory.
            const saved = await remoteState(snapshot, signal);
            assertSnapshot(snapshot);
            if (saved?.revision !== state.revision || fingerprint(saved) !== fingerprint(state)) throw new Error('记忆保存未通过读回校验，未推进压缩进度。');
            return saved;
        } catch (error) {
            if (identity() === snapshot.owner && context().chatMetadata[MODULE]?.revision === state.revision) {
                if (old === undefined) delete context().chatMetadata[MODULE]; else context().chatMetadata[MODULE] = old;
            }
            throw error;
        }
    }

    function inject(text) {
        context().setExtensionPrompt(MODULE, text, script.extension_prompt_types.IN_CHAT, 1, false, script.extension_prompt_roles.SYSTEM);
    }

    async function availableHistory(settings, maxPromptTokens) {
        const ctx = context();
        const key = fingerprint([identity(), tokenizerIdentity(ctx), ctx.getCharacterCardFields?.(), ctx.chatCompletionSettings?.prompts,
            Object.entries(ctx.extensionPrompts ?? {}).filter(([k]) => k !== MODULE).map(([k, v]) => [k, v.value])]);
        if (key !== overheadIdentity) { overheadIdentity = key; lastOverhead = null; }
        const fields = ctx.getCharacterCardFields?.() ?? {};
        const fixedStrings = [...Object.values(fields).filter(v => typeof v === 'string'),
            ...(ctx.chatCompletionSettings?.prompts ?? []).filter(p => p.enabled !== false).map(p => p.content ?? ''),
            ...Object.entries(ctx.extensionPrompts ?? {}).filter(([k]) => k !== MODULE).map(([, p]) => p.value ?? '')];
        const estimate = await count(fixedStrings.join('\n'));
        // Dynamic world info is built AFTER interceptors. Reserve space conservatively on the first request;
        // subsequent requests also use measured total-minus-history overhead from the host's final prompt.
        const overhead = Math.max(estimate, lastOverhead ?? Math.floor(maxPromptTokens * 0.25));
        const reserve = Math.max(256, Math.ceil(maxPromptTokens * 0.03));
        return { available: Math.max(0, maxPromptTokens - overhead - reserve - settings.memoryTokens), overhead, reserve, estimated: true };
    }

    async function observePrompt(text, historyTokens, memoryTokens) {
        lastOverhead = Math.max(0, await count(text) - historyTokens - memoryTokens);
    }

    async function prepareApi(settings) {
        const ctx = context();
        const mainApi = ctx.mainApi;
        const cc = structuredClone(ctx.chatCompletionSettings);
        const tc = structuredClone(ctx.textCompletionSettings);
        const model = ctx.getChatCompletionModel?.();
        const apiServer = mainApi === 'textgenerationwebui' ? ctx.getTextGenServer?.(tc.type) : '';
        const instruct = structuredClone(ctx.powerUserSettings?.instruct);
        const sourceContext = settings.apiMode === 'main' ? script.getMaxContextTokens() : settings.summaryContext;
        const limit = Math.min(sourceContext, settings.summaryContext);
        const output = Math.min(settings.summaryOutput, Math.floor(limit / 3));
        const sameTokenizer = settings.apiMode === 'main' || settings.customModel === model;
        // An unrelated custom model has no host tokenizer. UTF-8 byte count is a conservative fallback.
        const apiCount = sameTokenizer ? count : async text => Math.max(await count(text), new TextEncoder().encode(text).length);
        if (settings.apiMode === 'custom') {
            let url;
            try { url = new URL(settings.customUrl); } catch { throw new Error('请填写独立 API 的有效 Base URL。'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址须为不含用户名和密码的 HTTP(S) 地址。');
            if (!settings.customModel) throw new Error('请填写独立摘要模型名称。');
            // Empty secret_id would silently select the host's active CUSTOM key. Require explicit selection.
            if (!settings.secretId) throw new Error('请选择独立 API 的酒馆密钥；本地免密服务可在宿主保存一个标注清楚的占位密钥。');
        } else if (!['openai', 'textgenerationwebui'].includes(mainApi)) {
            throw new Error('此主 API 类型尚未适配，请选择独立 OpenAI 兼容 API。');
        }
        return { limit, output, count: apiCount, tokenizerEstimated: !sameTokenizer,
            send: async (messages, signal) => {
                if (settings.apiMode === 'custom') {
                    return (await ctx.ChatCompletionService.processRequest({ messages, model: settings.customModel, max_tokens: output,
                        chat_completion_source: 'custom', custom_url: settings.customUrl.replace(/\/+$/, ''), secret_id: settings.secretId,
                        temperature: 0.2, stream: false, custom_prompt_post_processing: 'none' }, {}, true, signal)).content;
                }
                if (mainApi === 'openai') {
                    const data = await openai.createGenerationParameters({ ...cc, openai_max_tokens: output, stream_openai: false, temperature: 0.2 }, model, 'quiet', messages);
                    const payload = { ...data.generate_data, messages, max_tokens: output, stream: false, n: 1 };
                    delete payload.tools; delete payload.tool_choice;
                    return (await ctx.ChatCompletionService.sendRequest(payload, true, signal)).content;
                }
                const prompt = instruct?.enabled ? ctx.TextCompletionService.constructPrompt(structuredClone(messages), instruct, {})
                    : messages.map(m => `${m.role}:\n${m.content}`).join('\n\n') + '\n\nassistant:\n';
                const payload = ctx.TextCompletionService.createRequestData({ prompt, api_type: tc.type, api_server: apiServer,
                    model: tc.model, max_tokens: output, temperature: 0.2, top_p: tc.top_p ?? 1, min_p: tc.min_p ?? 0,
                    repetition_penalty: tc.rep_pen ?? 1, stream: false, max_context_length: limit, truncation_length: limit });
                return (await ctx.TextCompletionService.sendRequest(payload, true, signal)).content;
            } };
    }

    async function secretOptions() {
        await secrets.readSecretState();
        return (secrets.secret_state[secrets.SECRET_KEYS.CUSTOM] ?? []).map(s => ({ id: s.id, label: s.label || '未命名密钥' }));
    }

    return { context, identity, capture, assertSnapshot, count, tokenizerIdentity, settings, saveSettings, persist, remoteState, post, inject,
        availableHistory, observePrompt, prepareApi, secretOptions,
        maxPromptTokens: () => script.getMaxPromptTokens(), isGenerating: () => script.isGenerating(),
        defaults: () => structuredClone(DEFAULTS), events: context().eventTypes };
}
