import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = (tag, props = {}, ...kids) => {
  const { html, dataset, style, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  if (html != null) n.innerHTML = html;
  if (dataset) Object.assign(n.dataset, dataset);
  if (style) n.style.cssText = style;
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};

export const ico = (name, size) => el('span', { className: 'ico', html: icon(name, size) });

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export function ago(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function dayLabel(ts) {
  const day = (t) => new Date(t).setHours(0, 0, 0, 0);
  const diff = Math.round((day(Date.now()) - day(ts)) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  return 'Older';
}

export function fmtMs(ms) {
  if (!ms) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

let openPopover = null;
export function closePopover() {
  openPopover?.close();
}

// Floating panel anchored to an element. Closes on outside click, Escape, or when closePopover() runs.
export function popover(anchor, content, { place = 'top', align = 'start', width } = {}) {
  closePopover();
  const pop = el('div', { className: 'popover', role: 'dialog' }, content);
  if (width) pop.style.width = `${width}px`;
  document.body.append(pop);
  const place_ = () => {
    const a = anchor.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const narrow = innerWidth < 640;
    let left = align === 'end' ? a.right - r.width : a.left;
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
    let top = place === 'top' ? a.top - r.height - 8 : a.bottom + 8;
    if (top < 8) top = a.bottom + 8;
    if (top + r.height > innerHeight - 8) top = Math.max(8, a.top - r.height - 8);
    pop.style.left = `${narrow ? 8 : left}px`;
    pop.style.top = `${top}px`;
    pop.classList.add('in');
  };
  requestAnimationFrame(place_);
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const close = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
    if (openPopover?.pop === pop) openPopover = null;
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  openPopover = { close, pop };
  return { close, pop, reposition: place_ };
}

export function toast(message, kind = '') {
  const t = el('div', { className: `toast ${kind}`, textContent: message, role: 'status' });
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 250);
  }, 2600);
}
