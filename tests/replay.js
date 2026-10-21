'use strict';
// Chat Replay tests: saving chat with time offsets, playback API, privacy and safety rules.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, total = 0;
const check = (name, cond) => { total++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const section = t => console.log(`\n--- ${t}`);

const api = async (tok, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const connect = token => new Promise(res => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise(res => s.emit(ev, p, res));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-replay-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, POST_COOLDOWN_MS: '0', AUTH_LIMIT: '60', SENSITIVE_LIMIT: '100', ADMIN_USERNAMES: 'siteadmin', DB_PATH: path.join(dir, 'novastream.db') },
    stdio: 'inherit'
  });
  const socks = [];
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* wait */ } await sleep(150); }
    const reg = async name => (await api(null, 'POST', '/api/register', { username: name, password: 'password123', dob: '2000-01-01', acceptTerms: true })).body;
    const ADM = await reg('siteadmin');
    const U = { hosty: await reg('hosty'), vera: await reg('vera'), walt: await reg('walt'), xena: await reg('xena'), yuri: await reg('yuri') };
    const H = U.hosty.token, V = U.vera.token, W = U.walt.token, X = U.xena.token, Y = U.yuri.token, A = ADM.token;

    section('saving chat while live');
    const host = await connect(H); socks.push(host);
    const vera = await connect(V), walt = await connect(W), xena = await connect(X); socks.push(vera, walt, xena);
    await emit(host, 'host', { title: 'Replay night', category: 'Gaming' });
    await emit(vera, 'watch', { channel: 'hosty' });
    await emit(walt, 'watch', { channel: 'hosty' });
    await emit(xena, 'watch', { channel: 'hosty' });
    const got = [];
    vera.on('chat', m => got.push(m));
    await emit(vera, 'chat', { text: 'first from vera' });
    await sleep(300);
    await emit(walt, 'chat', { text: 'walt says hi @vera' });
    await sleep(300);
    await emit(xena, 'chat', { text: 'xena will be deleted' });
    await sleep(300);
    await emit(vera, 'chat', { text: 'vera again' });
    await sleep(300);
    await emit(walt, 'pin', { text: 'is this a pinned question?' });
    await sleep(300);
    await emit(xena, 'chat', { text: 'what a wonderful night' });
    await sleep(700);
    await emit(vera, 'chat', { text: 'secretword spoiler' });
    await sleep(300);
    const veraMsg = got.find(m => m.text === 'first from vera');
    const xenaMsg = got.find(m => m.text === 'xena will be deleted');
    await emit(walt, 'react-msg', { id: veraMsg.id, emoji: '🔥' });
    await emit(host, 'delete-msg', { id: xenaMsg.id });

    const liveStreams = (await api(H, 'GET', '/api/dashboard')).body.recent;
    const streamId = liveStreams[0].id;
    check('a live stream is not offered as a replay yet', liveStreams.length === 1 && liveStreams[0].replay === false && (await api(V, 'GET', '/api/replays/hosty')).body.replays.length === 0);
    const liveMeta = (await api(V, 'GET', '/api/replay/' + streamId)).body;
    check('opening a live stream\'s replay says it is still live', liveMeta.live === true && liveMeta.messages === undefined);
    check('its chat cannot be read while it is live', (await api(V, 'GET', `/api/replay/${streamId}/chat`)).status === 409);

    section('after the stream ends');
    host.emit('end');
    await sleep(500);
    const list = (await api(V, 'GET', '/api/replays/hosty')).body;
    check('the finished stream appears in the channel\'s replay list', list.enabled && list.replays.length === 1 && list.replays[0].id === streamId && list.replays[0].messages >= 4);
    check('the dashboard and profile link to it', (await api(H, 'GET', '/api/dashboard')).body.recent[0].replay === true && (await api(V, 'GET', '/api/profile/hosty')).body.recent[0].replay === true);

    const meta = (await api(V, 'GET', '/api/replay/' + streamId)).body;
    check('replay info has title, duration and an activity chart', meta.live === false && meta.stream.title === 'Replay night' && meta.stream.durationMs >= 1000 && meta.buckets.length === 90 && meta.buckets.reduce((a, b) => a + b, 0) === meta.messages);
    check('pinned questions are listed with their time', meta.pins.length === 1 && meta.pins[0].username === 'walt' && meta.pins[0].t >= 0);
    check('viewers cannot delete, the streamer can', meta.canDelete === false && (await api(H, 'GET', '/api/replay/' + streamId)).body.canDelete === true);

    const all = (await api(V, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body;
    const texts = all.messages.map(m => m.text);
    check('chat comes back in the order it was sent, with offsets from the stream start', texts.indexOf('first from vera') < texts.indexOf('vera again') && all.messages.every((m, i, a) => m.t >= 0 && (i === 0 || m.t >= a[i - 1].t)));
    check('the start-of-stream system line is saved too', all.messages[0].system === true && /Stream started/.test(all.messages[0].text));
    check('a message a moderator deleted is not in the replay', !texts.includes('xena will be deleted'));
    check('reactions, pins and the streamer flag survive', all.messages.find(m => m.id === veraMsg.id).reactions['🔥'] === 1 && all.messages.some(m => m.pinned && m.earlyBird));
    check('time windows work: a later window does not repeat earlier chat', (await api(V, 'GET', `/api/replay/${streamId}/chat?from=${meta.stream.durationMs + 5000}&to=${meta.stream.durationMs + 20000}`)).body.messages.length === 0);
    const p1 = (await api(V, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000&limit=2`)).body;
    const p2 = (await api(V, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000&limit=2&after=${p1.next}`)).body;
    check('long windows page cleanly with limit and after', p1.more === true && p1.messages.length === 2 && p2.messages.length >= 1 && p2.messages[0].row > p1.messages[1].row);

    section('privacy and safety');
    check('logged-out visitors cannot read replays', (await api(null, 'GET', '/api/replay/' + streamId)).status === 401 && (await api(null, 'GET', `/api/replay/${streamId}/chat`)).status === 401 && (await api(null, 'GET', '/api/replays/hosty')).status === 401);
    check('unknown replays give a readable 404', (await api(V, 'GET', '/api/replay/99999')).status === 404 && (await api(V, 'GET', '/api/replay/abc')).status === 404);
    await api(V, 'POST', '/api/blocks/walt');
    const blockedView = (await api(V, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages;
    check('people you blocked are left out of your replay', !blockedView.some(m => m.username === 'walt') && blockedView.some(m => m.username === 'vera'));
    check('other viewers still see them', (await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages.some(m => m.username === 'walt'));
    check('pinned questions from people you blocked are hidden too', (await api(V, 'GET', '/api/replay/' + streamId)).body.pins.length === 0);
    await api(V, 'DELETE', '/api/blocks/walt');
    await api(A, 'POST', '/api/admin/words', { word: 'wonderful' });
    await api(H, 'PUT', '/api/profile', { blockedWords: ['secretword'] });
    // words added after the fact are applied when the replay is played
    const masked = (await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages;
    check('words added to the site filter later are masked in old replays', masked.some(m => m.text === 'what a ********* night') && !masked.some(m => /wonderful/i.test(m.text)));
    check('the streamer\'s own blocked words are masked too', masked.some(m => m.text === '********** spoiler') && !masked.some(m => /secretword/i.test(m.text)));
    await api(A, 'POST', `/api/admin/users/${U.vera.user.id}/action`, { action: 'suspend', hours: 24, reason: 'test suspension' });
    check('messages from suspended accounts are hidden', !(await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages.some(m => m.username === 'vera'));
    await api(A, 'POST', `/api/admin/users/${U.vera.user.id}/action`, { action: 'unban' });
    check('and come back when the suspension is lifted', (await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages.some(m => m.username === 'vera'));

    section('data rights');
    const exp = (await api(W, 'GET', '/api/account/export')).body;
    check('my data download includes the chat messages I sent', Array.isArray(exp.chatMessages) && exp.chatMessages.some(m => m.text.includes('walt says hi')));
    check('deleting my account removes my saved messages', (await api(W, 'POST', '/api/account/delete', { password: 'password123' })).status === 200
      && !(await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages.some(m => m.username === 'walt'));

    section('settings and deleting');
    check('only an admin can change the replay settings', (await api(V, 'PUT', '/api/admin/settings', { chatReplayDays: 7 })).status === 403 && (await api(A, 'PUT', '/api/admin/settings', { chatReplayDays: 7 })).status === 200);
    check('settings reject nonsense', (await api(A, 'PUT', '/api/admin/settings', { chatReplayDays: 0 })).status === 400 && (await api(A, 'PUT', '/api/admin/settings', { chatReplayEnabled: 'yes' })).status === 400);
    check('the public site info tells the app how long chat is kept', (await api(null, 'GET', '/api/site')).body.chatReplay.days === 7);
    await api(A, 'PUT', '/api/admin/settings', { chatReplayEnabled: false });
    check('switching Chat Replay off hides replays', (await api(Y, 'GET', '/api/replay/' + streamId)).status === 404 && (await api(Y, 'GET', '/api/replays/hosty')).body.replays.length === 0);
    const host2 = await connect(H); socks.push(host2);
    await emit(host2, 'host', { title: 'While off', category: 'Gaming' });
    await emit(host2, 'chat', { text: 'this should not be saved' });
    await sleep(200);
    host2.emit('end'); await sleep(400);
    await api(A, 'PUT', '/api/admin/settings', { chatReplayEnabled: true });
    const recentNow = (await api(H, 'GET', '/api/dashboard')).body.recent;
    const offId = recentNow[recentNow.length - 1].id;
    check('nothing is saved while it is off', offId !== streamId && (await api(Y, 'GET', '/api/replays/hosty')).body.replays.every(r => r.id !== offId));
    check('a viewer cannot delete someone else\'s replay', (await api(Y, 'DELETE', '/api/replay/' + streamId)).status === 403);
    check('the streamer can delete their replay', (await api(H, 'DELETE', '/api/replay/' + streamId)).status === 200 && (await api(Y, 'GET', '/api/replays/hosty')).body.replays.length === 0);
    check('a deleted replay has no chat left', (await api(Y, 'GET', `/api/replay/${streamId}/chat?from=0&to=600000`)).body.messages.length === 0);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    socks.forEach(s => s.close());
    server.kill('SIGTERM');
    console.log(failures ? `\n${failures} of ${total} check(s) FAILED` : `\nAll ${total} chat replay checks passed`);
    process.exit(failures ? 1 : 0);
  }
})();
