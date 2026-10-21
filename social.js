'use strict';
/**
 * NovaStream Phase 2: social feed, Circles, notifications, search & discovery,
 * appreciation score, achievements and creator analytics.
 * Mounted from server.js with the shared app, database and helpers.
 */
const express = require('express');

module.exports = function mountSocial(ctx) {
  const { app, io, db, q, auth, need, rooms, limiter, addCols, minAgeMs, getSetting, isTeen, isBlockedBy } = ctx;
  const { cleanText, filterText, cleanList, splitList, colorFor, REACTIONS } = ctx;
  const DAY = 86400000;

  /* ---------------------------------------------------------------- schema */
  addCols('follows', [['created_at', 'INTEGER NOT NULL DEFAULT 0']]);
  addCols('streams', [['chat_count', 'INTEGER NOT NULL DEFAULT 0']]);
  addCols('users', [['notif_prefs', "TEXT NOT NULL DEFAULT '{}'"], ['quiet_start', 'INTEGER NOT NULL DEFAULT -1'],
    ['quiet_end', 'INTEGER NOT NULL DEFAULT -1'], ['tz_offset', 'INTEGER NOT NULL DEFAULT 0']]);
  db.exec(`
CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, circle_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'update', body TEXT NOT NULL DEFAULT '', repost_of INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS post_reactions (post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, reply_to INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS circles (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL, goal_title TEXT NOT NULL DEFAULT '', goal_target INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS circle_members (circle_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, contribs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (circle_id, user_id));
CREATE TABLE IF NOT EXISTS circle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', starts_at INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_rsvps (event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (event_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_badges (user_id INTEGER NOT NULL, code TEXT NOT NULL, earned_at INTEGER NOT NULL, PRIMARY KEY (user_id, code));
CREATE TABLE IF NOT EXISTS pin_answers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stream_views (id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, left_at INTEGER);
CREATE TABLE IF NOT EXISTS watch_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, category TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS circle_bans (circle_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (circle_id, user_id));
CREATE TABLE IF NOT EXISTS post_media (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, post_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_media_post ON post_media(post_id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_circle ON posts(circle_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_views_stream ON stream_views(stream_id);
`);

  addCols('circle_events', [['reminded', 'INTEGER NOT NULL DEFAULT 0']]);

  const BLOCK_FILTER = 'user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)';
  const p = {
    postById: db.prepare('SELECT * FROM posts WHERE id = ?'),
    insertPost: db.prepare('INSERT INTO posts (user_id, circle_id, kind, body, repost_of, created_at) VALUES (?,?,?,?,?,?)'),
    delPost: db.prepare('DELETE FROM posts WHERE id = ?'),
    delPostReacts: db.prepare('DELETE FROM post_reactions WHERE post_id = ?'),
    delPostComments: db.prepare('DELETE FROM comments WHERE post_id = ?'),
    delPostMedia: db.prepare('DELETE FROM post_media WHERE post_id = ?'),
    mediaOf: db.prepare('SELECT id, kind FROM post_media WHERE post_id = ? ORDER BY id'),
    mediaMeta: db.prepare('SELECT id, user_id, post_id, kind FROM post_media WHERE id = ?'),
    mediaHead: db.prepare('SELECT id, post_id, mime, length(data) AS size FROM post_media WHERE id = ?'),
    mediaSlice: db.prepare('SELECT substr(data, ?, ?) AS chunk FROM post_media WHERE id = ?'),
    mediaPending: db.prepare('SELECT COUNT(*) c FROM post_media WHERE user_id = ? AND post_id = 0'),
    insertMedia: db.prepare('INSERT INTO post_media (user_id, post_id, kind, mime, data, created_at) VALUES (?,0,?,?,?,?)'),
    attachMedia: db.prepare('UPDATE post_media SET post_id = ? WHERE id = ? AND user_id = ? AND post_id = 0'),
    ownPostCount: db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ? AND repost_of = 0'),
    feedAll: db.prepare(`SELECT * FROM posts WHERE id < ? AND ${BLOCK_FILTER} ORDER BY id DESC LIMIT ?`),
    feedFollowing: db.prepare(`SELECT * FROM posts WHERE id < ? AND (user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?) OR user_id = ? OR circle_id IN (SELECT circle_id FROM circle_members WHERE user_id = ?)) AND ${BLOCK_FILTER} ORDER BY id DESC LIMIT ?`),
    feedUser: db.prepare(`SELECT * FROM posts WHERE user_id = ? AND circle_id = 0 AND id < ? ORDER BY id DESC LIMIT ?`),
    feedCircle: db.prepare(`SELECT * FROM posts WHERE circle_id = ? AND id < ? AND ${BLOCK_FILTER} ORDER BY id DESC LIMIT ?`),
    reactionCounts: db.prepare('SELECT emoji, COUNT(*) c FROM post_reactions WHERE post_id = ? GROUP BY emoji'),
    myReaction: db.prepare('SELECT emoji FROM post_reactions WHERE post_id = ? AND user_id = ?'),
    upsertReaction: db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji, created_at) VALUES (?,?,?,?) ON CONFLICT(post_id, user_id) DO UPDATE SET emoji = excluded.emoji'),
    delReaction: db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?'),
    commentCount: db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?'),
    repostCount: db.prepare('SELECT COUNT(*) c FROM posts WHERE repost_of = ?'),
    commentsOf: db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id LIMIT 200'),
    commentById: db.prepare('SELECT * FROM comments WHERE id = ?'),
    insertComment: db.prepare('INSERT INTO comments (post_id, user_id, reply_to, body, created_at) VALUES (?,?,?,?,?)'),
    hasRepost: db.prepare('SELECT 1 FROM posts WHERE user_id = ? AND repost_of = ?'),

    circleById: db.prepare('SELECT * FROM circles WHERE id = ?'),
    circleBySlug: db.prepare('SELECT * FROM circles WHERE slug = ?'),
    circlesByOwner: db.prepare('SELECT COUNT(*) c FROM circles WHERE owner_id = ?'),
    insertCircle: db.prepare('INSERT INTO circles (slug, name, description, emoji, owner_id, goal_title, goal_target, created_at) VALUES (?,?,?,?,?,?,?,?)'),
    updateCircle: db.prepare('UPDATE circles SET description = ?, goal_title = ?, goal_target = ? WHERE id = ?'),
    allCircles: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) members FROM circles c ORDER BY c.id DESC LIMIT 200'),
    memberRow: db.prepare('SELECT * FROM circle_members WHERE circle_id = ? AND user_id = ?'),
    memberCount: db.prepare('SELECT COUNT(*) c FROM circle_members WHERE circle_id = ?'),
    addMember: db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?,?,?,?)'),
    delMember: db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?'),
    setRole: db.prepare('UPDATE circle_members SET role = ? WHERE circle_id = ? AND user_id = ?'),
    bump: db.prepare('UPDATE circle_members SET contribs = contribs + 1 WHERE circle_id = ? AND user_id = ?'),
    members: db.prepare('SELECT cm.*, u.username, u.display_name, u.avatar, u.avatar_img FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? ORDER BY cm.joined_at, cm.user_id LIMIT 100'),
    memberIds: db.prepare('SELECT user_id FROM circle_members WHERE circle_id = ?'),
    nthJoin: db.prepare('SELECT joined_at FROM circle_members WHERE circle_id = ? ORDER BY joined_at, user_id LIMIT 1 OFFSET ?'),
    myCircleIds: db.prepare('SELECT circle_id FROM circle_members WHERE user_id = ?'),
    insertEvent: db.prepare('INSERT INTO circle_events (circle_id, title, description, starts_at, created_by, created_at) VALUES (?,?,?,?,?,?)'),
    eventsOf: db.prepare('SELECT * FROM circle_events WHERE circle_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 10'),
    eventById: db.prepare('SELECT * FROM circle_events WHERE id = ?'),
    delEvent: db.prepare('DELETE FROM circle_events WHERE id = ?'),
    dueEvents: db.prepare('SELECT * FROM circle_events WHERE reminded = 0 AND starts_at <= ? AND starts_at > ?'),
    markReminded: db.prepare('UPDATE circle_events SET reminded = 1 WHERE id = ?'),
    rsvpUsers: db.prepare('SELECT user_id FROM event_rsvps WHERE event_id = ?'),
    isBanned: db.prepare('SELECT 1 FROM circle_bans WHERE circle_id = ? AND user_id = ?'),
    addBan: db.prepare('INSERT OR IGNORE INTO circle_bans (circle_id, user_id) VALUES (?,?)'),
    rsvpCount: db.prepare('SELECT COUNT(*) c FROM event_rsvps WHERE event_id = ?'),
    myRsvp: db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?'),
    addRsvp: db.prepare('INSERT OR IGNORE INTO event_rsvps VALUES (?,?)'),
    delRsvp: db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?'),

    insertNotif: db.prepare('INSERT INTO notifications (user_id, type, text, link, created_at) VALUES (?,?,?,?,?)'),
    dupNotif: db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND type = ? AND text = ? AND link = ? AND created_at > ?'),
    notifsOf: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
    unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0'),
    readAll: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?'),
    setPrefs: db.prepare('UPDATE users SET notif_prefs = ?, quiet_start = ?, quiet_end = ?, tz_offset = ? WHERE id = ?'),
    followerIds: db.prepare('SELECT follower_id FROM follows WHERE followee_id = ? LIMIT 500'),
    followeeIds: db.prepare('SELECT followee_id FROM follows WHERE follower_id = ?'),

    addBadge: db.prepare('INSERT OR IGNORE INTO user_badges (user_id, code, earned_at) VALUES (?,?,?)'),
    badgesOf: db.prepare('SELECT code, earned_at FROM user_badges WHERE user_id = ? ORDER BY earned_at'),
    insertPinAnswer: db.prepare('INSERT INTO pin_answers (user_id, channel_id, created_at) VALUES (?,?,?)'),

    insertView: db.prepare('INSERT INTO stream_views (stream_id, user_id, joined_at) VALUES (?,?,?)'),
    closeView: db.prepare('UPDATE stream_views SET left_at = ? WHERE id = ? AND left_at IS NULL'),
    setChatCount: db.prepare('UPDATE streams SET chat_count = ? WHERE id = ?'),
    addHistory: db.prepare('INSERT INTO watch_history (user_id, channel_id, category, ts) VALUES (?,?,?,?)'),
    historyCats: db.prepare('SELECT category FROM watch_history WHERE user_id = ? ORDER BY id DESC LIMIT 30'),

    streamAnalytics: db.prepare(`SELECT s.id, s.title, s.started_at, s.ended_at, s.peak_viewers, s.chat_count,
      (SELECT COUNT(DISTINCT v.user_id) FROM stream_views v WHERE v.stream_id = s.id AND v.user_id > 0) uniq_users,
      (SELECT COUNT(*) FROM stream_views v WHERE v.stream_id = s.id AND v.user_id = 0) guests,
      (SELECT AVG(COALESCE(v.left_at, s.ended_at, s.started_at) - v.joined_at) FROM stream_views v WHERE v.stream_id = s.id) avg_ms,
      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = s.user_id AND f.created_at BETWEEN s.started_at AND COALESCE(s.ended_at, s.started_at) + 1800000) new_followers
      FROM streams s WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 10`),
    uniqLogged: db.prepare('SELECT COUNT(DISTINCT v.user_id) c FROM stream_views v JOIN streams s ON s.id = v.stream_id WHERE s.user_id = ? AND v.user_id > 0'),
    guestSessions: db.prepare('SELECT COUNT(*) c FROM stream_views v JOIN streams s ON s.id = v.stream_id WHERE s.user_id = ? AND v.user_id = 0'),
    returning: db.prepare('SELECT COUNT(*) c FROM (SELECT v.user_id FROM stream_views v JOIN streams s ON s.id = v.stream_id WHERE s.user_id = ? AND v.user_id > 0 GROUP BY v.user_id HAVING COUNT(DISTINCT v.stream_id) >= 2)'),
    avgWatch: db.prepare('SELECT AVG(COALESCE(v.left_at, s.ended_at, s.started_at) - v.joined_at) a FROM stream_views v JOIN streams s ON s.id = v.stream_id WHERE s.user_id = ?'),
    chatTotal: db.prepare('SELECT COALESCE(SUM(chat_count), 0) c FROM streams WHERE user_id = ?'),
    followersDuring: db.prepare('SELECT COUNT(*) c FROM follows f WHERE f.followee_id = ? AND EXISTS (SELECT 1 FROM streams s WHERE s.user_id = f.followee_id AND f.created_at BETWEEN s.started_at AND COALESCE(s.ended_at, s.started_at) + 1800000)'),
    followTimes: db.prepare('SELECT created_at FROM follows WHERE followee_id = ? AND created_at > ?'),

    reactionsReceived: db.prepare(`SELECT COALESCE(SUM(c), 0) s FROM (SELECT MIN(20, COUNT(*)) c FROM post_reactions pr JOIN posts po ON po.id = pr.post_id JOIN users u ON u.id = pr.user_id
      WHERE po.user_id = ? AND pr.user_id <> ? AND u.created_at <= ? GROUP BY pr.post_id)`),
    commentsWritten: db.prepare('SELECT COUNT(*) c FROM comments c JOIN posts po ON po.id = c.post_id WHERE c.user_id = ? AND po.user_id <> c.user_id'),
    contribTotal: db.prepare('SELECT COALESCE(SUM(contribs), 0) c FROM circle_members WHERE user_id = ?'),
    answeredCount: db.prepare('SELECT COUNT(*) c FROM pin_answers WHERE user_id = ?'),
    streamsHosted: db.prepare('SELECT COUNT(*) c FROM streams WHERE user_id = ? AND peak_viewers >= 2'),

    searchUsers: db.prepare("SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR interests LIKE ? ESCAPE '\\' ORDER BY username LIMIT 12"),
    searchCircles: db.prepare("SELECT c.*, (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) members FROM circles c WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' LIMIT 12"),
    searchPosts: db.prepare("SELECT * FROM posts WHERE body LIKE ? ESCAPE '\\' AND repost_of = 0 ORDER BY id DESC LIMIT 12")
  };

  /* ---------------------------------------------------------------- helpers */
  const BADGES = {
    first_post: { emoji: '✍️', label: 'First post' }, regular: { emoji: '📝', label: 'Regular poster' },
    first_comment: { emoji: '💬', label: 'First comment' }, early_bird: { emoji: '🐦', label: 'Early Bird' },
    helper: { emoji: '🙋', label: 'Got a question answered' }, streamer: { emoji: '🎥', label: 'First stream' },
    circle_founder: { emoji: '🌟', label: 'Circle founder' }, circle_member: { emoji: '🤝', label: 'Circle member' }
  };
  const NOTIF_TYPES = ['follow', 'live', 'mention', 'comment', 'circle', 'event', 'answered', 'achievement'];
  const lastAct = new Map();
  const cooled = uid => { const n = Date.now(); if (n - (lastAct.get(uid) || 0) < getSetting('postCooldownMs')) return false; lastAct.set(uid, n); return true; };
  const postLimiter = limiter({ windowMs: 3600000, max: 120 });
  const like = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
  const asId = v => Number(v) || 0;
  const avOf = u => (u && (u.avatar_img || u.avatar)) || '';

  const authorOf = id => {
    const u = q.userById.get(id);
    return u ? { username: u.username, displayName: u.display_name || u.username, avatar: avOf(u), color: colorFor(u.username), verified: !!u.verified }
             : { username: 'deleted', displayName: 'Deleted user', avatar: '', color: '#888' };
  };
  const circleBrief = id => { const c = id ? p.circleById.get(id) : null; return c ? { slug: c.slug, name: c.name, emoji: c.emoji } : null; };
  const staffOf = (circleId, userId) => { const m = userId ? p.memberRow.get(circleId, userId) : null; return m && (m.role === 'owner' || m.role === 'mod') ? m : null; };

  function hydrate(row, viewerId, depth = 0) {
    const reactions = {};
    for (const r of p.reactionCounts.all(row.id)) reactions[r.emoji] = r.c;
    const mine = viewerId ? (p.myReaction.get(row.id, viewerId) || {}).emoji || '' : '';
    const orig = row.repost_of && depth === 0 ? p.postById.get(row.repost_of) : null;
    return {
      id: row.id, kind: row.kind, body: row.body, createdAt: row.created_at, author: authorOf(row.user_id), authorId: row.user_id,
      circle: circleBrief(row.circle_id), reactions, myReaction: mine,
      comments: p.commentCount.get(row.id).c, reposts: p.repostCount.get(row.id).c,
      isRepost: !!row.repost_of, original: orig ? hydrate(orig, viewerId, 1) : null,
      media: p.mediaOf.all(row.id).map(m => ({ id: m.id, kind: m.kind, url: '/media/' + m.id }))
    };
  }

  /* ---------------------------------------------------------- notifications */
  const inQuiet = u => {
    if (u.quiet_start < 0 || u.quiet_end < 0 || u.quiet_start === u.quiet_end) return false;
    const mins = (((Math.floor(Date.now() / 60000) + u.tz_offset) % 1440) + 1440) % 1440;
    const hr = Math.floor(mins / 60);
    return u.quiet_start < u.quiet_end ? hr >= u.quiet_start && hr < u.quiet_end : hr >= u.quiet_start || hr < u.quiet_end;
  };
  function notify(userId, type, text, link, fromId) {
    if (!userId || userId === fromId) return 0;
    const u = q.userById.get(userId);
    if (!u) return 0;
    let prefs = {};
    try { prefs = JSON.parse(u.notif_prefs || '{}'); } catch { /* defaults */ }
    if (fromId && isBlockedBy(userId, fromId)) return 0; // blocked people cannot reach you
    if (type !== 'system' && prefs[type] === false) return 0; // safety messages from staff always arrive
    if (p.dupNotif.get(userId, type, text, link || '', Date.now() - 60000)) return 0;
    const info = p.insertNotif.run(userId, type, text, link || '', Date.now());
    // quiet hours: still saved in the inbox, but no live pop-up
    if (!inQuiet(u)) io.to('u:' + userId).emit('notify', { id: Number(info.lastInsertRowid), type, text, link: link || '' });
    return Number(info.lastInsertRowid);
  }
  function award(userId, code) {
    const b = BADGES[code];
    if (!b) return;
    if (p.addBadge.run(userId, code, Date.now()).changes > 0) {
      const u = q.userById.get(userId);
      notify(userId, 'achievement', `Achievement unlocked: ${b.emoji} ${b.label}`, u ? '#/u/' + u.username : '', 0);
    }
  }
  function mentionedUsers(text) {
    const out = new Set();
    for (const m of String(text).matchAll(/@([a-zA-Z0-9_]{3,20})/g)) { out.add(m[1].toLowerCase()); if (out.size >= 5) break; }
    return [...out].map(n => q.userByName.get(n)).filter(Boolean);
  }
  function notifyMentions(text, from, link, where) {
    for (const u of mentionedUsers(text)) notify(u.id, 'mention', `${from.username} mentioned you ${where}`, link, from.id);
  }
  const unreadCount = userId => p.unread.get(userId).c;

  app.get('/api/notifications', need, (req, res) => {
    const u = req.user;
    let prefs = {};
    try { prefs = JSON.parse(u.notif_prefs || '{}'); } catch { /* defaults */ }
    res.json({
      notifications: p.notifsOf.all(u.id).map(n => ({ id: n.id, type: n.type, text: n.text, link: n.link, read: !!n.read, createdAt: n.created_at })),
      unread: unreadCount(u.id),
      prefs: Object.fromEntries(NOTIF_TYPES.map(t => [t, prefs[t] !== false])),
      quietStart: u.quiet_start, quietEnd: u.quiet_end, tzOffset: u.tz_offset
    });
  });
  app.post('/api/notifications/read', need, (req, res) => { p.readAll.run(req.user.id); res.json({ ok: true }); });
  app.put('/api/notifications/prefs', need, (req, res) => {
    const b = req.body || {}, u = req.user;
    let prefs = {};
    try { prefs = JSON.parse(u.notif_prefs || '{}'); } catch { /* defaults */ }
    for (const t of NOTIF_TYPES) if (b.prefs && typeof b.prefs[t] === 'boolean') prefs[t] = b.prefs[t];
    const hour = (v, keep) => { if (v === undefined) return keep; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : -1; };
    const tz = b.tzOffset === undefined ? u.tz_offset : Math.max(-840, Math.min(840, Math.round(Number(b.tzOffset) || 0)));
    p.setPrefs.run(JSON.stringify(prefs), hour(b.quietStart, u.quiet_start), hour(b.quietEnd, u.quiet_end), tz, u.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------ achievements */
  function appreciation(userId) {
    const cutoff = Date.now() - minAgeMs();
    const minAge = getSetting('minAccountAgeMin');
    const badges = p.badgesOf.all(userId);
    const parts = [
      { key: 'reactions', label: `Reactions on your posts from other people (max 20 per post${minAge > 0 ? `; accounts newer than ${minAge} min are ignored` : ''})`, points: Math.min(500, p.reactionsReceived.get(userId, userId, cutoff).s) },
      { key: 'comments', label: 'Comments on other people\'s posts (max 100)', points: Math.min(100, p.commentsWritten.get(userId).c) },
      { key: 'circles', label: 'Contributions in Circles (2 points each, max 50)', points: Math.min(50, p.contribTotal.get(userId).c) * 2 },
      { key: 'answers', label: 'Questions of yours the streamer answered (3 points each, max 30)', points: Math.min(30, p.answeredCount.get(userId).c) * 3 },
      { key: 'streams', label: 'Streams hosted with 2 or more viewers (2 points each, max 30)', points: Math.min(30, p.streamsHosted.get(userId).c) * 2 },
      { key: 'achievements', label: 'Achievements unlocked (5 points each)', points: badges.length * 5 }
    ];
    const score = parts.reduce((a, x) => a + x.points, 0);
    return { score, level: Math.floor(Math.sqrt(score / 4)) + 1, parts, minAccountAgeMin: minAge };
  }
  const profileExtras = userId => ({
    appreciation: appreciation(userId),
    badges: p.badgesOf.all(userId).filter(b => BADGES[b.code]).map(b => ({ code: b.code, ...BADGES[b.code], earnedAt: b.earned_at }))
  });

  /* ------------------------------------------------------------ post media (pictures and short videos) */
  // Files are checked by their first bytes, not by what the browser claims. SVG and anything else that can run code is refused.
  const MAX_MEDIA = 4, MAX_PENDING = 8, IMG_MAX = 6 * 1024 * 1024, VIDEO_MAX = 20 * 1024 * 1024;
  const sniffMedia = b => {
    if (!Buffer.isBuffer(b) || b.length < 16) return null;
    const at = (o, n) => b.toString('latin1', o, o + n);
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { kind: 'image', mime: 'image/jpeg' };
    if (b[0] === 0x89 && at(1, 3) === 'PNG') return { kind: 'image', mime: 'image/png' };
    if (at(0, 4) === 'RIFF' && at(8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
    if (at(0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
    if (at(4, 4) === 'ftyp') return { kind: 'video', mime: 'video/mp4' };
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { kind: 'video', mime: 'video/webm' };
    return null;
  };
  const mediaLimiter = limiter({ windowMs: 10 * 60000, max: 40 });
  app.post('/api/media', need, mediaLimiter, express.raw({ type: () => true, limit: VIDEO_MAX + 1024 }), (req, res) => {
    const buf = req.body;
    const info = sniffMedia(buf);
    if (!info) return res.status(400).json({ error: 'That file type is not supported. Use a JPEG, PNG, WebP or GIF picture, or an MP4 or WebM video.' });
    if (info.kind === 'image' && buf.length > IMG_MAX) return res.status(413).json({ error: 'That picture is larger than 6 MB. Please choose a smaller one.' });
    if (info.kind === 'video' && buf.length > VIDEO_MAX) return res.status(413).json({ error: 'That video is larger than 20 MB. Please trim it or choose a shorter clip.' });
    if (p.mediaPending.get(req.user.id).c >= MAX_PENDING) return res.status(429).json({ error: 'You have several files waiting to be posted. Post or remove them first.' });
    const r = p.insertMedia.run(req.user.id, info.kind, info.mime, buf, Date.now());
    const id = Number(r.lastInsertRowid);
    res.json({ id, kind: info.kind });
  });
  // files that were uploaded but never attached to a post are removed after an hour
  const sweepMedia = () => { try { db.prepare('DELETE FROM post_media WHERE post_id = 0 AND created_at < ?').run(Date.now() - 3600000); } catch { /* best effort */ } };
  setInterval(sweepMedia, 30 * 60000).unref();
  app.get('/media/:id', (req, res) => {
    const head = /^\d+$/.test(req.params.id) ? p.mediaHead.get(Number(req.params.id)) : null;
    if (!head || !head.post_id) return res.status(404).end();   // pending uploads are private
    const size = Number(head.size);
    res.set({ 'Content-Type': head.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline' });
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      const row = p.mediaSlice.get(start + 1, end - start + 1, head.id);
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
      return res.end(Buffer.from(row.chunk));
    }
    const row = p.mediaSlice.get(1, size, head.id);
    res.set('Content-Length', String(size));
    res.end(Buffer.from(row.chunk));
  });

  /* ------------------------------------------------------------------- feed */
  app.get('/api/feed', auth, (req, res) => {
    const me = req.user ? req.user.id : 0;
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const limit = 30;
    let rows;
    if (req.query.user) {
      const u = q.userByName.get(String(req.query.user));
      if (!u) return res.status(404).json({ error: 'Profile not found.' });
      rows = p.feedUser.all(u.id, before, limit);
    } else if (req.query.circle) {
      const c = p.circleBySlug.get(String(req.query.circle));
      if (!c) return res.status(404).json({ error: 'Circle not found.' });
      rows = p.feedCircle.all(c.id, before, me, limit);
    } else if (req.query.scope === 'following' && me) rows = p.feedFollowing.all(before, me, me, me, me, limit);
    else rows = p.feedAll.all(before, me, limit);
    res.json({ posts: rows.map(r => hydrate(r, me)), next: rows.length === limit ? rows[rows.length - 1].id : null });
  });

  app.get('/api/posts/:id', auth, (req, res) => {
    const row = p.postById.get(asId(req.params.id));
    if (!row) return res.status(404).json({ error: 'That post was removed or never existed.' });
    res.json({ post: hydrate(row, req.user ? req.user.id : 0) });
  });

  app.post('/api/posts', need, postLimiter, (req, res) => {
    const u = req.user, b = req.body || {};
    const body = filterText(cleanText(b.body, 500));
    const wanted = Array.isArray(b.media) ? [...new Set(b.media.map(asId).filter(Boolean))] : [];
    if (wanted.length > MAX_MEDIA) return res.status(400).json({ error: `You can attach up to ${MAX_MEDIA} pictures to one post.` });
    const files = wanted.map(id => p.mediaMeta.get(id));
    if (files.some(m => !m || m.user_id !== u.id || m.post_id !== 0)) return res.status(400).json({ error: 'One of the attachments is no longer available. Please add it again.' });
    const videos = files.filter(m => m.kind === 'video').length;
    if (videos > 1 || (videos && files.length > 1)) return res.status(400).json({ error: 'A post can hold one video, or up to 4 pictures, but not both.' });
    if (!body && !files.length) return res.status(400).json({ error: 'Write something or add a picture first.' });
    let kind = ['update', 'question', 'announcement'].includes(b.kind) ? b.kind : 'update';
    let circle = null;
    if (b.circle) {
      circle = p.circleBySlug.get(String(b.circle));
      if (!circle) return res.status(404).json({ error: 'Circle not found.' });
      if (!p.memberRow.get(circle.id, u.id)) return res.status(403).json({ error: 'Join this Circle to post in it.' });
    }
    if (kind === 'announcement' && !(circle && staffOf(circle.id, u.id))) {
      return res.status(403).json({ error: 'Only the Circle owner or moderators can post announcements.' });
    }
    if (!cooled(u.id)) return res.status(429).json({ error: 'Please wait a few seconds between posts.' });
    const info = p.insertPost.run(u.id, circle ? circle.id : 0, kind, body, 0, Date.now());
    const id = Number(info.lastInsertRowid);
    for (const m of files) p.attachMedia.run(id, m.id, u.id);
    if (circle) contribution(circle, u);
    award(u.id, 'first_post');
    if (p.ownPostCount.get(u.id).c >= 5) award(u.id, 'regular');
    notifyMentions(body, u, '#/post/' + id, 'in a post');
    if (kind === 'announcement') {
      for (const m of p.memberIds.all(circle.id)) notify(m.user_id, 'circle', `${circle.name}: ${body.slice(0, 80)}`, '#/circle/' + circle.slug, u.id);
    }
    res.json({ post: hydrate(p.postById.get(id), u.id) });
  });

  app.delete('/api/posts/:id', need, (req, res) => {
    const row = p.postById.get(asId(req.params.id));
    if (!row) return res.json({ ok: true });
    const own = row.user_id === req.user.id;
    if (!own && !(row.circle_id && staffOf(row.circle_id, req.user.id))) return res.status(403).json({ error: 'You can only delete your own posts.' });
    p.delPostReacts.run(row.id); p.delPostComments.run(row.id); p.delPostMedia.run(row.id); p.delPost.run(row.id);
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/react', need, (req, res) => {
    const row = p.postById.get(asId(req.params.id));
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    if (isBlockedBy(row.user_id, req.user.id)) return res.status(403).json({ error: 'You cannot interact with this account.' });
    const emoji = String((req.body || {}).emoji || '');
    if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction.' });
    const cur = p.myReaction.get(row.id, req.user.id);
    if (cur && cur.emoji === emoji) p.delReaction.run(row.id, req.user.id);
    else p.upsertReaction.run(row.id, req.user.id, emoji, Date.now());
    const reactions = {};
    for (const r of p.reactionCounts.all(row.id)) reactions[r.emoji] = r.c;
    res.json({ reactions, myReaction: (p.myReaction.get(row.id, req.user.id) || {}).emoji || '' });
  });

  app.get('/api/posts/:id/comments', auth, (req, res) => {
    const row = p.postById.get(asId(req.params.id));
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    const blocked = new Set(req.user ? db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(req.user.id).map(r => r.blocked_id) : []);
    res.json({
      comments: p.commentsOf.all(row.id).filter(c => !blocked.has(c.user_id)).map(c => {
        const parent = c.reply_to ? p.commentById.get(c.reply_to) : null;
        return { id: c.id, body: c.body, createdAt: c.created_at, author: authorOf(c.user_id), authorId: c.user_id, replyTo: parent ? { id: parent.id, username: authorOf(parent.user_id).username } : null };
      })
    });
  });

  app.post('/api/posts/:id/comments', need, postLimiter, (req, res) => {
    const row = p.postById.get(asId(req.params.id));
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    if (isBlockedBy(row.user_id, req.user.id)) return res.status(403).json({ error: 'You cannot interact with this account.' });
    const u = req.user, b = req.body || {};
    const body = filterText(cleanText(b.body, 300));
    if (!body) return res.status(400).json({ error: 'Write a comment first.' });
    const parent = b.replyTo ? p.commentById.get(asId(b.replyTo)) : null;
    if (b.replyTo && (!parent || parent.post_id !== row.id)) return res.status(400).json({ error: 'That comment is gone.' });
    if (!cooled(u.id)) return res.status(429).json({ error: 'Please wait a few seconds between comments.' });
    const info = p.insertComment.run(row.id, u.id, parent ? parent.id : 0, body, Date.now());
    const circle = row.circle_id ? p.circleById.get(row.circle_id) : null;
    if (circle && p.memberRow.get(circle.id, u.id)) contribution(circle, u);
    award(u.id, 'first_comment');
    notify(row.user_id, 'comment', `${u.username} commented on your post`, '#/post/' + row.id, u.id);
    if (parent) notify(parent.user_id, 'comment', `${u.username} replied to your comment`, '#/post/' + row.id, u.id);
    notifyMentions(body, u, '#/post/' + row.id, 'in a comment');
    res.json({ id: Number(info.lastInsertRowid) });
  });

  app.post('/api/posts/:id/repost', need, postLimiter, (req, res) => {
    let orig = p.postById.get(asId(req.params.id));
    if (orig && orig.repost_of) orig = p.postById.get(orig.repost_of);
    if (!orig) return res.status(404).json({ error: 'Post not found.' });
    if (isBlockedBy(orig.user_id, req.user.id)) return res.status(403).json({ error: 'You cannot interact with this account.' });
    if (orig.circle_id) return res.status(400).json({ error: 'Posts inside a Circle stay inside it.' });
    if (orig.user_id === req.user.id) return res.status(400).json({ error: 'You cannot repost your own post.' });
    if (p.hasRepost.get(req.user.id, orig.id)) return res.status(409).json({ error: 'You already reposted this.' });
    if (!cooled(req.user.id)) return res.status(429).json({ error: 'Please wait a few seconds.' });
    const body = filterText(cleanText((req.body || {}).body, 280));
    const info = p.insertPost.run(req.user.id, 0, 'repost', body, orig.id, Date.now());
    notify(orig.user_id, 'comment', `${req.user.username} reposted your post`, '#/post/' + orig.id, req.user.id);
    res.json({ post: hydrate(p.postById.get(Number(info.lastInsertRowid)), req.user.id) });
  });

  /* ---------------------------------------------------------------- circles */
  function contribution(circle, user) {
    p.bump.run(circle.id, user.id);
    const m = p.memberRow.get(circle.id, user.id);
    const names = { 1: 'First contribution', 5: 'Regular', 20: 'Trusted member' };
    if (names[m.contribs]) notify(user.id, 'achievement', `You earned "${names[m.contribs]}" in ${circle.name}`, '#/circle/' + circle.slug, 0);
  }
  function circleBadges(m, rank) {
    const b = [];
    if (m.role === 'owner') b.push({ emoji: '🌟', label: 'Founder' });
    if (m.role === 'mod') b.push({ emoji: '🛡️', label: 'Moderator' });
    if (rank <= 10) b.push({ emoji: '🏛️', label: 'Founding member' });
    if (m.contribs >= 1) b.push({ emoji: '🌱', label: 'First contribution' });
    if (m.contribs >= 5) b.push({ emoji: '🔥', label: 'Regular' });
    if (m.contribs >= 20 || m.role === 'mod') b.push({ emoji: '🤝', label: 'Trusted member' });
    return b;
  }
  const isLive = username => { const r = rooms.get(String(username).toLowerCase()); return !!(r && r.live); };
  const circleSummary = (c, members, me) => ({
    slug: c.slug, name: c.name, description: c.description, emoji: c.emoji, members, createdAt: c.created_at,
    owner: { ...authorOf(c.owner_id), live: isLive(authorOf(c.owner_id).username) },
    joined: me ? !!p.memberRow.get(c.id, me) : false
  });

  app.get('/api/circles', auth, (req, res) => {
    const me = req.user ? req.user.id : 0;
    let list = p.allCircles.all().map(c => circleSummary(c, c.members, me));
    if (req.query.mine && me) list = list.filter(c => c.joined);
    if (req.query.sort === 'popular') list.sort((a, b) => b.members - a.members);
    res.json({ circles: list });
  });

  app.post('/api/circles', need, (req, res) => {
    const u = req.user, b = req.body || {};
    const name = filterText(cleanText(b.name, 40));
    if (name.length < 3) return res.status(400).json({ error: 'Give your Circle a name (at least 3 characters).' });
    const slug = String(b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (slug.length < 3) return res.status(400).json({ error: 'The web address needs at least 3 letters or numbers.' });
    if (p.circleBySlug.get(slug)) return res.status(409).json({ error: 'That Circle address is taken.' });
    if (p.circlesByOwner.get(u.id).c >= 3) return res.status(400).json({ error: 'You can own up to 3 Circles.' });
    const target = Math.max(0, Math.min(100000, Math.round(Number(b.goalTarget) || 0)));
    p.insertCircle.run(slug, name, filterText(cleanText(b.description, 300)), Array.from(cleanText(b.emoji, 12) || '🌐').slice(0, 4).join(''),
      u.id, filterText(cleanText(b.goalTitle, 60)), target, Date.now());
    const c = p.circleBySlug.get(slug);
    p.addMember.run(c.id, u.id, 'owner', Date.now());
    award(u.id, 'circle_founder');
    res.json({ slug });
  });

  app.get('/api/circles/:slug', auth, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    const me = req.user ? req.user.id : 0;
    const count = p.memberCount.get(c.id).c;
    const mine = me ? p.memberRow.get(c.id, me) : null;
    const members = p.members.all(c.id).map((m, i) => ({
      username: m.username, displayName: m.display_name || m.username, avatar: m.avatar_img || m.avatar, color: colorFor(m.username),
      role: m.role, contribs: m.contribs, joinedAt: m.joined_at, badges: circleBadges(m, i + 1)
    }));
    const milestones = [{ label: 'Circle created', at: c.created_at }];
    for (const n of [10, 25, 50, 100, 250, 500]) {
      if (count >= n) { const r = p.nthJoin.get(c.id, n - 1); if (r) milestones.push({ label: `Reached ${n} members`, at: r.joined_at }); }
    }
    const goalDone = c.goal_target > 0 && count >= c.goal_target;
    if (goalDone) { const r = p.nthJoin.get(c.id, c.goal_target - 1); if (r) milestones.push({ label: `Goal reached: ${c.goal_title || c.goal_target + ' members'}`, at: r.joined_at }); }
    milestones.sort((a, b) => b.at - a.at);
    res.json({
      ...circleSummary(c, count, me), isMember: !!mine, role: mine ? mine.role : '', members, milestones,
      goal: c.goal_target ? { title: c.goal_title || `Reach ${c.goal_target} members`, target: c.goal_target, progress: count, done: goalDone } : null,
      events: p.eventsOf.all(c.id, Date.now()).map(e => ({
        id: e.id, title: e.title, description: e.description, startsAt: e.starts_at,
        rsvps: p.rsvpCount.get(e.id).c, going: me ? !!p.myRsvp.get(e.id, me) : false
      }))
    });
  });

  app.put('/api/circles/:slug', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can edit this Circle.' });
    const b = req.body || {};
    p.updateCircle.run(
      b.description === undefined ? c.description : filterText(cleanText(b.description, 300)),
      b.goalTitle === undefined ? c.goal_title : filterText(cleanText(b.goalTitle, 60)),
      b.goalTarget === undefined ? c.goal_target : Math.max(0, Math.min(100000, Math.round(Number(b.goalTarget) || 0))), c.id);
    res.json({ ok: true });
  });

  app.post('/api/circles/:slug/join', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    if (p.isBanned.get(c.id, req.user.id)) return res.status(403).json({ error: 'You cannot join this Circle.' });
    if (p.addMember.run(c.id, req.user.id, 'member', Date.now()).changes > 0) {
      award(req.user.id, 'circle_member');
      notify(c.owner_id, 'circle', `${req.user.username} joined ${c.name}. Say hello!`, '#/circle/' + c.slug, req.user.id);
    }
    res.json({ ok: true });
  });
  app.post('/api/circles/:slug/leave', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    if (c.owner_id === req.user.id) return res.status(400).json({ error: 'Owners cannot leave their own Circle.' });
    p.delMember.run(c.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/circles/:slug/role', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can change roles.' });
    const t = q.userByName.get(String((req.body || {}).username || ''));
    const m = t ? p.memberRow.get(c.id, t.id) : null;
    if (!m || m.role === 'owner') return res.status(400).json({ error: 'Pick a member of this Circle.' });
    const role = (req.body || {}).role === 'mod' ? 'mod' : 'member';
    p.setRole.run(role, c.id, t.id);
    if (role === 'mod') notify(t.id, 'circle', `You are now a moderator of ${c.name}`, '#/circle/' + c.slug, req.user.id);
    res.json({ ok: true });
  });

  // owner or Circle moderators can remove (and optionally ban) a disruptive member
  app.post('/api/circles/:slug/members/:username/remove', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    const me = staffOf(c.id, req.user.id);
    if (!me) return res.status(403).json({ error: 'Only the owner or moderators can remove members.' });
    const t = q.userByName.get(req.params.username);
    const m = t ? p.memberRow.get(c.id, t.id) : null;
    if (!m) return res.status(404).json({ error: 'That person is not in this Circle.' });
    if (m.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed.' });
    if (m.role === 'mod' && me.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove moderators.' });
    p.delMember.run(c.id, t.id);
    const ban = !!(req.body || {}).ban;
    if (ban) p.addBan.run(c.id, t.id);
    notify(t.id, 'circle', `You were ${ban ? 'banned from' : 'removed from'} ${c.name}.`, '#/circles', req.user.id);
    res.json({ ok: true, banned: ban });
  });

  app.post('/api/circles/:slug/events', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    if (!staffOf(c.id, req.user.id)) return res.status(403).json({ error: 'Only the owner or moderators can schedule events.' });
    const b = req.body || {};
    const title = filterText(cleanText(b.title, 80));
    const at = Number(b.startsAt);
    if (!title) return res.status(400).json({ error: 'Give the event a title.' });
    if (!Number.isFinite(at) || at < Date.now() || at > Date.now() + 366 * DAY) return res.status(400).json({ error: 'Pick a start time in the future (within a year).' });
    const info = p.insertEvent.run(c.id, title, filterText(cleanText(b.description, 300)), at, req.user.id, Date.now());
    for (const m of p.memberIds.all(c.id)) notify(m.user_id, 'event', `${c.name}: new event "${title}"`, '#/circle/' + c.slug, req.user.id);
    res.json({ id: Number(info.lastInsertRowid) });
  });
  app.post('/api/circles/:slug/events/:id/rsvp', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    const e = p.eventById.get(asId(req.params.id));
    if (!c || !e || e.circle_id !== c.id) return res.status(404).json({ error: 'Event not found.' });
    if (!p.memberRow.get(c.id, req.user.id)) return res.status(403).json({ error: 'Join the Circle to RSVP.' });
    const going = !!p.myRsvp.get(e.id, req.user.id);
    if (going) p.delRsvp.run(e.id, req.user.id); else p.addRsvp.run(e.id, req.user.id);
    res.json({ going: !going, rsvps: p.rsvpCount.get(e.id).c });
  });
  app.delete('/api/circles/:slug/events/:id', need, (req, res) => {
    const c = p.circleBySlug.get(req.params.slug);
    const e = p.eventById.get(asId(req.params.id));
    if (!c || !e || e.circle_id !== c.id) return res.json({ ok: true });
    if (!staffOf(c.id, req.user.id)) return res.status(403).json({ error: 'Only the owner or moderators can remove events.' });
    p.delEvent.run(e.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------- search and discovery */
  const liveStreams = () => {
    const out = [];
    for (const r of rooms.values()) {
      if (!r.live) continue;
      const o = q.userById.get(r.ownerId);
      out.push({
        username: r.channel, color: colorFor(r.channel), avatar: avOf(o), title: r.title, category: r.category, tags: r.tags,
        viewers: r.viewers.size, startedAt: r.startedAt, ownerId: r.ownerId, description: r.description
      });
    }
    return out;
  };
  const stripStream = s => { const { ownerId, ...rest } = s; return rest; };

  app.get('/api/search', auth, (req, res) => {
    const term = cleanText(req.query.q, 60);
    const type = String(req.query.type || 'all');
    const category = String(req.query.category || '');
    const liveOnly = req.query.live === '1';
    if (term.length < 2 && !category && !liveOnly) return res.json({ users: [], streams: [], circles: [], posts: [], hint: 'Type at least 2 letters, or pick a filter.' });
    const want = t => type === 'all' || type === t;
    const needle = term.toLowerCase();
    const out = { users: [], streams: [], circles: [], posts: [] };
    if (want('streams')) {
      out.streams = liveStreams().filter(s =>
        (!category || s.category === category) &&
        (!needle || `${s.title} ${s.username} ${s.category} ${s.tags.join(' ')} ${s.description}`.toLowerCase().includes(needle))
      ).map(stripStream).slice(0, 12);
    }
    if (want('users') && term.length >= 2) {
      const L = like(term);
      out.users = p.searchUsers.all(L, L, L).filter(u => !isTeen(u) || u.username.toLowerCase() === needle).filter(u => !liveOnly || isLive(u.username)).map(u => ({
        username: u.username, displayName: u.display_name || u.username, avatar: avOf(u), color: colorFor(u.username),
        bio: isTeen(u) ? '' : u.bio, interests: isTeen(u) ? [] : splitList(u.interests), live: isLive(u.username), followers: q.followCount.get(u.id).c
      }));
    }
    if (want('circles') && term.length >= 2 && !liveOnly) {
      const L = like(term);
      out.circles = p.searchCircles.all(L, L, L).map(c => circleSummary(c, c.members, req.user ? req.user.id : 0));
    }
    if (want('posts') && term.length >= 2 && !liveOnly && !category) {
      out.posts = p.searchPosts.all(like(term)).filter(r => !r.circle_id).map(r => hydrate(r, req.user ? req.user.id : 0));
    }
    res.json(out);
  });

  // Search-as-you-type: a few relevant profiles while the person is still typing (like Facebook's search box).
  // Best matches first: exact name, name starts with the text, a word starts with it, then "contains".
  // People you follow and people who are live float up inside the same match quality.
  // Same privacy rules as full search: teens only appear on an exact username, blocked and banned people never appear.
  const suggestUsers = db.prepare("SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' ORDER BY username LIMIT 60");
  const suggestLimit = limiter({ windowMs: 60000, max: 120 });
  app.get('/api/suggest', need, suggestLimit, (req, res) => {
    const term = cleanText(req.query.q, 40).replace(/^@/, '');
    if (term.length < 2) return res.json({ users: [], circles: [], streams: [] });
    const needle = term.toLowerCase();
    const me = req.user.id;
    const blocked = new Set(q.blocksOf.all(me).map(b => b.id));
    const rank = u => {
      const un = u.username.toLowerCase(), dn = (u.display_name || '').toLowerCase();
      if (un === needle) return 0;
      if (un.startsWith(needle)) return 1;
      if (dn.startsWith(needle)) return 2;
      if (dn.split(/[\s._-]+/).some(w => w.startsWith(needle))) return 3;
      return 4;
    };
    const L = like(term);
    const users = suggestUsers.all(L, L)
      .filter(u => u.id !== me && u.status !== 'banned' && !blocked.has(u.id) && (!isTeen(u) || u.username.toLowerCase() === needle))
      .map(u => ({ u, r: rank(u), following: !!q.isFollowing.get(me, u.id), live: isLive(u.username), followers: q.followCount.get(u.id).c }))
      .sort((a, b) => a.r - b.r || (b.following - a.following) || (b.live - a.live) || b.followers - a.followers || a.u.username.localeCompare(b.u.username))
      .slice(0, 6)
      .map(({ u, following, live, followers }) => ({
        username: u.username, displayName: u.display_name || u.username, avatar: avOf(u), color: colorFor(u.username),
        verified: !!u.verified, live, following, followers
      }));
    // Circles and live streams that match, so the box suggests more than people
    const starts = (txt) => String(txt).toLowerCase().startsWith(needle) ? 0 : 1;
    const circles = p.searchCircles.all(L, L, L)
      .filter(c => `${c.name} ${c.slug}`.toLowerCase().includes(needle))
      .sort((a, b) => starts(a.name) - starts(b.name) || b.members - a.members)
      .slice(0, 3).map(c => ({ slug: c.slug, name: c.name, emoji: c.emoji, members: c.members }));
    const streams = liveStreams()
      .filter(s => `${s.title} ${s.username} ${s.category} ${s.tags.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => starts(a.title) - starts(b.title) || b.viewers - a.viewers)
      .slice(0, 3).map(s => ({ username: s.username, title: s.title, category: s.category, viewers: s.viewers, color: s.color, avatar: s.avatar }));
    res.json({ users, circles, streams });
  });

  // Fair discovery: interests, history and follows raise a stream, but a small-channel boost
  // and a dedicated "Rising" row make sure new creators are seen, not only the biggest ones.
  app.get('/api/discover', auth, (req, res) => {
    const me = req.user;
    const live = liveStreams().filter(s => !me || s.ownerId !== me.id);
    const interests = new Set(me ? splitList(me.interests).map(s => s.toLowerCase()) : []);
    const cats = new Set(me ? p.historyCats.all(me.id).map(r => r.category) : []);
    const following = new Set(me ? p.followeeIds.all(me.id).map(r => r.followee_id) : []);
    const scored = live.map(s => {
      const hay = `${s.title} ${s.tags.join(' ')} ${s.category}`.toLowerCase();
      let score = 2 / (1 + Math.sqrt(s.viewers));
      for (const i of interests) if (hay.includes(i)) score += 3;
      if (cats.has(s.category)) score += 1.5;
      if (following.has(s.ownerId)) score += 2;
      return { ...s, score };
    }).sort((a, b) => b.score - a.score || b.startedAt - a.startedAt);
    const rising = live.filter(s => s.viewers <= 5).sort((a, b) => a.viewers - b.viewers || b.startedAt - a.startedAt).slice(0, 8);
    const all = p.allCircles.all().map(c => circleSummary(c, c.members, me ? me.id : 0)).filter(c => !c.joined);
    const popular = [...all].sort((a, b) => b.members - a.members).slice(0, 4);
    const fresh = [...all].sort((a, b) => b.createdAt - a.createdAt).filter(c => !popular.includes(c)).slice(0, 4);
    res.json({ recommended: scored.slice(0, 8).map(({ score, ...s }) => stripStream(s)), rising: rising.map(stripStream), circles: [...popular, ...fresh] });
  });

  /* -------------------------------------------------------------- analytics */
  function analytics(userId) {
    const per = p.streamAnalytics.all(userId).reverse().map(r => {
      const dur = Math.max(60000, (r.ended_at || r.started_at) - r.started_at);
      const avg = Math.max(0, r.avg_ms || 0);
      return {
        id: r.id, title: r.title, startedAt: r.started_at, minutes: Math.round(dur / 60000), peak: r.peak_viewers,
        unique: r.uniq_users + r.guests, avgWatchMin: Math.round(avg / 6000) / 10, retention: Math.min(100, Math.round((avg / dur) * 100)),
        chat: r.chat_count, newFollowers: r.new_followers
      };
    });
    const logged = p.uniqLogged.get(userId).c, guests = p.guestSessions.get(userId).c, unique = logged + guests;
    const gained = p.followersDuring.get(userId).c;
    const buckets = new Array(14).fill(0), now = Date.now();
    for (const f of p.followTimes.all(userId, now - 14 * DAY)) {
      const d = Math.min(13, Math.floor((now - f.created_at) / DAY));
      buckets[13 - d]++;
    }
    return {
      uniqueViewers: unique, returningViewers: p.returning.get(userId).c,
      avgWatchMin: Math.round(Math.max(0, p.avgWatch.get(userId).a || 0) / 6000) / 10,
      chatMessages: p.chatTotal.get(userId).c, followersFromStreams: gained,
      followerConversion: unique ? Math.round((gained / unique) * 1000) / 10 : 0,
      followerGrowth: buckets, perStream: per
    };
  }

  /* ------------------------------------------------------ event reminders */
  // members who RSVP'd (and the organiser) get a reminder when an event is less than an hour away
  function runReminders() {
    const now = Date.now();
    for (const e of p.dueEvents.all(now + 3600000, now)) {
      const c = p.circleById.get(e.circle_id);
      if (c) {
        const mins = Math.max(1, Math.round((e.starts_at - now) / 60000));
        for (const uid of new Set([e.created_by, ...p.rsvpUsers.all(e.id).map(r => r.user_id)])) {
          notify(uid, 'event', `Starting in ${mins} min: "${e.title}" (${c.name})`, '#/circle/' + c.slug, 0);
        }
      }
      p.markReminded.run(e.id);
    }
  }
  const jobTimer = setInterval(() => { try { runReminders(); } catch (err) { console.error(err); } }, Number(process.env.JOB_INTERVAL_MS) || 60000);
  jobTimer.unref();

  /* -------------------------------------------------------- realtime hooks */
  return {
    unreadCount, profileExtras, analytics, notify, award, notifyMentions, mentionedUsers,
    userConnected(socket) { if (socket.user) socket.join('u:' + socket.user.id); },
    streamStarted(room, user) {
      award(user.id, 'streamer');
      for (const f of p.followerIds.all(user.id)) notify(f.follower_id, 'live', `${user.username} is live: ${room.title}`, '#/c/' + user.username, user.id);
      for (const v of room.viewers.values()) this.viewerJoined(room, v);
    },
    viewerJoined(room, entry) {
      if (!room.live || !room.streamId) return;
      entry.viewId = Number(p.insertView.run(room.streamId, entry.user ? entry.user.id : 0, Date.now()).lastInsertRowid);
      if (entry.user) p.addHistory.run(entry.user.id, room.ownerId, room.category, Date.now());
    },
    viewerLeft(entry) { if (entry && entry.viewId) { p.closeView.run(Date.now(), entry.viewId); entry.viewId = 0; } },
    streamEnded(room) {
      const now = Date.now();
      for (const v of room.viewers.values()) if (v.viewId) { p.closeView.run(now, v.viewId); v.viewId = 0; }
      if (room.streamId) p.setChatCount.run(room.chatCount || 0, room.streamId);
    },
    earlyBird(userId) { award(userId, 'early_bird'); },
    pinAnswered(room, pin) {
      p.insertPinAnswer.run(pin.userId, room.ownerId, Date.now());
      award(pin.userId, 'helper');
      notify(pin.userId, 'answered', `${room.channel} answered your pinned question`, '#/c/' + room.channel, room.ownerId);
    },
    chatMention(room, user, text, replyToUserId) {
      notifyMentions(text, user, '#/c/' + room.channel, `in ${room.channel}'s chat`);
      if (replyToUserId) notify(replyToUserId, 'mention', `${user.username} replied to you in ${room.channel}'s chat`, '#/c/' + room.channel, user.id);
    }
  };
};
