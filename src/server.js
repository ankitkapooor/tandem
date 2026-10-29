import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import * as store from './store.js';
import { agentStatus, CHOICES } from './agents.js';
import { isBusy, planFor, sendMessage, stopThread } from './router.js';
import { discoverSkills } from './skills.js';
import { MODES, ROLE_LABEL } from './plan.js';

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
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_UPLOAD = 40 * 1024 * 1024;

// Only files tandem itself saved are allowed through, so a request cannot point an agent at any other file.
function cleanAttachments(list) {
  const root = path.resolve(store.UPLOADS) + path.sep;
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ name: String(a?.name || ''), path: path.resolve(String(a?.path || '')), size: Number(a?.size) || 0 }))
    .filter((a) => a.name && a.path.startsWith(root) && fs.existsSync(a.path))
    .slice(0, 10);
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

export async function startServer({ port = 4777, lan = false, mock = false, open = true, quiet = false } = {}) {
  const token = getToken();
  const clients = new Set();
  const emit = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  };
  if (lan) store.saveSettings({ phoneAccess: true });
  let currentPort = port;

  const cookieToken = (req) => /(?:^|;\s*)tandem_token=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = (req.headers.host || '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    const loopback = LOOPBACK.has(req.socket.remoteAddress || '');

    if (loopback) {
      // Requests from this computer must be addressed to localhost, which blocks DNS rebinding.
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
    } else {
      // Anything from the network needs phone access switched on and the private token.
      if (!store.getSettings().phoneAccess) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Phone access is off. Turn it on in tandem, under Settings.');
        return;
      }
      const given = url.searchParams.get('token') || req.headers['x-tandem-token'] || cookieToken(req);
      if (given !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing or wrong token. Scan the QR code or open the full link from tandem.');
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
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, loopback);
      if (url.pathname === '/manifest.webmanifest') return serveManifest(res, loopback);
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

  async function phoneInfo(loopback) {
    const settings = store.getSettings();
    if (!loopback) return { enabled: settings.phoneAccess, urls: [] };
    const urls = settings.phoneAccess ? lanAddresses().map((ip) => `http://${ip}:${currentPort}/?token=${token}`) : [];
    const qr = urls[0] ? await QRCode.toString(urls[0], { type: 'svg', margin: 1, color: { dark: '#0b0c10', light: '#ffffff' } }) : '';
    return { enabled: settings.phoneAccess, urls, qr };
  }

  async function api(req, res, url, loopback) {
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
      return json(res, { version: VERSION, mock, agents: agentStatus(mock), settings: store.getSettings(), home: store.HOME, choices: CHOICES, modes: MODES, roles: ROLE_LABEL });
    }
    if (p === '/settings') {
      if (m === 'PUT') {
        const before = store.getSettings().phoneAccess;
        const saved = store.saveSettings(await readBody(req));
        json(res, saved);
        // Rebind only after the response is flushed, or the rebind would cut it off.
        if (saved.phoneAccess !== before) res.on('finish', () => setTimeout(() => rebind(saved.phoneAccess).catch(() => {}), 50));
        return;
      }
      return json(res, store.getSettings());
    }
    if (p === '/upload' && m === 'POST') {
      const name = path.basename(decodeURIComponent(String(url.searchParams.get('name') || 'file'))).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
      const dir = path.join(store.UPLOADS, store.newMessageId());
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      let size = 0;
      const out = fs.createWriteStream(file);
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_UPLOAD) {
            req.destroy();
            out.destroy();
            reject(Object.assign(new Error('That file is over 40 MB.'), { status: 413 }));
          }
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      return json(res, { name, path: file, size });
    }
    if (p === '/phone') return json(res, await phoneInfo(loopback));
    if (p === '/skills') return json(res, discoverSkills(store.getSettings().workdir));
    if (p === '/plan' && m === 'POST') {
      const body = await readBody(req);
      return json(res, planFor(String(body.text || ''), { mode: body.mode, settings: store.getSettings() }));
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
        const typed = String(body.text || '').trim();
        if (!typed && !body.attachments?.length) return json(res, { error: 'Empty message' }, 400);
        const text = typed || 'See the attached file.';
        if (!store.getThread(tid)) return json(res, { error: 'Thread not found' }, 404);
        if (isBusy(tid)) return json(res, { error: 'This thread is busy. Stop it first.' }, 409);
        // Runs in the background; progress arrives over /api/events.
        sendMessage(tid, { text, mode: body.mode, plan: body.plan, skills: body.skills, attachments: cleanAttachments(body.attachments) }, emit, mock).catch((e) =>
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

  // The Home Screen app on iOS keeps its own cookies, so on the phone the token rides in the start URL.
  function serveManifest(res, loopback) {
    fs.readFile(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8', (err, text) => {
      if (err) return res.writeHead(404).end();
      const manifest = JSON.parse(text);
      if (!loopback) manifest.start_url = `/?token=${token}`;
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(manifest));
    });
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
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  const listen = (host, p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

  // Binding to the network only while phone access is on avoids the macOS "accept incoming connections" prompt.
  async function rebind(phone) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    clients.clear();
    await listen(phone ? '0.0.0.0' : '127.0.0.1', currentPort);
  }

  const phone = store.getSettings().phoneAccess;
  try {
    await listen(phone ? '0.0.0.0' : '127.0.0.1', currentPort);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    currentPort = 0; // the usual port is taken: let the system pick one
    await listen(phone ? '0.0.0.0' : '127.0.0.1', 0);
  }
  currentPort = server.address().port;

  const local = `http://localhost:${currentPort}`;
  if (!quiet) {
    console.log(`\n  tandem ${mock ? '(mock agents) ' : ''}is running`);
    console.log(`  ${local}`);
    if (phone) for (const ip of lanAddresses()) console.log(`  On your phone: http://${ip}:${currentPort}/?token=${token}`);
    else console.log('  Want it on your phone? Turn on Phone access in Settings.');
    console.log('');
  }

  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', local] : [local];
    try {
      spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
      /* no browser available */
    }
  }
  return { server, port: currentPort, url: local };
}
