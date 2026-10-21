(() => {
'use strict';

/* ------------------------------------------------------------ utilities */
const $ = (s, el = document) => el.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BANNERS = [
  'linear-gradient(120deg,#1d4ed8,#38bdf8)', 'linear-gradient(120deg,#0f766e,#5eead4)', 'linear-gradient(120deg,#0e7490,#a3e635)',
  'linear-gradient(120deg,#1e3a8a,#60a5fa)', 'linear-gradient(120deg,#166534,#86efac)', 'linear-gradient(120deg,#b45309,#fcd34d)',
  'linear-gradient(120deg,#334155,#94a3b8)', 'linear-gradient(120deg,#0369a1,#2dd4bf)'
];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); // text nodes only: no HTML injection
  }
  return el;
}

const DEFAULT_REMOTE_BACKEND = 'https://lukaymobileapps-502240410285.europe-west2.run.app';
const IS_NATIVE_SHELL = (typeof window !== 'undefined' && (window.Capacitor !== undefined || location.protocol === 'capacitor:' || (location.hostname === 'localhost' && (!location.port || location.port === '80'))));
const API_BASE = IS_NATIVE_SHELL
  ? (localStorage.getItem('novastream_server_url') || DEFAULT_REMOTE_BACKEND)
  : '';

function apiUrl(path) {
  if (!path || /^https?:\/\//i.test(path)) return path;
  return API_BASE + path;
}
window.NovaStreamApiUrl = apiUrl;

const S = {
  token: localStorage.getItem('novastream_token'),
  user: null,
  cfg: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], categories: ['Just Chatting', 'Gaming', 'Music'], reactions: ['❤️', '🔥', '🫶', '😭', '💀', '🤯', '😂', '🎉', '👏'], platforms: ['Website'] },
  blocked: new Set(),
  socket: null,
  local: null,
  hosting: null,
  peers: new Map(),
  cleanup: null
};

