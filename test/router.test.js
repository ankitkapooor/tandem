import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TANDEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));

const store = await import('../src/store.js');
const { sendMessage, buildPrompts, findHandoff, planFor } = await import('../src/router.js');
const { buildPlan, detectRole } = await import('../src/plan.js');
const { claudeArgs, codexArgs } = await import('../src/agents.js');

const collect = () => {
  const events = [];
  return { events, emit: (e) => events.push(e) };
};
const settings = () => store.getSettings();
const roles = (t) => store.getThread(t.id).messages.map((m) => m.role);

test('plan: your own words set the order and roles', () => {
  const p = buildPlan('What about Descartes demon? @chat respond and @claude critique it', { settings: settings() });
  assert.deepEqual(p.stages.flat().map((s) => [s.agent, s.role]), [['codex', 'answer'], ['claude', 'critique']]);
  assert.equal(p.label, 'Codex answers → Claude critiques');
});

test('plan: aliases and single mentions', () => {
  const s = settings();
  assert.equal(buildPlan('@gpt hi', { settings: s }).stages[0][0].agent, 'codex');
  assert.equal(buildPlan('@anthropic hi', { settings: s }).stages[0][0].agent, 'claude');
  const solo = buildPlan('@claude critique my plan', { settings: s });
  assert.deepEqual(solo.stages.flat().map((x) => [x.agent, x.role]), [['claude', 'critique']]);
  assert.equal(detectRole('please review and fix'), 'critique');
});

test('plan: defaults are Claude answers, Codex critiques, and Settings can swap them', () => {
  assert.equal(buildPlan('hello', { settings: settings() }).label, 'Claude answers → Codex critiques');
  store.saveSettings({ roles: { answer: 'codex' } });
  assert.equal(buildPlan('hello', { settings: settings() }).label, 'Codex answers → Claude critiques');
  store.saveSettings({ roles: { answer: 'claude', critique: 'codex' } });
  assert.deepEqual(settings().roles, { answer: 'claude', critique: 'codex' });
});

test('plan: modes', () => {
  const s = settings();
  assert.equal(buildPlan('x', { mode: 'solo', settings: s }).stages.length, 1);
  const par = buildPlan('x', { mode: 'parallel', settings: s });
  assert.equal(par.stages[0].length, 2);
  assert.ok(par.stages[0].every((x) => x.blind));
  assert.equal(par.stages[1][0].role, 'merge');
  assert.equal(buildPlan('x', { mode: 'debate', settings: { ...s, maxTurns: 4 } }).stages.length, 4);
  assert.equal(buildPlan('x', { mode: 'relay', settings: { ...s, revise: true } }).stages.length, 3);
});

test('plan: a disabled agent is skipped', () => {
  const s = { ...settings(), codex: { ...settings().codex, enabled: false } };
  assert.equal(buildPlan('hello', { settings: s }).label, 'Claude answers');
});

test('relay runs in sequence: Claude answers, then Codex critiques it', async () => {
  const t = store.createThread();
  const { events, emit } = collect();
  await sendMessage(t.id, { text: 'is a hot dog a sandwich' }, emit, true);
  const saved = store.getThread(t.id);
  assert.deepEqual(roles(t), ['user', 'claude', 'codex']);
  assert.deepEqual(saved.messages.slice(1).map((m) => m.meta.role), ['answer', 'critique']);
  assert.match(saved.messages[2].text, /Critique/);
  assert.equal(saved.title, 'is a hot dog a sandwich');
  assert.ok(events.some((e) => e.type === 'plan'));
  assert.equal(events.at(-1).state, 'idle');
});

test('each agent is told its role and sees what the other said', async () => {
  const t = store.createThread();
  const { emit } = collect();
  await sendMessage(t.id, { text: 'first question' }, emit, true);
  const thread = store.getThread(t.id);
  const step = { agent: 'codex', role: 'critique', n: 2 };
  const plan = planFor('x', { settings: settings() });
  const { prompt, fullPrompt } = buildPrompts(thread, 'codex', step, plan);
  assert.ok(fullPrompt.includes('You are Codex in Tandem'));
  assert.match(fullPrompt, /\[Claude\]:/);
  assert.match(prompt, /\[Tandem\] Plan: Claude answers → Codex critiques\. You are step 2 of 2/);
  assert.match(prompt, /\(role: critique\)/);
  // Claude already saw the question, so its next prompt only carries what it has not seen: Codex's critique.
  const next = buildPrompts(thread, 'claude', { agent: 'claude', role: 'answer', n: 1 }, plan);
  assert.ok(!next.prompt.includes('first question'));
  assert.match(next.prompt, /\[Codex\]:/);
  assert.ok(!next.prompt.includes('[Claude (you)]'), 'an agent is not sent its own earlier replies');
});

