'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, nothing to compile
const { Server } = require('socket.io');
const mountSocial = require('./social');
const mountAdmin = require('./admin');
const mountReplay = require('./replay');

/* ------------------------------------------------------------------ config */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
let EPHEMERAL_SECRET = false;
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  EPHEMERAL_SECRET = true;
  console.warn('[warning] JWT_SECRET not set - using generated secret.');
}
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'novastream.db');
const ADMIN_NAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const EARLY_BIRD_SLOTS = 4;
const PINS_PER_BIRD = 3;
const VISIBLE_PINS = 4;
const MAX_MSG = 300;
const CATEGORIES = ['Just Chatting', 'Gaming', 'Music', 'Education', 'Technology', 'Podcasts', 'Entertainment', 'Creative Arts', 'Sports Talk', 'Lifestyle', 'Tutorials', 'Interviews', 'Community', 'Presentations'];
const REACTIONS = ['❤️', '🔥', '🫶', '😭', '💀', '🤯', '😂', '🎉', '👏'];
const PLATFORMS = ['YouTube', 'Twitch', 'TikTok', 'Instagram', 'Facebook', 'Kick', 'X', 'Website', 'Donation'];
const BLOCKED = (process.env.BLOCKED_WORDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* ---------------------------------------------------------------- database */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  dob TEXT NOT NULL,
  is_teen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT, category TEXT,
  started_at INTEGER, ended_at INTEGER, peak_viewers INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  channel TEXT, username TEXT, message TEXT, reason TEXT,
  created_at INTEGER NOT NULL
);
`);
const addCols = (table, cols) => {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [n, def] of cols) if (!have.includes(n)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${n} ${def}`);
};
addCols('users', [
  ['display_name', "TEXT NOT NULL DEFAULT ''"], ['bio', "TEXT NOT NULL DEFAULT ''"], ['interests', "TEXT NOT NULL DEFAULT ''"],
  ['links', "TEXT NOT NULL DEFAULT '[]'"], ['avatar', "TEXT NOT NULL DEFAULT ''"], ['banner', 'INTEGER NOT NULL DEFAULT 0'],
  ['channel_desc', "TEXT NOT NULL DEFAULT ''"], ['blocked_words', "TEXT NOT NULL DEFAULT ''"]
]);
addCols('streams', [['description', "TEXT NOT NULL DEFAULT ''"], ['tags', "TEXT NOT NULL DEFAULT ''"]]);
addCols('follows', [['created_at', 'INTEGER NOT NULL DEFAULT 0']]);
addCols('users', [
  ['role', "TEXT NOT NULL DEFAULT 'user'"], ['status', "TEXT NOT NULL DEFAULT 'active'"], ['status_reason', "TEXT NOT NULL DEFAULT ''"],
  ['suspended_until', 'INTEGER NOT NULL DEFAULT 0'], ['verified', 'INTEGER NOT NULL DEFAULT 0'], ['token_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['reset_hash', "TEXT NOT NULL DEFAULT ''"], ['reset_expires', 'INTEGER NOT NULL DEFAULT 0'], ['last_login', 'INTEGER NOT NULL DEFAULT 0']
]);
addCols('reports', [
  ['type', "TEXT NOT NULL DEFAULT 'chat'"], ['target', "TEXT NOT NULL DEFAULT ''"], ['category', "TEXT NOT NULL DEFAULT 'other'"],
  ['status', "TEXT NOT NULL DEFAULT 'open'"], ['resolution', "TEXT NOT NULL DEFAULT ''"], ['handled_by', 'INTEGER NOT NULL DEFAULT 0'],
  ['handled_at', 'INTEGER NOT NULL DEFAULT 0'], ['context', "TEXT NOT NULL DEFAULT ''"], ['reported_user_id', 'INTEGER NOT NULL DEFAULT 0'],
  ['priority', 'INTEGER NOT NULL DEFAULT 0']
]);
// profile pictures: one small square JPEG per person, kept in the database so backups and account deletion cover them
db.exec('CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
addCols('users', [['avatar_img', "TEXT NOT NULL DEFAULT ''"], ['banner_img', "TEXT NOT NULL DEFAULT ''"]]);
db.exec('CREATE TABLE IF NOT EXISTS banners (user_id INTEGER PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
// what the rest of the app shows as someone's picture: their uploaded photo if they have one, otherwise their emoji
const avOf = u => (u && (u.avatar_img || u.avatar)) || '';
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mod_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, admin_id INTEGER NOT NULL DEFAULT 0, action TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', response TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, handled_by INTEGER NOT NULL DEFAULT 0, handled_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS legal_pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS banned_words (word TEXT PRIMARY KEY, added_by INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
`);
if (ADMIN_NAMES.length) for (const n of ADMIN_NAMES) db.prepare("UPDATE users SET role = 'admin' WHERE username = ? COLLATE NOCASE").run(n);

/* ---- site settings: editable live from the admin page, with .env values as defaults ---- */
const SETTING_DEFAULTS = {
  registrationOpen: true, maintenance: false,
  maintenanceMessage: 'NovaStream is being updated. You can still browse and watch, but posting and going live are paused for a short while.',
  announcement: '', announcementLevel: 'info',
  maxViewers: Number(process.env.MAX_VIEWERS_PER_STREAM) || 25,
  minAccountAgeMin: Number(process.env.EARLY_BIRD_MIN_ACCOUNT_AGE_MIN) || 0,
  postCooldownMs: Number(process.env.POST_COOLDOWN_MS ?? 3000),
  chatReplayEnabled: process.env.CHAT_REPLAY !== 'off',
  chatReplayDays: Number(process.env.CHAT_REPLAY_DAYS) || 30
};
const settingsCache = { ...SETTING_DEFAULTS };
for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { settingsCache[r.key] = JSON.parse(r.value); } catch { /* keep default */ } }
const getSetting = k => settingsCache[k];
const putSetting = (k, v) => {
  settingsCache[k] = v;
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
};
const maxViewers = () => getSetting('maxViewers');
const minAgeMs = () => getSetting('minAccountAgeMin') * 60000;
db.exec(`
CREATE TABLE IF NOT EXISTS mods (channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (channel_id, user_id));
CREATE TABLE IF NOT EXISTS blocks (blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
UPDATE streams SET ended_at = started_at WHERE ended_at IS NULL;
`);
const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, pass_hash, dob, is_teen, created_at) VALUES (?,?,?,?,?)'),
  followCount: db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?'),
  isFollowing: db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?'),
  follow: db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)'),
  unfollow: db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'),
  following: db.prepare('SELECT u.username FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY u.username'),
  insertStream: db.prepare('INSERT INTO streams (user_id, title, category, description, tags, started_at) VALUES (?,?,?,?,?,?)'),
  endStream: db.prepare('UPDATE streams SET ended_at = ?, peak_viewers = ? WHERE id = ?'),
  insertReport: db.prepare('INSERT INTO reports (reporter_id, channel, username, message, reason, created_at) VALUES (?,?,?,?,?,?)'),
  followingCount: db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?'),
  updateProfile: db.prepare('UPDATE users SET display_name=?, bio=?, interests=?, links=?, avatar=?, banner=?, channel_desc=?, blocked_words=? WHERE id=?'),
  modsOf: db.prepare('SELECT user_id FROM mods WHERE channel_id = ?'),
  modsList: db.prepare('SELECT u.username FROM mods m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY u.username'),
  addMod: db.prepare('INSERT OR IGNORE INTO mods VALUES (?,?)'),
  delMod: db.prepare('DELETE FROM mods WHERE channel_id = ? AND user_id = ?'),
  blocksOf: db.prepare('SELECT u.id, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY u.username'),
  addBlock: db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?)'),
  delBlock: db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
  isBlocked: db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
  statsFor: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at ELSE 0 END),0) ms, COALESCE(MAX(peak_viewers),0) peak, COALESCE(AVG(peak_viewers),0) avg FROM streams WHERE user_id = ?'),
  recentStreams: db.prepare('SELECT id, title, category, started_at, ended_at, peak_viewers FROM streams WHERE user_id = ? ORDER BY id DESC LIMIT 10'),
  reportsFor: db.prepare('SELECT username, message, reason, created_at FROM reports WHERE channel = ? COLLATE NOCASE ORDER BY id DESC LIMIT 20')
};

/* ----------------------------------------------------------------- helpers */
const colorFor = name => {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 62%)`;
};
const cleanText = (t, max) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max);
const splitList = s => (s ? String(s).split(',').filter(Boolean) : []);
const cleanList = (x, n, len) => {
  const arr = Array.isArray(x) ? x : String(x || '').split(',');
  const out = [];
  for (const s of arr) {
    const v = cleanText(s, len);
    if (v && !out.some(o => o.toLowerCase() === v.toLowerCase())) out.push(v);
    if (out.length >= n) break;
  }
  return out;
};
const cleanTags = x => cleanList(x, 5, 20).map(s => s.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean);
const cleanLinks = arr => {
  const out = [];
  for (const l of Array.isArray(arr) ? arr.slice(0, 6) : []) {
    if (!l) continue;
    let u;
    try { u = new URL(String(l.url || '').trim()); } catch { continue; }
    if (u.protocol !== 'https:' || u.href.length > 200) continue; // https only: blocks javascript: and plain http
    out.push({ platform: PLATFORMS.includes(l.platform) ? l.platform : 'Website', url: u.href });
  }
  return out;
};
// Whole-word, case-insensitive masking ("class" is safe, "ass" is not). Global words are managed on the admin page.
let globalWords = [];
const setGlobalWords = arr => { globalWords = arr; };
const wordRegexes = new Map();
const wordRegex = w => {
  let r = wordRegexes.get(w);
  if (!r) { r = new RegExp('(?<![\\p{L}\\p{N}_])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'giu'); wordRegexes.set(w, r); }
  r.lastIndex = 0;
  return r;
};
const filterText = (t, extra = []) => {
  let out = t;
  for (const w of new Set([...BLOCKED, ...globalWords, ...extra.map(x => String(x).toLowerCase())].filter(Boolean))) out = out.replace(wordRegex(w), m => '*'.repeat(m.length));
  return out;
};
const ageOf = dob => {
  const b = new Date(dob), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
};
const isTeen = u => ageOf(u.dob) < 18;
const signToken = user => jwt.sign({ id: user.id, tv: user.token_version || 0 }, JWT_SECRET, { expiresIn: '30d' });
const publicUser = u => ({
  id: u.id, username: u.username, displayName: u.display_name || u.username, avatar: avOf(u), color: colorFor(u.username),
  isTeen: isTeen(u), isAdmin: u.role === 'admin', verified: !!u.verified
});
// a token stops working when the account's token_version changes (password change, "log out everywhere", admin action)
const userFromToken = token => {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const u = q.userById.get(p.id);
    if (!u || (p.tv || 0) !== (u.token_version || 0)) return null;
    return u;
  } catch {
    return null;
  }
};
const restrictionOf = u => {
  if (!u) return null;
  if (u.status === 'banned') return { banned: true, reason: u.status_reason, until: 0 };
  if (u.status === 'suspended' && (u.suspended_until === 0 || u.suspended_until > Date.now())) return { banned: false, reason: u.status_reason, until: u.suspended_until };
  return null;
};
const restrictionText = r => (r.banned ? 'This account has been banned.' : `This account is suspended${r.until ? ' until ' + new Date(r.until).toUTCString() : ''}.`) +
  ` Reason: ${r.reason || 'a breach of the community guidelines'}. You can appeal below.`;
const isBlockedBy = (ownerId, actorId) => !!q.isBlocked.get(ownerId, actorId);

/* ------------------------------------------------------------ live rooms */
const rooms = new Map(); // channel(lowercase) -> room
function getRoom(owner) {
  const key = owner.username.toLowerCase();
  let r = rooms.get(key);
  if (!r) {
    r = {
      key, channel: owner.username, ownerId: owner.id, ownerSocket: null,
      live: false, title: '', category: '', streamId: null, startedAt: null, peak: 0,
      description: '', tags: [], slow: 0, poll: null, chatCount: 0,
      mods: new Set(q.modsOf.all(owner.id).map(x => x.user_id)), blocked: splitList(owner.blocked_words),
      timeouts: new Map(), msgReacts: new Map(),
      viewers: new Map(), earlyBirds: new Map(), pinsUsed: new Map(),
      revoked: new Set(), muted: new Set(), pins: [], history: [], graceTimer: null
    };
    rooms.set(key, r);
  }
  return r;
}
const roomName = r => 'ch:' + r.key;
function cleanupRoom(room) {
  if (!room.live && !room.ownerSocket && room.viewers.size === 0) rooms.delete(room.key);
}
function publicState(room) {
  return {
    channel: room.channel, live: room.live, title: room.title, category: room.category,
    startedAt: room.startedAt, viewerCount: room.viewers.size, slotsTotal: EARLY_BIRD_SLOTS,
    description: room.description, tags: room.tags, slow: room.slow, mods: [...room.mods], ownerId: room.ownerId,
    poll: room.poll ? {
      id: room.poll.id, question: room.poll.question, open: room.poll.open,
      options: room.poll.options.map(o => ({ text: o.text, votes: o.voters.size }))
    } : null,
    earlyBirds: [...room.earlyBirds.values()].map(b => ({
      userId: b.userId, username: b.username, slot: b.slot,
      revoked: room.revoked.has(b.userId),
      pinsLeft: room.revoked.has(b.userId) ? 0 : PINS_PER_BIRD - (room.pinsUsed.get(b.userId) || 0)
    })),
    pins: { visible: room.pins.slice(0, VISIBLE_PINS), queued: Math.max(0, room.pins.length - VISIBLE_PINS) }
  };
}
let io;
let social = null; // Phase 2 module, mounted once the socket server exists
let admin = null;  // admin and account-safety module
let replay = null; // Chat Replay: saves chat with its time offset and plays it back after the stream
const broadcast = room => io.to(roomName(room)).emit('room-state', publicState(room));
function emitChat(room, msg) {
  room.history.push(msg);
  if (replay) replay.record(room, msg);
  if (room.history.length > 50) { const old = room.history.shift(); room.msgReacts.delete(old.id); }
  io.to(roomName(room)).emit('chat', msg);
}
const systemMsg = (room, text) =>
  emitChat(room, { id: crypto.randomUUID(), system: true, text, ts: Date.now() });
const userMsg = (room, user, text, extra = {}) => ({
  id: crypto.randomUUID(), userId: user.id, username: user.username, color: colorFor(user.username),
  text, ts: Date.now(), owner: user.id === room.ownerId, mod: room.mods.has(user.id), earlyBird: room.earlyBirds.has(user.id), avatar: avOf(user), reactions: {}, ...extra
});

/** Early Birds = the first 4 eligible logged-in viewers to join a live stream. */
function assignEarlyBirds(room) {
  if (!room.live) return;
  for (const v of room.viewers.values()) {
    if (room.earlyBirds.size >= EARLY_BIRD_SLOTS) break;
    if (!v.user || room.earlyBirds.has(v.user.id)) continue;
    if (Date.now() - v.user.created_at < minAgeMs()) continue; // anti-bot: account must be old enough
    const slot = room.earlyBirds.size + 1;
    room.earlyBirds.set(v.user.id, { userId: v.user.id, username: v.user.username, slot });
    social.earlyBird(v.user.id);
    systemMsg(room, `🐦 ${v.user.username} is Early Bird #${slot}!`);
  }
}
function endStream(room) {
  if (room.graceTimer) clearTimeout(room.graceTimer);
  room.graceTimer = null;
  if (room.live) social.streamEnded(room);
  if (room.live && room.streamId) q.endStream.run(Date.now(), room.peak, room.streamId);
  room.live = false;
  room.ownerSocket = null;
  room.pins = [];
  room.earlyBirds.clear();
  room.pinsUsed.clear();
  room.revoked.clear();
  room.muted.clear();
  room.timeouts.clear();
  room.poll = null;
  room.slow = 0;
  io.to(roomName(room)).emit('stream-ended');
  broadcast(room);
  cleanupRoom(room);
}

/* --------------------------------------------------------------------- app */
const app = express();
app.set('trust proxy', true);
app.use(helmet({
  xFrameOptions: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["*"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
const jsonSmall = express.json({ limit: '10kb' });
const jsonPicture = express.json({ limit: '450kb' });
app.use((req, res, next) => (req.path === '/api/profile/avatar' || req.path === '/api/profile/banner' ? jsonPicture : jsonSmall)(req, res, next));
const limiter = o => rateLimit({
  standardHeaders: true, legacyHeaders: false,
  validate: { xForwardedForHeader: false, forwardedHeader: false },
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down and try again in a minute.' }), ...o
});
app.use('/api/', limiter({ windowMs: 60000, max: 300 }));
const authLimiter = limiter({ windowMs: 15 * 60000, max: Number(process.env.AUTH_LIMIT) || 30 });

// maintenance mode: everything is read-only for everyone except admins
const MAINT_ALLOWED = ['/login', '/appeal', '/reset-password'];
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !getSetting('maintenance') || MAINT_ALLOWED.includes(req.path)) return next();
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const u = t ? userFromToken(t) : null;
  if (u && u.role === 'admin') return next();
  res.status(503).json({ error: getSetting('maintenanceMessage'), maintenance: true });
});

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  let u = t ? userFromToken(t) : null;
  const r = restrictionOf(u);
  if (r) {
    if (req.requireAuth) return res.status(403).json({ error: restrictionText(r), suspended: true });
    u = null; // restricted people browse as guests
  }
  req.user = u;
  if (req.requireAuth && !u) return res.status(401).json({ error: 'Please log in first.' });
  next();
};
const need = (req, res, next) => { req.requireAuth = true; auth(req, res, next); };

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }
  res.json({
    iceServers, maxViewers: maxViewers(), categories: CATEGORIES, reactions: REACTIONS, platforms: PLATFORMS,
    minAccountAgeMin: getSetting('minAccountAgeMin'), registrationOpen: getSetting('registrationOpen')
  });
});
app.get('/api/site', (_req, res) => res.json({
  announcement: getSetting('announcement'), announcementLevel: getSetting('announcementLevel'),
  maintenance: getSetting('maintenance'), maintenanceMessage: getSetting('maintenanceMessage'), registrationOpen: getSetting('registrationOpen'),
  chatReplay: { enabled: getSetting('chatReplayEnabled') !== false, days: getSetting('chatReplayDays') }
}));

