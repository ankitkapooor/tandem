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

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Keeps Tab inside a container and returns focus to where it was when released.
function trapFocus(root, onEscape) {
  const back = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onEscape();
    }
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  };
}

// Floating panel anchored to an element. On a phone it becomes a bottom sheet.
export function popover(anchor, content, { place = 'top', align = 'start', width, label = 'Options' } = {}) {
  closePopover();
  const phone = innerWidth < 640;
  const pop = el('div', { className: `popover ${phone ? 'sheet' : ''}`, role: 'dialog' }, content);
  pop.setAttribute('aria-label', label);
  if (width && !phone) pop.style.width = `${width}px`;
  const scrim = phone ? el('div', { className: 'sheet-scrim' }) : null;
  if (scrim) document.body.append(scrim);
  document.body.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  const place_ = () => {
    if (!phone) {
      const a = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      let left = align === 'end' ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      pop.style.left = `${left}px`;
      const above = a.top - 16;
      const below = innerHeight - a.bottom - 16;
      // Anchored by the edge nearest the button, so a panel that grows keeps growing away from it.
      if (place === 'top' ? above > 220 || above > below : below < 220 && above > below) {
        pop.style.top = 'auto';
        pop.style.bottom = `${innerHeight - a.top + 8}px`;
        pop.style.maxHeight = `${Math.min(560, above)}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${a.bottom + 8}px`;
        pop.style.maxHeight = `${Math.min(560, below)}px`;
      }
    }
    pop.classList.add('in');
  };
  requestAnimationFrame(() => {
    place_();
    if (!pop.contains(document.activeElement)) (pop.querySelector(FOCUSABLE) || pop).focus({ preventScroll: true });
  });
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const release = trapFocus(pop, () => close());
  const close = () => {
    document.removeEventListener('pointerdown', onDown, true);
    release();
    anchor.removeAttribute('aria-expanded');
    scrim?.remove();
    pop.remove();
    if (openPopover?.pop === pop) openPopover = null;
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  openPopover = { close, pop };
  return { close, pop, reposition: place_ };
}

// Replaces window.confirm: names the object, and the dangerous button says what it does.
export function confirmDialog({ title, body, confirm = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const cancel = el('button', { className: 'btn quiet', type: 'button', textContent: 'Cancel' });
    const ok = el('button', { className: `btn ${danger ? 'danger' : ''}`, type: 'button', textContent: confirm });
    const box = el('div', { className: 'dialog', role: 'alertdialog' }, el('h3', { textContent: title }), el('p', { textContent: body }), el('div', { className: 'acts' }, cancel, ok));
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    const wrap = el('div', { className: 'dialog-wrap' }, box);
    document.body.append(wrap);
    const release = trapFocus(box, () => done(false));
    const done = (v) => {
      release();
      wrap.remove();
      resolve(v);
    };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    wrap.onpointerdown = (e) => e.target === wrap && done(false);
    cancel.focus();
  });
}

// Screen-reader announcements for things that appear without focus moving.
export function announce(text) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => (live.textContent = text), 30);
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
