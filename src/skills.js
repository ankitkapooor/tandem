import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Finds skills the two CLIs already know about, so they can be picked with "/" in the composer.
// Skill folders hold SKILL.md with "name" and "description" in the frontmatter.

const MAX = 400;
let cache = { at: 0, key: '', list: [] };

function frontmatter(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(head);
    if (!m) return {};
    const get = (k) => {
      const line = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1]);
      return line ? line[1].replace(/^['">|-]+\s*|['"]$/g, '').trim() : '';
    };
    return { name: get('name'), description: get('description') };
  } catch {
    return {};
  }
}

function scanSkillDir(dir, agent, scope, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX) return;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const sub = path.join(dir, e.name);
    const file = path.join(sub, 'SKILL.md');
    if (fs.existsSync(file)) {
      const fm = frontmatter(file);
      out.push({ agent, name: fm.name || e.name, description: fm.description || '', path: file, scope });
    } else if (depth < 2) {
      scanSkillDir(sub, agent, scope, out, depth + 1);
    }
  }
}

function scanCommands(dir, agent, scope, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || out.length >= MAX) continue;
    const file = path.join(dir, e.name);
    const fm = frontmatter(file);
    out.push({ agent, name: e.name.replace(/\.md$/, ''), description: fm.description || '', path: file, scope });
  }
}

// Plugin skills live deeper (~/.claude/plugins/**/skills/<name>/SKILL.md), so walk with a depth limit.
function scanPlugins(root, agent, out, depth = 0) {
  if (depth > 6 || out.length >= MAX) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    const sub = path.join(root, e.name);
    if (e.name === 'skills') scanSkillDir(sub, agent, 'plugin', out);
    else scanPlugins(sub, agent, out, depth + 1);
  }
}

export function discoverSkills(workdir = '') {
  const key = workdir;
  if (Date.now() - cache.at < 30000 && cache.key === key) return cache.list;
  const home = os.homedir();
  const out = [];
  const project = workdir && fs.existsSync(workdir) ? workdir : process.cwd();

  scanSkillDir(path.join(home, '.claude', 'skills'), 'claude', 'personal', out);
  scanSkillDir(path.join(project, '.claude', 'skills'), 'claude', 'project', out);
  scanCommands(path.join(home, '.claude', 'commands'), 'claude', 'personal', out);
  scanPlugins(path.join(home, '.claude', 'plugins'), 'claude', out);

  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  scanSkillDir(path.join(codexHome, 'skills'), 'codex', 'personal', out);
  scanSkillDir(path.join(home, '.agents', 'skills'), 'codex', 'personal', out);
  scanSkillDir(path.join(project, '.agents', 'skills'), 'codex', 'project', out);
  scanSkillDir(path.join(project, '.codex', 'skills'), 'codex', 'project', out);

  const seen = new Set();
  const list = out
    .filter((s) => {
      const k = `${s.agent}:${s.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), key, list };
  return list;
}
