import { AGENTS, runAgent } from './agents.js';
import { buildPlan, detectRole, otherAgent, parseMentions, ROLE_LABEL, sanitizePlan } from './plan.js';
import { getMemory, getSettings, getThread, newMessageId, saveThread } from './store.js';

const LABEL = { user: 'You', claude: 'Claude', codex: 'Codex', system: 'System' };
const running = new Map(); // threadId -> AbortController

export const isBusy = (tid) => running.has(tid);
export const stopThread = (tid) => running.get(tid)?.abort();

function preamble(agent) {
  const peer = LABEL[otherAgent(agent)];
  const notes = getMemory().notes;
  const lines = [
    `You are ${LABEL[agent]} in Tandem, a shared chat thread with the user and ${peer}. You are one of two coding agents working together.`,
    `Messages are tagged [You], [Claude] and [Codex]. Reply only as yourself. Be concise, because usage is limited, and do not repeat what others already said.`,
    `For each user message Tandem makes a plan, such as "Claude answers → Codex critiques". Each turn ends with a [Tandem] note telling you which step you are and your role. Follow it.`,
    `To hand the floor to ${peer}, start a line of your reply with @${otherAgent(agent)} and say what you want from them. If you have nothing to add in a back-and-forth, reply with exactly [[DONE]].`,
    `Use fenced code blocks for code, a \`\`\`mermaid block for diagrams, and a \`\`\`html block for a small self-contained UI preview.`,
  ];
  if (notes.length) lines.push('Shared notes from the user:', ...notes.map((n) => `- ${n.text}`));
  return lines.join('\n');
}

const ROLE_TEXT = (peer) => ({
  answer: 'Answer the user\'s latest message directly.',
  critique: `Critique ${peer}'s answer above: what is right, what is wrong or missing, and what you would change. Be specific and brief. Do not rewrite their whole answer.`,
  revise: `Revise your earlier answer using ${peer}'s critique. Say what changed.`,
  rebut: `Respond to ${peer}'s last message: concede what is right and push back on what is not. If you both agree and have nothing to add, reply [[DONE]].`,
  merge: `You and ${peer} both answered above. Give the user one final answer: where you agree, where you differ, and your recommendation.`,
  summarize: 'Summarize the thread so far in a few lines.',
});

const fmt = (m, agent) => `[${LABEL[m.role]}${m.role === agent ? ' (you)' : ''}]: ${m.text}`;

function tandemNote(agent, step, plan, total, skills) {
  const peer = LABEL[otherAgent(agent)];
  const lines = [
    `[Tandem] Plan: ${plan.label}. You are step ${step.n} of ${total}. Your role: ${ROLE_TEXT(peer)[step.role]} (role: ${step.role})`,
  ];
  if (step.blind) lines.push(`${peer} is answering the same message at the same time and you cannot see their answer. Answer on your own.`);
  const mine = skills.filter((s) => !s.agent || s.agent === agent);
  if (mine.length) {
    lines.push(`The user asked you to use these skills. Read each file and follow it: ${mine.map((s) => `"${s.name}" at ${s.path}`).join('; ')}.`);
  }
  return lines.join('\n');
}

export function buildPrompts(thread, agent, step, plan, skills = []) {
  const cursor = thread.cursors[agent] || 0;
  const note = tandemNote(agent, step, plan, plan.stages.flat().length, skills);
  const delta = thread.messages.slice(cursor).filter((m) => m.role !== agent && m.role !== 'system');
  const all = thread.messages.filter((m) => m.role !== 'system');
  return {
    prompt: `${delta.map((m) => fmt(m, agent)).join('\n\n')}\n\n${note}`.trim(),
    fullPrompt: `${preamble(agent)}\n\n${all.map((m) => fmt(m, agent)).join('\n\n')}\n\n${note}`,
    seenUpTo: thread.messages.length,
  };
}

function addMessage(thread, role, text, emit, meta) {
  const message = { id: newMessageId(), role, text, ts: Date.now(), ...(meta ? { meta } : {}) };
  thread.messages.push(message);
  saveThread(thread);
  emit({ type: 'message', threadId: thread.id, message });
  return message;
}

export function planFor(text, { mode, settings }) {
  return buildPlan(text, { mode, settings });
}

