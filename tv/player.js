/* Cinema — video player. Engine: Samsung AVPlay (native: MKV/HEVC/HDR) with an HTML5 <video> fallback for
   desktop previews. Subtitles are rendered here (styling, offset); streams/progress come from Jellyfin. */
(function () {
  'use strict';
  var U = window.Cinema, JF = window.Jellyfin, K = U.K, esc = U.esc, $ = U.$;

  // ── subtitle style (persisted) ─────────────────────────────────────────────
  var STYLE_KEY = 'cinemaSubStyle', LANG_KEY = 'cinemaSubLang';
  var STYLE_OPTS = [
    { key: 'size', values: ['s', 'm', 'l', 'xl'] },
    { key: 'bg', values: ['none', 'shadow', 'box', 'band'] },
    { key: 'color', values: ['white', 'yellow'] },
    { key: 'pos', values: ['normal', 'high', 'top'] }
  ];
  function loadStyle() {
    var d = { size: 'm', bg: 'shadow', color: 'white', pos: 'normal' };
    try { var s = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}'); for (var k in s) d[k] = s[k]; } catch (e) { /* default */ }
    return d;
  }
  var subStyle = loadStyle();
  function applySubStyle() {
    var el = $('plSub'); if (!el) return;
    el.className = 'pl-sub size-' + subStyle.size + ' bg-' + subStyle.bg + ' color-' + subStyle.color + ' pos-' + subStyle.pos;
  }

  function isPt(lang) { return /^(por|pob|pt|pt-br|ptbr|pb)$/i.test(lang || ''); }
  function bazarrCode(lang) {
    lang = (lang || '').toLowerCase();
    if (lang === 'pob' || lang === 'pt-br' || lang === 'ptbr' || lang === 'pb') return 'pb';
    if (lang === 'por' || lang === 'pt') return 'pt';
    if (lang === 'eng' || lang === 'en') return 'en';
    if (lang === 'spa' || lang === 'es') return 'es';
    return lang.slice(0, 2);
  }
  function cleanSub(t) {
    var raw = String(t).replace(/\{\\[^}]*\}/g, '')            // ASS override tags {\an8}
      .replace(/<\/?(?!(?:i|b|u)\b)[a-z][^>]*>/gi, '');            // <font color=…> and other markup; keep i/b/u
    var s = esc(raw).replace(/\\N|\\n|\r?\n/g, '<br>');
    return s.replace(/&lt;(\/?(i|b|u))&gt;/gi, '<$1>');
  }

  // ── engines ────────────────────────────────────────────────────────────────
  function AvplayEngine(listener) {
    var av = webapis.avplay;
    return {
      kind: 'avplay',
      open: function (url, startMs) {
        av.open(url);
        av.setDisplayRect(0, 0, 1920, 1080);
        try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
        av.setListener({
          onbufferingstart: function () { listener.buffering(true); },
          onbufferingcomplete: function () { listener.buffering(false); },
          onstreamcompleted: function () { listener.ended(); },
          onerror: function (e) { listener.error(new Error('AVPlay ' + e)); },
          onevent: function () {}, onsubtitlechange: function () {}, oncurrentplaytime: function () {}
        });
        try { av.setSilentSubtitle(true); } catch (e) { /* we render subtitles ourselves */ }
        return new Promise(function (resolve, reject) {
          av.prepareAsync(function () {
            if (startMs > 1000) av.seekTo(Math.floor(startMs), resolve, resolve); else resolve();
          }, function (e) { reject(new Error('AVPlay: ' + (e && e.name || e))); });
        });
      },
      play: function () { av.play(); },
      pause: function () { av.pause(); },
      paused: function () { return av.getState() === 'PAUSED'; },
      seek: function (ms) { return new Promise(function (r) { av.seekTo(Math.max(0, Math.floor(ms)), r, r); }); },
      time: function () { try { return av.getCurrentTime(); } catch (e) { return 0; } },
      duration: function () { try { return av.getDuration(); } catch (e) { return 0; } },
      audioTracks: function () {
        try { return av.getTotalTrackInfo().filter(function (t) { return t.type === 'AUDIO'; }).map(function (t) { return t.index; }); }
        catch (e) { return []; }
      },
      setAudio: function (avIndex) { av.setSelectTrack('AUDIO', avIndex); },
      stop: function () { try { av.stop(); } catch (e) { /* idle */ } try { av.close(); } catch (e) { /* idle */ } }
    };
  }
  function Html5Engine(listener) {
    var v = $('plVideo');
    v.style.display = 'block';
    v.onwaiting = function () { listener.buffering(true); };
    v.onplaying = function () { listener.buffering(false); };
    v.onended = function () { listener.ended(); };
    v.onerror = function () { listener.error(new Error('video not supported by this browser')); };
    return {
      kind: 'html5',
      open: function (url, startMs) {
        v.src = url;
        return new Promise(function (resolve) { v.onloadedmetadata = function () { if (startMs > 1000) v.currentTime = startMs / 1000; resolve(); }; });
      },
      play: function () { v.play(); }, pause: function () { v.pause(); }, paused: function () { return v.paused; },
      seek: function (ms) { v.currentTime = ms / 1000; return Promise.resolve(); },
      time: function () { return v.currentTime * 1000; }, duration: function () { return (v.duration || 0) * 1000; },
      audioTracks: function () { return []; }, setAudio: function () {},
      stop: function () { v.pause(); v.removeAttribute('src'); v.load(); }
    };
  }

  // ── player ─────────────────────────────────────────────────────────────────
  var P = window.Player = { active: false };
  var ctx, item, info, engine, segments, nextEp, dur = 0;
  var ui = { visible: false, zone: 'bar', btn: 0, hideTimer: null, panel: null, col: 0, row: [0, 0, 0], styleRow: 0, searchRow: 0 };
  var subs = { index: null, events: [], offset: 0, ptr: 0 }, audioIndex = null;
  var scrub = null, scrubTimer = null, scrubStep = 10000, lastScrub = 0;
  var tickTimer = null, reportTimer = null, skipShownFor = null, skipDismissed = {}, nextState = null, candidates = null;

  function root() { return $('player'); }
  function rootHtml() {
    return '<object id="plAv" type="application/avplayer" class="pl-av"></object><video id="plVideo" class="pl-video"></video>' +
      '<div id="plSub" class="pl-sub"></div><div id="plSpin" class="pl-spin hidden"><i></i></div>' +
      '<div id="plUi" class="pl-ui">' +
        '<div class="pl-top"><div id="plTitle"></div></div>' +
        '<div class="pl-bottom">' +
          '<div id="plLinks" class="pl-links"></div>' +
          '<div id="plPrev" class="pl-prev hidden"><div id="plThumb" class="pl-thumb"></div><div id="plPTime" class="pl-ptime"></div></div>' +
          '<div id="plBar" class="pl-bar"><div id="plFill" class="pl-fill"></div><div id="plKnob" class="pl-knob"></div></div>' +
          '<div class="pl-times"><span id="plCur">0:00</span><span id="plRem"></span></div>' +
          '<div id="plBtns" class="pl-btns"></div>' +
        '</div>' +
      '</div>' +
      '<div id="plSkip" class="pl-skip hidden"></div><div id="plNext" class="pl-next hidden"></div>' +
      '<div id="plPanel" class="pl-panel hidden"></div><div id="plPrompt" class="pl-prompt hidden"></div>';
  }

  // ctx: { itemId, title, subtitle, logo, type ('show'|'movie'), tmdb, season, episode, resume (bool: start at saved position) }
  P.open = function (c, onExit) {
    ctx = c; P.onExit = onExit || P.onExit;
    P.active = true; document.documentElement.classList.add('playing');
    var r = root(); r.innerHTML = rootHtml(); r.classList.remove('hidden');
    applySubStyle(); spin(true);
    $('plTitle').innerHTML = (ctx.logo ? '<img class="pl-logo" src="' + esc(ctx.logo) + '">' : '<div class="pl-name">' + esc(ctx.title) + '</div>') +
      (ctx.subtitle ? '<div class="pl-subtitle">' + esc(ctx.subtitle) + '</div>' : '');
    subs = { index: null, events: [], offset: 0, ptr: 0 }; segments = []; nextEp = null; nextState = null; skipDismissed = {}; candidates = null;
    JF.item(ctx.itemId).then(function (it) {
      item = it;
      var pos = it.UserData && it.UserData.PlaybackPositionTicks ? it.UserData.PlaybackPositionTicks / 10000 : 0;
      if (ctx.resume && pos > 0) return start(pos);
      if (pos > 60000 && (!it.RunTimeTicks || pos < it.RunTimeTicks / 10000 - 120000)) return prompt(pos);
      return start(0);
    }).catch(fail);
  };

  function prompt(pos) {
    spin(false);
    ui.zone = 'prompt'; ui.btn = 0;
    var el = $('plPrompt'); el.classList.remove('hidden');
    el.innerHTML = '<div class="pl-prompt-box"><div class="pl-prompt-t">' + t('pl.continueQ') + '</div>' +
      '<div class="btn primary focus" data-p="0">▶  ' + t('pl.continueFrom', { t: U.clock(pos) }) + '</div><div class="btn" data-p="1">' + t('pl.fromStart') + '</div></div>';
    el.setAttribute('data-pos', pos);
  }

  function start(startMs, opts) {
    opts = opts || {};
    spin(true); $('plPrompt').classList.add('hidden'); ui.zone = 'bar';
    return JF.playbackInfo(ctx.itemId, { startMs: startMs, audioIndex: opts.audioIndex, subtitleIndex: opts.burnSubtitle, forceTranscode: opts.forceTranscode })
      .then(function (pi) {
        info = pi;
        if (audioIndex == null) audioIndex = pi.defaultAudio;
        var listener = { buffering: spin, ended: onEnded, error: function (e) { onEngineError(e, startMs, opts); } };
        engine = (window.webapis && webapis.avplay) ? AvplayEngine(listener) : Html5Engine(listener);
        return engine.open(pi.url, startMs);
      })
      .then(function () {
        engine.play(); spin(false);
        dur = engine.duration() || (item.RunTimeTicks ? item.RunTimeTicks / 10000 : 0);
        if (opts.burnSubtitle == null) chooseInitialSubtitle();
        JF.reportStart(report('start'));
        clearInterval(tickTimer); tickTimer = setInterval(tick, 200);
        clearInterval(reportTimer); reportTimer = setInterval(function () { JF.reportProgress(report('timeupdate')); }, 10000);
        JF.segments(ctx.itemId).then(function (s) { segments = s; });
        if (item.Type === 'Episode') JF.nextEpisode(item).then(function (n) { nextEp = n; drawButtons(); });
        drawButtons(); drawLinks(); showUi();
      })
      .catch(function (e) { if (!opts.forceTranscode && info && info.method === 'DirectPlay') return onEngineError(e, startMs, opts); fail(e); });
  }

  function onEngineError(e, startMs, opts) {
    // Direct play failed (codec/container the TV refuses): retry once through the server.
    if (!opts.forceTranscode && info && info.method === 'DirectPlay') {
      U.toast(t('pl.transcoding'), 4000);
      var at = engine ? engine.time() || startMs : startMs;
      if (engine) engine.stop();
      return start(at, { forceTranscode: true, audioIndex: opts.audioIndex });
    }
    fail(e);
  }
  function fail(e) { spin(false); U.toast(t('pl.cantPlay', { msg: e.message }), 7000); P.close(); }

  function report(event) {
    var p = { ItemId: ctx.itemId, MediaSourceId: info.mediaSource.Id, PlaySessionId: info.playSessionId,
      PositionTicks: JF.ticks(engine ? engine.time() : 0), CanSeek: true, IsPaused: engine ? engine.paused() : false,
      PlayMethod: info.method, AudioStreamIndex: audioIndex, SubtitleStreamIndex: subs.index == null ? -1 : subs.index, EventName: event };
    return p;
  }

  P.close = function () {
    clearInterval(tickTimer); clearInterval(reportTimer); clearTimeout(ui.hideTimer); clearTimeout(scrubTimer);
    if (engine && info) {
      JF.reportStop(report('stop'));
      if (info.method === 'Transcode') JF.stopTranscode(info.playSessionId);
    }
    if (engine) engine.stop();
    engine = null; info = null; P.active = false;
    root().classList.add('hidden'); root().innerHTML = '';
    document.documentElement.classList.remove('playing');
    if (P.onExit) P.onExit();
  };

  function onEnded() {
    if (nextEp) return playNext();
    P.close();
  }

  // ── subtitles ──────────────────────────────────────────────────────────────
  function textSubs() { return (info ? info.streams : []).filter(function (s) { return s.Type === 'Subtitle'; }); }
  function audioStreams() { return (info ? info.streams : []).filter(function (s) { return s.Type === 'Audio'; }); }
  function isText(s) { return s && !/pgs|dvd|dvb|vobsub/i.test(s.Codec || ''); }

  function chooseInitialSubtitle() {
    var list = textSubs().filter(isText), pref = localStorage.getItem(LANG_KEY);
    var a = audioStreams().filter(function (s) { return s.Index === audioIndex; })[0];
    var pick = null;
    if (pref === 'off') pick = null;
    else if (pref) pick = list.filter(function (s) { return (s.Language || '') === pref && !s.IsForced; })[0] || null;
    if (!pick && pref !== 'off' && info.defaultSubtitle != null && info.defaultSubtitle >= 0) pick = list.filter(function (s) { return s.Index === info.defaultSubtitle; })[0] || null;
    if (!pick && pref !== 'off' && !(a && isPt(a.Language))) pick = list.filter(function (s) { return isPt(s.Language); })[0] || null;
    setSubtitle(pick ? pick.Index : null, true);
  }

  function setSubtitle(index, quiet) {
    subs.index = index; subs.events = []; subs.ptr = 0; $('plSub').innerHTML = '';
    if (index == null) { if (!quiet) localStorage.setItem(LANG_KEY, 'off'); return Promise.resolve(); }
    var s = textSubs().filter(function (x) { return x.Index === index; })[0];
    if (!quiet && s) localStorage.setItem(LANG_KEY, s.Language || '');
    if (s && !isText(s)) {   // image subtitles: the server burns them into the video
      U.toast(t('pl.imageSubs'), 5000);
      var at = engine.time(); engine.stop();
      return start(at, { burnSubtitle: index, forceTranscode: true, audioIndex: audioIndex });
    }
    return JF.subtitleEvents(ctx.itemId, info.mediaSource.Id, index).then(function (ev) {
      if (subs.index === index) subs.events = ev;
    }).catch(function (e) { U.toast(t('pl.subFail', { msg: e.message }), 5000); });
  }

  function renderSubs(t) {
    var el = $('plSub'); if (!el) return;
    if (ui.panel === 'style') { el.innerHTML = '<span>' + t('pl.stylePreview') + '</span>'; return; }
    var ev = subs.events; if (!ev.length) { if (el.innerHTML) el.innerHTML = ''; return; }
    var now = t - subs.offset, out = [];
    // events are sorted by start; scan a small window around the last position
    var i = subs.ptr;
    while (i > 0 && ev[i - 1].end > now) i--;
    while (i < ev.length && ev[i].end <= now) i++;
    subs.ptr = i;
    for (var j = i; j < ev.length && ev[j].start <= now; j++) if (ev[j].end > now) out.push(cleanSub(ev[j].text));
    var html = out.length ? '<span>' + out.join('<br>') + '</span>' : '';
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ── ticking: progress, subtitles, skip intro, next episode ─────────────────
  function tick() {
    if (!engine) return;
    var t = engine.time();
    if (!dur) dur = engine.duration();
    renderSubs(t);
    if (ui.visible && scrub == null) drawProgress(t);
    // skip intro / recap
    var seg = segments.filter(function (s) {
      return (s.Type === 'Intro' || s.Type === 'Recap') && t >= s.StartTicks / 10000 && t < s.EndTicks / 10000 - 1500;
    })[0];
    var skipEl = $('plSkip');
    if (seg && !skipDismissed[seg.Id || seg.StartTicks]) {
      if (skipShownFor !== seg) {
        skipShownFor = seg;
        skipEl.innerHTML = '<div class="btn focus">' + (seg.Type === 'Recap' ? t('pl.skipRecap') : t('pl.skipIntro')) + '  ⏭</div>';
        skipEl.classList.remove('hidden');
      }
    } else if (skipShownFor) { skipShownFor = null; skipEl.classList.add('hidden'); }
    // next episode card: at the outro segment or in the last 40 s
    if (nextEp && !nextState && dur > 0) {
      var outro = segments.filter(function (s) { return s.Type === 'Outro'; })[0];
      var at = outro ? outro.StartTicks / 10000 : dur - 40000;
      if (t >= at && t < dur - 3000) showNextCard();
    }
  }

  function showNextCard() {
    nextState = { left: 10, dismissed: false };
    var el = $('plNext'); el.classList.remove('hidden');
    var draw = function () {
      el.innerHTML = '<div class="pl-next-thumb" data-bg="' + esc(JF.image(nextEp.Id, 'Primary', 480)) + '"></div><div class="pl-next-info">' +
        '<div class="pl-next-k">' + t('pl.nextIn', { n: nextState.left }) + '</div><div class="pl-next-t">' + t('ep.code', { s: nextEp.ParentIndexNumber, e: nextEp.IndexNumber }) + ' · ' + esc(nextEp.Name) + '</div>' +
        '<div class="btn primary focus">▶  ' + t('pl.playNow') + '</div></div>';
    };
    draw();
    nextState.timer = setInterval(function () {
      if (!nextState || nextState.dismissed) return;
      nextState.left--; if (nextState.left <= 0) { clearInterval(nextState.timer); playNext(); } else draw();
    }, 1000);
  }
  function dismissNext() { if (nextState) { nextState.dismissed = true; clearInterval(nextState.timer); } $('plNext').classList.add('hidden'); }

  function playNext() {
    var n = nextEp; if (!n) return;
    dismissNext();
    var next = { itemId: n.Id, title: ctx.title, logo: ctx.logo, backdrop: ctx.backdrop, type: 'show', tmdb: ctx.tmdb, season: n.ParentIndexNumber, episode: n.IndexNumber,
      subtitle: t('ep.code', { s: n.ParentIndexNumber, e: n.IndexNumber }) + ' · ' + n.Name, resume: true };
    var exit = P.onExit; P.onExit = null; P.close(); P.onExit = exit;
    P.open(next);
  }

  // ── controls UI ────────────────────────────────────────────────────────────
  function spin(on) { var s = $('plSpin'); if (s) s.classList.toggle('hidden', !on); }
  function showUi() {
    ui.visible = true; $('plUi').classList.add('show'); root().classList.add('ui-open'); drawProgress(engine ? engine.time() : 0); paintFocus();
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(function () { if (!ui.panel && engine && !engine.paused() && scrub == null) hideUi(); }, 5000);
  }
  function hideUi() { ui.visible = false; ui.zone = 'bar'; $('plUi').classList.remove('show'); root().classList.remove('ui-open'); $('plPrev').classList.add('hidden'); }

  function buttons() {
    var b = [{ id: 'pp', label: engine && engine.paused() ? '▶' : '❚❚', icon: true }, { id: 'back10', label: '↺ 10', icon: true }, { id: 'fwd10', label: '10 ↻', icon: true },
      { id: 'tracks', label: t('pl.tracks') }, { id: 'style', label: t('pl.style') }];
    if (nextEp) b.push({ id: 'next', label: t('pl.next') + '  ⏭' });
    return b;
  }
  // "Ver série" / "Ver temporada" (episodes only), above the progress bar.
  function links() {
    if (!ctx || ctx.type !== 'show' || !ctx.tmdb) return [];
    var l = [{ id: 'series', label: t('pl.series') }];
    if (ctx.season != null) l.push({ id: 'season', label: t('pl.season', { n: ctx.season }) });
    return l;
  }
  function drawLinks() {
    var el = $('plLinks'); if (!el) return;
    el.innerHTML = links().map(function (x, i) { return '<div class="pl-link" data-l="' + i + '">' + esc(x.label) + '</div>'; }).join('');
  }
  function navigate(kind) {
    var c = ctx, exit = P.onExit;
    P.onExit = null; P.close(); P.onExit = exit;
    if (P.onNavigate) P.onNavigate(kind, c);
  }
  function drawButtons() {
    var el = $('plBtns'); if (!el) return;
    el.innerHTML = buttons().map(function (b, i) { return '<div class="pl-btn' + (b.icon ? ' icon' : '') + '" data-b="' + i + '">' + esc(b.label) + '</div>'; }).join('');
    paintFocus();
  }
  function paintFocus() {
    var f = root().querySelectorAll('.pl-ui .focus'); for (var i = 0; i < f.length; i++) f[i].classList.remove('focus');
    $('plBar').classList.toggle('focus', ui.zone === 'bar');
    if (ui.zone === 'links') { var l = root().querySelector('.pl-link[data-l="' + ui.link + '"]'); if (l) l.classList.add('focus'); }
    if (ui.zone === 'buttons') { var b = root().querySelector('.pl-btn[data-b="' + ui.btn + '"]'); if (b) b.classList.add('focus'); }
  }
  function drawProgress(t) {
    if (!dur) return;
    var pct = Math.min(100, Math.max(0, 100 * t / dur));
    $('plFill').style.width = pct + '%'; $('plKnob').style.left = pct + '%';
    $('plCur').textContent = U.clock(t); $('plRem').textContent = '-' + U.clock(dur - t);
  }

  function trickplayFor(ms) {
    var tp = item && item.Trickplay && info && item.Trickplay[info.mediaSource.Id];
    if (!tp) return null;
    var widths = Object.keys(tp).map(Number).sort(function (a, b) { return Math.abs(a - 320) - Math.abs(b - 320); });
    var w = widths[0], t = tp[w]; if (!t) return null;
    var n = Math.min(t.ThumbnailCount - 1, Math.floor(ms / t.Interval)), per = t.TileWidth * t.TileHeight;
    var within = n % per;
    return { url: JF.trickplayTile(ctx.itemId, w, Math.floor(n / per), info.mediaSource.Id), x: (within % t.TileWidth) * t.Width,
             y: Math.floor(within / t.TileWidth) * t.Height, w: t.Width, h: t.Height };
  }

  function scrubBy(delta) {
    var now = Date.now();
    scrubStep = now - lastScrub < 450 ? Math.min(scrubStep * 1.5, 120000) : 10000;
    lastScrub = now;
    if (scrub == null) scrub = engine.time();
    root().classList.add('scrubbing');
    scrub = Math.max(0, Math.min(dur - 2000, scrub + (delta > 0 ? scrubStep : -scrubStep) * Math.abs(delta)));
    showUi(); drawProgress(scrub);
    var prev = $('plPrev'), tp = trickplayFor(scrub);
    prev.classList.remove('hidden');
    var pct = 100 * scrub / dur; prev.style.left = 'calc(' + pct + '% - ' + (tp ? tp.w / 2 : 80) + 'px)';
    $('plPTime').textContent = U.clock(scrub);
    var th = $('plThumb');
    if (tp) {
      th.style.display = 'block'; th.style.width = tp.w + 'px'; th.style.height = tp.h + 'px';
      th.style.backgroundImage = 'url("' + tp.url + '")'; th.style.backgroundPosition = (-tp.x) + 'px ' + (-tp.y) + 'px';
    } else th.style.display = 'none';
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(commitScrub, 800);
  }
  function commitScrub() {
    clearTimeout(scrubTimer);
    if (scrub == null) return;
    var to = scrub; scrub = null; spin(true); root().classList.remove('scrubbing');
    engine.seek(to).then(function () { spin(false); subs.ptr = 0; JF.reportProgress(report('timeupdate')); });
    setTimeout(function () { $('plPrev').classList.add('hidden'); }, 600);
    showUi();
  }
  function togglePause() {
    if (engine.paused()) { engine.play(); JF.reportProgress(report('unpause')); }
    else { engine.pause(); JF.reportProgress(report('pause')); }
    drawButtons(); showUi();
  }

  function pressButton(b) {
    if (b.id === 'pp') togglePause();
    else if (b.id === 'back10') { scrubBy(-1); commitScrub(); }
    else if (b.id === 'fwd10') { scrubBy(1); commitScrub(); }
    else if (b.id === 'tracks') openPanel('tracks');
    else if (b.id === 'style') openPanel('style');
    else if (b.id === 'next') playNext();
  }

  // ── panels: audio & subtitles, subtitle style, subtitle search ────────────
  function trackCols() {
    var aud = audioStreams().map(function (s) { return { kind: 'audio', index: s.Index, label: s.DisplayTitle || s.Language || t('pl.track', { n: s.Index }), on: s.Index === audioIndex }; });
    var sub = [{ kind: 'sub', index: null, label: t('pl.off'), on: subs.index == null }].concat(textSubs().map(function (s) {
      return { kind: 'sub', index: s.Index, label: (s.DisplayTitle || s.Language || t('pl.subtitles')) + (s.IsExternal ? '  ' + t('pl.file') : ''), on: s.Index === subs.index };
    }));
    var off = subs.offset / 1000;
    var adj = [{ kind: 'search', label: t('pl.searchSubs') }, { kind: 'sync', label: t('pl.sync') },
      { kind: 'delay', d: -250, label: t('pl.earlier') }, { kind: 'delay', d: 250, label: t('pl.later') },
      { kind: 'delay0', label: t('pl.delay', { d: (off > 0 ? '+' : '') + I18n.num(off, 2) }) + (off ? '  ' + t('pl.reset') : '') }];
    return [{ title: t('pl.audio'), items: aud }, { title: t('pl.subtitles'), items: sub }, { title: t('pl.subAdjust'), items: adj }];
  }
  function openPanel(name) {
    ui.panel = name; ui.zone = 'panel';
    if (name === 'tracks') { ui.col = 1; ui.row = [0, 0, 0]; }
    drawPanel(); showUi();
  }
  function closePanel() {
    ui.panel = null; ui.zone = 'buttons'; $('plPanel').classList.add('hidden'); renderSubs(engine ? engine.time() : 0); showUi();
  }
  function drawPanel() {
    var el = $('plPanel'); el.classList.remove('hidden');
    if (ui.panel === 'tracks') {
      var cols = trackCols();
      el.className = 'pl-panel tracks';
      el.innerHTML = cols.map(function (c, ci) {
        return '<div class="pl-col"><div class="pl-col-t">' + esc(c.title) + '</div>' + c.items.map(function (it, ri) {
          return '<div class="pl-opt' + (it.on ? ' on' : '') + (ui.col === ci && ui.row[ci] === ri ? ' focus' : '') + '">' + (it.on ? '✓ ' : '') + esc(it.label) + '</div>';
        }).join('') + '</div>';
      }).join('');
    } else if (ui.panel === 'style') {
      el.className = 'pl-panel style';
      el.innerHTML = '<div class="pl-col-t">' + t('pl.style') + '</div>' + STYLE_OPTS.map(function (o, ri) {
        var cur = o.values.indexOf(subStyle[o.key]) >= 0 ? subStyle[o.key] : o.values[0];
        return '<div class="pl-style-row' + (ui.styleRow === ri ? ' focus' : '') + '"><span class="k">' + t('st.' + o.key) + '</span><span class="v">◀  ' + t('st.' + o.key + '.' + cur) + '  ▶</span></div>';
      }).join('') + '<div class="hint">' + t('pl.styleHint') + '</div>';
      renderSubs(0);
    } else if (ui.panel === 'search') {
      el.className = 'pl-panel search';
      if (!candidates) { el.innerHTML = '<div class="pl-col-t">' + t('pl.searching') + '</div>'; return; }
      el.innerHTML = '<div class="pl-col-t">' + t('pl.pick', { n: candidates.length }) + '</div><div class="pl-search-list" id="plSearchList">' +
        (candidates.length ? candidates.map(function (c, i) {
          return '<div class="pl-cand' + (ui.searchRow === i ? ' focus' : '') + '"><span class="sc">' + (c.score || 0) + '</span><span class="lg">' + esc(c.language || '') +
            (c.hi ? ' · CC' : '') + '</span><span class="rl">' + esc(c.release || '') + '</span><span class="pv">' + esc(c.provider) + '</span></div>';
        }).join('') : '<div class="hint">' + t('pl.noneFound') + '</div>') + '</div>';
      var f = el.querySelector('.pl-cand.focus'), list = $('plSearchList');
      if (f && list) list.scrollTop = Math.max(0, f.offsetTop - 200);
    }
  }

  function subContext() {
    return { type: ctx.type, tmdb: ctx.tmdb, season: ctx.season, episode: ctx.episode };
  }
  function qsOf(o) { return Object.keys(o).filter(function (k) { return o[k] != null; }).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&'); }

  function panelKey(k) {
    if (ui.panel === 'tracks') {
      var cols = trackCols(), c = ui.col;
      if (k === K.UP) ui.row[c] = Math.max(0, ui.row[c] - 1);
      else if (k === K.DOWN) ui.row[c] = Math.min(cols[c].items.length - 1, ui.row[c] + 1);
      else if (k === K.LEFT) ui.col = Math.max(0, c - 1);
      else if (k === K.RIGHT) ui.col = Math.min(2, c + 1);
      else if (k === K.ENTER) { chooseTrack(cols[c].items[ui.row[c]]); return; }
      drawPanel();
    } else if (ui.panel === 'style') {
      var o = STYLE_OPTS[ui.styleRow];
      if (k === K.UP) ui.styleRow = Math.max(0, ui.styleRow - 1);
      else if (k === K.DOWN) ui.styleRow = Math.min(STYLE_OPTS.length - 1, ui.styleRow + 1);
      else if (k === K.LEFT || k === K.RIGHT || k === K.ENTER) {
        var idx = Math.max(0, o.values.indexOf(subStyle[o.key]));
        idx = (idx + (k === K.LEFT ? -1 : 1) + o.values.length) % o.values.length;
        subStyle[o.key] = o.values[idx]; localStorage.setItem(STYLE_KEY, JSON.stringify(subStyle)); applySubStyle();
      }
      drawPanel();
    } else if (ui.panel === 'search') {
      if (!candidates) return;
      if (k === K.UP) ui.searchRow = Math.max(0, ui.searchRow - 1);
      else if (k === K.DOWN) ui.searchRow = Math.min(candidates.length - 1, ui.searchRow + 1);
      else if (k === K.ENTER && candidates[ui.searchRow]) { downloadCandidate(candidates[ui.searchRow]); return; }
      drawPanel();
    }
  }

  function chooseTrack(it) {
    if (!it) return;
    if (it.kind === 'audio') {
      if (it.index === audioIndex) return;
      var target = audioStreams().filter(function (s) { return s.Index === it.index; })[0];
      var order = audioStreams().map(function (s) { return s.Index; }).indexOf(it.index);
      var avTracks = engine.audioTracks();
      var nativeOk = info.method === 'DirectPlay' && avTracks[order] != null && /aac|mp3|ac3|eac3|flac|opus|vorbis|pcm/i.test(target.Codec || '');
      audioIndex = it.index;
      if (nativeOk) { try { engine.setAudio(avTracks[order]); U.toast(t('pl.audioSet', { l: it.label })); } catch (e) { nativeOk = false; } }
      if (!nativeOk) {
        U.toast(t('pl.audioSwitch'), 4000);
        var at = engine.time(); engine.stop(); clearInterval(tickTimer);
        start(at, { audioIndex: it.index, forceTranscode: info.method !== 'DirectPlay' || !/aac|mp3|ac3|eac3|flac|opus|vorbis|pcm/i.test(target.Codec || '') });
      }
      drawPanel();
    } else if (it.kind === 'sub') { setSubtitle(it.index).then(drawPanel); drawPanel(); }
    else if (it.kind === 'delay') { subs.offset += it.d; subs.ptr = 0; drawPanel(); }
    else if (it.kind === 'delay0') { subs.offset = 0; subs.ptr = 0; drawPanel(); }
    else if (it.kind === 'search') {
      if (!ctx.tmdb) return U.toast(t('pl.noRef'), 5000);
      candidates = null; ui.searchRow = 0; ui.panel = 'search'; drawPanel();
      U.api('/api/subs/candidates?' + qsOf(subContext())).then(function (r) { candidates = r.items; if (ui.panel === 'search') drawPanel(); })
        .catch(function (e) { U.toast(e.message, 6000); ui.panel = 'tracks'; drawPanel(); });
    } else if (it.kind === 'sync') syncCurrent();
  }

  function syncCurrent() {
    var s = textSubs().filter(function (x) { return x.Index === subs.index; })[0];
    if (!s || !s.IsExternal) return U.toast(t('pl.syncNeedsFile'), 5000);
    U.toast(t('pl.syncing'), 60000);
    var body = subContext(); body.language = bazarrCode(s.Language);
    U.api('/api/subs/sync', body).then(function () {
      U.toast(t('pl.synced'), 4000); subs.offset = 0;
      return setSubtitle(s.Index, true);
    }).catch(function (e) { U.toast(t('pl.syncFail', { msg: e.message }), 7000); });
  }

  function downloadCandidate(c) {
    U.toast(t('pl.downloading', { l: c.language || '', p: c.provider }), 30000);
    var body = subContext(); body.candidate = c;
    var before = textSubs().map(function (s) { return s.Index; });
    U.api('/api/subs/download', body).then(function () {
      U.toast(t('pl.refreshing'), 15000);
      return JF.refreshItem(ctx.itemId);
    }).then(function () {
      return new Promise(function (r) { setTimeout(r, 6000); });
    }).then(function () { return JF.item(ctx.itemId); }).then(function (it) {
      item = it; info.streams = it.MediaStreams || info.streams;
      var fresh = textSubs().filter(function (s) { return before.indexOf(s.Index) === -1 && s.IsExternal; });
      var pick = fresh[0] || textSubs().filter(function (s) { return s.IsExternal && bazarrCode(s.Language) === (c.languageCode || ''); })[0];
      if (pick) { setSubtitle(pick.Index); U.toast(t('pl.subOn'), 3000); }
      else U.toast(t('pl.notListed'), 6000);
      ui.panel = 'tracks'; drawPanel();
    }).catch(function (e) { U.toast(t('pl.failed', { msg: e.message }), 7000); });
  }

  // ── keys ───────────────────────────────────────────────────────────────────
  P.key = function (k) {
    if (!P.active) return;
    if (ui.zone === 'prompt') {
      var pos = Number($('plPrompt').getAttribute('data-pos'));
      if (k === K.UP || k === K.DOWN || k === K.LEFT || k === K.RIGHT) {
        ui.btn = 1 - ui.btn;
        var bs = $('plPrompt').querySelectorAll('.btn'); bs[0].classList.toggle('focus', ui.btn === 0); bs[1].classList.toggle('focus', ui.btn === 1);
      } else if (k === K.ENTER) start(ui.btn === 0 ? pos : 0);
      else if (k === K.BACK || k === K.ESC) P.close();
      return;
    }
    if (!engine) { if (k === K.BACK || k === K.ESC) P.close(); return; }

    if (k === K.BACK || k === K.ESC) {
      if (ui.panel === 'search') { ui.panel = 'tracks'; drawPanel(); return; }
      if (ui.panel) return closePanel();
      if (nextState && !nextState.dismissed) return dismissNext();
      if (scrub != null) { scrub = null; root().classList.remove('scrubbing'); $('plPrev').classList.add('hidden'); drawProgress(engine.time()); return; }
      if (ui.visible) return hideUi();
      return P.close();
    }
    if (k === K.STOP) return P.close();
    if (k === K.PLAYPAUSE || k === K.PLAY || k === K.PAUSE) {
      if (k === K.PLAY && !engine.paused()) return showUi();
      if (k === K.PAUSE && engine.paused()) return showUi();
      return togglePause();
    }
    if (k === K.FF) return scrubBy(3);
    if (k === K.RW) return scrubBy(-3);
    if (k === K.NEXT && nextEp) return playNext();

    if (ui.panel) { panelKey(k); showUi(); return; }

    // next-episode card and skip button take OK while visible
    if (nextState && !nextState.dismissed && k === K.ENTER && !ui.visible) return playNext();
    if (skipShownFor && k === K.ENTER && !ui.visible) {
      var end = skipShownFor.EndTicks / 10000; skipDismissed[skipShownFor.Id || skipShownFor.StartTicks] = true;
      $('plSkip').classList.add('hidden'); skipShownFor = null; spin(true);
      engine.seek(end).then(function () { spin(false); subs.ptr = 0; });
      return;
    }

    if (!ui.visible) {
      if (k === K.LEFT) return scrubBy(-1);
      if (k === K.RIGHT) return scrubBy(1);
      if (k === K.ENTER) return togglePause();
      return showUi();
    }
    if (ui.zone === 'bar') {
      if (k === K.LEFT) return scrubBy(-1);
      if (k === K.RIGHT) return scrubBy(1);
      if (k === K.ENTER) { if (scrub != null) return commitScrub(); return togglePause(); }
      if (k === K.DOWN) { ui.zone = 'buttons'; ui.btn = 0; paintFocus(); return showUi(); }
      if (k === K.UP && links().length) { if (scrub != null) commitScrub(); ui.zone = 'links'; ui.link = 0; paintFocus(); return showUi(); }
      return showUi();
    }
    if (ui.zone === 'links') {
      var nl = links().length;
      if (k === K.LEFT) ui.link = Math.max(0, ui.link - 1);
      else if (k === K.RIGHT) ui.link = Math.min(nl - 1, ui.link + 1);
      else if (k === K.DOWN) ui.zone = 'bar';
      else if (k === K.ENTER) return navigate(links()[ui.link].id);
      paintFocus(); return showUi();
    }
    if (ui.zone === 'buttons') {
      var n = buttons().length;
      if (k === K.LEFT) ui.btn = Math.max(0, ui.btn - 1);
      else if (k === K.RIGHT) ui.btn = Math.min(n - 1, ui.btn + 1);
      else if (k === K.UP) ui.zone = 'bar';
      else if (k === K.ENTER) { pressButton(buttons()[ui.btn]); return; }
      paintFocus(); showUi();
    }
  };

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && P.active && engine && !engine.paused()) { engine.pause(); JF.reportProgress(report('pause')); }
  });
})();