const RESERVED = ['admin', 'administrator', 'root', 'moderator', 'mod', 'support', 'staff', 'official', 'system', 'novastream', 'nova', 'help', 'security', 'team', 'null', 'undefined', 'anonymous', 'owner', 'ceo'];
const looksReserved = name => {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return RESERVED.includes(n) || /^(admin|novastream|moderator|official|support)/.test(n);
};

app.post('/api/register', authLimiter, (req, res) => {
  const { username, password, dob, acceptTerms } = req.body || {};
  if (!getSetting('registrationOpen')) return res.status(403).json({ error: 'New sign-ups are paused right now. Please try again later.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscores.' });
  const isAdminName = ADMIN_NAMES.includes(username.toLowerCase());
  if (!isAdminName && looksReserved(username)) return res.status(400).json({ error: 'That username is reserved so nobody can pretend to be NovaStream staff. Please pick another.' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (acceptTerms !== true) return res.status(400).json({ error: 'Please agree to the Terms and Community Guidelines to join.' });
  const birth = new Date(dob);
  if (isNaN(birth)) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  const age = ageOf(dob);
  if (age < 13) return res.status(403).json({ error: 'You must be at least 13 to join NovaStream.' });
  if (age > 110) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  if (q.userByName.get(username)) return res.status(409).json({ error: 'That username is taken.' });
  const info = q.insertUser.run(username, bcrypt.hashSync(password, 11), dob, age < 18 ? 1 : 0, Date.now());
  const id = Number(info.lastInsertRowid);
  // under-18 default: quiet hours 22:00-07:00 so late-night pop-ups do not keep teens up
  if (age < 18) db.prepare('UPDATE users SET quiet_start = 22, quiet_end = 7 WHERE id = ?').run(id);
  db.prepare('UPDATE users SET last_login = ?, role = ? WHERE id = ?').run(Date.now(), isAdminName ? 'admin' : 'user', id);
  const user = q.userById.get(id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? q.userByName.get(username) : null;
  if (!user || typeof password !== 'string' || !bcrypt.compareSync(password, user.pass_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const r = restrictionOf(user);
  if (r) return res.status(403).json({ error: restrictionText(r), suspended: true, reason: r.reason, until: r.until, banned: r.banned });
  db.prepare('UPDATE users SET last_login = ?, is_teen = ? WHERE id = ?').run(Date.now(), isTeen(user) ? 1 : 0, user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', need, (req, res) => res.json({ user: publicUser(req.user), unread: social.unreadCount(req.user.id) }));

app.get('/api/streams', auth, (_req, res) => {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.live) continue;
    list.push({
      username: r.channel, color: colorFor(r.channel), title: r.title, category: r.category,
      viewers: r.viewers.size, startedAt: r.startedAt, full: r.viewers.size >= maxViewers(),
      tags: r.tags, description: r.description, avatar: avOf(q.userById.get(r.ownerId))
    });
  }
  list.sort((a, b) => b.viewers - a.viewers);
  res.json({ streams: list });
});

app.get('/api/channel/:name', auth, (req, res) => {
  const owner = q.userByName.get(req.params.name);
  if (!owner) return res.status(404).json({ error: 'Channel not found.' });
  const room = rooms.get(owner.username.toLowerCase());
  res.json({
    username: owner.username, color: colorFor(owner.username),
    live: !!(room && room.live), title: room ? room.title : '', category: room ? room.category : '',
    viewers: room ? room.viewers.size : 0,
    followers: q.followCount.get(owner.id).c,
    following: req.user ? !!q.isFollowing.get(req.user.id, owner.id) : false
  });
});

app.post('/api/follow/:name', need, (req, res) => {
  const t = q.userByName.get(req.params.name);
  if (!t || t.id === req.user.id) return res.status(400).json({ error: 'You cannot follow this channel.' });
  if (isBlockedBy(t.id, req.user.id)) return res.status(403).json({ error: 'You cannot interact with this account.' });
  if (q.follow.run(req.user.id, t.id, Date.now()).changes > 0) {
    social.notify(t.id, 'follow', `${req.user.username} followed you`, '#/u/' + req.user.username, req.user.id);
  }
  res.json({ ok: true });
});
app.delete('/api/follow/:name', need, (req, res) => {
  const t = q.userByName.get(req.params.name);
  if (t) q.unfollow.run(req.user.id, t.id);
  res.json({ ok: true });
});
app.get('/api/following', need, (req, res) => {
  const list = q.following.all(req.user.id).map(r => {
    const room = rooms.get(r.username.toLowerCase());
    return {
      username: r.username, color: colorFor(r.username), live: !!(room && room.live),
      title: room ? room.title : '', category: room ? room.category : '', viewers: room ? room.viewers.size : 0
    };
  });
  res.json({ following: list });
});

/* ---- profiles, channel settings, moderators, blocks, dashboard ---- */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
app.get('/api/profile/:name', auth, (req, res) => {
  const u = q.userByName.get(req.params.name);
  if (!u) return res.status(404).json({ error: 'Profile not found.' });
  const room = rooms.get(u.username.toLowerCase());
  res.json({
    username: u.username, displayName: u.display_name || u.username, avatar: avOf(u), avatarEmoji: u.avatar, hasPhoto: !!u.avatar_img, banner: u.banner, bannerImg: u.banner_img || '',
    // under-18 defaults: no external links, and bio/interests/channel text only for logged-in people
    bio: isTeen(u) && !req.user ? '' : u.bio, interests: isTeen(u) && !req.user ? [] : splitList(u.interests),
    links: isTeen(u) ? [] : JSON.parse(u.links || '[]'), channelDesc: isTeen(u) && !req.user ? '' : u.channel_desc,
    color: colorFor(u.username), joined: u.created_at, verified: !!u.verified, isStaff: u.role === 'admin', isTeen: isTeen(u),
    followers: q.followCount.get(u.id).c, followingCount: q.followingCount.get(u.id).c,
    live: !!(room && room.live), title: room ? room.title : '', category: room ? room.category : '',
    isFollowing: req.user ? !!q.isFollowing.get(req.user.id, u.id) : false,
    isSelf: !!req.user && req.user.id === u.id,
    ...social.profileExtras(u.id),
    recent: q.recentStreams.all(u.id).slice(0, 5).map(s => ({
      id: s.id, title: s.title, category: s.category, startedAt: s.started_at,
      minutes: s.ended_at ? Math.round((s.ended_at - s.started_at) / 60000) : 0, peak: s.peak_viewers,
      replay: !!s.ended_at && !(room && room.live && room.streamId === s.id) && replay.hasReplay(s.id)
    }))
  });
});

app.put('/api/profile', need, (req, res) => {
  const b = req.body || {}, u = req.user;
  const has = k => b[k] !== undefined;
  const vals = [
    has('displayName') ? filterText(cleanText(b.displayName, 30)) : u.display_name,
    has('bio') ? filterText(cleanText(b.bio, 200)) : u.bio,
    has('interests') ? cleanList(b.interests, 8, 20).map(s => filterText(s)).join(',') : u.interests,
    isTeen(u) ? '[]' : has('links') ? JSON.stringify(cleanLinks(b.links)) : u.links,
    has('avatar') ? Array.from(cleanText(b.avatar, 12)).slice(0, 4).join('') : u.avatar,
    has('banner') ? clamp(b.banner, 0, 7) : u.banner,
    has('channelDesc') ? filterText(cleanText(b.channelDesc, 500)) : u.channel_desc,
    has('blockedWords') ? cleanList(b.blockedWords, 30, 20).join(',') : u.blocked_words,
    u.id
  ];
  q.updateProfile.run(...vals);
  const room = rooms.get(u.username.toLowerCase());
  if (room) room.blocked = splitList(vals[7]);
  res.json({ ok: true });
});

/* ---- profile picture upload ---- */
const avatarLimiter = limiter({ windowMs: 10 * 60000, max: 15 });
app.put('/api/profile/avatar', need, avatarLimiter, (req, res) => {
  // the browser crops and re-encodes the picture to a 256px JPEG; the server checks that is what arrived
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  const ok = buf && buf.length > 200 && buf.length <= 250 * 1024 &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  if (!ok) return res.status(400).json({ error: 'That picture could not be used. Please try a different image.' });
  const ts = Date.now();
  db.prepare('INSERT INTO avatars (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(req.user.id, buf, ts);
  const url = `/avatars/${req.user.id}.jpg?v=${ts}`;
  db.prepare('UPDATE users SET avatar_img = ? WHERE id = ?').run(url, req.user.id);
  res.json({ ok: true, avatar: url });
});
app.delete('/api/profile/avatar', need, (req, res) => {
  db.prepare('DELETE FROM avatars WHERE user_id = ?').run(req.user.id);
  db.prepare("UPDATE users SET avatar_img = '' WHERE id = ?").run(req.user.id);
  res.json({ ok: true, avatar: req.user.avatar });
});
/* ---- cover (banner) photo: the browser crops it to 1200x400 and re-encodes it as a JPEG ---- */
app.put('/api/profile/banner', need, avatarLimiter, (req, res) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  const ok = buf && buf.length > 500 && buf.length <= 300 * 1024 &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  if (!ok) return res.status(400).json({ error: 'That cover photo could not be used. Please try a different image.' });
  const ts = Date.now();
  db.prepare('INSERT INTO banners (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(req.user.id, buf, ts);
  const url = `/banners/${req.user.id}.jpg?v=${ts}`;
  db.prepare('UPDATE users SET banner_img = ? WHERE id = ?').run(url, req.user.id);
  res.json({ ok: true, bannerImg: url });
});
app.delete('/api/profile/banner', need, (req, res) => {
  db.prepare('DELETE FROM banners WHERE user_id = ?').run(req.user.id);
  db.prepare("UPDATE users SET banner_img = '' WHERE id = ?").run(req.user.id);
  res.json({ ok: true, bannerImg: '' });
});
app.get('/banners/:file', (req, res) => {
  const m = /^(\d+)\.jpg$/.exec(req.params.file);
  const row = m && db.prepare('SELECT data FROM banners WHERE user_id = ?').get(Number(m[1]));
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(row.data));
});

app.get('/avatars/:file', (req, res) => {
  const m = /^(\d+)\.jpg$/.exec(req.params.file);
  const row = m && db.prepare('SELECT data FROM avatars WHERE user_id = ?').get(Number(m[1]));
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(row.data));
});

/* ---- who follows a person, and who they follow (logged-in people only) ---- */
app.get('/api/users/:name/connections', need, (req, res) => {
  const u = q.userByName.get(req.params.name);
  if (!u) return res.status(404).json({ error: 'Profile not found.' });
  const mode = req.query.mode === 'following' ? 'following' : 'followers';
  const me = req.user.id, PAGE = 40, offset = clamp(req.query.offset, 0, 1000000);
  const [mine, other] = mode === 'followers' ? ['f.followee_id', 'f.follower_id'] : ['f.follower_id', 'f.followee_id'];
  const where = `FROM follows f JOIN users x ON x.id = ${other} WHERE ${mine} = ? AND x.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = x.id) OR (b.blocker_id = x.id AND b.blocked_id = ?))`;
  const total = db.prepare(`SELECT COUNT(*) c ${where}`).get(u.id, me, me).c;
  const rows = db.prepare(`SELECT x.* ${where} ORDER BY f.created_at DESC, x.id DESC LIMIT ? OFFSET ?`).all(u.id, me, me, PAGE + 1, offset);
  const people = rows.slice(0, PAGE).map(x => {
    const room = rooms.get(x.username.toLowerCase());
    return {
      username: x.username, displayName: x.display_name || x.username, avatar: avOf(x), color: colorFor(x.username),
      verified: !!x.verified, bio: x.bio, live: !!(room && room.live),
      isFollowing: !!q.isFollowing.get(me, x.id), isSelf: x.id === me
    };
  });
  res.json({ user: { username: u.username, displayName: u.display_name || u.username }, mode, total, people, next: rows.length > PAGE ? offset + PAGE : null });
});

app.get('/api/mods', need, (req, res) => res.json({ mods: q.modsList.all(req.user.id).map(r => r.username) }));
app.post('/api/mods', need, (req, res) => {
  const t = q.userByName.get(String((req.body || {}).username || ''));
  if (!t) return res.status(404).json({ error: 'No user with that name.' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'You already own this channel.' });
  q.addMod.run(req.user.id, t.id);
  const room = rooms.get(req.user.username.toLowerCase());
  if (room) { room.mods.add(t.id); broadcast(room); }
  res.json({ ok: true });
});
app.delete('/api/mods/:name', need, (req, res) => {
  const t = q.userByName.get(req.params.name);
  if (t) {
    q.delMod.run(req.user.id, t.id);
    const room = rooms.get(req.user.username.toLowerCase());
    if (room) { room.mods.delete(t.id); broadcast(room); }
  }
  res.json({ ok: true });
});

app.get('/api/blocks', need, (req, res) => res.json({ blocks: q.blocksOf.all(req.user.id).map(r => ({ id: r.id, username: r.username })) }));
app.post('/api/blocks/:name', need, (req, res) => {
  const t = q.userByName.get(req.params.name);
  if (!t || t.id === req.user.id) return res.status(400).json({ error: 'You cannot block this account.' });
  q.addBlock.run(req.user.id, t.id);
  res.json({ ok: true, id: t.id });
});
app.delete('/api/blocks/:name', need, (req, res) => {
  const t = q.userByName.get(req.params.name);
  if (t) q.delBlock.run(req.user.id, t.id);
  res.json({ ok: true });
});

app.get('/api/dashboard', need, (req, res) => {
  const u = req.user, a = q.statsFor.get(u.id);
  res.json({
    stats: { followers: q.followCount.get(u.id).c, streams: a.n, hours: Math.round(a.ms / 360000) / 10, peak: a.peak, avgPeak: Math.round(a.avg) },
    recent: q.recentStreams.all(u.id).reverse().map(s => ({
      id: s.id, title: s.title, category: s.category, startedAt: s.started_at,
      minutes: s.ended_at ? Math.round((s.ended_at - s.started_at) / 60000) : 0, peak: s.peak_viewers,
      replay: !!s.ended_at && replay.hasReplay(s.id)
    })),
    reports: q.reportsFor.all(u.username).map(r => ({ username: r.username, message: r.message, reason: r.reason, at: r.created_at })),
    mods: q.modsList.all(u.id).map(r => r.username),
    channelDesc: u.channel_desc, blockedWords: splitList(u.blocked_words),
    analytics: social.analytics(u.id)
  });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '1h' : 0 }));

/* --------------------------------------------------------------- realtime */
const server = http.createServer(app);
io = new Server(server, {
  maxHttpBufferSize: 1e5,
  cors: process.env.CORS_ORIGINS ? { origin: process.env.CORS_ORIGINS.split(',') } : undefined
});
io.use((socket, next) => {
  const t = socket.handshake.auth && socket.handshake.auth.token;
  let u = t ? userFromToken(t) : null;
  if (restrictionOf(u)) u = null;
  socket.user = u;
  next();
});
social = mountSocial({
  app, io, db, q, auth, need, rooms, limiter, addCols, minAgeMs, getSetting, isTeen, isBlockedBy,
  cleanText, filterText, cleanList, splitList, colorFor, REACTIONS
});
replay = mountReplay({
  app, db, q, need, rooms, limiter, getSetting, filterText, splitList, colorFor, restrictionOf
});
admin = mountAdmin({
  app, io, db, q, auth, need, rooms, limiter, endStream, social, cleanText, filterText, cleanList, splitList, colorFor, publicUser, isTeen, ageOf,
  signToken, getSetting, putSetting, SETTING_DEFAULTS, setGlobalWords, restrictionOf, DB_PATH, IS_PROD, EPHEMERAL_SECRET,
  hasTurn: !!process.env.TURN_URL, envBlockedCount: BLOCKED.length, wordRegex, replay
});

function leave(socket) {
  const key = socket.data.watching;
  if (!key) return;
  socket.leave('ch:' + key);
  socket.data.watching = null;
  const room = rooms.get(key);
  if (!room) return;
  const entry = room.viewers.get(socket.id);
  if (room.viewers.delete(socket.id)) {
    social.viewerLeft(entry);
    if (room.ownerSocket) io.to(room.ownerSocket).emit('viewer-left', { id: socket.id });
    broadcast(room);
  }
  cleanupRoom(room);
}

io.on('connection', socket => {
  socket.data.lastMsg = 0;
  social.userConnected(socket);
  const currentRoom = () => rooms.get(socket.data.watching);
  const isHost = room => room && room.ownerSocket === socket.id;
  const canMod = room => !!(room && socket.user && (socket.user.id === room.ownerId || room.mods.has(socket.user.id)));
  const NO_MOD = { error: 'Only the streamer or a moderator can do that.' };
  const maintBlock = () => (getSetting('maintenance') && !(socket.user && socket.user.role === 'admin') ? getSetting('maintenanceMessage') : null);
  const wrap = fn => (payload, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    try { fn(payload || {}, ack); } catch (e) { console.error(e); if (admin) admin.logError(e.message, 'socket'); ack({ error: 'Something went wrong on our side. Please try again.' }); }
  };

  socket.on('watch', wrap(({ channel }, ack) => {
    const name = String(channel || '');
    const owner = /^[a-zA-Z0-9_]{3,20}$/.test(name) ? q.userByName.get(name) : null;
    if (!owner) return ack({ error: 'Channel not found.' });
    leave(socket);
    const room = getRoom(owner);
    const ownerView = socket.user && socket.user.id === owner.id;
    if (!ownerView && room.viewers.size >= maxViewers()) {
      cleanupRoom(room);
      return ack({ error: 'This room is full. Small rooms keep chat human - try again in a bit.' });
    }
    socket.join(roomName(room));
    socket.data.watching = room.key;
    if (!ownerView) {
      room.viewers.set(socket.id, { user: socket.user });
      social.viewerJoined(room, room.viewers.get(socket.id));
      room.peak = Math.max(room.peak, room.viewers.size);
      assignEarlyBirds(room);
    }
    broadcast(room);
    const myVote = room.poll && socket.user ? room.poll.options.findIndex(o => o.voters.has(socket.user.id)) : -1;
    ack({ ok: true, state: publicState(room), history: room.history, isOwner: !!ownerView, myVote });
  }));

  socket.on('leave', () => leave(socket));

  socket.on('ready', () => {
    const room = currentRoom();
    if (room && room.live && room.ownerSocket && room.viewers.has(socket.id)) {
      io.to(room.ownerSocket).emit('viewer-ready', { id: socket.id });
    }
  });

  socket.on('signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!target || !data) return;
    const ok = (socket.data.hosting && target.data.watching === socket.data.hosting) ||
               (target.data.hosting && socket.data.watching === target.data.hosting);
    if (ok) target.emit('signal', { from: socket.id, data });
  });

  socket.on('host', wrap(({ title, category, description, tags }, ack) => {
    if (!socket.user) return ack({ error: 'Log in to go live.' });
    if (maintBlock()) return ack({ error: maintBlock() });
    const room = getRoom(socket.user);
    if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
    const reconnect = room.live;
    if (socket.data.watching !== room.key) leave(socket);
    socket.join(roomName(room));
    socket.data.watching = room.key;
    socket.data.hosting = room.key;
    room.ownerSocket = socket.id;
    if (!reconnect) {
      room.title = cleanText(title, 80) || `${socket.user.username}'s stream`;
      room.category = CATEGORIES.includes(category) ? category : 'Just Chatting';
      room.description = filterText(cleanText(description, 300));
      room.tags = cleanTags(tags);
      room.startedAt = Date.now();
      room.peak = room.viewers.size;
      room.earlyBirds.clear(); room.pinsUsed.clear(); room.revoked.clear(); room.muted.clear(); room.timeouts.clear();
      room.pins = []; room.history = []; room.poll = null; room.slow = 0; room.msgReacts.clear(); room.chatCount = 0;
      room.streamId = q.insertStream.run(socket.user.id, room.title, room.category, room.description, room.tags.join(','), room.startedAt).lastInsertRowid;
      room.live = true;
      systemMsg(room, '🔴 Stream started. The first 4 viewers become Early Birds and can pin messages.');
      social.streamStarted(room, socket.user);
    }
    assignEarlyBirds(room);
    ack({ ok: true });
    if (reconnect) io.to(roomName(room)).emit('restart');
    broadcast(room);
  }));

  socket.on('end', () => {
    const room = rooms.get(socket.data.hosting);
    socket.data.hosting = null;
    if (isHost(room)) endStream(room);
  });

  const blockedNow = (room, u, now) => {
    if (room.muted.has(u.id)) return 'You are muted in this channel.';
    const t = room.timeouts.get(u.id);
    if (t && t > now && !canMod(room)) return `You are timed out for ${Math.ceil((t - now) / 1000)}s.`;
    return null;
  };

  socket.on('chat', wrap(({ text, replyTo }, ack) => {
    const room = currentRoom();
    if (!room) return ack({ error: 'Join a channel first.' });
    if (!socket.user) return ack({ error: 'Log in to chat.' });
    if (maintBlock()) return ack({ error: maintBlock() });
    const now = Date.now();
    const blocked = blockedNow(room, socket.user, now);
    if (blocked) return ack({ error: blocked });
    if (now - socket.data.lastMsg < 800) return ack({ ok: false, silent: true }); // too quick: quietly ignored, no alert
    if (room.slow && !canMod(room) && now - (socket.data.lastChat || 0) < room.slow * 1000) {
      return ack({ error: `Slow mode is on. Wait ${Math.ceil((room.slow * 1000 - (now - socket.data.lastChat)) / 1000)}s.` });
    }
    const clean = filterText(cleanText(text, MAX_MSG), room.blocked);
    if (!clean) return ack({ error: 'Message is empty.' });
    socket.data.lastMsg = now;
    socket.data.lastChat = now;
    let reply = null, replyUser = 0;
    if (replyTo) {
      const m = room.history.find(x => x.id === replyTo && !x.system);
      if (m) { reply = { id: m.id, username: m.username, text: String(m.text).slice(0, 80) }; replyUser = m.userId; }
    }
    room.chatCount++;
    emitChat(room, userMsg(room, socket.user, clean, reply ? { reply } : {}));
    social.chatMention(room, socket.user, clean, replyUser);
    ack({ ok: true });
  }));

  // Early Bird Pins: first 4 viewers, 3 pins each per stream, streamer or a mod clears them.
  socket.on('pin', wrap(({ text }, ack) => {
    const room = currentRoom();
    const u = socket.user;
    if (!room || !room.live) return ack({ error: 'The stream is not live.' });
    if (!u) return ack({ error: 'Log in to pin.' });
    if (maintBlock()) return ack({ error: maintBlock() });
    if (!room.earlyBirds.has(u.id)) return ack({ error: 'Only the first 4 viewers (Early Birds) can pin.' });
    if (room.revoked.has(u.id)) return ack({ error: 'The streamer turned off your pins.' });
    const now = Date.now();
    const blocked = blockedNow(room, u, now);
    if (blocked) return ack({ error: blocked });
    const used = room.pinsUsed.get(u.id) || 0;
    if (used >= PINS_PER_BIRD) return ack({ error: 'You have used all 3 pins for this stream.' });
    if (now - socket.data.lastMsg < 800) return ack({ ok: false, silent: true }); // too quick: quietly ignored, no alert
    const clean = filterText(cleanText(text, MAX_MSG), room.blocked);
    if (!clean) return ack({ error: 'Message is empty.' });
    socket.data.lastMsg = now;
    room.pinsUsed.set(u.id, used + 1);
    const pin = { id: crypto.randomUUID(), userId: u.id, username: u.username, color: colorFor(u.username), text: clean, ts: now };
    room.pins.push(pin);
    emitChat(room, userMsg(room, u, clean, { pinned: true }));
    broadcast(room);
    ack({ ok: true, pinsLeft: PINS_PER_BIRD - used - 1 });
  }));

  socket.on('answer', wrap(({ pinId }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    const i = room.pins.findIndex(p => p.id === pinId);
    if (i === -1) return ack({ error: 'Pin not found.' });
    const [pin] = room.pins.splice(i, 1);
    social.pinAnswered(room, pin);
    io.to(roomName(room)).emit('answered', { username: pin.username, text: pin.text });
    broadcast(room);
    ack({ ok: true });
  }));

  // moderators cannot act on the owner or on other moderators (only the owner can)
  const targetOk = (room, id) => id !== room.ownerId && (!room.mods.has(id) || socket.user.id === room.ownerId);

  socket.on('revoke-pins', wrap(({ userId }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    const id = Number(userId);
    if (!targetOk(room, id)) return ack({ error: 'You cannot do that to this person.' });
    room.revoked.add(id);
    room.pins = room.pins.filter(p => p.userId !== id);
    broadcast(room);
    ack({ ok: true });
  }));

  socket.on('mute', wrap(({ userId }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    const id = Number(userId);
    if (!targetOk(room, id)) return ack({ error: 'You cannot do that to this person.' });
    room.muted.add(id);
    room.pins = room.pins.filter(p => p.userId !== id);
    systemMsg(room, 'A viewer was muted by the channel team.');
    broadcast(room);
    ack({ ok: true });
  }));

  socket.on('timeout', wrap(({ userId, seconds }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    const id = Number(userId);
    if (!targetOk(room, id)) return ack({ error: 'You cannot do that to this person.' });
    const secs = clamp(seconds, 10, 86400);
    room.timeouts.set(id, Date.now() + secs * 1000);
    room.pins = room.pins.filter(p => p.userId !== id);
    systemMsg(room, `A viewer was timed out for ${secs >= 60 ? Math.round(secs / 60) + ' min' : secs + 's'}.`);
    broadcast(room);
    ack({ ok: true });
  }));

  socket.on('slowmode', wrap(({ seconds }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    room.slow = [5, 10, 30, 60, 120].includes(Number(seconds)) ? Number(seconds) : 0;
    systemMsg(room, room.slow ? `🐢 Slow mode on: one message every ${room.slow}s.` : 'Slow mode is off.');
    broadcast(room);
    ack({ ok: true });
  }));

  socket.on('delete-msg', wrap(({ id }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    const i = room.history.findIndex(m => m.id === id);
    if (i !== -1) room.history.splice(i, 1);
    replay.markDeleted(room, id);
    io.to(roomName(room)).emit('msg-deleted', { id });
    ack({ ok: true });
  }));

  // reactions: animated emoji on the stream, and counts on chat messages
  socket.on('react', wrap(({ emoji }, ack) => {
    const room = currentRoom();
    if (!room || !room.live) return ack({ error: 'The stream is not live.' });
    if (!socket.user) return ack({ error: 'Log in to react.' });
    if (!REACTIONS.includes(emoji)) return ack({ error: 'Unknown reaction.' });
    const now = Date.now();
    if (now - (socket.data.lastReact || 0) < 150) return ack({ ok: true });
    socket.data.lastReact = now;
    io.to(roomName(room)).emit('reaction', { emoji });
    ack({ ok: true });
  }));

  socket.on('react-msg', wrap(({ id, emoji }, ack) => {
    const room = currentRoom();
    const u = socket.user;
    if (!room || !u) return ack({ error: 'Log in to react.' });
    if (!REACTIONS.includes(emoji)) return ack({ error: 'Unknown reaction.' });
    const m = room.history.find(x => x.id === id);
    if (!m || m.system) return ack({ error: 'Message not found.' });
    let byEmoji = room.msgReacts.get(id);
    if (!byEmoji) { byEmoji = new Map(); room.msgReacts.set(id, byEmoji); }
    let set = byEmoji.get(emoji);
    if (!set) { set = new Set(); byEmoji.set(emoji, set); }
    if (set.has(u.id)) set.delete(u.id); else set.add(u.id);
    m.reactions = {};
    for (const [e, s] of byEmoji) if (s.size) m.reactions[e] = s.size;
    replay.setReactions(room, id, m.reactions);
    io.to(roomName(room)).emit('msg-reactions', { id, reactions: m.reactions });
    ack({ ok: true });
  }));

  // polls: streamer or mod starts one, everyone logged in votes once
  socket.on('poll-start', wrap(({ question, options }, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    if (!room.live) return ack({ error: 'Start the stream first.' });
    const qn = filterText(cleanText(question, 120), room.blocked);
    const opts = cleanList(options, 4, 40).map(s => filterText(s, room.blocked));
    if (!qn || opts.length < 2) return ack({ error: 'A poll needs a question and at least 2 options.' });
    room.poll = { id: crypto.randomUUID(), question: qn, open: true, options: opts.map(text => ({ text, voters: new Set() })) };
    systemMsg(room, `📊 New poll: ${qn}`);
    broadcast(room);
    ack({ ok: true });
  }));

  socket.on('poll-vote', wrap(({ index }, ack) => {
    const room = currentRoom();
    const u = socket.user;
    if (!u) return ack({ error: 'Log in to vote.' });
    if (!room || !room.poll || !room.poll.open) return ack({ error: 'There is no open poll.' });
    const i = Number(index);
    if (!room.poll.options[i]) return ack({ error: 'Pick one of the options.' });
    if (room.poll.options.some(o => o.voters.has(u.id))) return ack({ error: 'You already voted.' });
    room.poll.options[i].voters.add(u.id);
    broadcast(room);
    ack({ ok: true, index: i });
  }));

  socket.on('poll-end', wrap((_p, ack) => {
    const room = currentRoom();
    if (!canMod(room)) return ack(NO_MOD);
    if (room.poll) { room.poll.open = false; broadcast(room); }
    ack({ ok: true });
  }));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.hosting);
    if (room && room.ownerSocket === socket.id) {
      // grace period so a page refresh does not kill the stream
      room.graceTimer = setTimeout(() => endStream(room), 15000);
    }
    leave(socket);
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'That does not exist.' }));
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to send.' });
  console.error(err);
  if (admin) admin.logError(err && err.message, 'http');
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});
server.listen(PORT, '0.0.0.0', () => console.log(`NovaStream running on http://0.0.0.0:${PORT}`));
const shutdown = () => { io.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
