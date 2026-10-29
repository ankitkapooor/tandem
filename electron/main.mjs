// tandem for Mac: a native window around the same local server the browser version uses.
import { app, BrowserWindow, shell, Menu, nativeTheme, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../src/server.js';

// Apps opened from Finder do not get the PATH from your shell, so `claude` and `codex` would look missing.
function fixPath() {
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.npm-global/bin`,
    `${home}/.bun/bin`, `${home}/.volta/bin`, `${home}/.cargo/bin`, '/usr/bin', '/bin',
  ];
  let fromShell = '';
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    fromShell = execFileSync(sh, ['-ilc', 'echo -n "__P__${PATH}__P__"'], { timeout: 4000, encoding: 'utf8' }).split('__P__')[1] || '';
  } catch { /* fall back to the guesses below */ }
  try {
    const nvm = path.join(home, '.nvm/versions/node');
    for (const v of fs.readdirSync(nvm)) extra.push(path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }
  const parts = [...fromShell.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

const ICON = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'build', 'icon.png');
let win;
let url;

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    title: 'tandem',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0d12' : '#f8f8fb',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(url);
  // Links in messages open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(url)) {
      e.preventDefault();
      if (/^https?:/.test(u)) shell.openExternal(u);
    }
  });
  win.on('closed', () => (win = null));
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => win && (win.isMinimized() && win.restore(), win.focus()));
  app.whenReady().then(async () => {
    fixPath();
    app.setName('tandem');
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(ICON));
    const started = await startServer({ port: 4777, quiet: true, open: false });
    url = started.url.replace('127.0.0.1', 'localhost');
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
        { role: 'windowMenu' },
      ]),
    );
    await createWindow();
    app.on('activate', () => !win && createWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}
