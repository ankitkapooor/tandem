import { renderMarkdown } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const NAMES = { user: 'You', claude: 'Claude', codex: 'Codex', system: 'Tandem' };
const INITIAL = { user: 'Y', claude: 'C', codex: 'X', system: '!' };

const state = {
  threads: [],
  currentId: null,
  view: 'thread',
  thread: null,
  agents: {},
  settings: null,
  mock: false,
  target: 'auto',
  loop: false,
  working: null, // agent name while a turn runs
  busy: false,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};

/* ---------- code blocks ---------- */

let mermaidPromise;
let mermaidCount = 0;
function loadMermaid() {
  mermaidPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.js';
    s.onload = () => {
      const dark = !matchMedia('(prefers-color-scheme: light)').matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      resolve(window.mermaid);
    };
    s.onerror = () => reject(new Error('Diagrams need mermaid. Run "npm install" in the tandem folder.'));
    document.head.append(s);
  });
  return mermaidPromise;
}

function copyButton(getText) {
  const b = el('button', { textContent: 'Copy', type: 'button' });
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1400);
  };
  return b;
}

function codeBlock(lang, code) {
  const wrap = el('div', { className: 'codeblock' });
  const head = el('div', { className: 'codehead' }, el('span', { className: 'lang', textContent: lang || 'text' }));
  const source = el('pre', {}, el('code', { textContent: code }));
  wrap.append(head);

  const toggled = lang === 'mermaid' || lang === 'html';
  if (toggled) {
    const out = el('div');
    const show = (mode) => {
      source.hidden = mode !== 'code';
      out.hidden = mode === 'code';
      tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.m === mode)));
    };
    const tabs = ['view', 'code'].map((m) => {
      const b = el('button', { type: 'button', textContent: m === 'view' ? (lang === 'html' ? 'Preview' : 'Diagram') : 'Code' });
      b.dataset.m = m;
      b.onclick = () => show(m);
      return b;
    });
    head.append(...tabs);
    wrap.append(out, source);
    if (lang === 'html') {
      out.className = 'preview';
      // No same-origin: the preview cannot reach tandem's API or storage.
      const f = el('iframe', { title: 'HTML preview' });
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = code;
      out.append(f);
    } else {
      out.className = 'diagram';
      out.textContent = 'Drawing diagram...';
      loadMermaid()
        .then((m) => m.render(`mmd${mermaidCount++}`, code))
        .then(({ svg }) => (out.innerHTML = svg))
        .catch((e) => {
          out.className = 'diagram err';
          out.textContent = `Could not draw this diagram: ${e.message}`;
        });
    }
    show('view');
  } else {
    wrap.append(source);
  }
  head.append(copyButton(() => code));
  return wrap;
}

/* ---------- messages ---------- */

function messageNode(m, prev) {
  const first = !prev || prev.role !== m.role || m.ts - prev.ts > 3 * 60 * 1000;
  const body = el('div', { className: 'body' });
  if (m.role === 'user') body.append(...userText(m.text));
  else body.append(renderMarkdown(m.text, codeBlock));
  const time = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const row = el(
    'article',
    { className: `msg${first ? ' first' : ''}` },
    el('div', { className: 'avatar', textContent: INITIAL[m.role], ariaHidden: 'true' }),
    el('div', {}, el('div', { className: 'meta' }, el('b', { textContent: NAMES[m.role] }), el('time', { textContent: time })), body),
  );
  row.dataset.role = m.role;
  return row;
}

function userText(text) {
  return text.split(/\n{2,}/).map((p) => el('p', { textContent: p }));
}

function appendMessage(m) {
  const list = $('#messages');
  if (!list || !state.thread || state.thread.id !== state.currentId) return;
  const prev = state.thread.messages[state.thread.messages.length - 1];
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  $('.empty', list)?.remove();
  state.thread.messages.push(m);
  list.append(messageNode(m, prev));
  if (near || m.role === 'user') list.scrollTop = list.scrollHeight;
}

/* ---------- views ---------- */

function setTitle(text, actions = []) {
  $('#title').textContent = text;
  const box = $('#top-actions');
  box.replaceChildren(...actions);
}

function noAgents() {
  return !state.mock && Object.values(state.agents).every((a) => !a.installed);
}

function emptyThread() {
  const box = el(
    'div',
    { className: 'empty' },
    el('h2', { textContent: 'Ask one agent, or both' }),
    el('p', { textContent: 'Pick who gets your message below, or type @claude, @codex or @both. Turn on "Let them talk" and the two will reply to each other.' }),
  );
  if (noAgents()) {
    box.append(
      el('div', { className: 'note' }, 'No agent CLIs found on this computer. Install and log in to at least one:', el('br'), el('code', { textContent: 'npm install -g @anthropic-ai/claude-code' }), el('br'), el('code', { textContent: 'npm install -g @openai/codex' }), el('br'), 'Then run ', el('code', { textContent: 'claude' }), ' or ', el('code', { textContent: 'codex' }), ' once to sign in, and reload this page.'),
    );
  }
  return box;
}

