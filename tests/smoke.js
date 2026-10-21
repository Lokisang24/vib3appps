'use strict';
// Starts the server on a temp DB and verifies the Early Bird Pins rules end to end.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

const post = async (p, body, token) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const connect = token => new Promise(res => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise(res => s.emit(ev, p, res));

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_PATH: path.join(os.tmpdir(), `huddle-test-${Date.now()}.db`) },
    stdio: 'inherit'
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(150); }

    const kid = await post('/api/register', { username: 'tinyuser', password: 'password123', dob: '2020-01-01', acceptTerms: true });
    check('under-13 signup is blocked', kid.status === 403);

    const users = {};
    for (const name of ['streamer1', 'viewer1', 'viewer2', 'viewer3', 'viewer4', 'viewer5']) {
      const r = await post('/api/register', { username: name, password: 'password123', dob: name === 'viewer2' ? '2010-06-01' : '2000-06-01', acceptTerms: true });
      users[name] = r.body;
    }
    check('registration works', !!users.streamer1.token);
    check('teen account is flagged', users.viewer2.user.isTeen === true);
    const bad = await post('/api/login', { username: 'viewer1', password: 'wrongpass' });
    check('wrong password rejected', bad.status === 401);

    const host = await connect(users.streamer1.token);
    const hostAck = await emit(host, 'host', { title: 'Test stream', category: 'Just Chatting' });
    check('streamer can go live', hostAck.ok);
    await emit(host, 'watch', { channel: 'streamer1' });

    const sockets = {};
    let lastState;
    host.on('room-state', s => { lastState = s; });
    for (const n of ['viewer1', 'viewer2', 'viewer3', 'viewer4', 'viewer5']) {
      sockets[n] = await connect(users[n].token);
      const a = await emit(sockets[n], 'watch', { channel: 'streamer1' });
      check(`${n} joined`, a.ok);
      await sleep(30);
    }
    await sleep(100);
    const names = lastState.earlyBirds.map(b => b.username);
    check('first 4 viewers are Early Birds in order', JSON.stringify(names) === JSON.stringify(['viewer1', 'viewer2', 'viewer3', 'viewer4']));

    const p5 = await emit(sockets.viewer5, 'pin', { text: 'pin me!' });
    check('5th viewer cannot pin', !!p5.error);

    let pinIds = [];
    for (let i = 1; i <= 3; i++) {
      await sleep(850);
      const r = await emit(sockets.viewer1, 'pin', { text: `question ${i}` });
      check(`viewer1 pin #${i} accepted`, r.ok && r.pinsLeft === 3 - i);
    }
    await sleep(850);
    const p4 = await emit(sockets.viewer1, 'pin', { text: 'question 4' });
    check('4th pin from same user rejected', !!p4.error);
    await sleep(100);
    pinIds = lastState.pins.visible.map(p => p.id);
    check('3 pins are showing on top', pinIds.length === 3);

    const sneaky = await emit(sockets.viewer2, 'answer', { pinId: pinIds[0] });
    check('non-streamer cannot clear pins', !!sneaky.error);

    const ok = await emit(host, 'answer', { pinId: pinIds[0] });
    await sleep(100);
    check('streamer clears a pin (Answered)', ok.ok && lastState.pins.visible.length === 2);

    await sleep(850);
    const v2pin = await emit(sockets.viewer2, 'pin', { text: 'hello from v2' });
    check('another Early Bird can pin', v2pin.ok);
    await emit(host, 'revoke-pins', { userId: users.viewer2.user.id });
    await sleep(100);
    check('revoking pins removes that user\'s pins', !lastState.pins.visible.some(p => p.username === 'viewer2'));
    await sleep(850);
    const again = await emit(sockets.viewer2, 'pin', { text: 'again' });
    check('revoked Early Bird cannot pin', !!again.error);

    await sleep(850);
    const chat = await emit(sockets.viewer5, 'chat', { text: 'normal chat works' });
    check('regular viewers can chat', chat.ok);

    const guest = await connect(null);
    await emit(guest, 'watch', { channel: 'streamer1' });
    const gchat = await emit(guest, 'chat', { text: 'hi' });
    check('guests cannot chat', !!gchat.error);

    /* ------------------------------------------------ Phase 1 features */
    const authed = async (token, method, p, body) => {
      const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const evs = { reaction: [], reacts: [], chats: [], deleted: [] };
    host.on('reaction', e => evs.reaction.push(e));
    host.on('msg-reactions', e => evs.reacts.push(e));
    host.on('chat', m => evs.chats.push(m));
    host.on('msg-deleted', e => evs.deleted.push(e));

    await authed(users.streamer1.token, 'PUT', '/api/profile', {
      displayName: 'Dawn Streams', bio: 'Study streams', interests: 'study, music, study',
      links: [{ platform: 'YouTube', url: 'https://youtube.com/@dawn' }, { platform: 'Website', url: 'javascript:alert(1)' }, { platform: 'Twitch', url: 'http://twitch.tv/dawn' }]
    });
    const prof = await (await fetch(BASE + '/api/profile/streamer1')).json();
    check('profile saves display name and bio', prof.displayName === 'Dawn Streams' && prof.bio === 'Study streams');
    check('interests are de-duplicated', prof.interests.length === 2);
    check('unsafe links (javascript:, http:) are dropped', prof.links.length === 1 && prof.links[0].platform === 'YouTube');
    const noAuth = await fetch(BASE + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('profile edit needs login', noAuth.status === 401);

    const rr = await emit(sockets.viewer1, 'react', { emoji: '🔥' });
    await sleep(100);
    check('stream reaction is broadcast', rr.ok && evs.reaction.length === 1);
    check('guests cannot react', !!(await emit(guest, 'react', { emoji: '🔥' })).error);
    check('unknown emoji rejected', !!(await emit(sockets.viewer1, 'react', { emoji: '💩' })).error);

    await sleep(850);
    await emit(sockets.viewer4, 'chat', { text: 'hello world' });
    await sleep(100);
    const msg = evs.chats.filter(m => !m.system).pop();
    await emit(sockets.viewer1, 'react-msg', { id: msg.id, emoji: '❤️' });
    await sleep(100);
    check('message reaction is counted', evs.reacts[evs.reacts.length - 1].reactions['❤️'] === 1);
    await emit(sockets.viewer1, 'react-msg', { id: msg.id, emoji: '❤️' });
    await sleep(100);
    check('reacting again removes it', !evs.reacts[evs.reacts.length - 1].reactions['❤️']);

    check('streamer appoints a moderator', (await authed(users.streamer1.token, 'POST', '/api/mods', { username: 'viewer3' })).status === 200);
    await sleep(100);
    check('non-mod cannot use slow mode', !!(await emit(sockets.viewer2, 'slowmode', { seconds: 10 })).error);
    check('moderator can enable slow mode', (await emit(sockets.viewer3, 'slowmode', { seconds: 10 })).ok);
    const slowTry = await emit(sockets.viewer4, 'chat', { text: 'again too soon' });
    check('slow mode blocks rapid chat', !!slowTry.error && /slow/i.test(slowTry.error));
    await emit(sockets.viewer3, 'slowmode', { seconds: 0 });

    await sleep(850);
    await emit(sockets.viewer4, 'pin', { text: 'mod can clear this' });
    await sleep(100);
    const modPin = lastState.pins.visible.find(p => p.text === 'mod can clear this');
    check('moderator can mark a pin Answered', (await emit(sockets.viewer3, 'answer', { pinId: modPin.id })).ok);

    check('moderator cannot time out the streamer', !!(await emit(sockets.viewer3, 'timeout', { userId: users.streamer1.user.id, seconds: 60 })).error);
    check('moderator can time out a viewer', (await emit(sockets.viewer3, 'timeout', { userId: users.viewer5.user.id, seconds: 60 })).ok);
    await sleep(850);
    const tChat = await emit(sockets.viewer5, 'chat', { text: 'let me talk' });
    check('timed-out viewer cannot chat', !!tChat.error && /timed out/i.test(tChat.error));

    await sleep(850);
    await emit(sockets.viewer2, 'chat', { text: 'delete me please' });
    await sleep(100);
    const del = evs.chats.filter(m => !m.system).pop();
    check('moderator can delete a message', (await emit(sockets.viewer3, 'delete-msg', { id: del.id })).ok);
    await sleep(100);
    check('delete is broadcast', evs.deleted.some(d => d.id === del.id));

    await authed(users.streamer1.token, 'PUT', '/api/profile', { blockedWords: 'spoiler' });
    await sleep(850);
    await emit(sockets.viewer2, 'chat', { text: 'big spoiler ahead' });
    await sleep(100);
    check('channel blocked words are masked', evs.chats.filter(m => !m.system).pop().text === 'big ******* ahead');

    check('non-mod cannot start a poll', !!(await emit(sockets.viewer2, 'poll-start', { question: 'x?', options: ['a', 'b'] })).error);
    check('streamer starts a poll', (await emit(host, 'poll-start', { question: 'Best snack?', options: ['Chips', 'Fruit', 'Cake'] })).ok);
    check('viewer can vote', (await emit(sockets.viewer1, 'poll-vote', { index: 1 })).ok);
    check('cannot vote twice', !!(await emit(sockets.viewer1, 'poll-vote', { index: 0 })).error);
    check('guests cannot vote', !!(await emit(guest, 'poll-vote', { index: 0 })).error);
    await sleep(100);
    check('poll counts update', lastState.poll && lastState.poll.options[1].votes === 1 && lastState.poll.open);
    check('non-mod cannot end a poll', !!(await emit(sockets.viewer2, 'poll-end', {})).error);
    await emit(host, 'poll-end', {});
    await sleep(100);
    check('poll closes', lastState.poll.open === false);
    check('cannot vote on a closed poll', !!(await emit(sockets.viewer2, 'poll-vote', { index: 0 })).error);

    await authed(users.viewer1.token, 'POST', '/api/blocks/viewer2');
    const blocks = await authed(users.viewer1.token, 'GET', '/api/blocks');
    check('viewer can block another user', blocks.body.blocks.some(b => b.username === 'viewer2'));
    await authed(users.viewer1.token, 'DELETE', '/api/blocks/viewer2');
    check('viewer can unblock', (await authed(users.viewer1.token, 'GET', '/api/blocks')).body.blocks.length === 0);
    await authed(users.viewer1.token, 'POST', '/api/report', { channel: 'streamer1', username: 'viewer2', message: 'rude', reason: 'test' });

    const list = await (await fetch(BASE + '/api/streams')).json();
    check('live stream appears in browse list', list.streams.length === 1 && list.streams[0].username === 'streamer1');

    host.emit('end');
    await sleep(150);
    const list2 = await (await fetch(BASE + '/api/streams')).json();
    check('stream disappears after ending', list2.streams.length === 0);

    const dash = await authed(users.streamer1.token, 'GET', '/api/dashboard');
    check('dashboard shows stream stats', dash.body.stats.streams === 1 && dash.body.stats.peak >= 5);
    check('dashboard lists moderators', dash.body.mods.includes('viewer3'));
    check('dashboard shows reports', dash.body.reports.length === 1);
    check('dashboard needs login', (await fetch(BASE + '/api/dashboard')).status === 401);

    Object.values(sockets).forEach(s => s.close()); host.close(); guest.close();
  } catch (e) {
    console.error(e); failures++;
  } finally {
    server.kill('SIGTERM');
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  }
})();