test('parallel: both answer blind at once, then one merges', async () => {
  const t = store.createThread();
  const { emit } = collect();
  const started = Date.now();
  await sendMessage(t.id, { text: 'pick a database', mode: 'parallel' }, emit, true);
  const saved = store.getThread(t.id);
  assert.deepEqual(saved.messages.slice(1).map((m) => m.meta.role).sort(), ['answer', 'answer', 'merge']);
  assert.ok(Date.now() - started < 2300, 'the two answers ran at the same time, not back to back');
  // Neither blind answer was built from the other's reply.
  const plan = planFor('x', { mode: 'parallel', settings: settings() });
  const blind = buildPrompts({ ...saved, messages: saved.messages.slice(0, 1), cursors: { claude: 0, codex: 0 } }, 'codex', plan.stages[0][1], plan);
  assert.match(blind.prompt, /cannot see their answer/);
  assert.ok(!blind.prompt.includes('[Claude]:'));
});

test('debate stops early when an agent replies [[DONE]]', async () => {
  const t = store.createThread();
  const { emit } = collect();
  store.saveSettings({ maxTurns: 6 });
  await sendMessage(t.id, { text: 'tabs or spaces', mode: 'debate' }, emit, true);
  const n = roles(t).filter((r) => r !== 'user').length;
  assert.equal(n, 2); // answer, then a rebuttal that ends the exchange
  store.saveSettings({ maxTurns: 4 });
});

test('an edited plan from the UI is validated and used', async () => {
  const t = store.createThread();
  const { emit } = collect();
  const plan = { stages: [[{ agent: 'codex', role: 'answer' }], [{ agent: 'claude', role: 'critique' }], [{ agent: 'nope', role: 'x' }]] };
  await sendMessage(t.id, { text: 'hello there', plan }, emit, true);
  assert.deepEqual(roles(t), ['user', 'codex', 'claude']);
});

test('handoff: a reply that starts a line with @agent passes the floor', () => {
  const s = settings();
  assert.deepEqual(findHandoff('Here is my take.\n@codex please check the math', 'claude', s), { agent: 'codex', role: 'critique' });
  assert.equal(findHandoff('I told @codex already', 'claude', s), null);
  assert.equal(findHandoff('@claude go', 'claude', s), null);
});

