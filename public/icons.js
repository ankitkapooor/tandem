// Small stroke icon set. icon('name', size) returns an inline SVG string.
const P = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3.5 20.5l1.4-4.8A8.5 8.5 0 1 1 21 11.5Z"/>',
  memory: '<path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11.5H8.5A3.5 3.5 0 0 1 5 16V4.5Z"/><path d="M9 9h6M9 12.5h4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  compose: '<path d="M12 20h8.5"/><path d="M16.2 3.8a2.3 2.3 0 0 1 3.3 3.2L7.6 18.9 3.5 20l1.1-4.1L16.2 3.8Z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  up: '<path d="M12 19V5.5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15V6.5A2.5 2.5 0 0 1 8 4h8.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4.5 7h15M9.5 11v6M14.5 11v6M6.5 7l.8 12.2A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7M9 7V4.5h6V7"/>',
  sparkle: '<path d="M11 3.5 12.9 9l5.6 1.9-5.6 1.9L11 18.4 9.1 12.8 3.5 10.9 9.1 9 11 3.5Z"/><path d="M19 3v4M17 5h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  phone: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M11 18h2"/>',
  arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  solo: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  relay: '<path d="M4 8h13.5L14 4.5M20 16H6.5L10 19.5"/>',
  parallel: '<path d="M5 8h14M5 16h14"/>',
  debate: '<path d="M4 5h10.5v7.5H8.5L4 16V5Z"/><path d="M10 15.5h4.5l4.5 3v-8"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z"/>',
  pencil: '<path d="M16.2 3.8a2.3 2.3 0 0 1 3.3 3.2L7.6 18.9 3.5 20l1.1-4.1L16.2 3.8Z"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
};

export function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