async function api(path, opts = {}) {
  const url = apiUrl(path);
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // a revoked or suspended session: sign out cleanly instead of showing confusing errors
    const lost = res.status === 401 || (res.status === 403 && data.suspended);
    if (lost && S.token && !opts.noExpire && !/^\/api\/(login|register|appeal|reset-password)/.test(path)) sessionExpired(data.suspended ? data.error : 'You were signed out. Please log in again.');
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
function sessionExpired(message) {
  localStorage.removeItem('novastream_token');
  S.token = null; S.user = null; S.blocked = new Set(); S.unread = 0;
  stopHosting(); connectSocket(); renderTop(); renderSide();
  toast(message, 6000);
  go('#/login');
}
function toast(msg, ms = 3500, link) {
  const t = link ? h('a', { class: 'toast', href: link }, msg) : h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
// fills an element, skipping null/false so nothing prints as the word "null" or "false"
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const add = (el, ...kids) => el.append(...kids.flat().filter(k => k != null && k !== false));
const initial = n => (n || '?')[0].toUpperCase();
// an avatar value is either an emoji or the address of an uploaded photo (/avatars/...)
const isPhoto = v => typeof v === 'string' && v.startsWith('/avatars/');
const avatar = (name, color, emoji, big) =>
  isPhoto(emoji)
    ? h('span', { class: 'avatar has-img' + (big ? ' lg' : ''), style: `background:${color}`, 'aria-hidden': 'true' }, h('img', { src: emoji, alt: '', loading: big ? 'eager' : 'lazy', decoding: 'async' }))
    : h('span', { class: 'avatar' + (big ? ' lg' : ''), style: `background:${color}`, 'aria-hidden': 'true' }, emoji || initial(name));
const thumbArt = (v, name) => isPhoto(v) ? h('img', { class: 'thumb-avatar', src: v, alt: '' }) : (v || initial(name));
const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };
const parseTags = s => [...new Set(String(s || '').toLowerCase().split(/[\s,]+/).map(x => x.replace(/[^a-z0-9-]/g, '')).filter(Boolean))].slice(0, 5);
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const field = (label, input, hint) => h('label', null, h('span', { class: 'flabel' }, label), input, hint && h('span', { class: 'hint' }, hint));

const REPORT_REASONS = [['spam', 'Spam or a scam'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'], ['sexual', 'Sexual content'],
  ['violence', 'Violence or threats'], ['self-harm', 'Self-harm or someone in danger'], ['impersonation', 'Pretending to be someone else'], ['underage', 'Someone seems to be under 13'], ['other', 'Something else']];
// one report dialog for messages, posts, comments, profiles, Circles and streams. Reports go to NovaStream admins.
function reportDialog({ type, target, username, context, label }) {
  if (!S.user) return go('#/login');
  const cat = h('select', { 'aria-label': 'Reason' }, REPORT_REASONS.map(([v, l]) => h('option', { value: v }, l)));
  const note = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Anything else we should know? (optional)', 'aria-label': 'Details' });
  const err = h('div', { class: 'err', role: 'alert' });
  const urgent = h('p', { class: 'urgent', hidden: true }, 'If someone is in immediate danger, please contact your local emergency services first. We will review this report as a priority.');
  cat.addEventListener('change', () => { urgent.hidden = !['self-harm', 'underage'].includes(cat.value); });
  const close = () => { modal.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const modal = h('div', { class: 'modal', onclick: e => { if (e.target === modal) close(); } },
    h('form', { class: 'modalbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report ' + label, onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('/api/reports', { method: 'POST', body: { type, target, username, context, category: cat.value, note: note.value } });
        close(); toast(r.duplicate ? 'You already reported this. Our team has it.' : 'Thanks. Our team will review your report and let you know what we decide.', 5000);
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('h2', null, 'Report ' + label), h('p', { class: 'hint' }, 'Reports go to NovaStream admins. The person is not told it was you.'),
      field('Why are you reporting this?', cat), urgent, field('Details', note), err,
      h('div', { class: 'row2' }, h('button', { class: 'btn danger', type: 'submit' }, 'Send report'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  document.body.append(modal);
  document.addEventListener('keydown', esc);
  cat.focus();
}
const verifiedMark = () => h('span', { class: 'vtick', title: 'Verified identity (this is not an endorsement of what they say)', 'aria-label': 'Verified' }, '✓');

function connectSocket() {
  if (typeof io !== 'function') return;
  if (S.socket) { try { S.socket.disconnect(); } catch {} }
  try {
    S.socket = io(API_BASE || undefined, { auth: { token: S.token } });
    S.socket.on('notify', n => { setUnread((S.unread || 0) + 1); toast(n.text, 5000, n.link); });
  } catch (e) { console.warn('Socket init:', e); }
}
function setUnread(n) {
  S.unread = n;
  const b = $('#bellcount');
  if (b) { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; }
}
async function loadBlocks() {
  S.blocked = new Set();
  if (!S.user) return;
  try { (await api('/api/blocks')).blocks.forEach(b => S.blocked.add(b.id)); } catch { /* optional */ }
}

/* --------------------------------------------------------------- chrome */
function closeDrawer() {
  document.body.classList.remove('side-open');
  const b = $('.menubtn'); if (b) b.setAttribute('aria-expanded', 'false');
}
function toggleDrawer() {
  const open = document.body.classList.toggle('side-open');
  const b = $('.menubtn'); if (b) b.setAttribute('aria-expanded', String(open));
}

/* ------------------------------------------------- back navigation */
// Every page the app shows gets a number in the browser history, so "Back" knows whether there is
// an earlier NovaStream page to return to (and falls back to the start page when there is not).
function trackNav() {
  const st = history.state;
  if (st && typeof st.nsIdx === 'number') S.navIdx = st.nsIdx; // back/forward/reload: the number is already stored
  else {
    if (S.keepIdx != null) { S.navIdx = S.keepIdx; S.keepIdx = null; } // a redirect replaces a page, it is not a new one
    else S.navIdx = S.navIdx == null ? 0 : S.navIdx + 1;
    try { history.replaceState({ nsIdx: S.navIdx }, '', location.href); } catch { /* history is optional */ }
  }
}
const rootHash = () => (S.user ? '#/' : '#/feed');
function replaceHash(hash) { S.keepIdx = S.navIdx; location.replace(hash); }
function goBack() { if ((S.navIdx || 0) > 0) history.back(); else go(rootHash()); }
function updateBack() {
  const b = $('#backbtn'); if (!b) return;
  const cur = location.hash || '#/';
  b.hidden = cur === '#/' || cur === '#' || (!S.user && cur === '#/feed');
  document.body.classList.toggle('has-back', !b.hidden);
}

// Twitch-style username colours: every person gets one stable, bright colour from a fixed palette
const TW_COLORS = ['#FF5C5C', '#5B8CFF', '#3DFF7A', '#FF7A7A', '#FF8A5C', '#B5E04B', '#FF6A33', '#3FD394', '#F5B82E', '#EE8E45', '#6CC3C6', '#3EA6FF', '#FF7BC0', '#B26BFF', '#27FFA3'];
function twitchColor(name) {
  let x = 0;
  for (const ch of String(name).toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return TW_COLORS[x % TW_COLORS.length];
}

function renderTop() {
  const guest = !S.user;
  document.body.classList.toggle('guest', guest);
  fill($('#top'),
    h('button', { class: 'backbtn', id: 'backbtn', type: 'button', 'aria-label': 'Go back', title: 'Go back', hidden: true, onclick: goBack },
      window.NSIcons.icon('chevronleft', 22)),
    h('button', { class: 'menubtn', 'aria-label': 'Open menu', 'aria-expanded': 'false', onclick: toggleDrawer }, '☰'),
    h('a', { href: rootHash(), class: 'logo', 'aria-label': 'NovaStream home' }, h('i'), 'NovaStream'),
    h('nav', { class: 'tabs', 'aria-label': 'Main' },
      guest ? h('a', { href: '#/feed' }, 'Feed') : [
        h('a', { href: '#/' }, 'Browse'),
        h('a', { href: '#/feed' }, 'Feed'),
        h('a', { href: '#/circles' }, 'Circles'),
        h('a', { href: '#/following' }, 'Following'),
        h('a', { href: '#/dashboard' }, 'Dashboard'),
        S.user.isAdmin && h('a', { href: '#/admin' }, 'Admin')]),
    guest ? null : h('form', { class: 'search', role: 'search', onsubmit: e => {
      e.preventDefault();
      const v = $('input', e.target).value.trim();
      go(v ? '#/search/' + encodeURIComponent(v) : '#/search');
    } }, h('input', { type: 'search', placeholder: 'Find people, streams, Circles...', 'aria-label': 'Search NovaStream' })),
    h('span', { class: 'grow' }),
    guest ? null : h('a', { href: '#/search', class: 'searchbtn', title: 'Search', 'aria-label': 'Search' }, window.NSIcons.icon('search', 20)),
    h('div', { class: 'actions' },
      S.user
        ? [h('a', { href: '#/notifications', class: 'bell', title: 'Notifications', 'aria-label': 'Notifications' }, window.NSIcons.icon('bell', 20),
             h('span', { id: 'bellcount', class: 'bcount', hidden: !S.unread }, S.unread > 99 ? '99+' : S.unread)),
           h('a', { href: '#/golive', class: 'btn primary', id: 'golivebtn', 'data-golive': 'Go live' }, window.NSIcons.icon('live', 16), h('span', { class: 'gl-l' }, 'Go live')),
           h('a', { href: '#/u/' + S.user.username, class: 'hdr-avatar', title: 'Your profile', 'aria-label': 'Your profile' }, avatar(S.user.username, S.user.color, S.user.avatar)),
           h('button', { class: 'btn small hide-sm', onclick: logout }, 'Log out')]
        : [h('a', { href: '#/login', class: 'btn' }, 'Log in'), h('a', { href: '#/signup', class: 'btn primary' }, 'Sign up')]));
  updateBack(); updateGoLive();
}

// Quick-navigation dock: icons only, tucked away at the bottom edge. Move the pointer to the bottom of the
// screen (or tap the little handle on a touch screen) and it slides up; it tucks away again by itself.
function renderBottom() {
  let nav = $('#bottom');
  if (!nav) {
    nav = h('nav', { id: 'bottom', 'aria-label': 'Quick navigation' });
    const zone = h('div', { id: 'dockzone', 'aria-hidden': 'true' });
    const handle = h('button', { id: 'dockhandle', type: 'button', 'aria-label': 'Show quick navigation', 'aria-expanded': 'false' }, h('i'));
    document.body.append(zone, handle, nav);
    wireDock(nav, zone, handle);
    window.addEventListener('hashchange', markDock);
    document.addEventListener('themechange', () => { const b = $('#dock-theme'); if (b) fill(b, window.NSIcons.icon(window.NSTheme.resolved() === 'light' ? 'moon' : 'sun', 22)); });
  }
  const item = (href, ic, label, o = {}) => h('a', { href, 'data-href': href, 'data-label': label, 'aria-label': label, 'data-golive': o.golive ? label : null, class: 'dk' + (o.cls ? ' ' + o.cls : '') },
    window.NSIcons.icon(ic, o.size || 22), o.badge ? h('span', { class: 'dk-badge' }, o.badge > 9 ? '9+' : o.badge) : null);
  const themeBtn = h('button', { id: 'dock-theme', type: 'button', class: 'dk', 'data-label': 'Light / dark', 'aria-label': 'Switch between light and dark mode', onclick: () => window.NSTheme.toggle() },
    window.NSIcons.icon(window.NSTheme.resolved() === 'light' ? 'moon' : 'sun', 22));
  if (!S.user) fill(nav, item('#/feed', 'feed', 'Community feed'), item('#/login', 'key', 'Log in'), item('#/signup', 'sparkles', 'Sign up', { cls: 'go' }), themeBtn);
  else fill(nav,
    item('#/', 'home', 'Browse streams'), item('#/feed', 'feed', 'Community feed'), item('#/circles', 'circles', 'Circles'), item('#/search', 'search', 'Search'),
    item('#/golive', 'live', 'Go live', { cls: 'go', size: 24, golive: true }),
    item('#/notifications', 'bell', 'Alerts', { badge: S.unread }), item('#/u/' + S.user.username, 'user', 'My profile'), themeBtn);
  markDock(); updateGoLive();
}
function markDock() {
  const cur = location.hash || '#/';
  document.querySelectorAll('#bottom a.dk').forEach(a => {
    const on = a.dataset.href === cur || (a.dataset.href !== '#/' && cur.startsWith(a.dataset.href + '/'));
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function wireDock(nav, zone, handle) {
  let timer = null;
  let shownAt = 0;
  const show = () => { shownAt = Date.now(); clearTimeout(timer); nav.classList.add('show'); handle.classList.add('up'); handle.setAttribute('aria-expanded', 'true'); };
  const hide = () => { nav.classList.remove('show'); handle.classList.remove('up'); handle.setAttribute('aria-expanded', 'false'); };
  const later = ms => { clearTimeout(timer); timer = setTimeout(hide, ms); };
  // touch screens fake mouse events after a tap; ignore the "mouse left" one so the dock stays up for its timer
  let lastTouch = 0;
  document.addEventListener('touchstart', () => { lastTouch = Date.now(); }, { passive: true, capture: true });
  [zone, handle, nav].forEach(el => { el.addEventListener('mouseenter', show); el.addEventListener('mouseleave', () => { if (Date.now() - lastTouch > 1500) later(450); }); });
  // a tap on a touch screen fires a hover first, so only treat the click as "close" if the dock had been open a while
  handle.addEventListener('click', () => { if (nav.classList.contains('show') && Date.now() - shownAt > 600) hide(); else { show(); later(6000); } });
  zone.addEventListener('touchstart', () => { show(); later(6000); }, { passive: true });
  handle.addEventListener('focus', () => { show(); later(6000); });
  nav.addEventListener('focusin', show);
  nav.addEventListener('focusout', () => later(300));
  nav.addEventListener('click', e => { if (e.target.closest('a')) later(900); else if (e.target.closest('button')) later(2500); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

/* ------------------------------------------------------------ the menu */
// The menu: a person card, a search box, and sections that open and close. It is the slide-out menu on
// tablets and phones; the channel lists under it (Following, Live now) show on every screen size.
S.menuOpen = { discover: true, space: true, account: true, about: false };
S.sideOpen = { following: true, live: true };
S.sideFilter = '';

const MENU_ICONS = { '📺': 'home', '🛡️': 'shield', '⭕': 'circles', '🙂': 'user', '👥': 'circles', '📊': 'dashboard', '📰': 'feed', '➕': 'heart', '🔴': 'live', '📜': 'scroll', '🔒': 'lock', '📄': 'scroll', '🔑': 'key', '🔔': 'bell', '🔍': 'search', '⚙️': 'settings', '✨': 'sparkles' };
function menuLink(href, icon, label, o = {}) {
  return h('a', { class: 'mi', href, 'data-href': href, 'data-golive': o.golive ? label : null },
    h('span', { class: 'mi-ico mi-' + (MENU_ICONS[icon] || 'x'), 'aria-hidden': 'true' }, MENU_ICONS[icon] ? window.NSIcons.icon(MENU_ICONS[icon], 20) : icon),
    h('span', { class: 'mi-txt' }, h('span', { class: 'mi-l' }, label), o.sub && h('small', null, o.sub)),
    o.badge ? h('span', { class: 'mi-badge' + (o.hot ? ' hot' : '') }, o.badge) : null,
    h('span', { class: 'mi-go', 'aria-hidden': 'true' }, '›'));
}
function menuGroup(key, title, items) {
  const open = S.menuOpen[key] !== false;
  const body = h('div', { class: 'mg-body', hidden: !open }, items);
  const head = h('button', { type: 'button', class: 'mg-head' + (open ? ' open' : ''), 'aria-expanded': String(open), onclick: () => {
    const now = body.hidden; // hidden now means it is about to open
    body.hidden = !now; S.menuOpen[key] = now;
    head.setAttribute('aria-expanded', String(now)); head.classList.toggle('open', now);
  } }, h('span', null, title), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
  return h('div', { class: 'mg' }, head, body);
}
function markMenu() {
  const cur = location.hash || '#/';
  document.querySelectorAll('#side a.mi').forEach(a => {
    const on = a.dataset.href === cur;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function drawMenu() {
  const nav = $('#menunav'); if (!nav) return;
  const me = S.user, st = S.me || {};
  const about = menuGroup('about', 'About NovaStream', [
    menuLink('#/legal/guidelines', '📜', 'Community Guidelines', { sub: 'How we keep it friendly' }),
    menuLink('#/legal/terms', '📄', 'Terms'), menuLink('#/legal/privacy', '🔒', 'Privacy')]);
  if (!me) {
    fill(nav,
      h('div', { class: 'mcard' }, h('b', null, 'Welcome to NovaStream'),
        h('p', { class: 'hint' }, 'You can read the community feed. Log in to watch streams, follow people, join Circles, search and go live.'),
        h('div', { class: 'mc-actions' }, h('a', { class: 'btn small primary', href: '#/signup' }, 'Sign up'), h('a', { class: 'btn small', href: '#/login' }, 'Log in'))),
      menuGroup('discover', 'Explore', [menuLink('#/feed', '📰', 'Community feed', { sub: 'Updates, questions and announcements' })]),
      menuGroup('account', 'Your account', [menuLink('#/login', '🔑', 'Log in', { sub: 'Welcome back' }), menuLink('#/signup', '✨', 'Create an account', { sub: 'Free, ages 13 and up' })]),
      about);
    markMenu(); updateGoLive(); return;
  }
  fill(nav,
    h('div', { class: 'mcard' },
      h('a', { class: 'mc-who', href: '#/u/' + me.username }, avatar(me.username, me.color, me.avatar, true),
        h('span', { class: 'mc-t' }, h('b', null, me.displayName), h('small', null, '@' + me.username))),
      h('div', { class: 'mc-counts' },
        h('a', { href: `#/u/${me.username}/followers` }, h('b', null, st.followers == null ? '-' : st.followers), ' followers'),
        h('a', { href: `#/u/${me.username}/following` }, h('b', null, st.followingCount == null ? '-' : st.followingCount), ' following')),
      h('div', { class: 'mc-actions' }, h('a', { class: 'btn small primary', href: '#/golive', 'data-golive': 'Go live' }, window.NSIcons.icon('live', 16), h('span', { class: 'gl-l' }, 'Go live')),
        h('a', { class: 'btn small', href: '#/notifications' }, S.unread ? `Alerts (${S.unread})` : 'Alerts'))),
    h('form', { class: 'mc-search', role: 'search', onsubmit: e => {
      e.preventDefault();
      const v = $('input', e.target).value.trim();
      go(v ? '#/search/' + encodeURIComponent(v) : '#/search');
    } }, h('input', { type: 'search', placeholder: 'Search NovaStream', 'aria-label': 'Search NovaStream from the menu' })),
    menuGroup('discover', 'Explore', [
      menuLink('#/', '📺', 'Browse', { sub: 'Live streams and categories', badge: S.liveCount ? `${S.liveCount} live` : '', hot: true }),
      menuLink('#/feed', '📰', 'Community feed', { sub: 'Updates, questions and announcements' }),
      menuLink('#/circles', '⭕', 'Circles', { sub: 'Communities to join' }),
      menuLink('#/search', '🔍', 'Search', { sub: 'People, streams, Circles and posts' })]),
    menuGroup('space', 'My space', [
      menuLink('#/u/' + me.username, '🙂', 'My profile', { sub: 'Picture, bio, links and posts' }),
      menuLink(`#/u/${me.username}/followers`, '👥', 'My followers', { sub: 'See who follows you', badge: st.followers || '' }),
      menuLink('#/following', '➕', 'Following', { sub: 'Channels you follow', badge: st.followingCount || '' }),
      menuLink('#/notifications', '🔔', 'Notifications', { sub: 'Alerts and inbox', badge: S.unread ? (S.unread > 99 ? '99+' : S.unread) : '', hot: true }),
      menuLink('#/dashboard', '📊', 'Dashboard', { sub: 'Stats, moderators and channel settings' }),
      menuLink('#/golive', '🔴', 'Go live', { sub: 'Start streaming from your camera or screen', golive: true })]),
    menuGroup('account', 'Account', [
      menuLink('#/settings', '⚙️', 'Account settings', { sub: 'Password, devices and your data' }),
      me.isAdmin && menuLink('#/admin', '🛡️', 'Admin', { sub: 'Reports, users and site settings' })]),
    about,
    h('button', { class: 'btn small mi-logout', type: 'button', onclick: logout }, 'Log out'));
  markMenu(); updateGoLive();
}

function sideRow(c) {
  return h('a', { class: 'chan', href: '#/c/' + c.username },
    avatar(c.username, c.color, c.avatar),
    h('span', { class: 'meta' }, h('div', { class: 'n' }, c.username),
      h('div', { class: 'c' }, c.live ? [c.category || 'Live', ` · ${c.viewers || 0} watching`].join('') : 'Offline')),
    h('span', { class: 'dot' + (c.live ? '' : ' off'), title: c.live ? 'Live' : 'Offline' }));
}
function sideSection(key, title, rows, empty) {
  const open = S.sideOpen[key] !== false;
  const body = h('div', { class: 'sec-body', hidden: !open }, rows.length ? rows.map(sideRow) : h('p', { class: 'empty' }, empty));
  const head = h('button', { type: 'button', class: 'sec-head' + (open ? ' open' : ''), 'aria-expanded': String(open), onclick: () => {
    const now = body.hidden; body.hidden = !now; S.sideOpen[key] = now;
    head.setAttribute('aria-expanded', String(now)); head.classList.toggle('open', now);
  } }, h('span', null, title), h('span', { class: 'cnt-pill' }, rows.length), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
  return h('div', { class: 'sec' }, head, body);
}
function drawLists() {
  const box = $('#sidelists'); if (!box) return;
  const d = S.sideData, f = (S.sideFilter || '').trim().toLowerCase();
  $('#sidefilter').hidden = !S.user;
  if (!S.user || !d) return fill(box);
  const keep = c => !f || c.username.toLowerCase().includes(f) || (c.category || '').toLowerCase().includes(f);
  fill(box,
    sideSection('following', 'Following', d.following.filter(keep), f ? 'No followed channels match.' : 'Follow a channel to see it here.'),
    sideSection('live', 'Live now', d.streams.filter(keep), f ? 'No live channels match.' : 'No one is live yet.'));
}

async function renderSide() {
  const side = $('#side');
  if (!side.dataset.ready) { // the skeleton is built once, so typing in the filter box is never interrupted by a refresh
    side.dataset.ready = '1';
    const filter = h('div', { id: 'sidefilter', class: 'sidefilter', hidden: true },
      h('input', { type: 'search', placeholder: 'Filter channels', 'aria-label': 'Filter channels in the sidebar', oninput: e => { S.sideFilter = e.target.value; drawLists(); } }));
    side.replaceChildren(h('div', { class: 'drawer-nav', id: 'menunav' }), filter, h('div', { id: 'sidelists' }));
    let x0 = null; // swipe left on the open menu to close it
    side.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    side.addEventListener('touchend', e => { if (x0 != null && e.changedTouches[0].clientX - x0 < -60) closeDrawer(); x0 = null; }, { passive: true });
  }
  drawMenu(); drawLists();
  if (!S.user) { S.sideData = null; S.me = null; S.liveCount = 0; drawLists(); return; } // channel lists are for logged-in people
  try {
    const [{ streams }, { following }, prof] = await Promise.all([
      api('/api/streams'), api('/api/following'), api('/api/profile/' + encodeURIComponent(S.user.username)).catch(() => null)]);
    if (!S.user) return; // logged out while loading
    S.sideData = { streams: streams.map(s => ({ ...s, live: true })), following };
    S.liveCount = streams.length;
    if (prof) S.me = { followers: prof.followers, followingCount: prof.followingCount };
    drawMenu(); drawLists();
  } catch { /* keep what is already shown */ }
}

async function logout() {
  localStorage.removeItem('novastream_token');
  S.token = null; S.user = null; S.blocked = new Set(); S.unread = 0;
  stopHosting();
  connectSocket(); renderTop(); renderSide();
  if (location.hash === '#/feed') route(); else replaceHash('#/feed'); // logged-out visitors land on the feed
}

/* ----------------------------------------------------------------- home */
function streamCard(s) {
  return h('a', { class: 'card', href: '#/c/' + s.username },
    h('div', { class: 'thumb', style: `background:${s.color}` },
      thumbArt(s.avatar, s.username), h('span', { class: 'badge' }, 'LIVE'), h('span', { class: 'badge v' }, `${s.viewers} watching`)),
    h('div', { class: 'row' }, avatar(s.username, s.color, s.avatar),
      h('div', null, h('div', { class: 't' }, s.title), h('div', { class: 'u' }, s.username), h('div', { class: 'g' }, s.category),
        s.tags && s.tags.length ? h('div', { class: 'tagrow' }, s.tags.slice(0, 3).map(t => h('span', { class: 'tag' }, '#' + t))) : null)));
}

async function homePage(main) {
  const page = h('div', { class: 'page' });
  fill(main, page);
  let streams = [], following = [];
  try { streams = (await api('/api/streams')).streams; } catch (e) { toast(e.message); }
  if (S.user) { try { following = (await api('/api/following')).following.filter(f => f.live); } catch { /* optional */ } }
  let disc = { recommended: [], rising: [], circles: [] };
  try { disc = await api('/api/discover'); } catch { /* optional */ }
  let cat = 'All';
  const gridEl = h('div', { class: 'grid' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Categories' });
  const draw = () => {
    fill(chips, ...['All', ...S.cfg.categories].map(c =>
      h('button', { class: 'chip' + (c === cat ? ' on' : ''), 'aria-pressed': String(c === cat), onclick: () => { cat = c; draw(); } }, c)));
    const list = streams.filter(s => cat === 'All' || s.category === cat);
    fill(gridEl, ...(list.length ? list.map(streamCard)
      : [h('p', { class: 'empty' }, streams.length ? 'There are no live streams in this category at the moment.' : 'No one is live at the moment. You can start a stream from Go live.')]));
  };
  add(page,
    h('section', { class: 'hero' },
      h('div', null, h('h1', null, 'Live streams in small rooms'),
        h('p', null, 'No giant anonymous crowds here. The first 4 people through the door of every stream become ', h('b', null, 'Early Birds'),
          ' and get to pin questions the streamer answers live.')),
      h('a', { class: 'btn primary', href: S.user ? '#/golive' : '#/signup' }, S.user ? 'Start streaming' : 'Join the fun')),
    following.length ? h('section', null, h('h2', { class: 'h2' }, 'Live from your people'),
      h('div', { class: 'grid' }, following.map(streamCard))) : null,
    disc.recommended.length ? h('section', null, h('h2', { class: 'h2' }, S.user ? 'Picked just for you' : 'Hot right now'),
      h('div', { class: 'grid' }, disc.recommended.map(streamCard))) : null,
    disc.rising.length ? h('section', null, h('h2', { class: 'h2' }, 'Rising stars'), h('p', { class: 'hint' }, 'Small streams with big potential. Drop in, say hi, make someone’s day.'),
      h('div', { class: 'grid' }, disc.rising.map(streamCard))) : null,
    h('h2', { class: 'h2' }, 'Live right now'), chips, gridEl,
    disc.circles.length ? h('section', null, h('h2', { class: 'h2' }, 'Circles worth joining'), h('div', { class: 'cgrid' }, disc.circles.slice(0, 6).map(c => SOC.circleCard(c)))) : null);
  draw();
}

async function followingPage(main) {
  if (!S.user) return go('#/login');
  const page = h('div', { class: 'page' }, h('h1', null, 'Following'), h('p', { class: 'sub' }, 'Creators you follow'));
  fill(main, page);
  const { following } = await api('/api/following');
  page.append(following.length
    ? h('div', { class: 'grid' }, following.map(c => c.live ? streamCard(c) :
        h('a', { class: 'card', href: '#/c/' + c.username },
          h('div', { class: 'thumb', style: 'background:var(--panel)' }, thumbArt(c.avatar, c.username)),
          h('div', { class: 'row' }, avatar(c.username, c.color, c.avatar), h('div', null, h('div', { class: 't' }, c.username), h('div', { class: 'g' }, 'Offline'))))))
    : h('p', { class: 'empty' }, 'Your list is empty (for now!). Find a channel you love and tap Follow'));
}

/* ----------------------------------------------------------------- auth */
function authPage(main, mode) {
  const signup = mode === 'signup';
  const err = h('div', { class: 'err', role: 'alert' });
  const appealBox = h('div', { hidden: true });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 3, maxlength: 20, pattern: '[A-Za-z0-9_]+' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, minlength: signup ? 8 : 1 });
  const dob = h('input', { name: 'dob', type: 'date', required: true, max: new Date().toISOString().slice(0, 10) });
  const terms = h('input', { type: 'checkbox', required: true, name: 'terms' });
  const showAppeal = () => {
    const msg = h('textarea', { rows: 4, maxlength: 1000, placeholder: 'Tell us what happened and why the decision should change.', 'aria-label': 'Appeal message' });
    const out = h('div', { class: 'err', role: 'alert' });
    appealBox.hidden = false;
    fill(appealBox, h('h2', { class: 'h2' }, 'Appeal this decision'), h('p', { class: 'hint' }, 'An admin will read your message and reply. You will be able to log in again if the appeal is approved.'), msg, out,
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try { await api('/api/appeal', { method: 'POST', body: { username: user.value, password: pass.value, message: msg.value } }); fill(appealBox, h('p', { class: 'ok' }, 'Your appeal was sent. Please check back by logging in later.')); }
        catch (ex) { out.textContent = ex.message; }
      } }, 'Send appeal'));
  };
  const form = h('form', { class: 'form', onsubmit: async e => {
    e.preventDefault();
    err.textContent = ''; appealBox.hidden = true;
    try {
      const body = { username: user.value, password: pass.value, ...(signup ? { dob: dob.value, acceptTerms: terms.checked } : {}) };
      const r = await api(signup ? '/api/register' : '/api/login', { method: 'POST', body });
      S.token = r.token; S.user = r.user;
      localStorage.setItem('novastream_token', r.token);
      try { S.unread = (await api('/api/me')).unread || 0; } catch { S.unread = 0; }
      connectSocket(); await loadBlocks(); renderTop(); renderSide(); syncTimezone();
      let dest = S.afterLogin || '#/'; S.afterLogin = null;
      if (!/^#\//.test(dest) || /^#\/(login|signup|reset)/.test(dest)) dest = '#/';
      if (location.hash === dest) route(); else replaceHash(dest);
    } catch (ex) { err.textContent = ex.message; if (ex.data && ex.data.suspended) showAppeal(); }
  } },
    h('h1', null, signup ? 'Create your account' : 'Welcome back'),
    field('Username', user, signup && '3-20 letters, numbers or underscores'),
    field('Password', pass, signup && 'At least 8 characters'),
    signup && field('Date of birth', dob, 'NovaStream is for ages 13 and up.'),
    signup && h('div', { class: 'teennote' }, h('b', null, 'Under 18? '), 'Your account gets extra protection: no links on your profile, not listed in people search, bio and interests hidden from logged-out visitors, and quiet hours from 10pm to 7am.'),
    signup && h('label', { class: 'check' }, terms, h('span', null, 'I agree to the ', h('a', { href: '#/legal/terms', class: 'ul' }, 'Terms'), ' and the ', h('a', { href: '#/legal/guidelines', class: 'ul' }, 'Community Guidelines'), '.')),
    err, appealBox,
    h('button', { class: 'btn primary', type: 'submit' }, signup ? 'Sign up' : 'Log in'),
    !signup && h('a', { href: '#/reset', class: 'hint' }, 'Forgot your password?'),
    h('a', { href: signup ? '#/login' : '#/signup', class: 'hint' }, signup ? 'Already have an account? Log in' : 'New here? Create an account'));
  fill(main, h('div', { class: 'page' }, form));
}

/* ------------------------------------------------- followers / following */
// cover photo: crops the middle to 3:1, shrinks to 1200x400 and keeps it under the server's size limit
function coverJpeg(file) {
  return new Promise((ok, bad) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return bad(new Error('Please choose a PNG, JPEG, WebP or GIF picture.'));
    if (file.size > 12 * 1024 * 1024) return bad(new Error('That picture is too large. Please choose one under 12 MB.'));
    const rd = new FileReader();
    rd.onerror = () => bad(new Error('That file could not be read.'));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => bad(new Error('That file could not be read as a picture.'));
      img.onload = () => {
        const W = 1200, H = 400, iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) return bad(new Error('That file could not be read as a picture.'));
        let sw = iw, sh = iw / 3; if (sh > ih) { sh = ih; sw = ih * 3; }
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
        x.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H);
        let out = '';
        for (const qlt of [0.82, 0.7, 0.55, 0.4]) { out = c.toDataURL('image/jpeg', qlt); if (out.length < 380000) break; }
        ok(out);
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}
// reads a picture file, crops the middle to a square, and returns it as a small JPEG (data URL)
function squareJpeg(file, size = 256) {
  return new Promise((ok, bad) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return bad(new Error('Please choose a PNG, JPEG, WebP or GIF picture.'));
    if (file.size > 10 * 1024 * 1024) return bad(new Error('That picture is too large. Please choose one under 10 MB.'));
    const rd = new FileReader();
    rd.onerror = () => bad(new Error('That file could not be read.'));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => bad(new Error('That file could not be read as a picture.'));
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return bad(new Error('That file could not be read as a picture.'));
        const c = document.createElement('canvas'); c.width = c.height = size;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, size, size);
        x.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        ok(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = rd.result; // a data: address, which the page's security policy allows
    };
    rd.readAsDataURL(file);
  });
}

async function connectionsPage(main, name, mode) {
  if (!S.user) return go('#/login');
  const followers = mode === 'followers';
  const page = h('div', { class: 'page narrow' });
  fill(main, page);
  const list = h('div', { class: 'people' }), moreBox = h('div', { class: 'moreWrap' }), sub = h('p', { class: 'sub' }, 'Loading...');
  const enc = encodeURIComponent(name);
  const tabs = h('div', { class: 'chips', role: 'tablist' },
    h('a', { class: 'chip' + (followers ? ' on' : ''), role: 'tab', href: `#/u/${enc}/followers` }, 'Followers'),
    h('a', { class: 'chip' + (followers ? '' : ' on'), role: 'tab', href: `#/u/${enc}/following` }, 'Following'));
  fill(page, h('h1', null, followers ? 'Followers' : 'Following'), sub, tabs, list, moreBox);

  const row = u => {
    let fol = u.isFollowing;
    const btn = u.isSelf ? null : h('button', { class: 'btn small', onclick: async () => {
      try { await api('/api/follow/' + u.username, { method: fol ? 'DELETE' : 'POST' }); fol = !fol; paint(); renderSide(); } catch (e) { toast(e.message); }
    } });
    const paint = () => { if (btn) { btn.textContent = fol ? 'Following' : 'Follow'; btn.className = 'btn small' + (fol ? '' : ' primary'); } };
    paint();
    return h('div', { class: 'prow' },
      h('a', { class: 'who', href: '#/u/' + u.username }, avatar(u.username, u.color, u.avatar),
        h('span', { class: 'ptxt' }, h('span', null, h('b', null, u.displayName, u.verified && verifiedMark()), h('small', null, ' @' + u.username),
          u.live ? h('span', { class: 'badge inline' }, 'LIVE') : null), u.bio ? h('span', { class: 'pbio' }, u.bio) : null)), btn);
  };
  let loaded = 0;
  const load = async offset => {
    let r;
    try { r = await api(`/api/users/${enc}/connections?mode=${mode}&offset=${offset}`); }
    catch (e) { fill(page, h('h1', null, 'Profile not found'), h('p', { class: 'sub' }, e.message)); return; }
    loaded += r.people.length;
    sub.textContent = '';
    add(sub, h('a', { href: '#/u/' + r.user.username, class: 'ul' }, '@' + r.user.username), ` · ${r.total} ${followers ? (r.total === 1 ? 'follower' : 'followers') : 'following'}`);
    if (offset === 0 && !r.people.length) {
      const self = S.user.username.toLowerCase() === r.user.username.toLowerCase();
      fill(list, h('p', { class: 'empty' }, followers ? (self ? 'No one follows you yet. Post in the feed or go live and people will find you.' : 'No followers yet.')
                                                       : (self ? 'Your list is empty (for now!). Find a channel you love and tap Follow' : 'Not following anyone yet.')));
    } else add(list, r.people.map(row));
    fill(moreBox, r.next != null ? h('button', { class: 'btn', onclick: () => load(r.next) }, 'Show more') : null);
  };
  await load(0);
}

/* -------------------------------------------------------------- profile */
async function profilePage(main, name) {
  let p;
  try { p = await api('/api/profile/' + encodeURIComponent(name)); }
  catch (e) { fill(main, h('div', { class: 'page' }, h('h1', null, 'Profile not found'), h('p', { class: 'sub' }, e.message))); return; }
  const page = h('div', { class: 'page profile' });
  fill(main, page);
  let editing = false, tab = 'posts';

  const view = () => {
    let following = p.isFollowing;
    const fbtn = h('button', { class: 'btn', onclick: async () => {
      if (!S.user) return go('#/login');
      try { await api('/api/follow/' + p.username, { method: following ? 'DELETE' : 'POST' }); following = !following; draw(); renderSide(); } catch (e) { toast(e.message); }
    } });
    const draw = () => { fbtn.textContent = following ? 'Following' : 'Follow'; fbtn.className = 'btn ' + (following ? '' : 'primary'); };
    draw();
    const I = (n, sz) => window.NSIcons.icon(n, sz || 18);
    const pickPhoto = (kind) => {
      const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onchange: async () => {
        const f = inp.files[0]; inp.remove(); if (!f) return;
        try {
          if (kind === 'cover') { const r = await api('/api/profile/banner', { method: 'PUT', body: { image: await coverJpeg(f) } }); p.bannerImg = r.bannerImg; toast('Cover photo updated.'); }
          else { const r = await api('/api/profile/avatar', { method: 'PUT', body: { image: await squareJpeg(f) } }); p.avatar = r.avatar; p.hasPhoto = true; S.user = (await api('/api/me')).user; renderTop(); drawMenu(); toast('Profile picture updated.'); }
          render();
        } catch (ex) { toast(ex.message); }
      } });
      document.body.append(inp); inp.click();
    };
    const removeCover = async () => { try { await api('/api/profile/banner', { method: 'DELETE' }); p.bannerImg = ''; toast('Cover photo removed.'); render(); } catch (ex) { toast(ex.message); } };

    // ---- cover photo with the picture overlapping it, like a Facebook profile
    const cover = h('div', { class: 'fbcover' + (p.bannerImg ? '' : ' nophoto'), style: p.bannerImg ? `background-image:url("${p.bannerImg}")` : `background:${BANNERS[p.banner] || BANNERS[0]}`, role: 'img', 'aria-label': 'Cover photo' },
      p.isSelf && h('div', { class: 'cover-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => pickPhoto('cover') }, I('camera', 16), p.bannerImg ? ' Change cover' : ' Add cover photo'),
        p.bannerImg && h('button', { class: 'btn small', type: 'button', onclick: removeCover }, 'Remove')));
    const avWrap = h('div', { class: 'fbav' }, avatar(p.username, p.color, p.avatar, true),
      p.isSelf && h('button', { class: 'avcam', type: 'button', title: 'Change profile picture', 'aria-label': 'Change profile picture', onclick: () => pickPhoto('avatar') }, I('camera', 16)));

    const head = h('div', { class: 'fbhead' }, avWrap,
      h('div', { class: 'fbname' },
        h('h1', null, p.displayName, p.verified && verifiedMark(), p.isStaff && h('span', { class: 'tag a', title: 'NovaStream staff' }, 'Staff'), p.live && h('span', { class: 'badge inline' }, 'LIVE')),
        h('div', { class: 'fbsub' }, '@' + p.username),
        h('div', { class: 'counts' }, h('a', { class: 'cnt', href: `#/u/${p.username}/followers`, title: 'See followers' }, h('b', null, p.followers), ' followers'), h('a', { class: 'cnt', href: `#/u/${p.username}/following`, title: 'See who they follow' }, h('b', null, p.followingCount), ' following'))),
      h('div', { class: 'fbacts' },
        p.live && h('a', { class: 'btn danger', href: '#/c/' + p.username }, I('live', 16), ' Watch live'),
        p.isSelf ? [h('button', { class: 'btn primary', onclick: () => { editing = true; render(); } }, I('settings', 16), ' Edit profile'), h('a', { class: 'btn', href: '#/settings' }, 'Settings'), h('button', { class: 'btn show-sm', onclick: logout }, 'Log out')]
                 : [fbtn, h('a', { class: 'btn', href: '#/c/' + p.username }, I('video', 16), ' Channel'), S.user && h('button', { class: 'btn small', 'aria-label': 'Report this profile', title: 'Report', onclick: () => reportDialog({ type: 'user', target: p.username, label: '@' + p.username }) }, '⚑')]));

    // ---- tabs and the two-column body: Intro on the left, content on the right
    const TABS = [['posts', 'Posts', 'feed'], ['about', 'About', 'user'], ['streams', 'Streams', 'live']];
    const content = h('div', { class: 'fbmain' });
    const tabbar = h('div', { class: 'fbtabs', role: 'tablist', 'aria-label': 'Profile sections' });
    const row = (ic, ...kids) => h('div', { class: 'introrow' }, h('span', { class: 'introico' }, I(ic, 18)), h('span', null, ...kids));
    const intro = h('aside', { class: 'panel intro' }, h('h2', { class: 'h2' }, 'Intro'),
      p.bio ? h('p', { class: 'bio2' }, p.bio) : (p.isSelf ? h('p', { class: 'hint' }, 'Add a short bio so people know who you are.') : null),
      p.live && row('live', 'Live now: ', h('a', { class: 'ul', href: '#/c/' + p.username }, p.title || 'watch the stream')),
      row('calendar', 'Joined ' + new Date(p.joined).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
      row('circles', h('b', null, p.followers), ' followers · ', h('b', null, p.followingCount), ' following'),
      p.interests.length ? h('div', { class: 'tagrow' }, p.interests.map(i => h('span', { class: 'tag' }, i))) : null,
      p.links.length ? h('div', { class: 'links' }, p.links.map(l => h('a', { class: 'btn small', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, l.platform))) : null);
    const drawTab = () => {
      tabbar.querySelectorAll('button').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      if (tab === 'about') fill(content,
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'About ' + p.displayName), p.bio ? h('p', { class: 'pre' }, p.bio) : h('p', { class: 'empty' }, 'No bio yet.'),
          p.interests.length ? h('div', { class: 'tagrow' }, p.interests.map(i => h('span', { class: 'tag' }, i))) : null),
        p.channelDesc ? h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'About the channel'), h('p', { class: 'pre' }, p.channelDesc)) : null,
        appreciationCard(p));
      else if (tab === 'streams') fill(content, h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Recent streams'),
        p.recent.length ? h('ul', { class: 'list' }, p.recent.map(s => h('li', null, h('b', null, s.title), ` - ${s.category}, ${s.minutes} min, peak ${s.peak}, ${ago(s.startedAt)}`, s.replay && [' · ', h('a', { href: '#/replay/' + s.id, class: 'ul' }, window.NSIcons.icon('message', 14), ' Chat replay')])))
                        : h('p', { class: 'empty' }, 'No streams yet. The first one is always the most legendary')));
      else fill(content,
        p.isSelf ? h('a', { class: 'panel mind', href: '#/feed' }, avatar(p.username, p.color, p.avatar), h('span', null, 'What’s on your mind, ' + p.displayName.split(' ')[0] + '?')) : null,
        SOC.feedList('/api/feed?user=' + encodeURIComponent(p.username), 'No posts yet.').el);
    };
    TABS.forEach(([k, label, ic]) => tabbar.append(h('button', { type: 'button', role: 'tab', class: 'fbtab', 'data-tab': k, onclick: () => { tab = k; drawTab(); } }, I(ic, 17), ' ', label)));
    drawTab();
    return h('div', { class: 'fbp' }, cover, h('div', { class: 'fbwrap' }, head, tabbar), h('div', { class: 'fbbody' }, intro, content));
  };

  const edit = () => {
    const err = h('div', { class: 'err', role: 'alert' });
    const dn = h('input', { maxlength: 30, value: p.displayName });
    const bio = h('textarea', { maxlength: 200, rows: 3 }, p.bio);
    const interests = h('input', { value: p.interests.join(', '), placeholder: 'music, coding, art' });
    const av = h('input', { maxlength: 4, value: p.avatarEmoji !== undefined ? p.avatarEmoji : p.avatar, placeholder: 'An emoji, e.g. 🦊', 'aria-label': 'Avatar emoji' });
    // profile picture: cropped to a square and shrunk in the browser, then uploaded straight away
    let hasPhoto = !!p.hasPhoto;
    const photoBox = h('div', { class: 'photobox' });
    const photoErr = h('div', { class: 'err', role: 'alert' });
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'aria-label': 'Choose a profile picture', onchange: async () => {
      const f = fileIn.files[0]; fileIn.value = ''; photoErr.textContent = '';
      if (!f) return;
      try {
        const image = await squareJpeg(f);
        const r = await api('/api/profile/avatar', { method: 'PUT', body: { image } });
        p.avatar = r.avatar; hasPhoto = true; p.hasPhoto = true;
        S.user = (await api('/api/me')).user; renderTop(); drawMenu();
        drawPhoto(); toast('Profile picture updated.');
      } catch (ex) { photoErr.textContent = ex.message; }
    } });
    const removePhoto = async () => {
      photoErr.textContent = '';
      try {
        const r = await api('/api/profile/avatar', { method: 'DELETE' });
        p.avatar = r.avatar || p.avatarEmoji || ''; hasPhoto = false; p.hasPhoto = false;
        S.user = (await api('/api/me')).user; renderTop(); drawMenu();
        drawPhoto(); toast('Profile picture removed.');
      } catch (ex) { photoErr.textContent = ex.message; }
    };
    const drawPhoto = () => fill(photoBox,
      avatar(p.username, p.color, hasPhoto ? p.avatar : (p.avatarEmoji || ''), true),
      h('div', { class: 'photo-actions' },
        h('div', { class: 'row2' }, h('button', { type: 'button', class: 'btn small', onclick: () => fileIn.click() }, hasPhoto ? 'Change photo' : 'Upload photo'),
          hasPhoto && h('button', { type: 'button', class: 'btn small', onclick: removePhoto }, 'Remove photo')),
        h('p', { class: 'hint' }, 'PNG, JPEG, WebP or GIF. It is cropped to a square. A photo is shown instead of your emoji.'), photoErr), fileIn);
    drawPhoto();
    const desc = h('textarea', { maxlength: 500, rows: 4 }, p.channelDesc);
    let bannerImg = p.bannerImg || '';
    const coverBox = h('div', { class: 'photobox coverbox' });
    const coverErr = h('div', { class: 'err', role: 'alert' });
    const coverIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'aria-label': 'Choose a cover photo', onchange: async () => {
      const f = coverIn.files[0]; coverIn.value = ''; coverErr.textContent = '';
      if (!f) return;
      try { const r = await api('/api/profile/banner', { method: 'PUT', body: { image: await coverJpeg(f) } }); bannerImg = p.bannerImg = r.bannerImg; drawCover(); toast('Cover photo updated.'); } catch (ex) { coverErr.textContent = ex.message; }
    } });
    const drawCover = () => fill(coverBox,
      h('div', { class: 'coverprev', style: bannerImg ? `background-image:url("${bannerImg}")` : `background:${BANNERS[banner] || BANNERS[0]}` }),
      h('div', { class: 'row2' }, h('button', { type: 'button', class: 'btn small', onclick: () => coverIn.click() }, bannerImg ? 'Change cover photo' : 'Upload cover photo'),
        bannerImg && h('button', { type: 'button', class: 'btn small', onclick: async () => { try { await api('/api/profile/banner', { method: 'DELETE' }); bannerImg = p.bannerImg = ''; drawCover(); toast('Cover photo removed.'); } catch (ex) { coverErr.textContent = ex.message; } } }, 'Remove')),
      h('p', { class: 'hint' }, 'Wide pictures work best. It is cropped to a 3:1 banner. A photo is shown instead of the colour below.'), coverErr, coverIn);
    let banner = p.banner;
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Banner colour' });
    const drawSw = () => fill(swatches, ...BANNERS.map((b, i) =>
      h('button', { type: 'button', class: 'sw' + (i === banner ? ' on' : ''), style: `background:${b}`, role: 'radio', 'aria-checked': String(i === banner), 'aria-label': 'Banner ' + (i + 1), onclick: () => { banner = i; drawSw(); drawCover(); } })));
    drawSw(); drawCover();
    const linkRows = Array.from({ length: 6 }, (_, i) => {
      const cur = p.links[i] || {};
      const sel = h('select', { 'aria-label': 'Platform ' + (i + 1) }, S.cfg.platforms.map(x => h('option', { selected: x === cur.platform }, x)));
      const url = h('input', { type: 'url', placeholder: 'https://', value: cur.url || '', 'aria-label': 'Link ' + (i + 1) });
      return { sel, url, el: h('div', { class: 'linkrow' }, sel, url) };
    });
    const blockedBox = h('div', { class: 'list' });
    (async () => {
      try {
        const { blocks } = await api('/api/blocks');
        fill(blockedBox, ...(blocks.length ? blocks.map(b => h('div', { class: 'linkrow' }, h('span', null, b.username),
          h('button', { type: 'button', class: 'btn small', onclick: async () => { await api('/api/blocks/' + b.username, { method: 'DELETE' }); S.blocked.delete(b.id); toast('Unblocked ' + b.username); edit$(); } }, 'Unblock')))
          : [h('p', { class: 'empty' }, 'You have not blocked anyone.')]));
      } catch { /* ignore */ }
    })();
    const form = h('form', { class: 'form wide', onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      try {
        await api('/api/profile', { method: 'PUT', body: {
          displayName: dn.value, bio: bio.value, interests: interests.value, avatar: av.value, banner, channelDesc: desc.value,
          links: linkRows.filter(r => r.url.value.trim()).map(r => ({ platform: r.sel.value, url: r.url.value.trim() }))
        } });
        S.user = (await api('/api/me')).user; renderTop();
        toast('Profile saved.'); route();
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('h1', null, 'Edit profile'),
      field('Display name', dn), field('Bio', bio, 'Up to 200 characters'), field('Interests', interests, 'Separate with commas (up to 8)'),
      h('div', null, h('div', { class: 'lbl' }, 'Profile picture'), photoBox),
      field('Avatar emoji', av, 'Used when you have no photo'), h('div', null, h('div', { class: 'lbl' }, 'Cover photo'), coverBox), h('div', null, h('div', { class: 'lbl' }, 'Cover colour (used when there is no photo)'), swatches),
      field('Channel description', desc, 'Shown on your profile. Rules, schedule, what you stream.'),
      S.user.isTeen ? h('p', { class: 'hint' }, 'External links are turned off for accounts under 18.')
        : h('div', null, h('div', { class: 'lbl' }, 'Links (https only)'), h('div', { class: 'list' }, linkRows.map(r => r.el))),
      h('div', null, h('div', { class: 'lbl' }, 'Blocked users'), blockedBox),
      err,
      h('div', { class: 'row2' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; render(); } }, 'Cancel')));
    return form;
  };
  const edit$ = () => { if (editing) render(); };
  const render = () => fill(page, editing ? edit() : view());
  render();
}

function appreciationCard(p) {
  const a = p.appreciation;
  if (!a) return null;
  return h('section', { class: 'panel' },
    h('div', { class: 'row2' }, h('h2', { class: 'h2 grow' }, 'Community appreciation'), h('span', { class: 'level' }, `Level ${a.level}`), h('span', { class: 'level alt' }, `${a.score} points`)),
    p.badges.length ? h('div', { class: 'tagrow' }, p.badges.map(b => h('span', { class: 'tag badge2', title: b.label }, `${b.emoji} ${b.label}`))) : h('p', { class: 'empty' }, 'No achievements yet.'),
    h('details', null, h('summary', null, 'How is this calculated?'),
      h('p', { class: 'hint' }, 'Points come from positive participation, not popularity. Each source has a cap, reactions from yourself do not count' + (a.minAccountAgeMin > 0 ? `, reactions from accounts newer than ${a.minAccountAgeMin} minutes are ignored` : '') + ', and nothing here changes where you appear in discovery.'),
      h('ul', { class: 'list' }, a.parts.map(x => h('li', null, h('b', null, x.points), ' - ' + x.label)))));
}

function analyticsPanel(a) {
  const stat = (n, label, hint) => h('div', { class: 'stat', title: hint || '' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label));
  const maxG = Math.max(1, ...a.followerGrowth);
  const growth = h('div', { class: 'bars', role: 'img', 'aria-label': `New followers per day for the last 14 days: ${a.followerGrowth.join(', ')}` },
    a.followerGrowth.map((n, i) => h('div', { class: 'bar', title: `${n} new` }, h('div', { class: 'fill', style: `height:${Math.max(3, (n / maxG) * 100)}%` }), h('span', null, i === 13 ? 'today' : ''))));
  const rows = a.perStream.length ? [...a.perStream].reverse() : [];
  return h('div', null,
    h('h2', { class: 'h2' }, 'Audience insights'),
    h('div', { class: 'stats' },
      stat(a.uniqueViewers, 'Unique viewers', 'Logged-in people once each, plus one per guest visit'), stat(a.returningViewers, 'Returning viewers', 'Watched 2 or more of your streams'),
      stat(a.avgWatchMin + ' min', 'Average watch time'), stat(a.chatMessages, 'Chat messages'), stat(a.followerConversion + '%', 'Viewers who followed', 'New followers during or just after streams, divided by unique viewers')),
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('h3', null, 'New followers, last 14 days'), growth),
      h('section', { class: 'panel' }, h('h3', null, 'Stream by stream'),
        rows.length ? h('div', { class: 'tbl' },
          h('div', { class: 'tr th' }, h('span', null, 'Stream'), h('span', null, 'Viewers'), h('span', null, 'Watch'), h('span', null, 'Stayed'), h('span', null, 'Chat'), h('span', null, '+Follows')),
          rows.map(r => h('div', { class: 'tr' }, h('span', { class: 'tt' }, r.title), h('span', null, r.unique), h('span', null, r.avgWatchMin + 'm'), h('span', null, r.retention + '%'), h('span', null, r.chat), h('span', null, r.newFollowers))))
          : h('p', { class: 'empty' }, 'Insights appear after your first stream.'))),
    h('p', { class: 'hint' }, 'These numbers are here to help you improve your streams, not to rank you against other creators.'));
}

/* ------------------------------------------------------------ dashboard */
async function dashboardPage(main) {
  if (!S.user) return go('#/login');
  const page = h('div', { class: 'page' }, h('h1', null, 'Creator dashboard'), h('p', { class: 'sub' }, 'Your channel statistics and settings'));
  fill(main, page);
  let d;
  try { d = await api('/api/dashboard'); } catch (e) { page.append(h('p', { class: 'err' }, e.message)); return; }

  const stat = (n, label) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label));
  const maxPeak = Math.max(1, ...d.recent.map(r => r.peak));
  const bars = d.recent.length
    ? h('div', { class: 'bars', role: 'img', 'aria-label': 'Peak viewers for your last streams' },
        d.recent.map(r => h('div', { class: 'bar', title: `${r.title}: peak ${r.peak}` },
          h('div', { class: 'fill', style: `height:${Math.max(4, (r.peak / maxPeak) * 100)}%` }), h('span', null, r.peak))))
    : h('p', { class: 'empty' }, 'Your stream history shows up here after your first broadcast. Ready when you are');

  const desc = h('textarea', { rows: 4, maxlength: 500 }, d.channelDesc);
  const words = h('input', { value: d.blockedWords.join(', '), placeholder: 'spoiler, rude word' });
  const saveSettings = h('button', { class: 'btn primary', onclick: async () => {
    try { await api('/api/profile', { method: 'PUT', body: { channelDesc: desc.value, blockedWords: words.value } }); toast('Channel settings saved.'); } catch (e) { toast(e.message); }
  } }, 'Save settings');

  const modsBox = h('div', { class: 'list' });
  const modInput = h('input', { placeholder: 'Username to appoint', 'aria-label': 'Username to appoint as moderator' });
  const drawMods = () => fill(modsBox, ...(d.mods.length ? d.mods.map(m => h('div', { class: 'linkrow' }, h('a', { href: '#/u/' + m }, '' + m),
    h('button', { class: 'btn small', onclick: async () => { await api('/api/mods/' + m, { method: 'DELETE' }); d.mods = d.mods.filter(x => x !== m); drawMods(); } }, 'Remove')))
    : [h('p', { class: 'empty' }, 'No moderators yet. Moderators can answer pins, time out, mute and delete messages.')]));
  drawMods();

  add(page,
    h('div', { class: 'stats' }, stat(d.stats.followers, 'Followers'), stat(d.stats.streams, 'Streams'), stat(d.stats.hours, 'Hours streamed'),
      stat(d.stats.peak, 'Best peak viewers'), stat(d.stats.avgPeak, 'Average peak')),
    h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Peak viewers per stream'), bars),
    d.analytics ? analyticsPanel(d.analytics) : null,
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Channel settings'),
        field('Channel description', desc), field('Blocked words in your chat', words, 'Comma-separated. These are masked for everyone.'), saveSettings,
        h('p', { class: 'hint' }, 'Edit your picture, banner and links on ', h('a', { href: '#/u/' + S.user.username, class: 'ul' }, 'your profile'), '.')),
      h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Moderators'), modsBox,
        h('form', { class: 'linkrow', onsubmit: async e => {
          e.preventDefault();
          try { await api('/api/mods', { method: 'POST', body: { username: modInput.value.trim() } }); d.mods.push(modInput.value.trim()); modInput.value = ''; drawMods(); toast('Moderator added.'); } catch (ex) { toast(ex.message); }
        } }, modInput, h('button', { class: 'btn primary small', type: 'submit' }, 'Appoint')))),
    h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Reports about your chat'),
      d.reports.length ? h('ul', { class: 'list' }, d.reports.map(r => h('li', null, h('b', null, r.username), ': ', r.message || '(no text)', ` - ${r.reason}, ${ago(r.at)}`)))
                       : h('p', { class: 'empty' }, 'No reports. Nice and quiet.')),
    h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Recent streams'),
      d.recent.length ? h('ul', { class: 'list' }, [...d.recent].reverse().map(s => h('li', null, h('b', null, s.title), ` - ${s.category}, ${s.minutes} min, peak ${s.peak}, ${ago(s.startedAt)}`, s.replay && [' · ', h('a', { href: '#/replay/' + s.id, class: 'ul' }, window.NSIcons.icon('message', 14), ' Chat replay')])))
                      : h('p', { class: 'empty' }, 'Nothing yet.')));
}

