// NovaStream admin area, account settings, legal pages and password recovery. Registered by app.js.
window.NSAdmin = {
  register(NS) {
    const { h, S, api, fill, toast, go, field, ago } = NS;
    const when = ms => (ms ? new Date(ms).toLocaleString() : 'never');
    const dur = s => (s >= 86400 ? Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h' : s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : Math.floor(s / 60) + 'm');
    const download = (text, name, type = 'application/json') => {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
      document.body.append(a); a.click(); a.remove();
    };

    /* ------------------------------------------------------- legal pages */
    function renderBody(text) {
      const out = []; let list = null, para = [];
      const flush = () => { if (para.length) { out.push(h('p', null, para.join(' '))); para = []; } };
      for (const line of String(text).split('\n')) {
        if (line.startsWith('## ')) { flush(); list = null; out.push(h('h2', { class: 'h2' }, line.slice(3))); }
        else if (line.startsWith('- ')) { flush(); if (!list) { list = h('ul', { class: 'bullets' }); out.push(list); } list.append(h('li', null, line.slice(2))); }
        else if (!line.trim()) { flush(); list = null; }
        else { list = null; para.push(line.trim()); }
      }
      flush();
      return out;
    }
    async function legal(main, slug) {
      const page = h('div', { class: 'page narrow legal' });
      fill(main, page);
      try {
        const r = await api('/api/legal/' + encodeURIComponent(slug));
        fill(page, h('h1', null, r.title), h('p', { class: 'hint' }, 'Last updated ' + new Date(r.updatedAt).toLocaleDateString()), ...renderBody(r.body),
          h('div', { class: 'row2' }, ['guidelines', 'terms', 'privacy'].filter(x => x !== slug).map(x => h('a', { class: 'btn small', href: '#/legal/' + x }, x === 'guidelines' ? 'Community Guidelines' : x === 'terms' ? 'Terms' : 'Privacy'))));
      } catch (e) { fill(page, h('h1', null, 'Page not found'), h('p', { class: 'sub' }, e.message)); }
    }

    /* --------------------------------------------------- password recovery */
    function resetPage(main) {
      const err = h('div', { class: 'err', role: 'alert' });
      const u = h('input', { required: true, autocomplete: 'username' }), c = h('input', { required: true, autocomplete: 'one-time-code', placeholder: '10 letters and numbers' });
      const p = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
      fill(main, h('div', { class: 'page' }, h('form', { class: 'form', onsubmit: async e => {
        e.preventDefault(); err.textContent = '';
        try {
          await api('/api/reset-password', { method: 'POST', body: { username: u.value, code: c.value, newPassword: p.value } });
          fill(main, h('div', { class: 'page' }, h('div', { class: 'form' }, h('h1', null, 'Password changed'), h('p', null, 'You can log in with your new password now.'), h('a', { class: 'btn primary', href: '#/login' }, 'Log in'))));
        } catch (ex) { err.textContent = ex.message; }
      } },
      h('h1', null, 'Reset your password'),
      h('p', { class: 'hint' }, 'NovaStream does not send emails yet. Ask a NovaStream admin for a one-time recovery code (they will check it is really you), then enter it here. Codes last 24 hours and work once.'),
      field('Username', u), field('Recovery code', c), field('New password', p, 'At least 8 characters'), err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Set new password'), h('a', { href: '#/login', class: 'hint' }, 'Back to log in'))));
    }

    /* ----------------------------------------------------- account settings */
    async function settings(main) {
      if (!S.user) return go('#/login');
      const page = h('div', { class: 'page narrow' });
      fill(main, page);
      const keepSession = r => { S.token = r.token; localStorage.setItem('novastream_token', r.token); NS.connectSocket(); };
      const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true }), nxt = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
      const pwErr = h('div', { class: 'err', role: 'alert' });
      const delPw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password' });
      const delOk = h('input', { type: 'checkbox', 'aria-label': 'I understand' });
      // appearance: light, dark, or follow the device
      const themeBox = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Colour theme' });
      const drawTheme = () => {
        const cur = window.NSTheme.mode();
        fill(themeBox, ...[['system', 'Match my device', 'sparkles'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([v, label, ic]) =>
          h('button', { type: 'button', class: 'segb' + (cur === v ? ' on' : ''), role: 'radio', 'aria-checked': String(cur === v), onclick: () => { window.NSTheme.set(v); drawTheme(); } }, NS.icon(ic, 18), h('span', null, label))));
      };
      drawTheme();
      fill(page, h('h1', null, 'Account settings'), h('p', { class: 'sub' }, `Signed in as @${S.user.username}`),
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Appearance'), h('p', { class: 'hint' }, 'Black and white, in a light or dark version. “Match my device” follows your phone or computer. Your choice is remembered on this device.'), themeBox,
          h('label', { class: 'row2 ucrow' }, h('input', { type: 'checkbox', checked: window.NSTheme.userColors(), onchange: e => window.NSTheme.setUserColors(e.target.checked) }), h('span', null, 'Coloured usernames in chat'),
            h('small', { class: 'hint' }, 'Off by default. Turn on if you find it easier to tell people apart by colour.'))),
        S.user.isTeen ? h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Extra protection for under-18 accounts'),
          h('ul', { class: 'bullets' }, ['No external links on your profile', 'Your profile is not listed in people search', 'Your bio and interests are only visible to logged-in people', 'Quiet hours from 10pm to 7am (change them in Notifications)'].map(x => h('li', null, x)))) : null,
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Change password'),
          h('form', { class: 'stack', onsubmit: async e => {
            e.preventDefault(); pwErr.textContent = '';
            try { const r = await api('/api/account/password', { method: 'PUT', body: { current: cur.value, next: nxt.value } }); keepSession(r); cur.value = ''; nxt.value = ''; toast('Password changed. Your other devices were signed out.'); }
            catch (ex) { pwErr.textContent = ex.message; }
          } }, field('Current password', cur), field('New password', nxt, 'At least 8 characters'), pwErr, h('button', { class: 'btn primary', type: 'submit' }, 'Change password'))),
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Sessions'), h('p', { class: 'hint' }, 'Signed in somewhere you no longer use? Sign out of every device, including this one stays signed in.'),
          h('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/account/logout-all', { method: 'POST' }); keepSession(r); toast('Signed out of all other devices.'); } catch (e) { toast(e.message); } } }, 'Log out of all devices')),
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Notifications and blocking'), h('p', { class: 'hint' }, 'Choose which alerts you get and set quiet hours. Blocked people are listed under Edit profile.'),
          h('div', { class: 'row2' }, h('a', { class: 'btn', href: '#/notifications' }, 'Notification settings'), h('a', { class: 'btn', href: '#/u/' + S.user.username }, 'My profile'))),
        h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Your data'), h('p', { class: 'hint' }, 'Download a copy of everything NovaStream holds about you: profile, posts, comments, follows, Circles and more.'),
          h('button', { class: 'btn', onclick: async () => { try { download(JSON.stringify(await api('/api/account/export'), null, 2), 'novastream-my-data.json'); } catch (e) { toast(e.message); } } }, 'Download my data')),
        h('section', { class: 'panel danger-zone' }, h('h2', { class: 'h2' }, 'Delete my account'),
          h('p', { class: 'hint' }, 'This removes your profile, posts, comments, follows and notifications for good. Circles you own pass to a member. It cannot be undone.'),
          field('Your password', delPw), h('label', { class: 'check' }, delOk, 'I understand this is permanent'),
          h('button', { class: 'btn danger', onclick: async () => {
            if (!delOk.checked) return toast('Tick the box to confirm.');
            try { await api('/api/account/delete', { method: 'POST', body: { password: delPw.value } }); toast('Your account was deleted. Goodbye, and thanks for being here.', 6000); NS.sessionExpired('Your account was deleted.'); } catch (e) { toast(e.message); }
          } }, 'Delete my account')));
    }

    /* ============================================================== admin */
    const TABS = [['overview', 'Overview'], ['reports', 'Reports'], ['users', 'Users'], ['appeals', 'Appeals'], ['streams', 'Live streams'], ['content', 'Content'], ['words', 'Word filter'], ['settings', 'Site settings'], ['legal', 'Legal pages'], ['backups', 'Backups'], ['audit', 'Audit log']];
    let openUser = null; // set when jumping from a report to an account

    const stat = (n, label, warn) => h('div', { class: 'stat' + (warn ? ' warn' : '') }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label));
    const pager = (pg, pages, go2) => pages > 1 ? h('div', { class: 'row2 pager' }, h('button', { class: 'btn small', disabled: pg <= 1, onclick: () => go2(pg - 1) }, '← Prev'), h('span', { class: 'hint' }, `Page ${pg} of ${pages}`), h('button', { class: 'btn small', disabled: pg >= pages, onclick: () => go2(pg + 1) }, 'Next →')) : null;
    const statusTag = s => h('span', { class: 'abadge ' + s }, s);

    async function admin(main, tab) {
      if (!S.user || !S.user.isAdmin) { fill(main, h('div', { class: 'page' }, h('h1', null, 'Admins only'), h('p', { class: 'sub' }, 'This area is for NovaStream admins.'))); return; }
      if (!TABS.some(([k]) => k === tab)) tab = 'overview';
      const body = h('div', { class: 'abody' });
      fill(main, h('div', { class: 'page admin' }, h('h1', null, 'Admin'),
        h('nav', { class: 'atabs', 'aria-label': 'Admin sections' }, TABS.map(([k, l]) => h('a', { class: 'chip' + (k === tab ? ' on' : ''), href: '#/admin/' + k, 'aria-current': k === tab ? 'page' : null }, l))), body));
      try { await views[tab](body); } catch (e) { fill(body, h('p', { class: 'err' }, e.message)); }
    }

    const views = {
      /* ---- overview ---- */
      async overview(body) {
        const d = await api('/api/admin/overview');
        const c = d.counts, s = d.system;
        fill(body,
          d.warnings.length ? h('div', { class: 'warnlist' }, d.warnings.map(w => h('div', { class: 'warn-' + w.level }, w.text))) : h('p', { class: 'ok' }, 'Everything looks healthy.'),
          h('div', { class: 'stats' }, stat(c.users, 'People'), stat(c.newToday, 'New in 24h'), stat(c.teens, 'Under 18'), stat(c.admins, 'Admins'), stat(c.restricted, 'Suspended or banned'),
            stat(c.live, 'Live now'), stat(c.viewers, 'Watching now'), stat(c.connections, 'Open connections'), stat(c.posts, 'Posts'), stat(c.circles, 'Circles'),
            stat(c.openReports, 'Open reports', c.openReports > 0), stat(c.urgentReports, 'Urgent reports', c.urgentReports > 0), stat(c.openAppeals, 'Open appeals', c.openAppeals > 0)),
          h('div', { class: 'cols' },
            h('section', { class: 'panel' }, h('h3', null, 'Server'), h('ul', { class: 'list' },
              h('li', null, h('b', null, 'Uptime: '), dur(s.uptimeSec)), h('li', null, h('b', null, 'Memory: '), s.memoryMb + ' MB'), h('li', null, h('b', null, 'Database: '), s.dbMb + ' MB'),
              h('li', null, h('b', null, 'Node: '), s.node), h('li', null, h('b', null, 'Mode: '), s.production ? 'production' : 'development'),
              h('li', null, h('b', null, 'Last backup: '), s.lastBackup ? when(s.lastBackup) : 'none yet'), h('li', null, h('b', null, 'Errors in 24h: '), s.errors24h))),
            h('section', { class: 'panel' }, h('h3', null, 'Live right now'), d.live.length ? h('ul', { class: 'list' }, d.live.map(l => h('li', null, h('a', { href: '#/c/' + l.channel, class: 'ul' }, l.channel), ` - ${l.title} (${l.viewers} watching)`))) : h('p', { class: 'empty' }, 'Nobody is live.'))),
          h('section', { class: 'panel' }, h('h3', null, 'Recent server errors'), d.errors.length ? h('ul', { class: 'list' }, d.errors.map(e => h('li', null, `${when(e.at)} - [${e.place}] ${e.message}`))) : h('p', { class: 'empty' }, 'No errors recorded.')));
      },

      /* ---- reports ---- */
      async reports(body, state = { status: 'open', type: '', category: '', page: 1 }) {
        const qs = new URLSearchParams({ status: state.status, type: state.type, category: state.category, page: state.page });
        const d = await api('/api/admin/reports?' + qs);
        const sel = (key, opts) => h('select', { 'aria-label': key, onchange: e => { state[key] = e.target.value; state.page = 1; views.reports(body, state); } }, opts.map(([v, l]) => h('option', { value: v, selected: state[key] === v }, l)));
        const card = r => {
          const act = h('select', { 'aria-label': 'Action' }, [['dismiss', 'Dismiss (no action)'], ['warn', 'Warn the person'], ...(['post', 'comment'].includes(r.type) ? [['delete_content', 'Delete the content']] : []), ['suspend', 'Suspend the account'], ['ban', 'Ban the account']].map(([v, l]) => h('option', { value: v }, l)));
          const note = h('input', { placeholder: 'Reason (the person sees this)', maxlength: 300, 'aria-label': 'Reason' });
          const hours = h('input', { type: 'number', min: 1, max: 8760, value: 24, 'aria-label': 'Hours', class: 'narrow-in' });
          const hoursWrap = h('label', { class: 'inline', hidden: true }, 'Hours ', hours);
          act.addEventListener('change', () => { hoursWrap.hidden = act.value !== 'suspend'; });
          return h('article', { class: 'rcard' + (r.priority ? ' urgent' : '') },
            h('div', { class: 'row2' }, r.priority ? h('span', { class: 'abadge banned' }, 'URGENT') : null, h('span', { class: 'abadge' }, r.type), h('b', null, r.category), h('span', { class: 'grow' }), h('small', null, when(r.createdAt))),
            h('p', { class: 'hint' }, `Reported by @${r.reporter}`, r.reported ? [' · about ', h('b', null, '@' + r.reported)] : null, r.channel ? ` · in ${r.channel}'s chat` : '', r.reportedStatus && r.reportedStatus !== 'active' ? [' · ', statusTag(r.reportedStatus)] : null),
            r.context ? h('blockquote', null, r.context) : null,
            r.reason && r.reason !== r.category ? h('p', null, h('b', null, 'Their note: '), r.reason) : null,
            r.others ? h('p', { class: 'hint' }, `${r.others} other open report${r.others > 1 ? 's' : ''} about the same thing`) : null,
            r.status === 'open'
              ? h('div', { class: 'row2 wrap' }, act, hoursWrap, note,
                  h('button', { class: 'btn primary small', onclick: async () => {
                    try { await api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST', body: { action: act.value, note: note.value, hours: Number(hours.value) } }); toast('Report handled.'); views.reports(body, state); } catch (e) { toast(e.message); }
                  } }, 'Resolve'),
                  r.reportedUserId ? h('button', { class: 'btn small', onclick: () => { openUser = r.reportedUserId; go('#/admin/users'); } }, 'Open account') : null,
                  r.type === 'post' ? h('a', { class: 'btn small', href: '#/post/' + r.target }, 'View post') : null)
              : h('p', { class: 'ok' }, `Handled: ${r.resolution} · ${when(r.handledAt)}`));
        };
        fill(body,
          h('div', { class: 'row2 wrap' }, sel('status', [['open', 'Open'], ['resolved', 'Handled'], ['all', 'All']]), sel('type', [['', 'Any type'], ['chat', 'Chat'], ['post', 'Posts'], ['comment', 'Comments'], ['user', 'Profiles'], ['circle', 'Circles'], ['stream', 'Streams']]),
            sel('category', [['', 'Any reason'], ['self-harm', 'Self-harm'], ['underage', 'Under-age'], ['harassment', 'Harassment'], ['hate', 'Hate'], ['sexual', 'Sexual'], ['violence', 'Violence'], ['spam', 'Spam'], ['impersonation', 'Impersonation'], ['other', 'Other']]),
            h('span', { class: 'hint' }, `${d.total} report${d.total === 1 ? '' : 's'}`)),
          d.reports.length ? h('div', { class: 'rlist' }, d.reports.map(card)) : h('p', { class: 'empty' }, state.status === 'open' ? 'No open reports. Nicely done.' : 'Nothing here.'),
          pager(d.page, d.pages, p => { state.page = p; views.reports(body, state); }));
      },

      /* ---- users ---- */
      async users(body, state = { q: '', status: '', page: 1 }) {
        const detail = h('div');
        const qs = new URLSearchParams({ q: state.q, status: state.status, page: state.page });
        const d = await api('/api/admin/users?' + qs);
        const input = h('input', { type: 'search', value: state.q, placeholder: 'Search by username or name', 'aria-label': 'Search accounts' });
        const showDetail = async id => {
          const r = await api('/api/admin/users/' + id);
          const u = r.user;
          const reason = h('input', { placeholder: 'Reason (the person sees this)', maxlength: 300, 'aria-label': 'Reason' });
          const hours = h('input', { type: 'number', min: 1, max: 8760, value: 24, class: 'narrow-in', 'aria-label': 'Suspension hours' });
          const codeBox = h('div');
          const run = (action, label, opts = {}) => h('button', { class: 'btn small ' + (opts.danger ? 'danger' : ''), onclick: async () => {
            if (opts.confirm && !confirm(opts.confirm)) return;
            try {
              const res = await api(`/api/admin/users/${u.id}/action`, { method: 'POST', body: { action, reason: reason.value, hours: Number(hours.value) } });
              if (res.code) { fill(codeBox, h('div', { class: 'codebox' }, h('b', null, 'Recovery code (shown once): '), h('code', null, res.code), h('p', { class: 'hint' }, 'Give it to the person privately. It works once and expires ' + when(res.expiresAt) + '.'))); toast('Recovery code created.'); return; }
              toast(label + ' done.'); if (action === 'delete') { detail.replaceChildren(); views.users(body, state); } else { showDetail(u.id); views.users(body, state); }
            } catch (e) { toast(e.message); }
          } }, label);
          fill(detail, h('section', { class: 'panel manage' },
            h('div', { class: 'row2' }, h('h2', { class: 'h2 grow' }, `@${u.username}`), statusTag(u.status), u.role === 'admin' ? h('span', { class: 'abadge admin' }, 'admin') : null, u.verified ? NS.verifiedMark() : null, u.teen ? h('span', { class: 'abadge' }, 'under 18') : null,
              h('button', { class: 'btn small', onclick: () => detail.replaceChildren() }, 'Close')),
            h('p', { class: 'hint' }, `Joined ${when(u.createdAt)} · last login ${when(u.lastLogin)} · born ${u.dob}`, u.status !== 'active' ? ` · ${u.reason}${u.until ? ' (until ' + when(u.until) + ')' : ''}` : ''),
            u.bio ? h('p', null, u.bio) : null,
            h('div', { class: 'row2 wrap' }, reason, h('label', { class: 'inline' }, 'Hours ', hours)),
            h('div', { class: 'row2 wrap' }, run('warn', 'Warn'), run('suspend', 'Suspend', { danger: true }), run('ban', 'Ban', { danger: true }), u.status !== 'active' ? run('unban', 'Lift restriction') : null,
              u.verified ? run('unverify', 'Remove tick') : run('verify', 'Verify'), u.role === 'admin' ? run('remove_admin', 'Remove admin') : run('make_admin', 'Make admin', { confirm: `Give @${u.username} full admin powers?` }),
              run('clear_profile', 'Clear profile'), run('logout', 'Log out everywhere'), run('reset_code', 'Recovery code'), run('delete', 'Delete account', { danger: true, confirm: `Permanently delete @${u.username} and their content?` })),
            codeBox,
            h('div', { class: 'cols' },
              h('div', null, h('h3', null, 'History'), r.history.length ? h('ul', { class: 'list' }, r.history.map(x => h('li', null, h('b', null, x.action), ` by ${x.by}: ${x.reason} (${ago(x.at)})`))) : h('p', { class: 'empty' }, 'Clean record.'),
                h('h3', null, 'Appeals'), r.appeals.length ? h('ul', { class: 'list' }, r.appeals.map(x => h('li', null, `${x.status}: "${x.message}"`, x.response ? ` → ${x.response}` : ''))) : h('p', { class: 'empty' }, 'None.')),
              h('div', null, h('h3', null, `Reports about them (${r.reports.length})`), r.reports.length ? h('ul', { class: 'list' }, r.reports.map(x => h('li', null, `${x.category} (${x.type}) from @${x.reporter} - ${x.status}`))) : h('p', { class: 'empty' }, 'None.'),
                h('h3', null, 'Circles'), r.circles.length ? h('ul', { class: 'list' }, r.circles.map(x => h('li', null, h('a', { class: 'ul', href: '#/circle/' + x.slug }, x.name), ` (${x.role})`))) : h('p', { class: 'empty' }, 'None.'),
                h('h3', null, 'Recent posts'), r.posts.length ? h('ul', { class: 'list' }, r.posts.map(x => h('li', null, x.body.slice(0, 90)))) : h('p', { class: 'empty' }, 'None.')))));
          detail.scrollIntoView({ block: 'nearest' });
        };
        fill(body,
          h('form', { class: 'row2 wrap', onsubmit: e => { e.preventDefault(); state.q = input.value; state.page = 1; views.users(body, state); } }, input,
            h('select', { 'aria-label': 'Filter', onchange: e => { state.status = e.target.value; state.page = 1; views.users(body, state); } }, [['', 'Everyone'], ['active', 'Active'], ['restricted', 'Suspended or banned'], ['admin', 'Admins']].map(([v, l]) => h('option', { value: v, selected: state.status === v }, l))),
            h('button', { class: 'btn primary small', type: 'submit' }, 'Search'), h('span', { class: 'hint' }, `${d.total} account${d.total === 1 ? '' : 's'}`)),
          detail,
          h('div', { class: 'tbl' }, h('div', { class: 'atr ath' }, ['Account', 'Joined', 'Last login', 'Posts', 'Reports', 'Status', ''].map(x => h('span', null, x))),
            d.users.map(u => h('div', { class: 'atr' }, h('span', null, h('b', null, u.username), u.verified ? NS.verifiedMark() : null, u.role === 'admin' ? h('span', { class: 'abadge admin' }, 'admin') : null, u.teen ? h('span', { class: 'abadge' }, '<18') : null),
              h('span', null, new Date(u.createdAt).toLocaleDateString()), h('span', null, u.lastLogin ? ago(u.lastLogin) : 'never'), h('span', null, u.posts), h('span', null, u.reportsAgainst), h('span', null, statusTag(u.status)),
              h('button', { class: 'btn small', onclick: () => showDetail(u.id) }, 'Manage')))),
          pager(d.page, d.pages, p => { state.page = p; views.users(body, state); }));
        if (openUser) { const id = openUser; openUser = null; showDetail(id); }
      },

      /* ---- appeals ---- */
      async appeals(body) {
        const d = await api('/api/admin/appeals?status=all');
        const card = a => {
          const reply = h('input', { placeholder: 'Your reply to the person', maxlength: 500, 'aria-label': 'Reply' });
          const resolve = decision => async () => { try { await api(`/api/admin/appeals/${a.id}/resolve`, { method: 'POST', body: { decision, response: reply.value } }); toast('Appeal ' + decision + 'd.'); views.appeals(body); } catch (e) { toast(e.message); } };
          return h('article', { class: 'rcard' }, h('div', { class: 'row2' }, h('b', null, '@' + a.username), statusTag(a.accountStatus || 'active'), h('span', { class: 'abadge' }, a.status), h('span', { class: 'grow' }), h('small', null, when(a.at))),
            h('p', { class: 'hint' }, `Original reason: ${a.reason || '(none recorded)'}`), h('blockquote', null, a.message),
            a.status === 'open' ? h('div', { class: 'row2 wrap' }, reply, h('button', { class: 'btn ok small', onclick: resolve('approve') }, 'Approve and restore'), h('button', { class: 'btn danger small', onclick: resolve('reject') }, 'Reject'),
              h('button', { class: 'btn small', onclick: () => { openUser = a.userId; go('#/admin/users'); } }, 'Open account')) : h('p', { class: 'ok' }, `Reply: ${a.response}`));
        };
        fill(body, d.appeals.length ? h('div', { class: 'rlist' }, d.appeals.map(card)) : h('p', { class: 'empty' }, 'No appeals.'));
      },

      /* ---- live streams ---- */
      async streams(body) {
        const d = await api('/api/admin/streams');
        fill(body, d.streams.length ? h('div', { class: 'rlist' }, d.streams.map(s => {
          const reason = h('input', { placeholder: 'Reason (the streamer sees this)', maxlength: 200, 'aria-label': 'Reason' });
          return h('article', { class: 'rcard' }, h('div', { class: 'row2' }, h('b', null, s.channel), h('span', { class: 'abadge' }, s.category), h('span', { class: 'grow' }), h('small', null, `${s.viewers} watching · started ${ago(s.startedAt)}`)),
            h('p', null, s.title), h('div', { class: 'row2 wrap' }, h('a', { class: 'btn small', href: '#/c/' + s.channel }, 'Watch'), reason,
              h('button', { class: 'btn danger small', onclick: async () => { if (!confirm(`End ${s.channel}'s stream now?`)) return; try { await api(`/api/admin/streams/${encodeURIComponent(s.channel)}/end`, { method: 'POST', body: { reason: reason.value } }); toast('Stream ended.'); views.streams(body); } catch (e) { toast(e.message); } } }, 'End stream')));
        })) : h('p', { class: 'empty' }, 'Nobody is live right now.'));
      },

      /* ---- content ---- */
      async content(body, q = '') {
        const [pd, cd] = await Promise.all([api('/api/admin/posts?q=' + encodeURIComponent(q)), api('/api/admin/circles')]);
        const input = h('input', { type: 'search', value: q, placeholder: 'Search posts by text or author', 'aria-label': 'Search posts' });
        fill(body,
          h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Posts'), h('form', { class: 'row2 wrap', onsubmit: e => { e.preventDefault(); views.content(body, input.value); } }, input, h('button', { class: 'btn primary small', type: 'submit' }, 'Search')),
            pd.posts.length ? h('div', { class: 'rlist' }, pd.posts.map(p => h('article', { class: 'rcard' }, h('div', { class: 'row2' }, h('b', null, '@' + p.author), p.circle ? h('span', { class: 'abadge' }, 'in ' + p.circle) : null, p.reports ? h('span', { class: 'abadge banned' }, p.reports + ' reports') : null, h('span', { class: 'grow' }), h('small', null, when(p.createdAt))),
              h('p', { class: 'pre' }, p.body), h('div', { class: 'row2' }, h('a', { class: 'btn small', href: '#/post/' + p.id }, 'Open'),
                h('button', { class: 'btn danger small', onclick: async () => { if (!confirm('Delete this post?')) return; try { await api('/api/admin/posts/' + p.id, { method: 'DELETE' }); toast('Post deleted.'); views.content(body, q); } catch (e) { toast(e.message); } } }, 'Delete'))))) : h('p', { class: 'empty' }, 'No posts match.')),
          h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Circles'), cd.circles.length ? h('div', { class: 'tbl' }, h('div', { class: 'atr ath c5' }, ['Circle', 'Owner', 'Members', 'Posts', ''].map(x => h('span', null, x))),
            cd.circles.map(c => h('div', { class: 'atr c5' }, h('span', null, h('a', { class: 'ul', href: '#/circle/' + c.slug }, c.name), c.reports ? h('span', { class: 'abadge banned' }, c.reports + ' reports') : null), h('span', null, '@' + c.owner), h('span', null, c.members), h('span', null, c.posts),
              h('button', { class: 'btn danger small', onclick: async () => { if (!confirm(`Delete the Circle "${c.name}" and all its posts?`)) return; try { await api('/api/admin/circles/' + c.id, { method: 'DELETE' }); toast('Circle deleted.'); views.content(body, q); } catch (e) { toast(e.message); } } }, 'Delete')))) : h('p', { class: 'empty' }, 'No Circles.')));
      },

      /* ---- word filter ---- */
      async words(body) {
        const d = await api('/api/admin/words');
        const input = h('input', { placeholder: 'Add a word or short phrase', maxlength: 30, 'aria-label': 'New blocked word' });
        fill(body, h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Word filter'),
          h('p', { class: 'hint' }, 'These words are masked with asterisks in chat, posts, comments, bios and Circle text across the whole site. Matching is whole-word and ignores capital letters, so "class" is safe. Streamers can add their own words for their channel.', d.fromEnv ? ` ${d.fromEnv} more come from the server's .env file.` : ''),
          h('form', { class: 'row2 wrap', onsubmit: async e => { e.preventDefault(); try { await api('/api/admin/words', { method: 'POST', body: { word: input.value } }); views.words(body); } catch (ex) { toast(ex.message); } } }, input, h('button', { class: 'btn primary small', type: 'submit' }, 'Add')),
          d.words.length ? h('div', { class: 'tagrow' }, d.words.map(w => h('button', { class: 'tag removable', title: 'Remove', onclick: async () => { await api('/api/admin/words/' + encodeURIComponent(w), { method: 'DELETE' }); views.words(body); } }, `${w}  ✕`))) : h('p', { class: 'empty' }, 'The list is empty.')));
      },

      /* ---- site settings ---- */
      async settings(body) {
        const { settings: s } = await api('/api/admin/settings');
        const cb = (v, label) => { const i = h('input', { type: 'checkbox', checked: v }); return [i, h('label', { class: 'check' }, i, label)]; };
        const [reg, regL] = cb(s.registrationOpen, 'Allow new sign-ups');
        const [maint, maintL] = cb(s.maintenance, 'Maintenance mode (read-only for everyone except admins)');
        const mmsg = h('input', { value: s.maintenanceMessage, maxlength: 300, 'aria-label': 'Maintenance message' });
        const ann = h('input', { value: s.announcement, maxlength: 300, placeholder: 'Shown to everyone at the top of every page', 'aria-label': 'Announcement' });
        const lvl = h('select', { 'aria-label': 'Announcement style' }, ['info', 'warning', 'critical'].map(v => h('option', { value: v, selected: s.announcementLevel === v }, v)));
        const mv = h('input', { type: 'number', min: 1, max: 200, value: s.maxViewers, 'aria-label': 'Max viewers' });
        const ma = h('input', { type: 'number', min: 0, max: 10080, value: s.minAccountAgeMin, 'aria-label': 'Minimum account age' });
        const cd = h('input', { type: 'number', min: 0, max: 60000, step: 500, value: s.postCooldownMs, 'aria-label': 'Post cooldown' });
        const [rpOn, rpOnL] = cb(s.chatReplayEnabled !== false, 'Chat Replay: save stream chat so it can be played back after the stream');
        const rpDays = h('input', { type: 'number', min: 1, max: 365, value: s.chatReplayDays, 'aria-label': 'Days to keep chat replays' });
        fill(body, h('form', { class: 'panel stack', onsubmit: async e => {
          e.preventDefault();
          try { await api('/api/admin/settings', { method: 'PUT', body: { registrationOpen: reg.checked, maintenance: maint.checked, maintenanceMessage: mmsg.value, announcement: ann.value, announcementLevel: lvl.value, maxViewers: Number(mv.value), minAccountAgeMin: Number(ma.value), postCooldownMs: Number(cd.value), chatReplayEnabled: rpOn.checked, chatReplayDays: Number(rpDays.value) } }); toast('Settings saved. They apply right away.'); NS.loadSite(); }
          catch (ex) { toast(ex.message); }
        } },
          h('h2', { class: 'h2' }, 'Site settings'), h('p', { class: 'hint' }, 'Changes apply immediately, without restarting the server.'),
          regL, maintL, field('Maintenance message', mmsg), field('Announcement banner', ann, 'Leave empty to hide it'), field('Banner style', lvl),
          field('Max viewers per stream', mv, 'Video is peer-to-peer, so 10-25 is realistic without a media server'),
          field('Anti-bot account age (minutes)', ma, 'Accounts newer than this cannot become Early Birds and their reactions earn no appreciation points. Recommended: 60 before launch'),
          field('Cooldown between posts and comments (ms)', cd, '3000 = 3 seconds'),
          rpOnL, field('Days to keep saved chat', rpDays, 'Older chat replays are deleted automatically. Turning Chat Replay off stops saving and hides replays; saved chat is still deleted when it expires. Mention saved chat in your Privacy Policy.'),
          h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')));
      },

      /* ---- legal pages ---- */
      async legal(body) {
        const slugs = ['guidelines', 'terms', 'privacy'];
        const pick = h('select', { 'aria-label': 'Page' }, slugs.map(s => h('option', { value: s }, s)));
        const title = h('input', { 'aria-label': 'Title', maxlength: 80 }), text = h('textarea', { rows: 18, 'aria-label': 'Text' });
        const load = async () => { const r = await api('/api/legal/' + pick.value); title.value = r.title; text.value = r.body; };
        pick.addEventListener('change', load); await load();
        fill(body, h('section', { class: 'panel stack' }, h('h2', { class: 'h2' }, 'Legal pages'),
          h('p', { class: 'hint' }, 'Shown to everyone and linked from sign-up. Use ## for headings and - for bullet points. These start as plain-language templates, not legal advice: have a lawyer review them for your country before a public launch, and add a contact email.'),
          field('Page', pick), field('Title', title), field('Text', text),
          h('div', { class: 'row2' }, h('button', { class: 'btn primary', onclick: async () => { try { await api('/api/admin/legal/' + pick.value, { method: 'PUT', body: { title: title.value, body: text.value } }); toast('Saved.'); } catch (e) { toast(e.message); } } }, 'Save'),
            h('a', { class: 'btn', href: '#/legal/' + pick.value }, 'View page'))));
      },

      /* ---- backups ---- */
      async backups(body) {
        const d = await api('/api/admin/backups');
        const get = async name => {
          try {
            const res = await fetch('/api/admin/backups/' + name, { headers: { Authorization: 'Bearer ' + S.token } });
            if (!res.ok) throw new Error('The download failed.');
            const a = h('a', { href: URL.createObjectURL(await res.blob()), download: name }); document.body.append(a); a.click(); a.remove();
          } catch (e) { toast(e.message); }
        };
        fill(body, h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Backups'),
          h('p', { class: 'hint' }, `A backup is made automatically every ${d.everyHours} hours and the newest ${d.keep} are kept. You can also make one any time. Backups live in ${d.dir}. Download one and keep it somewhere off this server.`),
          h('button', { class: 'btn primary', onclick: async () => { try { await api('/api/admin/backups', { method: 'POST' }); toast('Backup created.'); views.backups(body); } catch (e) { toast(e.message); } } }, 'Back up now'),
          d.backups.length ? h('div', { class: 'tbl' }, h('div', { class: 'atr ath c4' }, ['File', 'Type', 'Size', ''].map(x => h('span', null, x))),
            d.backups.map(b => h('div', { class: 'atr c4' }, h('span', null, b.name, h('small', { class: 'hint' }, ' ' + when(b.createdAt))), h('span', null, b.kind), h('span', null, (b.size / 1048576).toFixed(2) + ' MB'), h('button', { class: 'btn small', onclick: () => get(b.name) }, 'Download'))))
            : h('p', { class: 'empty' }, 'No backups yet.'),
          h('h3', null, 'Restoring'), h('p', { class: 'hint' }, 'Stop NovaStream, replace the file data/novastream.db with the backup (rename it to novastream.db), then start it again. Restoring is deliberately not a button so nobody can wipe the live site by accident.')));
      },

      /* ---- audit log ---- */
      async audit(body, page = 1) {
        const d = await api('/api/admin/audit?page=' + page);
        fill(body, h('section', { class: 'panel' }, h('h2', { class: 'h2' }, 'Audit log'), h('p', { class: 'hint' }, 'Every admin action, newest first.'),
          d.entries.length ? h('div', { class: 'tbl' }, h('div', { class: 'atr ath c4' }, ['When', 'Admin', 'Action', 'Details'].map(x => h('span', null, x))),
            d.entries.map(a => h('div', { class: 'atr c4' }, h('span', null, when(a.at)), h('span', null, '@' + a.admin), h('span', null, h('b', null, a.action)), h('span', null, `${a.target}${a.detail ? ' - ' + a.detail : ''}`)))) : h('p', { class: 'empty' }, 'Nothing yet.'),
          h('div', { class: 'row2 pager' }, h('button', { class: 'btn small', disabled: page <= 1, onclick: () => views.audit(body, page - 1) }, '← Newer'), h('button', { class: 'btn small', disabled: d.entries.length < 50, onclick: () => views.audit(body, page + 1) }, 'Older →'))));
      }
    };

    return { admin, settings, legal, resetPage };
  }
};
