'use strict';
// Phase 2: feed, Circles, notifications, search, discovery, appreciation score, achievements, analytics.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, total = 0;
const check = (name, cond) => { total++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

const api = async (tok, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const connect = token => new Promise(res => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise(res => s.emit(ev, p, res));
const notifs = async tok => (await api(tok, 'GET', '/api/notifications')).body;
const hasNotif = (n, type, text) => n.notifications.some(x => x.type === type && (!text || x.text.includes(text)));

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, POST_COOLDOWN_MS: '0', DB_PATH: path.join(os.tmpdir(), `novastream-p2-${Date.now()}.db`) },
    stdio: 'inherit'
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* wait */ } await sleep(150); }
    const U = {};
    for (const n of ['alice', 'bobby', 'cara', 'dane', 'evey']) {
      U[n] = (await api(null, 'POST', '/api/register', { username: n, password: 'password123', dob: '2000-01-01', acceptTerms: true })).body;
    }
    const T = n => U[n].token;
    const A = T('alice'), B = T('bobby'), C = T('cara'), D = T('dane'), E = T('evey');

    /* ----------------------------------------------------------- feed */
    check('guest cannot post', (await api(null, 'POST', '/api/posts', { body: 'hi' })).status === 401);
    check('empty post rejected', (await api(A, 'POST', '/api/posts', { body: '   ' })).status === 400);
    const p1 = (await api(A, 'POST', '/api/posts', { body: 'Welcome to my channel! Lofi study streams every night.', kind: 'update' })).body.post;
    check('user can publish a post', p1 && p1.id && p1.author.username === 'alice');
    check('first post unlocks an achievement', (await api(null, 'GET', '/api/profile/alice')).body.badges.some(b => b.code === 'first_post'));

    await api(B, 'POST', '/api/follow/alice');
    check('new follower notifies the creator', hasNotif(await notifs(A), 'follow', 'bobby followed you'));

    let r = await api(B, 'POST', `/api/posts/${p1.id}/react`, { emoji: '❤️' });
    check('reaction is added', r.body.reactions['❤️'] === 1 && r.body.myReaction === '❤️');
    r = await api(B, 'POST', `/api/posts/${p1.id}/react`, { emoji: '❤️' });
    check('same reaction again removes it', !r.body.reactions['❤️'] && r.body.myReaction === '');
    await api(B, 'POST', `/api/posts/${p1.id}/react`, { emoji: '❤️' });
    r = await api(B, 'POST', `/api/posts/${p1.id}/react`, { emoji: '🔥' });
    check('a different reaction replaces it (one per person)', r.body.reactions['🔥'] === 1 && !r.body.reactions['❤️']);
    check('unknown emoji rejected', (await api(B, 'POST', `/api/posts/${p1.id}/react`, { emoji: '💩' })).status === 400);

    const c1 = await api(B, 'POST', `/api/posts/${p1.id}/comments`, { body: '@cara come and see this!' });
    check('comment is saved', c1.status === 200);
    check('mention notifies the person mentioned', hasNotif(await notifs(C), 'mention', 'bobby mentioned you'));
    check('comment notifies the post author', hasNotif(await notifs(A), 'comment', 'bobby commented'));
    const c2 = await api(A, 'POST', `/api/posts/${p1.id}/comments`, { body: 'Thanks for coming!', replyTo: c1.body.id });
    check('threaded reply notifies the comment author', hasNotif(await notifs(B), 'comment', 'alice replied'));
    const cl = (await api(null, 'GET', `/api/posts/${p1.id}/comments`)).body.comments;
    check('replies show who they answer', cl.length === 2 && cl[1].replyTo && cl[1].replyTo.username === 'bobby');
    check('reply to a missing comment rejected', (await api(A, 'POST', `/api/posts/${p1.id}/comments`, { body: 'x', replyTo: 9999 })).status === 400);

    const rp = await api(C, 'POST', `/api/posts/${p1.id}/repost`, { body: 'worth a watch' });
    check('repost works and links the original', rp.body.post.isRepost && rp.body.post.original.id === p1.id);
    check('duplicate repost rejected', (await api(C, 'POST', `/api/posts/${p1.id}/repost`, {})).status === 409);
    check('cannot repost your own post', (await api(A, 'POST', `/api/posts/${p1.id}/repost`, {})).status === 400);

    const fb = (await api(B, 'GET', '/api/feed?scope=following')).body.posts;
    check('following feed shows posts from people you follow', fb.some(p => p.id === p1.id));
    const fe = (await api(E, 'GET', '/api/feed?scope=following')).body.posts;
    check('following feed hides strangers', !fe.some(p => p.id === p1.id));
    check('discover feed shows everyone', (await api(E, 'GET', '/api/feed')).body.posts.some(p => p.id === p1.id));
    await api(B, 'POST', '/api/blocks/alice');
    check('blocked authors vanish from your feed', !(await api(B, 'GET', '/api/feed')).body.posts.some(p => p.authorId === U.alice.user.id));
    await api(B, 'DELETE', '/api/blocks/alice');

    check('others cannot delete your post', (await api(C, 'DELETE', `/api/posts/${p1.id}`)).status === 403);
    check('post can be reported', (await api(C, 'POST', `/api/posts/${p1.id}/report`, { reason: 'test' })).status === 200);
    const p2 = (await api(A, 'POST', '/api/posts', { body: 'Temporary post' })).body.post;
    check('author can delete their post', (await api(A, 'DELETE', `/api/posts/${p2.id}`)).status === 200 && (await api(null, 'GET', `/api/posts/${p2.id}`)).status === 404);

    /* -------------------------------------------------------- circles */
    check('short circle name rejected', (await api(A, 'POST', '/api/circles', { name: 'ab' })).status === 400);
    const cc = await api(A, 'POST', '/api/circles', { name: 'Lofi Lounge', description: 'Chill study beats', emoji: '🎧', goalTitle: 'Reach 4 members', goalTarget: 4 });
    check('creator can start a Circle', cc.body.slug === 'lofi-lounge');
    check('duplicate Circle address rejected', (await api(B, 'POST', '/api/circles', { name: 'Lofi Lounge' })).status === 409);
    check('founder badge awarded', (await api(null, 'GET', '/api/profile/alice')).body.badges.some(b => b.code === 'circle_founder'));
    await api(B, 'POST', '/api/circles/lofi-lounge/join');
    let det = (await api(B, 'GET', '/api/circles/lofi-lounge')).body;
    check('member can join and is listed', det.isMember && det.members.length === 2 && det.role === 'member');
    check('owner is told about new members', hasNotif(await notifs(A), 'circle', 'bobby joined'));
    check('outsider cannot post in a Circle', (await api(C, 'POST', '/api/posts', { body: 'hi', circle: 'lofi-lounge' })).status === 403);
    const cp = await api(B, 'POST', '/api/posts', { body: 'Hi everyone, I love lofi!', circle: 'lofi-lounge' });
    check('member can post in a Circle', cp.status === 200 && cp.body.post.circle.slug === 'lofi-lounge');
    check('first contribution is celebrated', hasNotif(await notifs(B), 'achievement', 'First contribution'));
    check('members cannot post announcements', (await api(B, 'POST', '/api/posts', { body: 'Big news', circle: 'lofi-lounge', kind: 'announcement' })).status === 403);
    check('owner can post announcements', (await api(A, 'POST', '/api/posts', { body: 'Friday listening party!', circle: 'lofi-lounge', kind: 'announcement' })).status === 200);
    check('members are notified of announcements', hasNotif(await notifs(B), 'circle', 'Friday listening party'));
    const cf = (await api(B, 'GET', '/api/feed?circle=lofi-lounge')).body.posts;
    check('Circle feed lists its posts', cf.length === 2 && cf.every(p => p.circle && p.circle.slug === 'lofi-lounge'));
    check('Circle posts cannot be reposted outside', (await api(C, 'POST', `/api/posts/${cf[0].id}/repost`, {})).status === 400);

    const soon = Date.now() + 3600000;
    check('members cannot schedule events', (await api(B, 'POST', '/api/circles/lofi-lounge/events', { title: 'Listening party', startsAt: soon })).status === 403);
    check('past events rejected', (await api(A, 'POST', '/api/circles/lofi-lounge/events', { title: 'Old', startsAt: Date.now() - 1000 })).status === 400);
    const ev = await api(A, 'POST', '/api/circles/lofi-lounge/events', { title: 'Listening party', description: 'Bring snacks', startsAt: soon });
    check('owner schedules an event', ev.status === 200);
    check('members are notified of events', hasNotif(await notifs(B), 'event', 'Listening party'));
    check('member can RSVP', (await api(B, 'POST', `/api/circles/lofi-lounge/events/${ev.body.id}/rsvp`)).body.going === true);
    check('non-members cannot RSVP', (await api(C, 'POST', `/api/circles/lofi-lounge/events/${ev.body.id}/rsvp`)).status === 403);
    det = (await api(B, 'GET', '/api/circles/lofi-lounge')).body;
    check('event shows RSVP count', det.events.length === 1 && det.events[0].rsvps === 1 && det.events[0].going);

    check('only the owner can promote moderators', (await api(B, 'POST', '/api/circles/lofi-lounge/role', { username: 'bobby', role: 'mod' })).status === 403);
    await api(A, 'POST', '/api/circles/lofi-lounge/role', { username: 'bobby', role: 'mod' });
    check('a Circle moderator can schedule events', (await api(B, 'POST', '/api/circles/lofi-lounge/events', { title: 'Mod movie night', startsAt: soon + 1000 })).status === 200);
    check('owner cannot leave their Circle', (await api(A, 'POST', '/api/circles/lofi-lounge/leave')).status === 400);
    await api(C, 'POST', '/api/circles/lofi-lounge/join');
    await api(C, 'POST', '/api/circles/lofi-lounge/leave');
    check('members can leave', !(await api(C, 'GET', '/api/circles/lofi-lounge')).body.isMember);
    await api(C, 'POST', '/api/circles/lofi-lounge/join');
    await api(D, 'POST', '/api/circles/lofi-lounge/join');
    det = (await api(A, 'GET', '/api/circles/lofi-lounge')).body;
    check('Circle goal completes', det.goal && det.goal.done && det.goal.progress === 4);
    check('shared history records milestones', det.milestones.some(m => m.label.startsWith('Goal reached')) && det.milestones.some(m => m.label === 'Circle created'));
    const bobBadges = det.members.find(m => m.username === 'bobby').badges.map(b => b.label);
    check('members earn Circle badges', ['Moderator', 'Founding member', 'First contribution'].every(l => bobBadges.includes(l)));
    check('"my Circles" filter works', (await api(D, 'GET', '/api/circles?mine=1')).body.circles.length === 1 && (await api(E, 'GET', '/api/circles?mine=1')).body.circles.length === 0);

    /* -------------------------------------------------- notifications */
    const before = (await notifs(C)).notifications.length;
    await api(C, 'PUT', '/api/notifications/prefs', { prefs: { mention: false } });
    await api(B, 'POST', '/api/posts', { body: 'Hey @cara, this is a second mention' });
    const nc = await notifs(C);
    check('turned-off notification types are not delivered', nc.notifications.length === before && nc.prefs.mention === false);
    check('unread count is tracked', nc.unread > 0);
    await api(C, 'POST', '/api/notifications/read');
    check('mark all read works', (await notifs(C)).unread === 0);
    const me = (await api(C, 'GET', '/api/me')).body;
    check('/api/me reports unread count', me.unread === 0);

    const dSock = await connect(D);
    const dGot = [];
    dSock.on('notify', n => dGot.push(n));
    const hr = new Date().getUTCHours();
    await api(D, 'PUT', '/api/notifications/prefs', { quietStart: hr, quietEnd: (hr + 1) % 24, tzOffset: 0 });
    await api(B, 'POST', '/api/posts', { body: 'quiet time ping @dane one' });
    await sleep(200);
    check('quiet hours: saved to the inbox', hasNotif(await notifs(D), 'mention', 'bobby mentioned you'));
    check('quiet hours: no live pop-up', dGot.filter(n => n.type === 'mention').length === 0);
    await api(D, 'PUT', '/api/notifications/prefs', { quietStart: -1, quietEnd: -1 });
    await api(B, 'POST', '/api/posts', { body: 'awake now ping @dane two' });
    await sleep(200);
    check('outside quiet hours: live pop-up arrives', dGot.some(n => n.type === 'mention'));

    await api(C, 'PUT', '/api/notifications/prefs', { prefs: { mention: true } });

    /* ----------------------------------------------- live + chat hooks */
    const host = await connect(A);
    await emit(host, 'watch', { channel: 'alice' });
    const lastState = {};
    host.on('room-state', s => { lastState.s = s; });
    await api(B, 'POST', '/api/follow/alice');
    await api(C, 'POST', '/api/follow/alice');
    await emit(host, 'host', { title: 'Lofi study night', category: 'Education', tags: ['lofi', 'study'], description: 'Study with me' });
    await sleep(150);
    check('followers are told when a stream starts', hasNotif(await notifs(B), 'live', 'alice is live'));
    check('streamer achievement awarded', (await api(null, 'GET', '/api/profile/alice')).body.badges.some(b => b.code === 'streamer'));

    const bSock = await connect(B), cSock = await connect(C), dSock2 = await connect(D);
    for (const s of [bSock, cSock, dSock2]) { await emit(s, 'watch', { channel: 'alice' }); await sleep(40); }
    await sleep(100);
    check('Early Bird achievement awarded', (await api(null, 'GET', '/api/profile/bobby')).body.badges.some(b => b.code === 'early_bird'));
    await emit(cSock, 'chat', { text: 'hello from cara' });
    await sleep(100);
    let chats = [];
    host.on('chat', m => chats.push(m));
    await sleep(900);
    await emit(cSock, 'chat', { text: '@bobby are you here?' });
    await sleep(100);
    check('chat mention notifies the person', hasNotif(await notifs(B), 'mention', 'cara mentioned you'));
    const target = chats.filter(m => !m.system).pop();
    await sleep(900);
    await emit(bSock, 'chat', { text: 'yes I am', replyTo: target.id });
    await sleep(100);
    const rep = chats.filter(m => !m.system).pop();
    check('chat replies carry the original message', rep.reply && rep.reply.username === 'cara' && rep.reply.id === target.id);
    check('chat reply notifies the original author', hasNotif(await notifs(C), 'mention', 'bobby replied to you'));
    await sleep(900);
    await emit(bSock, 'pin', { text: 'What do you study?' });
    await sleep(100);
    const pin = lastState.s.pins.visible[0];
    await emit(host, 'answer', { pinId: pin.id });
    await sleep(100);
    check('answered pin notifies the asker', hasNotif(await notifs(B), 'answered', 'answered your pinned question'));
    check('asker earns the helper achievement', (await api(null, 'GET', '/api/profile/bobby')).body.badges.some(b => b.code === 'helper'));

    /* ----------------------------------------- search and discovery */
    check('search needs 2+ letters or a filter', !!(await api(null, 'GET', '/api/search?q=a')).body.hint);
    let s = (await api(B, 'GET', '/api/search?q=alic')).body;
    check('search finds people', s.users.some(u => u.username === 'alice' && u.live));
    s = (await api(B, 'GET', '/api/search?q=lofi')).body;
    check('search finds live streams by title or tag', s.streams.length === 1 && s.streams[0].username === 'alice');
    check('search finds Circles', s.circles.some(c => c.slug === 'lofi-lounge'));
    check('search finds public posts', s.posts.some(p => p.id === p1.id));
    check('search never returns Circle-only posts', !s.posts.some(p => p.circle));
    check('category filter narrows streams', (await api(B, 'GET', '/api/search?category=Gaming')).body.streams.length === 0 && (await api(B, 'GET', '/api/search?category=Education')).body.streams.length === 1);
    check('"live only" filter works', (await api(B, 'GET', '/api/search?q=alic&live=1')).body.users.length === 1 && (await api(B, 'GET', '/api/search?q=cara&live=1')).body.users.length === 0);
    check('type filter works', (await api(B, 'GET', '/api/search?q=lofi&type=circles')).body.streams.length === 0);
    check('LIKE wildcards are escaped', (await api(B, 'GET', '/api/search?q=%25%25')).body.users.length === 0);

    const disc = (await api(E, 'GET', '/api/discover')).body;
    check('discovery recommends live streams', disc.recommended.length === 1 && disc.recommended[0].username === 'alice');
    check('rising row surfaces small channels', disc.rising.some(s2 => s2.username === 'alice'));
    check('discovery suggests Circles you have not joined', disc.circles.some(c => c.slug === 'lofi-lounge'));
    check('discovery hides your own stream from you', (await api(A, 'GET', '/api/discover')).body.recommended.length === 0);
    check('Circle shows owner is live', (await api(E, 'GET', '/api/circles/lofi-lounge')).body.owner.live === true);

    /* ---------------------------------------------- appreciation score */
    const ap0 = (await api(null, 'GET', '/api/profile/alice')).body.appreciation;
    check('appreciation score has a transparent breakdown', ap0.parts.length === 6 && ap0.parts.every(x => x.label && typeof x.points === 'number'));
    const reactPts = ap0.parts.find(x => x.key === 'reactions').points;
    await api(A, 'POST', `/api/posts/${p1.id}/react`, { emoji: '👏' });
    const ap1 = (await api(null, 'GET', '/api/profile/alice')).body.appreciation;
    check('reacting to your own post earns nothing', ap1.parts.find(x => x.key === 'reactions').points === reactPts);
    await api(C, 'POST', `/api/posts/${p1.id}/react`, { emoji: '😂' });
    const ap2 = (await api(null, 'GET', '/api/profile/alice')).body.appreciation;
    check('reactions from other people add points', ap2.parts.find(x => x.key === 'reactions').points === reactPts + 1);
    check('level rises with score', ap2.level >= 1 && ap2.score > 0);

    /* ------------------------------------------------------ analytics */
    await sleep(200);
    host.emit('end');
    await sleep(300);
    await emit(host, 'host', { title: 'Second stream', category: 'Education', tags: [] });
    await sleep(100);
    await api(E, 'POST', '/api/follow/alice');
    await sleep(100);
    host.emit('end');
    await sleep(300);
    const dash = (await api(A, 'GET', '/api/dashboard')).body.analytics;
    check('analytics: unique viewers counted', dash.uniqueViewers >= 3);
    check('analytics: returning viewers detected', dash.returningViewers >= 1);
    check('analytics: chat messages counted', dash.chatMessages >= 3);
    check('analytics: per-stream rows', dash.perStream.length === 2 && dash.perStream.every(x => typeof x.retention === 'number'));
    check('analytics: followers gained during streams', dash.followersFromStreams >= 1 && dash.followerConversion > 0);
    check('analytics: 14-day follower growth', dash.followerGrowth.length === 14 && dash.followerGrowth.reduce((a, b) => a + b, 0) >= 3);
    check('analytics are private', (await api(null, 'GET', '/api/dashboard')).status === 401);

    [host, bSock, cSock, dSock, dSock2].forEach(x => x.close());
  } catch (e) {
    console.error(e); failures++;
  } finally {
    server.kill('SIGTERM');
    console.log(failures ? `\n${failures} of ${total} check(s) FAILED` : `\nAll ${total} Phase 2 checks passed`);
    process.exit(failures ? 1 : 0);
  }
})();