function renderThread() {
  const t = state.thread;
  setTitle(t ? t.title : 'tandem', t ? [renameBtn(), deleteBtn()] : []);
  const view = $('#view');
  const list = el('div', { id: 'messages' });
  const status = el('div', { id: 'status', ariaLive: 'polite' });
  view.replaceChildren(list, status, composer());
  if (!t || !t.messages.length) list.append(emptyThread());
  else t.messages.forEach((m, i) => list.append(messageNode(m, t.messages[i - 1])));
  list.scrollTop = list.scrollHeight;
  updateStatus();
}

function renameBtn() {
  const b = el('button', { className: 'ghost', textContent: 'Rename' });
  b.onclick = async () => {
    const title = prompt('Thread name', state.thread.title);
    if (!title) return;
    await api(`/threads/${state.currentId}`, { method: 'PATCH', body: { title } });
    state.thread.title = title;
    $('#title').textContent = title;
    refreshThreads();
  };
  return b;
}

function deleteBtn() {
  const b = el('button', { className: 'ghost', textContent: 'Delete' });
  b.onclick = async () => {
    if (!confirm('Delete this thread? This cannot be undone.')) return;
    await api(`/threads/${state.currentId}`, { method: 'DELETE' });
    state.currentId = null;
    state.thread = null;
    await refreshThreads();
    const next = state.threads[0];
    if (next) openThread(next.id);
    else renderThread();
  };
  return b;
}

function composer() {
  const input = el('textarea', { id: 'input', rows: 1, placeholder: 'Message Claude, Codex, or both' });
  const send = el('button', { id: 'send', type: 'button' });
  const seg = el('div', { className: 'seg', role: 'group', ariaLabel: 'Send to' });
  [['auto', 'Auto'], ['claude', 'Claude'], ['codex', 'Codex'], ['both', 'Both']].forEach(([t, label]) => {
    const b = el('button', { type: 'button', textContent: label });
    b.dataset.t = t;
    b.onclick = () => {
      state.target = t;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.t === t)));
    };
    b.setAttribute('aria-pressed', String(state.target === t));
    seg.append(b);
  });
  const loop = el('input', { type: 'checkbox', checked: state.loop });
  loop.onchange = () => {
    state.loop = loop.checked;
    store.set('tandem.loop', loop.checked ? '1' : '0');
  };
  const turns = state.settings?.maxTurns ?? 4;
  const loopLabel = el('label', { className: 'loop', title: `They take turns, up to ${turns} replies` }, loop, `Let them talk (up to ${turns})`);

  const sync = () => {
    send.textContent = state.busy ? 'Stop' : 'Send';
    send.className = state.busy ? 'stop' : '';
    send.id = 'send';
    send.disabled = !state.busy && !input.value.trim();
  };
  const submit = async () => {
    if (state.busy) {
      await api(`/threads/${state.currentId}/stop`, { method: 'POST' }).catch(() => {});
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    if (!state.currentId) await newThread();
    const targets = state.target === 'both' ? ['claude', 'codex'] : state.target === 'auto' ? undefined : [state.target];
    input.value = '';
    input.style.height = 'auto';
    state.busy = true;
    composer.sync();
    try {
      await api(`/threads/${state.currentId}/send`, { method: 'POST', body: { text, targets, loop: state.loop } });
    } catch (e) {
      state.busy = false;
      composer.sync();
      appendMessage({ id: `e${Date.now()}`, role: 'system', text: e.message, ts: Date.now() });
    }
  };
  send.onclick = submit;
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    sync();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      submit();
    }
  };
  composer.sync = sync;
  sync();
  setTimeout(() => matchMedia('(pointer: fine)').matches && input.focus(), 0);
  return el('div', { id: 'composer' }, el('div', { className: 'box' }, input, el('div', { className: 'controls' }, seg, loopLabel, el('span', { className: 'spacer' }), send)));
}

function updateStatus() {
  const s = $('#status');
  if (s) {
    s.replaceChildren();
    if (state.working) {
      s.append(el('span', { className: 'riders' }, el('i'), el('i')), `${NAMES[state.working]} is working`);
    }
  }
  composer.sync?.();
}

