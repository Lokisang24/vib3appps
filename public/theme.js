// Light / dark / system theme. Loaded in <head> so the right colours are applied before the page paints.
(function () {
  var KEY = 'novastream_theme';
  // dark unless the person chose otherwise; "system" is an explicit choice (follow the device)
  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'system' ? v : 'dark'; } catch (e) { return 'dark'; } }
  function systemDark() { try { return !window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return true; } }
  function apply(mode) {
    var resolved = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', resolved === 'light' ? '#ffffff' : '#000000');
  }
  window.NSTheme = {
    mode: saved,
    resolved: function () { return document.documentElement.getAttribute('data-theme') || 'dark'; },
    set: function (mode) { try { localStorage.setItem(KEY, mode); } catch (e) { /* storage blocked */ } apply(mode); document.dispatchEvent(new CustomEvent('themechange')); },
    toggle: function () { this.set(this.resolved() === 'light' ? 'dark' : 'light'); }
  };
  var UC = 'novastream_usercolors';
  function ucOn() { try { return localStorage.getItem(UC) === '1'; } catch (e) { return false; } }
  function applyUC() { document.documentElement.setAttribute('data-uc', ucOn() ? 'on' : 'off'); }
  window.NSTheme.userColors = ucOn;
  window.NSTheme.setUserColors = function (on) { try { localStorage.setItem(UC, on ? '1' : '0'); } catch (e) { /* storage blocked */ } applyUC(); };
  applyUC();
  apply(saved());
  try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (saved() === 'system') apply('system'); }); } catch (e) { /* old browser */ }
})();