/* ------------------------------------------------------ go live (host) */
function stopHosting() {
  if (S.socket && S.hosting) S.socket.emit('end');
  S.hosting = null;
  for (const pc of S.peers.values()) pc.close();
  S.peers.clear();
  if (S.local) { S.local.getTracks().forEach(t => t.stop()); S.local = null; }
  updateGoLive();
}
// every Go live button (header, dock, menu) turns into End stream while you are live
function updateGoLive() {
  const live = !!(S.hosting && S.user);
  document.querySelectorAll('[data-golive]').forEach(a => {
    const text = live ? 'End stream' : 'Go live';
    a.classList.toggle('endlive', live);
    a.setAttribute('href', live ? '#/c/' + S.user.username : '#/golive');
    a.setAttribute('title', live ? 'End your live stream' : 'Start a live stream');
    if (a.classList.contains('dk')) { a.dataset.label = text; a.setAttribute('aria-label', text); }
    const l = a.querySelector('.gl-l, .mi-l'); if (l) l.textContent = text;
    const sub = a.querySelector('.mi-txt small'); if (sub) sub.textContent = live ? 'You are live. Tap to stop streaming' : 'Start streaming from your camera or screen';
  });
}
function endStreamNow() {
  if (!S.hosting || !S.user) return;
  if (!confirm('End your live stream now?')) return;
  const mine = '#/c/' + S.user.username.toLowerCase();
  stopHosting(); toast('Stream ended.');
  if ((location.hash || '').toLowerCase() === mine) route(); // refresh the channel so it shows as offline
}
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('[data-golive]');
  if (a && S.hosting) { e.preventDefault(); endStreamNow(); }
});

