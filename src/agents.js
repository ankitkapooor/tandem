import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { UPLOADS } from './store.js';

const TIMEOUT_MS = 10 * 60 * 1000;

export const AGENTS = {
  claude: { id: 'claude', name: 'Claude', bin: 'claude' },
  codex: { id: 'codex', name: 'Codex', bin: 'codex' },
};

// Choices offered in the pickers. Anything else can be typed in as a custom model name.
export const CHOICES = {
  claude: {
    models: [
      { value: '', label: 'Default' },
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: [
      { value: 'default', label: 'Read-only (asks are denied)' },
      { value: 'plan', label: 'Plan only' },
      { value: 'acceptEdits', label: 'Can edit files' },
      { value: 'auto', label: 'Auto' },
    ],
  },
  codex: {
    models: [{ value: '', label: 'Default' }],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    sandboxes: [
      { value: 'read-only', label: 'Read-only' },
      { value: 'workspace-write', label: 'Can edit files in the project folder' },
    ],
  },
};

export function checkCli(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0) return { installed: false, version: '' };
    return { installed: true, version: (r.stdout || r.stderr || '').trim().split('\n')[0] };
  } catch {
    return { installed: false, version: '' };
  }
}

// What each CLI uses when no model is picked, read from the CLIs' own config so the UI can say it.
const observed = {};
export function noteModel(agent, model) {
  if (model) observed[agent] = model;
}
export function defaultModels() {
  const out = { claude: observed.claude || '', codex: observed.codex || '' };
  const home = process.env.HOME || '';
  try {
    const j = JSON.parse(fs.readFileSync(`${home}/.claude/settings.json`, 'utf8'));
    if (typeof j.model === 'string' && j.model) out.claude = j.model;
  } catch { /* no settings file */ }
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(`${home}/.codex/config.toml`, 'utf8'));
    if (m) out.codex = m[1];
  } catch { /* no config */ }
  return out;
}

export function agentStatus(mock) {
  const out = {};
  for (const a of Object.values(AGENTS)) {
    out[a.id] = mock ? { installed: true, version: 'mock' } : checkCli(a.bin);
  }
  return out;
}

// Runs a process, feeds `input` on stdin, resolves with { code, stdout, stderr }.
function run(bin, args, { input, cwd, signal, onLine }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped'));
    const child = spawn(bin, args, { cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    let pending = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Stopped'));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

const cwdFor = (settings) => (settings.workdir && fs.existsSync(settings.workdir) ? settings.workdir : undefined);

// Only these errors mean "that saved session is gone", so only these trigger a fresh start.
const STALE = /no rollout found|no conversation found|session.*(not found|does not exist|expired)|invalid session/i;

// Claude Code: `claude -p` reads the prompt from stdin; --output-format json returns { result, session_id }.
export function claudeArgs({ session, settings, dirs = [], stream = false }) {
  const c = settings.claude;
  const args = stream ? ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : ['-p', '--output-format', 'json'];
  if (c.permissionMode && c.permissionMode !== 'default') args.push('--permission-mode', c.permissionMode);
  if (c.model) args.push('--model', c.model);
  if (c.effort) args.push('--effort', c.effort);
  if (session) args.push('--resume', session);
  if (dirs.length) args.push('--add-dir', ...dirs);
  return args;
}

const TOOL_STATUS = {
  Read: 'Reading files', Glob: 'Searching files', Grep: 'Searching code', Bash: 'Running a command', Edit: 'Editing a file', Write: 'Writing a file',
  MultiEdit: 'Editing files', WebSearch: 'Searching the web', WebFetch: 'Reading a web page', Task: 'Delegating a task', Agent: 'Delegating a task',
};

async function runClaude({ prompt, fullPrompt, session, settings, signal, onProgress }) {
  let final = null;
  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'result') final = ev;
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) noteModel('claude', ev.model);
    if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'message_start') onProgress?.({ reset: true });
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') onProgress?.({ status: TOOL_STATUS[e.content_block.name] || `Using ${e.content_block.name}` });
      if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') onProgress?.({ status: 'Thinking' });
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) onProgress?.({ text: e.delta.text, status: 'Writing' });
    }
  };
  const r = await run('claude', claudeArgs({ session, settings, dirs: [UPLOADS], stream: true }), {
    input: session ? prompt : fullPrompt,
    cwd: cwdFor(settings),
    signal,
    onLine,
  });
  let data = final;
  if (!data) {
    try { data = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()); } catch { /* fall through to the error path */ }
  }
  if (data && typeof data.result === 'string' && !data.is_error) {
    return { text: data.result.trim(), session: data.session_id || session };
  }
  const detail = (data && (data.result || data.error)) || r.stderr || r.stdout || `exit ${r.code}`;
  throw Object.assign(new Error(String(detail).trim().slice(0, 600)), { stale: STALE.test(String(detail)) });
}