// An agent can pass the floor by starting a line with @claude or @codex.
export function findHandoff(text, self, settings) {
  for (const line of text.split('\n')) {
    if (!/^\s*@\w+/.test(line)) continue;
    const [m] = parseMentions(line.trim());
    if (m && m.start === 0 && m.agent !== 'both' && m.agent !== self && settings[m.agent]?.enabled) {
      return { agent: m.agent, role: detectRole(line.slice(m.end)) || 'answer' };
    }
  }
  return null;
}

export async function sendMessage(threadId, { text, mode, plan: edited, skills = [] }, emit, mock) {
  const thread = getThread(threadId);
  if (!thread) throw new Error('Thread not found');
  if (running.has(threadId)) throw Object.assign(new Error('This thread is busy. Stop it first.'), { status: 409 });
  const settings = getSettings();
  const plan = sanitizePlan(edited, settings) || planFor(text, { mode, settings });
  if (!plan.stages.length) throw new Error('No agents are enabled. Turn one on in Settings.');
  const picked = (Array.isArray(skills) ? skills : []).filter((s) => s && s.name && s.path).slice(0, 8);

  const abort = new AbortController();
  running.set(threadId, abort);
  const stages = plan.stages.map((s) => s.map((x) => ({ ...x })));
  const total = () => stages.flat().length;
  let handoffs = 0;
  try {
    if (thread.title === 'New thread') thread.title = makeTitle(text);
    addMessage(thread, 'user', text, emit);
    emit({ type: 'plan', threadId, plan });

    for (let si = 0; si < stages.length; si++) {
      const stage = stages[si];
      emit({ type: 'step', threadId, stage: si, state: 'running', agents: stage.map((s) => s.agent) });
      emit({ type: 'status', threadId, agents: stage.map((s) => s.agent), state: 'working' });

      // Prompts are built before anything runs, so steps in one stage cannot see each other.
      const jobs = stage.map((step) => {
        const livePlan = { ...plan, stages };
        const p = buildPrompts(thread, step.agent, step, livePlan, picked);
        return { step, p };
      });
      const results = await Promise.all(
        jobs.map(async ({ step, p }) => {
          const started = Date.now();
          try {
            const reply = await runAgent(
              step.agent,
              { prompt: p.prompt, fullPrompt: p.fullPrompt, session: thread.sessions[step.agent] || null, settings, signal: abort.signal },
              mock,
            );
            return { step, p, reply, ms: Date.now() - started };
          } catch (error) {
            return { step, error };
          }
        }),
      );

      let failed = false;
      let handoff = null;
      for (const r of results) {
        if (r.error) {
          failed = true;
          if (r.error.message !== 'Stopped') addMessage(thread, 'system', `${LABEL[r.step.agent]} could not answer: ${r.error.message}`, emit);
          continue;
        }
        const { step, p, reply, ms } = r;
        thread.sessions[step.agent] = reply.session;
        thread.cursors[step.agent] = p.seenUpTo;
        const finished = reply.text.includes('[[DONE]]');
        const clean = reply.text.replace(/\[\[DONE\]\]/g, '').trim();
        if (clean) addMessage(thread, step.agent, clean, emit, { role: step.role, step: step.n, of: total(), ms });
        saveThread(thread);
        if (finished) stages.length = si + 1; // an agent ended the exchange early
        else if (!handoff) handoff = findHandoff(clean, step.agent, settings);
      }
      emit({ type: 'step', threadId, stage: si, state: failed ? 'error' : 'done', agents: stage.map((s) => s.agent) });
      if (failed || abort.signal.aborted) break;

      // The last stage may end with "@codex please check this": run that as one more step, within the cap.
      if (si === stages.length - 1 && handoff && handoffs < settings.maxTurns) {
        handoffs += 1;
        stages.push([{ ...handoff, n: total() + 1 }]);
        emit({ type: 'plan', threadId, plan: { ...plan, label: `${plan.label} → ${LABEL[handoff.agent]} ${ROLE_LABEL[handoff.role].toLowerCase()}s`, stages } });
      }
    }
  } finally {
    running.delete(threadId);
    emit({ type: 'status', threadId, agents: [], state: 'idle' });
  }
}

function makeTitle(text) {
  const t = text.replace(/^(\s*@\w+\s*)+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New thread';
  if (t.length <= 48) return t;
  const cut = t.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 24 ? cut.lastIndexOf(' ') : 48)}…`;
}
