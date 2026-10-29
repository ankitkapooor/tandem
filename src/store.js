import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.TANDEM_HOME || path.join(os.homedir(), '.tandem');
const THREADS = path.join(HOME, 'threads');

export const DEFAULT_SETTINGS = {
  maxTurns: 4,
  workdir: '',
  claude: { enabled: true, permissionMode: 'default', model: '' },
  codex: { enabled: true, sandbox: 'read-only', model: '' },
};

fs.mkdirSync(THREADS, { recursive: true });

const id = () => crypto.randomBytes(6).toString('hex');
const threadFile = (tid) => path.join(THREADS, `${tid.replace(/[^a-z0-9]/gi, '')}.json`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function getSettings() {
  const saved = readJson(path.join(HOME, 'settings.json'), {});
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    claude: { ...DEFAULT_SETTINGS.claude, ...saved.claude },
    codex: { ...DEFAULT_SETTINGS.codex, ...saved.codex },
  };
}

export function saveSettings(next) {
  const merged = {
    ...getSettings(),
    ...next,
    claude: { ...getSettings().claude, ...next.claude },
    codex: { ...getSettings().codex, ...next.codex },
  };
  merged.maxTurns = Math.min(12, Math.max(1, Number(merged.maxTurns) || 4));
  writeJson(path.join(HOME, 'settings.json'), merged);
  return merged;
}

export function getMemory() {
  return readJson(path.join(HOME, 'memory.json'), { notes: [] });
}

export function saveMemory(notes) {
  const clean = (Array.isArray(notes) ? notes : [])
    .map((n) => ({ id: n.id || id(), text: String(n.text || '').trim().slice(0, 2000), ts: n.ts || Date.now() }))
    .filter((n) => n.text);
  writeJson(path.join(HOME, 'memory.json'), { notes: clean });
  return { notes: clean };
}

export function listThreads() {
  return fs
    .readdirSync(THREADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(THREADS, f), null))
    .filter(Boolean)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      return {
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        preview: last ? last.text.replace(/\s+/g, ' ').slice(0, 90) : '',
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createThread(title = 'New thread') {
  const t = {
    id: id(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    sessions: {},
    cursors: { claude: 0, codex: 0 },
  };
  writeJson(threadFile(t.id), t);
  return t;
}

export function getThread(tid) {
  return readJson(threadFile(tid), null);
}

export function saveThread(t) {
  t.updatedAt = Date.now();
  writeJson(threadFile(t.id), t);
  return t;
}

export function deleteThread(tid) {
  try {
    fs.unlinkSync(threadFile(tid));
    return true;
  } catch {
    return false;
  }
}

export function newMessageId() {
  return id();
}