// Codex: `codex exec --json` streams JSONL events; the prompt is read from stdin with "-".
// `codex exec resume` does not accept --sandbox, so sandbox and effort go through -c on both paths.
export function codexArgs({ session, settings }) {
  const c = settings.codex;
  const args = ['exec'];
  if (session) args.push('resume', session);
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${c.sandbox || 'read-only'}"`);
  if (c.model) args.push('-m', c.model);
  if (c.effort) args.push('-c', `model_reasoning_effort="${c.effort}"`);
  args.push('-');
  return args;
}

async function runCodex({ prompt, fullPrompt, session, settings, signal, onProgress }) {
  const live = [];
  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const item = ev.item || ev.msg;
    if (ev.type === 'item.started' && item?.type === 'command_execution') onProgress?.({ status: 'Running a command' });
    if (ev.type === 'item.started' && item?.type === 'reasoning') onProgress?.({ status: 'Thinking' });
    if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
      live.push(item.text);
      onProgress?.({ reset: true });
      onProgress?.({ text: live.join('\n\n'), status: 'Writing' });
    }
  };
  const r = await run('codex', codexArgs({ session, settings }), {
    input: session ? prompt : fullPrompt,
    cwd: cwdFor(settings),
    signal,
    onLine,
  });
  let thread = session;
  const messages = [];
  const problems = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
      const item = ev.item || ev.msg;
      if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) messages.push(item.text);
      if (ev.type === 'item.completed' && item?.type === 'error' && item.message) problems.push(item.message);
      if (ev.type === 'turn.failed' || ev.type === 'error') problems.push(ev.error?.message || ev.message || '');
    } catch {
      /* ignore non-JSON lines */
    }
  }
  if (messages.length) return { text: messages.join('\n\n').trim(), session: thread };
  const detail = problems.filter(Boolean).join(' ') || r.stderr || r.stdout || `exit ${r.code}`;
  throw Object.assign(new Error(String(detail).trim().slice(-600)), { stale: STALE.test(String(detail)) });
}

// Fake agents so the UI and routing can be tried without any CLI installed.
const wait = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new Error('Stopped'));
    });
  });

async function runMock(agent, { prompt, session, signal, onProgress }) {
  onProgress?.({ status: 'Thinking' });
  await wait(450, signal);
  if (process.env.TANDEM_MOCK_FAIL === agent) throw new Error(`${agent === 'claude' ? 'Claude' : 'Codex'} is not logged in. Run /login`);
  const role = /\(role: (\w+)\)/.exec(prompt)?.[1] || 'answer';
  const turns = prompt.split('\n').filter((l) => /^\[(You|Claude|Codex)/.test(l));
  const last = (turns.filter((l) => !l.startsWith(`[${agent === 'claude' ? 'Claude' : 'Codex'}`)).pop() || turns.pop() || '').replace(/^\[[^\]]+\]:\s*/, '');
  const lower = last.toLowerCase();
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const peer = agent === 'claude' ? 'Codex' : 'Claude';
  let text;
  if (role === 'critique') text = `**Critique.** ${peer}'s answer holds up, but it skips edge cases and never states its assumptions.\n\n- Strong: it answers the question directly\n- Weak: no evidence given\n- Missing: a concrete next step`;
  else if (role === 'merge') text = `**Merged view.** We agree on the core answer. We differ on emphasis, so my recommendation is to start with the simpler option.`;
  else if (role === 'revise') text = `**Revised.** Updated my answer to cover the edge cases and state the assumptions up front.`;
  else if (role === 'rebut') text = `I agree with part of that, but I'd push back on the main claim. [[DONE]]`;
  else if (lower.includes('diagram')) text = 'Here is the flow:\n\n```mermaid\nflowchart LR\n  You --> Plan\n  Plan --> Claude\n  Plan --> Codex\n  Claude --> Review\n  Codex --> Review\n```';
  else if (lower.includes('html') || lower.includes(' ui')) text = 'A tiny widget:\n\n```html\n<button onclick="this.textContent=\'clicked \'+(++window.n||(window.n=1))" style="padding:10px 16px;font:16px system-ui">Click me</button>\n```';
  else if (lower.includes('code')) text = 'Sure:\n\n```js\nexport function add(a, b) {\n  return a + b;\n}\n```';
  else text = `${name} here. On "${last.slice(0, 90)}": the short answer is yes, with caveats worth checking.`;
  const words = text.split(/(\s+)/);
  let sofar = '';
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3).join('');
    sofar += chunk;
    onProgress?.({ text: chunk, status: 'Writing' });
    await wait(40, signal);
  }
  return { text, session: session || `mock-${agent}` };
}

export async function runAgent(agent, ctx, mock) {
  if (mock) return runMock(agent, ctx);
  const fn = agent === 'claude' ? runClaude : runCodex;
  try {
    return await fn(ctx);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`${AGENTS[agent].name} CLI not found. Install it and sign in, then try again.`);
    }
    // The saved session is gone: start a fresh one once, with the whole thread as context.
    if (e.stale && ctx.session) return fn({ ...ctx, session: null });
    throw e;
  }
}
