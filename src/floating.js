// A small reading companion: current floor range leads, controls stay within thumb reach.
// Uses the host's ink/paper palette and existing button rules, with no new global shortcuts.
let activePanel = null;
export function mountFloatingPanel(host, engine, actions) {
    activePanel?.destroy();
    const storageKey = 'lightmemory-floating-v1';
    let layout = { collapsed: true, x: null, y: null };
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && typeof saved.collapsed === 'boolean') layout.collapsed = saved.collapsed;
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) Object.assign(layout, { x: saved.x, y: saved.y });
    } catch { /* Storage may be disabled; the panel still works for this session. */ }
    const node = (tag, className, text = '') => {
        const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
    };
    const root = node('aside', 'lightmemory lm-floating');
    root.id = 'lightmemory-floating'; root.setAttribute('aria-label', '轻忆快捷面板');
    // ST's html-level touchstart/mousedown handler closes unpinned drawers on outside input.
    // Keep settings open while interacting with this companion, including the hide button.
    for (const type of ['click', 'mousedown', 'touchstart']) root.addEventListener(type, event => event.stopPropagation());
    const header = node('div', 'lm-float-header');
    const handle = node('button', 'lm-float-handle', '轻忆');
    handle.type = 'button'; handle.title = '拖动移动；聚焦后用方向键移动，Home 键复位';
    handle.setAttribute('aria-label', '移动轻忆面板，方向键移动，Home 键复位');
    const phase = node('span', 'lm-float-phase', '未启用');
    const toggle = node('button', 'menu_button lm-button lm-float-toggle'); toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'lm-floating-body');
    const body = node('div', 'lm-float-body'); body.id = 'lm-floating-body';
    const message = node('p', 'lm-float-message'); message.setAttribute('aria-live', 'polite');
    const progress = node('p', 'lm-help lm-tabular');
    const metrics = node('div', 'lm-metrics');
    const values = ['记忆批次', '待整理轮次', '近期轮次'].map(label => {
        const item = node('div', ''); const value = node('strong', '', '—');
        item.append(value, node('span', '', label)); metrics.append(item); return value;
    });
    const error = node('p', 'lm-notice lm-error'); error.setAttribute('role', 'status');
    const buttons = node('div', 'lm-actions');
    function button(label, action) {
        const b = node('button', 'menu_button lm-button', label); b.type = 'button';
        b.addEventListener('click', async () => {
            b.disabled = true;
            try { await action(); } catch (e) { engine.fail(e); }
            finally { b.disabled = false; render(engine.status); }
        });
        buttons.append(b); return b;
    }
    const start = button('整理历史', () => engine.run(true));
    const pause = button('暂停整理', () => host.isGenerating() ? engine.stopBackground() : engine.pause(!engine.status.state?.paused));
    button('查看记忆', actions.memories);
    button('上次注入', actions.injection);
    button('打开设置', actions.settings);
    button('隐藏悬浮条', () => actions.hide());
    header.append(handle, phase, toggle); body.append(message, progress, metrics, error, buttons);
    root.append(header, body); document.body.append(root);

    function save() { try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Optional preference only. */ } }
    function clamp() {
        if (root.hidden) return;
        const viewport = window.visualViewport;
        const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
        const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
        const box = root.getBoundingClientRect();
        const x = layout.x ?? left + 16;
        const y = layout.y ?? top + 80;
        root.style.left = `${Math.max(left + 8, Math.min(x, left + width - box.width - 8))}px`;
        root.style.top = `${Math.max(top + 8, Math.min(y, top + height - box.height - 8))}px`;
    }
    function sync() {
        root.hidden = host.settings().floatingEnabled === false;
        body.hidden = layout.collapsed;
        root.classList.toggle('lm-collapsed', layout.collapsed);
        toggle.textContent = layout.collapsed ? '展开' : '收起';
        toggle.setAttribute('aria-expanded', String(!layout.collapsed));
        clamp();
    }
    toggle.addEventListener('click', () => { layout.collapsed = !layout.collapsed; save(); sync(); });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !layout.collapsed) { layout.collapsed = true; save(); sync(); toggle.focus(); event.stopPropagation(); }
    });
    let drag = null;
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const rect = root.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        layout.x = drag.left + event.clientX - drag.x; layout.y = drag.top + event.clientY - drag.y; clamp();
    });
    const finishDrag = () => {
        if (!drag) return;
        drag = null; const rect = root.getBoundingClientRect(); layout.x = rect.left; layout.y = rect.top; save();
    };
    handle.addEventListener('pointerup', finishDrag); handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
    handle.addEventListener('keydown', event => {
        if (event.key === 'Home') { event.preventDefault(); layout.x = null; layout.y = null; save(); clamp(); return; }
        const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
        if (!delta) return;
        event.preventDefault(); const rect = root.getBoundingClientRect();
        layout.x = rect.left + delta[0]; layout.y = rect.top + delta[1]; clamp(); save();
    });
    const active = new Set(['preparing', 'summarizing', 'saving', 'indexing', 'waiting']);
    const names = { preparing: '核对正文', summarizing: '摘要中', saving: '保存中', indexing: '索引中', waiting: '等待保存', paused: '已暂停', error: '需处理', idle: '就绪' };
    function tick() {
        const state = engine.status;
        const seconds = state.startedAt && active.has(state.phase) ? Math.floor((Date.now() - state.startedAt) / 1000) : null;
        progress.textContent = `本次已保存 ${state.completedBatches ?? 0} 批${seconds !== null ? ` · 已用时 ${seconds} 秒` : ''}`;
    }
    function render(state) {
        const enabled = host.settings().enabled;
        phase.textContent = enabled ? names[state.phase] ?? '就绪' : '未启用';
        root.dataset.phase = enabled ? state.phase : 'disabled';
        message.textContent = state.message;
        const m = state.metrics;
        [m?.segments, m?.pendingRounds, m?.recentRounds].forEach((v, i) => { values[i].textContent = v === undefined ? '—' : String(v); });
        error.textContent = [state.error || state.warning, m ? `待整理 ${m.pendingRounds} 轮：可整理 ${m.readyRounds ?? m.pendingRounds} · 受保护 ${m.blockedRounds ?? 0} · 排队 ${m.queuedRounds ?? 0}${m.openingPending ? '；另有开场白' : ''}` : ''].filter(Boolean).join('\n'); error.hidden = !error.textContent;
        start.disabled = !enabled || !host.identity() || host.isGenerating() || active.has(state.phase);
        pause.disabled = !enabled || !host.identity();
        pause.textContent = host.isGenerating() ? '停止本次' : state.state?.paused ? '恢复整理' : '暂停整理';
        tick(); sync();
    }
    const unsubscribe = engine.subscribe(render);
    const timer = setInterval(tick, 1000);
    const observer = new ResizeObserver(clamp); observer.observe(root);
    window.addEventListener('resize', clamp);
    window.visualViewport?.addEventListener('resize', clamp);
    window.visualViewport?.addEventListener('scroll', clamp);
    activePanel = { sync: () => render(engine.status), destroy() {
        unsubscribe(); clearInterval(timer); observer.disconnect();
        window.removeEventListener('resize', clamp);
        window.visualViewport?.removeEventListener('resize', clamp);
        window.visualViewport?.removeEventListener('scroll', clamp); root.remove();
    } };
    return activePanel;
}