function goLivePage(main) {
  if (!S.user) return go('#/login');
  if (S.hosting) return go('#/c/' + S.user.username);
  const preview = h('video', { autoplay: true, muted: true, playsinline: true });
  preview.muted = true;
  const ph = h('div', { class: 'preview' }, 'Choose a camera or screen to preview');
  const title = h('input', { maxlength: 80, placeholder: `${S.user.username}'s stream`, 'aria-label': 'Stream title' });
  const desc = h('textarea', { maxlength: 300, rows: 2, placeholder: 'What is this stream about?', 'aria-label': 'Description' });
  const tags = h('input', { placeholder: 'study, lofi, chill', 'aria-label': 'Tags' });
  const cat = h('select', { 'aria-label': 'Category' }, S.cfg.categories.map(c => h('option', null, c)));
  const err = h('div', { class: 'err', role: 'alert' });
  const startBtn = h('button', { class: 'btn primary', disabled: true }, 'Start stream');

  const setStream = stream => {
    if (S.local) S.local.getTracks().forEach(t => t.stop());
    S.local = stream;
    preview.srcObject = stream;
    fill(ph, preview);
    startBtn.disabled = false;
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (!S.hosting) { S.local = null; startBtn.disabled = true; fill(ph, 'Source stopped. Choose again.'); } });
  };
  const useCamera = async () => {
    err.textContent = '';
    try { setStream(await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: true })); }
    catch { err.textContent = 'Could not open your camera or microphone. Allow access in your browser or device settings, and close other apps using the camera.'; }
  };
  const useScreen = async () => {
    err.textContent = '';
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      try { const mic = await navigator.mediaDevices.getUserMedia({ audio: true }); if (!screen.getAudioTracks().length) mic.getAudioTracks().forEach(t => screen.addTrack(t)); } catch { /* no mic */ }
      setStream(screen);
    } catch { err.textContent = 'Screen share was cancelled or is not supported on this device.'; }
  };
  startBtn.onclick = () => {
    S.hosting = { title: title.value.trim(), category: cat.value, description: desc.value.trim(), tags: parseTags(tags.value) };
    updateGoLive();
    go('#/c/' + S.user.username);
  };
  fill(main, h('div', { class: 'page' }, h('div', { class: 'golive' },
    h('h1', null, 'Go live'),
    h('p', { class: 'sub' }, 'Small rooms mean real conversations. Your first 4 viewers become Early Birds and can pin questions for you.'),
    ph,
    h('div', { class: 'row2' },
      h('button', { class: 'btn', onclick: useCamera }, 'Use camera'),
      navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && h('button', { class: 'btn', onclick: useScreen }, 'Share screen')),
    field('Title', title), field('Category', cat), field('Description', desc), field('Tags', tags, 'Up to 5, separated by commas'), err, startBtn)));
  S.cleanup = () => { if (!S.hosting && S.local) { S.local.getTracks().forEach(t => t.stop()); S.local = null; } };
}

