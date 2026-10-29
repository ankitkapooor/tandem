import { $, el, ico, debounce, ago, dayLabel, fmtMs, popover, closePopover, toast } from './ui.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { codeBlock } from './blocks.js';

/* ============================== state & api ============================== */

const state = {
  view: 'chat', // chat | memory | settings
  mock: false,
  agents: {}, // { claude: {installed, version}, codex: ... }
  settings: null,
  choices: null,
  roles: {},
  threads: [],
  thread: null,
  search: '',
  mode: 'relay',
  preview: null, // plan preview from the server
  edited: null, // plan the user changed by hand
  live: null, // plan currently running
  stageState: {}, // stage index -> running | done | error
  working: [], // agent ids currently running
  skills: [],
  picked: [],
  files: [], // attachments waiting to be sent
};

const NAMES = { claude: 'Claude', codex: 'Codex', user: 'You', system: 'tandem' };
const LETTER = { claude: 'C', codex: 'X', user: 'Y', system: '!' };
const MODE_LABEL = { solo: 'Solo', relay: 'Relay', parallel: 'Parallel', debate: 'Debate' };
const MODE_TIP = {
  solo: 'One agent answers',
  relay: 'One answers, the other responds to it',
  parallel: 'Both answer blind, then merge',
  debate: 'They go back and forth until they agree',
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const avatar = (who, extra = '') => {
  const a = el('span', { className: `avatar ${extra}`, textContent: LETTER[who] || '?' });
  a.dataset.who = who;
  return a;
};
const enabledAgents = () => ['claude', 'codex'].filter((a) => state.settings?.[a]?.enabled);
const isWorking = () => state.working.length > 0 || !!state.thread?.busy;

/* ============================== layout: rail ============================== */

function renderRail() {
  const rail = $('#rail');
  rail.replaceChildren();
  rail.append(
    el('div', { className: 'logo', html: '<img src="/icon.svg" width="40" height="40" alt="tandem" style="border-radius:11px">' }),
    el('div', { className: 'rail-sep' }),
  );
  const items = [
    ['chat', 'chat', 'Threads'],
    ['memory', 'memory', 'Memory'],
    ['settings', 'sliders', 'Settings'],
  ];
  for (const [view, name, label] of items) {
    const b = el('button', { className: 'rail-btn', title: label, type: 'button' }, ico(name, 21));
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-current', String(state.view === view));
    b.onclick = () => go(view);
    rail.append(b);
  }
  rail.append(el('div', { className: 'rail-grow' }));
  for (const a of ['claude', 'codex']) {
    const ok = state.agents[a]?.installed && state.settings?.[a]?.enabled;
    const p = el('div', { className: `presence ${ok ? '' : 'off'} ${state.working.includes(a) ? 'working' : ''}`, title: `${NAMES[a]}: ${state.agents[a]?.installed ? (state.settings?.[a]?.enabled ? 'ready' : 'turned off') : 'not installed'}` }, avatar(a));
    rail.append(p);
  }
}

function toggleThreads() {
  const on = document.body.classList.toggle('collapsed');
  try { localStorage.setItem('tandem.collapsed', on ? '1' : '0'); } catch { /* private mode */ }
}

function go(view) {
  state.view = view;
  closePopover();
  document.body.classList.remove('drawer');
  $('#scrim').hidden = true;
  renderAll();
}

/* ============================== layout: thread panel ============================== */

function renderThreadPanel() {
  const panel = $('#threads');
  const keepSearch = document.activeElement?.id === 'search-input';
  panel.replaceChildren();
  const newBtn = el('button', { className: 'icon-btn', title: 'New thread', type: 'button' }, ico('compose', 19));
  newBtn.setAttribute('aria-label', 'New thread');
  newBtn.onclick = newThread;
  const head = el('div', { className: 'panel-head' }, el('h2', { textContent: state.view === 'chat' ? 'Threads' : state.view === 'memory' ? 'Memory' : 'Settings' }), state.view === 'chat' ? newBtn : null);
  panel.append(head);

  if (state.view !== 'chat') {
    const list = el('div', { id: 'thread-list' });
    const back = el('button', { className: 'thread', type: 'button' }, el('div', { className: 'row1' }, ico('arrow', 16), el('b', { textContent: 'Back to threads' })));
    back.onclick = () => go('chat');
    list.append(back);
    panel.append(list);
    return;
  }

  const input = el('input', { id: 'search-input', type: 'search', placeholder: 'Search threads', value: state.search, autocomplete: 'off' });
  input.oninput = () => {
    state.search = input.value;
    renderThreadList();
  };
  panel.append(el('div', { className: 'search' }, ico('search', 16), input), el('div', { id: 'thread-list' }));
  renderThreadList();
  if (keepSearch) input.focus();
}

function renderThreadList() {
  const list = $('#thread-list');
  if (!list || state.view !== 'chat') return;
  list.replaceChildren();
  const q = state.search.trim().toLowerCase();
  const rows = state.threads.filter((t) => !q || t.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q));
  if (!rows.length) {
    list.append(el('div', { className: 'empty-list', textContent: q ? 'No threads match.' : 'No threads yet. Start one with the pencil above.' }));
    return;
  }
  let group = '';
  for (const t of rows) {
    const g = dayLabel(t.updatedAt);
    if (g !== group) {
      group = g;
      list.append(el('div', { className: 'group-label', textContent: g }));
    }
    const busy = t.busy || (state.thread?.id === t.id && isWorking());
    const b = el(
      'button',
      { className: 'thread', type: 'button' },
      el('div', { className: 'row1' }, el('b', { textContent: t.title }), busy ? el('span', { className: 'riders', html: '<i></i><i></i>' }) : el('time', { textContent: ago(t.updatedAt) })),
      t.preview ? el('span', { className: 'prev', textContent: t.preview }) : null,
    );
    b.setAttribute('aria-current', String(state.thread?.id === t.id));
    b.onclick = () => openThread(t.id);
    list.append(b);
  }
}

