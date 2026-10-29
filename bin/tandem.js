#!/usr/bin/env node
import { startServer } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag('help') || flag('h')) {
  console.log(`tandem - one thread for you, Claude Code and Codex

Usage: tandem [options]

  --port <n>     Port to listen on (default 4777)
  --lan          Turn on phone access (shows a link, or a QR code in Settings)
  --mock         Use fake agents (no CLIs needed), for trying the UI
  --no-open      Do not open the browser
  --help         Show this help
`);
  process.exit(0);
}

await startServer({
  port: Number(value('port', process.env.PORT || 4777)),
  lan: flag('lan'),
  mock: flag('mock'),
  open: !flag('no-open'),
});
