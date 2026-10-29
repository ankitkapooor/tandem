const modes = {
  solo: { eyebrow: 'THE FOCUSED PASS', title: 'Sometimes, one perspective is enough.', description: 'Choose a single agent for a direct answer. Solo works with just one installed CLI, so you can start with the tool you already use.', prompt: '@claude help me plan this feature', nodes: [['You', 'you-node'], ['Claude', 'claude-node', 'answers']] },
  relay: { eyebrow: 'THE HANDOFF', title: 'An answer is a starting point.', description: 'One agent takes the first pass. The other reads it, challenges the assumptions, and adds what’s missing. Swap the roles whenever you like.', prompt: '@chat respond and @claude critique it', nodes: [['You', 'you-node'], ['Claude', 'claude-node', 'answers'], ['Codex', 'codex-node', 'critiques']] },
  parallel: { eyebrow: 'THE INDEPENDENT THINKERS', title: 'Two first instincts. A stronger synthesis.', description: 'Both agents answer without seeing the other’s response. Then one merges the perspectives. A way to explore independently before bringing the ideas together.', prompt: '@both give your own answers, then merge', nodes: [['You', 'you-node'], ['Claude + Codex', 'parallel-node', 'answer independently'], ['Merge', 'codex-node', 'shared result']] },
  debate: { eyebrow: 'THE CONSTRUCTIVE DISAGREEMENT', title: 'Give the trade-offs a voice.', description: 'Let the agents go back and forth, reading and responding to each other. They stop when they agree or hit your turn limit. You can stop the conversation at any time.', prompt: '@claude and @codex debate: monorepo or separate repos?', nodes: [['Claude', 'claude-node', 'makes the case'], ['Codex', 'codex-node', 'challenges it'], ['↻', 'you-node', 'until agreement / limit']] }
};
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectMode(tab) {
  const mode = modes[tab.dataset.mode];
  tabs.forEach(t => { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; });
  document.querySelector('#mode-panel').setAttribute('aria-labelledby', tab.id);
  document.querySelector('#mode-panel .eyebrow').textContent = mode.eyebrow;
  document.querySelector('#mode-title').textContent = mode.title;
  document.querySelector('#mode-description').textContent = mode.description;
  document.querySelector('#mode-prompt').textContent = mode.prompt;
  document.querySelector('#mode-flow').replaceChildren(...mode.nodes.flatMap(([label, cls, sub], i) => {
    const node = document.createElement('span'); node.className = `flow-node ${cls}`; node.textContent = label;
    if (sub) { const small = document.createElement('span'); small.textContent = sub; node.append(small); }
    if (!i) return [node];
    const arrow = document.createElement('span'); arrow.className = 'connector'; arrow.textContent = tab.dataset.mode === 'debate' && i === 1 ? '⇄' : '→'; arrow.setAttribute('aria-hidden','true');
    return [arrow, node];
  }));
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectMode(tab));
  tab.addEventListener('keydown', event => {
    const move = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!move && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + move + tabs.length) % tabs.length];
    selectMode(next); next.focus();
  });
});
const tabMedia = matchMedia('(max-width:780px)');
function setTabOrientation() { document.querySelector('[role="tablist"]').setAttribute('aria-orientation', tabMedia.matches ? 'horizontal' : 'vertical'); }
setTabOrientation(); tabMedia.addEventListener('change', setTabOrientation);
document.querySelector('#copy-install').addEventListener('click', async () => {
  const text = document.querySelector('#install-command').textContent;
  const status = document.querySelector('#copy-status');
  try { await navigator.clipboard.writeText(text); status.textContent = 'Copied. Paste into Terminal to install tandem.'; }
  catch { const range = document.createRange(); range.selectNodeContents(document.querySelector('#install-command')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); status.textContent = 'Command selected. Press ⌘C (or Ctrl+C) to copy.'; }
});
document.querySelectorAll('a[href="#phone-setup"]').forEach(link => link.addEventListener('click', () => { document.querySelector('#phone-setup').open = true; }));