/* -------------------------------------------------------------- channel */
async function channelPage(main, name) {
  let info;
  try { info = await api('/api/channel/' + encodeURIComponent(name)); }
  catch (e) { fill(main, h('div', { class: 'page' }, h('h1', null, 'Channel not found'), h('p', { class: 'sub' }, e.message))); return; }
  let prof = {};
  try { prof = await api('/api/profile/' + encodeURIComponent(info.username)); } catch { /* optional */ }

  const isOwner = !!S.user && S.user.username.toLowerCase() === info.username.toLowerCase();
  const sock = S.socket;
  let state = null, pc = null, pinMode = false, wasLive = false, following = info.following, myVote = -1, replyTo = null;
  const mentionsMe = txt => !!S.user && new RegExp('@' + S.user.username + '\\b', 'i').test(txt);
  const isMod = () => isOwner || !!(state && S.user && state.mods.includes(S.user.id));
  const me = () => state && S.user && state.earlyBirds.find(b => b.userId === S.user.id);

  /* stage: video, controls, reactions */
  const video = h('video', { autoplay: true, playsinline: true });
  video.muted = true;
  const over = h('div', { class: 'vover' }, h('div', null, h('strong', null, 'Connecting...')));
  const floaters = h('div', { class: 'floaters', 'aria-hidden': 'true' });
  const muteBtn = h('button', { class: 'btn small', 'aria-label': 'Toggle sound', onclick: () => { video.muted = !video.muted; syncAudio(); } });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume', oninput: () => { video.volume = Number(vol.value); video.muted = video.volume === 0; syncAudio(); } });
  const syncAudio = () => { muteBtn.textContent = video.muted ? 'Unmute' : 'Mute'; };
  syncAudio();
  const channelEl = h('div', { id: 'channel' });
  const theatreBtn = h('button', { class: 'btn small', 'aria-pressed': 'false', onclick: () => { const on = channelEl.classList.toggle('theatre'); theatreBtn.setAttribute('aria-pressed', String(on)); theatreBtn.textContent = on ? 'Exit theatre' : 'Theatre'; } }, 'Theatre');
  const fsBtn = h('button', { class: 'btn small', onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); else vwrap.requestFullscreen && vwrap.requestFullscreen().catch(() => toast('Fullscreen is not available here.')); } }, 'Fullscreen');
  // chat overlay: the newest messages float over the video, handy in theatre mode and fullscreen
  const ovl = h('div', { class: 'chatovl', 'aria-hidden': 'true' });
  let ovlOn = false, histDone = false, left = false;
  try { ovlOn = localStorage.getItem('novastream_chat_overlay') === '1'; } catch { /* storage blocked */ }
  ovl.hidden = !ovlOn;
  const ovlBtn = h('button', { class: 'btn small', title: 'Show new chat messages over the video', 'aria-pressed': String(ovlOn), onclick: () => {
    ovlOn = !ovlOn; ovl.hidden = !ovlOn; fill(ovl);
    ovlBtn.setAttribute('aria-pressed', String(ovlOn)); ovlBtn.textContent = ovlOn ? 'Overlay on' : 'Chat overlay';
    try { localStorage.setItem('novastream_chat_overlay', ovlOn ? '1' : '0'); } catch { /* storage blocked */ }
  } }, ovlOn ? 'Overlay on' : 'Chat overlay');
  // Every line that arrives gets its own random colour (never the same as the line before it), so no one owns a colour.
  const OVL_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff', '#ff9f43', '#f72585', '#9bf6ff', '#b8f35d', '#ff8fab', '#7cf29a', '#ffe066'];
  let ovlLastColor = '';
  function ovlColor() {
    let c;
    do { c = OVL_COLORS[Math.floor(Math.random() * OVL_COLORS.length)]; } while (c === ovlLastColor);
    return (ovlLastColor = c);
  }
  function dropOverlay(n) { // a line that has been sitting a while slides up and fades away
    if (!n.isConnected || n.classList.contains('out')) return;
    if (REDUCED) return n.remove();
    n.classList.add('out');
    n.addEventListener('animationend', () => n.remove(), { once: true });
    setTimeout(() => n.remove(), 2500);
  }
  // The overlay is a tall column that stops a little way below the top of the video. Lines enter at the bottom from the
  // left and are pushed up by newer lines, as if you were scrolling through the chat; near the top they fade out.
  function pushOverlay(m) {
    if (!ovlOn || !histDone || m.system) return;
    while (ovl.children.length > 60) ovl.firstChild.remove(); // safety cap; lines normally leave when they scroll out of the top
    const olds = [...ovl.children];
    const tops = olds.map(c => c.getBoundingClientRect().top);
    const n = h('div', { class: 'o', style: `--oc:${ovlColor()};--from:${ovl.clientWidth || 400}px` }, // --from: how far to travel in from the right edge of the video
      m.owner && h('span', { class: 'bdg host', title: 'Streamer' }, window.NSIcons.icon('video', 11)),
      m.mod && !m.owner && h('span', { class: 'bdg mod', title: 'Moderator' }, window.NSIcons.icon('shield', 11)),
      h('b', null, m.username), h('span', { class: 'colon' }, ':'), ' ', h('span', { class: 'ot' }, m.text));
    ovl.append(n);
    if (!REDUCED) olds.forEach((c, i) => { // older lines glide up to make room instead of jumping
      const d = tops[i] - c.getBoundingClientRect().top;
      if (d) c.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)', composite: 'add' });
    });
    setTimeout(() => { // lines that have scrolled out of the top are tidied away
      const cut = ovl.getBoundingClientRect().top;
      [...ovl.children].forEach(c => { if (c.getBoundingClientRect().bottom < cut) c.remove(); });
    }, 450);
    setTimeout(() => dropOverlay(n), 20000);
  }
  const ctrls = h('div', { class: 'ctrls' }, muteBtn, vol, h('span', { class: 'grow' }), ovlBtn, theatreBtn, fsBtn);
  const reactBar = h('div', { class: 'reactbar', role: 'group', 'aria-label': 'Reactions' }, S.cfg.reactions.map(em =>
    h('button', { class: 'react', 'aria-label': 'React ' + em, onclick: () => {
      if (!S.user) return go('#/login');
      sock.emit('react', { emoji: em }, r => r && r.error && toast(r.error));
    } }, em)));
  // the streamer's live head-count sits on the right of the video (the chat overlay is on the left)
  const vcount = isOwner ? h('div', { class: 'vcount', hidden: true, 'aria-live': 'off', title: 'People watching right now' },
    window.NSIcons.icon('eye', 16), h('b', { class: 'vc-n' }, '0'), h('span', { class: 'vc-l' }, 'watching')) : null;
  function drawViewers() {
    if (!vcount) return;
    const n = state && state.live ? state.viewerCount || 0 : 0, el = vcount.querySelector('.vc-n');
    vcount.hidden = !(state && state.live);
    if (el.textContent !== String(n)) {
      el.textContent = n;
      vcount.setAttribute('aria-label', `${n} watching`);
      vcount.classList.remove('pop'); void vcount.offsetWidth; vcount.classList.add('pop');
    }
  }
  const vwrap = h('div', { class: 'vwrap' }, video, over, floaters, ovl, vcount, ctrls);

  function floatEmoji(em) {
    if (REDUCED) return;
    while (floaters.children.length > 24) floaters.firstChild.remove();
    const n = h('span', { class: 'fl', style: `right:${8 + Math.random() * 60}px;animation-duration:${2 + Math.random()}s` }, em);
    floaters.append(n);
    setTimeout(() => n.remove(), 3200);
  }

  /* info */
  const titleEl = h('h2', null, info.username);
  const tagsEl = h('div', { class: 'tags' });
  const descEl = h('p', { class: 'desc' });
  const followBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (!S.user) return go('#/login');
    try { await api('/api/follow/' + info.username, { method: following ? 'DELETE' : 'POST' }); following = !following; drawFollow(); renderSide(); } catch (e) { toast(e.message); }
  } });
  const drawFollow = () => { followBtn.textContent = following ? 'Following' : 'Follow'; followBtn.className = 'btn ' + (following ? '' : 'primary'); };
  drawFollow();
  const shareBtn = h('button', { class: 'btn', onclick: async () => {
    const url = location.origin + '/#/c/' + info.username;
    try { if (navigator.share) await navigator.share({ title: info.username + ' on NovaStream', url }); else { await navigator.clipboard.writeText(url); toast('Link copied.'); } } catch { /* cancelled */ }
  } }, 'Share');
  const stopBtn = h('button', { class: 'btn danger', onclick: () => { stopHosting(); toast('Stream ended.'); go('#/c/' + info.username); } }, 'End stream');
  const ownerBtn = isOwner ? (S.hosting ? stopBtn : h('a', { class: 'btn primary', href: '#/golive' }, window.NSIcons.icon('live', 16), ' Go live')) : followBtn;
  const birds = h('section', { class: 'birds' });
  const info$ = h('div', { class: 'info' },
    h('a', { href: '#/u/' + info.username, 'aria-label': 'View profile' }, avatar(info.username, info.color, prof.avatar, true)),
    h('div', { class: 'main' }, titleEl, tagsEl, descEl),
    h('div', { class: 'row2' }, shareBtn, ownerBtn));
  const about = h('section', { class: 'panel about' });
  const drawAbout = () => fill(about, 
    h('h3', null, 'About ', h('a', { href: '#/u/' + info.username, class: 'ul' }, prof.displayName || info.username)),
    prof.channelDesc ? h('p', { class: 'pre' }, prof.channelDesc) : h('p', { class: 'empty' }, 'This channel is still writing its story '),
    prof.links && prof.links.length ? h('div', { class: 'links' }, prof.links.map(l => h('a', { class: 'btn small', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, l.platform))) : null);
  drawAbout();

  /* chat */
  const pinsEl = h('div', { class: 'pins', 'aria-label': 'Pinned by Early Birds' });
  const pollEl = h('div', { class: 'poll' });
  const modbar = h('div', { class: 'modbar' });
  const pollForm = h('form', { class: 'pollform', hidden: true });
  const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
  const nodes = new Map();
  const status = h('div', { class: 'status' });
  const replyBar = h('div', { class: 'replybar', hidden: true });
  const drawReply = () => { replyBar.hidden = !replyTo; fill(replyBar, replyTo && `Replying to @${replyTo.username} `, replyTo && h('button', { type: 'button', class: 'btn small', onclick: () => { replyTo = null; drawReply(); } }, 'Cancel')); };
  const input = h('input', { maxlength: 300, placeholder: S.user ? 'Say something...' : 'Log in to chat', 'aria-label': 'Message', disabled: !S.user, autocomplete: 'off' });
  const pinBtn = h('button', { type: 'button', class: 'btn pinbtn', title: 'Pin this message (Early Birds only)', 'aria-pressed': 'false', onclick: () => {
    if (!S.user) return go('#/login');
    pinMode = !pinMode; drawComposer();
    if (pinMode && !me()) toast('Only the first 4 viewers (Early Birds) can pin. Join early next time!');
  } }, 'Pin');
  const sendBtn = h('button', { class: 'btn primary', type: 'submit', disabled: !S.user }, 'Chat');
  const composer = h('form', { class: 'composer', onsubmit: e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sock.emit(pinMode ? 'pin' : 'chat', pinMode ? { text } : { text, replyTo: replyTo ? replyTo.id : undefined }, r => {
      if (r && r.error) toast(r.error);
      else if (r && r.silent) { /* sent a little too quickly: keep the text, show no alert */ }
      else { input.value = ''; replyTo = null; drawReply(); if (pinMode) { pinMode = false; drawComposer(); } }
    });
  } }, h('div', { class: 'line' }, S.user && avatar(S.user.username, S.user.color, S.user.avatar), input, pinBtn, sendBtn), replyBar, status);

  const act = (ev, payload) => sock.emit(ev, payload, r => r && r.error && toast(r.error));

  function drawComposer() {
    pinBtn.className = 'btn pinbtn' + (pinMode ? ' on' : '');
    pinBtn.setAttribute('aria-pressed', String(pinMode));
    input.className = pinMode ? 'pinmode' : '';
    sendBtn.textContent = pinMode ? 'Pin it' : 'Chat';
    const b = me();
    const slow = state && state.slow ? ` Slow mode: ${state.slow}s.` : '';
    if (isOwner) fill(status, 'You are the streamer. Tap Answered when you reply to a pin.' + slow);
    else if (b) fill(status, h('b', null, `Early Bird #${b.slot}`), (b.revoked ? ' - pins turned off by streamer' : ` - ${b.pinsLeft} of 3 pins left.`) + slow);
    else if (state && state.live) fill(status, 'Chat is open. Pins are for the first 4 viewers.' + slow);
    else fill(status, '');
  }

  function drawBirds() {
    if (!state) return;
    const list = h('ul');
    for (let i = 1; i <= state.slotsTotal; i++) {
      const b = state.earlyBirds.find(x => x.slot === i);
      list.append(b ? h('li', { class: 'taken' }, h('span', null, '' + b.username), h('small', null, b.revoked ? 'off' : `${b.pinsLeft} pins`))
                    : h('li', null, h('span', null, 'Open spot'), h('small', null, '#' + i)));
    }
    const open = state.slotsTotal - state.earlyBirds.length;
    fill(birds, h('h3', null, 'Early Birds'), list,
      h('p', null, state.live ? (open ? `${open} spot${open > 1 ? 's' : ''} left. Early Birds can pin 3 messages the streamer will see first.` : 'All Early Bird spots are taken for this stream.')
                              : 'When the stream starts, the first 4 viewers become Early Birds.'));
  }

  function drawPins() {
    if (!state) return;
    const { visible, queued } = state.pins;
    fill(pinsEl, ...[...visible.map(p => h('div', { class: 'pin' },
      h('div', { class: 'body' }, h('div', { class: 'who' }, h('span', null, 'Pinned '), p.username), p.text),
      isMod() && h('button', { class: 'btn ok small', onclick: () => act('answer', { pinId: p.id }) }, 'Answered'))),
      queued ? h('div', { class: 'queued' }, `+${queued} more waiting`) : null].filter(Boolean));
  }

  function drawPoll() {
    const poll = state && state.poll;
    if (!poll) { fill(pollEl, ); return; }
    const total = poll.options.reduce((a, o) => a + o.votes, 0);
    fill(pollEl, 
      h('div', { class: 'q' }, '' + poll.question, h('small', null, poll.open ? ' (open)' : ' (closed)')),
      ...poll.options.map((o, i) => {
        const pct = total ? Math.round((o.votes / total) * 100) : 0;
        const canVote = poll.open && S.user && myVote < 0;
        return h('button', { class: 'opt' + (i === myVote ? ' mine' : ''), disabled: !canVote, onclick: () => sock.emit('poll-vote', { index: i }, r => { if (r && r.error) toast(r.error); else { myVote = i; drawPoll(); } }) },
          h('span', { class: 'fillbar', style: `width:${pct}%` }), h('span', { class: 'txt' }, (i === myVote ? '✓ ' : '') + o.text), h('span', { class: 'pct' }, `${o.votes} (${pct}%)`));
      }),
      isMod() && poll.open ? h('button', { class: 'btn small', onclick: () => act('poll-end', {}) }, 'End poll') : null);
  }

  function drawModbar() {
    if (!isMod() || !state || !state.live) { fill(modbar, ); modbar.hidden = true; pollForm.hidden = true; return; }
    modbar.hidden = false;
    const slow = h('select', { 'aria-label': 'Slow mode', onchange: () => act('slowmode', { seconds: Number(slow.value) }) },
      [[0, 'Slow mode: off'], [5, '5s'], [10, '10s'], [30, '30s'], [60, '1 min'], [120, '2 min']].map(([v, l]) => h('option', { value: v, selected: v === state.slow }, l)));
    fill(modbar, h('span', null, isOwner ? 'Streamer tools' : 'Moderator tools'),
      h('button', { class: 'btn small', onclick: () => { pollForm.hidden = !pollForm.hidden; } }, 'Poll'), slow);
  }
  (() => {
    const q = h('input', { placeholder: 'Poll question', maxlength: 120, 'aria-label': 'Poll question' });
    const opts = [1, 2, 3, 4].map(i => h('input', { placeholder: 'Option ' + i, maxlength: 40, 'aria-label': 'Option ' + i }));
    pollForm.append(q, ...opts, h('button', { class: 'btn primary small', type: 'submit' }, 'Start poll'));
    pollForm.onsubmit = e => {
      e.preventDefault();
      sock.emit('poll-start', { question: q.value, options: opts.map(o => o.value) }, r => {
        if (r && r.error) toast(r.error); else { q.value = ''; opts.forEach(o => { o.value = ''; }); pollForm.hidden = true; myVote = -1; }
      });
    };
  })();

  function drawState() {
    titleEl.textContent = state.live ? state.title : (prof.displayName || info.username);
    fill(tagsEl, 
      state.live ? h('span', { class: 'l' }, 'LIVE') : h('span', null, 'Offline'),
      state.live && h('span', null, `${state.viewerCount} watching`),
      state.live && h('span', null, state.category),
      h('span', null, `${info.followers} followers`),
      ...(state.live ? state.tags.map(t => h('span', { class: 'tag' }, '#' + t)) : []));
    descEl.textContent = state.live ? state.description : '';
    if (!state.live) {
      over.className = 'vover';
      fill(over, h('div', null, h('strong', null, `${info.username} is offline`),
        isOwner ? 'Press Go live to start. People waiting here will join when you do.' : 'Stay on this page. The stream appears when they go live.'));
      video.srcObject = null;
    } else if (isOwner && S.local) over.className = 'vover hide';
    else if (!pc && !isOwner) { over.className = 'vover'; fill(over, h('div', null, h('strong', null, 'Connecting to stream...'), 'If this takes more than a few seconds, the streamer may have a weak connection.')); }
    drawBirds(); drawPins(); drawPoll(); drawModbar(); drawComposer(); drawViewers();
    if (state.live && !wasLive && !isOwner) sock.emit('ready');
    wasLive = state.live;
  }

  function addMsg(m) {
    if (!m.system && S.blocked.has(m.userId)) return;
    pushOverlay(m);
    const near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    let node;
    if (m.system) node = h('div', { class: 'm sys' }, m.text);
    else {
      const self = S.user && m.userId === S.user.id;
      const rx = h('span', { class: 'rx' });
      const tools = S.user && h('span', { class: 'tools' },
        ['🔥', '🫶', '😭', '💀', '🤯'].map(em => h('button', { title: 'React ' + em, 'aria-label': 'React ' + em, onclick: () => act('react-msg', { id: m.id, emoji: em }) }, em)),
        h('button', { title: 'Reply', 'aria-label': 'Reply', onclick: () => { replyTo = { id: m.id, username: m.username }; drawReply(); input.focus(); } }, '↩'),
        !self && h('button', { title: 'Report', 'aria-label': 'Report message', onclick: async () => {
          reportDialog({ type: 'chat', target: info.username, username: m.username, context: m.text, label: 'this message' });
        } }, '⚑'),
        !self && !m.owner && h('button', { title: 'Block this user', 'aria-label': 'Block user', onclick: async () => {
          try { await api('/api/blocks/' + m.username, { method: 'POST' }); S.blocked.add(m.userId); toast(`Blocked ${m.username}. Manage blocks in Edit profile.`); [...msgs.querySelectorAll(`[data-u="${m.userId}"]`)].forEach(n => n.remove()); } catch (e) { toast(e.message); }
        } }, window.NSIcons.icon('ban', 14)),
        isMod() && !self && !m.owner && h('button', { title: 'Time out 5 minutes', 'aria-label': 'Time out', onclick: () => act('timeout', { userId: m.userId, seconds: 300 }) }, '⏱'),
        isMod() && !self && !m.owner && h('button', { title: 'Mute for this stream', 'aria-label': 'Mute', onclick: () => act('mute', { userId: m.userId }) }, window.NSIcons.icon('volumex', 14)),
        isMod() && !self && !m.owner && m.earlyBird && h('button', { title: 'Turn off this viewer\'s pins', 'aria-label': 'Turn off pins', onclick: () => act('revoke-pins', { userId: m.userId }) }, window.NSIcons.icon('pin', 14)),
        isMod() && h('button', { title: 'Delete message', 'aria-label': 'Delete message', onclick: () => act('delete-msg', { id: m.id }) }, window.NSIcons.icon('x', 14)));
      node = h('div', { class: 'm' + (m.pinned ? ' pinned' : '') + (mentionsMe(m.text) ? ' mentionme' : ''), 'data-u': m.userId },
        m.reply && h('div', { class: 'qreply' }, `↩ ${m.reply.username}: ${m.reply.text}`),
        m.owner && h('span', { title: 'Streamer', class: 'cbdg' }, window.NSIcons.icon('video', 13)), m.mod && !m.owner && h('span', { title: 'Moderator', class: 'cbdg' }, window.NSIcons.icon('shield', 13)), m.earlyBird && h('span', { title: 'Early Bird', class: 'cbdg' }, window.NSIcons.icon('star', 13)),
        h('a', { class: 'u', href: '#/u/' + m.username, style: `--uc:${twitchColor(m.username)}` }, m.username), ': ', m.pinned ? window.NSIcons.icon('pin', 13) : '', SOC.richText(m.text), rx, tools);
      nodes.set(m.id, { node, rx });
      drawRx(m.id, m.reactions);
    }
    node.dataset.id = m.id;
    msgs.append(node);
    while (msgs.children.length > 200) msgs.firstChild.remove();
    if (near) msgs.scrollTop = msgs.scrollHeight;
  }
  function drawRx(id, reactions) {
    const n = nodes.get(id); if (!n) return;
    fill(n.rx, ...Object.entries(reactions || {}).map(([em, c]) => h('button', { class: 'rxchip', 'aria-label': `${em} ${c}, toggle`, onclick: () => act('react-msg', { id, emoji: em }) }, `${em} ${c}`)));
  }

  /* WebRTC: viewer */
  function closeViewerPc() { if (pc) { pc.close(); pc = null; } }
  const queue = (p, fn) => { p._q = (p._q || Promise.resolve()).then(fn).catch(() => {}); };
  function viewerSignal(from, data) {
    if (data.sdp && data.sdp.type === 'offer') {
      closeViewerPc();
      const p = pc = new RTCPeerConnection({ iceServers: S.cfg.iceServers });
      p.ontrack = e => { video.srcObject = e.streams[0]; over.className = 'vover hide'; video.play().catch(() => {}); };
      p.onicecandidate = e => e.candidate && sock.emit('signal', { to: from, data: { candidate: e.candidate } });
      p.onconnectionstatechange = () => {
        if (p.connectionState === 'failed') { toast('Stream connection lost. Reconnecting...'); closeViewerPc(); sock.emit('ready'); }
      };
      queue(p, async () => {
        await p.setRemoteDescription(data.sdp);
        await p.setLocalDescription(await p.createAnswer());
        sock.emit('signal', { to: from, data: { sdp: p.localDescription } });
      });
    } else if (data.candidate && pc) { const p = pc; queue(p, () => p.addIceCandidate(data.candidate)); }
  }

  /* WebRTC: host */
  async function hostOffer(viewerId) {
    if (!S.local) return;
    const old = S.peers.get(viewerId); if (old) old.close();
    const p = new RTCPeerConnection({ iceServers: S.cfg.iceServers });
    S.peers.set(viewerId, p);
    S.local.getTracks().forEach(t => p.addTrack(t, S.local));
    p.onicecandidate = e => e.candidate && sock.emit('signal', { to: viewerId, data: { candidate: e.candidate } });
    p.onconnectionstatechange = () => { if (['failed', 'closed'].includes(p.connectionState)) { p.close(); if (S.peers.get(viewerId) === p) S.peers.delete(viewerId); } };
    await p.setLocalDescription(await p.createOffer());
    sock.emit('signal', { to: viewerId, data: { sdp: p.localDescription } });
  }
  function hostSignal(from, data) {
    const p = S.peers.get(from);
    if (!p) return;
    if (data.sdp && data.sdp.type === 'answer') queue(p, () => p.setRemoteDescription(data.sdp));
    else if (data.candidate) queue(p, () => p.addIceCandidate(data.candidate));
  }

  /* socket wiring */
  const on = {
    'room-state': s => { state = s; if (!s.poll) myVote = -1; drawState(); },
    chat: addMsg,
    reaction: ({ emoji }) => floatEmoji(emoji),
    'msg-reactions': ({ id, reactions }) => drawRx(id, reactions),
    'msg-deleted': ({ id }) => { const n = nodes.get(id); if (n) { n.node.remove(); nodes.delete(id); } },
    answered: ({ username, text }) => {
      const s = h('div', { class: 'shout' }, `Answered: ${username} - ${text}`);
      vwrap.append(s); setTimeout(() => s.remove(), 4500);
    },
    'stream-ended': () => { closeViewerPc(); wasLive = false; if (isOwner && S.hosting) { stopHosting(); ownerSlot(); } },
    signal: ({ from, data }) => (isOwner ? hostSignal(from, data) : viewerSignal(from, data)),
    'viewer-ready': ({ id }) => { if (isOwner) hostOffer(id).catch(() => {}); },
    'viewer-left': ({ id }) => { const p = S.peers.get(id); if (p) { p.close(); S.peers.delete(id); } },
    restart: () => { if (!isOwner) { closeViewerPc(); sock.emit('ready'); } }
  };
  function ownerSlot() { info$.lastChild.lastChild.replaceWith(h('a', { class: 'btn primary', href: '#/golive' }, window.NSIcons.icon('live', 16), ' Go live')); }
  for (const [ev, fn] of Object.entries(on)) sock.on(ev, fn);

  const join = () => {
    fill(msgs); nodes.clear();
    wasLive = false;
    if (isOwner && S.hosting && S.local) {
      video.srcObject = S.local;
      sock.emit('host', S.hosting, r => { if (r && r.error) { toast(r.error); stopHosting(); } });
    }
    sock.emit('watch', { channel: info.username }, r => {
      if (!r || r.error) {
        fill(over, h('div', null, h('strong', null, 'Cannot join'), (r && r.error) || 'Try again.'));
        over.className = 'vover';
        return;
      }
      state = r.state; myVote = r.myVote;
      fill(msgs); nodes.clear();
      histDone = false; r.history.forEach(addMsg); histDone = true; drawState();
    });
  };
  sock.on('connect', join);
  if (sock.connected) join();

  const stage = h('div', { class: 'stage' }, vwrap, reactBar, info$, about, birds);
  const savedHint = h('div', { class: 'rphint', hidden: true });
  (async () => {
    try {
      if (!S.site) await loadSite();
      const c = S.site && S.site.chatReplay;
      if (c && c.enabled && !left) { savedHint.textContent = `Chat is saved so it can be replayed for ${c.days} days.`; savedHint.hidden = false; }
    } catch { /* the hint is optional */ }
  })();
  const chat = h('aside', { class: 'chat' }, h('header', null, 'Stream chat'), composer, savedHint, pinsEl, pollEl, modbar, pollForm, msgs);
  channelEl.append(stage, chat);
  fill(main, channelEl);
  drawComposer();
  REP.pastStreams(info.username).then(el => { if (el && !left) about.after(el); });

  S.cleanup = () => {
    left = true;
    for (const [ev, fn] of Object.entries(on)) sock.off(ev, fn);
    sock.off('connect', join);
    sock.emit('leave');
    closeViewerPc();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (isOwner && S.hosting) stopHosting(); // hosting continues only while the host stays on their channel page
  };
}

