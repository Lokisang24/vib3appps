// NovaStream Chat Replay: plays a finished stream's saved chat back on a timeline.
// Scrub or press play and each message shows up at the second it was first sent. Registered by app.js.
//
// The player runs from a millisecond clock (`clock` below). Built-in video is not recorded, so the clock is a
// timer. When recordings exist, replace clock.now() with video.currentTime * 1000 and drive play/pause/seek
// from the <video> element; the chat sync, chunk loading and timeline all keep working unchanged.
window.NSReplay = {
  register(NS, SOC) {
    const { h, S, api, fill, toast, avatar, go } = NS;
    const CHUNK = 60000;            // chat is fetched one minute of stream time at a time
    const MAX_LINES = 200;          // lines kept on screen
    const SPEEDS = [0.5, 1, 2, 4, 8];

    const pad = n => String(n).padStart(2, '0');
    const fmt = ms => {
      const s = Math.max(0, Math.floor(ms / 1000)), hr = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return hr ? `${hr}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    };
    const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`; };
    const day = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

    /* ---------------------------------------- "Past streams" list on a channel page */
    async function pastStreams(name) {
      let r;
      try { r = await api('/api/replays/' + encodeURIComponent(name), { noExpire: true }); } catch { return null; }
      if (!r.enabled || !r.replays.length) return null;
      return h('section', { class: 'panel replays' },
        h('h3', null, window.NSIcons.icon('message', 16), ' Chat replays'),
        h('p', { class: 'hint' }, `Watch the chat of a past stream, in sync with the timeline. Saved for ${r.days} days.`),
        h('ul', { class: 'rplist' }, r.replays.map(s => h('li', null,
          h('a', { href: '#/replay/' + s.id },
            h('b', null, s.title || 'Untitled stream'),
            h('small', null, ` ${s.category || ''} · ${day(s.startedAt)} · ${dur(s.durationMs)} · ${s.messages} message${s.messages === 1 ? '' : 's'}`))))));
    }

    /* ----------------------------------------------------------- the replay page */
    async function replayPage(main, id, startSec) {
      let meta;
      try { meta = await api('/api/replay/' + encodeURIComponent(id)); }
      catch (e) { fill(main, h('div', { class: 'page' }, h('h1', null, 'Replay not available'), h('p', { class: 'sub' }, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to browse'))); return; }

      const ch = meta.channel, st = meta.stream;
      const head = h('div', { class: 'info rhead' },
        h('a', { href: '#/u/' + ch.username, 'aria-label': 'View profile' }, avatar(ch.username, ch.color, ch.avatar, true)),
        h('div', { class: 'main' }, h('h2', null, st.title || 'Untitled stream'),
          h('div', { class: 'tags' }, h('a', { href: '#/c/' + ch.username, class: 'ul' }, ch.displayName), st.category && h('span', null, st.category), h('span', null, day(st.startedAt)),
            !meta.live && h('span', null, dur(st.durationMs)))));

      if (meta.live) {
        fill(main, h('div', { id: 'replay' }, h('div', { class: 'stage' }, head,
          h('section', { class: 'panel rnote' }, h('h3', null, 'This stream is still live'), h('p', null, 'The chat replay is ready as soon as the stream ends.'),
            h('a', { class: 'btn danger', href: '#/c/' + ch.username }, 'Watch live')))));
        return;
      }

      const duration = st.durationMs;
      const chunks = new Map();     // chunk number -> messages
      const loading = new Map();    // chunk number -> promise
      const retryAt = new Map();
      const lastChunk = Math.floor(duration / CHUNK);
      let pos = Math.min(duration, Math.max(0, (Number(startSec) || 0) * 1000));
      let playing = false, rate = 1, buffering = false, needRebuild = true, dragging = false;
      let cursor = { ci: 0, i: 0 }, stick = true, unseen = 0, dead = false, finished = false, errorShown = false;

      /* ---- chat loading ---- */
      function load(ci) {
        if (ci < 0 || ci > lastChunk) return null;
        if (chunks.has(ci)) return null;
        if (loading.has(ci)) return loading.get(ci);
        if ((retryAt.get(ci) || 0) > Date.now()) return null;
        const job = (async () => {
          let after = 0; const all = [];
          for (let guard = 0; guard < 40; guard++) {
            const r = await api(`/api/replay/${id}/chat?from=${ci * CHUNK}&to=${(ci + 1) * CHUNK}&after=${after}&limit=500`);
            all.push(...r.messages);
            if (!r.more) break;
            after = r.next;
          }
          if (!dead) chunks.set(ci, all);
        })().catch(e => {
          retryAt.set(ci, Date.now() + 3000);
          if (!errorShown && !dead) { errorShown = true; toast(e.message || 'Could not load part of the chat. Retrying...'); }
        }).finally(() => loading.delete(ci));
        loading.set(ci, job);
        return job;
      }
      const have = ci => ci < 0 || ci > lastChunk || chunks.has(ci);

      /* ---- chat panel ---- */
      const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'off', 'aria-label': 'Chat replay' });
      const jump = h('button', { class: 'btn small primary rjump', hidden: true, onclick: () => { stick = true; msgs.scrollTop = msgs.scrollHeight; setUnseen(0); } }, 'Jump to latest');
      const wait = h('div', { class: 'rwait', hidden: true }, 'Loading chat...');
      const setUnseen = n => { unseen = n; jump.hidden = stick || !n; jump.textContent = `${n} new message${n === 1 ? '' : 's'}`; };
      msgs.addEventListener('scroll', () => {
        stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
        if (stick) setUnseen(0); else jump.hidden = !unseen;
      });

      function line(m) {
        if (!m.system && S.blocked.has(m.userId)) return null;
        if (m.system) return h('div', { class: 'm sys' }, h('button', { class: 'ts', onclick: () => seek(m.t, true), title: 'Jump to ' + fmt(m.t) }, fmt(m.t)), m.text);
        const self = S.user && m.userId === S.user.id;
        const mention = S.user && new RegExp('@' + S.user.username + '\\b', 'i').test(m.text);
        const rx = Object.entries(m.reactions || {}).map(([em, c]) => h('span', { class: 'rxchip static' }, `${em} ${c}`));
        const tools = h('span', { class: 'tools' },
          !self && h('button', { title: 'Report', 'aria-label': 'Report message', onclick: () => NS.report({ type: 'chat', target: ch.username, username: m.username, context: m.text, label: 'this message' }) }, '⚑'),
          !self && !m.owner && h('button', { title: 'Block this user', 'aria-label': 'Block user', onclick: async () => {
            try {
              await api('/api/blocks/' + m.username, { method: 'POST' });
              S.blocked.add(m.userId); toast(`Blocked ${m.username}. Manage blocks in Edit profile.`);
              [...msgs.querySelectorAll(`[data-u="${m.userId}"]`)].forEach(n => n.remove());
            } catch (e) { toast(e.message); }
          } }, window.NSIcons.icon('ban', 14)));
        return h('div', { class: 'm' + (m.pinned ? ' pinned' : '') + (mention ? ' mentionme' : ''), 'data-u': m.userId },
          m.reply && h('div', { class: 'qreply' }, `↩ ${m.reply.username}: ${m.reply.text}`),
          h('button', { class: 'ts', onclick: () => seek(m.t, true), title: 'Jump to ' + fmt(m.t) }, fmt(m.t)),
          m.owner && h('span', { title: 'Streamer', class: 'cbdg' }, window.NSIcons.icon('video', 13)), m.mod && !m.owner && h('span', { title: 'Moderator', class: 'cbdg' }, window.NSIcons.icon('shield', 13)), m.earlyBird && h('span', { title: 'Early Bird', class: 'cbdg' }, window.NSIcons.icon('star', 13)),
          h('a', { class: 'u', href: '#/u/' + m.username, style: `--uc:${NS.twitchColor(m.username)}` }, m.username), ': ', m.pinned ? window.NSIcons.icon('pin', 13) : '', SOC.richText(m.text), rx, S.user && tools);
      }
      function append(m, fresh) {
        const n = line(m); if (!n) return;
        msgs.append(n);
        while (msgs.children.length > MAX_LINES) msgs.firstChild.remove();
        if (fresh && !stick) setUnseen(unseen + 1);
      }

      /* ---- keeping the chat in step with the clock ---- */
      function rebuild(ci) {
        fill(msgs); setUnseen(0);
        const prev = [...(chunks.get(ci - 2) || []), ...(chunks.get(ci - 1) || [])], cur = chunks.get(ci) || [];
        const upTo = [...prev, ...cur].filter(m => m.t <= pos);
        upTo.slice(-80).forEach(m => append(m, false));
        let i = 0; while (i < cur.length && cur[i].t <= pos) i++;
        cursor = { ci, i };
        stick = true; msgs.scrollTop = msgs.scrollHeight;
        needRebuild = false;
      }
      function syncChat() {
        const ci = Math.min(lastChunk, Math.floor(pos / CHUNK));
        for (const c of [ci - 2, ci - 1, ci, ci + 1, ci + 2]) if (c >= ci || needRebuild) load(c);
        if (!have(ci) || (needRebuild && (!have(ci - 1) || !have(ci - 2)))) { buffering = true; wait.hidden = false; return; }
        buffering = false; wait.hidden = true;
        if (needRebuild) { rebuild(ci); return; }
        let fresh = 0;
        for (let guard = 0; guard < 2000; guard++) {
          const arr = chunks.get(cursor.ci);
          if (!arr || cursor.i >= arr.length) {
            if (cursor.ci < ci) { cursor = { ci: cursor.ci + 1, i: 0 }; continue; } // move on to the next minute
            break;
          }
          const m = arr[cursor.i];
          if (m.t > pos) break;
          append(m, true); cursor.i++; fresh++;
        }
        if (fresh && stick) msgs.scrollTop = msgs.scrollHeight;
      }

      /* ---- timeline ---- */
      const max = Math.max(1, ...meta.buckets);
      const bars = h('div', { class: 'rbars', role: 'img', 'aria-label': 'Chat activity over the stream. Click to jump.' },
        meta.buckets.map((n, i) => h('i', { style: `height:${n ? Math.max(6, Math.round(n / max * 100)) : 0}%`, title: `${fmt(i / meta.buckets.length * duration)}: ${n} message${n === 1 ? '' : 's'}` })));
      const playhead = h('div', { class: 'rhead-line' });
      const marks = h('div', { class: 'rmarks' }, meta.pins.map(p => h('button', { class: 'rpinmark', style: `left:${p.t / duration * 100}%`, title: `Pinned at ${fmt(p.t)}: ${p.username}`, 'aria-label': `Pinned question at ${fmt(p.t)}`, onclick: () => seek(p.t, true) }, window.NSIcons.icon('pin', 13))));
      const chart = h('div', { class: 'rchart' }, bars, playhead, marks);
      chart.addEventListener('click', e => { if (e.target.closest('.rpinmark')) return; const r = chart.getBoundingClientRect(); seek(Math.round((e.clientX - r.left) / r.width * duration), true); });
      const slider = h('input', { type: 'range', class: 'rslider', min: 0, max: Math.ceil(duration / 1000), step: 1, value: Math.floor(pos / 1000), 'aria-label': 'Replay position' });
      slider.addEventListener('pointerdown', () => { dragging = true; });
      const release = () => { dragging = false; };
      window.addEventListener('pointerup', release);
      slider.addEventListener('input', () => seek(Number(slider.value) * 1000, false));
      const clockEl = h('div', { class: 'rclock', 'aria-live': 'off' });
      const playBtn = h('button', { class: 'btn primary rplay', 'aria-label': 'Play', onclick: () => toggle() }, '▶ Play');
      const back = h('button', { class: 'btn', 'aria-label': 'Back 10 seconds', onclick: () => seek(pos - 10000, true) }, '↺ 10s');
      const fwd = h('button', { class: 'btn', 'aria-label': 'Forward 10 seconds', onclick: () => seek(pos + 10000, true) }, '10s ↻');
      const speed = h('select', { 'aria-label': 'Playback speed', onchange: () => { rate = Number(speed.value); } }, SPEEDS.map(s => h('option', { value: s, selected: s === 1 }, s + 'x')));
      const status = h('span', { class: 'rstatus' });

      function seek(ms, syncSlider) {
        pos = Math.min(duration, Math.max(0, ms));
        finished = false; needRebuild = true;
        if (syncSlider) slider.value = Math.floor(pos / 1000);
        draw();
      }
      function toggle(on) {
        playing = on === undefined ? !playing : on;
        if (playing && pos >= duration) seek(0, true);
        finished = false;
        draw();
      }
      function draw() {
        clockEl.textContent = `${fmt(pos)} / ${fmt(duration)}`;
        playhead.style.left = (pos / duration * 100) + '%';
        slider.setAttribute('aria-valuetext', `${fmt(pos)} of ${fmt(duration)}`);
        if (!dragging) slider.value = Math.floor(pos / 1000);
        playBtn.textContent = playing ? '⏸ Pause' : (finished ? '↺ Replay' : '▶ Play');
        playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        status.textContent = finished ? 'Replay finished' : buffering ? 'Loading chat...' : '';
      }

      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now(), dt = Math.min(1000, now - last); last = now;
        if (playing && !buffering) {
          pos = Math.min(duration, pos + dt * rate);
          if (pos >= duration) { playing = false; finished = true; }
        }
        syncChat(); draw();
      }, 200);

      /* ---- the rest of the page ---- */
      const peaks = (() => {
        const out = [], n = meta.buckets.length;
        [...meta.buckets.keys()].sort((a, b) => meta.buckets[b] - meta.buckets[a]).forEach(i => {
          if (meta.buckets[i] >= 3 && out.length < 3 && out.every(j => Math.abs(j - i) > 3)) out.push(i);
        });
        return out.sort((a, b) => a - b).map(i => ({ t: Math.max(0, Math.round(i / n * duration) - 5000), n: meta.buckets[i] }));
      })();
      const side = [
        peaks.length ? h('section', { class: 'panel' }, h('h3', null, 'Busiest moments'),
          h('div', { class: 'chips' }, peaks.map(p => h('button', { class: 'chip', onclick: () => { seek(p.t, true); toggle(true); } }, `${fmt(p.t)} · ${p.n} messages`)))) : null,
        meta.pins.length ? h('section', { class: 'panel' }, h('h3', null, 'Pinned by Early Birds'),
          h('ul', { class: 'rplist' }, meta.pins.map(p => h('li', null, h('button', { class: 'rpinrow', onclick: () => { seek(Math.max(0, p.t - 3000), true); toggle(true); } },
            h('b', null, fmt(p.t)), ' ', h('span', { class: 'u' }, p.username + ': '), p.text))))) : null
      ];
      const copyBtn = h('button', { class: 'btn', onclick: async () => {
        const url = `${location.origin}/#/replay/${id}/${Math.floor(pos / 1000)}`;
        try { if (navigator.share) await navigator.share({ title: st.title || 'Chat replay', url }); else { await navigator.clipboard.writeText(url); toast('Link copied. It opens at ' + fmt(pos) + '.'); } } catch { /* cancelled */ }
      } }, 'Share at this time');
      const delBtn = meta.canDelete && h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete this chat replay for good? The stream stays in your stats, but its saved chat is removed.')) return;
        try { await api('/api/replay/' + id, { method: 'DELETE' }); toast('Replay deleted.'); go('#/c/' + ch.username); } catch (e) { toast(e.message); }
      } }, 'Delete replay');

      const stage = h('div', { class: 'stage' }, head,
        h('section', { class: 'panel rplayer', 'aria-label': 'Replay controls' },
          h('div', { class: 'rtop' }, clockEl, status),
          chart, slider,
          h('div', { class: 'rctrls' }, back, playBtn, fwd, h('label', { class: 'rspeed' }, 'Speed ', speed), h('span', { class: 'grow' }), copyBtn, delBtn),
          h('p', { class: 'hint' }, meta.messages ? `${meta.messages} chat message${meta.messages === 1 ? '' : 's'}. Press play, or click the chart to jump to a busy moment. Space plays and pauses, arrow keys skip 5 seconds. The stream video itself is not recorded.` : 'No chat was saved for this stream.'),
          h('p', { class: 'hint' }, `Chat replays are kept for ${meta.keptDays} days. Messages from people you blocked are hidden.`)),
        side);
      const chat = h('aside', { class: 'chat' }, h('header', null, 'Chat replay'), h('div', { class: 'rchatbox' }, msgs, wait, jump),
        h('div', { class: 'rfoot' }, 'Read-only. ', h('a', { href: '#/c/' + ch.username, class: 'ul' }, 'Open the channel'), ' to chat live.'));
      fill(main, h('div', { id: 'replay' }, stage, chat));
      draw();

      const keys = e => {
        const t = e.target, tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // a focused button keeps its own Space and Enter
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(pos - 5000, true); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); seek(pos + 5000, true); }
        else if (e.key === 'j') seek(pos - 10000, true);
        else if (e.key === 'l') seek(pos + 10000, true);
      };
      document.addEventListener('keydown', keys);
      S.cleanup = () => { dead = true; clearInterval(timer); document.removeEventListener('keydown', keys); window.removeEventListener('pointerup', release); };
    }

    return { replayPage, pastStreams, fmt };
  }
};
