import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const TIMEOUT_MS = 10 * 60 * 1000;

export const AGENTS = {
  claude: { id: 'claude', name: 'Claude', bin: 'claude' },
  codex: { id: 'codex', name: 'Codex', bin: 'codex' },
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

export function agentStatus(mock) {
  const out = {};
  for (const a of Object.values(AGENTS)) {
    out[a.id] = mock ? { installed: true, version: 'mock' } : checkCli(a.bin);
  }
  return out;
}

// Runs a process, feeds `input` on stdin, resolves with { code, stdout, stderr }.
function run(bin, args, { input, cwd, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (stdout += d));
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

function cwdFor(settings) {
  return settings.workdir && fs.existsSync(settings.workdir) ? settings.workdir : undefined;
}

// Claude Code: `claude -p` reads the prompt from stdin; --output-format json returns { result, session_id }.
async function runClaude({ prompt, fullPrompt, session, settings, signal }) {
  const c = settings.claude;
  const args = ['-p', '--output-format', 'json'];
  if (c.permissionMode && c.permissionMode !== 'default') args.push('--permission-mode', c.permissionMode);
  if (c.model) args.push('--model', c.model);
  if (session) args.push('--resume', session);
  const r = await run('claude', args, { input: session ? prompt : fullPrompt, cwd: cwdFor(settings), signal });
  let data = null;
  try {
    data = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
  } catch {
    /* fall through */
  }
  if (data && typeof data.result === 'string' && !data.is_error) {
    return { text: data.result.trim(), session: data.session_id || session };
  }
  const detail = (data && (data.result || data.error)) || r.stderr || r.stdout || `exit ${r.code}`;
  throw Object.assign(new Error(String(detail).trim().slice(0, 600)), { staleSession: !!session });
}

// Codex: `codex exec --json` streams JSONL events; the prompt is read from stdin with "-".
async function runCodex({ prompt, fullPrompt, session, settings, signal }) {
  const c = settings.codex;
  const args = ['exec'];
  if (session) args.push('resume', session);
  args.push('--json', '--skip-git-repo-check');
  if (c.sandbox) args.push('--sandbox', c.sandbox);
  if (c.model) args.push('--model', c.model);
  args.push('-');
  const r = await run('codex', args, { input: session ? prompt : fullPrompt, cwd: cwdFor(settings), signal });
  let thread = session;
  const messages = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
      const item = ev.item || ev.msg;
      if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) messages.push(item.text);
    } catch {
      /* ignore non-JSON lines */
    }
  }
  if (messages.length) return { text: messages.join('\n\n').trim(), session: thread };
  const detail = r.stderr || r.stdout || `exit ${r.code}`;
  throw Object.assign(new Error(String(detail).trim().slice(-600)), { staleSession: !!session });
}

// Fake agents so the UI and routing can be tried without any CLI installed.
async function runMock(agent, { prompt, session, signal }) {
  await new Promise((res, rej) => {
    const t = setTimeout(res, 500);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new Error('Stopped'));
    });
  });
  const last = prompt.split('\n').filter((l) => l.startsWith('[')).pop() || prompt;
  const lower = last.toLowerCase();
  let text = `(${agent} mock) I read: ${last.replace(/^\[[^\]]+\]:\s*/, '').slice(0, 120)}`;
  if (agent === 'claude' && lower.startsWith('[codex]')) {
    text += '\n\nLooks good to me. [[DONE]]';
  } else if (lower.includes('diagram')) {
    text = 'Here is a flow:\n\n```mermaid\nflowchart LR\n  You --> Bridge\n  Bridge --> Claude\n  Bridge --> Codex\n```';
  } else if (lower.includes('html') || lower.includes(' ui')) {
    text =
      'A tiny widget:\n\n```html\n<button onclick="this.textContent=\'clicked \'+(++window.n||(window.n=1))" style="padding:10px 16px;font:16px system-ui">Click me</button>\n```';
  } else if (lower.includes('code')) {
    text = 'Sure:\n\n```js\nexport function add(a, b) {\n  return a + b;\n}\n```';
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
      throw new Error(`${AGENTS[agent].name} CLI not found. Install it and log in, then try again.`);
    }
    // A stale or expired resume id: start a fresh session once.
    if (e.staleSession && ctx.session) return fn({ ...ctx, session: null });
    throw e;
  }
}
