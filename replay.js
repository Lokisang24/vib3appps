'use strict';
/**
 * Chat Replay.
 *
 * While a stream is live, every chat line is also written to the `chat_log` table with its offset
 * (milliseconds since the stream started). After the stream ends, the replay page plays that log back on a
 * timeline: scrub or play and the messages appear at the exact second they were first sent.
 *
 * Built-in video is peer-to-peer and is not recorded, so a replay is the chat, the pinned questions and a chat
 * activity chart on a timeline. The timeline works from a millisecond clock, so when recordings exist later the
 * clock can simply follow the video's currentTime (see public/replay.js, `clock`).
 *
 * Privacy and safety: a site setting switches it off and sets how many days chats are kept; the streamer (or an
 * admin) can delete a replay; deleted messages are never served; people you blocked, and people who are
 * suspended or banned, are left out; the site and channel word filters are applied again when playing back;
 * deleting an account removes that person's saved messages.
 */
module.exports = function mountReplay(ctx) {
  const { app, db, q, need, rooms, getSetting, filterText, splitList, colorFor, restrictionOf, limiter } = ctx;

  db.exec(`
CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  offset_ms INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0,
  owner INTEGER NOT NULL DEFAULT 0,
  mod INTEGER NOT NULL DEFAULT 0,
  early_bird INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  reply_user TEXT NOT NULL DEFAULT '',
  reply_text TEXT NOT NULL DEFAULT '',
  reactions TEXT NOT NULL DEFAULT '{}',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chatlog_stream ON chat_log(stream_id, id);
CREATE INDEX IF NOT EXISTS idx_chatlog_msg ON chat_log(stream_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_chatlog_user ON chat_log(user_id);
`);

  const p = {
    insert: db.prepare('INSERT INTO chat_log (stream_id, msg_id, offset_ms, user_id, username, text, system, owner, mod, early_bird, pinned, reply_user, reply_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    setReactions: db.prepare('UPDATE chat_log SET reactions = ? WHERE stream_id = ? AND msg_id = ?'),
    markDeleted: db.prepare("UPDATE chat_log SET deleted = 1, text = '', reactions = '{}' WHERE stream_id = ? AND msg_id = ?"),
    stream: db.prepare('SELECT * FROM streams WHERE id = ?'),
    hasChat: db.prepare('SELECT 1 FROM chat_log WHERE stream_id = ? AND system = 0 AND deleted = 0 LIMIT 1'),
    countChat: db.prepare('SELECT COUNT(*) c, COALESCE(MAX(offset_ms), 0) last FROM chat_log WHERE stream_id = ? AND system = 0 AND deleted = 0'),
    offsets: db.prepare('SELECT offset_ms t FROM chat_log WHERE stream_id = ? AND system = 0 AND deleted = 0'),
    window: db.prepare(`SELECT c.*, u.status ustatus, u.suspended_until usus FROM chat_log c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.stream_id = ? AND c.offset_ms >= ? AND c.offset_ms < ? AND c.id > ? AND c.deleted = 0 ORDER BY c.id LIMIT ?`),
    pins: db.prepare(`SELECT c.*, u.status ustatus, u.suspended_until usus FROM chat_log c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.stream_id = ? AND c.pinned = 1 AND c.deleted = 0 ORDER BY c.id LIMIT 24`),
    listForUser: db.prepare(`SELECT s.id, s.title, s.category, s.started_at, s.ended_at, s.peak_viewers,
      (SELECT COUNT(*) FROM chat_log c WHERE c.stream_id = s.id AND c.system = 0 AND c.deleted = 0) msgs,
      (SELECT COALESCE(MAX(c.offset_ms), 0) FROM chat_log c WHERE c.stream_id = s.id) last
      FROM streams s WHERE s.user_id = ? AND s.ended_at IS NOT NULL ORDER BY s.id DESC LIMIT 30`),
    wipeStream: db.prepare('DELETE FROM chat_log WHERE stream_id = ?'),
    wipeUser: db.prepare('DELETE FROM chat_log WHERE user_id = ?'),
    userStreams: db.prepare('SELECT id FROM streams WHERE user_id = ?'),
    purgeOld: db.prepare('DELETE FROM chat_log WHERE stream_id IN (SELECT id FROM streams WHERE started_at < ?)'),
    mineForExport: db.prepare(`SELECT s.title stream, c.offset_ms offsetMs, c.text FROM chat_log c JOIN streams s ON s.id = c.stream_id
      WHERE c.user_id = ? AND c.system = 0 AND c.deleted = 0 ORDER BY c.id DESC LIMIT 2000`),
    audit: db.prepare('INSERT INTO audit_log (admin_id, action, target, detail, created_at) VALUES (?,?,?,?,?)')
  };

  const enabled = () => getSetting('chatReplayEnabled') !== false;
  const days = () => Math.max(1, Number(getSetting('chatReplayDays')) || 30);
  const BUCKETS = 90;
  const WINDOW_MAX = 600000;      // the most the chat endpoint returns per request, in ms of stream time
  const LIMIT_MAX = 1000;

  /** Called for every chat line of a live stream. Never throws: chat must keep working even if this fails. */
  function record(room, msg) {
    try {
      if (!enabled() || !room.live || !room.streamId) return;
      const offset = Math.max(0, (msg.ts || Date.now()) - (room.startedAt || msg.ts || Date.now()));
      p.insert.run(room.streamId, String(msg.id), offset, msg.userId || 0, msg.username || '', String(msg.text || ''),
        msg.system ? 1 : 0, msg.owner ? 1 : 0, msg.mod ? 1 : 0, msg.earlyBird ? 1 : 0, msg.pinned ? 1 : 0,
        msg.reply ? String(msg.reply.username || '') : '', msg.reply ? String(msg.reply.text || '') : '');
    } catch (e) { console.error('chat replay: could not save a message:', e.message); }
  }
  const setReactions = (room, id, reactions) => { try { if (room.streamId) p.setReactions.run(JSON.stringify(reactions || {}), room.streamId, String(id)); } catch { /* keep chatting */ } };
  const markDeleted = (room, id) => { try { if (room.streamId) p.markDeleted.run(room.streamId, String(id)); } catch { /* keep chatting */ } };

  function purgeOld() {
    try {
      const r = p.purgeOld.run(Date.now() - days() * 86400000);
      if (r.changes) console.log(`chat replay: removed ${r.changes} saved messages older than ${days()} days`);
    } catch (e) { console.error('chat replay: purge failed:', e.message); }
  }
  purgeOld();
  setInterval(purgeOld, 3600000).unref();

  const wipeUser = id => { p.wipeUser.run(id); for (const s of p.userStreams.all(id)) p.wipeStream.run(s.id); };

  /* ------------------------------------------------------------------ helpers */
  const parseId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };
  const durationOf = (s, lastOffset) => Math.max(0, (s.ended_at || s.started_at) - s.started_at, lastOffset || 0);

  /** A replay a viewer may open: finished stream, replays on, owner in good standing. */
  function openable(streamId) {
    const s = p.stream.get(streamId);
    if (!s) return { error: 'Replay not found.', status: 404 };
    const owner = q.userById.get(s.user_id);
    if (!owner || restrictionOf(owner)) return { error: 'Replay not found.', status: 404 };
    if (!enabled()) return { error: 'Chat Replay is switched off right now.', status: 404 };
    const room = rooms.get(owner.username.toLowerCase());
    if (!s.ended_at || (room && room.live && room.streamId === s.id)) return { live: true, stream: s, owner };
    if (s.started_at < Date.now() - days() * 86400000) return { error: 'This replay has expired.', status: 404 };
    return { stream: s, owner };
  }

  const visibleUser = r => {
    if (r.system || !r.user_id) return true;
    return !restrictionOf({ status: r.ustatus, suspended_until: r.usus });
  };
  function shape(r, extraWords, blockedIds) {
    if (!r.system && blockedIds.has(r.user_id)) return null;
    if (!visibleUser(r)) return null;
    let reactions = {};
    try { reactions = JSON.parse(r.reactions || '{}'); } catch { /* none */ }
    return {
      id: r.msg_id, row: r.id, t: r.offset_ms, system: !!r.system,
      userId: r.user_id, username: r.username, color: r.system ? undefined : colorFor(r.username),
      text: filterText(r.text, extraWords),
      owner: !!r.owner, mod: !!r.mod, earlyBird: !!r.early_bird, pinned: !!r.pinned,
      reply: r.reply_user ? { username: r.reply_user, text: filterText(r.reply_text, extraWords) } : undefined,
      reactions
    };
  }
  const blockedSet = userId => new Set(q.blocksOf.all(userId).map(b => b.id));

  /* --------------------------------------------------------------------- API */
  const readLimit = limiter ? limiter({ windowMs: 60000, max: 240 }) : (_q, _r, n) => n();

  // past streams of a channel that have a chat replay
  app.get('/api/replays/:name', need, (req, res) => {
    const owner = q.userByName.get(req.params.name);
    if (!owner || restrictionOf(owner)) return res.status(404).json({ error: 'Channel not found.' });
    if (!enabled()) return res.json({ enabled: false, replays: [], days: days() });
    const room = rooms.get(owner.username.toLowerCase());
    const cutoff = Date.now() - days() * 86400000;
    const replays = p.listForUser.all(owner.id)
      .filter(s => s.msgs > 0 && s.started_at >= cutoff && !(room && room.live && room.streamId === s.id))
      .slice(0, 12)
      .map(s => ({ id: s.id, title: s.title, category: s.category, startedAt: s.started_at, durationMs: durationOf(s, s.last), peak: s.peak_viewers, messages: s.msgs }));
    res.json({ enabled: true, replays, days: days() });
  });

  // everything the page needs before it starts playing: stream info, activity chart, pinned questions
  app.get('/api/replay/:id', need, readLimit, (req, res) => {
    const id = parseId(req.params.id);
    const o = id ? openable(id) : { error: 'Replay not found.', status: 404 };
    if (o.error) return res.status(o.status).json({ error: o.error });
    const { stream: s, owner } = o;
    const channel = { username: owner.username, displayName: owner.display_name || owner.username, color: colorFor(owner.username), avatar: (owner.avatar_img || owner.avatar) || '' };
    const base = { id: s.id, title: s.title, category: s.category, description: s.description, startedAt: s.started_at, peak: s.peak_viewers };
    if (o.live) return res.json({ live: true, stream: base, channel });
    const tot = p.countChat.get(s.id);
    const durationMs = Math.max(1000, durationOf(s, tot.last));
    const buckets = new Array(BUCKETS).fill(0);
    for (const r of p.offsets.all(s.id)) buckets[Math.min(BUCKETS - 1, Math.floor(r.t / durationMs * BUCKETS))]++;
    const extra = splitList(owner.blocked_words);
    const blocked = blockedSet(req.user.id);
    const pins = p.pins.all(s.id).map(r => shape(r, extra, blocked)).filter(Boolean).map(m => ({ t: m.t, username: m.username, text: m.text }));
    res.json({
      live: false, stream: { ...base, endedAt: s.ended_at, durationMs }, channel, messages: tot.c, buckets, pins,
      keptDays: days(), canDelete: req.user.id === owner.id || req.user.role === 'admin'
    });
  });

  // chat lines for a slice of stream time: from <= t < to, in the order they were sent
  app.get('/api/replay/:id/chat', need, readLimit, (req, res) => {
    const id = parseId(req.params.id);
    const o = id ? openable(id) : { error: 'Replay not found.', status: 404 };
    if (o.error) return res.status(o.status).json({ error: o.error });
    if (o.live) return res.status(409).json({ error: 'This stream is still live.' });
    const from = Math.max(0, Math.floor(Number(req.query.from)) || 0);
    let to = Math.floor(Number(req.query.to));
    if (!Number.isFinite(to) || to <= from) to = from + 30000;
    to = Math.min(to, from + WINDOW_MAX);
    const after = Math.max(0, Math.floor(Number(req.query.after)) || 0);
    const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(req.query.limit)) || 500));
    const rows = p.window.all(id, from, to, after, limit + 1);
    const more = rows.length > limit;
    const extra = splitList(o.owner.blocked_words);
    const blocked = blockedSet(req.user.id);
    const messages = rows.slice(0, limit).map(r => shape(r, extra, blocked)).filter(Boolean);
    const lastRow = rows.length ? rows[Math.min(rows.length, limit) - 1].id : after;
    res.json({ from, to, messages, more, next: more ? lastRow : 0 });
  });

  // the streamer, or an admin, can delete a saved chat replay
  app.delete('/api/replay/:id', need, (req, res) => {
    const id = parseId(req.params.id);
    const s = id && p.stream.get(id);
    if (!s) return res.status(404).json({ error: 'Replay not found.' });
    const isOwner = s.user_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the streamer can delete this replay.' });
    const r = p.wipeStream.run(id);
    if (!isOwner) { try { p.audit.run(req.user.id, 'replay_deleted', 'stream #' + id, s.title || '', Date.now()); } catch { /* audit is best effort */ } }
    res.json({ ok: true, removed: r.changes });
  });

  return {
    record, setReactions, markDeleted, wipeUser, purgeOld,
    hasReplay: streamId => enabled() && !!p.hasChat.get(streamId),
    exportFor: userId => p.mineForExport.all(userId)
  };
};
