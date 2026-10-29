# tandem

One chat thread for you, Claude Code and Codex. It runs on your own computer and drives the official `claude` and `codex` command line tools, so it uses the subscriptions you already have. Nothing goes through a server of ours, and there is no sign-up.

- One thread, three speakers, each message labeled and colored
- Send to `@claude`, `@codex` or `@both`, or let the last speaker answer
- "Let them talk": the agents reply to each other, up to a turn limit you set
- Code blocks with copy, Mermaid diagrams, and HTML previews in a sandbox
- Shared memory notes, plus each CLI's own skills and instruction files (`CLAUDE.md`, `AGENTS.md`)
- Works in the browser on your computer, and on your phone as a home-screen app

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and at least one of the two CLIs, installed and signed in:

```sh
npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in
npm install -g @openai/codex               # then run `codex` once and choose "Sign in with ChatGPT"
```

Then run tandem from this folder:

```sh
git clone https://github.com/ankitkapooor/tandem && cd tandem
npm install
npm start
```

It opens `http://localhost:4777`. Try it without any CLI first with `npm run dev`, which uses fake agents.

## Using it on your phone

The CLIs only run on your computer, so your phone connects to it:

1. Put both devices on the same Wi-Fi, or install [Tailscale](https://tailscale.com) on both (works anywhere).
2. Start tandem with `npm start -- --lan`.
3. Open the "On your phone" link it prints. On iPhone, use Safari, then Share, then Add to Home Screen.

The link contains a private token. Anyone who has it can run the agents on your computer, so do not share it. Your computer must stay awake while you use it.

## How it keeps usage low

- Each agent keeps its own resumed session, and only receives messages it has not seen yet, not the whole thread.
- Agents see each other's final answers, not their tool calls or reasoning.
- Agent-to-agent talk is off by default, and capped when you turn it on (Settings, default 4 replies).
- Each agent can end an exchange early by replying `[[DONE]]`.

## Safety

Claude Code and Codex can read files and run commands on your computer. Tandem starts them locked down: Claude asks first (which means it can't edit files in this mode) and Codex runs in a read-only sandbox. You can loosen this per agent in Settings. Set a project folder in Settings so they work where you expect.

tandem only listens on `localhost` unless you pass `--lan`. With `--lan`, every request needs the private token.

## Using your subscriptions

Tandem does not read or copy your login tokens. It runs the official CLIs, which handle their own sign-in. Provider terms change often, so check Anthropic's and OpenAI's current terms for using subscriptions with other tools before relying on it.

## Where your data lives

`~/.tandem` holds threads, memory notes, settings and the phone token. Set `TANDEM_HOME` to move it. Delete the folder to remove everything.

## Status

Early version. Works with mock agents end to end (`npm test` runs the routing tests). The real CLI integration follows the documented headless modes (`claude -p --output-format json`, `codex exec --json`), but CLI flags change between versions, so if an agent fails, the error shows up in the thread. Not built yet: syntax highlighting, QR code for the phone link, streaming replies, a packaged Mac app.
