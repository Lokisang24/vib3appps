// NovaStream Phase 2 pages: feed, Circles, notifications, search. Registered by app.js.
window.NSPages = {
  register(NS) {
    const { h, S, api, fill, toast, avatar, go, ago, field, initial } = NS;
    const TYPE_LABELS = { follow: 'New followers', live: 'Followed creators going live', mention: 'Mentions and chat replies', comment: 'Comments, replies and reposts',
      circle: 'Circle news', event: 'Event reminders', answered: 'Your pinned question answered', achievement: 'Achievements' };
    const NICON = { follow: 'userplus', live: 'live', mention: 'at', comment: 'message', circle: 'circles', event: 'calendar', answered: 'check', achievement: 'trophy', system: 'shield' };
    const TYPE_ICONS = { follow: '👤', live: '🔴', mention: '@', comment: '💬', circle: '🌐', event: '📅', answered: '🙋', achievement: '🏆', system: '🛡️' };

    // text with clickable @mentions (text nodes only, so no HTML injection)
    const richText = text => String(text).split(/(@[a-zA-Z0-9_]{3,20})/g).map(part =>
      /^@[a-zA-Z0-9_]{3,20}$/.test(part) ? h('a', { class: 'mention', href: '#/u/' + part.slice(1) }, part) : part);

    const needLogin = () => { if (!S.user) { go('#/login'); return true; } return false; };
    const person = (a, big) => h('a', { class: 'who', href: '#/u/' + a.username }, avatar(a.username, a.color, a.avatar, big), h('span', null, h('b', null, a.displayName, a.verified && NS.verifiedMark()), h('small', null, ' @' + a.username)));

    /* ------------------------------------------------------------ media on posts */
    const MAX_FILES = 4, IMG_LIMIT = 6 * 1024 * 1024, GIF_LIMIT = 5 * 1024 * 1024, VIDEO_LIMIT = 20 * 1024 * 1024, MAX_PX = 1600;
    function lightbox(url, alt) {
      const onKey = e => { if (e.key === 'Escape') close(); };
      const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
      const box = h('div', { class: 'modal lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Picture viewer', onclick: close },
        h('img', { src: url, alt }), h('button', { class: 'btn', type: 'button', 'aria-label': 'Close picture viewer', onclick: close }, 'Close'));
      document.addEventListener('keydown', onKey);
      document.body.append(box);
    }
    /* Only one video or audio plays at a time, and anything that is playing pauses when it is scrolled out of view.
       A video can also be opened in a larger media player, which carries on from the same moment. */
    const watchMedia = (() => {
      let io = null;
      document.addEventListener('play', e => {
        if (!(e.target instanceof HTMLMediaElement)) return;
        document.querySelectorAll('video, audio').forEach(o => { if (o !== e.target && !o.paused) o.pause(); });
      }, true);
      return m => {
        if (!('IntersectionObserver' in window)) return;
        if (!io) io = new IntersectionObserver(entries => entries.forEach(en => {
          const el = en.target;
          if ((!en.isIntersecting || en.intersectionRatio < 0.25) && !el.paused && !el.dataset.inplayer) el.pause();
        }), { threshold: [0, 0.25, 0.5] });
        io.observe(m);
      };
    })();
    function mediaPlayer(url, kind, from, label, onClose) {
      const m = h(kind === 'audio' ? 'audio' : 'video', { src: url, controls: true, autoplay: true, playsinline: true, 'aria-label': label });
      m.dataset.inplayer = '1';
      m.addEventListener('loadedmetadata', () => { try { m.currentTime = from || 0; } catch { /* not seekable yet */ } }, { once: true });
      const onKey = e => { if (e.key === 'Escape') close(); };
      const close = () => { const t = m.currentTime; m.pause(); box.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(t); };
      const box = h('div', { class: 'modal mediaplayer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media player', onclick: e => { if (e.target === box) close(); } },
        h('div', { class: 'mpbox' }, h('div', { class: 'mphead' }, h('b', null, label), h('button', { class: 'btn small', type: 'button', onclick: close }, 'Close')), m));
      document.addEventListener('keydown', onKey);
      document.body.append(box);
      m.play().catch(() => {});
    }
    function mediaView(list, who) {
      if (!list || !list.length) return null;
      const vid = list.find(m => m.kind === 'video'), aud = list.find(m => m.kind === 'audio');
      const player = (m, kind) => {
        const label = `${kind === 'audio' ? 'Audio' : 'Video'} shared by ${who}`;
        const v = h(kind, { src: m.url, controls: true, preload: 'metadata', playsinline: true, 'aria-label': label });
        watchMedia(v);
        const open = h('button', { type: 'button', class: 'pvid-open', title: 'Open in media player', 'aria-label': 'Open in media player', onclick: () => {
          const t = v.currentTime; v.pause();
          mediaPlayer(m.url, kind, t, label, back => { try { v.currentTime = back; } catch { /* ignore */ } });
        } }, window.NSIcons.icon('expand', 16), h('span', null, 'Player'));
        return h('div', { class: 'pmedia n1 pvid' + (kind === 'audio' ? ' paud' : '') }, v, open);
      };
      if (vid) return player(vid, 'video');
      if (aud) return player(aud, 'audio');
      return h('div', { class: 'pmedia n' + list.length }, list.map(m => h('button', { type: 'button', class: 'pimg', 'aria-label': 'View picture larger', onclick: () => lightbox(m.url, `Picture shared by ${who}`) },
        h('img', { src: m.url, alt: `Picture shared by ${who}`, loading: 'lazy' }))));
    }
    const readDataUrl = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('That file could not be read.')); r.readAsDataURL(file); });
    async function decodeImage(file) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older browsers: fall back to an <img> */ }
      const src = await readDataUrl(file);
      return await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('That picture could not be opened.')); im.src = src; });
    }
    const drawTo = (img, max, type, quality) => {
      const w = img.width, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    };
    // pictures are resized in the browser (max 1600px, JPEG) which also removes camera location data; GIFs and videos are sent as they are
    async function prepareFile(file) {
      if (/^video\/(mp4|webm)$/.test(file.type)) {
        if (file.size > VIDEO_LIMIT) throw new Error('Videos can be up to 20 MB. Please trim the clip or choose a shorter one.');
        return { blob: file, kind: 'video', thumb: '' };
      }
      if (file.type === 'image/gif') {
        if (file.size > GIF_LIMIT) throw new Error('GIFs can be up to 5 MB.');
        return { blob: file, kind: 'image', thumb: await readDataUrl(file) };
      }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPEG, PNG, WebP or GIF picture, or an MP4 or WebM video.');
      const img = await decodeImage(file);
      const big = drawTo(img, MAX_PX), small = drawTo(img, 160);
      const blob = await new Promise(ok => big.toBlob(ok, 'image/jpeg', 0.86));
      if (!blob) throw new Error('That picture could not be prepared.');
      if (blob.size > IMG_LIMIT) throw new Error('That picture is still too large after resizing. Please choose another one.');
      return { blob, kind: 'image', thumb: small.toDataURL('image/jpeg', 0.7) };
    }
    async function uploadMedia(blob) {
      const url = NS.apiUrl ? NS.apiUrl('/api/media') : '/api/media';
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', Authorization: 'Bearer ' + S.token }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The upload did not finish. Please try again.');
      return data;
    }

    /* ------------------------------------------------------------ posts */
    function postCard(post, opts = {}) {
      let p = post, open = false, replyTo = null;
      const I = (n, s) => window.NSIcons.icon(n, s || 18);
      const el = h('article', { class: 'post fb k-' + p.kind, style: `--pc:${p.author.color}` });
      const head = h('header', { class: 'fbp-head' });
      const body = h('div', { class: 'fbp-body' });
      const stats = h('div', { class: 'fbp-stats', 'aria-label': 'Post activity' });
      const bar = h('div', { class: 'fbp-bar', role: 'group', 'aria-label': 'Post actions' });
      const cbox = h('div', { class: 'fbp-cbox', hidden: true });
      const mediaBox = h('div', { class: 'pmediawrap' });
      el.append(head, body, mediaBox, stats, bar, cbox);
      const mine = () => S.user && S.user.username === p.author.username;
      const postUrl = () => location.origin + '/#/post/' + p.id;

      const react = async em => {
        if (needLogin()) return;
        try { const r = await api(`/api/posts/${p.id}/react`, { method: 'POST', body: { emoji: em } }); p.reactions = r.reactions; p.myReaction = r.myReaction; drawBar(); } catch (e) { toast(e.message); }
      };
      const share = async () => {
        try { if (navigator.share) await navigator.share({ title: 'NovaStream post', url: postUrl() }); else { await navigator.clipboard.writeText(postUrl()); toast('Link copied.'); } } catch { /* cancelled */ }
      };
      const repost = async () => {
        if (needLogin()) return;
        try { await api(`/api/posts/${p.id}/repost`, { method: 'POST', body: {} }); p.reposts++; drawBar(); toast('Reposted to your followers.'); } catch (e) { toast(e.message); }
      };
      const toggleComments = () => { open = !open; cbox.hidden = !open; if (open) loadComments(); };
      const del = async () => {
        if (!confirm('Delete this post?')) return;
        try { await api('/api/posts/' + p.id, { method: 'DELETE' }); el.remove(); if (opts.onDelete) opts.onDelete(p); } catch (e) { toast(e.message); }
      };

      /* comments, laid out like Facebook: avatar, grey bubble, then small Reply / time links */
      const loadComments = async () => {
        let list = [];
        try { list = (await api(`/api/posts/${p.id}/comments`)).comments; } catch (e) { toast(e.message); }
        const input = h('input', { maxlength: 300, placeholder: S.user ? 'Write a comment...' : 'Log in to join the conversation', disabled: !S.user, 'aria-label': 'Comment', autocomplete: 'off' });
        const chip = h('div', { class: 'replychip', hidden: true });
        const drawChip = () => { chip.hidden = !replyTo; fill(chip, replyTo && `Replying to @${replyTo.username} `, replyTo && h('button', { type: 'button', class: 'fbp-link', onclick: () => { replyTo = null; drawChip(); } }, 'Cancel')); };
        const form = h('form', { class: 'fbp-cform', onsubmit: async e => {
          e.preventDefault();
          if (!input.value.trim()) return;
          try { await api(`/api/posts/${p.id}/comments`, { method: 'POST', body: { body: input.value, replyTo: replyTo ? replyTo.id : 0 } }); p.comments++; replyTo = null; drawBar(); loadComments(); } catch (ex) { toast(ex.message); }
        } }, S.user ? avatar(S.user.username, S.user.color, S.user.avatar) : null, input,
          h('button', { class: 'fbp-send', type: 'submit', disabled: !S.user, 'aria-label': 'Post comment', title: 'Post comment' }, I('send', 18)));
        fill(cbox,
          ...list.map(c => h('div', { class: 'fbp-cmt' + (c.replyTo ? ' reply' : '') },
            h('a', { href: '#/u/' + c.author.username, 'aria-label': c.author.displayName }, avatar(c.author.username, c.author.color, c.author.avatar)),
            h('div', { class: 'fbp-cmain' },
              h('div', { class: 'fbp-bubble' },
                h('a', { class: 'fbp-cname', href: '#/u/' + c.author.username }, c.author.displayName, c.author.verified && NS.verifiedMark()),
                c.replyTo && h('div', { class: 'to' }, '↩ replying to @' + c.replyTo.username),
                h('div', { class: 'fbp-ctext' }, richText(c.body))),
              h('div', { class: 'fbp-cmeta' },
                h('button', { type: 'button', class: 'fbp-link', onclick: () => { if (needLogin()) return; replyTo = { id: c.id, username: c.author.username }; drawChip(); input.focus(); } }, 'Reply'),
                h('span', { class: 'when' }, ago(c.createdAt)),
                S.user && c.authorId !== S.user.id && h('button', { type: 'button', class: 'fbp-link', 'aria-label': 'Report comment', onclick: () => NS.report({ type: 'comment', target: c.id, label: 'this comment' }) }, 'Report'))))),
          list.length ? null : h('p', { class: 'empty' }, 'No comments yet. Be the first to comment.'),
          chip, form);
        drawChip();
      };

      /* counts row: reactions on the left, comments and reposts on the right */
      const drawStats = () => {
        const total = Object.values(p.reactions).reduce((a, b) => a + b, 0);
        const top = Object.entries(p.reactions).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
        stats.hidden = !(total || p.comments || p.reposts);
        fill(stats,
          h('span', { class: 'fbp-rx', title: total ? `${total} reaction${total === 1 ? '' : 's'}` : '' }, total ? [h('span', { class: 'fbp-rxs' }, top.map(e => h('i', null, e))), h('span', null, '' + total)] : null),
          h('span', { class: 'fbp-counts' },
            p.comments ? h('button', { type: 'button', class: 'fbp-link', onclick: toggleComments }, `${p.comments} comment${p.comments === 1 ? '' : 's'}`) : null,
            !p.circle && p.reposts ? h('span', null, `${p.reposts} repost${p.reposts === 1 ? '' : 's'}`) : null));
      };

      /* action row: React (hover or long-press for the emoji picker), Comment, Repost, Share */
      const drawBar = () => {
        drawStats();
        const reacted = p.myReaction;
        const likeBtn = h('button', { class: 'fbp-act fbp-like' + (reacted ? ' on' : ''), type: 'button', 'aria-pressed': String(!!reacted), 'aria-label': reacted ? `You reacted ${reacted}. Tap to remove` : 'React to this post',
          onclick: () => { if (wrap.classList.contains('show')) return; react(reacted || S.cfg.reactions[0]); } },
          reacted ? h('span', { class: 'fbp-emo' }, reacted) : I('heart'), h('span', { class: 'fbp-lbl' }, reacted ? 'Reacted' : 'React'));
        const picker = h('div', { class: 'rxpick', role: 'group', 'aria-label': 'Choose a reaction' },
          S.cfg.reactions.map(em => h('button', { type: 'button', class: 'rxo' + (reacted === em ? ' on' : ''), 'aria-label': `React ${em}`, onclick: () => { wrap.classList.remove('show'); react(em); } }, em)));
        const wrap = h('div', { class: 'rxwrap' }, likeBtn, picker);
        let timer = null;
        likeBtn.addEventListener('touchstart', () => { timer = setTimeout(() => { wrap.classList.add('show'); const off = e => { if (!wrap.contains(e.target)) { wrap.classList.remove('show'); document.removeEventListener('pointerdown', off, true); } }; document.addEventListener('pointerdown', off, true); }, 420); }, { passive: true });
        ['touchend', 'touchmove', 'touchcancel'].forEach(t => likeBtn.addEventListener(t, () => clearTimeout(timer), { passive: true }));
        likeBtn.addEventListener('contextmenu', e => e.preventDefault());
        fill(bar, wrap,
          h('button', { class: 'fbp-act fbp-comment', type: 'button', 'aria-expanded': String(open), onclick: toggleComments }, I('message'), h('span', { class: 'fbp-lbl' }, 'Comment')),
          !p.circle && !p.isRepost && !mine() && h('button', { class: 'fbp-act fbp-repost', type: 'button', onclick: repost }, I('repeat'), h('span', { class: 'fbp-lbl' }, 'Repost')),
          h('button', { class: 'fbp-act fbp-share', type: 'button', onclick: share }, I('share'), h('span', { class: 'fbp-lbl' }, 'Share')));
      };

      /* header: avatar, name, small grey line, and the ... menu */
      const menu = h('div', { class: 'fbp-menu', role: 'menu', hidden: true });
      const menuBtn = h('button', { class: 'fbp-more', type: 'button', 'aria-label': 'More options for this post', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => {
        e.stopPropagation();
        if (!menu.hidden) return closeMenu();
        menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true');
        setTimeout(() => { document.addEventListener('click', closeMenu); document.addEventListener('keydown', onEsc); }, 0);
      } }, I('more', 20));
      const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', closeMenu); document.removeEventListener('keydown', onEsc); };
      const onEsc = e => { if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); } };
      const mi = (icon, label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, I(icon, 16), label);
      fill(menu,
        mi('link', 'Copy link', async () => { try { await navigator.clipboard.writeText(postUrl()); toast('Link copied.'); } catch { toast(postUrl()); } }),
        (mine() || opts.canModerate) ? mi('trash', 'Delete post', del) : (S.user ? mi('flag', 'Report post', () => NS.report({ type: 'post', target: p.id, label: 'this post' })) : null));

      fill(head,
        h('a', { class: 'fbp-av', href: '#/u/' + p.author.username, 'aria-label': p.author.displayName }, avatar(p.author.username, p.author.color, p.author.avatar)),
        h('div', { class: 'fbp-who' },
          h('div', { class: 'fbp-line1' }, h('a', { class: 'fbp-name', href: '#/u/' + p.author.username }, p.author.displayName, p.author.verified && NS.verifiedMark()),
            p.kind === 'question' && h('span', { class: 'tag q' }, 'Question'), p.kind === 'announcement' && h('span', { class: 'tag a' }, 'Announcement')),
          h('div', { class: 'fbp-sub' }, '@' + p.author.username, ' · ', h('a', { class: 'when', href: '#/post/' + p.id, title: new Date(p.createdAt).toLocaleString() }, ago(p.createdAt)),
            p.circle && [' · ', h('a', { class: 'fbp-circle', href: '#/circle/' + p.circle.slug }, `${p.circle.emoji} ${p.circle.name}`)])),
        h('div', { class: 'fbp-menuwrap' }, menuBtn, menu));
      fill(body, p.body && h('p', { class: 'pre' }, richText(p.body)),
        p.isRepost ? (p.original ? h('div', { class: 'quote' }, person(p.original.author), h('p', { class: 'pre' }, richText(p.original.body)), h('a', { class: 'when', href: '#/post/' + p.original.id }, 'View original'))
                                 : h('div', { class: 'quote empty' }, 'The original post was removed.')) : null);
      body.hidden = !body.childNodes.length;
      fill(mediaBox, mediaView(p.media, p.author.displayName));
      el.classList.toggle('big', !p.isRepost && p.body.length > 0 && p.body.length <= 90 && !(p.media && p.media.length));
      drawBar();
      if (opts.openComments) { open = true; cbox.hidden = false; loadComments(); }
      return el;
    }

    /* ------------------------------------------------- spotlight slideshow (4 seconds a slide) */
    const SLIDE_MS = 4000;
    function spotlight(posts) {
      if (posts.length < 2) return null;
      let i = 0, elapsed = 0, hover = false, userPaused = false, last = performance.now(), touchX = null;
      try { userPaused = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* default */ }
      const excerpt = t => { const x = String(t).replace(/\s+/g, ' ').trim(); return x.length > 170 ? x.slice(0, 167) + '...' : x; };
      const tally = p => Object.values(p.reactions).reduce((a, b) => a + b, 0);
      const picOf = p => (p.media || []).find(m => m.kind === 'image');
      const slides = posts.map((p, n) => {
        const pic = picOf(p), extra = pic ? (p.media || []).filter(m => m.kind === 'image').length - 1 : 0;
        return h('a', { class: 'sslide' + (pic ? ' has-pic' : ''), href: '#/post/' + p.id, style: `--pc:${p.author.color}`, 'aria-roledescription': 'slide', 'aria-label': `${n + 1} of ${posts.length}` },
          pic && h('img', { class: 'spic', src: pic.url, alt: p.body ? excerpt(p.body) : `Picture shared by ${p.author.displayName}` }),
          h('div', { class: 'sov top' }, avatar(p.author.username, p.author.color, p.author.avatar), h('b', null, p.author.displayName), h('small', null, ' @' + p.author.username),
            p.kind === 'question' && h('span', { class: 'tag q' }, 'Question'), p.kind === 'announcement' && h('span', { class: 'tag a' }, 'Announcement'), h('span', { class: 'when' }, ago(p.createdAt))),
          !pic && p.body && h('p', { class: 'sq' }, excerpt(p.body)),
          h('div', { class: 'sov bot' },
            pic && p.body && h('span', { class: 'scap' }, excerpt(p.body)),
            h('span', { class: 'ps hot' }, window.NSIcons.icon('flame', 14), ' ' + tally(p)), h('span', { class: 'ps' }, window.NSIcons.icon('message', 14), ' ' + p.comments),
            extra > 0 && h('span', { class: 'ps' }, `+${extra} more`),
            h('span', { class: 'sgo' }, 'Open post')));
      });
      const dots = posts.map((_, n) => h('button', { class: 'sdot', 'aria-label': `Show slide ${n + 1}`, onclick: () => go_(n) }, h('i')));
      const pauseBtn = h('button', { class: 'spause', type: 'button', onclick: () => { userPaused = !userPaused; draw(); } });
      const stage = h('div', { class: 'sstage' }, ...slides);
      const root = h('section', { class: 'spot', 'aria-roledescription': 'carousel', 'aria-label': 'Featured pictures and posts' },
        h('div', { class: 'spothead' }, h('b', null, 'Spotlight'), h('small', null, 'Recent pictures and popular posts'), h('span', { class: 'grow' }), pauseBtn),
        stage, h('div', { class: 'sctl' }, h('button', { class: 'snav', type: 'button', 'aria-label': 'Previous slide', onclick: () => go_(i - 1) }, '‹'), h('div', { class: 'sdots' }, dots), h('button', { class: 'snav', type: 'button', 'aria-label': 'Next slide', onclick: () => go_(i + 1) }, '›')));
      function draw() {
        slides.forEach((sl, n) => { sl.classList.toggle('on', n === i); sl.setAttribute('aria-hidden', String(n !== i)); sl.tabIndex = n === i ? 0 : -1; });
        dots.forEach((d, n) => { d.classList.toggle('on', n === i); d.classList.toggle('done', n < i); d.firstChild.style.width = n === i ? Math.min(100, elapsed / SLIDE_MS * 100) + '%' : (n < i ? '100%' : '0%'); });
        pauseBtn.textContent = userPaused ? 'Play' : 'Pause';
        pauseBtn.setAttribute('aria-label', userPaused ? 'Play slideshow' : 'Pause slideshow');
        stage.setAttribute('aria-live', userPaused || hover ? 'polite' : 'off');
      }
      function go_(n) { i = (n + posts.length) % posts.length; elapsed = 0; draw(); }
      root.addEventListener('mouseenter', () => { hover = true; draw(); });
      root.addEventListener('mouseleave', () => { hover = false; draw(); });
      root.addEventListener('focusin', () => { hover = true; });
      root.addEventListener('focusout', () => { hover = false; });
      stage.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; hover = true; }, { passive: true });
      stage.addEventListener('touchend', e => { hover = false; if (touchX === null) return; const dx = e.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(dx) > 40) go_(i + (dx < 0 ? 1 : -1)); }, { passive: true });
      root.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') go_(i - 1); else if (e.key === 'ArrowRight') go_(i + 1); });
      const timer = setInterval(() => {
        if (!root.isConnected) { clearInterval(timer); return; }   // left the page: stop for good
        const now = performance.now(), dt = Math.min(500, now - last); last = now;
        if (userPaused || hover || document.hidden) return;
        elapsed += dt;
        if (elapsed >= SLIDE_MS) go_(i + 1); else draw();
      }, 100);
      draw();
      return root;
    }

    /* ------------------------------------------------- search as you type (profiles) */
    const RECENT_KEY = 'novastream_recent_people';
    const recents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 5); } catch { return []; } };
    const remember = u => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ username: u.username, displayName: u.displayName, color: u.color, avatar: u.avatar }, ...recents().filter(r => r.username !== u.username)].slice(0, 5))); } catch { /* storage blocked */ } };
    const forget = () => { try { localStorage.removeItem(RECENT_KEY); } catch { /* storage blocked */ } };
    const hl = (text, q) => {
      const at = q ? String(text).toLowerCase().indexOf(q.toLowerCase()) : -1;
      return at < 0 ? [text] : [text.slice(0, at), h('mark', null, text.slice(at, at + q.length)), text.slice(at + q.length)];
    };
    let sgUid = 0;
    function attachSuggest(form) {
      const input = form.querySelector('input');
      if (!input || form.dataset.sg) return null;
      form.dataset.sg = '1'; form.classList.add('sg-host');
      const id = 'sg' + (++sgUid);
      const box = h('div', { class: 'sgbox', role: 'listbox', id, hidden: true, 'aria-label': 'Search suggestions' });
      form.append(box);
      Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id, autocomplete: 'off' }).forEach(([k, v]) => input.setAttribute(k, v));
      let rows = [], active = -1, seq = 0, timer = null;
      const close = () => { box.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
      const open = () => { box.hidden = false; input.setAttribute('aria-expanded', 'true'); };
      const mark = n => {
        active = n;
        rows.forEach((r, k) => { r.el.classList.toggle('on', k === n); r.el.setAttribute('aria-selected', String(k === n)); });
        if (n >= 0) { input.setAttribute('aria-activedescendant', rows[n].el.id); rows[n].el.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
      };
      const rowBase = (n, href, onPick) => ({ class: 'sgrow', role: 'option', id: `${id}-${n}`, 'aria-selected': 'false', href,
        onmousedown: e => e.preventDefault(), onmousemove: () => mark(n), onclick: () => { if (onPick) onPick(); close(); input.blur(); } });
      const row = (u, q, n, isRecent) => ({ el: h('a', rowBase(n, '#/u/' + u.username, () => remember(u)),
        avatar(u.username, u.color, u.avatar),
        h('span', { class: 'sgtxt' }, h('b', null, hl(u.displayName, q), u.verified && NS.verifiedMark()), h('small', null, ' @', hl(u.username, q))),
        isRecent && h('span', { class: 'sgmeta' }, 'Recent'),
        !isRecent && u.live && h('span', { class: 'badge inline' }, 'LIVE'),
        !isRecent && u.following && h('span', { class: 'sgmeta' }, 'Following'),
        !isRecent && !u.following && h('span', { class: 'sgmeta' }, `${u.followers} follower${u.followers === 1 ? '' : 's'}`)) });
      const circleRow = (c, q, n) => ({ el: h('a', rowBase(n, '#/circle/' + c.slug),
        h('span', { class: 'sgico' }, c.emoji || NS.icon('circles', 18)),
        h('span', { class: 'sgtxt' }, h('b', null, hl(c.name, q)), h('small', null, ' Circle')),
        h('span', { class: 'sgmeta' }, `${c.members} member${c.members === 1 ? '' : 's'}`)) });
      const streamRow = (s, q, n) => ({ el: h('a', rowBase(n, '#/c/' + s.username),
        avatar(s.username, s.color, s.avatar),
        h('span', { class: 'sgtxt' }, h('b', null, hl(s.title, q)), h('small', null, ' @' + s.username)),
        h('span', { class: 'badge inline' }, 'LIVE')) });
      const showList = (people, q, isRecent, more = {}) => {
        rows = []; const parts = [];
        const group = (label, items, make) => {
          if (!items || !items.length) return;
          if (q) parts.push(h('div', { class: 'sghead' }, label));
          items.forEach(it => { const r = make(it, q, rows.length); rows.push(r); parts.push(r.el); });
        };
        group('People', people, (u, qq, n) => row(u, qq, n, isRecent));
        group('Circles', more.circles, circleRow);
        group('Live now', more.streams, streamRow);
        const hasAny = rows.length > 0;
        if (q) {
          const n = rows.length;
          const all = h('a', { ...rowBase(n, '#/search/' + encodeURIComponent(q)), class: 'sgrow sgall', id: `${id}-all` },
            h('span', { class: 'sgico' }, NS.icon('search', 18)), h('span', { class: 'sgtxt' }, hasAny ? 'See all results for ' : 'No quick matches. Try the full search for ', h('b', null, `“${q}”`)));
          rows.push({ el: all }); parts.push(all);
        }
        fill(box,
          isRecent && people.length && h('div', { class: 'sghead' }, 'Recent', h('button', { type: 'button', class: 'sgclear', onmousedown: e => e.preventDefault(), onclick: () => { forget(); close(); } }, 'Clear')),
          ...parts);
        active = -1;
        if (rows.length) open(); else close();
      };
      const run = async () => {
        const q = input.value.trim().replace(/^@/, '');
        if (q.length < 2) { onFocus(); return; }
        const mine = ++seq;
        try {
          const r = await api('/api/suggest?q=' + encodeURIComponent(q), { noExpire: true });
          if (mine === seq && document.activeElement === input) showList(r.users, q, false, { circles: r.circles, streams: r.streams });
        } catch { if (mine === seq) close(); }
      };
      function onFocus() {
        if (input.value.trim().length >= 2) { run(); return; }
        const r = recents();
        if (r.length) showList(r, '', true); else close();
      }
      input.addEventListener('focus', onFocus);
      input.addEventListener('input', () => { clearTimeout(timer); if (input.value.trim().length < 2) { seq++; onFocus(); return; } timer = setTimeout(run, 160); });
      input.addEventListener('blur', () => setTimeout(close, 120));
      input.addEventListener('keydown', e => {
        if (box.hidden && e.key === 'ArrowDown') { onFocus(); return; }
        if (box.hidden || !rows.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); mark((active + 1) % rows.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); mark((active - 1 + rows.length) % rows.length); }
        else if (e.key === 'Escape') { close(); }
        else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); rows[active].el.click(); }
      });
      form.addEventListener('submit', close);
      return { onFocus };
    }

    function composer(onPost, circle, canAnnounce) {
      const box = h('textarea', { rows: 3, maxlength: 500, placeholder: circle ? `Say something to ${circle.name}...` : 'Share an update, ask a question, or mention someone with @username', 'aria-label': 'New post' });
      const kind = h('select', { 'aria-label': 'Post type' }, h('option', { value: 'update' }, 'Update'), h('option', { value: 'question' }, 'Question'), canAnnounce && h('option', { value: 'announcement' }, 'Announcement'));
      const count = h('small', { class: 'hint' }, '0 / 500');
      const note = h('small', { class: 'hint attnote', role: 'status' });
      const tray = h('div', { class: 'tray', hidden: true });
      const picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', multiple: true, class: 'sr', tabindex: '-1', 'aria-hidden': 'true' });
      const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, NS.icon('image', 16), ' Photo or video');
      const postBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Post');
      let files = [], busy = 0;
      const draw = () => {
        tray.hidden = !files.length;
        fill(tray, ...files.map((f, n) => h('div', { class: 'att' },
          f.kind === 'video' ? h('div', { class: 'attvid' }, NS.icon('video', 22), h('small', null, 'Video')) : h('img', { src: f.thumb, alt: 'Attached picture ' + (n + 1) }),
          h('button', { type: 'button', class: 'attx', 'aria-label': 'Remove attachment ' + (n + 1), onclick: () => { files.splice(n, 1); draw(); } }, NS.icon('x', 14)))));
        const hasVideo = files.some(f => f.kind === 'video');
        addBtn.disabled = busy > 0 || hasVideo || files.length >= MAX_FILES;
        postBtn.disabled = busy > 0;
        note.textContent = busy ? 'Uploading...' : (files.length ? (hasVideo ? '1 video attached' : `${files.length} of ${MAX_FILES} pictures attached`) : '');
      };
      picker.addEventListener('change', async () => {
        const chosen = [...picker.files]; picker.value = '';
        for (const file of chosen) {
          const isVid = file.type.startsWith('video/');
          if (files.some(f => f.kind === 'video') || (isVid && files.length) || files.length >= MAX_FILES) { toast(isVid ? 'A video cannot be combined with other files.' : 'A post can hold one video, or up to 4 pictures.'); break; }
          busy++; draw();
          try { const prep = await prepareFile(file); const up = await uploadMedia(prep.blob); files.push({ id: up.id, kind: prep.kind, thumb: prep.thumb }); }
          catch (e) { toast(e.message); }
          busy--; draw();
        }
      });
      box.addEventListener('input', () => { count.textContent = `${box.value.length} / 500`; });
      draw();
      return h('form', { class: 'panel composer2', onsubmit: async e => {
        e.preventDefault();
        if (busy || (!box.value.trim() && !files.length)) return;
        try {
          const r = await api('/api/posts', { method: 'POST', body: { body: box.value, kind: kind.value, media: files.map(f => f.id), circle: circle ? circle.slug : undefined } });
          box.value = ''; count.textContent = '0 / 500'; files = []; draw(); onPost(r.post);
        } catch (ex) { toast(ex.message); }
      } }, box, tray, h('div', { class: 'row2 composer-bar' }, addBtn, kind, h('span', { class: 'grow' }), note, count, postBtn), picker);
    }

    function feedList(url, emptyMsg, opts = {}) {
      const list = h('div', { class: 'feed' });
      const more = h('button', { class: 'btn', hidden: true }, 'Show more');
      let next = null;
      const load = async (reset) => {
        if (reset) { next = null; fill(list); }
        try {
          const r = await api(url + (url.includes('?') ? '&' : '?') + (next ? 'before=' + next : ''));
          r.posts.forEach(p => list.append(postCard(p, opts)));
          next = r.next; more.hidden = !next;
          if (!list.children.length) list.append(h('p', { class: 'empty' }, emptyMsg));
        } catch (e) { toast(e.message); }
      };
      more.onclick = () => load(false);
      load(true);
      return { el: h('div', null, list, more), prepend: p => { const e = list.querySelector('.empty'); if (e) e.remove(); list.prepend(postCard(p, opts)); }, reload: () => load(true) };
    }

    async function feed(main) {
      let scope = S.user ? 'following' : 'discover';
      const page = h('div', { class: 'page narrow' });
      fill(main, page);
      let spot = null;
      const draw = () => {
        const tabs = h('div', { class: 'chips', role: 'tablist' },
          S.user && h('button', { class: 'chip' + (scope === 'following' ? ' on' : ''), role: 'tab', onclick: () => { scope = 'following'; draw(); } }, 'Following'),
          h('button', { class: 'chip' + (scope === 'discover' ? ' on' : ''), role: 'tab', onclick: () => { scope = 'discover'; draw(); } }, 'Discover'));
        const list = feedList(scope === 'following' ? '/api/feed?scope=following' : '/api/feed',
          scope === 'following' ? 'Your feed is empty. Follow creators, join Circles or publish a post.' : 'There are no posts yet.');
        fill(page, h('h1', null, 'Community feed'), h('p', { class: 'sub' }, 'Updates, questions and announcements from creators and Circles.'), spot, tabs,
          S.user ? composer(p => list.prepend(p)) : h('p', { class: 'panel' }, h('a', { href: '#/login', class: 'ul' }, 'Log in'), ' or ', h('a', { href: '#/signup', class: 'ul' }, 'sign up'), ' to post, react and comment, and to unlock streams, Circles, search and profiles.'), list.el);
      };
      draw();
      // Spotlight: the most talked-about recent posts, changing every 4 seconds
      api('/api/feed', { noExpire: true }).then(r => {
        const score = p => Object.values(p.reactions).reduce((a, b) => a + b, 0) + 2 * p.comments + 2 * p.reposts;
        const base = r.posts.filter(p => !p.isRepost && !p.circle);
        const pics = base.filter(p => (p.media || []).some(m => m.kind === 'image')).slice(0, 6);   // newest pictures first
        const text = base.filter(p => p.body && !pics.includes(p)).sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt).slice(0, Math.max(0, 5 - pics.length));
        spot = spotlight([...pics, ...text]);
        if (spot && page.isConnected) draw();
      }).catch(() => { /* the spotlight is optional */ });
    }

    async function postPage(main, id) {
      const page = h('div', { class: 'page narrow' });
      fill(main, page);
      try { const { post } = await api('/api/posts/' + id); fill(page, h('a', { href: '#/feed', class: 'backlink' }, NS.icon('chevronleft', 16), ' Back to feed'), postCard(post, { openComments: true, onDelete: () => go('#/feed') })); }
      catch (e) { fill(page, h('h1', null, 'Post not found'), h('p', { class: 'sub' }, e.message)); }
    }

    /* ---------------------------------------------------------- circles */
    function circleCard(c, onJoined) {
      const btn = h('button', { class: 'btn small ' + (c.joined ? '' : 'primary'), onclick: async e => {
        e.preventDefault();
        if (needLogin()) return;
        try { await api(`/api/circles/${c.slug}/${c.joined ? 'leave' : 'join'}`, { method: 'POST' }); c.joined = !c.joined; c.members += c.joined ? 1 : -1; draw(); if (onJoined) onJoined(c); } catch (ex) { toast(ex.message); }
      } });
      const card = h('a', { class: 'ccard', href: '#/circle/' + c.slug });
      const draw = () => {
        btn.textContent = c.joined ? 'Joined' : 'Join';
        btn.className = 'btn small ' + (c.joined ? '' : 'primary');
        fill(card, h('div', { class: 'cemoji', 'aria-hidden': 'true' }, c.emoji || ''),
          h('div', { class: 'cinfo' }, h('div', { class: 't' }, c.name), h('div', { class: 'g' }, c.description || 'A NovaStream Circle'),
            h('div', { class: 'g' }, `${c.members} member${c.members === 1 ? '' : 's'} · by ${c.owner.username}`, c.owner.live ? h('span', { class: 'badge inline' }, 'LIVE') : null)), btn);
      };
      draw();
      return card;
    }

    async function circles(main) {
      let mine = false;
      const page = h('div', { class: 'page' });
      fill(main, page);
      const draw = async () => {
        let list = [];
        try { list = (await api('/api/circles?sort=popular' + (mine ? '&mine=1' : ''))).circles; } catch (e) { toast(e.message); }
        fill(page,
          h('div', { class: 'row2' }, h('div', { class: 'grow' }, h('h1', null, 'Circles'), h('p', { class: 'sub' }, 'Small communities with a shared identity, events and goals. You do not need to pay or be famous to belong.')),
            h('a', { class: 'btn primary', href: S.user ? '#/circles/new' : '#/login' }, 'Start a Circle')),
          h('div', { class: 'chips' }, h('button', { class: 'chip' + (!mine ? ' on' : ''), onclick: () => { mine = false; draw(); } }, 'All'),
            S.user && h('button', { class: 'chip' + (mine ? ' on' : ''), onclick: () => { mine = true; draw(); } }, 'My Circles')),
          h('div', { class: 'cgrid' }, list.length ? list.map(c => circleCard(c)) : [h('p', { class: 'empty' }, mine ? 'You have not joined a Circle yet.' : 'No Circles yet. Start the first one!')]));
      };
      draw();
    }

    function newCircle(main) {
      if (needLogin()) return;
      const err = h('div', { class: 'err', role: 'alert' });
      const name = h('input', { maxlength: 40, required: true }), slug = h('input', { maxlength: 30, placeholder: 'auto from the name' });
      const emoji = h('input', { maxlength: 4, placeholder: '' }), desc = h('textarea', { rows: 3, maxlength: 300 });
      const gt = h('input', { maxlength: 60, placeholder: 'e.g. Reach 50 members' }), gn = h('input', { type: 'number', min: 0, max: 100000, placeholder: 'Target members' });
      fill(main, h('div', { class: 'page' }, h('form', { class: 'form wide', onsubmit: async e => {
        e.preventDefault(); err.textContent = '';
        try { const r = await api('/api/circles', { method: 'POST', body: { name: name.value, slug: slug.value, emoji: emoji.value, description: desc.value, goalTitle: gt.value, goalTarget: gn.value } }); go('#/circle/' + r.slug); }
        catch (ex) { err.textContent = ex.message; }
      } }, h('h1', null, 'Start a Circle'), h('p', { class: 'sub' }, 'A Circle is a home for your community: discussion, events, goals and member badges.'),
      field('Name', name), field('Web address', slug, 'Letters, numbers and dashes'), field('Emoji', emoji), field('Description', desc), field('Community goal (optional)', gt), field('Goal: number of members', gn),
      err, h('button', { class: 'btn primary', type: 'submit' }, 'Create Circle'))));
    }

    async function circlePage(main, slug) {
      let c;
      try { c = await api('/api/circles/' + encodeURIComponent(slug)); }
      catch (e) { fill(main, h('div', { class: 'page' }, h('h1', null, 'Circle not found'), h('p', { class: 'sub' }, e.message))); return; }
      const page = h('div', { class: 'page' });
      fill(main, page);
      const staff = c.role === 'owner' || c.role === 'mod';
      const reload = () => route2();
      const route2 = () => circlePage(main, slug);

      const joinBtn = c.role === 'owner' ? null : h('button', { class: 'btn ' + (c.isMember ? '' : 'primary'), onclick: async () => {
        if (needLogin()) return;
        try { await api(`/api/circles/${slug}/${c.isMember ? 'leave' : 'join'}`, { method: 'POST' }); toast(c.isMember ? 'You left the Circle.' : 'Welcome to the Circle!'); reload(); } catch (e) { toast(e.message); }
      } }, c.isMember ? 'Leave' : 'Join Circle');

      const list = feedList('/api/feed?circle=' + encodeURIComponent(slug), c.isMember ? 'No posts yet. Introduce yourself!' : 'No posts yet. Join and be the first to say hello.', { canModerate: staff });
      const goal = c.goal && h('div', { class: 'goal' }, h('div', { class: 'row2' }, h('b', null, '' + c.goal.title), h('span', { class: 'grow' }), h('small', null, c.goal.done ? 'Goal reached!' : `${c.goal.progress} / ${c.goal.target}`)),
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': Math.min(c.goal.progress, c.goal.target), 'aria-valuemin': 0, 'aria-valuemax': c.goal.target }, h('div', { style: `width:${Math.min(100, Math.round((c.goal.progress / c.goal.target) * 100))}%` })));

      // events
      const evBox = h('section', { class: 'panel' }, h('h3', null, 'Upcoming events'));
      evBox.append(...(c.events.length ? c.events.map(e => h('div', { class: 'event' },
        h('b', null, e.title), h('div', { class: 'g' }, new Date(e.startsAt).toLocaleString()), e.description && h('div', { class: 'g' }, e.description),
        h('div', { class: 'row2' }, h('button', { class: 'btn small ' + (e.going ? 'ok' : ''), onclick: async () => {
          if (needLogin()) return;
          try { await api(`/api/circles/${slug}/events/${e.id}/rsvp`, { method: 'POST' }); reload(); } catch (ex) { toast(ex.message); }
        } }, e.going ? "✓ I'm going" : 'RSVP'), h('small', { class: 'g' }, `${e.rsvps} going`),
          staff && h('button', { class: 'btn small', onclick: async () => { await api(`/api/circles/${slug}/events/${e.id}`, { method: 'DELETE' }); reload(); } }, 'Remove'))))
        : [h('p', { class: 'empty' }, 'No events scheduled.')]));
      if (staff) {
        const t = h('input', { placeholder: 'Event title', maxlength: 80, 'aria-label': 'Event title' });
        const d = h('input', { type: 'datetime-local', 'aria-label': 'Start time' });
        evBox.append(h('form', { class: 'pollform', onsubmit: async e => {
          e.preventDefault();
          try { await api(`/api/circles/${slug}/events`, { method: 'POST', body: { title: t.value, startsAt: new Date(d.value).getTime() } }); toast('Event scheduled. Members were notified.'); reload(); } catch (ex) { toast(ex.message); }
        } }, t, d, h('button', { class: 'btn primary small', type: 'submit' }, 'Schedule event')));
      }

      const removeBtn = m => (staff && m.role !== 'owner' && !(m.role === 'mod' && c.role !== 'owner') && m.username !== S.user.username)
        ? h('button', { class: 'btn small', onclick: async () => {
            if (!confirm(`Remove @${m.username} from this Circle?`)) return;
            const ban = confirm('Also stop them from rejoining?\n\nOK = remove and ban\nCancel = just remove');
            try { await api(`/api/circles/${slug}/members/${m.username}/remove`, { method: 'POST', body: { ban } }); toast(ban ? 'Removed and banned.' : 'Removed.'); reload(); } catch (e) { toast(e.message); }
          } }, 'Remove') : null;
      // members
      const memBox = h('section', { class: 'panel' }, h('h3', null, `Members (${c.members.length})`),
        h('div', { class: 'list' }, c.members.slice(0, 40).map(m => h('div', { class: 'member' }, person({ username: m.username, displayName: m.displayName, avatar: m.avatar, color: m.color }),
          h('div', { class: 'mb' }, m.badges.map(b => h('span', { class: 'tag', title: b.label }, `${b.emoji} ${b.label}`))), removeBtn(m),
          c.role === 'owner' && m.role !== 'owner' && h('button', { class: 'btn small', onclick: async () => {
            try { await api(`/api/circles/${slug}/role`, { method: 'POST', body: { username: m.username, role: m.role === 'mod' ? 'member' : 'mod' } }); reload(); } catch (e) { toast(e.message); }
          } }, m.role === 'mod' ? 'Remove mod' : 'Make mod')))));

      const history = h('section', { class: 'panel' }, h('h3', null, 'Our story'), h('ul', { class: 'list' }, c.milestones.map(m => h('li', null, h('b', null, m.label), ' · ' + new Date(m.at).toLocaleDateString()))),
        S.user && c.role !== 'owner' ? h('button', { class: 'btn small', onclick: () => NS.report({ type: 'circle', target: slug, label: 'this Circle' }) }, '⚑ Report this Circle') : null);

      let editBox = null;
      if (c.role === 'owner') {
        const d = h('textarea', { rows: 3, maxlength: 300 }, c.description), gt = h('input', { value: c.goal ? c.goal.title : '', maxlength: 60, placeholder: 'Goal title' }), gn = h('input', { type: 'number', value: c.goal ? c.goal.target : 0, min: 0 });
        editBox = h('section', { class: 'panel' }, h('h3', null, 'Edit Circle'), field('Description', d), field('Goal title', gt), field('Goal members', gn),
          h('button', { class: 'btn primary small', onclick: async () => { try { await api('/api/circles/' + slug, { method: 'PUT', body: { description: d.value, goalTitle: gt.value, goalTarget: Number(gn.value) } }); toast('Saved.'); reload(); } catch (e) { toast(e.message); } } }, 'Save'));
      }

      fill(page,
        h('div', { class: 'chead' }, h('div', { class: 'cemoji big', 'aria-hidden': 'true' }, c.emoji || ''),
          h('div', { class: 'grow' }, h('h1', null, c.name), h('p', { class: 'sub' }, c.description),
            h('div', { class: 'counts' }, h('span', null, h('b', null, c.members.length), ' members'), h('span', null, 'Created by ', h('a', { class: 'ul', href: '#/u/' + c.owner.username }, '@' + c.owner.username)),
              c.owner.live ? h('a', { class: 'btn danger small', href: '#/c/' + c.owner.username }, 'Watch live') : null)), joinBtn),
        goal,
        h('div', { class: 'cols3' },
          h('div', null, c.isMember ? composer(p => list.prepend(p), c, staff) : h('p', { class: 'panel' }, 'Join this Circle to post and join the conversation.'), list.el),
          h('div', null, evBox, memBox, history, editBox)));
    }

    /* ---------------------------------------------------- notifications */
    async function notifications(main) {
      if (needLogin()) return;
      const page = h('div', { class: 'page narrow' });
      fill(main, page);
      let d;
      try { d = await api('/api/notifications'); } catch (e) { fill(page, h('p', { class: 'err' }, e.message)); return; }
      const prefs = { ...d.prefs };
      const hours = Array.from({ length: 24 }, (_, i) => i);
      const qs = h('select', { 'aria-label': 'Quiet hours start' }, h('option', { value: -1 }, 'Off'), hours.map(i => h('option', { value: i, selected: i === d.quietStart }, `${String(i).padStart(2, '0')}:00`)));
      const qe = h('select', { 'aria-label': 'Quiet hours end' }, h('option', { value: -1 }, 'Off'), hours.map(i => h('option', { value: i, selected: i === d.quietEnd }, `${String(i).padStart(2, '0')}:00`)));
      fill(page,
        h('div', { class: 'row2' }, h('h1', { class: 'grow' }, 'Notifications'), h('button', { class: 'btn small', onclick: async () => { await api('/api/notifications/read', { method: 'POST' }); NS.setUnread(0); NS.route(); } }, 'Mark all read')),
        d.notifications.length ? h('div', { class: 'nlist' }, d.notifications.map(n => h('a', { class: 'nitem' + (n.read ? '' : ' unread'), href: n.link || '#/notifications' },
          h('span', { class: 'nicon t-' + n.type, 'aria-hidden': 'true' }, NS.icon(NICON[n.type] || 'bell', 20)), h('span', { class: 'grow' }, n.text), h('small', null, ago(n.createdAt)))))
          : h('p', { class: 'empty' }, 'You are all caught up. New followers, replies and events will show up here.'),
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'What should we tell you about?'),
          h('div', { class: 'list' }, Object.keys(TYPE_LABELS).map(k => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs[k], onchange: e => { prefs[k] = e.target.checked; } }), TYPE_LABELS[k]))),
          h('h2', { class: 'h2' }, 'Quiet hours'), h('p', { class: 'hint' }, 'Alerts are still saved here, but no pop-ups appear during these hours.'),
          h('div', { class: 'linkrow' }, h('span', null, 'From'), qs, h('span', null, 'to'), qe),
          h('button', { class: 'btn primary', onclick: async () => {
            try { await api('/api/notifications/prefs', { method: 'PUT', body: { prefs, quietStart: Number(qs.value), quietEnd: Number(qe.value), tzOffset: -new Date().getTimezoneOffset() } }); toast('Preferences saved.'); } catch (e) { toast(e.message); }
          } }, 'Save preferences')));
      if (d.unread) { try { await api('/api/notifications/read', { method: 'POST' }); NS.setUnread(0); } catch { /* ignore */ } }
    }

    /* ------------------------------------------------------------ search */
    async function search(main, q) {
      const page = h('div', { class: 'page' });
      fill(main, page);
      const input = h('input', { type: 'search', value: q, placeholder: 'Find people, streams, Circles and posts...', 'aria-label': 'Search' });
      const type = h('select', { 'aria-label': 'Type' }, [['all', 'Everything'], ['streams', 'Live streams'], ['users', 'People'], ['circles', 'Circles'], ['posts', 'Posts']].map(([v, l]) => h('option', { value: v }, l)));
      const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'Any category'), S.cfg.categories.map(c => h('option', null, c)));
      const live = h('input', { type: 'checkbox', 'aria-label': 'Live only' });
      const out = h('div');
      const run = async () => {
        const params = new URLSearchParams({ q: input.value.trim(), type: type.value, category: cat.value, live: live.checked ? '1' : '0' });
        try {
          const r = await api('/api/search?' + params);
          if (r.hint) { fill(out, h('p', { class: 'empty' }, r.hint)); return; }
          const none = !r.streams.length && !r.users.length && !r.circles.length && !r.posts.length;
          fill(out,
            none && h('p', { class: 'empty' }, 'No results. Try different words or fewer filters.'),
            r.streams.length ? h('section', null, h('h2', { class: 'h2' }, 'Live streams'), h('div', { class: 'grid' }, r.streams.map(s => NS.streamCard(s)))) : null,
            r.users.length ? h('section', null, h('h2', { class: 'h2' }, 'People'), h('div', { class: 'list' }, r.users.map(u => h('a', { class: 'panel urow', href: '#/u/' + u.username },
              avatar(u.username, u.color, u.avatar), h('div', { class: 'grow' }, h('b', null, u.displayName), h('small', null, ' @' + u.username), u.live ? h('span', { class: 'badge inline' }, 'LIVE') : null, h('div', { class: 'g' }, u.bio || u.interests.join(', '))), h('small', null, `${u.followers} followers`))))) : null,
            r.circles.length ? h('section', null, h('h2', { class: 'h2' }, 'Circles'), h('div', { class: 'cgrid' }, r.circles.map(c => circleCard(c)))) : null,
            r.posts.length ? h('section', { class: 'narrow2' }, h('h2', { class: 'h2' }, 'Posts'), r.posts.map(p => postCard(p))) : null);
        } catch (e) { toast(e.message); }
      };
      const sfwrap = h('div', { class: 'sfwrap' }, input);
      attachSuggest(sfwrap);
      fill(page, h('h1', null, 'Search'), h('form', { class: 'sfilters', role: 'search', onsubmit: e => { e.preventDefault(); history.replaceState(null, '', '#/search/' + encodeURIComponent(input.value.trim())); run(); } },
        sfwrap, type, cat, h('label', { class: 'check' }, live, 'Live only'), h('button', { class: 'btn primary', type: 'submit' }, 'Search')), out);
      if (q) run(); else fill(out, h('p', { class: 'empty' }, 'Type at least two letters, or choose a category or “Live only”.'));
    }

    return { feed, postPage, circles, newCircle, circlePage, notifications, search, circleCard, postCard, feedList, richText, spotlight, attachSuggest };
  }
};
