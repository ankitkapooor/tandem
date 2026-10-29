import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TANDEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));

const store = await import('../src/store.js');
const { sendMessage, parseTargets, buildPrompts } = await import('../src/router.js');

const collect = () => {
  const events = [];
  return { events, emit: (e) => events.push(e) };
};

test('parseTargets reads @mentions and falls back to the last speaker', () => {
  const settings = store.getSettings();
  const thread = store.createThread();
  assert.deepEqual(parseTargets('hi @codex', thread, settings), ['codex']);
  assert.deepEqual(parseTargets('hey @both', thread, settings), ['claude', 'codex']);
  assert.deepEqual(parseTargets('no mention', thread, settings), ['claude']);
  thread.messages.push({ id: 'x', role: 'codex', text: 'hello', ts: 1 });
  assert.deepEqual(parseTargets('no mention', thread, settings), ['codex']);
});

test('a message to both agents runs them in order and saves the thread', async () => {
  const t = store.createThread();
  const { events, emit } = collect();
  await sendMessage(t.id, { text: 'say hello @both' }, emit, true);
  const saved = store.getThread(t.id);
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'claude', 'codex']);
  assert.equal(saved.title, 'say hello');
  assert.equal(events.at(-1).state, 'idle');
});

test('each agent only receives messages it has not seen yet', async () => {
  const t = store.createThread();
  const { emit } = collect();
  await sendMessage(t.id, { text: 'first @claude' }, emit, true);
  await sendMessage(t.id, { text: 'second @codex' }, emit, true);
  const thread = store.getThread(t.id);
  const { prompt, fullPrompt } = buildPrompts(thread, 'claude');
  assert.ok(!prompt.includes('first'), 'claude already saw the first message');
  assert.ok(prompt.includes('second @codex'));
  assert.ok(prompt.includes('[Codex]'));
  assert.ok(fullPrompt.includes('You are Claude in Tandem'));
});

test('loop mode alternates agents, honors [[DONE]] and the turn cap', async () => {
  const t = store.createThread();
  const { emit } = collect();
  store.saveSettings({ maxTurns: 6 });
  await sendMessage(t.id, { text: 'review this code @codex', loop: true }, emit, true);
  const roles = store.getThread(t.id).messages.map((m) => m.role);
  // codex answers, claude replies and ends with [[DONE]], loop stops early
  assert.deepEqual(roles, ['user', 'codex', 'claude']);

  const t2 = store.createThread();
  store.saveSettings({ maxTurns: 3 });
  await sendMessage(t2.id, { text: 'chat @claude', loop: true }, emit, true);
  const n = store.getThread(t2.id).messages.filter((m) => m.role !== 'user').length;
  assert.equal(n, 3);
});

test('a second send while busy is rejected', async () => {
  const t = store.createThread();
  const { emit } = collect();
  const first = sendMessage(t.id, { text: 'one @claude' }, emit, true);
  await assert.rejects(sendMessage(t.id, { text: 'two @claude' }, emit, true), /busy/);
  await first;
});
