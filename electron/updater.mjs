// Self-update from GitHub Releases. The app is not code-signed, so Apple's own updater cannot be used;
// instead we download the new .app ourselves, swap it in after quitting, and relaunch.
import { app, dialog, shell } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = 'ankitkapooor/tandem';
const ASSET = 'tandem-mac.zip';

const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function latest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'tandem', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const rel = await res.json();
  const asset = rel.assets?.find((a) => a.name === ASSET);
  return { version: String(rel.tag_name || '').replace(/^v/, ''), url: asset?.browser_download_url, notes: rel.body || '' };
}

async function install(win, rel) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-update-'));
  const zip = path.join(work, ASSET);
  const res = await fetch(rel.url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(zip);
  let got = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    if (total) win?.setProgressBar(got / total);
  }
  await new Promise((r) => out.end(r));
  win?.setProgressBar(-1);
  execFileSync('/usr/bin/ditto', ['-xk', zip, work]);
  const fresh = path.join(work, 'tandem.app');
  if (!fs.existsSync(fresh)) throw new Error('The download did not contain the app.');

  // exe is <bundle>/Contents/MacOS/tandem
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  const script = path.join(work, 'swap.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "${bundle}.old"
mv "${bundle}" "${bundle}.old" && mv "${fresh}" "${bundle}" && rm -rf "${bundle}.old"
xattr -cr "${bundle}" 2>/dev/null
open "${bundle}"
`,
    { mode: 0o755 },
  );
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

export async function checkForUpdates(win, { manual = false } = {}) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(win, { message: 'Updates only apply to the installed app.', detail: 'You are running from source. Use git pull.' });
    return;
  }
  try {
    const rel = await latest();
    if (!rel.version || !newer(rel.version, app.getVersion())) {
      if (manual) dialog.showMessageBox(win, { message: 'You are up to date.', detail: `tandem ${app.getVersion()}` });
      return;
    }
    if (!rel.url) throw new Error('The release has no Mac download yet.');
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `tandem ${rel.version} is available`,
      detail: `You have ${app.getVersion()}. tandem will restart to update. Your threads are kept.`,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await install(win, rel);
  } catch (e) {
    if (manual) {
      const { response } = await dialog.showMessageBox(win, { type: 'warning', message: 'Could not update', detail: e.message, buttons: ['OK', 'Open downloads page'] });
      if (response === 1) shell.openExternal(`https://github.com/${REPO}/releases/latest`);
    }
  }
}
