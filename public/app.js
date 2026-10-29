import { $, el, ico, debounce, ago, dayLabel, fmtMs, popover, closePopover, toast, confirmDialog, announce } from './ui.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { codeBlock, resetDiagramTheme } from './blocks.js';

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
  stream: {}, // agent -> { text, status } while a reply is being written
  defaults: {}, // model each CLI uses when none is picked
  tab: 'general', // settings section
};

const NAMES = { claude: 'Claude', codex: 'Codex', user: 'You', system: 'tandem' };
const LETTER = { claude: 'C', codex: 'X', user: 'Y', system: '!' };
const MODE_GLYPH = { solo: '', relay: '→', parallel: '+', debate: '⇄' };
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

const dotFor = (who) => {
  const d = el('span', { className: 'dot' });
  d.dataset.who = who;
  return d;
};
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
  rail.append(el('div', { className: 'logo', html: '<img src="/icon.svg" width="32" height="32" alt="tandem">' }));
  const items = [
    ['chat', 'chat', 'Threads'],
    ['memory', 'memory', 'Memory'],
    ['settings', 'sliders', 'Settings'],
  ];
  for (const [view, name, label] of items) {
    const b = el('button', { className: 'rail-btn', title: label, type: 'button' }, ico(name, 20));
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-current', String(state.view === view));
    b.onclick = () => go(view);
    rail.append(b);
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

  // The icon rail is hidden on a phone, so the same destinations live at the top of the drawer.
  const nav = el('div', { className: 'mobile-nav' });
  for (const [view, name, label] of [['chat', 'chat', 'Threads'], ['memory', 'memory', 'Memory'], ['settings', 'sliders', 'Settings']]) {
    const b = el('button', { type: 'button' }, ico(name, 17), el('span', { textContent: label }));
    b.setAttribute('aria-pressed', String(state.view === view));
    b.onclick = () => go(view);
    nav.append(b);
  }
  panel.append(nav);

  if (state.view !== 'chat') {
    const list = el('div', { id: 'thread-list' });
    const back = el('button', { className: 'opt', type: 'button' }, ico('arrow', 16), el('span', { className: 'grow', textContent: 'Back to threads' }));
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
  const ordered = [...rows.filter((t) => t.pinned), ...rows.filter((t) => !t.pinned)];
  for (const t of ordered) {
    const g = t.pinned ? 'Pinned' : dayLabel(t.updatedAt);
    if (g !== group) {
      group = g;
      list.append(el('div', { className: 'group-label', textContent: g }));
    }
    const busy = t.busy || (state.thread?.id === t.id && isWorking());
    const open = el(
      'button',
      { className: 'open', type: 'button' },
      el('div', { className: 'row1' }, t.pinned ? el('span', { className: 'pin' }, ico('pin', 13)) : null, el('b', { textContent: t.title }), busy ? el('span', { className: 'riders', html: '<i></i><i></i>' }) : Date.now() - t.updatedAt > 60e3 ? el('time', { textContent: ago(t.updatedAt) }) : null),
      t.preview ? el('span', { className: 'prev', textContent: t.preview }) : null,
    );
    open.onclick = () => openThread(t.id);
    const more = el('button', { className: 'icon-btn more', type: 'button', title: 'Thread options' }, ico('more', 18));
    more.setAttribute('aria-label', `Options for ${t.title}`);
    more.onclick = (e) => {
      e.stopPropagation();
      threadMenu(t, more);
    };
    const row = el('div', { className: 'thread' }, open, more);
    row.setAttribute('aria-current', String(state.thread?.id === t.id));
    row.oncontextmenu = (e) => (e.preventDefault(), threadMenu(t, more));
    list.append(row);
  }
}

// Rename / pin / delete, shared by the list and the top bar.
function threadMenu(t, anchor) {
  const item = (icon, label, fn, cls = '') => {
    const b = el('button', { className: `opt ${cls}`, type: 'button' }, ico(icon, 16), el('span', { className: 'grow', textContent: label }));
    b.onclick = () => (closePopover(), fn());
    return b;
  };
  popover(
    anchor,
    el('div', {},
      item('pencil', 'Rename', () => renameThread(t)),
      item('pin', t.pinned ? 'Unpin' : 'Pin to top', async () => {
        await api(`/threads/${t.id}`, { method: 'PATCH', body: { pinned: !t.pinned } });
        await refreshThreads();
      }),
      item('trash', 'Delete…', () => deleteThread(t), 'danger'),
    ),
    { place: 'bottom', align: 'end', label: `Options for ${t.title}`, width: 220 },
  );
}

function renameThread(t) {
  if (state.view !== 'chat') return;
  const rows = [...document.querySelectorAll('#thread-list .thread')];
  const idx = state.threads.filter((x) => x.pinned).concat(state.threads.filter((x) => !x.pinned)).findIndex((x) => x.id === t.id);
  const row = rows[idx];
  if (!row || !row.offsetParent) {
    // Panel hidden (collapsed or phone): rename from the title instead.
    return $('#topbar .title')?.click();
  }
  const input = el('input', { className: 'rename', value: t.title, maxLength: 80 });
  input.setAttribute('aria-label', 'Thread name');
  row.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== t.title) await api(`/threads/${t.id}`, { method: 'PATCH', body: { title: v } }).catch(() => {});
    refreshThreads();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

async function deleteThread(t) {
  const ok = await confirmDialog({ title: 'Delete this thread?', body: `“${t.title}” and everything in it will be removed. This cannot be undone.`, confirm: 'Delete thread' });
  if (!ok) return;
  await api(`/threads/${t.id}`, { method: 'DELETE' });
  if (state.thread?.id === t.id) state.thread = null;
  await refreshThreads();
  if (!state.thread && state.threads[0]) await openThread(state.threads[0].id);
  else renderAll();
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
    bar.append(el('div', { className: 'title' }));
    return;
  }
  const t = state.thread;
  const title = el('h1', { className: 'title', textContent: t ? t.title : 'tandem' });
  if (t) {
    title.title = 'Click to rename';
    title.onclick = () => {
      title.contentEditable = 'true';
      title.setAttribute('role', 'textbox');
      title.setAttribute('aria-label', 'Thread name');
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
    const more = el('button', { className: 'icon-btn', type: 'button', title: 'Thread options' }, ico('more', 20));
    more.setAttribute('aria-label', 'Thread options');
    more.onclick = () => threadMenu(state.threads.find((x) => x.id === t.id) || { id: t.id, title: t.title, pinned: false }, more);
    bar.append(more);
  }
}

/* ============================== chat view ============================== */

let stickToBottom = true;

function scrollDown(force) {
  const s = $('#scroller');
  if (!s) return;
  if (force || stickToBottom) s.scrollTo({ top: s.scrollHeight, behavior: 'auto' });
}

function renderChat() {
  const page = $('#page');
  page.replaceChildren();
  const scroller = el('div', { id: 'scroller' }, el('div', { id: 'messages', role: 'log' }));
  scroller.setAttribute('aria-label', 'Messages');
  scroller.firstChild.setAttribute('aria-live', 'off');
  const jump = el('button', { className: 'jump', type: 'button', hidden: true }, ico('down', 16), 'Latest');
  jump.onclick = () => ((stickToBottom = true), scrollDown(true));
  scroller.onscroll = () => {
    $('#topbar')?.classList.toggle('scrolled', scroller.scrollTop > 4);
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
    const last = t.messages[t.messages.length - 1];
    const lastSystem = last?.role === 'system' && !isWorking() ? last : null;
    for (const m of t.messages) {
      const d = new Date(m.ts).toDateString();
      if (d !== day) {
        day = d;
        box.append(el('div', { className: 'day', textContent: dayLabel(m.ts) === 'Today' ? 'Today' : new Date(m.ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }));
        prev = null;
      }
      box.append(messageNode(m, prev, m === lastSystem));
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

const failText = (t) => t.replace(/^(Claude|Codex) could not answer:\s*/, '').trim();

function errorNode(m, latest) {
  const agent = m.meta?.agent || /^(Claude|Codex)/.exec(m.text)?.[1]?.toLowerCase();
  const who = agent ? NAMES[agent] : 'An agent';
  const kind = m.meta?.kind || (/not logged in|\/login/i.test(m.text) ? 'auth' : 'other');
  const hint =
    kind === 'auth'
      ? el('small', { html: `Sign in once in Terminal: run <code>${agent === 'codex' ? 'codex login' : 'claude'}</code>${agent === 'codex' ? '' : ', then type <code>/login</code>'}. Then try again.` })
      : kind === 'missing'
        ? el('small', { html: `Install the ${who} command-line tool, sign in, then try again.` })
        : null;
  const acts = el('div', { className: 'acts' });
  if (latest && m.meta?.agent) {
    const again = el('button', { className: 'btn sm', type: 'button' }, ico('refresh', 15), kind === 'auth' ? ' I’ve signed in, try again' : ' Try again');
    again.style.display = 'inline-flex';
    again.style.gap = '6px';
    again.style.alignItems = 'center';
    again.onclick = async () => {
      again.disabled = true;
      try {
        if (kind !== 'other') state.agents = await api('/agents').catch(() => state.agents);
        stickToBottom = true;
        await api(`/threads/${state.thread.id}/send`, { method: 'POST', body: { retry: true, plan: { stages: [[{ agent: m.meta.agent, role: m.meta.role || 'answer' }]] } } });
      } catch (e) {
        again.disabled = false;
        toast(e.message, 'bad');
      }
    };
    acts.append(again);
  }
  const box = el('div', { className: 'alert', role: 'alert' }, ico('alert', 18), el('div', { className: 'grow' }, el('b', { textContent: `${who} couldn’t answer` }), el('span', { className: 'why', textContent: failText(m.text) }), hint, acts.childNodes.length ? acts : null));
  return box;
}

function metaRow(who, role, status) {
  const meta = el('div', { className: 'meta' }, el('span', { className: 'dot' }), el('b', { textContent: NAMES[who] || who }));
  if (role) meta.append(el('span', { className: 'role', textContent: (state.roles[role] || role).toLowerCase() }));
  if (status) meta.append(status);
  return meta;
}

function messageNode(m, prev, latestError = false) {
  const who = m.role;
  const first = !prev || prev.role !== who || m.ts - prev.ts > 5 * 60e3 || who === 'system' || (m.meta && prev.meta && prev.meta.step !== m.meta.step);
  const node = el('div', { className: `msg ${first ? 'first' : ''}` });
  node.dataset.who = who;
  node.dataset.id = m.id;
  if (who === 'system') {
    node.append(errorNode(m, latestError));
    return node;
  }
  const body = el('div', { className: 'body' });
  body.append(renderMarkdown(m.text, codeBlock));
  if (m.meta?.attachments?.length) body.append(el('div', { className: 'msg-files' }, ...m.meta.attachments.map((a) => attachChip(a, false))));
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
  const info = [new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), m.meta?.ms ? fmtMs(m.meta.ms) : '', m.meta?.of > 1 ? `step ${m.meta.step} of ${m.meta.of}` : ''].filter(Boolean).join(' · ');
  node.append(metaRow(who, m.meta?.role), body, el('div', { className: 'foot-row' }, who === 'user' ? null : el('span', { className: 'nfo', textContent: info }), copy, who === 'user' ? el('span', { className: 'nfo', textContent: info }) : null));
  // Touch has no hover, so tapping a message reveals its time and copy button.
  node.addEventListener('click', (e) => {
    if (!matchMedia('(pointer: coarse)').matches || e.target.closest('a, button, summary, iframe, .codeblock')) return;
    node.classList.toggle('tapped');
  });
  return node;
}

// While a reply is being written, code blocks stay plain so diagrams are not redrawn on every word.
const streamCode = (lang, code) => codeBlock(lang === 'mermaid' || lang === 'html' ? 'text' : lang, code);

function liveStep(a) {
  const si = Object.keys(state.stageState).find((k) => state.stageState[k] === 'running' && state.live?.stages[k]?.some((s) => s.agent === a));
  return si != null ? state.live.stages[si].find((s) => s.agent === a) : state.live?.stages.flat().find((s) => s.agent === a);
}

function liveNode(a) {
  const node = el('div', { className: 'msg live first' });
  node.dataset.who = a;
  node.dataset.live = a;
  const step = liveStep(a);
  const status = el('span', { className: 'status-line', style: 'margin-left:auto' }, el('i'), el('span', { className: 'st', textContent: 'Thinking' }));
  status.firstChild.style.setProperty('--who', `var(--${a})`);
  node.append(metaRow(a, step?.role, status), el('div', { className: 'body' }));
  return node;
}

function paintStream() {
  for (const a of state.working) {
    const node = document.querySelector(`.msg.live[data-live="${a}"]`);
    if (!node) continue;
    const st = state.stream[a] || { text: '', status: '' };
    const body = node.querySelector('.body');
    if (st.text !== node.dataset.painted) {
      node.dataset.painted = st.text;
      body.replaceChildren(st.text ? renderMarkdown(st.text, streamCode) : '');
      body.classList.toggle('has', !!st.text);
    }
    node.querySelector('.st').textContent = st.status ? `${st.status}…` : 'Thinking…';
  }
  scrollDown();
}
let paintQueued = false;
const schedulePaint = () => {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => ((paintQueued = false), paintStream()));
};

function renderWorking() {
  $$('.msg.live').forEach((n) => n.remove());
  const box = $('#messages');
  if (!box || state.view !== 'chat' || !state.working.length) return;
  for (const a of state.working) box.append(liveNode(a));
  paintStream();
}
const $$ = (sel) => [...document.querySelectorAll(sel)];

function appendMessage(m) {
  if (!state.thread || state.thread.messages.some((x) => x.id === m.id)) return;
  const prev = state.thread.messages[state.thread.messages.length - 1] || null;
  state.thread.messages.push(m);
  if (m.role === 'claude' || m.role === 'codex') {
    delete state.stream[m.role];
    announce(`${NAMES[m.role]} replied: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const box = $('#messages');
  if (!box || state.view !== 'chat') return;
  if (state.thread.messages.length === 1) return renderMessages();
  document.querySelector(`.msg.live[data-live="${m.role}"]`)?.remove();
  // A fresh error is the latest one, so the older ones lose their retry button.
  if (m.role === 'system') $$('.msg[data-who="system"] .acts').forEach((n) => n.remove());
  const live = $$('.msg.live');
  const node = messageNode(m, prev, m.role === 'system');
  if (live.length) live[0].before(node);
  else box.append(node);
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
  const first = (() => { try { return !localStorage.getItem('tandem.hinted'); } catch { return false; } })();
  dock.append(el('div', { className: 'plan', id: 'plan' }), buildComposer(), first ? el('div', { className: 'hint', html: '<kbd>@</kbd> direct an agent · <kbd>/</kbd> add a skill · <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line' }) : null);
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
  const b = el(interactive ? 'button' : 'div', { className: `step ${status || ''}` }, dotFor(s.agent), el('span', { textContent: NAMES[s.agent] }), el('span', { className: 'role', textContent: (state.roles[s.role] || s.role).toLowerCase() }));
  if (status === 'done') b.append(el('span', { className: 'state' }, ico('check', 14)));
  if (interactive) {
    b.type = 'button';
    b.title = 'Change this step';
    b.onclick = () => editStep(b, i);
  }
  return b;
}

// The strip is only worth the space when the plan is not simply the default one.
const planVisible = () => !!(isWorking() && state.live) || !!state.edited || state.preview?.source === 'message';

function renderPlan() {
  const box = $('#plan');
  if (!box) return;
  box.replaceChildren();
  refreshRoute();
  const plan = currentPlan();
  const running = isWorking() && state.live;
  if (!plan || !planVisible()) return;
  box.append(el('span', { className: 'plan-label', textContent: running ? 'Running' : state.edited ? 'Your plan' : 'From your message' }));
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
      reset.onclick = () => ((state.edited = null), renderPlan(), refreshPreview());
      box.append(reset);
    }
  }
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
      const o = el('button', { className: 'opt', type: 'button' }, dotFor(a), el('span', { className: 'grow', textContent: NAMES[a] }), step.agent === a ? el('span', { className: 'tick' }, ico('check', 16)) : null);
      o.onclick = () => ((step.agent = a), commit(), draw());
      root.append(o);
    }
    root.append(el('div', { className: 'pop-title', textContent: 'Job' }));
    const seg = el('div', { className: 'pop-row' });
    for (const r of Object.keys(state.roles)) {
      const b = el('button', { className: 'step', type: 'button', textContent: state.roles[r] });
      b.setAttribute('aria-pressed', String(step.role === r));
      if (step.role === r) b.style.borderColor = 'var(--text)';
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

  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  picker.onchange = () => (addFiles([...picker.files]), (picker.value = ''));
  const plus = el('button', { className: 'plus', type: 'button', title: 'Attach files, skills and mentions' }, ico('plus', 18));
  plus.setAttribute('aria-label', 'Add files, skills or mentions');
  plus.onclick = () => {
    const item = (icon, label, sub, fn) => {
      const b = el('button', { className: 'opt', type: 'button' }, ico(icon, 18), el('span', { className: 'grow' }, el('span', { textContent: label }), el('small', { textContent: sub })));
      b.onclick = () => (closePopover(), fn());
      return b;
    };
    const type = (ch) => () => {
      input.focus();
      const at = input.selectionStart;
      const pad = at > 0 && !/\s$/.test(input.value.slice(0, at)) ? ' ' : '';
      input.setRangeText(`${pad}${ch}`, at, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    };
    popover(plus, el('div', {}, item('clip', 'Add files', 'Documents, images, code', () => picker.click()), item('sparkle', 'Use a skill', 'From ~/.claude and ~/.codex', type('/')), item('chat', 'Direct an agent', '@claude, @codex or @both', type('@'))), { width: 270, label: 'Add to message' });
  };

  const route = el('button', { className: 'route', id: 'route', type: 'button' });
  route.onclick = () => routePanel(route);
  const send = el('button', { id: 'send', className: 'send', type: 'button', title: 'Send' }, ico('up', 19));
  send.setAttribute('aria-label', 'Send');
  const bar = el('div', { className: 'bar' }, plus, el('span', { className: 'grow' }), route, send, picker);
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
  setTimeout(() => (renderFiles(), refreshRoute()));
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
    const chip = el('span', { className: 'skill-chip' }, el('span', { textContent: s.name }), x);
    if (s.agent) chip.prepend(dotFor(s.agent));
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
  try { localStorage.setItem('tandem.hinted', '1'); } catch { /* ignore */ }
  $('.hint')?.remove();
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
      it.kind === 'agent' && it.who ? dotFor(it.who) : it.kind === 'agent' ? el('span', { className: 'dots' }, dotFor('claude'), dotFor('codex')) : it.skill?.agent ? dotFor(it.skill.agent) : ico('sparkle', 18),
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

/* ============================== route chip and panel ============================== */

const friendly = (id) => (id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^(\w)/, (c) => c.toUpperCase()).replace(/-/g, ' ');

function modelName(a) {
  const cfg = state.settings[a];
  const hit = state.choices[a].models.find((m) => m.value === cfg.model && m.value);
  if (hit) return hit.label;
  if (cfg.model) return cfg.model;
  return state.defaults?.[a] ? friendly(state.defaults[a]) : 'Default model';
}

function routeSummary() {
  const plan = currentPlan();
  const agents = plan ? [...new Set(plan.stages.flat().map((s) => s.agent))] : enabledAgents();
  const mode = state.edited ? 'custom' : plan?.mode && plan.mode !== 'custom' ? plan.mode : state.mode;
  const glyph = agents.length < 2 ? '' : state.edited ? '→' : MODE_GLYPH[mode] || '→';
  return { agents, text: agents.map((a) => NAMES[a]).join(` ${glyph} `) || 'No agent on', mode: state.edited ? 'Custom' : agents.length < 2 ? '' : MODE_LABEL[mode] || '' };
}

function refreshRoute() {
  const b = $('#route');
  if (!b || !state.settings) return;
  const r = routeSummary();
  b.replaceChildren(el('span', { className: 'dots' }, ...r.agents.map(dotFor)), el('span', { className: 'txt', textContent: r.text }), r.mode ? el('small', { textContent: r.mode }) : null, ico('chevron', 14));
  const detail = r.agents.map((a) => `${NAMES[a]} ${modelName(a)}${state.settings[a].effort ? ` ${state.settings[a].effort}` : ''}`).join(', ');
  b.title = detail || 'Choose who answers';
  b.setAttribute('aria-label', `Who answers: ${r.text}. ${r.mode}. ${detail}. Change`);
  b.setAttribute('aria-haspopup', 'dialog');
}

async function patchSettings(patch) {
  state.settings = await api('/settings', { method: 'PUT', body: patch });
  refreshPreview();
  refreshRoute();
}

function routePanel(anchor) {
  const root = el('div');
  let open = null; // agent whose model list is expanded
  const draw = () => {
    root.replaceChildren();
    root.append(el('div', { className: 'pop-title', textContent: 'How they work together' }));
    const seg = el('div', { className: 'seg full', role: 'group' });
    for (const m of Object.keys(MODE_LABEL)) {
      const b = el('button', { type: 'button', textContent: MODE_LABEL[m] });
      b.setAttribute('aria-pressed', String(state.mode === m && !state.edited));
      b.onclick = () => {
        state.mode = m;
        state.edited = null;
        refreshPreview();
        refreshRoute();
        draw();
      };
      seg.append(b);
    }
    root.append(seg, el('div', { className: 'foot', style: 'padding:0 12px 6px', textContent: state.edited ? 'You customised the steps for this message.' : MODE_TIP[state.mode] }));
    const custom = el('button', { className: 'opt', type: 'button' }, ico('sliders', 16), el('span', { className: 'grow' }, el('span', { textContent: 'Customize steps' }), el('small', { textContent: 'Choose who goes when, and in what role' })));
    custom.onclick = () => {
      if (!state.edited && state.preview) state.edited = structuredClone(state.preview);
      closePopover();
      renderPlan();
    };
    root.append(custom);

    for (const a of ['claude', 'codex']) {
      const cfg = state.settings[a];
      const ch = state.choices[a];
      const installed = state.agents[a]?.installed;
      const head = el('div', { className: 'sec-head' }, dotFor(a), el('span', { className: 'grow', textContent: NAMES[a] }));
      const sw = el('label', { className: 'switch', title: `${NAMES[a]} on or off` }, el('input', { type: 'checkbox', checked: cfg.enabled }), el('i'));
      sw.firstChild.setAttribute('aria-label', `${NAMES[a]} enabled`);
      sw.firstChild.onchange = async (e) => (await patchSettings({ [a]: { enabled: e.target.checked } }), draw());
      head.append(sw);
      root.append(head);
      const row = el('button', { className: 'opt', type: 'button' }, el('span', { className: 'grow' }, el('span', { textContent: modelName(a) }), el('small', { textContent: installed ? `${cfg.effort ? `${cfg.effort} effort` : 'Automatic effort'}${cfg.enabled ? '' : ' · off'}` : 'CLI not installed' })), ico('chevron', 14));
      row.setAttribute('aria-expanded', String(open === a));
      row.onclick = () => ((open = open === a ? null : a), draw());
      root.append(row);
      if (open === a) {
        root.append(el('div', { className: 'pop-title', textContent: 'Model' }));
        for (const m of ch.models) {
          const label = m.value ? m.label : state.defaults?.[a] ? `Default · ${friendly(state.defaults[a])}` : 'Default';
          const o = el('button', { className: 'opt', type: 'button' }, el('span', { className: 'grow', textContent: label }), cfg.model === m.value ? el('span', { className: 'tick' }, ico('check', 16)) : null);
          o.onclick = async () => (await patchSettings({ [a]: { model: m.value } }), draw());
          root.append(o);
        }
        if (a === 'codex') {
          const customModel = el('input', { className: 'pop-input', placeholder: 'Or type a model name', value: ch.models.some((m) => m.value === cfg.model) ? '' : cfg.model });
          customModel.setAttribute('aria-label', 'Custom Codex model');
          customModel.onchange = async () => (await patchSettings({ codex: { model: customModel.value.trim() } }), draw());
          root.append(customModel);
        }
        root.append(el('div', { className: 'pop-title', textContent: 'Effort' }));
        const eff = el('div', { className: 'seg', style: 'margin:0 6px 8px;flex-wrap:wrap' });
        for (const e of ['', ...ch.efforts]) {
          const b = el('button', { type: 'button', textContent: e || 'Auto' });
          b.setAttribute('aria-pressed', String((cfg.effort || '') === e));
          b.onclick = async () => (await patchSettings({ [a]: { effort: e } }), draw());
          eff.append(b);
        }
        root.append(eff);
      }
    }
  };
  draw();
  popover(anchor, root, { width: 340, align: 'end', label: 'Who answers and how' });
}

/* ============================== shared page pieces ============================== */

// One save model for every settings and memory page: changes apply at once and a quiet stamp confirms them.
function pageHead(title) {
  const stamp = el('span', { className: 'saved' }, ico('check', 14), 'Saved');
  stamp.setAttribute('role', 'status');
  let t;
  const flash = () => {
    stamp.classList.add('in');
    clearTimeout(t);
    t = setTimeout(() => stamp.classList.remove('in'), 1800);
  };
  return { node: el('div', { className: 'page-head' }, el('h2', { textContent: title }), el('span', { className: 'grow' }), stamp), flash };
}

function picker(value, options, onchange, label) {
  const b = el('button', { className: 'picker', type: 'button' }, el('span', { textContent: options.find(([v]) => v === value)?.[1] ?? value }), ico('chevron', 14));
  b.setAttribute('aria-haspopup', 'listbox');
  b.setAttribute('aria-label', `${label}: ${options.find(([v]) => v === value)?.[1] ?? value}`);
  b.onclick = () => {
    const list = el('div', { role: 'listbox' });
    for (const [v, l] of options) {
      const o = el('button', { className: 'opt', type: 'button', role: 'option' }, el('span', { className: 'grow', textContent: l }), v === value ? el('span', { className: 'tick' }, ico('check', 16)) : null);
      o.setAttribute('aria-selected', String(v === value));
      o.onclick = () => (closePopover(), v !== value && onchange(v));
      list.append(o);
    }
    popover(b, list, { place: 'bottom', width: Math.max(220, b.offsetWidth), label });
  };
  return b;
}

function toggle(checked, onchange, label) {
  const i = el('input', { type: 'checkbox', checked });
  i.setAttribute('aria-label', label);
  i.onchange = () => onchange(i.checked);
  return el('label', { className: 'switch' }, i, el('i'));
}

const row = (what, sub, control) => el('div', { className: 'setting' }, el('div', { className: 'what' }, el('b', { textContent: what }), sub ? el('span', { textContent: sub }) : null), el('div', { className: 'control' }, control));

/* ============================== memory view ============================== */

async function renderMemory() {
  const page = $('#page');
  const mem = await api('/memory');
  let notes = mem.notes;
  const wrap = el('div', { className: 'page-inner' });
  page.replaceChildren(el('div', { className: 'page-scroll' }, wrap));
  const head = pageHead('Memory');
  const save = debounce(async () => {
    await api('/memory', { method: 'PUT', body: { notes } }).then(head.flash).catch((e) => toast(e.message, 'bad'));
  }, 400);
  const list = el('div', { className: 'card' });
  const draw = () => {
    list.replaceChildren();
    if (!notes.length) list.append(el('div', { className: 'empty-list', textContent: 'Nothing saved yet. Add something both agents should always know.' }));
    notes.forEach((n, i) => {
      const t = el('textarea', { className: 'field', value: n.text, rows: 2 });
      t.setAttribute('aria-label', `Note ${i + 1}`);
      t.oninput = () => ((n.text = t.value), save());
      const d = el('button', { className: 'icon-btn', type: 'button', title: 'Delete note' }, ico('trash', 17));
      d.setAttribute('aria-label', `Delete note ${i + 1}`);
      d.onclick = () => (notes.splice(i, 1), save(), draw());
      list.append(el('div', { className: 'note-item' }, t, d));
    });
  };
  const add = el('button', { className: 'btn', type: 'button', textContent: 'Add note' });
  add.onclick = () => {
    notes.unshift({ id: `n${Date.now()}`, text: '', ts: Date.now() });
    draw();
    list.querySelector('textarea')?.focus();
  };
  wrap.append(head.node, el('p', { className: 'sub', textContent: 'Notes here are shared with both agents on every message, so they stop asking the same things.' }), el('div', {}, add), list);
  draw();
}

/* ============================== settings view ============================== */

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  try { localStorage.setItem('tandem.theme', mode); } catch { /* ignore */ }
  requestAnimationFrame(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.body).backgroundColor);
    resetDiagramTheme();
  });
}
const themeMode = () => { try { return localStorage.getItem('tandem.theme') || 'system'; } catch { return 'system'; } };

const TABS = [['general', 'General'], ['agents', 'Agents'], ['phone', 'Phone'], ['skills', 'Skills']];

async function renderSettings() {
  const page = $('#page');
  const scroll = page.querySelector('.page-scroll');
  const keep = scroll?.scrollTop || 0;
  const wrap = el('div', { className: 'settings-layout' });
  page.replaceChildren(el('div', { className: 'page-scroll' }, wrap));
  const s = state.settings;
  const head = pageHead(TABS.find(([k]) => k === state.tab)[1]);

  const nav = el('nav', { className: 'settings-nav', 'aria-label': 'Settings sections' });
  for (const [k, l] of TABS) {
    const b = el('button', { type: 'button', textContent: l });
    b.setAttribute('aria-current', String(state.tab === k));
    b.onclick = () => ((state.tab = k), renderSettings());
    nav.append(b);
  }

  const save = async (patch, redraw = false) => {
    try {
      state.settings = await api('/settings', { method: 'PUT', body: patch });
      head.flash();
      if (redraw) renderSettings();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const agentOpts = [['claude', 'Claude'], ['codex', 'Codex (ChatGPT)']];
  const body = el('div', { className: 'settings-body' }, head.node);

  if (state.tab === 'general') {
    body.append(
      el('div', { className: 'card' }, el('h3', { textContent: 'Default roles' }),
        row('Answers', 'Replies first when you do not @mention anyone', picker(s.roles.answer, agentOpts, (v) => save({ roles: { answer: v, critique: v === 'claude' ? 'codex' : 'claude' } }, true), 'Answers')),
        row('Critiques', 'Checks the answer and pushes back', picker(s.roles.critique, agentOpts, (v) => save({ roles: { critique: v, answer: v === 'claude' ? 'codex' : 'claude' } }, true), 'Critiques')),
        row('Revise after critique', 'The answerer gets a final turn to fix what was caught', toggle(s.revise, (v) => save({ revise: v }), 'Revise after critique')),
      ),
    );
    const workdir = el('input', { className: 'field wide', value: s.workdir, placeholder: 'Defaults to the folder tandem started in' });
    workdir.setAttribute('aria-label', 'Project folder');
    workdir.onchange = () => save({ workdir: workdir.value.trim() });
    const turns = el('input', { className: 'field', type: 'number', min: 2, max: 12, value: s.maxTurns, style: 'min-width:90px;width:90px' });
    turns.setAttribute('aria-label', 'Max back-and-forth turns');
    turns.onchange = () => save({ maxTurns: Number(turns.value) });
    body.append(
      el('div', { className: 'card' }, el('h3', { textContent: 'Conversation' }),
        row('Project folder', 'Where the agents run, and what they can read', workdir),
        row('Max back-and-forth turns', 'Stops debates and handoffs from running away', turns),
      ),
      el('div', { className: 'card' }, el('h3', { textContent: 'Appearance' }),
        row('Theme', 'Follows your device unless you choose', picker(themeMode(), THEMES, (v) => (applyTheme(v), head.flash(), setTimeout(renderSettings, 30)), 'Theme')),
      ),
    );
    const del = el('button', { className: 'btn danger sm', type: 'button', textContent: 'Delete all threads…' });
    del.onclick = async () => {
      const n = state.threads.length;
      if (!n) return toast('There are no threads to delete');
      const ok = await confirmDialog({ title: `Delete all ${n} thread${n > 1 ? 's' : ''}?`, body: `Every conversation in ${state.home} will be removed. Memory notes and settings are kept. This cannot be undone.`, confirm: `Delete ${n} thread${n > 1 ? 's' : ''}` });
      if (!ok) return;
      for (const t of state.threads) await api(`/threads/${t.id}`, { method: 'DELETE' }).catch(() => {});
      state.thread = null;
      await refreshThreads();
      head.flash();
      toast('Threads deleted');
    };
    body.append(el('div', { className: 'card danger-zone' }, el('h3', { textContent: 'Danger zone' }), row('Delete all threads', `${state.threads.length} on this computer`, del)));
    body.append(el('p', { className: 'foot', html: `Your threads and notes live in <code>${state.home}</code>${state.mock ? ' · mock agents (demo mode)' : ''} · tandem ${state.version || ''}` }));
  }

  if (state.tab === 'agents') {
    body.append(el('p', { className: 'foot', textContent: 'tandem runs the official Claude and Codex command-line tools on this computer, using your own subscriptions. Nothing is sent anywhere else.' }));
    for (const a of ['claude', 'codex']) {
      const st = state.agents[a];
      const ch = state.choices[a];
      const cfg = s[a];
      const recheck = el('button', { className: 'btn quiet sm', type: 'button', textContent: 'Re-check' });
      recheck.onclick = async () => {
        state.agents = await api('/agents').catch(() => state.agents);
        toast(state.agents[a]?.installed ? `${NAMES[a]} CLI found` : `${NAMES[a]} CLI still not found`, state.agents[a]?.installed ? '' : 'bad');
        renderSettings();
      };
      const access = a === 'claude'
        ? row('Permissions', 'What Claude may do in your project folder', picker(cfg.permissionMode, ch.permissionModes.map((p) => [p.value, p.label]), (v) => save({ claude: { permissionMode: v } }, true), 'Claude permissions'))
        : row('Sandbox', 'What Codex may do in your project folder', picker(cfg.sandbox, ch.sandboxes.map((p) => [p.value, p.label]), (v) => save({ codex: { sandbox: v } }, true), 'Codex sandbox'));
      const modelOpts = ch.models.map((m) => [m.value, m.value ? m.label : state.defaults?.[a] ? `Default · ${friendly(state.defaults[a])}` : 'Default']);
      if (cfg.model && !modelOpts.some(([v]) => v === cfg.model)) modelOpts.push([cfg.model, cfg.model]);
      body.append(
        el('div', { className: 'card' },
          el('h3', {}, dotFor(a), NAMES[a], el('span', { className: 'status' }, el('span', { className: `dot ${st?.installed ? 'ok' : 'bad'}` }), el('span', { className: 'muted', textContent: st?.installed ? `CLI ${st.version || ''}` : 'CLI not found' }))),
          row('Enabled', st?.installed ? '' : `Install the ${a} CLI and sign in first`, st?.installed ? toggle(cfg.enabled, (v) => save({ [a]: { enabled: v } }), `${NAMES[a]} enabled`) : recheck),
          row('Model', 'Used when you do not pick one for a message', picker(cfg.model, modelOpts, (v) => save({ [a]: { model: v } }, true), `${NAMES[a]} model`)),
          row('Effort', 'How hard it thinks', picker(cfg.effort, [['', 'Automatic'], ...ch.efforts.map((e) => [e, e])], (v) => save({ [a]: { effort: v } }, true), `${NAMES[a]} effort`)),
          access,
        ),
      );
    }
  }

  if (state.tab === 'phone') {
    const phoneCard = el('div', { className: 'card' }, el('h3', {}, ico('phone', 17), 'iPhone access'),
      row('Use tandem on your iPhone', 'Open it from your phone over your Wi-Fi or Tailscale, then Add to Home Screen', toggle(s.phoneAccess, async (v) => {
        await save({ phoneAccess: v });
        setTimeout(renderSettings, 700);
      }, 'Phone access')),
    );
    if (s.phoneAccess) {
      const pb = el('div', { className: 'phone-body' }, el('span', { className: 'foot', textContent: 'Loading…' }));
      phoneCard.append(pb);
      const load = (tries = 0) => api('/phone').then((p) => {
        pb.replaceChildren();
        if (!p.urls?.length) return pb.append(el('span', { className: 'foot', textContent: 'No network address found. Connect to Wi-Fi and reopen this page.' }));
        pb.append(el('div', { className: 'qr', html: p.qr }), el('div', {}, el('b', { textContent: 'Scan with your iPhone camera' }), el('span', { className: 'foot', style: 'display:block', textContent: 'Open it in Safari, tap Share, then Add to Home Screen. After that it launches full screen as its own app. Your Mac must be awake and on the same Wi-Fi (or Tailscale).' }), el('code', { textContent: p.urls[0] }), el('span', { className: 'foot', textContent: 'Anyone with this link can use your subscriptions while this is on. Turn it off when you are done.' })));
      }).catch(() => tries < 4 && setTimeout(() => load(tries + 1), 600));
      load();
    }
    body.append(phoneCard);
  }

  if (state.tab === 'skills') {
    const skillCard = el('div', { className: 'card' }, el('h3', { textContent: `Skills found (${state.skills.length})` }));
    const sl = el('div', { className: 'skill-list' });
    for (const k of state.skills.slice(0, 120)) sl.append(el('span', {}, k.agent ? dotFor(k.agent) : null, k.name));
    if (!state.skills.length) sl.append(el('span', { className: 'foot', textContent: 'None yet. Skills in ~/.claude/skills and ~/.codex/skills appear here and in the / menu.' }));
    skillCard.append(sl);
    body.append(skillCard);
  }

  wrap.append(nav, body);
  page.querySelector('.page-scroll').scrollTop = keep;
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
    if (e.type === 'progress' && mine) {
      const st = (state.stream[e.agent] ||= { text: '', status: '' });
      if (e.reset) st.text = '';
      if (e.text) st.text += e.text;
      if (e.status) st.status = e.status;
      if (e.done) setTimeout(() => (delete state.stream[e.agent], renderWorking()), 250);
      else schedulePaint();
    }
    if (e.type === 'status' && mine) {
      state.working = e.state === 'working' ? e.agents : [];
      if (e.state === 'working') announce(`${e.agents.map((a) => NAMES[a]).join(' and ')} ${e.agents.length > 1 ? 'are' : 'is'} working`);
      if (e.state === 'idle') {
        state.thread.busy = false;
        state.live = null;
        state.stageState = {};
        state.stream = {};
      } else state.thread.busy = true;
      renderWorking();
      renderPlan();
      syncSend();
    }
    if (e.type === 'error' && mine) toast(e.error, 'bad');
    if (e.type === 'status' && e.state === 'idle') refreshThreadsSoon();
    if (e.type === 'message' || e.type === 'status') refreshThreadsSoon();
  };
  es.onerror = () => { /* the browser reconnects on its own */ };
}

/* ============================== boot ============================== */

function renderAll() {
  document.body.dataset.view = state.view;
  $('#topbar').classList.remove('scrolled');
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
  Object.assign(state, { defaults: s.defaults || {}, version: s.version, mock: s.mock, agents: s.agents, settings: s.settings, choices: s.choices, roles: s.roles, home: s.home });
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