function renderMemory() {
  setTitle('Memory');
  const notes = [];
  const list = el('div', { className: 'card' });
  const draw = () => {
    list.replaceChildren();
    if (!notes.length) list.append(el('p', { className: 'muted', textContent: 'No notes yet. Add something both agents should know.' }));
    notes.forEach((n, i) => {
      const del = el('button', { className: 'ghost', textContent: 'Remove' });
      del.onclick = async () => {
        notes.splice(i, 1);
        await api('/memory', { method: 'PUT', body: { notes } });
        draw();
      };
      list.append(el('div', { className: 'note-item' }, el('p', { textContent: n.text }), del));
    });
  };
  const input = el('textarea', { className: 'field', rows: 2, placeholder: 'For example: I prefer TypeScript and short answers.' });
  const add = el('button', { className: 'primary', textContent: 'Add note' });
  add.onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    notes.push({ text });
    const saved = await api('/memory', { method: 'PUT', body: { notes } });
    notes.splice(0, notes.length, ...saved.notes);
    input.value = '';
    draw();
  };
  $('#view').replaceChildren(
    el('div', { className: 'page' }, el('div', {},
      el('h2', { textContent: 'Shared memory' }),
      el('p', { className: 'sub', textContent: 'Notes both agents get at the start of a new session. They live on this computer only. Claude and Codex also keep reading their own skills and instruction files (CLAUDE.md, AGENTS.md) as usual.' }),
      list,
      el('div', { className: 'card' }, input, el('div', { className: 'row' }, add)),
    )),
  );
  api('/memory').then((m) => {
    notes.push(...m.notes);
    draw();
  });
}

