// Inline stroke icons (24x24 grid).
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  brush: '<path d="M18.4 3.6a2 2 0 0 1 2.9 2.9L11 16.8 7.2 13z"/><path d="M7 14c-2 0-3.5 1.5-3.5 3.5 0 1.2-.5 2-1.5 2.5 3 1 7 .5 7-3.5"/>',
  pen: '<path d="m15 4 5 5L9 20H4v-5z"/><path d="m13 6 5 5"/>',
  eraser: '<path d="m7 20-3.3-3.3a1.5 1.5 0 0 1 0-2.1L13.6 4.7a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L11.4 20z"/><path d="M7 20h13M9 11l5.5 5.5"/>',
  select: '<path d="M5 3l14 7-6 2-2 6z"/>',
  line: '<path d="M5 19 19 5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  fill: '<path d="M5 11 12 4l7 7-7 7z"/><path d="M5 11h14"/><path d="M20 15s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16.5a1.5 1.5 0 0 1 2.3-2L8 17"/>',
  first: '<path d="M6 5v14M18 6l-8 6 8 6z"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  play: '<path d="M7 5v14l12-7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  last: '<path d="M18 5v14M6 6l8 6-8 6z"/>',
  key: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  keyblank: '<circle cx="12" cy="12" r="5"/>',
  plusframe: '<rect x="3" y="5" width="12" height="14" rx="1.5"/><path d="M19 9v6M16 12h6"/>',
  insert: '<path d="M4 12h12M12 8l4 4-4 4M20 5v14"/>',
  remove: '<path d="M20 12H8M12 8l-4 4 4 4M4 5v14"/>',
  tween: '<circle cx="5" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="12" r="2.5" fill="currentColor"/><path d="M8 12h8M13 9l3 3-3 3"/>',
  onion: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  loop: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z"/><path d="M8 3v5h7V3"/><rect x="7" y="13" width="10" height="7" rx="1"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};
export function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}
export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
}
