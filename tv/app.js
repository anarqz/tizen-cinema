/* Cinema — TV client screens. Plain ES2017 (Tizen 5.5 / Chromium ~63): no ?. or ??, no flex gap,
   no inline style="" in injected HTML (use data-bg / data-w; see Cinema.hydrate in common.js).
   Strings come from i18n.js via t(). */
(function () {
  'use strict';
  var U = window.Cinema, JF = window.Jellyfin, Player = window.Player, I18n = window.I18n;
  var K = U.K, $ = U.$, esc = U.esc, api = U.api, toast = U.toast, bytes = U.bytes, eta = U.eta, fmtDate = U.fmtDate;
  var publicCfg = null;

  var STATUS_DOT = { library: '✓', downloading: '↓', wanted: '•' };

  var backdropUrl = '';
  function setBackdrop(url) {
    var b = $('backdrop');
    if (url === backdropUrl) return;
    backdropUrl = url;
    if (!url) { b.classList.remove('on'); return; }
    var img = new Image();
    img.onload = function () { if (backdropUrl === url) { b.style.backgroundImage = 'url("' + url + '")'; b.classList.add('on'); } };
    img.src = url;
  }
  function ratingPills(r) {
    var h = '';
    if (r && r.imdb) h += '<span class="pill imdb">IMDb ' + esc(r.imdb) + '</span>';
    if (r && r.rottenTomatoes) h += '<span class="pill rt">RT ' + esc(r.rottenTomatoes) + '</span>';
    if (r && r.metascore) h += '<span class="pill meta">MC ' + esc(r.metascore) + '</span>';
    if (r && r.tmdb && !r.imdb) h += '<span class="pill tmdb">★ ' + esc(I18n.num(r.tmdb, 1)) + '</span>';
    return h;
  }
  function statusPill(st) { return st && st !== 'missing' && STATUS_DOT[st] ? '<span class="pill ' + st + '">' + t('status.' + st) + '</span>' : ''; }
  function certBox(c) { return c ? '<span class="cert">' + esc(c) + '</span>' : ''; }
  function rowTitle(r) { return r.titleKey ? t(r.titleKey) : r.title; }
  function titleArt(it) { return it.logo ? '<img class="logo" src="' + esc(it.logo) + '">' : '<h1 class="logo-text">' + esc(it.title) + '</h1>'; }
  function loadingHtml(it) { return '<div class="loading-center">' + (it && (it.logo || it.title) ? titleArt(it) : '') + '<div class="ring"></div></div>'; }
  function typeLabel(type) { return type === 'show' ? t('common.show') : t('common.movie'); }

  // ── on-screen keyboard (setup, passwords, settings fields, PIN) ──────────────
  // Keyboard({ title, hint, value, secret, numeric, onDone(value) })
  function Keyboard(o) {
    var rows = o.numeric ? [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['⌫', '0', 'OK']] : null;
    return {
      v: o.value || '', r: 0, c: 0, caps: false,
      layout: function () {
        if (rows) return rows;
        var parts = (this.caps ? 'ABCDEFGHIJKLM|NOPQRSTUVWXYZ' : 'abcdefghijklm|nopqrstuvwxyz').split('|');
        return [parts[0].split(''), parts[1].split(''), '0123456789.:/'.split(''), '-_@?&=%#~+!,'.split(''),
          ['⇧', t('key.space'), t('key.delete'), t('key.clear'), 'OK']];
      },
      mount: function (el) { this.el = el; this.draw(); },
      draw: function () {
        var lay = this.layout(), self = this;
        var shown = o.secret ? this.v.replace(/./g, '•') : this.v;
        this.el.innerHTML = '<div class="kb-screen"><div class="kb-title">' + esc(o.title) + '</div>' +
          (o.hint ? '<div class="kb-hint">' + esc(o.hint) + '</div>' : '') +
          '<div class="kb-value">' + esc(shown) + '<span class="caret"></span></div><div class="kb-keys' + (rows ? ' numeric' : '') + '">' +
          lay.map(function (row, r) {
            return '<div class="kb-row">' + row.map(function (k, c) {
              return '<div class="key' + (k.length > 1 && k !== 'OK' ? ' wide' : '') + (k === 'OK' ? ' ok' : '') + (r === self.r && c === self.c ? ' focus' : '') + '">' + esc(k) + '</div>';
            }).join('') + '</div>';
          }).join('') + '</div></div>';
      },
      key: function (k) {
        var lay = this.layout();
        if (k === K.UP) { if (this.r > 0) { this.r--; this.c = Math.min(this.c, lay[this.r].length - 1); } }
        else if (k === K.DOWN) { if (this.r < lay.length - 1) { this.r++; this.c = Math.min(this.c, lay[this.r].length - 1); } }
        else if (k === K.LEFT) { if (this.c > 0) this.c--; }
        else if (k === K.RIGHT) { if (this.c < lay[this.r].length - 1) this.c++; }
        else if (k >= 48 && k <= 57) this.v += String(k - 48);          // remote number keys
        else if (k === K.BKSP) this.v = this.v.slice(0, -1);
        else if (k === K.ENTER) {
          var key = lay[this.r][this.c];
          if (key === 'OK') { popOverlay(); o.onDone(this.v); return true; }
          if (key === '⇧') this.caps = !this.caps;
          else if (key === '⌫' || key === t('key.delete')) this.v = this.v.slice(0, -1);
          else if (key === t('key.clear')) this.v = '';
          else if (key === t('key.space')) this.v += ' ';
          else this.v += key;
        }
        this.draw(); return true;
      }
    };
  }
  function ask(o) { pushOverlay(Keyboard(o)); }

  // ── first run: Cinema server address ─────────────────────────────────────────
  function Setup(onReady) {
    return {
      mount: function (el) {
        this.el = el;
        el.innerHTML = '<div class="gate"><div class="gate-logo"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#fff" stroke-width="7"/><path d="M42 33 L42 67 L69 50 Z" fill="#ffcc34"/></svg></div>' +
          '<div class="gate-t">' + t('setup.title') + '</div><div class="gate-s">' + esc(t('setup.hint')) + '</div>' +
          '<div class="btn primary focus">' + t('setup.connect') + '</div><div class="gate-msg" id="setupMsg"></div></div>';
      },
      back: function () { return true; },    // nothing behind this screen
      key: function (k) {
        if (k !== K.ENTER) return true;
        ask({ title: t('setup.title'), hint: t('setup.hint'), value: U.API || 'http://', onDone: function (v) {
          var url = v.trim().replace(/\/+$/, '');
          if (!/^https?:\/\//.test(url)) url = 'http://' + url;
          $('setupMsg').textContent = t('setup.checking');
          fetch(url + '/api/public').then(function (r) { return r.json(); }).then(function (cfg) {
            if (cfg.app !== 'cinema') throw new Error('not a Cinema server');
            U.setServer(url); popOverlay(); onReady();
          }).catch(function (e) { $('setupMsg').textContent = t('setup.fail', { url: url, msg: e.message }); });
        } });
        return true;
      }
    };
  }

  // ── profiles (Jellyfin users) ────────────────────────────────────────────────
  function Profiles(onDone, closable) {
    return {
      users: null, i: 0,
      mount: function (el) {
        this.el = el; var self = this;
        if (this.users) return this.draw();
        el.innerHTML = '<div class="gate"><div class="ring"></div></div>';
        JF.publicUsers().then(function (us) {
          self.users = us.concat([{ Id: null, Name: t('profile.other') }]);
          var cur = JF.current(); if (cur) self.users.forEach(function (u, n) { if (u.Id === cur.userId) self.i = n; });
          if (stack[stack.length - 1] === self) self.draw();
        }).catch(function (e) { el.innerHTML = '<div class="gate"><div class="gate-msg">' + esc(t('common.error', { msg: e.message })) + '</div></div>'; });
      },
      draw: function () {
        var self = this, known = JF.knownSessions();
        this.el.innerHTML = '<div class="gate"><div class="gate-t">' + t('profile.who') + '</div><div class="profiles">' +
          this.users.map(function (u, n) {
            var img = u.Id ? JF.userImage(u.Id, u.PrimaryImageTag, 300) : null;
            return '<div class="profile' + (n === self.i ? ' focus' : '') + '"><div class="pf-avatar"' + (img ? ' data-bg="' + esc(img) + '"' : '') + '>' +
              (img ? '' : (u.Id ? esc(u.Name.charAt(0).toUpperCase()) : '+')) + '</div><div class="pf-name">' + esc(u.Name) + '</div>' +
              (u.Id && known[u.Id] ? '<div class="pf-dot"></div>' : '') + '</div>';
          }).join('') + '</div></div>';
      },
      back: function () { return !closable; },
      key: function (k) {
        if (!this.users) return true;
        if (k === K.LEFT) this.i = Math.max(0, this.i - 1);
        else if (k === K.RIGHT) this.i = Math.min(this.users.length - 1, this.i + 1);
        else if (k === K.ENTER) { this.pick(this.users[this.i]); return true; }
        this.draw(); return true;
      },
      pick: function (u) {
        var finish = function () { popOverlay(); onSignedIn(); if (onDone) onDone(); };
        if (u.Id && JF.use(u.Id)) return finish();
        if (u.Id && u.HasPassword === false) {
          return JF.signInPassword(u.Name, '').then(finish).catch(function () { pushOverlay(SignIn(u, finish)); });
        }
        pushOverlay(SignIn(u.Id ? u : null, finish));
      }
    };
  }

  // Quick Connect (any user approves the code) with a password fallback for a known user.
  function SignIn(user, then) {
    var qc = null;
    return {
      mount: function (el) {
        this.el = el;
        el.innerHTML = '<div class="gate"><div class="gate-t">' + esc(user ? t('qc.as', { name: user.Name }) : t('qc.title')) + '</div>' +
          '<div class="qc-code" id="qcCode">······</div><div class="qc-s">' + t('qc.howto') + '</div>' +
          '<div class="qc-hint" id="qcHint">' + t('qc.waiting') + '</div>' +
          (user ? '<div class="btn focus" id="qcPw">' + t('qc.password') + '</div>' : '') + '</div>';
        if (qc) return;
        qc = JF.quickConnect(function (code) { var c = $('qcCode'); if (c) c.textContent = code; });
        qc.promise.then(function (s) { toast(t('qc.connected', { name: s.userName }), 4000); popOverlay(); then(); })
          .catch(function (e) {
            if (e.message === 'cancelled') return;
            var c = $('qcCode'); if (c) c.textContent = '—';
            var h = $('qcHint'); if (h) h.textContent = t('qc.error', { msg: e.message });
          });
      },
      unmount: function () { if (qc) qc.cancel(); },
      key: function (k) {
        if (k === K.ENTER && user) {
          ask({ title: t('pw.title', { name: user.Name }), secret: true, onDone: function (pw) {
            JF.signInPassword(user.Name, pw).then(function (s) { toast(t('qc.connected', { name: s.userName }), 4000); popOverlay(); then(); })
              .catch(function () { toast(t('pw.wrong'), 4000); });
          } });
        }
        return true;
      }
    };
  }

  function onSignedIn() {
    paintAvatar();
    BROWSES.forEach(function (b) { b.resume = null; });
    Discover.loadResume();
    if (current && current.mount && current !== Settings) current.mount($('screen'));
  }

  // ── playback entry points ──────────────────────────────────────────────────
  function withJellyfin(then) {
    if (JF.signedIn()) return then();
    pushOverlay(Profiles(then, true));
  }
  // ctx for Player.open: { itemId, title, subtitle, logo, backdrop, type, tmdb, season, episode, resume }
  function play(ctx) {
    Player.open(ctx, function () {
      if (stack.length) { var top = stack[stack.length - 1]; if (top.refresh) top.refresh(); else top.mount($('overlay')); }
      Discover.loadResume();
    });
  }
  Player.onNavigate = function (kind, c) {
    while (stack.length) { var o = stack.pop(); if (o.unmount) o.unmount(); }
    var card = { type: 'show', tmdb: c.tmdb, title: c.title, logo: c.logo, backdrop: c.backdrop };
    pushOverlay(Detail(card));
    if (kind === 'season' && c.season != null) pushOverlay(Season(card, c.season));
  };
  function playEpisode(d, season, episode, title) {
    withJellyfin(function () {
      toast(t('pl.opening'), 2000);
      JF.findByTmdb('show', d.tmdb, d.originalTitle || d.title, d.year).then(function (s) {
        if (!s) throw new Error(t('pl.notInJf'));
        return JF.episode(s.Id, season, episode);
      }).then(function (ep) {
        if (!ep) throw new Error(t('pl.epNotInJf'));
        play({ itemId: ep.Id, title: d.title, logo: d.logo, backdrop: d.backdrop, type: 'show', tmdb: d.tmdb, season: season, episode: episode,
               subtitle: t('ep.code', { s: season, e: episode }) + ' · ' + (title || ep.Name) });
      }).catch(function (e) { toast(e.message, 6000); });
    });
  }

  // ── cards ──────────────────────────────────────────────────────────────────
  function cardBadge(c) {
    if (c.watchers) return t('badge.watching', { n: I18n.compact(c.watchers) });
    if (c.badgeKey) return t(c.badgeKey);
    return c.badge || '';
  }
  function landCard(c) {
    var st = STATUS_DOT[c.status] ? '<div class="dot ' + c.status + '">' + STATUS_DOT[c.status] + '</div>' : '';
    var b = cardBadge(c), badge = b ? '<div class="badge">' + esc(b) + '</div>' : '';
    var art = c.logo ? '<img class="mini-logo" src="' + esc(c.logo) + '">' : '<div class="mini-title">' + esc(c.title) + '</div>';
    var resume = c.progress != null && c.jellyfinId ? '<div class="ep-sub">' + esc(c.subtitle || '') + '</div><div class="progress"><i data-w="' + c.progress + '%"></i></div>' : '';
    return '<div class="card land' + (resume ? ' resume' : '') + '" data-bg="' + esc(c.thumb || c.backdrop || c.poster || '') + '">' +
      '<div class="shade"></div>' + art + st + badge + resume + '</div>';
  }
  function topCard(c, i) {
    var st = STATUS_DOT[c.status] ? '<div class="dot ' + c.status + '">' + STATUS_DOT[c.status] + '</div>' : '';
    return '<div class="top"><div class="num">' + (i + 1) + '</div><div class="card" data-bg="' + esc(c.poster || '') + '">' + st + '</div></div>';
  }

  // ── browse screens (Home, TV Shows, Movies) ─────────────────────────────────
  function Browse(path, onlyType) { return {
    rows: null, resume: null, r: 0, c: 0, cols: {},
    mount: function (el) {
      this.el = el;
      if (!this.rows) {
        el.innerHTML = '<div class="loading-center"><div class="ring"></div></div>';
        var self = this;
        api(path).then(function (d) {
          self.rows = d.rows;
          if (d.errors && d.errors.length) toast(d.errors[0], 6000);
          if (current === self) self.draw();
        }).catch(function (e) { el.innerHTML = '<div class="spinner">' + esc(t('common.error', { msg: e.message })) + '</div>'; });
        this.loadResume();
        return;
      }
      this.draw();
    },
    allRows: function () { return this.resume && this.resume.items.length ? [this.resume].concat(this.rows || []) : (this.rows || []); },
    // "Continue watching" straight from the Jellyfin server (current profile).
    loadResume: function () {
      var self = this;
      if (!JF.signedIn()) return;
      JF.resume().then(function (items) {
        var seriesIds = items.filter(function (i) { return i.SeriesId; }).map(function (i) { return i.SeriesId; });
        return JF.providerIds(seriesIds).then(function (prov) {
          return items.map(function (it) {
            var isEp = it.Type === 'Episode', pid = isEp ? (prov[it.SeriesId] || {}) : (it.ProviderIds || {});
            return {
              type: isEp ? 'show' : 'movie', tmdb: Number(pid.Tmdb || pid.tmdb) || null, title: isEp ? it.SeriesName : it.Name,
              logo: it.ParentLogoItemId ? JF.image(it.ParentLogoItemId, 'Logo', 400) : (it.ImageTags && it.ImageTags.Logo ? JF.image(it.Id, 'Logo', 400) : null),
              thumb: JF.image(it.Id, isEp ? 'Primary' : 'Backdrop', 640), backdrop: JF.image(isEp ? it.SeriesId : it.Id, 'Backdrop', 1280),
              overview: it.Overview, year: it.ProductionYear, jellyfinId: it.Id,
              progress: Math.round((it.UserData && it.UserData.PlayedPercentage) || 0),
              season: it.ParentIndexNumber, episode: it.IndexNumber,
              subtitle: isEp ? t('ep.code', { s: it.ParentIndexNumber, e: it.IndexNumber }) + ' · ' + it.Name : null
            };
          });
        });
      }).then(function (cards) {
        if (onlyType) cards = cards.filter(function (c) { return c.type === onlyType; });
        var had = !!(self.resume && self.resume.items.length);
        self.resume = { id: 'resume', kind: 'resume', titleKey: 'row.continue', items: cards };
        if (!had && cards.length && self.rows && self.r > 0) self.r++;
        if (current === self && self.rows && !overlayOpen()) self.draw();
      }).catch(function () { /* not fatal */ });
    },
    draw: function () {
      var h = '<div class="billboard" id="billboard"></div><div class="rows"><div class="rows-inner" id="rowsInner">';
      this.allRows().forEach(function (row) {
        var cards = row.kind === 'top10' ? row.items.map(topCard).join('') : row.items.map(landCard).join('');
        h += '<div class="row' + (row.kind === 'top10' ? ' top10' : '') + '"><h2>' + esc(rowTitle(row)) + '</h2><div class="strip">' + cards + '</div></div>';
      });
      this.el.innerHTML = h + '</div></div>';
      this.focus();
    },
    item: function () { var rows = this.allRows(); return rows[this.r] && rows[this.r].items[this.c]; },
    focus: function () {
      var rows = this.allRows(); if (!rows.length) return;
      var inner = $('rowsInner'); if (!inner) return;
      this.r = Math.min(this.r, rows.length - 1);
      var prev = this.el.querySelectorAll('.focus'); for (var p = 0; p < prev.length; p++) prev[p].classList.remove('focus');
      var rowEl = this.el.querySelectorAll('.row')[this.r], strip = rowEl.querySelector('.strip');
      var top10 = rows[this.r].kind === 'top10';
      var cells = strip.querySelectorAll(top10 ? '.top' : '.card');
      if (focusArea === 'content' && cells[this.c]) {
        cells[this.c].classList.add('focus');
        if (top10) cells[this.c].querySelector('.card').classList.add('focus');
      }
      inner.style.transform = 'translateY(' + (-rowEl.offsetTop) + 'px)';
      strip.style.transform = 'translateX(' + (-Math.max(0, this.c - 1) * (top10 ? 340 : 370)) + 'px)';
      var it = this.item(); if (!it) return;
      setBackdrop(it.backdrop);
      var meta = [ratingPills(it.ratings || { tmdb: it.rating }), '<span>' + esc(it.year || '') + '</span>', '<span>' + typeLabel(it.type) + '</span>', statusPill(it.status)].join('');
      $('billboard').innerHTML = (it.jellyfinId ? '<div class="chip-new">' + t('badge.continue') + (it.subtitle ? ' · ' + esc(it.subtitle) : '') + '</div>' : '') +
        titleArt(it) + '<div class="meta">' + meta + '</div><div class="overview">' + esc(it.overview || '') + '</div>';
    },
    key: function (k) {
      var rows = this.allRows(); if (!rows.length) return false;
      var n = rows[this.r].items.length;
      if (k === K.LEFT) { if (this.c === 0) return false; this.c--; }
      else if (k === K.RIGHT) { if (this.c < n - 1) this.c++; }
      else if (k === K.UP || k === K.DOWN) {
        // each row keeps its own horizontal position (new rows start at the first card)
        var to = this.r + (k === K.UP ? -1 : 1);
        if (to < 0 || to >= rows.length) return true;
        this.cols[rows[this.r].id] = this.c;
        this.r = to; this.c = Math.min(this.cols[rows[to].id] || 0, rows[to].items.length - 1);
      }
      else if (k === K.ENTER) {
        var it = this.item();
        if (it && it.jellyfinId) play({ itemId: it.jellyfinId, title: it.title, logo: it.logo, backdrop: it.backdrop, type: it.type, tmdb: it.tmdb,
          season: it.season, episode: it.episode, subtitle: it.subtitle, resume: true });
        else openDetail(it);
        return true;
      }
      else return false;
      this.focus(); return true;
    },
    refreshStatus: function () { this.rows = null; }
  }; }
  var Home = Browse('/api/home'), Shows = Browse('/api/browse/show', 'show'), Movies = Browse('/api/browse/movie', 'movie');
  var BROWSES = [Home, Shows, Movies];
  var Discover = {   // fan-out helpers used across screens
    refreshStatus: function () { BROWSES.forEach(function (b) { b.refreshStatus(); }); },
    loadResume: function () { BROWSES.forEach(function (b) { b.loadResume(); }); }
  };

  // ── search ─────────────────────────────────────────────────────────────────
  var KEYS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
  var Search = {
    q: '', zone: 'kbd', kr: 0, kc: 0, items: [], ri: 0, timer: null, seq: 0,
    mount: function (el) { this.el = el; setBackdrop(''); this.draw(); },
    kbdRows: function () {
      var rows = []; for (var i = 0; i < KEYS.length; i += 9) rows.push(KEYS.slice(i, i + 9));
      rows.push(['space', 'delete', 'clear']); return rows;
    },
    draw: function () {
      var rows = this.kbdRows();
      var kb = rows.map(function (row, r) {
        return row.map(function (k, c) {
          return '<div class="key' + (k.length > 1 ? ' wide' : '') + '" data-r="' + r + '" data-c="' + c + '">' + esc(k.length > 1 ? t('key.' + k) : k) + '</div>';
        }).join('') + '<br>';
      }).join('');
      var res = this.items.length ? '<h3>' + t('search.results') + '</h3>' + this.items.map(landCard).join('')
        : '<div class="hint">' + esc(this.q.length < 2 ? t('search.hint') : t('search.none', { q: this.q })) + '</div>';
      this.el.innerHTML = '<div class="search"><div class="query">' + esc(this.q) + '<span class="caret"></span></div>' +
        '<div class="kbd">' + kb + '</div><div class="results"><div class="results-inner" id="resInner">' + res + '</div></div></div>';
      this.focus();
    },
    focus: function () {
      var f = this.el.querySelectorAll('.focus'); for (var i = 0; i < f.length; i++) f[i].classList.remove('focus');
      if (focusArea !== 'content') return;
      if (this.zone === 'kbd') {
        var key = this.el.querySelector('.key[data-r="' + this.kr + '"][data-c="' + this.kc + '"]'); if (key) key.classList.add('focus');
      } else {
        var cards = this.el.querySelectorAll('#resInner .card'), c = cards[this.ri];
        if (c) { c.classList.add('focus'); $('resInner').style.transform = 'translateY(' + (-Math.max(0, c.offsetTop - 300)) + 'px)'; }
        var it = this.items[this.ri]; if (it) setBackdrop(it.backdrop);
      }
    },
    type: function (k) {
      if (k === 'space') this.q += ' ';
      else if (k === 'delete') this.q = this.q.slice(0, -1);
      else if (k === 'clear') this.q = '';
      else this.q += k;
      this.draw();
      var self = this; clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.run(); }, 450);
    },
    run: function () {
      var self = this, seq = ++this.seq, q = this.q.trim();
      if (q.length < 2) { this.items = []; this.draw(); return; }
      api('/api/search?q=' + encodeURIComponent(q)).then(function (d) {
        if (seq !== self.seq) return; self.items = d.items; self.ri = 0; if (current === self) self.draw();
      }).catch(function (e) { toast(e.message); });
    },
    key: function (k) {
      var rows = this.kbdRows();
      if (this.zone === 'kbd') {
        if (k === K.LEFT) { if (this.kc === 0) return false; this.kc--; }
        else if (k === K.RIGHT) {
          if (this.kc < rows[this.kr].length - 1) this.kc++;
          else if (this.items.length) { this.zone = 'res'; this.ri = 0; }
        }
        else if (k === K.UP) { if (this.kr > 0) { this.kr--; this.kc = Math.min(this.kc, rows[this.kr].length - 1); } }
        else if (k === K.DOWN) { if (this.kr < rows.length - 1) { this.kr++; this.kc = Math.min(this.kc, rows[this.kr].length - 1); } }
        else if (k === K.ENTER) { this.type(rows[this.kr][this.kc]); return true; }
        else if (k === K.BKSP) { this.type('delete'); return true; }
        else return false;
      } else {
        var per = 3, n = this.items.length;
        if (k === K.LEFT) { if (this.ri % per === 0) this.zone = 'kbd'; else this.ri--; }
        else if (k === K.RIGHT) { if (this.ri % per < per - 1 && this.ri < n - 1) this.ri++; }
        else if (k === K.UP) { if (this.ri >= per) this.ri -= per; }
        else if (k === K.DOWN) { if (this.ri + per < n) this.ri += per; }
        else if (k === K.ENTER) { openDetail(this.items[this.ri]); return true; }
        else return false;
      }
      this.focus(); return true;
    }
  };

  // ── list screens (Downloads, Coming up) ──────────────────────────────────────
  function ListScreen(opts) {
    return {
      i: 0, items: [], timer: null,
      mount: function (el) {
        this.el = el; var self = this;
        el.innerHTML = '<div class="page-title">' + esc(t(opts.titleKey)) + '</div><div class="page-sub" id="listSub"></div>' +
          '<div class="list"><div class="list-inner" id="listInner"><div class="spinner flush">' + t('common.loading') + '</div></div></div>';
        setBackdrop('');
        this.load();
        clearInterval(this.timer);
        if (opts.refreshMs) this.timer = setInterval(function () { if (current === self && !overlayOpen() && !Player.active) self.load(); }, opts.refreshMs);
      },
      unmount: function () { clearInterval(this.timer); },
      load: function () {
        var self = this;
        (opts.fetch ? opts.fetch() : api(opts.path)).then(function (d) {
          if (current !== self) return;
          var out = opts.build(d); self.items = out.items; self.i = Math.min(self.i, Math.max(0, self.items.length - 1));
          $('listInner').innerHTML = out.html || '<div class="spinner flush">' + esc(t(opts.emptyKey)) + '</div>';
          $('listSub').textContent = out.sub || '';
          if (d.errors && d.errors.length) toast(d.errors[0], 5000);
          self.focus();
        }).catch(function (e) { if (current === self) $('listInner').innerHTML = '<div class="spinner flush">' + esc(t('common.error', { msg: e.message })) + '</div>'; });
      },
      focus: function () {
        var lis = this.el.querySelectorAll('.li');
        for (var n = 0; n < lis.length; n++) lis[n].classList.toggle('focus', focusArea === 'content' && n === this.i);
        var el = lis[this.i]; if (el) $('listInner').style.transform = 'translateY(' + (-Math.max(0, el.offsetTop - 220)) + 'px)';
      },
      key: function (k) {
        if (k === K.UP) { if (this.i > 0) this.i--; }
        else if (k === K.DOWN) { if (this.i < this.items.length - 1) this.i++; }
        else if (k === K.ENTER) { if (opts.enter && this.items[this.i]) opts.enter(this.items[this.i], this); }
        else return false;
        this.focus(); return true;
      }
    };
  }

  var sync = { key: 'dl.sync', p: null, running: false, err: false, armed: null };
  var attentionCache = { at: 0, items: [] };
  function loadAttention(force) {
    if (!force && Date.now() - attentionCache.at < 15000) return Promise.resolve(attentionCache.items);
    return api('/api/sync/attention').then(function (r) { attentionCache = { at: Date.now(), items: r.items }; return r.items; })
      .catch(function () { return attentionCache.items; });
  }
  function syncLabel() { return (sync.running || sync.key === 'dl.sync' ? '⟳  ' : sync.err ? '✗  ' : '✓  ') + t(sync.key, sync.p || {}); }
  function runSync(screen) {
    if (sync.running) return;
    sync.running = true; sync.err = false; sync.key = 'dl.importing'; sync.p = null; screen.load();
    api('/api/sync', {}).then(function () {
      if (!JF.signedIn()) { sync.key = 'dl.syncNoJf'; return; }
      sync.key = 'dl.scanStart'; screen.load();
      return JF.scanLibrary().then(function () {
        return new Promise(function (resolve) {
          var tries = 0;
          (function poll() {
            JF.scanProgress().then(function (p) {
              tries++;
              if (p && p.running) { sync.key = 'dl.scanning'; sync.p = { p: p.percent }; if (current === screen) screen.load(); setTimeout(poll, 2000); }
              else if (tries < 4) setTimeout(poll, 1500);   // the task may take a moment to start
              else resolve();
            }).catch(function () { resolve(); });
          })();
        });
      }).then(function () { sync.key = 'dl.synced'; sync.p = { t: new Date().toTimeString().slice(0, 5) }; Discover.refreshStatus(); Discover.loadResume(); });
    }).catch(function (e) {
      sync.err = true;
      if (/403/.test(e.message)) { sync.key = 'dl.noAdmin'; sync.p = null; } else { sync.key = 'common.error'; sync.p = { msg: e.message }; }
    }).then(function () { sync.running = false; attentionCache.at = 0; if (current === screen) screen.load(); });
  }

  // ── Downloads: torrent client (Deluge) + Sonarr/Radarr queue + blocked imports ──
  var LIMITS = [-1, 1024, 5120, 10240, 25600];      // KiB/s, Deluge's unit
  function limitLabel(v) { return v > 0 ? (v >= 1024 ? I18n.num(v / 1024, v % 1024 ? 1 : 0) + ' MB/s' : v + ' KB/s') : '∞'; }
  function nextLimit(v) { var i = LIMITS.indexOf(v > 0 ? v : -1); return LIMITS[(i + 1) % LIMITS.length]; }
  var TSTATE = { Downloading: ['dl', '▼'], Seeding: ['seed', '▲'], Paused: ['paused', '❚❚'], Error: ['err', '!'], Checking: ['check', '⟳'],
                 Queued: ['queued', '⋯'], Allocating: ['check', '⟳'], Moving: ['check', '⇢'] };
  function tCls(s) { return (TSTATE[s] || ['queued'])[0]; }
  function tIcon(s) { return (TSTATE[s] || ['', '•'])[1]; }
  function tStateLabel(s) { return I18n.has('tor.state.' + s) ? t('tor.state.' + s) : s; }
  function duration(sec) {
    if (!sec || sec < 0) return '';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'min' : m + ' min';
  }
  var DL_FILTERS = ['all', 'downloading', 'seeding', 'paused', 'error', 'queue', 'attention'];
  function inFilter(f, x) {
    if (f === 'all') return true;
    if (f === 'downloading') return x.state === 'Downloading' || x.state === 'Checking' || x.state === 'Allocating' || (x.state === 'Queued' && x.progress < 100);
    if (f === 'seeding') return x.state === 'Seeding' || (x.state === 'Queued' && x.progress >= 100);
    if (f === 'paused') return x.state === 'Paused';
    if (f === 'error') return x.state === 'Error' || !!x.message;
    return false;
  }

  var Downloads = {
    data: null, queue: [], attention: [], filter: 0, zone: 'list', top: 0, i: 0, timer: null, armed: null, error: null,
    mount: function (el) {
      this.el = el; var self = this; setBackdrop('');
      if (!this.data) el.innerHTML = '<div class="page-title">' + t('nav.downloads') + '</div><div class="loading-center"><div class="ring"></div></div>';
      else this.draw();
      this.load();
      clearInterval(this.timer);
      this.timer = setInterval(function () { if (current === self && !overlayOpen() && !Player.active) self.load(); }, 2500);
    },
    unmount: function () { clearInterval(this.timer); },
    load: function () {
      var self = this;
      Promise.all([api('/api/torrents').catch(function (e) { return { error: e.message, torrents: [], stats: {} }; }),
                   api('/api/downloads').catch(function () { return { queue: [] }; }), loadAttention()]).then(function (r) {
        self.data = r[0]; self.queue = r[1].queue || []; self.attention = r[2] || [];
        if (current === self && !overlayOpen()) self.draw();
      });
    },
    items: function () {
      var f = DL_FILTERS[this.filter];
      if (f === 'queue') return this.queue;
      if (f === 'attention') return this.attention;
      return ((this.data && this.data.torrents) || []).filter(function (x) { return inFilter(f, x); });
    },
    count: function (f) {
      if (f === 'queue') return this.queue.length;
      if (f === 'attention') return this.attention.length;
      return ((this.data && this.data.torrents) || []).filter(function (x) { return inFilter(f, x); }).length;
    },
    topButtons: function () {
      var st = (this.data && this.data.stats) || {};
      return [{ id: 'sync', label: syncLabel(), cls: 'sync' },
              this.data && this.data.paused ? { id: 'resumeAll', label: '▶  ' + t('tor.resumeAll') } : { id: 'pauseAll', label: '❚❚  ' + t('tor.pauseAll') },
              { id: 'limit', label: '↓  ' + t('tor.limit', { v: limitLabel(st.limitDown) }) }];
    },
    torrentRow: function (x) {
      var cls = tCls(x.state), bits = [tStateLabel(x.state), bytes(x.done) + ' / ' + bytes(x.size)];
      if (x.eta) bits.push(t('tor.eta', { t: duration(x.eta) }));
      bits.push(t('tor.seeds', { a: x.seeds || 0, b: x.seedsTotal > 0 ? x.seedsTotal : 0 }), t('tor.peers', { a: x.peers || 0, b: x.peersTotal > 0 ? x.peersTotal : 0 }),
                t('tor.ratio', { r: I18n.num(x.ratio > 0 ? x.ratio : 0, 2) }));
      if (x.label) bits.push(x.label);
      var speeds = (x.down ? '↓ ' + bytes(x.down) + '/s' : '') + (x.down && x.up ? '  ' : '') + (x.up ? '↑ ' + bytes(x.up) + '/s' : '');
      return '<div class="li tor"><div class="ticon ' + cls + '">' + tIcon(x.state) + '</div><div class="grow"><div class="t">' + esc(x.name) + '</div>' +
        '<div class="s">' + esc(bits.join(' · ')) + (x.message ? ' · <span class="rej">' + esc(x.message) + '</span>' : '') + '</div>' +
        '<div class="bar ' + cls + '"><i data-w="' + x.progress + '%"></i></div></div>' +
        '<div class="r"><b>' + I18n.num(x.progress, x.progress < 100 && x.progress % 1 ? 1 : 0) + '%</b><br><span class="spd">' + (speeds || '—') + '</span></div></div>';
    },
    queueRow: function (q) {
      var pct = q.size ? Math.round(100 * (1 - q.left / q.size)) : 0;
      var title = (q.title || '') + (q.season != null ? ' · ' + t('ep.code', { s: q.season, e: q.episode }) : '');
      return '<div class="li"><div class="grow"><div class="t">' + esc(title) + '</div><div class="s">' + esc(q.svc) + ' · ' + esc(q.status) +
        (q.messages && q.messages.length ? ' · ' + esc(q.messages[0]) : '') + '</div><div class="bar"><i data-w="' + pct + '%"></i></div></div>' +
        '<div class="r">' + pct + '%' + (q.timeleft ? '<br>' + esc(q.timeleft) : '') + '</div></div>';
    },
    attentionRow: function (a) {
      var name = (a.name || a.title) + (a.episodes > 1 ? ' · ' + t('dl.episodes', { n: a.episodes }) : '');
      var reason = a.reason !== 'other' && I18n.has('reason.' + a.reason) ? t('reason.' + a.reason) : a.raw;
      return '<div class="li attn"><div class="grow"><div class="t">⚠  ' + esc(name) + '</div><div class="s">' + esc(reason) + ' · ' + esc(a.title) + '</div></div>' +
        '<div class="r">' + esc(a.action ? t('action.' + a.action) : (a.svc === 'sonarr' ? 'Sonarr' : 'Radarr')) + '</div></div>';
    },
    draw: function () {
      var self = this, st = (this.data && this.data.stats) || {}, f = DL_FILTERS[this.filter], items = this.items();
      this.i = Math.min(this.i, Math.max(0, items.length - 1));
      var stats = this.data && !this.data.error
        ? '↓ ' + bytes(st.down) + '/s   ↑ ' + bytes(st.up) + '/s   ·   ' + t('tor.connections', { n: st.connections || 0 }) + '   ·   ' + t('tor.free', { s: bytes(st.freeSpace) })
        : (this.data && this.data.error ? t('common.error', { msg: this.data.error }) : '');
      var top = this.topButtons().map(function (b, n) {
        return '<div class="btn small' + (b.cls ? ' ' + b.cls : '') + (self.zone === 'top' && self.top === n ? ' focus' : '') + '">' + esc(b.label) + '</div>';
      }).join('');
      var chips = DL_FILTERS.map(function (k, n) {
        var c = self.count(k); if (k === 'attention' && !c) return '';
        return '<div class="chip' + (n === self.filter ? ' on' : '') + (self.zone === 'filters' && n === self.filter ? ' focus' : '') + (k === 'attention' ? ' warn' : '') + '">' +
          esc(t('tor.f.' + k)) + ' <small>' + c + '</small></div>';
      }).join('');
      var rows = items.map(function (x) {
        return f === 'queue' ? self.queueRow(x) : f === 'attention' ? self.attentionRow(x) : self.torrentRow(x);
      }).join('') || '<div class="spinner flush">' + t('tor.empty') + '</div>';
      this.el.innerHTML = '<div class="page-title">' + t('nav.downloads') + '</div><div class="page-sub">' + esc(stats) + '</div>' +
        '<div class="dl-top">' + top + '</div><div class="dl-chips">' + chips + '</div>' +
        '<div class="list dl-list"><div class="list-inner" id="listInner">' + rows + '</div></div>';
      var lis = this.el.querySelectorAll('.dl-list .li');
      if (this.zone === 'list' && focusArea === 'content' && lis[this.i]) lis[this.i].classList.add('focus');
      if (lis[this.i]) $('listInner').style.transform = 'translateY(' + (-Math.max(0, lis[this.i].offsetTop - 260)) + 'px)';
    },
    focus: function () { this.draw(); },
    visibleFilters: function () { var self = this; return DL_FILTERS.map(function (k, n) { return n; }).filter(function (n) { return DL_FILTERS[n] !== 'attention' || self.count('attention'); }); },
    runTop: function (b) {
      var self = this, st = (this.data && this.data.stats) || {};
      if (b.id === 'sync') return runSync(this);
      var call = b.id === 'pauseAll' ? api('/api/torrents/session', { action: 'pause' })
        : b.id === 'resumeAll' ? api('/api/torrents/session', { action: 'resume' })
        : api('/api/torrents/session', { action: 'limit', down: nextLimit(st.limitDown) });
      call.then(function () { setTimeout(function () { self.load(); }, 600); }).catch(function (e) { toast(e.message, 6000); });
    },
    toggle: function (x) {
      var self = this;
      api('/api/torrent/' + x.hash + '/' + (x.state === 'Paused' ? 'resume' : 'pause'), {})
        .then(function () { toast(x.state === 'Paused' ? t('tor.resumed') : t('tor.paused'), 2500); setTimeout(function () { self.load(); }, 600); })
        .catch(function (e) { toast(e.message, 6000); });
    },
    key: function (k) {
      var items = this.items(), f = DL_FILTERS[this.filter], vis = this.visibleFilters(), pos = vis.indexOf(this.filter);
      if (this.zone === 'top') {
        if (k === K.LEFT) { if (this.top === 0) return false; this.top--; }
        else if (k === K.RIGHT) { if (this.top < 2) this.top++; }
        else if (k === K.DOWN) this.zone = 'filters';
        else if (k === K.ENTER) { this.runTop(this.topButtons()[this.top]); return true; }
      } else if (this.zone === 'filters') {
        if (k === K.LEFT) { if (pos <= 0) return false; this.filter = vis[pos - 1]; this.i = 0; }
        else if (k === K.RIGHT) { if (pos < vis.length - 1) { this.filter = vis[pos + 1]; this.i = 0; } }
        else if (k === K.UP) this.zone = 'top';
        else if (k === K.DOWN) { if (items.length) this.zone = 'list'; }
      } else {
        var x = items[this.i];
        if (k === K.UP) { if (this.i > 0) this.i--; else this.zone = 'filters'; }
        else if (k === K.DOWN) { if (this.i < items.length - 1) this.i++; }
        else if (k === K.LEFT) return false;
        else if ((k === K.PLAYPAUSE || k === K.PLAY || k === K.PAUSE) && x && x.hash) { this.toggle(x); return true; }
        else if (k === K.ENTER && x) {
          if (x.hash) { pushOverlay(TorrentDetail(x.hash, x.name)); return true; }
          if (f === 'attention') { this.resolveAttention(x); return true; }
        }
      }
      this.draw(); return true;
    },
    resolveAttention: function (it) {
      var self = this;
      if (!it.action) return toast(t('dl.resolveIn', { svc: it.svc === 'sonarr' ? 'Sonarr' : 'Radarr', msg: it.raw }), 7000);
      if (this.armed !== it.downloadId) { this.armed = it.downloadId; return toast(t('common.pressOkAgain', { what: t('action.' + it.action).toLowerCase() }), 5000); }
      this.armed = null; toast(t('dl.resolving'), 4000);
      api('/api/sync/resolve', { svc: it.svc, action: it.action, queueIds: it.queueIds, downloadId: it.downloadId, movieId: it.movieId, seriesId: it.seriesId })
        .then(function () { toast(t('dl.done.' + it.action), 5000); attentionCache.at = 0; setTimeout(function () { self.load(); }, 3000); })
        .catch(function (e) { toast(e.message, 7000); });
    }
  };

  // Torrent detail: stats, actions, files and peers. Refreshes every 2 s while open.
  function TorrentDetail(hash, name) {
    return {
      d: null, zone: 'act', a: 0, tab: 0, li: 0, armed: null, timer: null,
      mount: function (el) {
        this.el = el; var self = this;
        if (!this.d) el.innerHTML = '<div class="page-title tor-title">' + esc(name) + '</div><div class="loading-center"><div class="ring"></div></div>';
        else this.draw();
        this.load();
        clearInterval(this.timer);
        this.timer = setInterval(function () { if (stack[stack.length - 1] === self) self.load(); }, 2000);
      },
      unmount: function () { clearInterval(this.timer); },
      load: function () {
        var self = this;
        api('/api/torrent/' + hash).then(function (d) { self.d = d; if (stack[stack.length - 1] === self) self.draw(); })
          .catch(function (e) { toast(e.message, 5000); });
      },
      actions: function () {
        var d = this.d;
        return [d.state === 'Paused' ? { id: 'resume', label: '▶  ' + t('tor.resume') } : { id: 'pause', label: '❚❚  ' + t('tor.pause') },
          { id: 'recheck', label: '⟳  ' + t('tor.recheck') }, { id: 'reannounce', label: '↻  ' + t('tor.reannounce') },
          { id: 'top', label: '⤒  ' + t('tor.top') }, { id: 'limit', label: '↓  ' + t('tor.limit', { v: limitLabel(d.limitDown) }) },
          { id: 'remove', label: t('tor.remove'), danger: true }, { id: 'removeData', label: t('tor.removeData'), danger: true }];
      },
      list: function () { return this.tab === 0 ? this.d.files : this.d.peers; },
      draw: function () {
        var d = this.d, self = this, cls = tCls(d.state);
        var facts = [
          [t('tor.size'), bytes(d.size)], [t('tor.done'), bytes(d.done) + ' (' + I18n.num(d.progress, 1) + '%)'],
          [t('tor.speed'), '↓ ' + bytes(d.down) + '/s   ↑ ' + bytes(d.up) + '/s'], [t('tor.etaL'), d.eta ? duration(d.eta) : '—'],
          [t('tor.seedsL'), (d.seeds || 0) + ' (' + Math.max(0, d.seedsTotal || 0) + ')'], [t('tor.peersL'), (d.peers || 0) + ' (' + Math.max(0, d.peersTotal || 0) + ')'],
          [t('tor.uploaded'), bytes(d.uploaded)], [t('tor.ratioL'), I18n.num(d.ratio > 0 ? d.ratio : 0, 2)],
          [t('tor.seedTime'), duration(d.seedingTime) || '—'], [t('tor.added'), d.added ? fmtDate(new Date(d.added * 1000).toISOString()) : '—'],
          [t('tor.tracker'), d.tracker || '—'], [t('tor.queue'), d.queue >= 0 ? '#' + (d.queue + 1) : '—']
        ];
        var acts = this.actions().map(function (b, n) {
          return '<div class="btn small' + (b.danger ? ' danger' : '') + (self.zone === 'act' && n === self.a ? ' focus' : '') + '">' + esc(b.label) + '</div>';
        }).join('');
        var tabs = [t('tor.files', { n: d.files.length }), t('tor.peerList', { n: d.peers.length })].map(function (l, n) {
          return '<div class="chip' + (n === self.tab ? ' on' : '') + (self.zone === 'tab' && n === self.tab ? ' focus' : '') + '">' + esc(l) + '</div>';
        }).join('');
        var rows = this.tab === 0
          ? d.files.map(function (f) {
              return '<div class="li slim' + (f.skipped ? ' dim' : '') + '"><div class="grow"><div class="t">' + esc(f.path.split('/').pop()) + '</div>' +
                '<div class="bar ' + cls + '"><i data-w="' + f.progress + '%"></i></div></div><div class="r">' + bytes(f.size) + '<br>' + I18n.num(f.progress, 0) + '%</div></div>';
            }).join('')
          : d.peers.map(function (p) {
              return '<div class="li slim"><div class="grow"><div class="t">' + esc((p.country ? p.country + ' · ' : '') + (p.client || '?')) + (p.seed ? ' · seed' : '') + '</div>' +
                '<div class="bar ' + cls + '"><i data-w="' + p.progress + '%"></i></div></div><div class="r">↓ ' + bytes(p.down) + '/s<br>↑ ' + bytes(p.up) + '/s</div></div>';
            }).join('');
        this.el.innerHTML = '<div class="page-title tor-title">' + esc(d.name) + '</div>' +
          '<div class="page-sub"><span class="ticon inline ' + cls + '">' + tIcon(d.state) + '</span> ' + esc(tStateLabel(d.state)) + (d.label ? ' · ' + esc(d.label) : '') +
          (d.message ? ' · <span class="rej">' + esc(d.message) + '</span>' : '') + '</div>' +
          '<div class="tor-wrap"><div class="tor-left"><div class="bar big ' + cls + '"><i data-w="' + d.progress + '%"></i></div><div class="tor-facts">' +
          facts.map(function (f) { return '<div class="fact"><b>' + esc(f[0]) + '</b><span>' + esc(f[1]) + '</span></div>'; }).join('') + '</div>' +
          '<div class="tor-acts">' + acts + '</div></div>' +
          '<div class="tor-right"><div class="dl-chips">' + tabs + '</div><div class="tor-list"><div class="list-inner" id="torInner">' +
          (rows || '<div class="hint">' + t('tor.none') + '</div>') + '</div></div></div></div>';
        var lis = this.el.querySelectorAll('.tor-list .li');
        if (this.zone === 'list' && lis[this.li]) { lis[this.li].classList.add('focus'); $('torInner').style.transform = 'translateY(' + (-Math.max(0, lis[this.li].offsetTop - 300)) + 'px)'; }
      },
      key: function (k) {
        if (!this.d) return true;
        var acts = this.actions(), n = this.list().length;
        if (this.zone === 'act') {
          if (k === K.LEFT) { if (this.a > 0) this.a--; }
          else if (k === K.RIGHT) { if (this.a < acts.length - 1) this.a++; else this.zone = 'tab'; }
          else if (k === K.ENTER) { this.run(acts[this.a]); return true; }
          else if (k === K.PLAYPAUSE || k === K.PLAY || k === K.PAUSE) { this.run(acts[0]); return true; }
        } else if (this.zone === 'tab') {
          if (k === K.LEFT) { if (this.tab > 0) this.tab--; else this.zone = 'act'; }
          else if (k === K.RIGHT) { if (this.tab < 1) this.tab++; }
          else if (k === K.DOWN) { if (n) { this.zone = 'list'; this.li = 0; } }
          this.li = 0;
        } else {
          if (k === K.UP) { if (this.li > 0) this.li--; else this.zone = 'tab'; }
          else if (k === K.DOWN) { if (this.li < n - 1) this.li++; }
          else if (k === K.LEFT) this.zone = 'act';
        }
        this.draw(); return true;
      },
      run: function (b) {
        var self = this, d = this.d;
        if (b.danger) {
          if (this.armed !== b.id) { this.armed = b.id; return toast(t('common.pressOkAgain', { what: b.label.toLowerCase() }), 5000); }
          this.armed = null;
          return api('/api/torrent/' + hash + '/remove', { withData: b.id === 'removeData' }).then(function () {
            toast(t('tor.removed'), 4000); popOverlay(); Downloads.load();
          }).catch(function (e) { toast(e.message, 6000); });
        }
        this.armed = null;
        var body = b.id === 'limit' ? { down: nextLimit(d.limitDown) } : {};
        api('/api/torrent/' + hash + '/' + b.id, body).then(function () {
          toast(t('tor.done.' + b.id), 2500); setTimeout(function () { self.load(); }, 500);
        }).catch(function (e) { toast(e.message, 6000); });
      }
    };
  }

  var Upcoming = ListScreen({
    titleKey: 'nav.upcoming', path: '/api/upcoming', emptyKey: 'up.empty',
    build: function (d) {
      var h = '', last = '';
      d.items.forEach(function (x) {
        var dt = new Date(x.date), day = t('week.' + dt.getDay()) + ', ' + dt.getDate() + '/' + (dt.getMonth() + 1);
        if (day !== last) { h += '<div class="section-title">' + esc(day) + '</div>'; last = day; }
        var sub = x.type === 'show' ? t('ep.code', { s: x.season, e: x.episode }) + ' · ' + (x.episodeTitle || '') : t('up.release.' + x.release);
        h += '<div class="li"><div class="thumb" data-bg="' + esc(x.poster || '') + '"></div><div class="grow"><div class="t">' + esc(x.title) +
          '</div><div class="s">' + esc(sub) + '</div></div><div class="r">' + esc(x.hasFile ? t('up.done') : (x.type === 'show' ? t('up.episode') : t('common.movie'))) + '</div></div>';
      });
      return { items: d.items, html: h, sub: t('up.count', { n: d.items.length }) };
    },
    enter: function (x) { if (x.tmdb) openDetail({ type: x.type, tmdb: x.tmdb, title: x.title }); }
  });

  // ── settings ───────────────────────────────────────────────────────────────
  var SECTIONS = ['app', 'jellyfin', 'tmdb', 'trakt', 'omdb', 'sonarr', 'radarr', 'prowlarr', 'bazarr', 'deluge', 'prefs', 'security'];
  var CYCLE = {
    'prefs.metadataLanguage': ['en-US', 'pt-BR', 'pt-PT', 'es-ES', 'es-MX', 'fr-FR', 'de-DE', 'it-IT', 'ja-JP'],
    'prefs.region': ['US', 'BR', 'PT', 'GB', 'ES', 'MX', 'FR', 'DE', 'IT', 'CA', 'AU']
  };
  var Settings = {
    s: null, status: {}, options: { sonarrProfiles: [], radarrProfiles: [] }, sec: 0, f: 0, zone: 'sec',
    mount: function (el) {
      this.el = el; setBackdrop('');
      el.innerHTML = '<div class="page-title">' + t('set.title') + '</div><div class="loading-center"><div class="ring"></div></div>';
      this.load();
    },
    load: function () {
      var self = this;
      api('/api/settings').then(function (r) {
        self.s = r.settings; self.draw(); self.test();
        api('/api/settings/options').then(function (o) { self.options = o; }).catch(function () {});
      }).catch(function (e) {
        if (e.code === 'pin_required') {
          return ask({ title: t('set.pin'), numeric: true, secret: true, onDone: function (pin) { U.pin = pin; self.load(); } });
        }
        self.el.innerHTML = '<div class="page-title">' + t('set.title') + '</div><div class="spinner">' + esc(t('common.error', { msg: e.message })) + '</div>';
      });
    },
    test: function () {
      var self = this;
      api('/api/settings/status').then(function (r) { self.status = r.services; if (current === self && !overlayOpen()) self.draw(); }).catch(function () {});
    },
    fields: function (sec) {
      if (sec === 'app') {
        return [{ id: 'lang', label: t('set.language'), value: (I18n.langs.filter(function (l) { return l[0] === I18n.lang(); })[0] || [])[1] },
                { id: 'server', label: t('set.server'), value: U.API },
                { id: 'profile', label: t('nav.profile'), value: JF.current() ? JF.current().userName : '—' },
                { id: 'signout', label: t('profile.signout'), value: '' },
                { id: 'about', label: t('set.about'), value: t('set.version', { v: publicCfg ? publicCfg.version : '' }) }];
      }
      var f = this.s[sec];
      return Object.keys(f).map(function (k) {
        var v = f[k];
        var shown = v && typeof v === 'object' && v.secret ? (v.set ? t('set.secretSet', { h: v.hint }) : t('set.secretEmpty'))
          : (v || (k === 'qualityProfile' ? t('set.auto') : t('set.empty')));
        return { id: k, label: t('field.' + k), value: shown, secret: !!(v && v.secret), raw: v };
      });
    },
    statusDot: function (sec) { var st = this.status[sec]; return st ? '<span class="sdot ' + st.state + '"></span>' : ''; },
    draw: function () {
      if (!this.s) return;
      var self = this, sec = SECTIONS[this.sec], fields = this.fields(sec), st = this.status[sec];
      var left = SECTIONS.map(function (s, i) {
        return '<div class="set-sec' + (i === self.sec ? (self.zone === 'sec' ? ' focus' : ' sel') : '') + '">' + self.statusDot(s) +
          esc(s === 'app' ? t('set.app') : t('sec.' + s)) + '</div>';
      }).join('');
      var head = sec !== 'app' && st ? '<div class="set-status ' + st.state + '">' + esc(t('set.status.' + st.state)) +
        (st.version ? ' · v' + esc(st.version) : '') + (st.name ? ' · ' + esc(st.name) : '') + (st.message ? ' · ' + esc(st.message) : '') + '</div>' : '';
      var right = '<div class="set-h">' + esc(sec === 'app' ? t('set.app') : t('sec.' + sec)) + '</div>' + head +
        fields.map(function (f, i) {
          return '<div class="set-field' + (self.zone === 'field' && i === self.f ? ' focus' : '') + '"><span class="k">' + esc(f.label) + '</span><span class="v">' + esc(f.value) + '</span></div>';
        }).join('') + (sec !== 'app' ? '<div class="set-field test' + (self.zone === 'field' && self.f === fields.length ? ' focus' : '') + '"><span class="k">⟳  ' + t('set.test') + '</span></div>' : '');
      this.el.innerHTML = '<div class="page-title">' + t('set.title') + '</div><div class="page-sub">' + esc(t('set.web', { url: U.API + '/settings' })) + '</div>' +
        '<div class="set-wrap"><div class="set-left">' + left + '</div><div class="set-right">' + right + '</div></div>';
    },
    focus: function () { this.draw(); },
    save: function (sec, field, value) {
      var self = this, patch = {}; patch[sec] = {}; patch[sec][field] = value;
      api('/api/settings', patch, 'PUT').then(function (r) {
        self.s = r.settings; toast(t('set.saved'), 2500); self.draw(); self.test();
        if (sec === 'jellyfin' || sec === 'prefs') refreshPublic();
        if (sec === 'prefs' || sec === 'tmdb' || sec === 'trakt') Discover.refreshStatus();
      }).catch(function (e) { toast(e.message, 6000); });
    },
    edit: function (f) {
      var self = this, sec = SECTIONS[this.sec];
      if (sec === 'app') {
        if (f.id === 'lang') {
          var i = I18n.langs.map(function (l) { return l[0]; }).indexOf(I18n.lang());
          I18n.set(I18n.langs[(i + 1) % I18n.langs.length][0]); paintRailLabels(); Discover.refreshStatus(); return this.draw();
        }
        if (f.id === 'server') return ask({ title: t('set.server'), value: U.API, onDone: function (v) { U.setServer(/^https?:\/\//.test(v) ? v : 'http://' + v); boot(); } });
        if (f.id === 'profile') return pushOverlay(Profiles(function () { self.draw(); }, true));
        if (f.id === 'signout') { JF.signOut(); paintAvatar(); return pushOverlay(Profiles(function () { self.draw(); }, false)); }
        return;
      }
      var key = sec + '.' + f.id;
      if (CYCLE[key]) {
        var list = CYCLE[key];
        return this.save(sec, f.id, list[(list.indexOf(f.raw) + 1) % list.length]);
      }
      if (f.id === 'qualityProfile') {
        var opts = [''].concat(sec === 'sonarr' ? this.options.sonarrProfiles : this.options.radarrProfiles);
        return this.save(sec, f.id, opts[(opts.indexOf(f.raw || '') + 1) % opts.length]);
      }
      ask({ title: t('sec.' + sec) + ' · ' + f.label, value: f.secret ? '' : (f.raw || (f.id === 'url' ? 'http://' : '')), secret: f.secret,
            numeric: f.id === 'pin', onDone: function (v) { self.save(sec, f.id, v); } });
    },
    key: function (k) {
      if (!this.s) return k !== K.LEFT;
      var fields = this.fields(SECTIONS[this.sec]), max = fields.length + (SECTIONS[this.sec] === 'app' ? -1 : 0);
      if (this.zone === 'sec') {
        if (k === K.UP) this.sec = Math.max(0, this.sec - 1);
        else if (k === K.DOWN) this.sec = Math.min(SECTIONS.length - 1, this.sec + 1);
        else if (k === K.RIGHT || k === K.ENTER) { this.zone = 'field'; this.f = 0; }
        else if (k === K.LEFT) return false;
      } else {
        if (k === K.UP) this.f = Math.max(0, this.f - 1);
        else if (k === K.DOWN) this.f = Math.min(max, this.f + 1);
        else if (k === K.LEFT) this.zone = 'sec';
        else if (k === K.ENTER) {
          if (this.f === fields.length) { toast(t('set.testing'), 2000); this.test(); return true; }
          this.edit(fields[this.f]); return true;
        }
      }
      this.draw(); return true;
    }
  };

  // ── overlays ───────────────────────────────────────────────────────────────
  var stack = [];
  function overlayOpen() { return stack.length > 0; }
  function pushOverlay(o) { stack.push(o); $('overlay').classList.remove('hidden'); o.mount($('overlay')); }
  function popOverlay() {
    var o = stack.pop(); if (o && o.unmount) o.unmount();
    if (stack.length) stack[stack.length - 1].mount($('overlay'));
    else { $('overlay').classList.add('hidden'); $('overlay').innerHTML = ''; if (current && current.focus) current.focus(); }
  }
  function openDetail(card) { if (card && card.tmdb) pushOverlay(Detail(card)); }

  // Trailer: embedded page served by the Cinema server (YouTube needs a real origin). OK = open in the YouTube app.
  function Trailer(youtubeId, title) {
    return {
      mount: function (el) {
        el.innerHTML = '<div class="trailer"><iframe id="ytFrame" allow="autoplay; encrypted-media; fullscreen" frameborder="0" src="' +
          esc(U.API + '/trailer/' + encodeURIComponent(youtubeId)) + '"></iframe>' +
          '<div class="trailer-hint">' + esc(t('yt.close', { t: title })) + '</div></div>';
        setTimeout(function () { window.focus(); }, 300);   // keep remote keys in the app, not the iframe
      },
      key: function (k) {
        if (k === K.ENTER) {
          toast(t('yt.opening'), 4000);
          api('/api/trailer/youtube', { id: youtubeId }).catch(function (e) { toast(e.message, 6000); });
        }
        return true;
      }
    };
  }

  // Title page: hero + seasons + cast + "More like this" + details.
  function Detail(card) {
    return {
      d: null, jf: null, sec: 0, idx: [0, 0, 0, 0, 0], busy: false,
      mount: function (el) {
        this.el = el; var self = this;
        if (this.d) return this.draw();
        el.innerHTML = '<div class="backdrop dim" data-bg="' + esc(card.backdrop || '') + '"></div><div class="scrim"></div>' + loadingHtml(card);
        api('/api/item/' + card.type + '/' + card.tmdb).then(function (d) {
          self.d = d; if (stack[stack.length - 1] === self) self.draw();
          self.loadJellyfin();
        }).catch(function (e) { toast(e.message); });
      },
      refresh: function () { this.loadJellyfin(); if (this.d) this.draw(); },
      // What "▶ Watch" plays: the movie, or the next-up episode (with resume position) for series.
      loadJellyfin: function () {
        var self = this, d = this.d;
        if (!d || !JF.signedIn() || d.status === 'missing') return;
        JF.findByTmdb(d.type, d.tmdb, d.originalTitle || d.title, d.year).then(function (it) {
          if (!it) return null;
          if (d.type === 'movie') return { item: it, label: it.UserData && it.UserData.PlaybackPositionTicks ? t('title.continue') : t('title.watch') };
          return JF.nextUp(it.Id).then(function (ep) {
            if (!ep) return JF.episodes(it.Id).then(function (eps) { return eps[0] ? { item: eps[0], label: t('title.watchEp', { s: eps[0].ParentIndexNumber, e: eps[0].IndexNumber }) } : null; });
            var resumed = ep.UserData && ep.UserData.PlaybackPositionTicks;
            return { item: ep, label: t(resumed ? 'title.continueEp' : 'title.watchEp', { s: ep.ParentIndexNumber, e: ep.IndexNumber }) };
          });
        }).then(function (jf) {
          self.jf = jf; if (stack[stack.length - 1] === self) self.draw();
        }).catch(function () { /* stays without the play button */ });
      },
      sections: function () {
        var d = this.d, s = ['hero'];
        if (d.type === 'show' && d.seasons && d.seasons.length && d.status !== 'missing') s.push('seasons');
        if (d.people && d.people.length) s.push('cast');
        if (d.recommendations && d.recommendations.length) s.push('recs');
        return s;
      },
      buttons: function () {
        var d = this.d, b = [];
        if (d.status !== 'missing') {
          if (this.jf) b.push({ id: 'play', label: '▶  ' + this.jf.label, primary: true });
          else if (!JF.signedIn()) b.push({ id: 'signin', label: '▶  ' + t('title.watch'), primary: true });
        }
        if (d.trailerYouTubeId) b.push({ id: 'trailer', label: '▷  ' + t('title.trailer') });
        if (d.status === 'missing') b.push({ id: 'add', label: '+  ' + t('title.add'), primary: !b.length || b[0].id === 'trailer' });
        else b.push({ id: 'none', label: '✓  ' + t('status.' + d.status) + (d.type === 'show' && d.total ? ' · ' + d.have + '/' + d.total : '') });
        if (d.status !== 'missing' && d.type === 'movie') b.push({ id: 'releases', label: t('title.versions') });
        return b;
      },
      draw: function () {
        var d = this.d;
        var meta = [ratingPills(d.ratings), '<span>' + esc(d.year) + '</span>', certBox(d.certification),
          d.counts ? '<span>' + (d.counts.seasons === 1 ? t('title.seasonCount1') : t('title.seasonsCount', { n: d.counts.seasons })) + '</span>'
                   : (d.runtime ? '<span>' + t('common.min', { n: d.runtime }) + '</span>' : ''), statusPill(d.status)].join('');
        var by = d.creators && d.creators.length ? '<div class="credits"><b>' + (d.type === 'show' ? t('title.createdBy') : t('title.directedBy')) + ':</b> ' + esc(d.creators.slice(0, 3).join(', ')) + '</div>' : '';
        var cast = d.cast && d.cast.length ? '<div class="credits"><b>' + t('title.starring') + ':</b> ' + esc(d.cast.slice(0, 4).join(', ')) + '</div>' : '';
        var next = d.nextEpisode ? '<div class="credits"><b>' + t('title.nextEp') + ':</b> ' + t('ep.code', { s: d.nextEpisode.season, e: d.nextEpisode.episode }) + ' · ' + esc(fmtDate(d.nextEpisode.date + 'T12:00:00')) + '</div>' : '';
        var hero = '<div class="tp-hero" data-sec="hero">' + titleArt(d) + '<div class="meta">' + meta + '</div>' +
          (d.tagline ? '<div class="tagline">' + esc(d.tagline) + '</div>' : '') +
          '<div class="overview">' + esc(d.overview) + '</div>' + by + cast + next +
          '<div class="actions">' + this.buttons().map(function (b, i) {
            return '<div class="btn' + (b.primary ? ' primary' : '') + '" data-i="' + i + '">' + esc(b.label) + '</div>';
          }).join('') + '</div></div>';
        var secs = this.sections(), body = '';
        if (secs.indexOf('seasons') !== -1) {
          body += '<div class="tp-sec" data-sec="seasons"><h2>' + t('title.seasons') + '</h2><div class="tp-strip">' + d.seasons.map(function (s, i) {
            var pct = s.have != null && s.episodes ? Math.round(100 * s.have / s.episodes) : null;
            return '<div class="season-card" data-i="' + i + '"><div class="sc-n">' + s.number + '</div><div class="sc-t">' + t('title.season', { n: s.number }) + '</div>' +
              '<div class="sc-s">' + t('title.episodesOf', { have: s.have != null ? s.have : '–', n: s.episodes }) + '</div>' +
              (pct != null ? '<div class="bar"><i data-w="' + pct + '%"></i></div>' : '') + '</div>';
          }).join('') + '</div></div>';
        }
        if (secs.indexOf('cast') !== -1) {
          body += '<div class="tp-sec" data-sec="cast"><h2>' + t('title.cast') + '</h2><div class="tp-strip">' + d.people.map(function (p, i) {
            return '<div class="person" data-i="' + i + '"><div class="ph" data-bg="' + esc(p.photo || '') + '">' + (p.photo ? '' : esc((p.name || '?').charAt(0))) + '</div>' +
              '<div class="pn">' + esc(p.name) + '</div><div class="pc">' + esc(p.character || '') + '</div></div>';
          }).join('') + '</div></div>';
        }
        if (secs.indexOf('recs') !== -1) {
          body += '<div class="tp-sec" data-sec="recs"><h2>' + t('title.more') + '</h2><div class="tp-strip">' + d.recommendations.map(landCard).join('') + '</div></div>';
        }
        var subs = d.subtitlesMissing == null ? null : (Array.isArray(d.subtitlesMissing)
          ? (d.subtitlesMissing.length ? t('fact.subsMissing', { l: d.subtitlesMissing.join(', ') }) : t('fact.subsOk'))
          : (d.subtitlesMissing ? t('fact.subsEpisodes', { n: d.subtitlesMissing }) : t('fact.subsOk')));
        var facts = [
          [t('fact.original'), d.originalTitle], [d.type === 'show' ? t('title.createdBy') : t('title.directedBy'), (d.creators || []).join(', ')],
          [d.type === 'show' ? t('fact.network') : t('fact.studio'), d.network], [t('fact.rating'), d.certification],
          [t('fact.status'), d.statusCode ? (I18n.has('tvstatus.' + d.statusCode) ? t('tvstatus.' + d.statusCode) : d.statusCode) : null],
          [t('fact.episodes'), d.counts ? t('fact.episodesVal', { e: d.counts.episodes, s: d.counts.seasons }) : null],
          [t('fact.genres'), (d.genres || []).join(', ')],
          ['IMDb', d.ratings && d.ratings.imdb ? t('fact.imdbVal', { r: d.ratings.imdb, v: d.ratings.imdbVotes || '' }) : null],
          [t('fact.budget'), d.budget ? t('fact.money', { n: Math.round(d.budget / 1e6) }) : null],
          [t('fact.revenue'), d.revenue ? t('fact.money', { n: Math.round(d.revenue / 1e6) }) : null],
          [t('fact.subs'), subs]
        ].filter(function (f) { return f[1]; });
        body += '<div class="tp-sec tp-facts"><h2>' + t('title.details') + '</h2><div class="facts">' + facts.map(function (f) {
          return '<div class="fact"><b>' + esc(f[0]) + '</b><span>' + esc(f[1]) + '</span></div>';
        }).join('') + '</div></div>';
        this.el.innerHTML = '<div class="backdrop" data-bg="' + esc(d.backdrop || '') + '"></div><div class="scrim"></div>' +
          '<div class="tp" id="tpPage"><div class="tp-inner" id="tpInner">' + hero + body + '</div></div>';
        this.focus();
      },
      focus: function () {
        var f = this.el.querySelectorAll('.focus'); for (var i = 0; i < f.length; i++) f[i].classList.remove('focus');
        var name = this.sections()[this.sec], idx = this.idx[this.sec];
        var secEl = this.el.querySelector('[data-sec="' + name + '"]'); if (!secEl) return;
        var target = name === 'hero' ? secEl.querySelector('.btn[data-i="' + idx + '"]') : secEl.querySelectorAll('.tp-strip > *')[idx];
        if (target) target.classList.add('focus');
        if (name !== 'hero') {
          var strip = secEl.querySelector('.tp-strip'), w = target ? target.offsetWidth + 20 : 0;
          strip.style.transform = 'translateX(' + (-Math.max(0, idx - 2) * w) + 'px)';
        }
        $('tpInner').style.transform = 'translateY(' + (name === 'hero' ? 0 : -(secEl.offsetTop - 120)) + 'px)';
        this.el.querySelector('.backdrop').classList.toggle('dim', name !== 'hero');
      },
      count: function (name) {
        var d = this.d;
        return name === 'hero' ? this.buttons().length : name === 'seasons' ? d.seasons.length : name === 'cast' ? d.people.length : d.recommendations.length;
      },
      key: function (k) {
        if (!this.d) return true;
        var secs = this.sections(), name = secs[this.sec], n = this.count(name);
        if (k === K.LEFT) this.idx[this.sec] = Math.max(0, this.idx[this.sec] - 1);
        else if (k === K.RIGHT) this.idx[this.sec] = Math.min(n - 1, this.idx[this.sec] + 1);
        else if (k === K.DOWN) { if (this.sec < secs.length - 1) this.sec++; }
        else if (k === K.UP) { if (this.sec > 0) this.sec--; }
        else if (k === K.ENTER) { this.press(name, this.idx[this.sec]); return true; }
        this.focus(); return true;
      },
      press: function (name, i) {
        var self = this, d = this.d;
        if (name === 'seasons') return pushOverlay(Season(d, d.seasons[i].number));
        if (name === 'recs') return openDetail(d.recommendations[i]);
        if (name === 'cast') return pushOverlay(Person(d.people[i]));
        var b = this.buttons()[i]; if (!b) return;
        if (b.id === 'play') {
          var it = this.jf.item, isEp = it.Type === 'Episode';
          play({ itemId: it.Id, title: d.title, logo: d.logo, backdrop: d.backdrop, type: d.type, tmdb: d.tmdb,
                 season: isEp ? it.ParentIndexNumber : null, episode: isEp ? it.IndexNumber : null,
                 subtitle: isEp ? t('ep.code', { s: it.ParentIndexNumber, e: it.IndexNumber }) + ' · ' + it.Name : null, resume: true });
        } else if (b.id === 'signin') withJellyfin(function () { self.loadJellyfin(); });
        else if (b.id === 'trailer') pushOverlay(Trailer(d.trailerYouTubeId, d.trailerName || d.title));
        else if (b.id === 'add' && !this.busy) {
          this.busy = true; toast(t('title.adding'));
          api('/api/add', { type: d.type, tmdb: d.tmdb }).then(function (r) {
            toast(r.already ? t('title.alreadyIn') : (d.type === 'show' ? t('title.addedShow') : t('title.addedMovie')));
            Discover.refreshStatus(); self.d = null; self.busy = false; self.mount(self.el);
          }).catch(function (e) { self.busy = false; toast(e.message, 6000); });
        } else if (b.id === 'releases') pushOverlay(Releases(d, null, null, t('rel.title')));
      }
    };
  }

  // Person page: big portrait, bio, "Known for" + filmography rows.
  function Person(p) {
    return {
      d: null, sec: 0, idx: [0, 0],
      mount: function (el) {
        this.el = el; var self = this;
        if (this.d) return this.draw();
        el.innerHTML = '<div class="backdrop dim" data-bg=""></div><div class="scrim"></div><div class="loading-center">' +
          (p.photo ? '<div class="pp-avatar" data-bg="' + esc(p.photo) + '"></div>' : '') + '<div class="pp-loading-name">' + esc(p.name) + '</div><div class="ring"></div></div>';
        api('/api/person/' + p.id).then(function (d) { self.d = d; if (stack[stack.length - 1] === self) self.draw(); })
          .catch(function (e) { toast(e.message, 6000); });
      },
      draw: function () {
        var d = this.d;
        var bg = d.rows[0] && d.rows[0].items[0] ? d.rows[0].items[0].backdrop : '';
        var meta = [d.department ? (I18n.has('dept.' + d.department) ? t('dept.' + d.department) : d.department) : null,
          d.age != null ? t('common.years', { n: d.age }) + (d.deathday ? ' (' + t('person.died') + ')' : '') : null, d.place,
          d.count ? t('person.works', { n: d.count }) : null].filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('');
        var rows = d.rows.map(function (r, i) {
          return '<div class="tp-sec pp-row" data-sec="' + i + '"><h2>' + esc(rowTitle(r)) + '</h2><div class="tp-strip">' + r.items.map(landCard).join('') + '</div></div>';
        }).join('');
        this.el.innerHTML = '<div class="backdrop dim" data-bg="' + esc(bg) + '"></div><div class="scrim"></div>' +
          '<div class="tp"><div class="tp-inner pp" id="tpInner"><div class="pp-head">' +
          '<div class="pp-photo" data-bg="' + esc(d.photo || '') + '">' + (d.photo ? '' : esc(d.name.charAt(0))) + '</div>' +
          '<div class="pp-text"><h1 class="logo-text">' + esc(d.name) + '</h1><div class="meta">' + meta + '</div>' +
          '<div class="pp-bio">' + esc(d.biography || t('person.noBio')) + '</div></div></div>' + rows + '</div></div>';
        this.focus();
      },
      focus: function () {
        var f = this.el.querySelectorAll('.focus'); for (var i = 0; i < f.length; i++) f[i].classList.remove('focus');
        var secEl = this.el.querySelector('[data-sec="' + this.sec + '"]'); if (!secEl) return;
        var cards = secEl.querySelectorAll('.tp-strip > .card'), c = cards[this.idx[this.sec]];
        if (c) c.classList.add('focus');
        secEl.querySelector('.tp-strip').style.transform = 'translateX(' + (-Math.max(0, this.idx[this.sec] - 2) * 372) + 'px)';
        $('tpInner').style.transform = 'translateY(' + (this.sec === 0 ? 0 : -(secEl.offsetTop - 160)) + 'px)';
      },
      key: function (k) {
        if (!this.d || !this.d.rows.length) return true;
        var n = this.d.rows[this.sec].items.length;
        if (k === K.LEFT) this.idx[this.sec] = Math.max(0, this.idx[this.sec] - 1);
        else if (k === K.RIGHT) this.idx[this.sec] = Math.min(n - 1, this.idx[this.sec] + 1);
        else if (k === K.UP) { if (this.sec > 0) this.sec--; }
        else if (k === K.DOWN) { if (this.sec < this.d.rows.length - 1) this.sec++; }
        else if (k === K.ENTER) { openDetail(this.d.rows[this.sec].items[this.idx[this.sec]]); return true; }
        this.focus(); return true;
      }
    };
  }

  var EP_CLS = { downloaded: 'library', downloading: 'downloading', blocked: 'blocked', missing: 'wanted', unaired: 'missing', unmonitored: 'missing' };
  function Season(d, n) {
    return {
      data: null, zone: 'list', i: 0, a: 0, h: 0, timer: null,
      mount: function (el) {
        this.el = el; var self = this;
        el.innerHTML = '<div class="backdrop dim" data-bg="' + esc(d.backdrop || '') + '"></div><div class="scrim"></div>' +
          '<div id="seasonBody"><div class="ep-head">' + titleArt(d) + '<span class="summary">' + t('title.season', { n: n }) + '</span></div></div>';
        if (this.data) this.draw();
        this.load();
        clearInterval(this.timer);
        this.timer = setInterval(function () {
          if (stack[stack.length - 1] === self && !Player.active && self.data && self.data.episodes.some(function (e) { return e.status === 'downloading'; })) self.load();
        }, 5000);
      },
      unmount: function () { clearInterval(this.timer); },
      load: function () {
        var self = this;
        api('/api/season/' + d.tmdb + '/' + n).then(function (r) {
          self.data = r; self.i = Math.min(self.i, r.episodes.length - 1);
          if (stack[stack.length - 1] === self) self.draw();
        }).catch(function (e) { toast(e.message, 6000); });
      },
      ep: function () { return this.data && this.data.episodes[this.i]; },
      head: function () { return [{ id: 'seasonAuto', label: t('season.searchAll') }, { id: 'seasonPick', label: t('season.pickPack') }]; },
      actions: function (e) {
        if (!e) return [];
        var a = [];
        if (e.status === 'downloaded') a.push({ id: 'play', label: '▶  ' + t('title.watch'), primary: true });
        if (e.status === 'blocked') a.push({ id: 'fixImport', label: t('season.fixImport'), primary: true });
        if (e.status === 'missing') a.push({ id: 'auto', label: t('season.searchAuto'), primary: true });
        if (e.status !== 'unaired') a.push({ id: 'pick', label: e.status === 'downloaded' ? t('season.change') : t('season.pick') });
        if (e.status === 'downloaded' && e.missingSubtitles && e.missingSubtitles.length) a.push({ id: 'subs', label: t('season.subs') });
        return a;
      },
      draw: function () {
        var eps = this.data.episodes;
        var have = eps.filter(function (e) { return e.status === 'downloaded'; }).length;
        var list = eps.map(function (e) {
          var extra = e.status === 'downloading' && e.progress != null ? ' ' + e.progress + '%' : (e.status === 'unaired' ? ' ' + fmtDate(e.airDate) : '');
          var subsWarn = e.missingSubtitles && e.missingSubtitles.length ? '<span class="pill wanted">' + t('season.noSubs') + '</span>' : '';
          return '<div class="li ep"><div class="thumb" data-bg="' + esc(e.still || '') + '"></div><div class="grow"><div class="t">' + e.number + '. ' + esc(e.title) + '</div>' +
            '<div class="s">' + (e.runtime ? t('common.min', { n: e.runtime }) + ' · ' : '') + esc(fmtDate(e.airDate)) + '</div></div>' +
            subsWarn + '<span class="pill ' + EP_CLS[e.status] + '">' + t('ep.' + e.status) + extra + '</span></div>';
        }).join('');
        var head = this.head().map(function (b, i) { return '<div class="btn small" data-h="' + i + '">' + esc(b.label) + '</div>'; }).join('');
        $('seasonBody').innerHTML = '<div class="ep-head">' + titleArt(d) + '<span class="summary">' + t('season.summary', { n: n, have: have, total: eps.length }) + '</span>' + head + '</div>' +
          '<div class="ep-list"><div class="list-inner" id="epInner">' + list + '</div></div><div class="ep-panel" id="epPanel"></div>';
        this.drawPanel(); this.focus();
      },
      drawPanel: function () {
        var e = this.ep(); if (!e) return;
        var subs = '';
        if (e.subtitles || e.missingSubtitles) {
          var ok = (e.subtitles || []).map(function (s) { return esc(s.name) + (s.embedded ? ' ' + t('season.embedded') : ''); });
          var miss = (e.missingSubtitles || []).map(function (s) { return '<span class="rej">' + esc(t('season.missingLang', { l: s.name })) + '</span>'; });
          subs = '<div class="ep-line"><b>' + t('season.subtitles') + '</b> ' + (ok.concat(miss).join(' · ') || '—') + '</div>';
        }
        var file = e.file ? '<div class="ep-line"><b>' + t('season.file') + '</b> ' + esc([e.file.quality, bytes(e.file.size), e.file.releaseGroup, e.file.video].filter(Boolean).join(' · ')) + '</div>' +
          (e.file.audio && e.file.audio.length ? '<div class="ep-line"><b>' + t('season.audio') + '</b> ' + esc(e.file.audio.join(', ')) + '</div>' : '') : '';
        var blocked = e.status === 'blocked' ? '<div class="ep-line"><b>' + t('ep.blocked') + '</b> <span class="rej">' +
          esc(e.blockReason && e.blockReason !== 'other' && I18n.has('reason.' + e.blockReason) ? t('reason.' + e.blockReason) : (e.blockMessage || '')) + '</span></div>' : '';
        var prog = e.status === 'downloading' ? '<div class="ep-line"><b>' + t('season.download') + '</b> ' + (e.progress || 0) + '%' + (e.timeleft ? ' · ' + esc(t('season.left', { t: e.timeleft })) : '') +
          (e.downloadState ? ' · ' + esc(e.downloadState) : '') + '</div><div class="bar"><i data-w="' + (e.progress || 0) + '%"></i></div>' : '';
        var acts = this.actions(e).map(function (b, i) { return '<div class="btn' + (b.primary ? ' primary' : '') + '" data-a="' + i + '">' + esc(b.label) + '</div>'; }).join('');
        $('epPanel').innerHTML = '<div class="still" data-bg="' + esc(e.still || d.backdrop || '') + '"></div>' +
          '<h2>' + e.number + '. ' + esc(e.title) + '</h2>' +
          '<div class="meta"><span class="pill ' + EP_CLS[e.status] + '">' + t('ep.' + e.status) + '</span><span>' + (e.airDate ? (e.status === 'unaired' ? t('season.premieres', { d: fmtDate(e.airDate) }) : fmtDate(e.airDate)) : '') + '</span>' +
          (e.runtime ? '<span>' + t('common.min', { n: e.runtime }) + '</span>' : '') + '</div>' +
          '<div class="overview">' + esc(e.overview || t('season.noOverview')) + '</div>' + file + subs + blocked + prog +
          '<div class="ep-actions">' + (acts || '<span class="hint">' + t('season.nothing') + '</span>') + '</div>';
      },
      focus: function () {
        var f = this.el.querySelectorAll('.focus'); for (var x = 0; x < f.length; x++) f[x].classList.remove('focus');
        var lis = this.el.querySelectorAll('.li.ep');
        for (var y = 0; y < lis.length; y++) lis[y].classList.remove('sel');
        if (lis[this.i]) {
          lis[this.i].classList.add(this.zone === 'list' ? 'focus' : 'sel');
          $('epInner').style.transform = 'translateY(' + (-Math.max(0, lis[this.i].offsetTop - 420)) + 'px)';
        }
        if (this.zone === 'act') { var b = this.el.querySelector('.btn[data-a="' + this.a + '"]'); if (b) b.classList.add('focus'); }
        if (this.zone === 'head') { var hb = this.el.querySelector('.btn[data-h="' + this.h + '"]'); if (hb) hb.classList.add('focus'); }
      },
      key: function (k) {
        if (!this.data) return true;
        var n2 = this.data.episodes.length, acts = this.actions(this.ep());
        if (this.zone === 'list') {
          if (k === K.UP) { if (this.i > 0) { this.i--; this.drawPanel(); } else { this.zone = 'head'; this.h = 0; } }
          else if (k === K.DOWN) { if (this.i < n2 - 1) { this.i++; this.drawPanel(); } }
          else if (k === K.ENTER && acts[0] && acts[0].id === 'play') { this.run(acts[0]); return true; }   // OK plays straight away
          else if (k === K.RIGHT || k === K.ENTER) { if (acts.length) { this.zone = 'act'; this.a = 0; } }
        } else if (this.zone === 'act') {
          if (k === K.LEFT) { if (this.a > 0) this.a--; else this.zone = 'list'; }
          else if (k === K.RIGHT) { if (this.a < acts.length - 1) this.a++; }
          else if (k === K.UP || k === K.DOWN) { this.zone = 'list'; }
          else if (k === K.ENTER) { this.run(acts[this.a]); return true; }
        } else {
          if (k === K.LEFT) { if (this.h > 0) this.h--; }
          else if (k === K.RIGHT) { if (this.h < 1) this.h++; }
          else if (k === K.DOWN) { this.zone = 'list'; }
          else if (k === K.ENTER) { this.run(this.head()[this.h]); return true; }
        }
        this.focus(); return true;
      },
      back: function () { if (this.zone !== 'list') { this.zone = 'list'; this.focus(); return true; } return false; },
      run: function (b) {
        var self = this, e = this.ep(), sid = this.data.seriesId;
        if (!b) return;
        if (b.id === 'play') return playEpisode(d, n, e.number, e.title);
        if (b.id === 'fixImport') {
          // same fix as Downloads → Needs attention, matched by the download id
          return loadAttention(true).then(function (items) {
            var it = items.filter(function (x) { return x.downloadId === e.downloadId; })[0];
            if (!it) return toast(t('season.fixNone'), 6000);
            if (!it.action) return toast(t('dl.resolveIn', { svc: 'Sonarr', msg: it.raw }), 8000);
            if (self.armed !== e.downloadId) { self.armed = e.downloadId; return toast(t('common.pressOkAgain', { what: t('action.' + it.action).toLowerCase() }), 6000); }
            self.armed = null; toast(t('dl.resolving'), 4000);
            return api('/api/sync/resolve', { svc: it.svc, action: it.action, queueIds: it.queueIds, downloadId: it.downloadId, movieId: it.movieId, seriesId: it.seriesId })
              .then(function () { toast(t('dl.done.' + it.action), 6000); setTimeout(function () { self.load(); }, 5000); });
          }).catch(function (x) { toast(x.message, 6000); });
        }
        if (b.id === 'pick') return pushOverlay(Releases(d, n, e.id, e.number + '. ' + e.title));
        if (b.id === 'seasonPick') return pushOverlay(Releases(d, n, null, t('title.season', { n: n })));
        var call = b.id === 'auto' ? api('/api/episode/search', { episodeId: e.id })
          : b.id === 'seasonAuto' ? api('/api/season/search', { seriesId: sid, season: n })
          : b.id === 'subs' ? api('/api/episode/subtitles', { seriesId: sid, episodeId: e.id }) : null;
        if (!call) return;
        toast(b.id === 'subs' ? t('season.subsSearching') : t('season.searching'), 8000);
        call.then(function (r) {
          if (b.id === 'subs') toast(r.nothingMissing ? t('season.subsNone') : (r.ok ? t('season.subsResult', { r: r.searched.map(function (s) { return s.language + (s.ok ? ' ✓' : ' ✗'); }).join(', ') }) : t('season.subsNotFound')), 6000);
          else toast(t('season.searchSent'), 6000);
          setTimeout(function () { self.load(); }, 4000);
        }).catch(function (x) { toast(x.message, 6000); });
      }
    };
  }

  function Releases(d, season, episodeId, label) {
    return {
      items: null, i: 0, armed: -1,
      mount: function (el) {
        this.el = el; var self = this;
        el.innerHTML = '<div class="backdrop dim" data-bg="' + esc(d.backdrop || '') + '"></div><div class="scrim"></div>' +
          '<div class="page-title">' + esc(d.title) + '</div><div class="page-sub">' + esc((label || t('rel.title')) + ' · ' + t('rel.hint')) + '</div>' +
          '<div class="list"><div class="list-inner" id="relInner"><div class="spinner flush">' + t('rel.searching') + '</div></div></div>';
        if (this.items) return this.draw();
        api('/api/releases/' + d.type + '/' + d.tmdb + (episodeId ? '?episodeId=' + episodeId : (season ? '?season=' + season : ''))).then(function (r) {
          self.items = r.items; if (stack[stack.length - 1] === self) self.draw();
        }).catch(function (e) { $('relInner').innerHTML = '<div class="spinner flush">' + esc(t('common.error', { msg: e.message })) + '</div>'; });
      },
      draw: function () {
        var h = this.items.map(function (r) {
          var age = r.age != null ? (r.age < 48 ? t('rel.hours', { n: Math.round(r.age) }) : t('rel.days', { n: Math.round(r.age / 24) })) : '';
          return '<div class="li"><div class="grow"><div class="t">' + esc(r.title) + '</div><div class="s">' +
            esc([r.quality, r.indexer, age, (r.languages || []).join('/'), r.fullSeason ? t('rel.fullSeason') : ''].filter(Boolean).join(' · ')) +
            (r.approved ? '' : ' · <span class="rej">' + esc((r.rejections[0] || t('rel.rejected'))) + '</span>') + '</div></div>' +
            '<div class="r">' + bytes(r.size) + '<br>' + (r.seeders != null ? r.seeders + ' seeds' : '') + '</div></div>';
        }).join('');
        $('relInner').innerHTML = h || '<div class="spinner flush">' + t('rel.none') + '</div>';
        this.focus();
      },
      focus: function () {
        var lis = this.el.querySelectorAll('.li');
        for (var n = 0; n < lis.length; n++) lis[n].classList.toggle('focus', n === this.i);
        var el = lis[this.i]; if (el) $('relInner').style.transform = 'translateY(' + (-Math.max(0, el.offsetTop - 220)) + 'px)';
      },
      key: function (k) {
        if (!this.items) return true;
        if (k === K.UP) { if (this.i > 0) this.i--; this.armed = -1; }
        else if (k === K.DOWN) { if (this.i < this.items.length - 1) this.i++; this.armed = -1; }
        else if (k === K.ENTER) {
          var r = this.items[this.i]; if (!r) return true;
          if (this.armed !== this.i) { this.armed = this.i; toast(t('rel.confirm', { s: bytes(r.size), q: r.quality || '' })); return true; }
          this.armed = -1; toast(t('rel.sending'));
          api('/api/grab', { type: d.type, guid: r.guid, indexerId: r.indexerId })
            .then(function () { toast(t('rel.sent')); Discover.refreshStatus(); })
            .catch(function (e) { toast(e.message, 6000); });
          return true;
        }
        this.focus(); return true;
      }
    };
  }

  // ── rail + key routing ─────────────────────────────────────────────────────
  var SCREENS = { discover: Home, shows: Shows, movies: Movies, search: Search, downloads: Downloads, upcoming: Upcoming, settings: Settings };
  var ORDER = ['profile', 'discover', 'shows', 'movies', 'search', 'downloads', 'upcoming', 'settings'];
  var tab = 1, railFocus = 1, current = null, focusArea = 'content';

  function paintRailLabels() {
    var map = { profile: 'nav.profile', discover: 'nav.home', shows: 'nav.shows', movies: 'nav.movies', search: 'nav.search',
                downloads: 'nav.downloads', upcoming: 'nav.upcoming', settings: 'nav.settings' };
    var items = document.querySelectorAll('.rail-item');
    for (var n = 0; n < items.length; n++) {
      var k = items[n].getAttribute('data-tab'), span = items[n].querySelector('span');
      if (span) span.textContent = k === 'profile' && JF.current() ? JF.current().userName : t(map[k]);
    }
  }
  function paintAvatar() {
    var el = $('railAvatar'), s = JF.current(), img = JF.configured() ? JF.avatar() : null;
    el.style.backgroundImage = img ? 'url("' + img + '")' : '';
    el.textContent = img ? '' : (s ? s.userName.charAt(0).toUpperCase() : '?');
    paintRailLabels();
  }
  function paintRail() {
    var items = document.querySelectorAll('.rail-item');
    $('rail').classList.toggle('open', focusArea === 'rail');
    for (var n = 0; n < items.length; n++) {
      items[n].classList.toggle('active', n === tab);
      items[n].classList.toggle('focus', focusArea === 'rail' && n === railFocus);
    }
  }
  function showTab(i) {
    if (current && current.unmount) current.unmount();
    tab = i; railFocus = i; current = SCREENS[ORDER[i]];
    paintRail();
    current.mount($('screen'));
  }
  function setArea(a) {
    focusArea = a; if (a === 'rail') railFocus = tab;
    paintRail();
    if (current && current.focus) current.focus();
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (Player.active) { e.preventDefault(); Player.key(k); return; }
    if (k === K.BACK || k === K.ESC) {
      e.preventDefault();
      if (overlayOpen()) { var top = stack[stack.length - 1]; if (top.back && top.back()) return; return popOverlay(); }
      if (focusArea === 'content') return setArea('rail');
      try { tizen.application.getCurrentApplication().exit(); } catch (x) { /* desktop preview */ }
      return;
    }
    if (overlayOpen()) { stack[stack.length - 1].key(k); return; }
    if (!current) return;
    if (focusArea === 'rail') {
      if (k === K.UP && railFocus > 0) { railFocus--; paintRail(); }
      else if (k === K.DOWN && railFocus < ORDER.length - 1) { railFocus++; paintRail(); }
      else if (k === K.RIGHT || k === K.ENTER) {
        if (ORDER[railFocus] === 'profile') { if (k === K.ENTER) pushOverlay(Profiles(null, true)); return; }
        focusArea = 'content'; if (railFocus !== tab) showTab(railFocus); else setArea('content');
      }
      return;
    }
    if (!current.key(k) && k === K.LEFT) setArea('rail');
  });

  // ── boot: server → public config → profile → home ─────────────────────────
  function refreshPublic() {
    return api('/api/public').then(function (cfg) { publicCfg = cfg; JF.configure(cfg.jellyfinUrl); return cfg; });
  }
  function boot() {
    while (stack.length) { var o = stack.pop(); if (o.unmount) o.unmount(); }
    $('overlay').classList.add('hidden');
    paintRailLabels();
    if (!U.API) return pushOverlay(Setup(boot));
    refreshPublic().then(function (cfg) {
      paintAvatar();
      BROWSES.forEach(function (b) { b.rows = null; b.resume = null; });
      if (!cfg.jellyfinUrl || !cfg.ready) { toast(t('setup.noJellyfin'), 8000); return showTab(ORDER.indexOf('settings')); }
      showTab(1);
      if (!JF.signedIn()) pushOverlay(Profiles(null, false));
    }).catch(function () { pushOverlay(Setup(boot)); });
  }

  U.registerMediaKeys();
  boot();
})();
