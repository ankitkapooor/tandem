import { el, ico, toast } from './ui.js';

/* ---------- tiny syntax highlighter (no dependencies) ---------- */

const KW = new Set(
  ('abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum except export extends ' +
    'false finally fn for from func function go if impl import in interface is lambda let loop match mod mut new nil none not null of or package pass pub raise ' +
    'return self static struct super switch then this throw true try type typeof undefined use var void while with yield').split(' '),
);
const HASH = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'dockerfile', 'ini']);
const SLASH = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'java', 'c', 'cpp', 'cs', 'csharp', 'go', 'rust', 'rs', 'swift', 'kotlin', 'php', 'scss', 'css', 'json', 'jsonc']);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(code, lang) {
  if (!HASH.has(lang) && !SLASH.has(lang) && lang !== 'html' && lang !== 'xml' && lang !== 'sql') return esc(code);
  const parts = [];
  if (lang === 'html' || lang === 'xml') parts.push('(?<c><!--[\\s\\S]*?-->)', '(?<t></?[a-zA-Z][\\w:-]*)', '(?<s>"[^"\\n]*"|\'[^\'\\n]*\')');
  else {
    if (HASH.has(lang)) parts.push('(?<c>#[^\\n]*)');
    if (SLASH.has(lang)) parts.push('(?<c>//[^\\n]*|/\\*[\\s\\S]*?\\*/)');
    if (lang === 'sql') parts.push('(?<c>--[^\\n]*)');
    parts.push('(?<s>"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)', '(?<n>\\b\\d[\\d_.]*\\b)', '(?<w>\\b[A-Za-z_][\\w]*\\b)');
  }
  const re = new RegExp(parts.join('|'), 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const g = m.groups;
    const text = esc(m[0]);
    if (g.c) out += `<i class="tk-c">${text}</i>`;
    else if (g.s) out += `<i class="tk-s">${text}</i>`;
    else if (g.n) out += `<i class="tk-n">${text}</i>`;
    else if (g.t) out += `<i class="tk-k">${text}</i>`;
    else if (g.w) {
      const w = m[0];
      const next = code[m.index + w.length];
      out += KW.has(w.toLowerCase()) ? `<i class="tk-k">${text}</i>` : next === '(' ? `<i class="tk-f">${text}</i>` : text;
    } else out += text;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

/* ---------- mermaid ---------- */

let mermaidPromise;
let mermaidCount = 0;
function loadMermaid() {
  mermaidPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.js';
    s.onload = () => {
      const dark = !matchMedia('(prefers-color-scheme: light)').matches;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: dark
          ? { background: 'transparent', primaryColor: '#1b1d27', primaryTextColor: '#ececf3', primaryBorderColor: '#3a3e52', lineColor: '#8a8fa6', secondaryColor: '#15161e', tertiaryColor: '#101118', fontFamily: 'inherit' }
          : { background: 'transparent', primaryColor: '#f1f2f7', primaryTextColor: '#171923', primaryBorderColor: '#c8cbdb', lineColor: '#6b6f85', fontFamily: 'inherit' },
      });
      resolve(window.mermaid);
    };
    s.onerror = () => reject(new Error('Diagrams need mermaid. Run "npm install" in the tandem folder.'));
    document.head.append(s);
  });
  return mermaidPromise;
}

/* ---------- code block component ---------- */

function copyButton(getText) {
  const b = el('button', { type: 'button', className: 'cb-btn', title: 'Copy' });
  const set = (name, label) => {
    b.replaceChildren(ico(name, 14), label);
  };
  set('copy', 'Copy');
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      set('check', 'Copied');
    } catch {
      toast('Could not copy', 'bad');
    }
    setTimeout(() => set('copy', 'Copy'), 1400);
  };
  return b;
}

export function codeBlock(lang, code) {
  const wrap = el('div', { className: 'codeblock' });
  const head = el('div', { className: 'codehead' }, el('span', { className: 'lang', textContent: lang || 'text' }));
  const source = el('pre', {}, el('code', { html: highlight(code, lang) }));
  wrap.append(head);

  if (lang === 'mermaid' || lang === 'html') {
    const out = el('div');
    const tabs = ['view', 'code'].map((m) => {
      const b = el('button', { type: 'button', className: 'cb-tab', textContent: m === 'view' ? (lang === 'html' ? 'Preview' : 'Diagram') : 'Code' });
      b.dataset.m = m;
      b.onclick = () => show(m);
      return b;
    });
    const show = (mode) => {
      source.hidden = mode !== 'code';
      out.hidden = mode === 'code';
      tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.m === mode)));
    };
    head.append(el('span', { className: 'tabs' }, ...tabs));
    wrap.append(out, source);
    if (lang === 'html') {
      out.className = 'preview';
      // No same-origin: the preview cannot reach tandem's API or storage.
      const f = el('iframe', { title: 'HTML preview' });
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = code;
      out.append(f);
    } else {
      out.className = 'diagram';
      out.append(el('div', { className: 'shimmer-line', style: 'width:60%;margin:18px auto' }));
      loadMermaid()
        .then((m) => m.render(`mmd${mermaidCount++}`, code))
        .then(({ svg }) => (out.innerHTML = svg))
        .catch((e) => {
          out.className = 'diagram err';
          out.textContent = `Could not draw this diagram: ${e.message}`;
        });
    }
    show('view');
  } else {
    wrap.append(source);
  }
  head.append(copyButton(() => code));
  return wrap;
}