/* --------------------------------------------------------------- router */
// pages a logged-out visitor can open; everything else needs an account
const GUEST_PAGES = new Set(['feed', 'post', 'login', 'signup', 'reset', 'legal']);
async function route() {
  closeDrawer();
  if (S.cleanup) { try { S.cleanup(); } catch {} S.cleanup = null; }
  const main = $('#main');
  trackNav();
  const [, page, arg, sub] = (location.hash || '#/').split('/');
  if (!S.user && !GUEST_PAGES.has(page)) {
    if (page) { S.afterLogin = location.hash; toast('Log in to use this part of NovaStream. Without an account you can read the community feed.', 5000); replaceHash('#/login'); }
    else replaceHash('#/feed');
    return;
  }
  renderBottom();
  document.body.classList.toggle('in-channel', page === 'c');
  try {
    if (page === 'c' && arg) await channelPage(main, decodeURIComponent(arg));
    else if (page === 'replay' && arg) await REP.replayPage(main, decodeURIComponent(arg), sub);
    else if (page === 'u' && arg && (sub === 'followers' || sub === 'following')) await connectionsPage(main, decodeURIComponent(arg), sub);
    else if (page === 'u' && arg) await profilePage(main, decodeURIComponent(arg));
    else if (page === 'feed') await SOC.feed(main);
    else if (page === 'post' && arg) await SOC.postPage(main, arg);
    else if (page === 'circles' && arg === 'new') SOC.newCircle(main);
    else if (page === 'circles') await SOC.circles(main);
    else if (page === 'circle' && arg) await SOC.circlePage(main, decodeURIComponent(arg));
    else if (page === 'notifications') await SOC.notifications(main);
    else if (page === 'search') await SOC.search(main, arg ? decodeURIComponent(arg) : '');
    else if (page === 'settings') await ADM.settings(main);
    else if (page === 'legal' && arg) await ADM.legal(main, arg);
    else if (page === 'reset') ADM.resetPage(main);
    else if (page === 'admin') await ADM.admin(main, arg || 'overview');
    else if (page === 'dashboard') await dashboardPage(main);
    else if (page === 'golive') goLivePage(main);
    else if (page === 'following') await followingPage(main);
    else if (page === 'login') authPage(main, 'login');
    else if (page === 'signup') authPage(main, 'signup');
    else await homePage(main);
  } catch (e) { toast(e.message || 'Something went wrong.'); }
  if (page !== 'c' && page !== 'admin') main.append(siteFooter());
  main.scrollTop = 0;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === (location.hash || '#/')));
  markMenu(); updateBack();
}