async function refreshThreads() {
  state.threads = await api('/threads');
  if (state.thread) {
    const t = state.threads.find((x) => x.id === state.thread.id);
    if (t) state.thread.title = t.title;
  }
  renderThreadList();
  renderTopbar();
}
const refreshThreadsSoon = debounce(() => refreshThreads().catch(() => {}), 250);

async function newThread() {
  const t = await api('/threads', { method: 'POST' });
  state.view = 'chat';
  await refreshThreads();
  await openThread(t.id);
  $('#input')?.focus();
}

async function openThread(id) {
  state.thread = await api(`/threads/${id}`);
  state.view = 'chat';
  state.live = null;
  state.stageState = {};
  state.working = state.thread.busy ? state.working : [];
  state.edited = null;
  localStorage.setItem('tandem.thread', id);
  document.body.classList.remove('drawer');
  $('#scrim').hidden = true;
  renderAll();
  scrollDown(true);
}

/* ============================== layout: top bar ============================== */

function renderTopbar() {
  const bar = $('#topbar');
  bar.replaceChildren();
  const menu = el('button', { id: 'menu', className: 'icon-btn', type: 'button', title: 'Threads' }, ico('menu', 20));
  menu.setAttribute('aria-label', 'Open threads');
  menu.onclick = () => {
    document.body.classList.add('drawer');
    $('#scrim').hidden = false;
  };
  bar.append(menu);
  const collapse = el('button', { id: 'collapse', className: 'icon-btn', type: 'button', title: 'Show or hide threads (Ctrl/⌘ B)' }, ico('panel', 20));
  collapse.setAttribute('aria-label', 'Show or hide threads');
  collapse.onclick = toggleThreads;
  bar.append(collapse);

  if (state.view !== 'chat') {
    bar.append(el('h1', { className: 'title', textContent: state.view === 'memory' ? 'Memory' : 'Settings' }));
    return;
  }
  const t = state.thread;
  const title = el('h1', { className: 'title', textContent: t ? t.title : 'tandem' });
  if (t) {
    title.title = 'Click to rename';
    title.onclick = () => {
      title.contentEditable = 'true';
      title.focus();
      document.getSelection().selectAllChildren(title);
    };
    const done = async (save) => {
      title.contentEditable = 'false';
      const v = title.textContent.trim();
      if (save && v && v !== t.title) {
        t.title = v;
        await api(`/threads/${t.id}`, { method: 'PATCH', body: { title: v } }).catch(() => {});
        refreshThreads();
      } else title.textContent = t.title;
    };
    title.onblur = () => title.isContentEditable && done(true);
    title.onkeydown = (e) => {
      if (e.key === 'Enter') (e.preventDefault(), done(true));
      if (e.key === 'Escape') done(false);
    };
  }
  bar.append(title);
  if (t) {
    const members = el('div', { className: 'members' }, avatar('user'), ...enabledAgents().map((a) => avatar(a, state.working.includes(a) ? 'working' : '')));
    const more = el('button', { className: 'icon-btn', type: 'button', title: 'Thread options' }, ico('more', 20));
    more.setAttribute('aria-label', 'Thread options');
    more.onclick = () => {
      const rename = el('button', { className: 'opt', type: 'button' }, ico('pencil', 16), el('span', { className: 'grow', textContent: 'Rename' }));
      rename.onclick = () => (closePopover(), title.click());
      const del = el('button', { className: 'opt', type: 'button' }, ico('trash', 16), el('span', { className: 'grow', textContent: 'Delete thread' }));
      del.onclick = async () => {
        closePopover();
        if (!confirm(`Delete “${t.title}”? This cannot be undone.`)) return;
        await api(`/threads/${t.id}`, { method: 'DELETE' });
        state.thread = null;
        await refreshThreads();
        if (state.threads[0]) await openThread(state.threads[0].id);
        else renderAll();
      };
      popover(more, el('div', {}, rename, del), { place: 'bottom', align: 'end' });
    };
    bar.append(members, more);
  }
}

/* ============================== chat view ============================== */

let stickToBottom = true;

function scrollDown(force) {
  const s = $('#scroller');
  if (!s) return;
  if (force || stickToBottom) s.scrollTo({ top: s.scrollHeight, behavior: force ? 'auto' : 'smooth' });
}

