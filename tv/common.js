/* Cinema — shared helpers (loaded first). Plain ES2017 for the Tizen 5.5 browser. */
(function () {
  'use strict';

  // Cinema server (backend) address: set on first run (Setup screen) and kept on the TV.
  // ?api=… overrides it for desktop previews.
  var qs = /[?&]api=([^&]+)/.exec(location.search);
  var U = window.Cinema = {};
  U.API = qs ? decodeURIComponent(qs[1]) : (localStorage.getItem('cinemaServer') || '');
  U.setServer = function (url) { U.API = url.replace(/\/+$/, ''); localStorage.setItem('cinemaServer', U.API); };
  U.pin = '';
  U.K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BKSP: 8,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232
  };

  U.$ = function (id) { return document.getElementById(id); };
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  };
  // api(path) GET · api(path, body) POST · api(path, body, 'PUT')
  U.api = function (path, body, method) {
    var opts = { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Cinema-Pin': U.pin } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(U.API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code; e.status = r.status; throw e; }
        return j;
      });
    });
  };
  var toastTimer;
  U.toast = function (msg, ms) {
    var t = U.$('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3500);
  };
  U.bytes = function (n) {
    if (!n) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i < 2 ? 0 : 1).replace('.', ',') + ' ' + u[i];
  };
  U.eta = function (sec) {
    if (!sec || sec < 0) return '';
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + 'h ' + m + 'min' : m + ' min';
  };
  U.fmtDate = function (iso) {
    if (!iso) return '';
    var d = new Date(iso); return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  };
  // ms -> "1:02:03" / "12:34"
  U.clock = function (ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  };

  // The TV's web runtime ignores inline style="" in injected HTML, so images and widths travel as
  // data-bg / data-w and are applied through the CSSOM.
  U.hydrate = function (root) {
    var bg = root.querySelectorAll('[data-bg]');
    for (var i = 0; i < bg.length; i++) {
      var u = bg[i].getAttribute('data-bg'); bg[i].removeAttribute('data-bg');
      if (u) bg[i].style.backgroundImage = 'url("' + u + '")';
    }
    var w = root.querySelectorAll('[data-w]');
    for (var j = 0; j < w.length; j++) { w[j].style.width = w[j].getAttribute('data-w'); w[j].removeAttribute('data-w'); }
  };
  function watch() { new MutationObserver(function () { U.hydrate(document.body); }).observe(document.body, { childList: true, subtree: true }); }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);

  // Media keys must be registered to reach the app.
  U.registerMediaKeys = function () {
    try {
      ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious']
        .forEach(function (k) { tizen.tvinputdevice.registerKey(k); });
    } catch (e) { /* desktop preview */ }
  };
})();