async function loadSite() {
  try {
    const s = await fetch(apiUrl('/api/site')).then(r => r.json());
    const bn = $('#banner');
    const msg = s.maintenance ? s.maintenanceMessage : s.announcement;
    bn.hidden = !msg;
    bn.className = 'banner-' + (s.maintenance ? 'critical' : s.announcementLevel || 'info');
    fill(bn, msg ? '' + msg : null);
    S.site = s;
  } catch { /* the banner is optional */ }
}
// keeps quiet hours correct for where the person actually is
function syncTimezone() {
  if (S.user) api('/api/notifications/prefs', { method: 'PUT', body: { tzOffset: -new Date().getTimezoneOffset() }, noExpire: true }).catch(() => {});
}
function siteFooter() {
  return h('footer', { class: 'sitefoot' }, h('a', { href: '#/legal/guidelines' }, 'Community Guidelines'), h('a', { href: '#/legal/terms' }, 'Terms'),
    h('a', { href: '#/legal/privacy' }, 'Privacy'), S.user && h('a', { href: '#/settings' }, 'Account settings'), h('span', null, 'NovaStream'));
}
const NS = { icon: window.NSIcons.icon, twitchColor, h, S, api, apiUrl, API_BASE, fill, add, toast, avatar, go, ago, field, initial, streamCard, route, setUnread, BANNERS, report: reportDialog, verifiedMark, logout, loadSite, siteFooter, renderTop, renderSide, connectSocket, sessionExpired };
const SOC = window.NSPages.register(NS);
const ADM = window.NSAdmin.register(NS);
const REP = window.NSReplay.register(NS, SOC);
// search-as-you-type: attach to the header and menu search boxes the first time they are used
document.addEventListener('focusin', e => {
  const f = e.target.closest && e.target.closest('form.search, form.mc-search');
  if (f && !f.dataset.sg && S.user) { const c = SOC.attachSuggest(f); if (c) c.onFocus(); }
});

/* ----------------------------------------------------------------- boot */
(async function init() {
  renderTop();
  renderSide();
  route();
  window.addEventListener('hashchange', route);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  setInterval(() => { if (!document.hidden) renderSide(); }, 30000);

  if (S.token) {
    try {
      const me = await api('/api/me', { noExpire: true });
      S.user = me.user;
      S.unread = me.unread || 0;
      renderTop();
      renderSide();
    } catch {
      S.token = null;
      localStorage.removeItem('novastream_token');
    }
  }
  try { Object.assign(S.cfg, await api('/api/config')); } catch { /* defaults */ }
  await loadBlocks().catch(() => {});
  connectSocket();
  loadSite().catch(() => {});
  syncTimezone();
  setInterval(loadSite, 300000);
  if ('serviceWorker' in navigator && location.protocol !== 'capacitor:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
})();
