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
