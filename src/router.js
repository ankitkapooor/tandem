import { AGENTS, runAgent } from './agents.js';
import { getMemory, getSettings, getThread, newMessageId, saveThread } from './store.js';

const LABEL = { user: 'You', claude: 'Claude', codex: 'Codex', system: 'System' };
const DONE = /\[\[DONE\]\]/g;
const running = new Map(); // threadId -> AbortController

export const isBusy = (tid) => running.has(tid);

export function stopThread(tid) {
  running.get(tid)?.abort();
}

const other = (a) => (a === 'claude' ? 'codex' : 'claude');

export function parseTargets(text, thread, settings) {
  const enabled = Object.keys(AGENTS).filter((a) => settings[a].enabled);
  const lower = text.toLowerCase();
  if (/@(both|all|team)\b/.test(lower)) return enabled;
  const hits = [];
  const re = /@(claude|codex)\b/g;
  let m;
  while ((m = re.exec(lower))) if (!hits.includes(m[1]) && enabled.includes(m[1])) hits.push(m[1]);
  if (hits.length) return hits;
  const lastAgent = [...thread.messages].reverse().find((x) => x.role === 'claude' || x.role === 'codex');
  if (lastAgent && enabled.includes(lastAgent.role)) return [lastAgent.role];
  return enabled.slice(0, 1);
}

function preamble(agent) {
  const notes = getMemory().notes;
  const lines = [
    `You are ${LABEL[agent]} in Tandem, a shared chat thread between the user, ${LABEL[agent]} and ${LABEL[other(agent)]}.`,
    `Messages are tagged [You], [Claude] and [Codex]. Reply only as yourself, be concise (usage is limited), and do not restate what others already said.`,
    `If you are talking with the other agent and have nothing to add, reply with exactly [[DONE]].`,
    `Use fenced code blocks for code. Use a \`\`\`mermaid block for diagrams and a \`\`\`html block for a small self-contained UI preview.`,
  ];
  if (notes.length) lines.push('Shared notes from the user:', ...notes.map((n) => `- ${n.text}`));
  return lines.join('\n');
}

const fmt = (m, agent) => `[${LABEL[m.role]}${m.role === agent ? ' (you)' : ''}]: ${m.text}`;

export function buildPrompts(thread, agent) {
  const cursor = thread.cursors[agent] || 0;
  const delta = thread.messages.slice(cursor).filter((m) => m.role !== agent && m.role !== 'system');
  const all = thread.messages.filter((m) => m.role !== 'system');
  return {
    prompt: delta.map((m) => fmt(m, agent)).join('\n\n'),
    fullPrompt: `${preamble(agent)}\n\n${all.map((m) => fmt(m, agent)).join('\n\n')}`,
  };
}

function addMessage(thread, role, text, emit) {
  const message = { id: newMessageId(), role, text, ts: Date.now() };
  thread.messages.push(message);
  saveThread(thread);
  emit({ type: 'message', threadId: thread.id, message });
  return message;
}

export async function sendMessage(threadId, { text, targets, loop }, emit, mock) {
  const thread = getThread(threadId);
  if (!thread) throw new Error('Thread not found');
  if (running.has(threadId)) throw Object.assign(new Error('This thread is busy. Stop it first.'), { status: 409 });
  const settings = getSettings();
  const chosen = (targets?.length ? targets : parseTargets(text, thread, settings)).filter((a) => AGENTS[a]);
  if (!chosen.length) throw new Error('No agents are enabled. Turn one on in Settings.');

  const abort = new AbortController();
  running.set(threadId, abort);
  try {
    if (thread.title === 'New thread') thread.title = text.replace(/@\w+/g, '').trim().slice(0, 40) || 'New thread';
    addMessage(thread, 'user', text, emit);

    const limit = loop ? Math.max(settings.maxTurns, chosen.length) : chosen.length;
    const queue = [...chosen];
    let turns = 0;
    while (queue.length && turns < limit) {
      const agent = queue.shift();
      emit({ type: 'status', threadId, agent, state: 'thinking' });
      let reply;
      try {
        const { prompt, fullPrompt } = buildPrompts(thread, agent);
        reply = await runAgent(
          agent,
          { prompt, fullPrompt, session: thread.sessions[agent] || null, settings, signal: abort.signal },
          mock,
        );
      } catch (e) {
        addMessage(thread, 'system', `${LABEL[agent]} failed: ${e.message}`, emit);
        break;
      }
      thread.sessions[agent] = reply.session;
      const finished = reply.text.includes('[[DONE]]');
      const clean = reply.text.replace(DONE, '').trim();
      if (clean) addMessage(thread, agent, clean, emit);
      thread.cursors[agent] = thread.messages.length;
      saveThread(thread);
      turns += 1;
      if (finished) break;
      if (loop && !queue.length) queue.push(other(agent));
    }
  } finally {
    running.delete(threadId);
    emit({ type: 'status', threadId, agent: null, state: 'idle' });
  }
}
