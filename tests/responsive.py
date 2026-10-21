# Responsive test: no sideways scrolling on any page at any common screen width, and the small-screen navigation works.
import os, subprocess, time, tempfile, json, sys
from playwright.sync_api import sync_playwright
PORT = 3991; BASE = f'http://localhost:{PORT}'
env = {**os.environ, 'PORT': str(PORT), 'DB_PATH': tempfile.mktemp(suffix='.db'), 'POST_COOLDOWN_MS': '0', 'ADMIN_USERNAMES': 'longusername_test'}
srv = subprocess.Popen(['node', 'server.js'], env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
time.sleep(1.5)
ok = True; fails = []
def check(n, c):
    global ok
    print(('PASS ' if c else 'FAIL ') + n); 
    if not c: ok = False; fails.append(n)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        seed = b.new_context(bypass_csp=True); r = seed.request
        def call(m, path, tok=None, body=None):
            hd = {'Content-Type': 'application/json'}
            if tok: hd['Authorization'] = 'Bearer ' + tok
            return getattr(r, m)(BASE + path, headers=hd, data=json.dumps(body) if body is not None else None).json()
        tok = call('post', '/api/register', body={'username': 'longusername_test', 'password': 'password123', 'dob': '2000-01-01', 'acceptTerms': True})['token']
        call('put', '/api/profile', tok, {'displayName': 'A Very Long Display Name Indeed', 'bio': 'A bio that is fairly long and keeps going to test wrapping on very small screens, ok?', 'interests': 'music, coding, art, cooking, travel', 'links': [{'platform': 'YouTube', 'url': 'https://youtube.com/@x'}, {'platform': 'Twitch', 'url': 'https://twitch.tv/x'}, {'platform': 'Kick', 'url': 'https://kick.com/x'}, {'platform': 'Website', 'url': 'https://example.com/a/very/long/path'}]})
        call('post', '/api/circles', tok, {'name': 'A Circle With A Rather Long Name', 'emoji': '🎧', 'description': 'Long description text that should wrap nicely and never push the page wider than the screen.', 'goalTitle': 'Reach 50 members', 'goalTarget': 50})
        call('post', '/api/posts', tok, {'body': 'A_very_long_unbroken_word_' * 6 + ' and then normal words afterwards for wrapping.'})
        call('post', '/api/posts', tok, {'body': 'Hello @longusername_test'})
        tok2 = call('post', '/api/register', body={'username': 'otheruser', 'password': 'password123', 'dob': '2000-01-01', 'acceptTerms': True})['token']
        pid = call('get', '/api/feed', tok2)['posts'][0]['id']
        call('post', f'/api/posts/{pid}/report', tok2, {'category': 'harassment', 'note': 'a fairly long note to check that report cards wrap nicely on tiny screens'})
        call('post', '/api/reports', tok2, {'type': 'user', 'target': 'longusername_test', 'category': 'self-harm'})
        admin_routes = ['#/admin/overview', '#/admin/reports', '#/admin/users', '#/admin/appeals', '#/admin/streams', '#/admin/content', '#/admin/words', '#/admin/settings', '#/admin/legal', '#/admin/backups', '#/admin/audit']
        routes = admin_routes + ['#/legal/terms', '#/settings', '#/reset', '#/', '#/feed', '#/circles', '#/circle/a-circle-with-a-rather-long-name', '#/search/music', '#/login', '#/signup',
                  '#/c/longusername_test', '#/u/longusername_test', '#/dashboard', '#/notifications', '#/golive', '#/following']
        widths = [(320, 640), (375, 740), (414, 860), (768, 1024), (820, 1180), (900, 700), (1024, 700), (1280, 800), (1440, 900)]
        for (w, hgt) in widths:
            ctx = b.new_context(viewport={'width': w, 'height': hgt}, bypass_csp=True, has_touch=(w < 800), is_mobile=(w < 800))
            pg = ctx.new_page(); pg.add_init_script(f"localStorage.setItem('novastream_token','{tok}')")
            bad = []; strays = []
            for rt in routes:
                pg.goto(BASE + '/' + rt); time.sleep(0.45)
                over = pg.evaluate("""() => { const m = document.getElementById('main'); const doc = document.documentElement;
                  const wide = []; for (const el of m.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > innerWidth + 2 && !el.closest('.tbl, .msgs, pre, .ctrls, .atabs')) wide.push(el.tagName + '.' + el.className); }
                  return { page: doc.scrollWidth - innerWidth, main: m.scrollWidth - m.clientWidth, wide: wide.slice(0, 3) }; }""")
                if over['page'] > 1 or over['main'] > 1 or over['wide']: bad.append((rt, over))
                stray = pg.evaluate("(()=>{const m=/(^|\\s)(null|undefined|false|NaN)(\\s|$)/.exec(document.getElementById('main').innerText);return m?m[2]:''})()")
                if stray: strays.append((rt, stray))
            pg.goto(BASE + '/#/u/otheruser'); time.sleep(0.4)
            pg.click('button:has-text("Report")'); time.sleep(0.3)
            box = pg.evaluate("(()=>{const r=document.querySelector('.modalbox').getBoundingClientRect();return {l:r.left,r:r.right,b:r.bottom,w:innerWidth,h:innerHeight}})()")
            check(f'{w}px: report dialog fits on screen', box['l'] >= -1 and box['r'] <= box['w'] + 1 and box['b'] <= box['h'] + 1)
            pg.keyboard.press('Escape'); time.sleep(0.2)
            check(f'{w}px: Escape closes the report dialog', pg.locator('.modalbox').count() == 0)
            pg.goto(BASE + '/#/'); time.sleep(0.3)
            hdr = pg.evaluate("(()=>{const t=document.getElementById('top');const over=[...t.children].filter(e=>e.offsetParent&&e.getBoundingClientRect().right>innerWidth+1).map(e=>e.className||e.tagName);return {sw:t.scrollWidth-innerWidth,over}})()")
            check(f'{w}px: header fits the screen (nothing pushed off the edge)', hdr['sw'] <= 1 and not hdr['over'])
            check(f'{w}px wide: no sideways scrolling on {len(routes)} pages', not bad)
            check(f'{w}px wide: no stray null/undefined/false text on any page', not strays)
            for rt, s2 in strays: print('     stray', rt, s2)
            for rt, o in bad: print('     ', rt, o)
            pg.goto(BASE + '/#/'); time.sleep(0.4)
            vis = lambda sel: pg.locator(sel).first.is_visible()
            if w <= 720: check(f'{w}px: bottom tab bar visible, top tabs hidden', vis('#bottom') and not vis('.tabs'))
            if 720 < w <= 1100: check(f'{w}px: no bottom bar, top tabs replaced by the menu', not vis('#bottom') and not vis('.tabs'))
            if w > 1100: check(f'{w}px: top tabs visible, bottom bar hidden', vis('.tabs') and not vis('#bottom'))
            if w <= 1100: check(f'{w}px: search icon replaces search box', vis('.searchbtn') and not vis('.search'))
            if w > 1100: check(f'{w}px: full search box shown', vis('.search') and not vis('.searchbtn'))
            if w <= 1100:
                check(f'{w}px: sidebar hidden until menu is opened', not (pg.evaluate("(()=>{const r=document.getElementById('side').getBoundingClientRect();return r.right>0})()")))
                pg.click('.menubtn'); time.sleep(0.35)
                check(f'{w}px: menu button opens the slide-out drawer', pg.evaluate("(()=>{const r=document.getElementById('side').getBoundingClientRect();return r.left>=0&&r.right>100})()"))
                pg.keyboard.press('Escape'); time.sleep(0.35)
                check(f'{w}px: Escape closes the drawer', not pg.evaluate("(()=>{const r=document.getElementById('side').getBoundingClientRect();return r.right>0})()"))
            else:
                check(f'{w}px: sidebar always visible, no menu button', vis('#side') and not vis('.menubtn'))
            if w < 800:
                small = pg.evaluate("[...document.querySelectorAll('#top .btn, #bottom a, .chip')].filter(e=>e.offsetParent).map(e=>e.getBoundingClientRect().height).filter(h=>h<34).length")
                check(f'{w}px: touch targets in header and bottom bar are at least 34px tall', small == 0)
            ctx.close()
        b.close()
finally:
    srv.terminate()
print('ALL PASSED' if ok else 'SOME FAILED: ' + '; '.join(fails)); sys.exit(0 if ok else 1)