function renderChat() {
  const page = $('#page');
  page.replaceChildren();
  const scroller = el('div', { id: 'scroller' }, el('div', { id: 'messages' }));
  const jump = el('button', { className: 'jump', type: 'button', hidden: true }, ico('down', 16), 'Latest');
  jump.onclick = () => ((stickToBottom = true), scrollDown(true));
  scroller.onscroll = () => {
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    jump.hidden = stickToBottom;
  };
  page.append(el('div', { style: 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column' }, scroller, jump), el('div', { id: 'dock' }));
  renderMessages();
  renderDock();
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  box.replaceChildren();
  const t = state.thread;
  if (!t || !t.messages.length) {
    box.append(emptyState());
  } else {
    let prev = null;
    let day = '';
    for (const m of t.messages) {
      const d = new Date(m.ts).toDateString();
      if (d !== day) {
        day = d;
        box.append(el('div', { className: 'day', textContent: dayLabel(m.ts) === 'Today' ? 'Today' : new Date(m.ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }));
        prev = null;
      }
      box.append(messageNode(m, prev));
      prev = m;
    }
  }
  renderWorking();
}

function emptyState() {
  const ready = enabledAgents().filter((a) => state.agents[a]?.installed);
  const missing = ['claude', 'codex'].filter((a) => !state.agents[a]?.installed && !state.mock);
  const cards = [
    ['sparkle', 'Get a second opinion', 'Ask a question, then watch the other agent push back.', 'What are the real trade-offs between SQLite and Postgres for a small side project?'],
    ['parallel', 'Compare approaches', 'Both answer blind, then merge the best of each.', 'Give me two different ways to structure a rate limiter in Node.'],
    ['debate', 'Settle a debate', 'Argue it out until they agree.', 'Should I write this as a monorepo or separate repos? Debate it.'],
  ];
  const wrap = el(
    'div',
    { className: 'hero' },
    el('div', { className: 'mark', html: '<img src="/icon.svg" width="64" height="64" alt="" style="border-radius:16px">' }),
    el('h2', { textContent: 'Two minds, one thread' }),
    el('p', { textContent: `${NAMES[state.settings.roles.answer]} answers and ${NAMES[state.settings.roles.critique]} critiques by default. Mention @claude or @codex to take control of who speaks and in what order.` }),
  );
  const grid = el('div', { className: 'suggest' });
  for (const [ic, title, sub, prompt] of cards) {
    const b = el('button', { type: 'button' }, ico(ic, 20), el('b', { textContent: title }), el('span', { textContent: sub }));
    b.onclick = () => {
      const i = $('#input');
      i.value = prompt;
      i.dispatchEvent(new Event('input'));
      i.focus();
    };
    grid.append(b);
  }
  wrap.append(grid);
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (ios && !navigator.standalone) {
    wrap.append(el('div', { className: 'note', html: '<b>Make it an app on this iPhone.</b> In Safari tap Share, then <b>Add to Home Screen</b>. It opens full screen with its own icon, no browser bars.' }));
  }
  if (missing.length) {
    const cmd = { claude: 'claude', codex: 'codex login' };
    wrap.append(
      el('div', { className: 'note', html: `<b>${missing.map((a) => NAMES[a]).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed.</b> tandem drives the official command-line tools using your own subscriptions. Install ${missing.length > 1 ? 'them' : 'it'}, sign in once in Terminal (<code>${cmd[missing[0]]}</code>), then restart tandem.` }),
    );
  } else if (!ready.length) {
    wrap.append(el('div', { className: 'note', textContent: 'Both agents are turned off. Turn one on in Settings.' }));
  }
  return wrap;
}

function messageNode(m, prev) {
  const who = m.role;
  const first = !prev || prev.role !== who || m.ts - prev.ts > 5 * 60e3 || who === 'system' || (m.meta && prev.meta && prev.meta.step !== m.meta.step);
  const node = el('div', { className: `msg ${first ? 'first' : ''}` });
  node.dataset.who = who;
  node.dataset.id = m.id;
  const body = el('div', { className: 'body' });
  if (who === 'system') {
    const hint = /not logged in|\/login/i.test(m.text)
      ? el('small', { html: 'Open Terminal, run <code>claude</code>, then type <code>/login</code>. For Codex run <code>codex login</code>. Then send again.' })
      : null;
    node.append(el('div', { className: 'main' }, el('div', { className: 'alert' }, ico('alert', 18), el('div', {}, el('span', { textContent: m.text }), hint))));
    return node;
  }
  body.append(renderMarkdown(m.text, codeBlock));
  if (m.meta?.attachments?.length) body.append(el('div', { className: 'msg-files' }, ...m.meta.attachments.map((a) => attachChip(a, false))));
  const meta = el('div', { className: 'meta' }, el('b', { textContent: NAMES[who] || who }));
  if (m.meta?.role) meta.append(el('span', { className: 'chip', textContent: state.roles[m.meta.role] || m.meta.role }));
  if (m.meta?.of > 1) meta.append(el('span', { className: 'dim', textContent: `step ${m.meta.step}/${m.meta.of}` }));
  const time = el('span', { className: 'dim', textContent: [new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), m.meta?.ms ? fmtMs(m.meta.ms) : ''].filter(Boolean).join(' · ') });
  meta.append(time);
  const copy = el('button', { className: 'icon-btn', type: 'button', title: 'Copy' }, ico('copy', 15));
  copy.setAttribute('aria-label', 'Copy message');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      toast('Copied');
    } catch {
      toast('Could not copy', 'bad');
    }
  };
  node.append(el('div', { className: 'gutter' }, avatar(who)), el('div', { className: 'main' }, meta, body, el('div', { className: 'tools' }, copy)));
  return node;
}

function renderWorking() {
  $$('.typing').forEach((n) => n.remove());
  const box = $('#messages');
  if (!box || !state.working.length) return;
  for (const a of state.working) {
    const step = state.live?.stages.flat().find((s) => s.agent === a);
    const row = el(
      'div',
      { className: 'typing' },
      avatar(a),
      el('div', { className: 'lines' }, el('div', {}, el('b', { textContent: NAMES[a], style: `--who:var(--${a})` }), el('span', { className: 'muted', textContent: step ? `${(state.roles[step.role] || step.role).toLowerCase()}…` : 'thinking…' })), el('div', { className: 'shimmer-line', style: 'width:72%' }), el('div', { className: 'shimmer-line', style: 'width:48%' })),
    );
    row.firstChild.dataset.who = a;
    box.append(row);
  }
  scrollDown();
}
const $$ = (sel) => [...document.querySelectorAll(sel)];

function appendMessage(m) {
  if (!state.thread || state.thread.messages.some((x) => x.id === m.id)) return;
  const prev = state.thread.messages[state.thread.messages.length - 1] || null;
  state.thread.messages.push(m);
  const box = $('#messages');
  if (!box || state.view !== 'chat') return;
  if (state.thread.messages.length === 1) return renderMessages();
  $$('.typing').forEach((n) => n.remove());
  box.append(messageNode(m, prev));
  renderWorking();
  scrollDown(m.role === 'user');
}

/* ============================== dock: plan, composer ============================== */

function currentPlan() {
  return isWorking() && state.live ? state.live : state.edited || state.preview;
}

function renderDock() {
  const dock = $('#dock');
  if (!dock || state.view !== 'chat') return;
  const had = $('#input');
  const draft = had ? { v: had.value, s: had.selectionStart } : null;
  dock.replaceChildren();
  dock.append(el('div', { className: 'plan', id: 'plan' }), buildComposer(), el('div', { className: 'hint', html: '<kbd>@</kbd> to direct an agent · <kbd>/</kbd> to add a skill · <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line' }));
  if (draft) {
    const i = $('#input');
    i.value = draft.v;
    i.setSelectionRange(draft.s, draft.s);
    autosize(i);
  }
  renderPlan();
  syncSend();
}

function stepNode(s, i, interactive, status) {
  const b = el(interactive ? 'button' : 'div', { className: `step ${status || ''}` }, avatar(s.agent), el('span', { textContent: NAMES[s.agent] }), el('span', { className: 'role', textContent: (state.roles[s.role] || s.role).toLowerCase() }));
  if (status === 'running') b.append(el('span', { className: 'state', html: '' }));
  if (status === 'done') b.append(el('span', { className: 'state' }, ico('check', 14)));
  if (interactive) {
    b.type = 'button';
    b.title = 'Change this step';
    b.onclick = () => editStep(b, i);
  }
  return b;
}

function renderPlan() {
  const box = $('#plan');
  if (!box) return;
  box.replaceChildren();
  const plan = currentPlan();
  const running = isWorking() && state.live;
  if (!plan) return;
  const solo = plan.stages.flat().length === 1 && !state.edited;
  box.append(el('span', { className: 'plan-label', textContent: running ? 'Running' : state.edited ? 'Your plan' : plan.source === 'message' ? 'From your message' : 'Plan' }));
  plan.stages.forEach((stage, si) => {
    const wrap = el('div', { className: `stage ${stage.length > 1 ? 'multi' : ''}` });
    stage.forEach((s, k) => wrap.append(stepNode(s, [si, k], !running, running ? (state.stageState[si] === 'done' ? 'done' : state.stageState[si] === 'error' ? 'error' : state.stageState[si] === 'running' ? 'running' : 'pending') : '')));
    if (si) box.append(el('span', { className: 'arrow', html: icon('arrow', 14) }));
    box.append(wrap);
  });
  if (!running) {
    const add = el('button', { className: 'ghost', type: 'button' }, ico('plus', 14), 'Step');
    add.onclick = () => {
      const base = structuredClone(state.edited || state.preview || { stages: [] });
      const last = base.stages.flat().at(-1);
      const next = enabledAgents().find((a) => a !== last?.agent) || enabledAgents()[0];
      if (!next) return toast('Turn on an agent in Settings', 'bad');
      base.stages.push([{ agent: next, role: last ? 'critique' : 'answer' }]);
      state.edited = base;
      renderPlan();
    };
    box.append(add);
    if (state.edited) {
      const reset = el('button', { className: 'ghost', type: 'button', title: 'Back to the automatic plan' }, ico('reset', 14), 'Auto');
      reset.onclick = () => ((state.edited = null), renderPlan());
      box.append(reset);
    }
  }
  void solo;
}

function editStep(anchor, [si, k]) {
  const base = structuredClone(state.edited || state.preview);
  const step = base.stages[si][k];
  const commit = () => {
    base.stages = base.stages.filter((s) => s.length);
    state.edited = base.stages.length ? base : null;
    renderPlan();
  };
  const root = el('div');
  const draw = () => {
    root.replaceChildren(el('div', { className: 'pop-title', textContent: 'Who' }));
    for (const a of enabledAgents()) {
      const o = el('button', { className: 'opt', type: 'button' }, avatar(a), el('span', { className: 'grow', textContent: NAMES[a] }), step.agent === a ? el('span', { className: 'tick' }, ico('check', 16)) : null);
      o.onclick = () => ((step.agent = a), commit(), draw());
      root.append(o);
    }
    root.append(el('div', { className: 'pop-title', textContent: 'Job' }));
    const seg = el('div', { className: 'pop-row' });
    for (const r of Object.keys(state.roles)) {
      const b = el('button', { className: 'step', type: 'button', textContent: state.roles[r] });
      b.style.cursor = 'pointer';
      if (step.role === r) b.style.borderColor = 'var(--you)';
      b.onclick = () => ((step.role = r), commit(), draw());
      seg.append(b);
    }
    root.append(seg);
    const together = el('button', { className: 'opt', type: 'button' }, ico('parallel', 16), el('span', { className: 'grow' }, 'Run alongside the previous step'));
    together.onclick = () => {
      if (si > 0 && k === 0) {
        base.stages[si - 1].push(...base.stages[si].splice(k, 1));
      } else if (k > 0) {
        const [moved] = base.stages[si].splice(k, 1);
        base.stages.splice(si + 1, 0, [moved]);
      }
      commit();
      closePopover();
    };
    const del = el('button', { className: 'opt', type: 'button' }, ico('trash', 16), el('span', { className: 'grow', textContent: 'Remove step' }));
    del.onclick = () => {
      base.stages[si].splice(k, 1);
      commit();
      closePopover();
    };
    root.append(together, del);
  };
  draw();
  popover(anchor, root, { width: 300 });
}

const refreshPreview = debounce(async () => {
  const input = $('#input');
  if (!input || state.edited) return;
  try {
    state.preview = await api('/plan', { method: 'POST', body: { text: input.value, mode: state.mode } });
    if (!isWorking()) renderPlan();
  } catch {
    /* preview is best-effort */
  }
}, 180);

function buildComposer() {
  const comp = el('div', { className: 'composer' });
  const chips = el('div', { className: 'skills-row', id: 'skills-row' });
  const input = el('textarea', { id: 'input', rows: 1, placeholder: state.thread?.messages.length ? 'Reply…' : 'Ask both of them anything…', enterKeyHint: 'send' });
  input.setAttribute('aria-label', 'Message');

  // mode segmented control
  const seg = el('div', { className: 'seg', role: 'group' });
  for (const m of Object.keys(MODE_LABEL)) {
    const b = el('button', { type: 'button', title: MODE_TIP[m] }, ico(m, 15), el('span', { textContent: MODE_LABEL[m] }));
    b.setAttribute('aria-pressed', String(state.mode === m));
    b.onclick = () => {
      state.mode = m;
      state.edited = null;
      for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
      refreshPreview();
    };
    seg.append(b);
  }

  const clip = el('button', { className: 'icon-btn clip', type: 'button', title: 'Attach files' }, ico('clip', 19));
  clip.setAttribute('aria-label', 'Attach files');
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  clip.onclick = () => picker.click();
  picker.onchange = () => (addFiles([...picker.files]), (picker.value = ''));
  const send = el('button', { id: 'send', className: 'send', type: 'button', title: 'Send' }, ico('up', 19));
  send.setAttribute('aria-label', 'Send');
  const bar = el('div', { className: 'bar' }, clip, seg, el('span', { className: 'grow' }), ...['claude', 'codex'].map(agentPill), send, picker);
  const files = el('div', { className: 'attach-row', id: 'attach-row' });
  comp.append(files, chips, input, bar);
  comp.addEventListener('dragover', (e) => (e.preventDefault(), comp.classList.add('drop')));
  comp.addEventListener('dragleave', () => comp.classList.remove('drop'));
  comp.addEventListener('drop', (e) => {
    e.preventDefault();
    comp.classList.remove('drop');
    addFiles([...(e.dataTransfer?.files || [])]);
  });
  input.addEventListener('paste', (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) (e.preventDefault(), addFiles(pasted));
  });

  input.addEventListener('input', () => {
    autosize(input);
    syncSend();
    refreshPreview();
    suggest(comp, input);
  });
  input.addEventListener('keydown', (e) => {
    if (menu.open && handleMenuKey(e, input)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => closeMenu(), 120));
  send.onclick = () => (isWorking() ? stop() : submit());
  renderSkillChips(chips);
  setTimeout(renderFiles);
  return comp;
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function addFiles(list) {
  for (const f of list.slice(0, 10)) {
    if (f.size > 40 * 1024 * 1024) {
      toast(`${f.name} is over 40 MB`, 'bad');
      continue;
    }
    const item = { name: f.name || 'pasted-image.png', size: f.size, busy: true, thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' };
    state.files.push(item);
    renderFiles();
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(item.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      Object.assign(item, data, { busy: false });
    } catch (e) {
      state.files = state.files.filter((x) => x !== item);
      toast(e.message, 'bad');
    }
    renderFiles();
    syncSend();
  }
}

function attachChip(a, removable) {
  const chip = el('span', { className: `attach ${a.busy ? 'busy' : ''}` }, a.thumb ? el('img', { src: a.thumb, alt: '' }) : ico('file', 16), el('span', { className: 'nm', textContent: a.name }), el('small', { textContent: a.busy ? 'uploading…' : fmtSize(a.size) }));
  if (removable) {
    const x = el('button', { type: 'button', title: 'Remove' }, ico('x', 12));
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.onclick = () => ((state.files = state.files.filter((f) => f !== a)), renderFiles(), syncSend());
    chip.append(x);
  }
  return chip;
}

function renderFiles() {
  const row = $('#attach-row');
  if (!row) return;
  row.replaceChildren(...state.files.map((a) => attachChip(a, true)));
  row.hidden = !state.files.length;
}

function autosize(i) {
  i.style.height = 'auto';
  i.style.height = `${Math.min(i.scrollHeight, 240)}px`;
}

function syncSend() {
  const b = $('#send');
  const i = $('#input');
  if (!b || !i) return;
  const running = isWorking();
  b.classList.toggle('stop', running);
  b.replaceChildren(ico(running ? 'stop' : 'up', 19));
  b.title = running ? 'Stop' : 'Send';
  b.setAttribute('aria-label', b.title);
  b.disabled = !running && !i.value.trim() && !state.files.some((f) => !f.busy);
}

function renderSkillChips(row = $('#skills-row')) {
  if (!row) return;
  row.replaceChildren();
  row.hidden = !state.picked.length;
  state.picked.forEach((s, idx) => {
    const x = el('button', { type: 'button', title: 'Remove' }, ico('x', 12));
    x.setAttribute('aria-label', `Remove ${s.name}`);
    x.onclick = () => (state.picked.splice(idx, 1), renderSkillChips());
    const chip = el('span', { className: 'skill-chip' }, el('i', { className: 'dotc' }), ico('sparkle', 13), el('span', { textContent: s.name }), x);
    if (s.agent) chip.dataset.who = s.agent;
    row.append(chip);
  });
}

async function submit() {
  const input = $('#input');
  const text = input.value.trim();
  const ready = state.files.filter((f) => !f.busy);
  if ((!text && !ready.length) || isWorking()) return;
  if (state.files.some((f) => f.busy)) return toast('Still uploading…');
  if (!enabledAgents().length) return toast('Turn on an agent in Settings first', 'bad');
  if (!state.thread) {
    const t = await api('/threads', { method: 'POST' });
    state.thread = t;
    await refreshThreads();
  }
  const plan = state.edited;
  const skills = state.picked.map(({ name, path, agent }) => ({ name, path, agent }));
  const attachments = ready.map(({ name, path, size }) => ({ name, path, size }));
  const sentFiles = state.files;
  state.files = [];
  renderFiles();
  input.value = '';
  autosize(input);
  state.picked = [];
  state.edited = null;
  stickToBottom = true;
  renderSkillChips();
  syncSend();
  try {
    await api(`/threads/${state.thread.id}/send`, { method: 'POST', body: { text, mode: state.mode, plan, skills, attachments } });
  } catch (e) {
    input.value = text;
    state.files = sentFiles;
    renderFiles();
    autosize(input);
    syncSend();
    toast(e.message, 'bad');
  }
}

async function stop() {
  if (state.thread) await api(`/threads/${state.thread.id}/stop`, { method: 'POST' }).catch(() => {});
}

/* ============================== @ and / autocomplete ============================== */

const menu = { open: false, items: [], index: 0, node: null, token: null };

function closeMenu() {
  menu.node?.remove();
  menu.node = null;
  menu.open = false;
}

function suggest(comp, input) {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)([@/])([\w.:-]*)$/.exec(upto);
  if (!m) return closeMenu();
  const [, , sigil, q] = m;
  const query = q.toLowerCase();
  let items = [];
  if (sigil === '@') {
    const all = [
      { id: 'claude', label: 'Claude', sub: 'Anthropic · Claude Code', who: 'claude', alias: ['claude', 'anthropic'] },
      { id: 'codex', label: 'Codex', sub: 'OpenAI · also @chat or @gpt', who: 'codex', alias: ['codex', 'chat', 'gpt', 'chatgpt', 'openai'] },
      { id: 'both', label: 'Both', sub: 'Everyone takes part', who: null, alias: ['both', 'all', 'team'] },
    ];
    items = all.filter((a) => !query || a.alias.some((x) => x.startsWith(query))).map((a) => ({ ...a, insert: `@${a.id} `, kind: 'agent' }));
  } else {
    items = state.skills
      .filter((s) => !state.picked.some((p) => p.path === s.path) && (!query || s.name.toLowerCase().includes(query)))
      .slice(0, 30)
      .map((s) => ({ id: s.path, label: s.name, sub: s.description || `${s.scope || ''} skill`, who: s.agent, skill: s, kind: 'skill' }));
    if (!items.length && !state.skills.length) {
      items = [{ label: 'No skills found', sub: 'Skills in ~/.claude/skills and ~/.codex/skills show up here', disabled: true }];
    }
  }
  if (!items.length) return closeMenu();
  menu.items = items;
  menu.index = Math.min(menu.index, items.length - 1);
  menu.token = { start: input.selectionStart - m[2].length - q.length, end: input.selectionStart };
  drawMenu(comp, input);
}

function drawMenu(comp, input) {
  menu.node?.remove();
  const node = el('div', { className: 'suggest-menu', role: 'listbox' });
  node.append(el('div', { className: 'pop-title', textContent: menu.items[0]?.kind === 'agent' ? 'Direct a message' : 'Add a skill' }));
  menu.items.forEach((it, i) => {
    const row = el(
      'button',
      { className: `opt ${i === menu.index ? 'sel' : ''}`, type: 'button', role: 'option' },
      it.kind === 'agent' && it.who ? avatar(it.who) : it.kind === 'agent' ? el('span', { className: 'members' }, avatar('claude'), avatar('codex')) : it.skill?.agent ? avatar(it.skill.agent) : ico('sparkle', 18),
      el('span', { className: 'grow' }, el('span', { textContent: it.kind === 'agent' ? `@${it.id}` : it.label }), el('small', { textContent: it.kind === 'agent' ? it.sub : it.sub })),
    );
    if (it.disabled) row.disabled = true;
    row.onpointerdown = (e) => {
      e.preventDefault();
      choose(i, input);
    };
    node.append(row);
  });
  comp.append(node);
  menu.node = node;
  menu.open = true;
  node.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function handleMenuKey(e, input) {
  const n = menu.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawMenu(input.closest('.composer'), input);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    choose(menu.index, input);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
    return true;
  }
  return false;
}

function choose(i, input) {
  const it = menu.items[i];
  if (!it || it.disabled) return;
  const { start, end } = menu.token;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  if (it.kind === 'agent') {
    input.value = `${before}${it.insert}${after}`;
    const pos = (before + it.insert).length;
    input.setSelectionRange(pos, pos);
  } else {
    input.value = `${before}${after}`.replace(/\s{2,}/g, ' ');
    input.setSelectionRange(before.length, before.length);
    state.picked.push(it.skill);
    renderSkillChips();
  }
  menu.index = 0;
  closeMenu();
  input.focus();
  autosize(input);
  syncSend();
  refreshPreview();
}

/* ============================== model / effort pills ============================== */

function agentPill(a) {
  const cfg = state.settings[a];
  const model = state.choices[a].models.find((m) => m.value === cfg.model)?.label || cfg.model || 'Default';
  const b = el('button', { className: `pill ${cfg.enabled && state.agents[a]?.installed ? '' : 'off'}`, type: 'button', title: `${NAMES[a]} settings` }, avatar(a), el('span', { className: 'name', textContent: `${model}${cfg.effort ? ` · ${cfg.effort}` : ''}` }));
  b.onclick = () => agentPopover(b, a);
  return b;
}

async function patchSettings(patch) {
  state.settings = await api('/settings', { method: 'PUT', body: patch });
  refreshPreview();
  renderRail();
  if (state.view === 'chat') {
    const pills = $$('.bar .pill');
    const fresh = ['claude', 'codex'].map(agentPill);
    pills.forEach((p, i) => p.replaceWith(fresh[i]));
    renderTopbar();
  }
}

function agentPopover(anchor, a) {
  const root = el('div');
  const draw = () => {
    const cfg = state.settings[a];
    const ch = state.choices[a];
    root.replaceChildren();
    const on = el('label', { className: 'opt' }, avatar(a), el('span', { className: 'grow' }, el('span', { textContent: `${NAMES[a]} is ${cfg.enabled ? 'on' : 'off'}` }), el('small', { textContent: state.agents[a]?.installed ? `CLI ${state.agents[a].version || ''}` : 'CLI not installed' })));
    const sw = el('span', { className: 'switch' }, el('input', { type: 'checkbox', checked: cfg.enabled }), el('i'));
    sw.firstChild.onchange = async (e) => (await patchSettings({ [a]: { enabled: e.target.checked } }), draw());
    on.append(sw);
    root.append(on, el('div', { className: 'pop-title', textContent: 'Model' }));
    for (const m of ch.models) {
      const o = el('button', { className: 'opt', type: 'button' }, el('span', { className: 'grow', textContent: m.label }), cfg.model === m.value ? el('span', { className: 'tick' }, ico('check', 16)) : null);
      o.onclick = async () => (await patchSettings({ [a]: { model: m.value } }), draw());
      root.append(o);
    }
    if (a === 'codex') {
      const custom = el('input', { className: 'pop-input', placeholder: 'Or type a model name', value: ch.models.some((m) => m.value === cfg.model) ? '' : cfg.model });
      custom.onchange = async () => (await patchSettings({ codex: { model: custom.value.trim() } }), draw());
      root.append(custom);
    }
    root.append(el('div', { className: 'pop-title', textContent: 'Effort' }));
    const seg = el('div', { className: 'pop-row' });
    const seg2 = el('div', { className: 'seg' });
    for (const e of ['', ...ch.efforts]) {
      const b = el('button', { type: 'button', textContent: e || 'auto' });
      b.setAttribute('aria-pressed', String((cfg.effort || '') === e));
      b.onclick = async () => (await patchSettings({ [a]: { effort: e } }), draw());
      seg2.append(b);
    }
    seg.append(seg2);
    root.append(seg);
  };
  draw();
  popover(anchor, root, { width: 300, align: 'end' });
}

/* ============================== memory view ============================== */

async function renderMemory() {
  const page = $('#page');
  const mem = await api('/memory');
  let notes = mem.notes;
  const wrap = el('div', { className: 'page-inner' });
  page.replaceChildren(el('div', { className: 'page-scroll' }, wrap));
  const save = debounce(async () => {
    await api('/memory', { method: 'PUT', body: { notes } }).catch((e) => toast(e.message, 'bad'));
  }, 400);
  const list = el('div', { className: 'card' });
  const draw = () => {
    list.replaceChildren();
    if (!notes.length) list.append(el('div', { className: 'empty-list', textContent: 'Nothing saved yet. Add something both agents should always know.' }));
    notes.forEach((n, i) => {
      const t = el('textarea', { className: 'field', value: n.text, rows: 2, style: 'flex:1;resize:vertical' });
      t.oninput = () => ((n.text = t.value), save());
      const d = el('button', { className: 'icon-btn', type: 'button', title: 'Delete' }, ico('trash', 17));
      d.setAttribute('aria-label', 'Delete note');
      d.onclick = () => (notes.splice(i, 1), save(), draw());
      list.append(el('div', { className: 'note-item' }, t, d));
    });
  };
  const add = el('button', { className: 'btn', type: 'button' }, ico('plus', 0), 'Add note');
  add.textContent = 'Add note';
  add.onclick = () => {
    notes.unshift({ id: `n${Date.now()}`, text: '', ts: Date.now() });
    draw();
    list.querySelector('textarea')?.focus();
  };
  wrap.append(el('h2', { textContent: 'Memory' }), el('p', { className: 'sub', textContent: 'Notes here are shared with both agents on every message, so they stop asking the same things.' }), el('div', {}, add), list);
  draw();
}

/* ============================== settings view ============================== */

async function renderSettings() {
  const page = $('#page');
  const wrap = el('div', { className: 'page-inner' });
  page.replaceChildren(el('div', { className: 'page-scroll' }, wrap));
  const s = state.settings;
  const sel = (value, options, onchange) => {
    const n = el('select', { className: 'select' });
    for (const [v, l] of options) n.append(el('option', { value: v, textContent: l, selected: v === value }));
    n.onchange = () => onchange(n.value);
    return n;
  };
  const toggle = (checked, onchange) => {
    const i = el('input', { type: 'checkbox', checked });
    i.onchange = () => onchange(i.checked);
    return el('span', { className: 'switch' }, i, el('i'));
  };
  const row = (what, sub, control) => el('div', { className: 'setting' }, el('div', { className: 'what' }, el('b', { textContent: what }), sub ? el('span', { textContent: sub }) : null), el('div', { className: 'control' }, control));
  const save = async (patch) => {
    try {
      state.settings = await api('/settings', { method: 'PUT', body: patch });
      renderRail();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const agentOpts = [['claude', 'Claude'], ['codex', 'Codex (ChatGPT)']];

  const roles = el('div', { className: 'card' }, el('h3', { textContent: 'Default roles' }),
    row('Answers', 'Replies first when you do not @mention anyone', sel(s.roles.answer, agentOpts, (v) => save({ roles: { answer: v, critique: v === 'claude' ? 'codex' : 'claude' } }).then(renderSettings))),
    row('Critiques', 'Checks the answer and pushes back', sel(s.roles.critique, agentOpts, (v) => save({ roles: { critique: v, answer: v === 'claude' ? 'codex' : 'claude' } }).then(renderSettings))),
    row('Revise after critique', 'The answerer gets a final turn to fix what was caught', toggle(s.revise, (v) => save({ revise: v }))),
  );

  const agentCard = (a) => {
    const st = state.agents[a];
    const ch = state.choices[a];
    const cfg = s[a];
    const access = a === 'claude'
      ? row('Permissions', 'What Claude may do in your project folder', sel(cfg.permissionMode, ch.permissionModes.map((p) => [p.value, p.label]), (v) => save({ claude: { permissionMode: v } })))
      : row('Sandbox', 'What Codex may do in your project folder', sel(cfg.sandbox, ch.sandboxes.map((p) => [p.value, p.label]), (v) => save({ codex: { sandbox: v } })));
    return el('div', { className: 'card' },
      el('h3', {}, avatar(a), NAMES[a], el('span', { className: `dot ${st?.installed ? 'ok' : 'bad'}` }), el('span', { className: 'muted', textContent: st?.installed ? `CLI ${st.version || ''}` : 'CLI not found' })),
      row('Enabled', st?.installed ? '' : `Install the ${a} CLI and sign in first`, toggle(cfg.enabled, (v) => save({ [a]: { enabled: v } }))),
      row('Model', '', sel(cfg.model, ch.models.map((m) => [m.value, m.label]), (v) => save({ [a]: { model: v } }))),
      row('Effort', 'How hard it thinks', sel(cfg.effort, [['', 'Automatic'], ...ch.efforts.map((e) => [e, e])], (v) => save({ [a]: { effort: v } }))),
      access,
    );
  };

  const workdir = el('input', { className: 'field wide', value: s.workdir, placeholder: 'Defaults to the folder tandem started in' });
  workdir.onchange = () => save({ workdir: workdir.value.trim() });
  const turns = el('input', { className: 'field', type: 'number', min: 2, max: 12, value: s.maxTurns, style: 'min-width:90px;width:90px' });
  turns.onchange = () => save({ maxTurns: Number(turns.value) });
  const convo = el('div', { className: 'card' }, el('h3', { textContent: 'Conversation' }),
    row('Project folder', 'Where the agents run, and what they can read', workdir),
    row('Max back-and-forth turns', 'Stops debates and handoffs from running away', turns),
  );

  const phoneCard = el('div', { className: 'card' }, el('h3', {}, ico('phone', 17), 'Phone access'),
    row('Use tandem on your iPhone', 'Open it from your phone over your Wi-Fi or Tailscale, then Add to Home Screen', toggle(s.phoneAccess, async (v) => {
      await save({ phoneAccess: v });
      setTimeout(renderSettings, 700);
    })),
  );
  if (s.phoneAccess) {
    const body = el('div', { className: 'phone-body' }, el('span', { className: 'foot', textContent: 'Loading…' }));
    phoneCard.append(body);
    const load = (tries = 0) => api('/phone').then((p) => {
      body.replaceChildren();
      if (!p.urls?.length) return body.append(el('span', { className: 'foot', textContent: 'No network address found. Connect to Wi-Fi and reopen Settings.' }));
      body.append(el('div', { className: 'qr', html: p.qr }), el('div', {}, el('b', { textContent: 'Scan with your iPhone camera' }), el('span', { className: 'foot', style: 'display:block', textContent: 'Open it in Safari, tap Share, then Add to Home Screen. After that it launches full screen as its own app. Your Mac must be awake and on the same Wi-Fi (or Tailscale).' }), el('code', { textContent: p.urls[0] }), el('span', { className: 'foot', textContent: 'Anyone with this link can use your subscriptions while this is on. Turn it off when you are done.' })));
    }).catch(() => tries < 4 && setTimeout(() => load(tries + 1), 600));
    load();
  }

  const skillCard = el('div', { className: 'card' }, el('h3', { textContent: `Skills found (${state.skills.length})` }));
  const sl = el('div', { className: 'skill-list' });
  for (const k of state.skills.slice(0, 80)) sl.append(el('span', {}, el('i', { style: `--who:var(--${k.agent || 'you'});background:var(--who)` }), k.name));
  if (!state.skills.length) sl.append(el('span', { className: 'foot', textContent: 'None yet. Skills in ~/.claude/skills and ~/.codex/skills appear here and in the / menu.' }));
  skillCard.append(sl);

  wrap.append(el('h2', { textContent: 'Settings' }), el('p', { className: 'sub', textContent: 'tandem runs the official Claude and Codex command-line tools on this computer, using your own subscriptions. Nothing is sent anywhere else.' }),
    roles, agentCard('claude'), agentCard('codex'), convo, phoneCard, skillCard,
    el('p', { className: 'foot', html: `Your threads and notes live in <code>${state.home}</code>${state.mock ? ' · mock agents (demo mode)' : ''} · tandem ${state.version || ''}` }),
  );
}

/* ============================== events (SSE) ============================== */

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    const mine = state.thread && e.threadId === state.thread.id;
    if (e.type === 'message' && mine) appendMessage(e.message);
    if (e.type === 'plan' && mine) {
      state.live = e.plan;
      state.stageState = {};
      renderPlan();
      syncSend();
    }
    if (e.type === 'step' && mine) {
      state.stageState[e.stage] = e.state;
      renderPlan();
    }
    if (e.type === 'status' && mine) {
      state.working = e.state === 'working' ? e.agents : [];
      if (e.state === 'idle') {
        state.thread.busy = false;
        state.live = null;
        state.stageState = {};
      } else state.thread.busy = true;
      renderWorking();
      renderPlan();
      syncSend();
      renderRail();
      renderTopbar();
    }
    if (e.type === 'error' && mine) toast(e.error, 'bad');
    if (e.type === 'message' || e.type === 'status') refreshThreadsSoon();
  };
  es.onerror = () => { /* the browser reconnects on its own */ };
}

/* ============================== boot ============================== */

function renderAll() {
  renderRail();
  renderThreadPanel();
  renderTopbar();
  if (state.view === 'chat') renderChat();
  else if (state.view === 'memory') renderMemory();
  else renderSettings();
  if (state.view === 'chat') refreshPreview();
}

async function boot() {
  if (/Electron/i.test(navigator.userAgent)) document.body.classList.add('electron');
  try { if (localStorage.getItem('tandem.collapsed') === '1') document.body.classList.add('collapsed'); } catch { /* ignore */ }
  $('#scrim').onclick = () => {
    document.body.classList.remove('drawer');
    $('#scrim').hidden = true;
  };
  const s = await api('/state');
  Object.assign(state, { version: s.version, mock: s.mock, agents: s.agents, settings: s.settings, choices: s.choices, roles: s.roles, home: s.home });
  state.skills = await api('/skills').catch(() => []);
  state.threads = await api('/threads');
  const wanted = localStorage.getItem('tandem.thread');
  const first = state.threads.find((t) => t.id === wanted) || state.threads[0];
  if (first) state.thread = await api(`/threads/${first.id}`);
  state.working = [];
  renderAll();
  scrollDown(true);
  connect();
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') (e.preventDefault(), newThread());
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') (e.preventDefault(), toggleThreads());
  });
}

boot().catch((e) => {
  document.body.append(el('pre', { style: 'padding:24px;color:#ff7b8c;white-space:pre-wrap', textContent: `tandem could not start: ${e.message}` }));
});
