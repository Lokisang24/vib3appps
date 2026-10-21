'use strict';
// Acceptance tests: every promise the app makes to its users and owner, plus the admin area.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, total = 0;
const check = (name, cond) => { total++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const section = t => console.log(`\n--- ${t}`);

const api = async (tok, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  let j = {}; try { j = ct.includes('json') ? await r.json() : { _raw: await r.text() }; } catch { /* empty */ }
  return { status: r.status, body: j, ct };
};
const connect = token => new Promise(res => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise(res => s.emit(ev, p, res));
const notifs = async tok => (await api(tok, 'GET', '/api/notifications')).body;
const has = (n, type, text) => n.notifications.some(x => x.type === type && (!text || x.text.includes(text)));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-promises-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, POST_COOLDOWN_MS: '0', JOB_INTERVAL_MS: '300', AUTH_LIMIT: '60', SENSITIVE_LIMIT: '100', ADMIN_USERNAMES: 'siteadmin', DB_PATH: path.join(dir, 'novastream.db') },
    stdio: 'inherit'
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* wait */ } await sleep(150); }
    const reg = async (name, dob = '2000-01-01', extra = {}) => (await api(null, 'POST', '/api/register', { username: name, password: 'password123', dob, acceptTerms: true, ...extra })).body;
    const ADM = await reg('siteadmin');
    const U = { alice: await reg('alice'), bobby: await reg('bobby'), cara: await reg('cara'), dane: await reg('dane', '2012-03-01'), evey: await reg('evey'), fred: await reg('fred') };
    const A = U.alice.token, B = U.bobby.token, C = U.cara.token, D = U.dane.token, E = U.evey.token, F = U.fred.token, X = ADM.token;
    const post = async (tok, body, extra = {}) => (await api(tok, 'POST', '/api/posts', { body, ...extra })).body.post;

    /* ============================================================ roles */
    section('Roles and access');
    check('the admin username from .env gets the admin role', ADM.user.isAdmin === true);
    check('normal accounts are not admins', U.alice.user.isAdmin === false);
    const adminPaths = ['/api/admin/overview', '/api/admin/reports', '/api/admin/users', '/api/admin/appeals', '/api/admin/streams', '/api/admin/posts', '/api/admin/circles', '/api/admin/words', '/api/admin/settings', '/api/admin/backups', '/api/admin/audit'];
    let denied = 0, guestDenied = 0;
    for (const p of adminPaths) { if ((await api(A, 'GET', p)).status === 403) denied++; if ((await api(null, 'GET', p)).status === 401) guestDenied++; }
    check(`all ${adminPaths.length} admin areas refuse normal users`, denied === adminPaths.length);
    check('all admin areas refuse logged-out visitors', guestDenied === adminPaths.length);

    /* ============================================== sign-up promises */
    section('Sign-up, reserved names, terms');
    check('sign-up needs agreement to the terms', (await api(null, 'POST', '/api/register', { username: 'noterms', password: 'password123', dob: '2000-01-01' })).status === 400);
    for (const n of ['admin', 'Support', 'novastream_team', 'ModeratorJoe', 'official']) {
      check(`staff-like username "${n}" is reserved`, (await api(null, 'POST', '/api/register', { username: n, password: 'password123', dob: '2000-01-01', acceptTerms: true })).status === 400);
    }
    for (const slug of ['guidelines', 'terms', 'privacy']) {
      const r = await api(null, 'GET', '/api/legal/' + slug);
      check(`${slug} page exists and has content`, r.status === 200 && r.body.body.length > 200);
    }
    check('an admin can edit a legal page', (await api(X, 'PUT', '/api/admin/legal/terms', { title: 'Terms of Service', body: 'Edited terms. '.repeat(10) })).status === 200 && (await api(null, 'GET', '/api/legal/terms')).body.body.startsWith('Edited terms'));
    check('a normal user cannot edit legal pages', (await api(A, 'PUT', '/api/admin/legal/terms', { body: 'x'.repeat(50) })).status === 403);

    /* ================================================ under-18 defaults */
    section('Under-18 safety defaults');
    check('under-18 accounts are flagged', U.dane.user.isTeen === true);
    const dn = await notifs(D);
    check('under-18 accounts start with quiet hours 22:00-07:00', dn.quietStart === 22 && dn.quietEnd === 7);
    await api(D, 'PUT', '/api/profile', { bio: 'I like drawing', interests: 'art', links: [{ platform: 'Website', url: 'https://example.com' }] });
    const guestView = (await api(null, 'GET', '/api/profile/dane')).body;
    const userView = (await api(B, 'GET', '/api/profile/dane')).body;
    check('under-18 profiles cannot carry external links', guestView.links.length === 0 && userView.links.length === 0);
    check('under-18 bio and interests are hidden from logged-out visitors', guestView.bio === '' && guestView.interests.length === 0);
    check('under-18 bio is visible to logged-in people', userView.bio === 'I like drawing');
    check('under-18 accounts are not listed in people search', !(await api(B, 'GET', '/api/search?q=dan')).body.users.some(u => u.username === 'dane'));
    check('an exact username still finds an under-18 account', (await api(B, 'GET', '/api/search?q=dane')).body.users.some(u => u.username === 'dane'));
    check('adults are still searchable', (await api(B, 'GET', '/api/search?q=alic')).body.users.some(u => u.username === 'alice'));

    /* ====================================================== word filter */
    section('Word filter');
    const w1 = await post(A, 'this is shit and a class act');
    check('common profanity is masked out of the box', w1.body === 'this is **** and a class act');
    check('words inside other words are left alone ("class")', w1.body.includes('class'));
    check('admin adds a word and it works immediately', (await api(X, 'POST', '/api/admin/words', { word: 'Frobnicate' })).status === 200 && (await post(A, 'Do not FROBNICATE here')).body === 'Do not ********** here');
    check('longer words containing it are not masked', (await post(A, 'frobnicated yesterday')).body === 'frobnicated yesterday');
    check('admin can list words', (await api(X, 'GET', '/api/admin/words')).body.words.includes('frobnicate'));
    check('a normal user cannot change the word list', (await api(A, 'POST', '/api/admin/words', { word: 'nope' })).status === 403);
    await api(X, 'DELETE', '/api/admin/words/frobnicate');
    check('admin removes a word and it stops masking', (await post(A, 'Do not frobnicate here')).body === 'Do not frobnicate here');

    /* ========================================================= blocking */
    section('Blocking really blocks');
    const ap = await post(A, 'a post by alice');
    await api(A, 'POST', '/api/blocks/bobby');
    check('blocked person cannot comment', (await api(B, 'POST', `/api/posts/${ap.id}/comments`, { body: 'hi' })).status === 403);
    check('blocked person cannot react', (await api(B, 'POST', `/api/posts/${ap.id}/react`, { emoji: '🔥' })).status === 403);
    check('blocked person cannot repost', (await api(B, 'POST', `/api/posts/${ap.id}/repost`, {})).status === 403);
    check('blocked person cannot follow', (await api(B, 'POST', '/api/follow/alice')).status === 403);
    const before = (await notifs(A)).notifications.length;
    await post(B, 'hey @alice are you there?');
    check('blocked person cannot notify you with a mention', (await notifs(A)).notifications.length === before);
    await api(A, 'DELETE', '/api/blocks/bobby');
    check('unblocking restores normal contact', (await api(B, 'POST', `/api/posts/${ap.id}/comments`, { body: 'hi again' })).status === 200);

    /* ============================================================ Circles */
    section('Circle member removal');
    await api(A, 'POST', '/api/circles', { name: 'Study Hall', description: 'quiet' });
    for (const t of [B, C, E, F]) await api(t, 'POST', '/api/circles/study-hall/join');
    await api(A, 'POST', '/api/circles/study-hall/role', { username: 'cara', role: 'mod' });
    await api(A, 'POST', '/api/circles/study-hall/role', { username: 'evey', role: 'mod' });
    check('a normal member cannot remove people', (await api(F, 'POST', '/api/circles/study-hall/members/bobby/remove', {})).status === 403);
    check('a moderator cannot remove another moderator', (await api(C, 'POST', '/api/circles/study-hall/members/evey/remove', {})).status === 403);
    check('nobody can remove the owner', (await api(C, 'POST', '/api/circles/study-hall/members/alice/remove', {})).status === 400);
    check('a moderator can remove and ban a member', (await api(C, 'POST', '/api/circles/study-hall/members/bobby/remove', { ban: true })).body.banned === true);
    check('the removed person is no longer a member', !(await api(B, 'GET', '/api/circles/study-hall')).body.isMember);
    check('a banned person cannot rejoin', (await api(B, 'POST', '/api/circles/study-hall/join')).status === 403);
    check('the removed person is told', has(await notifs(B), 'circle', 'banned from'));
    await api(C, 'POST', '/api/circles/study-hall/members/fred/remove', {});
    check('removal without a ban lets them rejoin', (await api(F, 'POST', '/api/circles/study-hall/join')).status === 200);

    /* ========================================================== reports */
    section('Reports reach admins');
    const rp = await post(A, 'a rude post');
    check('a post report is accepted', (await api(B, 'POST', `/api/posts/${rp.id}/report`, { category: 'harassment', note: 'rude to me' })).status === 200);
    check('reporting the same post twice does not double up', (await api(B, 'POST', `/api/posts/${rp.id}/report`, { category: 'harassment' })).body.duplicate === true);
    check('chat reports (older route) are accepted', (await api(B, 'POST', '/api/report', { channel: 'alice', username: 'alice', message: 'bad chat line', reason: 'test' })).status === 200);
    check('profiles can be reported', (await api(B, 'POST', '/api/reports', { type: 'user', target: 'alice', category: 'impersonation' })).status === 200);
    check('Circles can be reported', (await api(B, 'POST', '/api/reports', { type: 'circle', target: 'study-hall', category: 'spam' })).status === 200);
    check('streams can be reported', (await api(B, 'POST', '/api/reports', { type: 'stream', target: 'alice', category: 'violence' })).status === 200);
    const cm = (await api(B, 'POST', `/api/posts/${ap.id}/comments`, { body: 'a rude comment' })).body;
    check('comments can be reported', (await api(C, 'POST', '/api/reports', { type: 'comment', target: cm.id, category: 'harassment' })).status === 200);
    check('you cannot report yourself', (await api(A, 'POST', '/api/reports', { type: 'user', target: 'alice', category: 'other' })).status === 400);
    check('an unknown report type is refused', (await api(B, 'POST', '/api/reports', { type: 'nonsense', target: 'x' })).status === 400);
    check('reporting a missing post is refused', (await api(B, 'POST', '/api/reports', { type: 'post', target: 99999 })).status === 404);
    check('report reasons are offered', (await api(null, 'GET', '/api/report-categories')).body.categories.includes('self-harm'));
    await api(C, 'POST', '/api/reports', { type: 'user', target: 'fred', category: 'self-harm', note: 'worrying posts' });

    let q = (await api(X, 'GET', '/api/admin/reports')).body;
    check('admins can see the report queue', q.reports.length >= 7);
    check('urgent reports (self-harm) come first and are flagged', q.reports[0].priority === true && q.reports[0].category === 'self-harm');
    const pr = q.reports.find(r => r.type === 'post' && r.target === String(rp.id));
    check('a report shows the reporter, the person reported and the content', pr && pr.reporter === 'bobby' && pr.reported === 'alice' && pr.context === 'a rude post' && pr.category === 'harassment');
    check('filters work (by type)', (await api(X, 'GET', '/api/admin/reports?type=circle')).body.reports.every(r => r.type === 'circle'));
    check('resolving needs an action', (await api(X, 'POST', `/api/admin/reports/${pr.id}/resolve`, {})).status === 400);
    check('warning needs a reason the person will see', (await api(X, 'POST', `/api/admin/reports/${pr.id}/resolve`, { action: 'warn' })).status === 400);
    check('admin can delete reported content', (await api(X, 'POST', `/api/admin/reports/${pr.id}/resolve`, { action: 'delete_content', note: 'rude' })).status === 200 && (await api(null, 'GET', `/api/posts/${rp.id}`)).status === 404);
    check('the person who reported is told it was handled', has(await notifs(B), 'system', 'took action'));
    check('a handled report cannot be handled twice', (await api(X, 'POST', `/api/admin/reports/${pr.id}/resolve`, { action: 'dismiss' })).status === 400);
    const ur = (await api(X, 'GET', '/api/admin/reports')).body.reports.find(r => r.type === 'user' && r.target === 'alice');
    check('admin can dismiss a report', (await api(X, 'POST', `/api/admin/reports/${ur.id}/resolve`, { action: 'dismiss' })).status === 200);
    check('dismissal tells the reporter nothing was needed', has(await notifs(B), 'system', 'no action was needed'));
    const cr = (await api(X, 'GET', '/api/admin/reports')).body.reports.find(r => r.type === 'comment');
    check('admin can warn the person reported', (await api(X, 'POST', `/api/admin/reports/${cr.id}/resolve`, { action: 'warn', note: 'please be kind' })).status === 200 && has(await notifs(B), 'system', 'Warning from NovaStream staff: please be kind'));
    check('safety messages arrive even if that alert type is off', (await api(B, 'PUT', '/api/notifications/prefs', { prefs: { comment: false, mention: false, follow: false } })).status === 200 && (await api(X, 'POST', '/api/admin/users/' + U.bobby.user.id + '/action', { action: 'warn', reason: 'second reminder' })).status === 200 && has(await notifs(B), 'system', 'second reminder'));
    const dash = (await api(A, 'GET', '/api/dashboard')).body;
    check('channel owners still see chat reports about their channel', dash.reports.some(r => r.message === 'bad chat line'));
    const resolvedList = (await api(X, 'GET', '/api/admin/reports?status=resolved')).body;
    check('resolved reports are kept with what was decided', resolvedList.reports.length >= 3 && resolvedList.reports.every(r => r.resolution));

    /* ============================================ suspend, ban, appeals */
    section('Suspensions, bans and appeals');
    const dSock = await connect(D); let dKicked = false; dSock.on('disconnect', () => { dKicked = true; });
    check('suspending needs a reason', (await api(X, 'POST', `/api/admin/users/${U.dane.user.id}/action`, { action: 'suspend', hours: 24 })).status === 400);
    check('admin can suspend an account', (await api(X, 'POST', `/api/admin/users/${U.dane.user.id}/action`, { action: 'suspend', hours: 24, reason: 'harassing another member' })).status === 200);
    await sleep(300);
    check('suspending signs the person out of live connections', dKicked);
    const sus = await api(null, 'POST', '/api/login', { username: 'dane', password: 'password123' });
    check('a suspended person cannot log in and is told why', sus.status === 403 && sus.body.suspended === true && sus.body.error.includes('harassing another member'));
    check('their old session stops working', [401, 403].includes((await api(D, 'GET', '/api/me')).status));
    check('they can still browse as a guest', (await api(D, 'GET', '/api/streams')).status === 200);
    check('an admin cannot suspend themselves', (await api(X, 'POST', `/api/admin/users/${ADM.user.id}/action`, { action: 'suspend', hours: 1, reason: 'oops' })).status === 400);
    check('appeals need the right password', (await api(null, 'POST', '/api/appeal', { username: 'dane', password: 'wrongwrong', message: 'please let me back in' })).status === 401);
    check('appeals need a real message', (await api(null, 'POST', '/api/appeal', { username: 'dane', password: 'password123', message: 'hi' })).status === 400);
    check('a suspended person can appeal', (await api(null, 'POST', '/api/appeal', { username: 'dane', password: 'password123', message: 'I am sorry and will be kinder.' })).status === 200);
    check('only one open appeal at a time', (await api(null, 'POST', '/api/appeal', { username: 'dane', password: 'password123', message: 'a second appeal message' })).status === 409);
    check('people who are not suspended cannot appeal', (await api(null, 'POST', '/api/appeal', { username: 'alice', password: 'password123', message: 'not suspended at all' })).status === 400);
    const ap1 = (await api(X, 'GET', '/api/admin/appeals')).body.appeals[0];
    check('admins see appeals with the account and reason', ap1 && ap1.username === 'dane' && ap1.reason === 'harassing another member');
    check('an appeal needs a written reply', (await api(X, 'POST', `/api/admin/appeals/${ap1.id}/resolve`, { decision: 'reject' })).status === 400);
    check('admin can reject an appeal', (await api(X, 'POST', `/api/admin/appeals/${ap1.id}/resolve`, { decision: 'reject', response: 'Please wait out the suspension.' })).status === 200);
    check('still suspended after a rejection', (await api(null, 'POST', '/api/login', { username: 'dane', password: 'password123' })).status === 403);
    await api(null, 'POST', '/api/appeal', { username: 'dane', password: 'password123', message: 'Second appeal: it will not happen again.' });
    const ap2 = (await api(X, 'GET', '/api/admin/appeals')).body.appeals[0];
    check('admin can approve an appeal', (await api(X, 'POST', `/api/admin/appeals/${ap2.id}/resolve`, { decision: 'approve', response: 'Welcome back.' })).status === 200);
    const back = await api(null, 'POST', '/api/login', { username: 'dane', password: 'password123' });
    check('an approved appeal restores the account', back.status === 200);
    check('the person is told the appeal was approved', has(await notifs(back.body.token), 'system', 'appeal was approved'));
    const hist = (await api(X, 'GET', '/api/admin/users/' + U.dane.user.id)).body;
    check('each account keeps a violation and appeal history', hist.history.some(h => h.action.startsWith('suspend')) && hist.history.some(h => h.action === 'appeal_rejected') && hist.history.some(h => h.action === 'appeal_approved'));

    const bSock = await connect(B); let bKicked = false; bSock.on('disconnect', () => { bKicked = true; });
    await api(X, 'POST', `/api/admin/users/${U.bobby.user.id}/action`, { action: 'ban', reason: 'repeated harassment' });
    await sleep(300);
    const bn = await api(null, 'POST', '/api/login', { username: 'bobby', password: 'password123' });
    check('a banned account cannot log in', bn.status === 403 && bn.body.banned === true);
    check('banning disconnects live sessions', bKicked);
    await api(X, 'POST', `/api/admin/users/${U.bobby.user.id}/action`, { action: 'unban', reason: 'reviewed' });
    check('an admin can lift a ban', (await api(null, 'POST', '/api/login', { username: 'bobby', password: 'password123' })).status === 200);
    const suspendViaReport = await api(F, 'POST', '/api/reports', { type: 'user', target: 'bobby', category: 'harassment' });
    const rr = (await api(X, 'GET', '/api/admin/reports')).body.reports.find(r => r.type === 'user' && r.target === 'bobby');
    check('a report can lead straight to a suspension', suspendViaReport.status === 200 && (await api(X, 'POST', `/api/admin/reports/${rr.id}/resolve`, { action: 'suspend', hours: 2, note: 'cooling off' })).status === 200 && (await api(null, 'POST', '/api/login', { username: 'bobby', password: 'password123' })).status === 403);
    await api(X, 'POST', `/api/admin/users/${U.bobby.user.id}/action`, { action: 'unban' });
    const newB = (await api(null, 'POST', '/api/login', { username: 'bobby', password: 'password123' })).body.token;

    /* =========================================================== accounts */
    section('Account management (admin)');
    const ul = (await api(X, 'GET', '/api/admin/users?q=ali')).body;
    check('admin can search accounts', ul.users.length === 1 && ul.users[0].username === 'alice');
    check('the list shows teen status, posts and reports against', typeof ul.users[0].teen === 'boolean' && ul.users[0].posts > 0 && ul.users[0].reportsAgainst >= 1);
    check('admin can filter to restricted accounts', (await api(X, 'GET', '/api/admin/users?status=restricted')).body.users.every(u => u.status !== 'active'));
    check('admin can verify a creator', (await api(X, 'POST', `/api/admin/users/${U.alice.user.id}/action`, { action: 'verify' })).status === 200 && (await api(null, 'GET', '/api/profile/alice')).body.verified === true);
    check('the tick shows on posts', (await api(null, 'GET', '/api/feed')).body.posts.some(p => p.author.username === 'alice' && p.author.verified === true));
    await api(X, 'POST', `/api/admin/users/${U.alice.user.id}/action`, { action: 'unverify' });
    check('admin can remove a tick', (await api(null, 'GET', '/api/profile/alice')).body.verified === false);
    await api(A, 'PUT', '/api/profile', { displayName: 'Alice A', bio: 'some bio text' });
    await api(X, 'POST', `/api/admin/users/${U.alice.user.id}/action`, { action: 'clear_profile', reason: 'inappropriate bio' });
    check('admin can clear a profile', (await api(null, 'GET', '/api/profile/alice')).body.bio === '');
    check('admin can make and remove admins', (await api(X, 'POST', `/api/admin/users/${U.fred.user.id}/action`, { action: 'make_admin' })).status === 200 && (await api(F, 'GET', '/api/admin/overview')).status === 200);
    check('an admin cannot be banned without removing the role first', (await api(X, 'POST', `/api/admin/users/${U.fred.user.id}/action`, { action: 'ban', reason: 'testing' })).status === 400);
    check('an admin cannot remove their own admin role', (await api(X, 'POST', `/api/admin/users/${ADM.user.id}/action`, { action: 'remove_admin' })).status === 400);
    await api(X, 'POST', `/api/admin/users/${U.fred.user.id}/action`, { action: 'remove_admin' });
    check('removing admin removes access immediately', (await api(F, 'GET', '/api/admin/overview')).status === 403);
    check('admin can sign someone out everywhere', (await api(X, 'POST', `/api/admin/users/${U.fred.user.id}/action`, { action: 'logout' })).status === 200 && (await api(F, 'GET', '/api/me')).status === 401);
    const fredToken = (await api(null, 'POST', '/api/login', { username: 'fred', password: 'password123' })).body.token;
    const detail = (await api(X, 'GET', '/api/admin/users/' + U.alice.user.id)).body;
    check('account detail shows reports, circles and recent posts', detail.reports.length >= 1 && detail.circles.length >= 1 && detail.posts.length >= 1);

    section('Account recovery and self-service');
    const code = (await api(X, 'POST', `/api/admin/users/${U.cara.user.id}/action`, { action: 'reset_code' })).body;
    check('admin can issue a one-time recovery code', typeof code.code === 'string' && code.code.length === 10);
    check('a wrong code does not work', (await api(null, 'POST', '/api/reset-password', { username: 'cara', code: 'AAAAAAAAAA', newPassword: 'brandnewpass1' })).status === 400);
    check('a short new password is refused', (await api(null, 'POST', '/api/reset-password', { username: 'cara', code: code.code, newPassword: 'short' })).status === 400);
    check('the right code resets the password', (await api(null, 'POST', '/api/reset-password', { username: 'cara', code: code.code, newPassword: 'brandnewpass1' })).status === 200);
    check('the old password stops working', (await api(null, 'POST', '/api/login', { username: 'cara', password: 'password123' })).status === 401);
    check('the new password works', (await api(null, 'POST', '/api/login', { username: 'cara', password: 'brandnewpass1' })).status === 200);
    check('old sessions are signed out by a reset', (await api(C, 'GET', '/api/me')).status === 401);
    check('a code only works once', (await api(null, 'POST', '/api/reset-password', { username: 'cara', code: code.code, newPassword: 'anotherpass12' })).status === 400);

    check('changing your password needs the current one', (await api(newB, 'PUT', '/api/account/password', { current: 'wrongwrong', next: 'newpassword99' })).status === 400);
    check('the new password must be long enough', (await api(newB, 'PUT', '/api/account/password', { current: 'password123', next: 'short' })).status === 400);
    const pw = await api(newB, 'PUT', '/api/account/password', { current: 'password123', next: 'newpassword99' });
    check('you can change your password', pw.status === 200 && !!pw.body.token);
    check('other sessions are signed out when you change it', (await api(newB, 'GET', '/api/me')).status === 401);
    check('the fresh session keeps working', (await api(pw.body.token, 'GET', '/api/me')).status === 200);
    check('the old password no longer logs in', (await api(null, 'POST', '/api/login', { username: 'bobby', password: 'password123' })).status === 401);
    const lo = await api(pw.body.token, 'POST', '/api/account/logout-all');
    check('"log out of all devices" revokes every session', lo.status === 200 && (await api(pw.body.token, 'GET', '/api/me')).status === 401 && (await api(lo.body.token, 'GET', '/api/me')).status === 200);
    const bobbyTok = lo.body.token;

    const exp = await api(bobbyTok, 'GET', '/api/account/export');
    const expText = JSON.stringify(exp.body);
    check('you can download your data', exp.status === 200 && exp.body.account.username === 'bobby' && Array.isArray(exp.body.posts) && Array.isArray(exp.body.moderationHistory));
    check('the export never contains the password hash', !expText.includes('$2') && !expText.includes('pass_hash'));

    await post(E, 'a post by evey that will disappear');
    await api(E, 'POST', '/api/circles', { name: 'Evey Club' });
    await api(F === null ? E : fredToken, 'POST', '/api/circles/evey-club/join');
    const eveyPostCount = (await api(X, 'GET', '/api/admin/posts?q=evey')).body.posts.length;
    check('deleting needs your password', (await api(E, 'POST', '/api/account/delete', { password: 'nope-nope' })).status === 400);
    check('you can delete your account', (await api(E, 'POST', '/api/account/delete', { password: 'password123' })).status === 200);
    check('the deleted account cannot log in', (await api(null, 'POST', '/api/login', { username: 'evey', password: 'password123' })).status === 401);
    check('their posts are removed too', eveyPostCount >= 1 && (await api(X, 'GET', '/api/admin/posts?q=evey')).body.posts.filter(p => p.author === 'evey').length === 0);
    const ec = (await api(null, 'GET', '/api/circles/evey-club'));
    check('a Circle with members passes to a member when its owner leaves', ec.status === 200 && ec.body.owner.username === 'fred');
    check('the only admin cannot delete themselves', (await api(X, 'POST', '/api/account/delete', { password: 'password123' })).status === 400);
    check('admin can delete an account', (await api(X, 'POST', `/api/admin/users/${U.dane.user.id}/action`, { action: 'delete' })).status === 200 && (await api(null, 'GET', '/api/profile/dane')).status === 404);

    /* ====================================================== live streams */
    section('Live stream takedown');
    const host = await connect(A);
    await emit(host, 'host', { title: 'Alice live', category: 'Gaming' });
    const viewer = await connect(fredToken); let ended = false;
    viewer.on('stream-ended', () => { ended = true; });
    await emit(viewer, 'watch', { channel: 'alice' });
    const sl = (await api(X, 'GET', '/api/admin/streams')).body.streams;
    check('admins can see everything live', sl.length === 1 && sl[0].channel === 'alice' && sl[0].viewers === 1);
    check('ending a stream needs a live stream', (await api(X, 'POST', '/api/admin/streams/nobody/end', { reason: 'x' })).status === 404);
    check('admin can end a live stream', (await api(X, 'POST', '/api/admin/streams/alice/end', { reason: 'violent content' })).status === 200);
    await sleep(200);
    check('viewers are told it ended', ended);
    check('the stream disappears from the site', (await api(null, 'GET', '/api/streams')).body.streams.length === 0);
    check('the streamer is told why', has(await notifs(A), 'system', 'violent content'));
    host.close(); viewer.close();

    /* ============================================ content and Circles */
    section('Content management');
    const cp = await post(A, 'a post to search for: zebra crossing');
    await api(fredToken, 'POST', `/api/posts/${cp.id}/comments`, { body: 'comment to remove' });
    const sp = (await api(X, 'GET', '/api/admin/posts?q=zebra')).body.posts;
    check('admin can search all posts', sp.length === 1 && sp[0].author === 'alice');
    const cmts = (await api(null, 'GET', `/api/posts/${cp.id}/comments`)).body.comments;
    check('admin can delete a comment', (await api(X, 'DELETE', `/api/admin/comments/${cmts[0].id}`)).status === 200 && (await api(null, 'GET', `/api/posts/${cp.id}/comments`)).body.comments.length === 0);
    check('admin can delete a post', (await api(X, 'DELETE', `/api/admin/posts/${cp.id}`)).status === 200 && (await api(null, 'GET', `/api/posts/${cp.id}`)).status === 404);
    await api(fredToken, 'POST', '/api/posts', { body: 'inside the circle', circle: 'study-hall' });
    const cl = (await api(X, 'GET', '/api/admin/circles')).body.circles;
    const sh = cl.find(c => c.slug === 'study-hall');
    check('admin can see every Circle with its owner and size', sh && sh.owner === 'alice' && sh.members >= 3 && sh.reports >= 1);
    check('admin can delete a Circle', (await api(X, 'DELETE', `/api/admin/circles/${sh.id}`)).status === 200 && (await api(null, 'GET', '/api/circles/study-hall')).status === 404);
    check('deleting a Circle removes its posts', !(await api(X, 'GET', '/api/admin/posts?q=inside')).body.posts.some(p => p.body === 'inside the circle'));

    /* ====================================== settings and site controls */
    section('Site settings');
    check('settings can be read', (await api(X, 'GET', '/api/admin/settings')).body.settings.maxViewers === 25);
    check('invalid settings are refused', (await api(X, 'PUT', '/api/admin/settings', { maxViewers: 0 })).status === 400 && (await api(X, 'PUT', '/api/admin/settings', { announcementLevel: 'purple' })).status === 400);
    await api(X, 'PUT', '/api/admin/settings', { announcement: 'Maintenance tonight at 9pm', announcementLevel: 'warning' });
    const site = (await api(null, 'GET', '/api/site')).body;
    check('an announcement banner reaches everyone', site.announcement === 'Maintenance tonight at 9pm' && site.announcementLevel === 'warning');
    await api(X, 'PUT', '/api/admin/settings', { announcement: '' });

    await api(X, 'PUT', '/api/admin/settings', { registrationOpen: false });
    check('admin can pause sign-ups', (await api(null, 'POST', '/api/register', { username: 'latecomer', password: 'password123', dob: '2000-01-01', acceptTerms: true })).status === 403);
    await api(X, 'PUT', '/api/admin/settings', { registrationOpen: true });
    check('and reopen them', (await api(null, 'POST', '/api/register', { username: 'latecomer', password: 'password123', dob: '2000-01-01', acceptTerms: true })).status === 200);

    await api(X, 'PUT', '/api/admin/settings', { maxViewers: 1 });
    const h2 = await connect(A); await emit(h2, 'host', { title: 'cap test', category: 'Gaming' });
    const v1 = await connect(fredToken), v2 = await connect(bobbyTok);
    await emit(v1, 'watch', { channel: 'alice' });
    const full = await emit(v2, 'watch', { channel: 'alice' });
    check('the room size limit can be changed live', !!full.error && /full/i.test(full.error));
    await api(X, 'PUT', '/api/admin/settings', { maxViewers: 25 });
    h2.emit('end'); await sleep(250); h2.close(); v1.close(); v2.close(); await sleep(150);

    await api(X, 'PUT', '/api/admin/settings', { maintenance: true, maintenanceMessage: 'Back soon!' });
    const mp = await api(bobbyTok, 'POST', '/api/posts', { body: 'during maintenance' });
    check('maintenance mode pauses posting for normal users', mp.status === 503 && mp.body.maintenance === true && mp.body.error === 'Back soon!');
    check('browsing keeps working during maintenance', (await api(null, 'GET', '/api/feed')).status === 200);
    check('logging in keeps working during maintenance', (await api(null, 'POST', '/api/login', { username: 'bobby', password: 'newpassword99' })).status === 200);
    check('admins can still act during maintenance', (await api(X, 'POST', '/api/posts', { body: 'admin post during maintenance' })).status === 200);
    const mh = await connect(A);
    check('going live is paused during maintenance', /Back soon/.test((await emit(mh, 'host', { title: 'x' })).error || ''));
    mh.close();
    await api(X, 'PUT', '/api/admin/settings', { maintenance: false });
    check('maintenance mode can be switched off', (await api(bobbyTok, 'POST', '/api/posts', { body: 'after maintenance' })).status === 200);

    await api(X, 'PUT', '/api/admin/settings', { minAccountAgeMin: 60 });
    const h3 = await connect(A); await emit(h3, 'host', { title: 'age test', category: 'Gaming' });
    let st; h3.on('room-state', s => { st = s; });
    const nv = await connect(fredToken); await emit(nv, 'watch', { channel: 'alice' });
    for (let i = 0; i < 40 && !(st && st.viewerCount >= 1); i++) await sleep(50);
    check('the anti-bot account-age rule can be turned on', st && st.earlyBirds.length === 0);
    check('the appreciation text states the rule when it is on', (await api(null, 'GET', '/api/profile/alice')).body.appreciation.parts[0].label.includes('60 min'));
    await api(X, 'PUT', '/api/admin/settings', { minAccountAgeMin: 0 });
    h3.emit('end'); await sleep(250); h3.close(); nv.close(); await sleep(150);
    check('the appreciation text does not claim a rule that is off', !(await api(null, 'GET', '/api/profile/alice')).body.appreciation.parts[0].label.includes('newer than'));

    await api(X, 'PUT', '/api/admin/settings', { postCooldownMs: 5000 });
    await api(bobbyTok, 'POST', '/api/posts', { body: 'first quick post' });
    const quick = await api(bobbyTok, 'POST', '/api/posts', { body: 'second quick post' });
    check('the post cooldown can be changed live and errors are readable', quick.status === 429 && /wait/i.test(quick.body.error));
    await api(X, 'PUT', '/api/admin/settings', { postCooldownMs: 0 });

    /* ========================================= events, backups, monitoring */
    section('Event reminders');
    await api(A, 'POST', '/api/circles', { name: 'Reminder Room' });
    await api(fredToken, 'POST', '/api/circles/reminder-room/join');
    const soon = (await api(A, 'POST', '/api/circles/reminder-room/events', { title: 'Soon event', startsAt: Date.now() + 30 * 60000 })).body.id;
    const later = (await api(A, 'POST', '/api/circles/reminder-room/events', { title: 'Later event', startsAt: Date.now() + 3 * 3600000 })).body.id;
    await api(fredToken, 'POST', `/api/circles/reminder-room/events/${soon}/rsvp`);
    await api(fredToken, 'POST', `/api/circles/reminder-room/events/${later}/rsvp`);
    await sleep(1200);
    const fn = await notifs(fredToken);
    check('people who RSVP get a reminder before an event starts', has(fn, 'event', 'Starting in') && fn.notifications.some(n => n.text.includes('Soon event') && n.text.includes('Starting in')));
    check('no reminder is sent too early', !fn.notifications.some(n => n.text.includes('Starting in') && n.text.includes('Later event')));
    await sleep(900);
    check('each reminder is sent only once', (await notifs(fredToken)).notifications.filter(n => n.text.includes('Starting in') && n.text.includes('Soon event')).length === 1);

    section('Backups, monitoring and the audit log');
    const mb = await api(X, 'POST', '/api/admin/backups');
    check('admin can create a backup', mb.status === 200 && /^manual-\d{14}/.test(mb.body.name));
    const bl = (await api(X, 'GET', '/api/admin/backups')).body;
    check('backups are listed', bl.backups.some(b => b.name === mb.body.name && b.size > 1000));
    check('automatic daily backups are made', bl.backups.some(b => b.kind === 'auto'));
    const dl = await fetch(BASE + '/api/admin/backups/' + mb.body.name, { headers: { Authorization: 'Bearer ' + X } });
    const head = Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString();
    check('a backup downloads as a real database file', dl.status === 200 && head === 'SQLite format 3');
    check('backup names cannot escape the folder', (await api(X, 'GET', '/api/admin/backups/..%2Fserver.js')).status === 404);
    check('normal users cannot download backups', (await api(A, 'GET', '/api/admin/backups/' + mb.body.name)).status === 403);

    const ov = (await api(X, 'GET', '/api/admin/overview')).body;
    check('overview shows people, content and live activity', ov.counts.users >= 6 && ov.counts.circles >= 1 && typeof ov.counts.live === 'number' && ov.counts.admins >= 1);
    check('overview shows server health', ov.system.uptimeSec >= 0 && ov.system.memoryMb > 0 && ov.system.dbMb >= 0 && ov.system.node.startsWith('v'));
    check('overview warns about risky settings', ov.warnings.some(w => /anti-bot/i.test(w.text)) && ov.warnings.some(w => /TURN/.test(w.text)));
    check('overview lists open reports and appeals', typeof ov.counts.openReports === 'number' && typeof ov.counts.openAppeals === 'number');
    const au = (await api(X, 'GET', '/api/admin/audit')).body.entries;
    const acts = au.map(a => a.action);
    check('every admin action is written to an audit log', ['user_suspend', 'user_ban', 'settings_change', 'backup_create', 'report_warn', 'stream_end', 'word_add', 'appeal_approve'].every(a => acts.includes(a)));
    check('the audit log says who did it', au.every(a => a.admin === 'siteadmin' && a.at > 0));

    /* ================================================== readable errors */
    section('Readable errors');
    const bad = await fetch(BASE + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bobbyTok }, body: '{broken' });
    check('malformed requests give a readable JSON error', bad.status === 400 && (await bad.json()).error.length > 5);
    const nf = await api(null, 'GET', '/api/does-not-exist');
    check('unknown API paths give a readable JSON error', nf.status === 404 && !!nf.body.error);
    let last;
    for (let i = 0; i < 70; i++) { last = await api(null, 'POST', '/api/login', { username: 'alice', password: 'wrong' + i }); if (last.status === 429) break; }
    check('rate limits give a readable JSON error, not plain text', last.status === 429 && last.ct.includes('json') && /too many/i.test(last.body.error));
  } catch (e) {
    console.error(e); failures++;
  } finally {
    server.kill('SIGTERM');
    console.log(failures ? `\n${failures} of ${total} check(s) FAILED` : `\nAll ${total} promise checks passed`);
    process.exit(failures ? 1 : 0);
  }
})();
