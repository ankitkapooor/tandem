import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { agentStatus } from './agents.js';
import { isBusy, sendMessage, stopThread } from './router.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function getToken() {
  const file = path.join(store.HOME, 'token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(18).toString('hex');
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  try {
    const r = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 3000 });
    const ip = r.status === 0 ? r.stdout.trim().split('\n')[0] : '';
    if (ip) out.unshift(ip);
  } catch {
    /* tailscale not installed */
  }
  return [...new Set(out)];
}

// Dependencies may be hoisted when installed through npx, so walk up looking for mermaid.
function findMermaid() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
    if (fs.existsSync(f)) return f;
    dir = path.dirname(dir);
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

export async function startServer({ port = 4777, lan = false, mock = false, open = true } = {}) {
  const token = getToken();
  const clients = new Set();
  const emit = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  };

  const cookieToken = (req) => /(?:^|;\s*)tandem_token=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = (req.headers.host || '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

    // Without --lan, only answer requests addressed to localhost (blocks DNS rebinding).
    if (!lan && !isLocalHost) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    // With --lan, every request needs the private token (cookie, header or ?token=).
    if (lan) {
      const given = url.searchParams.get('token') || req.headers['x-tandem-token'] || cookieToken(req);
      if (given !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing or wrong token. Open the full link printed by tandem.');
        return;
      }
      if (url.searchParams.get('token')) {
        res.setHeader('set-cookie', `tandem_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      }
    }
    // Block cross-site writes from other web pages.
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && new URL(origin).host.toLowerCase() !== host) {
      res.writeHead(403).end('Bad origin');
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  const json = (res, data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, '');
    const m = req.method;

    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (p === '/state' && m === 'GET') {
      return json(res, { mock, agents: agentStatus(mock), settings: store.getSettings(), home: store.HOME });
    }
    if (p === '/settings') {
      if (m === 'PUT') return json(res, store.saveSettings(await readBody(req)));
      return json(res, store.getSettings());
    }
    if (p === '/memory') {
      if (m === 'PUT') return json(res, store.saveMemory((await readBody(req)).notes));
      return json(res, store.getMemory());
    }
    if (p === '/threads') {
      if (m === 'POST') return json(res, store.createThread());
      return json(res, store.listThreads().map((t) => ({ ...t, busy: isBusy(t.id) })));
    }
    const t = /^\/threads\/([a-z0-9]+)(?:\/(send|stop))?$/i.exec(p);
    if (t) {
      const [, tid, action] = t;
      if (action === 'send' && m === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, { error: 'Empty message' }, 400);
        if (!store.getThread(tid)) return json(res, { error: 'Thread not found' }, 404);
        if (isBusy(tid)) return json(res, { error: 'This thread is busy. Stop it first.' }, 409);
        // Runs in the background; progress arrives over /api/events.
        sendMessage(tid, { text, targets: body.targets, loop: !!body.loop }, emit, mock).catch((e) =>
          emit({ type: 'error', threadId: tid, error: e.message }),
        );
        return json(res, { ok: true }, 202);
      }
      if (action === 'stop' && m === 'POST') {
        stopThread(tid);
        return json(res, { ok: true });
      }
      if (m === 'GET') {
        const thread = store.getThread(tid);
        return thread ? json(res, { ...thread, busy: isBusy(tid) }) : json(res, { error: 'Not found' }, 404);
      }
      if (m === 'PATCH') {
        const thread = store.getThread(tid);
        if (!thread) return json(res, { error: 'Not found' }, 404);
        thread.title = String((await readBody(req)).title || thread.title).slice(0, 80);
        return json(res, store.saveThread(thread));
      }
      if (m === 'DELETE') return json(res, { ok: store.deleteThread(tid) });
    }
    return json(res, { error: 'Not found' }, 404);
  }

  function serveStatic(res, pathname) {
    let file;
    if (pathname === '/vendor/mermaid.js') {
      file = findMermaid();
      if (!file) return res.writeHead(404).end('mermaid not installed');
    } else {
      const rel = path.normalize(pathname === '/' ? 'index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
      file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
  });

  const local = `http://localhost:${port}`;
  console.log(`\n  tandem ${mock ? '(mock agents) ' : ''}is running`);
  if (lan) {
    console.log(`  On this computer:  ${local}/?token=${token}`);
    for (const ip of lanAddresses()) console.log(`  On your phone:     http://${ip}:${port}/?token=${token}`);
    console.log('  Keep these links private. Anyone with one can run the agents on this machine.');
  } else {
    console.log(`  ${local}`);
    console.log('  Want it on your phone? Restart with: tandem --lan');
  }
  console.log('');

  if (open && !lan) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', local] : [local];
    try {
      spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
      /* no browser available */
    }
  }
  return server;
}
