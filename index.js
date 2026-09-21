import { MODULE } from './src/core.js';
import { createHost } from './src/host.js';
import { createVectorService } from './src/vectors.js';
import { MemoryEngine } from './src/engine.js';
import { mountUI } from './src/ui.js';

let instance = null;
let starting = null;
let disposers = [];

export async function initialize() {
    if (instance) return instance;
    if (starting) return starting;
    starting = (async () => {
        const host = await createHost();
        const engine = new MemoryEngine(host, createVectorService(host));
        const ui = mountUI(host, engine);
        const { eventSource, eventTypes: e } = host.context();
        function on(event, handler) {
            if (!event) return;
            eventSource.on(event, handler);
            disposers.push(() => eventSource.removeListener(event, handler));
        }
        on(e.CHAT_CHANGED, () => { engine.changed(); engine.schedule(); });
        on(e.GENERATION_STARTED, (_type, _options, dryRun) => { if (!dryRun) engine.cancel('正在生成角色回复。'); });
        on(e.GENERATION_ENDED, () => { engine.scheduleRefresh(); engine.schedule(); });
        on(e.GENERATION_STOPPED, () => { engine.cancel('角色生成已停止。'); engine.scheduleRefresh(); });
        for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'CHARACTER_FIRST_MESSAGE_SELECTED']) {
            on(e[name], () => { engine.changed(); engine.schedule(); });
        }
        for (const name of ['MAIN_API_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CONNECTION_PROFILE_LOADED']) {
            on(e[name], () => { engine.changed(); ui.syncControls(); });
        }
        on(e.CHAT_COMPLETION_PROMPT_READY, data => engine.observePrompt(data, 'chat'));
        on(e.GENERATE_AFTER_COMBINE_PROMPTS, data => engine.observePrompt(data, 'text'));
        // An API-side hook is kept available even when the extension's own setting is off.
        globalThis.lightMemoryInterceptor = (chat, size, _abort, type) => engine.intercept(chat, size, type);
        instance = { host, engine, ui };
        engine.scheduleRefresh();
        return instance;
    })().finally(() => { starting = null; });
    return starting;
}

export async function onDisable() {
    instance?.engine.destroy();
    instance?.ui.destroy();
    for (const dispose of disposers) dispose();
    disposers = [];
    instance = null;
    globalThis.lightMemoryInterceptor = async () => {};
    globalThis.SillyTavern?.getContext()?.setExtensionPrompt(MODULE, '', 1, 1, false, 0);
}

export async function onEnable() { await initialize(); }

// APP_READY may already have fired for an installation loaded without a full page reload.
const ctx = globalThis.SillyTavern.getContext();
ctx.eventSource.once(ctx.eventTypes.APP_READY, () => { void initialize().catch(console.error); });
if (document.readyState !== 'loading' && document.getElementById('extensions_settings2')) {
    void initialize().catch(console.error);
} else {
    document.addEventListener('DOMContentLoaded', () => { void initialize().catch(console.error); }, { once: true });
}