test('CLI arguments follow the real flags', () => {
  const s = settings();
  s.claude = { ...s.claude, model: 'opus', effort: 'high', permissionMode: 'plan' };
  assert.deepEqual(claudeArgs({ session: 'abc', settings: s }), ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--model', 'opus', '--effort', 'high', '--resume', 'abc']);
  s.codex = { ...s.codex, model: 'm1', effort: 'xhigh', sandbox: 'workspace-write' };
  const fresh = codexArgs({ session: null, settings: s });
  const resumed = codexArgs({ session: 'sid', settings: s });
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', 'sid']);
  assert.ok(!fresh.includes('--sandbox') && !resumed.includes('--sandbox'), 'resume rejects --sandbox, so it goes through -c');
  assert.ok(resumed.includes('sandbox_mode="workspace-write"') && resumed.includes('model_reasoning_effort="xhigh"'));
  assert.ok(resumed.includes('-m') && resumed.at(-1) === '-');
});

test('a second send while busy is rejected', async () => {
  const t = store.createThread();
  const { emit } = collect();
  const first = sendMessage(t.id, { text: 'one' }, emit, true);
  await assert.rejects(sendMessage(t.id, { text: 'two' }, emit, true), /busy/);
  await first;
});

test('attachments: small text files are inlined, others are passed by path', async () => {
  const t = store.createThread();
  const dir = path.join(store.UPLOADS, 'x1');
  fs.mkdirSync(dir, { recursive: true });
  const note = path.join(dir, 'notes.md');
  const pdf = path.join(dir, 'paper.pdf');
  fs.writeFileSync(note, 'secret-plan-42');
  fs.writeFileSync(pdf, '%PDF');
  const { emit } = collect();
  await sendMessage(t.id, { text: 'look', mode: 'solo', attachments: [{ name: 'notes.md', path: note }, { name: 'paper.pdf', path: pdf }] }, emit, true);
  const saved = store.getThread(t.id);
  const step = { agent: 'codex', role: 'critique', n: 2 };
  const { prompt } = buildPrompts(saved, 'codex', step, planFor('x', { settings: settings() }), []);
  assert.match(prompt, /secret-plan-42/);
  assert.ok(prompt.includes(`Read it at: ${pdf}`));
  assert.equal(saved.messages[0].meta.attachments.length, 2);
});

test('claude gets the uploads folder when asked', () => {
  assert.deepEqual(claudeArgs({ session: null, settings: settings(), dirs: ['/u'] }).slice(-2), ['--add-dir', '/u']);
});

// ---------- streaming and retry ----------

const { runAgent } = await import('../src/agents.js');

function fakeBin(name, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-bin-'));
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\ncat >/dev/null\n${script}\n`, { mode: 0o755 });
  return dir;
}

test('claude streaming: text deltas and tool status reach onProgress, the result line is the answer', async () => {
  const dir = fakeBin('claude', `cat <<'EOF'
{"type":"system","subtype":"init","model":"claude-opus-4-1-20250805"}
{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}}
{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}
{"type":"result","subtype":"success","is_error":false,"result":"Hello","session_id":"s-1"}
EOF`);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    const seen = [];
    const r = await runAgent('claude', { prompt: 'p', fullPrompt: 'p', session: null, settings: settings(), onProgress: (d) => seen.push(d) }, false);
    assert.equal(r.text, 'Hello');
    assert.equal(r.session, 's-1');
    assert.deepEqual(seen.filter((d) => d.text).map((d) => d.text), ['Hel', 'lo']);
    assert.ok(seen.some((d) => d.status === 'Reading files'));
    assert.ok(seen.some((d) => d.reset));
    const { defaultModels } = await import('../src/agents.js');
    assert.equal(defaultModels().claude.includes('opus'), true);
  } finally {
    process.env.PATH = old;
  }
});

test('codex streaming: commands show as status and the final message comes through', async () => {
  const dir = fakeBin('codex', `cat <<'EOF'
{"type":"thread.started","thread_id":"t-9"}
{"type":"item.started","item":{"type":"command_execution"}}
{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}
EOF`);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    const seen = [];
    const r = await runAgent('codex', { prompt: 'p', fullPrompt: 'p', session: null, settings: settings(), onProgress: (d) => seen.push(d) }, false);
    assert.equal(r.text, 'Done.');
    assert.equal(r.session, 't-9');
    assert.ok(seen.some((d) => d.status === 'Running a command'));
    assert.ok(seen.some((d) => d.text === 'Done.'));
  } finally {
    process.env.PATH = old;
  }
});

test('a failed step is saved with its kind, and a retry re-runs only that step without a new user message', async () => {
  const { events, emit } = collect();
  const t = store.createThread();
  process.env.TANDEM_MOCK_FAIL = 'claude';
  await sendMessage(t.id, { text: 'hello', mode: 'solo' }, emit, true);
  delete process.env.TANDEM_MOCK_FAIL;
  const failed = store.getThread(t.id).messages.at(-1);
  assert.equal(failed.role, 'system');
  assert.equal(failed.meta.kind, 'auth');
  assert.equal(failed.meta.agent, 'claude');
  const before = store.getThread(t.id).messages.length;
  await sendMessage(t.id, { text: '', retry: true, plan: { stages: [[{ agent: 'claude', role: failed.meta.role }]] } }, emit, true);
  const after = store.getThread(t.id).messages;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).role, 'claude');
  assert.equal(after.filter((m) => m.role === 'user').length, 1);
  assert.ok(events.some((e) => e.type === 'progress' && e.agent === 'claude' && e.text));
});

test('thread list previews skip system messages', () => {
  const t = store.createThread();
  const th = store.getThread(t.id);
  th.messages.push({ id: 'a', role: 'user', text: 'What is **bold** here?', ts: Date.now() }, { id: 'b', role: 'system', text: 'Claude could not answer: boom', ts: Date.now() });
  store.saveThread(th);
  const row = store.listThreads().find((x) => x.id === t.id);
  assert.equal(row.preview, 'What is bold here?');
});
