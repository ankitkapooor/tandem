// Turns a user message (plus a mode chip) into a plan: ordered stages of steps.
// Steps inside one stage run at the same time; stages run one after another.
// Pure rules, no model calls, so planning costs no tokens.

export const AGENT_IDS = ['claude', 'codex'];
export const MODES = ['solo', 'relay', 'parallel', 'debate'];

export const ROLE_LABEL = {
  answer: 'Answer',
  critique: 'Critique',
  revise: 'Revise',
  rebut: 'Rebut',
  merge: 'Merge',
  summarize: 'Summarize',
};

const ALIAS = {
  claude: 'claude',
  anthropic: 'claude',
  codex: 'codex',
  chatgpt: 'codex',
  chat: 'codex',
  gpt: 'codex',
};
const GROUP = new Set(['both', 'all', 'team']);
const MENTION = /@(claude|anthropic|codex|chatgpt|chat|gpt|both|all|team)\b/gi;

// First verb found in a clause decides the role of the agent it follows.
const ROLE_WORDS = [
  ['critique', /\b(critiqu\w*|review\w*|check\w*|challeng\w*|poke|judg\w*|evaluat\w*|audit\w*|roast\w*|feedback|fact-?check\w*|verify|disagree\w*|push back)\b/i],
  ['revise', /\b(improv\w*|revis\w*|fix\w*|refin\w*|rewrit\w*|polish\w*|update)\b/i],
  ['summarize', /\b(summari[sz]\w*|tl;?dr|sum up|recap)\b/i],
  ['merge', /\b(merg\w*|reconcil\w*|combin\w*|synthesi[sz]\w*|decide)\b/i],
  ['answer', /\b(answer\w*|respond\w*|repl\w*|explain\w*|write|draft|say|think|propose|suggest\w*|give|tell|take|start)\b/i],
];

export function detectRole(clause) {
  let best = null;
  for (const [role, re] of ROLE_WORDS) {
    const m = re.exec(clause);
    if (m && (!best || m.index < best.index)) best = { role, index: m.index };
  }
  return best?.role || null;
}

export function parseMentions(text) {
  const out = [];
  MENTION.lastIndex = 0;
  let m;
  while ((m = MENTION.exec(text))) {
    const key = m[1].toLowerCase();
    out.push({ agent: GROUP.has(key) ? 'both' : ALIAS[key], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const other = (a) => (a === 'claude' ? 'codex' : 'claude');

function numbered(stages) {
  let n = 0;
  return stages.map((stage) => stage.map((s) => ({ ...s, n: ++n })));
}

function describe(stages) {
  return stages
    .map((stage) => stage.map((s) => `${s.agent === 'claude' ? 'Claude' : 'Codex'} ${ROLE_LABEL[s.role].toLowerCase()}s`).join(' + '))
    .join(' → ');
}

function enabledList(settings) {
  return AGENT_IDS.filter((a) => settings[a]?.enabled);
}

export function buildPlan(text, { mode = 'relay', settings }) {
  const enabled = enabledList(settings);
  if (!enabled.length) return { mode: 'solo', source: 'none', stages: [], label: 'No agents are enabled' };

  const mentions = parseMentions(text);
  const named = [...new Set(mentions.filter((m) => m.agent !== 'both').map((m) => m.agent))].filter((a) => enabled.includes(a));

  // 1. Your words win: "@chat answer, then @claude critique" is read left to right.
  if (named.length >= 2) {
    const stages = [];
    mentions.forEach((m, i) => {
      if (m.agent === 'both' || !enabled.includes(m.agent)) return;
      if (stages.length && stages[stages.length - 1][0].agent === m.agent) return; // same agent twice in a row is one step
      const clauseEnd = mentions[i + 1] ? mentions[i + 1].start : text.length;
      const role = detectRole(text.slice(m.end, clauseEnd)) || (stages.length ? 'critique' : 'answer');
      stages.push([{ agent: m.agent, role }]);
    });
    const numberedStages = numbered(stages);
    return { mode: 'custom', source: 'message', stages: numberedStages, label: describe(numberedStages) };
  }
  if (named.length === 1 && !mentions.some((m) => m.agent === 'both')) {
    const m = mentions.find((x) => x.agent === named[0]);
    const next = mentions.find((x) => x.start > m.start);
    const role = detectRole(text.slice(m.end, next ? next.start : text.length)) || 'answer';
    const stages = numbered([[{ agent: named[0], role }]]);
    return { mode: 'solo', source: 'message', stages, label: describe(stages) };
  }

  // 2. Otherwise the mode chip decides, using your default roles from Settings.
  const A = enabled.includes(settings.roles.answer) ? settings.roles.answer : enabled[0];
  const C = enabled.find((a) => a !== A && a === settings.roles.critique) || enabled.find((a) => a !== A);
  let stages;
  if (!C || mode === 'solo') {
    stages = [[{ agent: A, role: 'answer' }]];
  } else if (mode === 'parallel') {
    stages = [[{ agent: A, role: 'answer', blind: true }, { agent: C, role: 'answer', blind: true }], [{ agent: A, role: 'merge' }]];
  } else if (mode === 'debate') {
    const rounds = Math.max(2, Math.min(settings.maxTurns, 8));
    stages = Array.from({ length: rounds }, (_, i) => [{ agent: i % 2 ? C : A, role: i === 0 ? 'answer' : 'rebut' }]);
  } else {
    stages = [[{ agent: A, role: 'answer' }], [{ agent: C, role: 'critique' }]];
    if (settings.revise) stages.push([{ agent: A, role: 'revise' }]);
  }
  const numberedStages = numbered(stages);
  return { mode: MODES.includes(mode) ? mode : 'relay', source: 'mode', stages: numberedStages, label: describe(numberedStages) };
}

// Validates a plan edited in the UI before it is trusted.
export function sanitizePlan(plan, settings) {
  if (!plan || !Array.isArray(plan.stages)) return null;
  const enabled = enabledList(settings);
  const stages = [];
  let count = 0;
  for (const stage of plan.stages.slice(0, 12)) {
    const steps = (Array.isArray(stage) ? stage : [])
      .filter((s) => enabled.includes(s?.agent) && ROLE_LABEL[s?.role])
      .map((s) => ({ agent: s.agent, role: s.role, blind: !!s.blind }));
    if (!steps.length) continue;
    count += steps.length;
    if (count > 12) break;
    stages.push(steps);
  }
  if (!stages.length) return null;
  const numberedStages = numbered(stages);
  return { mode: 'custom', source: 'edited', stages: numberedStages, label: describe(numberedStages) };
}

export const otherAgent = other;
