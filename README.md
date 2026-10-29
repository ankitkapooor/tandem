# tandem

One thread for you, **Claude Code** and **Codex**. tandem runs the official `claude` and `codex` command-line tools on your own computer, so it uses the subscriptions you already pay for. No API keys, no accounts, nothing leaves your machine.

## What it does

- **Real sequencing.** Say who does what in plain words: `@chat respond and @claude critique it` runs Codex first, then Claude. Without mentions, your default roles apply (Claude answers, Codex critiques; change it in Settings).
- **Four modes.** Solo, Relay, Parallel (both answer blind, then merge) and Debate (back and forth until they agree).
- **They know about each other.** Each agent sees what the other said, its own role and its place in the plan. Only new messages are sent each turn, so tokens are not wasted.
- **Plan strip.** See the plan before you send, and click any step to change who does it or what job it has.
- **Model and effort per agent**, from the pills in the composer.
- **`/` skills.** Skills from `~/.claude/skills`, `~/.codex/skills` and your project folders show up in the `/` menu.
- **Code, HTML previews and Mermaid diagrams** render inline.
- **Phone.** Turn on Phone access in Settings, scan the QR code, then Add to Home Screen on iPhone.

## Install

You need Node 20+ and both CLIs signed in (run `claude` then `/login`, and `codex login`, once in Terminal).

```bash
git clone https://github.com/ankitkapooor/tandem && cd tandem
npm install
npm run app      # native window (Electron)
npm start        # or in your browser at http://localhost:4777
```

### A download for a friend

Run the **Build Mac app** workflow on GitHub (Actions tab), or `npm run dist` on a Mac. You get a `.dmg`. The app is not code-signed, so the first time: right-click it, choose Open, then Open again.

## Safety

- Listens on `127.0.0.1` only until you turn on Phone access, then needs a secret token.
- Agents start read-only in your project folder. Change that in Settings.
- HTML previews run in a sandboxed frame.

## Develop

```bash
npm run dev      # mock agents, no CLIs needed
npm test
```

Data lives in `~/.tandem` (override with `TANDEM_HOME`).
