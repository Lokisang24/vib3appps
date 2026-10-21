'use strict';
/**
 * NovaStream admin and account-safety module.
 *  - reports that reach admins, with actions, and an audit trail
 *  - account management: warn, suspend, ban, verify, roles, recovery codes, deletion
 *  - appeals, live-stream takedown, content removal
 *  - site settings (registration, maintenance, announcement, limits), word filter, legal pages
 *  - backups, monitoring, and the self-service account endpoints (password, sessions, export, delete)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

module.exports = function mountAdmin(ctx) {
  const { app, io, db, q, need, rooms, limiter, endStream, social, cleanText, splitList, colorFor, publicUser, isTeen, signToken,
    getSetting, putSetting, SETTING_DEFAULTS, setGlobalWords, restrictionOf, DB_PATH, IS_PROD, EPHEMERAL_SECRET, hasTurn, envBlockedCount, replay } = ctx;
  const now = () => Date.now();
  const num = v => Number(v) || 0;
  const like = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
  const page = req => Math.max(1, Math.floor(num(req.query.page)) || 1);
  const PAGE = 25;

  /* ------------------------------------------------------------ plumbing */
  const audit = (admin, action, target, detail) =>
    db.prepare('INSERT INTO audit_log (admin_id, action, target, detail, created_at) VALUES (?,?,?,?,?)').run(admin.id, action, String(target || ''), String(detail || '').slice(0, 500), now());
  function logError(message, place) {
    try {
      db.prepare('INSERT INTO error_log (message, place, created_at) VALUES (?,?,?)').run(cleanText(message || 'unknown error', 300), place || '', now());
      db.exec('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)');
    } catch { /* logging must never crash the app */ }
  }
  const modAction = (userId, adminId, action, reason) =>
    db.prepare('INSERT INTO mod_actions (user_id, admin_id, action, reason, created_at) VALUES (?,?,?,?,?)').run(userId, adminId, action, cleanText(reason, 300), now());
  const kick = userId => io.in('u:' + userId).disconnectSockets(true);
  const adminOnly = [need, (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'This area is for NovaStream admins only.' }))];
  const sensitive = limiter({ windowMs: 15 * 60000, max: Number(process.env.SENSITIVE_LIMIT) || 20 });
  const reportLimiter = limiter({ windowMs: 3600000, max: 30 });
  const effectiveStatus = u => { const r = restrictionOf(u); return r ? (r.banned ? 'banned' : 'suspended') : 'active'; };

  /* ------------------------------------------------- deleting things safely */
  function deletePost(id) {
    db.prepare('DELETE FROM post_reactions WHERE post_id = ?').run(id);
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(id);
    db.prepare('DELETE FROM post_media WHERE post_id = ?').run(id);
    db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }
  function deleteCircle(id) {
    for (const p of db.prepare('SELECT id FROM posts WHERE circle_id = ?').all(id)) deletePost(p.id);
    for (const e of db.prepare('SELECT id FROM circle_events WHERE circle_id = ?').all(id)) db.prepare('DELETE FROM event_rsvps WHERE event_id = ?').run(e.id);
    db.prepare('DELETE FROM circle_events WHERE circle_id = ?').run(id);
    db.prepare('DELETE FROM circle_members WHERE circle_id = ?').run(id);
    db.prepare('DELETE FROM circle_bans WHERE circle_id = ?').run(id);
    db.prepare('DELETE FROM circles WHERE id = ?').run(id);
  }
  function deleteUser(id) {
    const u = q.userById.get(id);
    if (!u) return;
    const room = rooms.get(u.username.toLowerCase());
    if (room && room.live) endStream(room);
    for (const c of db.prepare('SELECT * FROM circles WHERE owner_id = ?').all(id)) {
      const heir = db.prepare("SELECT user_id FROM circle_members WHERE circle_id = ? AND user_id <> ? ORDER BY CASE role WHEN 'mod' THEN 0 ELSE 1 END, joined_at LIMIT 1").get(c.id, id);
      if (heir) {
        db.prepare('UPDATE circles SET owner_id = ? WHERE id = ?').run(heir.user_id, c.id);
        db.prepare("UPDATE circle_members SET role = 'owner' WHERE circle_id = ? AND user_id = ?").run(c.id, heir.user_id);
      } else deleteCircle(c.id);
    }
    replay.wipeUser(id); // saved chat replays: their messages, and the replays of their own streams
    for (const p of db.prepare('SELECT id FROM posts WHERE user_id = ?').all(id)) deletePost(p.id);
    for (const s of db.prepare('SELECT id FROM streams WHERE user_id = ?').all(id)) db.prepare('DELETE FROM stream_views WHERE stream_id = ?').run(s.id);
    const wipe = [
      'DELETE FROM streams WHERE user_id = ?', 'DELETE FROM comments WHERE user_id = ?', 'DELETE FROM post_reactions WHERE user_id = ?',
      'DELETE FROM follows WHERE follower_id = ? OR followee_id = ?', 'DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?',
      'DELETE FROM mods WHERE channel_id = ? OR user_id = ?', 'DELETE FROM circle_members WHERE user_id = ?', 'DELETE FROM circle_bans WHERE user_id = ?',
      'DELETE FROM event_rsvps WHERE user_id = ?', 'DELETE FROM notifications WHERE user_id = ?', 'DELETE FROM user_badges WHERE user_id = ?',
      'DELETE FROM pin_answers WHERE user_id = ? OR channel_id = ?', 'DELETE FROM watch_history WHERE user_id = ? OR channel_id = ?',
      'DELETE FROM appeals WHERE user_id = ?', 'DELETE FROM mod_actions WHERE user_id = ?', 'DELETE FROM avatars WHERE user_id = ?', 'DELETE FROM banners WHERE user_id = ?', 'DELETE FROM post_media WHERE user_id = ?'
    ];
    for (const sql of wipe) db.prepare(sql).run(...Array(sql.split('?').length - 1).fill(id));
    db.prepare('UPDATE stream_views SET user_id = 0 WHERE user_id = ?').run(id); // keep anonymous viewing numbers for the creator's analytics
    db.prepare('UPDATE reports SET reporter_id = 0 WHERE reporter_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    kick(id);
  }

  /* --------------------------------------------------- word filter + legal */
  const DEFAULT_WORDS = ['fuck', 'fucking', 'fucker', 'shit', 'shitty', 'bitch', 'asshole', 'bastard', 'cunt'];
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'wordsSeeded'").get()) {
    for (const w of DEFAULT_WORDS) db.prepare('INSERT OR IGNORE INTO banned_words (word, added_by, created_at) VALUES (?,0,?)').run(w, now());
    putSetting('wordsSeeded', true);
  }
  const loadWords = () => setGlobalWords(db.prepare('SELECT word FROM banned_words ORDER BY word').all().map(r => r.word));
  loadWords();

  const LEGAL_DEFAULTS = {
    guidelines: ['Community Guidelines', `## Be good to each other
NovaStream is a place where everyone should feel they belong, whether a stream has four viewers or four thousand.

## What is not allowed
- Harassment, bullying, threats or pile-ons
- Hate speech or attacks on people for who they are
- Sexual content, and anything that sexualises or endangers young people
- Encouraging self-harm. If you are struggling, please talk to someone you trust or a local helpline
- Spam, scams, fake giveaways, or pretending to be someone else (including NovaStream staff)
- Sharing other people's private information

## Streaming and chat
Streamers set the tone of their channel and can appoint moderators, use slow mode and block words. Early Bird pins are for real questions, not spam.

## Under-18 accounts
Accounts under 18 have extra protections: no external links on the profile, no listing in people search, bio and interests visible only to logged-in people, and quiet hours from 10pm to 7am by default.

## Verified accounts
A tick means NovaStream confirmed the identity of the person or organisation behind the account. It does not mean we vouch for what they say or stream.

## Reporting and consequences
Use the Report button on any message, post, profile, Circle or stream. Admins review reports. Depending on what happened we may warn, remove content, suspend for a time, or ban an account. Serious reports (self-harm, under-age users) are reviewed first.

## Appeals
If your account is suspended or banned you can appeal from the login page. A different admin will take a fresh look where possible.`],
    terms: ['Terms of Service', `## Using NovaStream
By creating an account you agree to these terms and to the Community Guidelines.

## Who can join
You must be at least 13 years old. If you are under the age of legal consent in your country, make sure a parent or guardian is happy for you to use NovaStream.

## Your account
Keep your password private. You are responsible for what happens on your account. You can change your password, log out everywhere, download your data and delete your account from Account settings.

## Your content
You own what you post and stream. You give NovaStream permission to host and show it to others as part of the service. Do not post anything you do not have the right to share.

## Our right to act
We may remove content, limit features, suspend or ban accounts that break the Community Guidelines or the law. We will explain why and you can appeal.

## Availability
NovaStream is provided as-is. We may pause the service for maintenance, and we cannot promise it will always be available or error-free.

## Changes
We may update these terms. Big changes will be announced on the site.

## Contact
Set a contact email for this section in Admin, then Legal pages.

Note for the site owner: this is a plain-language starting template, not legal advice. Have it reviewed by a lawyer for your country before a public launch.`],
    privacy: ['Privacy Policy', `## What we collect
- Account details: username, password (stored only as a one-way hash), date of birth
- What you add: profile, posts, comments, reactions, chat messages, Circle activity
- Basic usage: when you last logged in, which streams you watched (used for recommendations and for creators' audience statistics), and error logs

## Why
To run NovaStream, keep it safe, recommend streams and Circles you may like, and show creators how their streams are doing.

## Who sees it
Your profile, posts and chat messages are visible to other people as you set them up. If you are under 18, your bio, interests and channel text are visible only to logged-in people, and your profile is not listed in people search. We do not sell personal data. Admins can see account and report information when needed to keep the site safe.

## How long we keep it
Until you delete your account. Deleting your account removes your profile, posts, comments, follows and notifications. Reports and safety records may be kept in anonymous form.

## Your choices
From Account settings you can download everything we hold about you, change your password, log out of all devices, and delete your account. You can block people, mute notification types and set quiet hours.

## Security
Passwords are hashed, connections should use HTTPS, and sessions can be revoked. No online service is perfectly secure, so please use a strong, unique password.

## Contact
Set a contact email for this section in Admin, then Legal pages.

Note for the site owner: this is a starting template, not legal advice. Child-privacy rules differ by country (for example COPPA, GDPR). Have it reviewed before a public launch.`]
  };
  for (const [slug, [title, body]] of Object.entries(LEGAL_DEFAULTS)) {
    db.prepare('INSERT OR IGNORE INTO legal_pages (slug, title, body, updated_at) VALUES (?,?,?,?)').run(slug, title, body, now());
  }
  app.get('/api/legal', (_req, res) => res.json({ pages: db.prepare('SELECT slug, title FROM legal_pages ORDER BY slug').all() }));
  app.get('/api/legal/:slug', (req, res) => {
    const r = db.prepare('SELECT * FROM legal_pages WHERE slug = ?').get(req.params.slug);
    if (!r) return res.status(404).json({ error: 'Page not found.' });
    res.json({ slug: r.slug, title: r.title, body: r.body, updatedAt: r.updated_at });
  });

  /* ---------------------------------------------- account self-service */
  app.put('/api/account/password', need, sensitive, (req, res) => {
    const u = req.user, b = req.body || {};
    if (typeof b.current !== 'string' || !bcrypt.compareSync(b.current, u.pass_hash)) return res.status(400).json({ error: 'Your current password is wrong.' });
    if (typeof b.next !== 'string' || b.next.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
    if (b.next === b.current) return res.status(400).json({ error: 'Pick a password you have not used just now.' });
    db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(b.next, 11), u.id);
    kick(u.id); // other devices are signed out
    res.json({ ok: true, token: signToken(q.userById.get(u.id)) });
  });
  app.post('/api/account/logout-all', need, (req, res) => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    kick(req.user.id);
    res.json({ ok: true, token: signToken(q.userById.get(req.user.id)) });
  });
  app.post('/api/account/delete', need, sensitive, (req, res) => {
    const u = req.user;
    if (typeof (req.body || {}).password !== 'string' || !bcrypt.compareSync(req.body.password, u.pass_hash)) return res.status(400).json({ error: 'Your password is wrong.' });
    if (u.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c <= 1) {
      return res.status(400).json({ error: 'You are the only admin. Make someone else an admin before deleting this account.' });
    }
    deleteUser(u.id);
    res.json({ ok: true });
  });
  app.get('/api/account/export', need, (req, res) => {
    const u = req.user, id = u.id;
    const names = sql => db.prepare(sql).all(id).map(r => r.username);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { username: u.username, displayName: u.display_name, bio: u.bio, interests: splitList(u.interests), links: JSON.parse(u.links || '[]'), dateOfBirth: u.dob, joined: new Date(u.created_at).toISOString(), role: u.role, verified: !!u.verified },
      posts: db.prepare('SELECT id, kind, body, circle_id AS circleId, created_at AS createdAt FROM posts WHERE user_id = ?').all(id),
      comments: db.prepare('SELECT id, post_id AS postId, body, created_at AS createdAt FROM comments WHERE user_id = ?').all(id),
      reactions: db.prepare('SELECT post_id AS postId, emoji, created_at AS createdAt FROM post_reactions WHERE user_id = ?').all(id),
      following: names('SELECT u.username FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ?'),
      followers: names('SELECT u.username FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ?'),
      blocked: names('SELECT u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?'),
      circles: db.prepare('SELECT c.name, c.slug, m.role, m.contribs AS contributions, m.joined_at AS joinedAt FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ?').all(id),
      badges: db.prepare('SELECT code, earned_at AS earnedAt FROM user_badges WHERE user_id = ?').all(id),
      notifications: db.prepare('SELECT type, text, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(id),
      streams: db.prepare('SELECT title, category, started_at AS startedAt, ended_at AS endedAt, peak_viewers AS peakViewers FROM streams WHERE user_id = ?').all(id),
      chatMessages: replay.exportFor(id),
      moderationHistory: db.prepare('SELECT action, reason, created_at AS createdAt FROM mod_actions WHERE user_id = ?').all(id)
    };
    res.setHeader('Content-Disposition', 'attachment; filename="novastream-my-data.json"');
    res.json(data);
  });

  // No email service is built in, so recovery works through an admin-issued one-time code.
  app.post('/api/reset-password', sensitive, (req, res) => {
    const b = req.body || {};
    const u = typeof b.username === 'string' ? q.userByName.get(b.username) : null;
    const bad = { error: 'That code is wrong or has expired. Ask a NovaStream admin for a new one.' };
    if (!u || !u.reset_hash || u.reset_expires < now() || typeof b.code !== 'string' || !bcrypt.compareSync(b.code.trim().toUpperCase(), u.reset_hash)) return res.status(400).json(bad);
    if (typeof b.newPassword !== 'string' || b.newPassword.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
    db.prepare("UPDATE users SET pass_hash = ?, reset_hash = '', reset_expires = 0, token_version = token_version + 1 WHERE id = ?").run(bcrypt.hashSync(b.newPassword, 11), u.id);
    res.json({ ok: true });
  });

  app.post('/api/appeal', sensitive, (req, res) => {
    const b = req.body || {};
    const u = typeof b.username === 'string' ? q.userByName.get(b.username) : null;
    if (!u || typeof b.password !== 'string' || !bcrypt.compareSync(b.password, u.pass_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
    if (!restrictionOf(u)) return res.status(400).json({ error: 'This account is not suspended or banned.' });
    const message = cleanText(b.message, 1000);
    if (message.length < 10) return res.status(400).json({ error: 'Please tell us a little more (at least 10 characters).' });
    if (db.prepare("SELECT 1 FROM appeals WHERE user_id = ? AND status = 'open'").get(u.id)) return res.status(409).json({ error: 'You already have an appeal waiting for review.' });
    db.prepare('INSERT INTO appeals (user_id, message, created_at) VALUES (?,?,?)').run(u.id, message, now());
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------- reports */
  const CATEGORIES = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self-harm', 'impersonation', 'underage', 'other'];
  const URGENT = ['self-harm', 'underage'];
  function fileReport(user, b) {
    const type = ['chat', 'post', 'comment', 'user', 'circle', 'stream'].includes(b.type) ? b.type : null;
    if (!type) return { status: 400, error: 'Pick what you are reporting.' };
    const category = CATEGORIES.includes(b.category) ? b.category : 'other';
    let reported = null, target = cleanText(b.target, 60), context = cleanText(b.context, 300), channel = '';
    if (type === 'chat') {
      channel = cleanText(b.target, 30);
      reported = q.userByName.get(cleanText(b.username, 30));
    } else if (type === 'post') {
      const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(num(b.target));
      if (!p) return { status: 404, error: 'That post is already gone.' };
      reported = q.userById.get(p.user_id); target = String(p.id); context = cleanText(p.body, 300);
    } else if (type === 'comment') {
      const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(num(b.target));
      if (!c) return { status: 404, error: 'That comment is already gone.' };
      reported = q.userById.get(c.user_id); target = String(c.id); context = cleanText(c.body, 300);
    } else if (type === 'user' || type === 'stream') {
      reported = q.userByName.get(target);
      if (!reported) return { status: 404, error: 'That person was not found.' };
      target = reported.username;
    } else if (type === 'circle') {
      const c = db.prepare('SELECT * FROM circles WHERE slug = ?').get(target);
      if (!c) return { status: 404, error: 'That Circle was not found.' };
      reported = q.userById.get(c.owner_id); target = c.slug; context = cleanText(`${c.name}: ${c.description}`, 300);
    }
    if (reported && reported.id === user.id) return { status: 400, error: 'You cannot report yourself.' };
    const dup = db.prepare('SELECT id FROM reports WHERE reporter_id = ? AND type = ? AND target = ? AND created_at > ?').get(user.id, type, target, now() - 86400000);
    if (dup && type !== 'chat') return { ok: true, duplicate: true };
    db.prepare(`INSERT INTO reports (reporter_id, channel, username, message, reason, created_at, type, target, category, context, reported_user_id, priority)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, channel, reported ? reported.username : cleanText(b.username, 30), context, cleanText(b.note, 300) || category, now(),
      type, target, category, context, reported ? reported.id : 0, URGENT.includes(category) ? 1 : 0);
    return { ok: true };
  }
  const reportHandler = type => (req, res) => {
    const b = { ...(req.body || {}) };
    if (type) { b.type = type; if (type === 'post') b.target = req.params.id; }
    const r = fileReport(req.user, b);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, duplicate: !!r.duplicate });
  };
  app.post('/api/reports', need, reportLimiter, reportHandler(null));
  app.post('/api/report', need, reportLimiter, (req, res) => { // older clients: chat reports
    const b = req.body || {};
    const r = fileReport(req.user, { type: 'chat', target: b.channel, username: b.username, context: b.message, note: b.reason, category: b.category });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  });
  app.post('/api/posts/:id/report', need, reportLimiter, reportHandler('post'));
  app.get('/api/report-categories', (_req, res) => res.json({ categories: CATEGORIES }));

  function restrict(target, kind, hours, reason) {
    const until = kind === 'suspend' ? now() + hours * 3600000 : 0;
    db.prepare('UPDATE users SET status = ?, status_reason = ?, suspended_until = ?, token_version = token_version + 1 WHERE id = ?')
      .run(kind === 'ban' ? 'banned' : 'suspended', cleanText(reason, 300), until, target.id);
    const room = rooms.get(target.username.toLowerCase());
    if (room && room.live) endStream(room);
    kick(target.id);
  }
  const lift = target => db.prepare("UPDATE users SET status = 'active', status_reason = '', suspended_until = 0 WHERE id = ?").run(target.id);
  const protectedFrom = (admin, target, action) => {
    if (!target) return 'That account does not exist.';
    if (['suspend', 'ban', 'delete'].includes(action)) {
      if (target.id === admin.id) return 'You cannot do that to your own account.';
      if (target.role === 'admin') return 'Remove their admin role first.';
    }
    return null;
  };

  const reportRow = r => {
    const reporter = r.reporter_id ? q.userById.get(r.reporter_id) : null;
    const reported = r.reported_user_id ? q.userById.get(r.reported_user_id) : null;
    return {
      id: r.id, type: r.type, target: r.target, channel: r.channel, category: r.category, priority: !!r.priority, status: r.status,
      reason: r.reason, context: r.context || r.message, createdAt: r.created_at,
      reporter: reporter ? reporter.username : '(deleted account)', reportedUserId: r.reported_user_id, reported: reported ? reported.username : r.username || '',
      reportedStatus: reported ? effectiveStatus(reported) : '',
      others: db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open' AND type = ? AND target = ? AND id <> ?").get(r.type, r.target, r.id).c,
      resolution: r.resolution, handledAt: r.handled_at
    };
  };
  app.get('/api/admin/reports', adminOnly, (req, res) => {
    const where = [], args = [];
    const status = req.query.status || 'open';
    if (status !== 'all') { where.push('status = ?'); args.push(status); }
    if (req.query.type) { where.push('type = ?'); args.push(String(req.query.type)); }
    if (req.query.category) { where.push('category = ?'); args.push(String(req.query.category)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM reports ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM reports ${w} ORDER BY priority DESC, id DESC LIMIT ? OFFSET ?`).all(...args, PAGE, (page(req) - 1) * PAGE);
    res.json({ reports: rows.map(reportRow), total, page: page(req), pages: Math.max(1, Math.ceil(total / PAGE)) });
  });
  app.post('/api/admin/reports/:id/resolve', adminOnly, (req, res) => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(num(req.params.id));
    if (!r) return res.status(404).json({ error: 'Report not found.' });
    if (r.status !== 'open') return res.status(400).json({ error: 'This report was already handled.' });
    const b = req.body || {}, admin = req.user;
    const action = ['dismiss', 'warn', 'delete_content', 'suspend', 'ban'].includes(b.action) ? b.action : null;
    if (!action) return res.status(400).json({ error: 'Pick an action.' });
    const note = cleanText(b.note, 300);
    const target = r.reported_user_id ? q.userById.get(r.reported_user_id) : null;
    if (action !== 'dismiss' && action !== 'delete_content' && !target) return res.status(400).json({ error: 'There is no account to take action on.' });
    if (action !== 'dismiss' && note.length < 3 && action !== 'delete_content') return res.status(400).json({ error: 'Add a short reason. The person will see it.' });
    const blocked = target ? protectedFrom(admin, target, action) : null;
    if (blocked) return res.status(400).json({ error: blocked });
    if (action === 'delete_content') {
      if (r.type === 'post') deletePost(num(r.target));
      else if (r.type === 'comment') db.prepare('DELETE FROM comments WHERE id = ?').run(num(r.target));
      else return res.status(400).json({ error: 'Only posts and comments can be deleted from a report.' });
      if (target) modAction(target.id, admin.id, 'content_removed', note || `${r.type} removed after a report`);
    } else if (action === 'warn') {
      modAction(target.id, admin.id, 'warn', note);
      social.notify(target.id, 'system', `Warning from NovaStream staff: ${note}`, '#/legal/guidelines', 0);
    } else if (action === 'suspend') {
      const hours = Math.max(1, Math.min(8760, Math.round(num(b.hours)) || 24));
      restrict(target, 'suspend', hours, note);
      modAction(target.id, admin.id, `suspend_${hours}h`, note);
    } else if (action === 'ban') {
      restrict(target, 'ban', 0, note);
      modAction(target.id, admin.id, 'ban', note);
    }
    const same = db.prepare("SELECT * FROM reports WHERE status = 'open' AND type = ? AND target = ?").all(r.type, r.target);
    for (const x of same) {
      db.prepare("UPDATE reports SET status = 'resolved', resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?").run(`${action}${note ? ': ' + note : ''}`, admin.id, now(), x.id);
      if (x.reporter_id) social.notify(x.reporter_id, 'system', action === 'dismiss' ? 'Thanks for your report. We reviewed it and decided no action was needed.' : 'Thanks for your report. We reviewed it and took action.', '', 0);
    }
    audit(admin, `report_${action}`, `report #${r.id}`, `${r.type}:${r.target} ${note}`);
    res.json({ ok: true, resolved: same.length });
  });

  /* --------------------------------------------------------------- users */
  const userRow = u => ({
    id: u.id, username: u.username, displayName: u.display_name || u.username, role: u.role, verified: !!u.verified, status: effectiveStatus(u),
    reason: u.status_reason, until: u.suspended_until, teen: isTeen(u), createdAt: u.created_at, lastLogin: u.last_login
  });
  app.get('/api/admin/users', adminOnly, (req, res) => {
    const where = [], args = [];
    const term = cleanText(req.query.q, 40);
    if (term) { where.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')"); args.push(like(term), like(term)); }
    if (req.query.role === 'admin') where.push("role = 'admin'");
    if (req.query.status === 'restricted') where.push("status IN ('suspended','banned')");
    if (req.query.status === 'active') where.push("status = 'active'");
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM users ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM users ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, PAGE, (page(req) - 1) * PAGE);
    res.json({
      users: rows.map(u => ({
        ...userRow(u),
        posts: db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(u.id).c,
        followers: q.followCount.get(u.id).c,
        reportsAgainst: db.prepare('SELECT COUNT(*) c FROM reports WHERE reported_user_id = ?').get(u.id).c
      })),
      total, page: page(req), pages: Math.max(1, Math.ceil(total / PAGE))
    });
  });
  app.get('/api/admin/users/:id', adminOnly, (req, res) => {
    const u = q.userById.get(num(req.params.id));
    if (!u) return res.status(404).json({ error: 'No such account.' });
    const nameOf = id => (q.userById.get(id) || { username: id ? '(deleted)' : 'system' }).username;
    res.json({
      user: { ...userRow(u), bio: u.bio, interests: splitList(u.interests), links: JSON.parse(u.links || '[]'), dob: u.dob },
      history: db.prepare('SELECT * FROM mod_actions WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id).map(m => ({ action: m.action, reason: m.reason, by: nameOf(m.admin_id), at: m.created_at })),
      reports: db.prepare('SELECT * FROM reports WHERE reported_user_id = ? ORDER BY id DESC LIMIT 20').all(u.id).map(reportRow),
      appeals: db.prepare('SELECT * FROM appeals WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(u.id).map(a => ({ id: a.id, message: a.message, status: a.status, response: a.response, at: a.created_at })),
      circles: db.prepare('SELECT c.name, c.slug, m.role FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ?').all(u.id),
      posts: db.prepare('SELECT id, body, created_at FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(u.id).map(p => ({ id: p.id, body: p.body, at: p.created_at })),
      live: !!(rooms.get(u.username.toLowerCase()) || {}).live
    });
  });
  app.post('/api/admin/users/:id/action', adminOnly, (req, res) => {
    const admin = req.user, b = req.body || {};
    const t = q.userById.get(num(req.params.id));
    const action = String(b.action || '');
    const reason = cleanText(b.reason, 300);
    const blocked = protectedFrom(admin, t, action);
    if (blocked) return res.status(400).json({ error: blocked });
    const needReason = ['warn', 'suspend', 'ban'].includes(action);
    if (needReason && reason.length < 3) return res.status(400).json({ error: 'Add a short reason. The person will see it.' });
    let extra = {};
    switch (action) {
      case 'warn':
        modAction(t.id, admin.id, 'warn', reason);
        social.notify(t.id, 'system', `Warning from NovaStream staff: ${reason}`, '#/legal/guidelines', 0);
        break;
      case 'suspend': {
        const hours = Math.max(1, Math.min(8760, Math.round(num(b.hours)) || 24));
        restrict(t, 'suspend', hours, reason); modAction(t.id, admin.id, `suspend_${hours}h`, reason);
        break;
      }
      case 'ban': restrict(t, 'ban', 0, reason); modAction(t.id, admin.id, 'ban', reason); break;
      case 'unban': lift(t); modAction(t.id, admin.id, 'restore', reason || 'account restored'); break;
      case 'verify': db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(t.id); break;
      case 'unverify': db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(t.id); break;
      case 'make_admin': db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(t.id); break;
      case 'remove_admin':
        if (t.id === admin.id) return res.status(400).json({ error: 'You cannot remove your own admin role.' });
        db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(t.id);
        break;
      case 'clear_profile':
        db.prepare("UPDATE users SET display_name = '', bio = '', interests = '', links = '[]', avatar = '', avatar_img = '', banner_img = '', channel_desc = '' WHERE id = ?").run(t.id);
        db.prepare('DELETE FROM avatars WHERE user_id = ?').run(t.id);
        db.prepare('DELETE FROM banners WHERE user_id = ?').run(t.id);
        modAction(t.id, admin.id, 'profile_cleared', reason || 'profile content removed');
        break;
      case 'logout': db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(t.id); kick(t.id); break;
      case 'reset_code': {
        const code = crypto.randomBytes(5).toString('hex').toUpperCase();
        const expires = now() + 24 * 3600000;
        db.prepare('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?').run(bcrypt.hashSync(code, 8), expires, t.id);
        extra = { code, expiresAt: expires };
        break;
      }
      case 'delete': deleteUser(t.id); break;
      default: return res.status(400).json({ error: 'Unknown action.' });
    }
    audit(admin, `user_${action}`, t.username, reason || (extra.code ? 'recovery code issued' : ''));
    res.json({ ok: true, ...extra, user: q.userById.get(t.id) ? userRow(q.userById.get(t.id)) : null });
  });

  /* ------------------------------------------------------------- appeals */
  app.get('/api/admin/appeals', adminOnly, (req, res) => {
    const status = req.query.status === 'all' ? null : 'open';
    const rows = db.prepare(`SELECT * FROM appeals ${status ? "WHERE status = 'open'" : ''} ORDER BY id DESC LIMIT 100`).all();
    res.json({
      appeals: rows.map(a => {
        const u = q.userById.get(a.user_id);
        return { id: a.id, userId: a.user_id, username: u ? u.username : '(deleted)', message: a.message, status: a.status, response: a.response, at: a.created_at, accountStatus: u ? effectiveStatus(u) : '', reason: u ? u.status_reason : '' };
      })
    });
  });
  app.post('/api/admin/appeals/:id/resolve', adminOnly, (req, res) => {
    const a = db.prepare('SELECT * FROM appeals WHERE id = ?').get(num(req.params.id));
    if (!a || a.status !== 'open') return res.status(404).json({ error: 'That appeal is not waiting for review.' });
    const decision = (req.body || {}).decision === 'approve' ? 'approve' : 'reject';
    const response = cleanText((req.body || {}).response, 500);
    if (response.length < 3) return res.status(400).json({ error: 'Write a short reply to the person.' });
    const u = q.userById.get(a.user_id);
    db.prepare('UPDATE appeals SET status = ?, response = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'rejected', response, req.user.id, now(), a.id);
    if (u && decision === 'approve') {
      lift(u); modAction(u.id, req.user.id, 'appeal_approved', response);
      social.notify(u.id, 'system', `Your appeal was approved: ${response}`, '', 0);
    } else if (u) modAction(u.id, req.user.id, 'appeal_rejected', response);
    audit(req.user, `appeal_${decision}`, u ? u.username : '', response);
    res.json({ ok: true });
  });

  /* -------------------------------------------------------- live streams */
  const liveRooms = () => [...rooms.values()].filter(r => r.live);
  app.get('/api/admin/streams', adminOnly, (_req, res) => res.json({
    streams: liveRooms().map(r => ({ channel: r.channel, ownerId: r.ownerId, title: r.title, category: r.category, viewers: r.viewers.size, startedAt: r.startedAt }))
  }));
  app.post('/api/admin/streams/:channel/end', adminOnly, (req, res) => {
    const room = rooms.get(String(req.params.channel).toLowerCase());
    if (!room || !room.live) return res.status(404).json({ error: 'That stream is not live.' });
    const reason = cleanText((req.body || {}).reason, 200) || 'a breach of the community guidelines';
    io.to('ch:' + room.key).emit('chat', { id: crypto.randomUUID(), system: true, text: 'This stream was ended by NovaStream staff.', ts: now() });
    endStream(room);
    modAction(room.ownerId, req.user.id, 'stream_ended', reason);
    social.notify(room.ownerId, 'system', `Your stream was ended by NovaStream staff: ${reason}`, '#/legal/guidelines', 0);
    audit(req.user, 'stream_end', room.channel, reason);
    res.json({ ok: true });
  });

  /* ------------------------------------------------- content and Circles */
  app.get('/api/admin/posts', adminOnly, (req, res) => {
    const term = cleanText(req.query.q, 60);
    const args = term ? [like(term), like(term)] : [];
    const w = term ? "WHERE (p.body LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')" : '';
    const rows = db.prepare(`SELECT p.*, u.username FROM posts p JOIN users u ON u.id = p.user_id ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...args, PAGE, (page(req) - 1) * PAGE);
    res.json({
      posts: rows.map(p => ({
        id: p.id, author: p.username, body: p.body, kind: p.kind, createdAt: p.created_at,
        circle: p.circle_id ? (db.prepare('SELECT slug FROM circles WHERE id = ?').get(p.circle_id) || {}).slug || '' : '',
        comments: db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id).c,
        reports: db.prepare("SELECT COUNT(*) c FROM reports WHERE type = 'post' AND target = ?").get(String(p.id)).c
      }))
    });
  });
  app.delete('/api/admin/posts/:id', adminOnly, (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(num(req.params.id));
    if (!p) return res.status(404).json({ error: 'Post not found.' });
    deletePost(p.id); modAction(p.user_id, req.user.id, 'content_removed', 'post removed by an admin');
    audit(req.user, 'post_delete', `post #${p.id}`, cleanText(p.body, 100));
    res.json({ ok: true });
  });
  app.delete('/api/admin/comments/:id', adminOnly, (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(num(req.params.id));
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id); modAction(c.user_id, req.user.id, 'content_removed', 'comment removed by an admin');
    audit(req.user, 'comment_delete', `comment #${c.id}`, cleanText(c.body, 100));
    res.json({ ok: true });
  });
  app.get('/api/admin/circles', adminOnly, (_req, res) => res.json({
    circles: db.prepare('SELECT * FROM circles ORDER BY id DESC LIMIT 200').all().map(c => ({
      id: c.id, slug: c.slug, name: c.name, owner: (q.userById.get(c.owner_id) || { username: '(deleted)' }).username, createdAt: c.created_at,
      members: db.prepare('SELECT COUNT(*) c FROM circle_members WHERE circle_id = ?').get(c.id).c,
      posts: db.prepare('SELECT COUNT(*) c FROM posts WHERE circle_id = ?').get(c.id).c,
      reports: db.prepare("SELECT COUNT(*) c FROM reports WHERE type = 'circle' AND target = ?").get(c.slug).c
    }))
  }));
  app.delete('/api/admin/circles/:id', adminOnly, (req, res) => {
    const c = db.prepare('SELECT * FROM circles WHERE id = ?').get(num(req.params.id));
    if (!c) return res.status(404).json({ error: 'Circle not found.' });
    deleteCircle(c.id);
    modAction(c.owner_id, req.user.id, 'circle_removed', `Circle "${c.name}" removed by an admin`);
    audit(req.user, 'circle_delete', c.slug, c.name);
    res.json({ ok: true });
  });

  /* ------------------------------------------------- words, settings, legal */
  app.get('/api/admin/words', adminOnly, (_req, res) => res.json({ words: db.prepare('SELECT word FROM banned_words ORDER BY word').all().map(r => r.word), fromEnv: envBlockedCount }));
  app.post('/api/admin/words', adminOnly, (req, res) => {
    const w = cleanText((req.body || {}).word, 30).toLowerCase();
    if (w.length < 2) return res.status(400).json({ error: 'Type a word or short phrase (at least 2 characters).' });
    db.prepare('INSERT OR IGNORE INTO banned_words (word, added_by, created_at) VALUES (?,?,?)').run(w, req.user.id, now());
    loadWords(); audit(req.user, 'word_add', w, '');
    res.json({ ok: true });
  });
  app.delete('/api/admin/words/:word', adminOnly, (req, res) => {
    db.prepare('DELETE FROM banned_words WHERE word = ?').run(String(req.params.word).toLowerCase());
    loadWords(); audit(req.user, 'word_remove', req.params.word, '');
    res.json({ ok: true });
  });

  const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
  app.get('/api/admin/settings', adminOnly, (_req, res) => res.json({ settings: Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)])), defaults: SETTING_DEFAULTS }));
  app.put('/api/admin/settings', adminOnly, (req, res) => {
    const b = req.body || {};
    const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    const rules = {
      registrationOpen: v => (typeof v === 'boolean' ? v : null), maintenance: v => (typeof v === 'boolean' ? v : null),
      maintenanceMessage: v => (typeof v === 'string' ? cleanText(v, 300) : null), announcement: v => (typeof v === 'string' ? cleanText(v, 300) : null),
      announcementLevel: v => (['info', 'warning', 'critical'].includes(v) ? v : null), maxViewers: v => int(v, 1, 200),
      minAccountAgeMin: v => int(v, 0, 10080), postCooldownMs: v => int(v, 0, 60000),
      chatReplayEnabled: v => (typeof v === 'boolean' ? v : null), chatReplayDays: v => int(v, 1, 365)
    };
    const changed = [];
    for (const k of SETTING_KEYS) {
      if (b[k] === undefined) continue;
      const v = rules[k](b[k]);
      if (v === null) return res.status(400).json({ error: `"${k}" has an invalid value.` });
      if (v !== getSetting(k)) { putSetting(k, v); changed.push(`${k}=${JSON.stringify(v)}`); }
    }
    if (changed.length) audit(req.user, 'settings_change', 'site', changed.join('; '));
    res.json({ ok: true, settings: Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)])) });
  });

  app.put('/api/admin/legal/:slug', adminOnly, (req, res) => {
    const r = db.prepare('SELECT * FROM legal_pages WHERE slug = ?').get(req.params.slug);
    if (!r) return res.status(404).json({ error: 'Page not found.' });
    const title = cleanText((req.body || {}).title, 80) || r.title;
    const body = String((req.body || {}).body || '').slice(0, 20000);
    if (body.trim().length < 20) return res.status(400).json({ error: 'The page needs some content.' });
    db.prepare('UPDATE legal_pages SET title = ?, body = ?, updated_at = ? WHERE slug = ?').run(title, body, now(), r.slug);
    audit(req.user, 'legal_edit', r.slug, title);
    res.json({ ok: true });
  });

  /* -------------------------------------------------------------- backups */
  const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const BACKUP_RE = /^(auto|manual)-\d{14}(-\d+)?\.db$/;
  const listBackups = () => fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).map(f => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, kind: f.split('-')[0], size: st.size, createdAt: st.mtimeMs };
  }).sort((a, b) => b.createdAt - a.createdAt);
  function createBackup(kind) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    let name = `${kind}-${stamp}.db`, n = 1;
    while (fs.existsSync(path.join(BACKUP_DIR, name))) name = `${kind}-${stamp}-${++n}.db`;
    db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, name).replace(/'/g, "''")}'`); // a consistent copy, safe while the app is running
    if (kind === 'auto') for (const old of listBackups().filter(b => b.kind === 'auto').slice(Number(process.env.BACKUP_KEEP) || 7)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    return name;
  }
  const backupEveryMs = (Number(process.env.BACKUP_EVERY_HOURS) || 24) * 3600000;
  function autoBackup() {
    try {
      const last = listBackups().find(b => b.kind === 'auto');
      if (!last || now() - last.createdAt >= backupEveryMs) createBackup('auto');
    } catch (e) { logError(e.message, 'backup'); }
  }
  setTimeout(autoBackup, 3000).unref();
  setInterval(autoBackup, 3600000).unref();
  app.get('/api/admin/backups', adminOnly, (_req, res) => res.json({ backups: listBackups(), dir: BACKUP_DIR, everyHours: backupEveryMs / 3600000, keep: Number(process.env.BACKUP_KEEP) || 7 }));
  app.post('/api/admin/backups', adminOnly, (req, res) => {
    try { const name = createBackup('manual'); audit(req.user, 'backup_create', name, ''); res.json({ ok: true, name }); }
    catch (e) { logError(e.message, 'backup'); res.status(500).json({ error: 'The backup could not be created.' }); }
  });
  app.get('/api/admin/backups/:name', adminOnly, (req, res) => {
    if (!BACKUP_RE.test(req.params.name) || !fs.existsSync(path.join(BACKUP_DIR, req.params.name))) return res.status(404).json({ error: 'Backup not found.' });
    audit(req.user, 'backup_download', req.params.name, '');
    res.download(path.join(BACKUP_DIR, req.params.name));
  });

  /* ------------------------------------------------- overview + audit log */
  app.get('/api/admin/overview', adminOnly, (_req, res) => {
    const c = sql => db.prepare(sql).get().c;
    const backups = listBackups();
    const warnings = [];
    if (!IS_PROD) warnings.push({ level: 'info', text: 'Running in development mode. Set NODE_ENV=production when you go live.' });
    if (EPHEMERAL_SECRET) warnings.push({ level: 'warning', text: 'JWT_SECRET is not set, so everyone is logged out whenever the server restarts.' });
    if (getSetting('minAccountAgeMin') === 0) warnings.push({ level: 'warning', text: 'The anti-bot account age is 0. Early Birds and appreciation points can be farmed with brand-new accounts. Set it to 60 before launch (Settings).' });
    if (!hasTurn) warnings.push({ level: 'info', text: 'No TURN server is configured, so some viewers on mobile data may not be able to watch.' });
    if (!backups.length || now() - backups[0].createdAt > 48 * 3600000) warnings.push({ level: 'warning', text: 'There is no backup from the last 48 hours.' });
    if (getSetting('maintenance')) warnings.push({ level: 'critical', text: 'Maintenance mode is ON: posting, chat and going live are paused for everyone except admins.' });
    if (!getSetting('registrationOpen')) warnings.push({ level: 'info', text: 'New sign-ups are paused.' });
    const urgent = c("SELECT COUNT(*) c FROM reports WHERE status = 'open' AND priority = 1");
    if (urgent) warnings.push({ level: 'critical', text: `${urgent} urgent report${urgent > 1 ? 's' : ''} (self-harm or under-age) waiting for review.` });
    const mem = process.memoryUsage();
    res.json({
      counts: {
        users: c('SELECT COUNT(*) c FROM users'), newToday: db.prepare('SELECT COUNT(*) c FROM users WHERE created_at > ?').get(now() - 86400000).c,
        teens: db.prepare('SELECT dob FROM users').all().filter(u => isTeen(u)).length, admins: c("SELECT COUNT(*) c FROM users WHERE role = 'admin'"),
        restricted: c("SELECT COUNT(*) c FROM users WHERE status IN ('suspended','banned')"), posts: c('SELECT COUNT(*) c FROM posts'), circles: c('SELECT COUNT(*) c FROM circles'),
        openReports: c("SELECT COUNT(*) c FROM reports WHERE status = 'open'"), urgentReports: urgent, openAppeals: c("SELECT COUNT(*) c FROM appeals WHERE status = 'open'"),
        live: liveRooms().length, viewers: liveRooms().reduce((a, r) => a + r.viewers.size, 0), connections: io.engine.clientsCount
      },
      system: {
        uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(mem.rss / 1048576), node: process.version,
        dbMb: Math.round((fs.statSync(DB_PATH).size / 1048576) * 10) / 10, production: IS_PROD,
        lastBackup: backups[0] ? backups[0].createdAt : 0, errors24h: db.prepare('SELECT COUNT(*) c FROM error_log WHERE created_at > ?').get(now() - 86400000).c
      },
      warnings,
      errors: db.prepare('SELECT message, place, created_at FROM error_log ORDER BY id DESC LIMIT 10').all().map(e => ({ message: e.message, place: e.place, at: e.created_at })),
      live: liveRooms().map(r => ({ channel: r.channel, title: r.title, viewers: r.viewers.size }))
    });
  });
  app.get('/api/admin/audit', adminOnly, (req, res) => {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(PAGE * 2, (page(req) - 1) * PAGE * 2);
    res.json({ entries: rows.map(a => ({ id: a.id, admin: (q.userById.get(a.admin_id) || { username: '(deleted)' }).username, action: a.action, target: a.target, detail: a.detail, at: a.created_at })), page: page(req) });
  });

  return { logError, deleteUser, createBackup, loadWords };
};