function renderSettings() {
  setTitle('Settings');
  const s = state.settings;
  const save = async (patch) => {
    state.settings = await api('/settings', { method: 'PUT', body: patch });
  };
  const toggle = (checked, onchange) => el('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) });
  const select = (value, options, onchange) => {
    const sel = el('select', { className: 'field' }, ...options.map(([v, l]) => el('option', { value: v, textContent: l, selected: v === value })));
    sel.onchange = () => onchange(sel.value);
    return sel;
  };
  const text = (value, placeholder, onchange) => {
    const i = el('input', { className: 'field', value: value || '', placeholder });
    i.onchange = () => onchange(i.value.trim());
    return i;
  };
  const agentCard = (id, name, extra) => {
    const a = state.agents[id] || {};
    const hint = id === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex';
    return el('div', { className: 'card' },
      el('h3', {}, el('span', { className: `dot ${a.installed ? 'ok' : 'bad'}` }), name,
        el('span', { className: 'muted', textContent: a.installed ? a.version : 'not installed' })),
      a.installed ? null : el('p', { className: 'muted' }, 'Install it with ', el('code', { textContent: hint }), ', run it once to sign in, then reload.'),
      el('div', { className: 'row' }, el('label', { textContent: 'Enabled' }), toggle(s[id].enabled, (v) => save({ [id]: { enabled: v } }))),
      ...extra,
    );
  };
  const page = el('div', { className: 'page' }, el('div', {},
    el('h2', { textContent: 'Settings' }),
    agentCard('claude', 'Claude Code', [
      el('div', { className: 'row' }, el('label', { textContent: 'Permissions' }),
        select(s.claude.permissionMode, [['default', 'Ask first (read-only in chat)'], ['plan', 'Plan only'], ['acceptEdits', 'Allow file edits']], (v) => save({ claude: { permissionMode: v } }))),
      el('div', { className: 'row' }, el('label', { textContent: 'Model (optional)' }), text(s.claude.model, 'Leave blank for your default', (v) => save({ claude: { model: v } }))),
    ]),
    agentCard('codex', 'Codex', [
      el('div', { className: 'row' }, el('label', { textContent: 'Sandbox' }),
        select(s.codex.sandbox, [['read-only', 'Read-only'], ['workspace-write', 'Can edit files in the project folder']], (v) => save({ codex: { sandbox: v } }))),
      el('div', { className: 'row' }, el('label', { textContent: 'Model (optional)' }), text(s.codex.model, 'Leave blank for your default', (v) => save({ codex: { model: v } }))),
    ]),
    el('div', { className: 'card' },
      el('h3', { textContent: 'Conversation' }),
      el('div', { className: 'row' }, el('label', { textContent: 'Max agent replies' }),
        el('input', { className: 'field', type: 'number', min: 1, max: 12, value: s.maxTurns, onchange: (e) => save({ maxTurns: Number(e.target.value) }) })),
      el('div', { className: 'row' }, el('label', { textContent: 'Project folder' }),
        text(s.workdir, 'Where the agents run, e.g. /Users/you/code/app', (v) => save({ workdir: v }))),
      el('p', { className: 'muted', textContent: 'Agents can read and, if you allow it, change files in the project folder. Leave it blank to run in the folder where you started tandem.' }),
    ),
    el('div', { className: 'card' },
      el('h3', { textContent: 'Use it on your phone' }),
      el('p', { className: 'muted' }, 'Quit tandem and start it with ', el('code', { textContent: 'tandem --lan' }), '. It prints a private link for your phone. Both devices need to be on the same Wi-Fi or on Tailscale, and this computer has to stay awake. On iPhone, open the link in Safari and choose Share, then Add to Home Screen.'),
    ),
    el('p', { className: 'muted', textContent: `Your threads and notes are stored in ${state.home}.` }),
  ));
  $('#view').replaceChildren(page);
}

/* ---------- navigation ---------- */

function renderSidebar() {
  const nav = $('#thread-list');
  nav.replaceChildren(
    ...state.threads.map((t) => {
      const b = el('button', { className: `thread${t.busy ? ' busy' : ''}`, type: 'button' }, el('b', { textContent: t.title }), el('span', { textContent: t.preview || 'No messages yet' }));
      b.setAttribute('aria-current', String(state.view === 'thread' && t.id === state.currentId));
      b.onclick = () => openThread(t.id);
      return b;
    }),
  );
  document.querySelectorAll('.navbtn').forEach((b) => b.setAttribute('aria-current', String(state.view === b.dataset.view)));
}

async function refreshThreads() {
  state.threads = await api('/threads');
  const mine = state.thread && state.threads.find((t) => t.id === state.thread.id);
  if (mine && mine.title !== state.thread.title) {
    state.thread.title = mine.title;
    if (state.view === 'thread') $('#title').textContent = mine.title;
  }
  renderSidebar();
}

function closeDrawer() {
  document.body.classList.remove('drawer');
  $('#scrim').hidden = true;
}

async function openThread(id) {
  closeDrawer();
  state.view = 'thread';
  state.currentId = id;
  store.set('tandem.thread', id);
  state.thread = await api(`/threads/${id}`);
  state.busy = !!state.thread.busy;
  state.working = null;
  renderThread();
  renderSidebar();
}

async function newThread() {
  const t = await api('/threads', { method: 'POST' });
  state.currentId = t.id;
  state.thread = t;
  state.view = 'thread';
  store.set('tandem.thread', t.id);
  await refreshThreads();
  renderThread();
  return t;
}

function openView(view) {
  closeDrawer();
  state.view = view;
  if (view === 'memory') renderMemory();
  else renderSettings();
  renderSidebar();
}

/* ---------- live updates ---------- */

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.threadId !== state.currentId) {
      if (ev.type === 'message' || ev.type === 'status') refreshThreads();
      return;
    }
    if (ev.type === 'message') {
      if (state.view === 'thread') appendMessage(ev.message);
      refreshThreads();
    } else if (ev.type === 'status') {
      state.working = ev.agent;
      state.busy = ev.state === 'thinking';
      if (state.view === 'thread') updateStatus();
      refreshThreads();
    } else if (ev.type === 'error') {
      state.busy = false;
      state.working = null;
      if (state.view === 'thread') {
        appendMessage({ id: `e${Date.now()}`, role: 'system', text: ev.error, ts: Date.now() });
        updateStatus();
      }
    }
  };
  es.onerror = () => {
    // The browser reconnects by itself; reload the thread once it does.
    es.addEventListener('open', async () => {
      if (state.view === 'thread' && state.currentId) {
        const t = await api(`/threads/${state.currentId}`).catch(() => null);
        if (t) {
          state.thread = t;
          state.busy = !!t.busy;
          if (!t.busy) state.working = null;
          renderThread();
        }
      }
    }, { once: true });
  };
}

/* ---------- start ---------- */

async function init() {
  state.loop = store.get('tandem.loop') === '1';
  $('#new-thread').onclick = () => newThread();
  $('#menu').onclick = () => {
    document.body.classList.add('drawer');
    $('#scrim').hidden = false;
  };
  $('#scrim').onclick = closeDrawer;
  document.querySelectorAll('.navbtn').forEach((b) => (b.onclick = () => openView(b.dataset.view)));

  const info = await api('/state');
  Object.assign(state, { agents: info.agents, settings: info.settings, mock: info.mock, home: info.home });
  await refreshThreads();
  connect();

  const saved = store.get('tandem.thread');
  const start = state.threads.find((t) => t.id === saved) || state.threads[0];
  if (start) await openThread(start.id);
  else renderThread();
}

init().catch((e) => {
  $('#view').replaceChildren(el('div', { className: 'empty' }, el('h2', { textContent: 'Cannot reach tandem' }), el('p', { textContent: e.message })));
});
