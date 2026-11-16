/* Cinema — Jellyfin client (runs on the TV, talks to the Jellyfin server directly).
   Profiles = Jellyfin users. Each signed-in user keeps its own access token in localStorage on the TV. */
(function () {
  'use strict';
  var U = window.Cinema;
  var SERVER = '';                      // set by JF.configure() from the Cinema server's public config
  var SESSIONS = 'cinemaSessions', CURRENT = 'cinemaUser';

  var deviceId = localStorage.getItem('cinemaDeviceId');
  if (!deviceId) { deviceId = 'cinema-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('cinemaDeviceId', deviceId); }

  function sessions() { try { return JSON.parse(localStorage.getItem(SESSIONS) || '{}'); } catch (e) { return {}; } }
  function saveSessions(all) { localStorage.setItem(SESSIONS, JSON.stringify(all)); }
  // one-time migration from the single-login storage of earlier versions
  (function () {
    var old = localStorage.getItem('cinemaJellyfin');
    if (!old) return;
    try { var o = JSON.parse(old), all = sessions(); all[o.userId] = o; saveSessions(all); localStorage.setItem(CURRENT, o.userId); } catch (e) { /* ignore */ }
    localStorage.removeItem('cinemaJellyfin');
  })();
  function session() { var id = localStorage.getItem(CURRENT); return id ? sessions()[id] || null : null; }
  function storeSession(s) { var all = sessions(); all[s.userId] = s; saveSessions(all); localStorage.setItem(CURRENT, s.userId); }
  function authHeader(token) {
    return 'MediaBrowser Client="Cinema", Device="Samsung TV", DeviceId="' + deviceId + '", Version="1.0.0"' + (token ? ', Token="' + token + '"' : '');
  }
  function req(method, path, body) {
    var s = session();
    var h = { Authorization: authHeader(s && s.token), Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    return fetch(SERVER + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401 && s) { JF.signOut(); throw new Error('Jellyfin session expired'); }
      if (!r.ok) throw new Error('Jellyfin ' + r.status);
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }
  function uid() { var s = session(); if (!s) throw new Error('Not signed in to Jellyfin'); return s.userId; }
  function token() { var s = session(); return s ? s.token : ''; }

  var JF = window.Jellyfin = { deviceId: deviceId, session: session, token: token };

  JF.configure = function (url) { SERVER = (url || '').replace(/\/+$/, ''); JF.server = SERVER; };
  JF.configured = function () { return !!SERVER; };
  JF.signedIn = function () { return !!session(); };
  JF.current = session;
  JF.knownSessions = sessions;
  // Switch to a profile that already has a stored session; false if it needs a sign-in.
  JF.use = function (userId) { if (!sessions()[userId]) return false; localStorage.setItem(CURRENT, userId); findCache = {}; return true; };
  JF.signOut = function () {
    var id = localStorage.getItem(CURRENT), all = sessions();
    if (id) { delete all[id]; saveSessions(all); }
    localStorage.removeItem(CURRENT); findCache = {};
  };
  JF.publicUsers = function () {
    return fetch(SERVER + '/Users/Public').then(function (r) { if (!r.ok) throw new Error('Jellyfin ' + r.status); return r.json(); });
  };
  JF.userImage = function (userId, tag, w) {
    return tag ? SERVER + '/Users/' + userId + '/Images/Primary?tag=' + tag + '&maxWidth=' + (w || 300) : null;
  };
  JF.avatar = function () { var s = session(); return s ? JF.userImage(s.userId, s.imageTag, 120) : null; };
  function fromAuth(a) {
    return { token: a.AccessToken, userId: a.User.Id, userName: a.User.Name, serverId: a.ServerId, imageTag: a.User.PrimaryImageTag || null };
  }
  JF.signInPassword = function (name, password) {
    return req('POST', '/Users/AuthenticateByName', { Username: name, Pw: password || '' }).then(function (a) {
      var s = fromAuth(a); storeSession(s); findCache = {}; return s;
    });
  };

  // Quick Connect: onCode(code) is called once; resolves with the session when approved.
  JF.quickConnect = function (onCode) {
    var cancelled = false, timer;
    var p = req('POST', '/QuickConnect/Initiate').then(function (qc) {
      onCode(qc.Code);
      return new Promise(function (resolve, reject) {
        (function poll() {
          if (cancelled) return reject(new Error('cancelled'));
          req('GET', '/QuickConnect/Connect?Secret=' + encodeURIComponent(qc.Secret)).then(function (st) {
            if (!st.Authenticated) { timer = setTimeout(poll, 2500); return; }
            req('POST', '/Users/AuthenticateWithQuickConnect', { Secret: qc.Secret }).then(function (a) {
              var s = fromAuth(a); storeSession(s); findCache = {}; resolve(s);
            }, reject);
          }, function (e) { timer = setTimeout(poll, 4000); });
        })();
      });
    });
    return { promise: p, cancel: function () { cancelled = true; clearTimeout(timer); } };
  };

  JF.item = function (id) { return req('GET', '/Users/' + uid() + '/Items/' + id + '?Fields=ProviderIds,Overview,MediaStreams,Chapters,Trickplay'); };

  // Find the Jellyfin series/movie for a TMDB id (cached per session).
  var findCache = {};
  JF.findByTmdb = function (type, tmdb, title, year) {
    var key = type + ':' + tmdb;
    if (findCache[key] !== undefined) return Promise.resolve(findCache[key]);
    var kind = type === 'show' ? 'Series' : 'Movie';
    var base = '/Users/' + uid() + '/Items?Recursive=true&IncludeItemTypes=' + kind + '&Fields=ProviderIds,UserData&Limit=20';
    function match(it) { return it.ProviderIds && String(it.ProviderIds.Tmdb || it.ProviderIds.tmdb || '') === String(tmdb); }
    return req('GET', base + '&AnyProviderIdEquals=tmdb.' + tmdb).then(function (r) {
      var hit = (r.Items || []).filter(match)[0];
      if (hit || !title) return hit;
      return req('GET', base + '&SearchTerm=' + encodeURIComponent(title)).then(function (r2) {
        var items = r2.Items || [];
        return items.filter(match)[0] || items.filter(function (it) { return year && String(it.ProductionYear) === String(year); })[0];
      });
    }).then(function (hit) { findCache[key] = hit || null; return findCache[key]; });
  };

  JF.episodes = function (seriesId) {
    return req('GET', '/Shows/' + seriesId + '/Episodes?UserId=' + uid() + '&Fields=Overview,UserData').then(function (r) { return r.Items || []; });
  };
  JF.episode = function (seriesId, season, number) {
    return JF.episodes(seriesId).then(function (eps) {
      return eps.filter(function (e) { return e.ParentIndexNumber === Number(season) && e.IndexNumber === Number(number); })[0] || null;
    });
  };
  JF.nextEpisode = function (ep) {
    if (!ep.SeriesId) return Promise.resolve(null);
    return JF.episodes(ep.SeriesId).then(function (eps) {
      for (var i = 0; i < eps.length; i++) if (eps[i].Id === ep.Id) return eps[i + 1] || null;
      return null;
    });
  };

  JF.nextUp = function (seriesId) {
    return req('GET', '/Shows/NextUp?SeriesId=' + seriesId + '&UserId=' + uid() + '&Limit=1&Fields=Overview')
      .then(function (r) { return (r.Items || [])[0] || null; });
  };
  JF.resume = function () {
    return req('GET', '/Users/' + uid() + '/Items/Resume?Limit=15&Recursive=true&MediaTypes=Video&Fields=ProviderIds,Overview')
      .then(function (r) { return r.Items || []; });
  };
  JF.providerIds = function (ids) {
    if (!ids.length) return Promise.resolve({});
    return req('GET', '/Users/' + uid() + '/Items?Ids=' + ids.join(',') + '&Fields=ProviderIds').then(function (r) {
      var out = {}; (r.Items || []).forEach(function (it) { out[it.Id] = it.ProviderIds || {}; }); return out;
    });
  };
  JF.image = function (id, kind, w) { return SERVER + '/Items/' + id + '/Images/' + kind + '?maxWidth=' + (w || 640); };

  // Library scan (needs an admin account) and its progress from the scheduled-task list.
  JF.scanLibrary = function () { return req('POST', '/Library/Refresh'); };
  JF.scanProgress = function () {
    return req('GET', '/ScheduledTasks?isHidden=false').then(function (tasks) {
      var t = (tasks || []).filter(function (x) { return x.Key === 'RefreshLibrary'; })[0];
      return t ? { running: t.State === 'Running', percent: Math.round(t.CurrentProgressPercentage || 0),
                   last: t.LastExecutionResult && t.LastExecutionResult.EndTimeUtc } : null;
    });
  };
  JF.segments = function (id) {
    return req('GET', '/MediaSegments/' + id).then(function (r) { return (r && r.Items) || []; }).catch(function () { return []; });
  };
  JF.refreshItem = function (id) {
    return req('POST', '/Items/' + id + '/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false');
  };

  // What this TV (2020 Tizen 5.5) plays natively. Text subtitles are delivered "External" so the
  // player renders them itself (styling, offset); image subtitles get burned in by the server.
  var PROFILE = {
    MaxStreamingBitrate: 120000000, MaxStaticBitrate: 120000000, MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv,mp4,m4v,mov,ts,m2ts,webm',
      VideoCodec: 'h264,hevc,vp9,mpeg2video,mpeg4', AudioCodec: 'aac,mp3,ac3,eac3,flac,opus,vorbis,pcm_s16le,pcm_s24le' }],
    TranscodingProfiles: [{ Type: 'Video', Container: 'ts', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264,hevc',
      AudioCodec: 'aac,ac3,eac3', MaxAudioChannels: '6', MinSegments: '1', BreakOnNonKeyFrames: true }],
    ContainerProfiles: [], CodecProfiles: [],
    SubtitleProfiles: ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'ttml'].map(function (f) { return { Format: f, Method: 'External' }; })
      .concat(['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].map(function (f) { return { Format: f, Method: 'Encode' }; }))
  };

  // opts: { startMs, audioIndex, subtitleIndex (only for burn-in), forceTranscode }
  JF.playbackInfo = function (itemId, opts) {
    opts = opts || {};
    var q = '?UserId=' + uid() + '&IsPlayback=true&AutoOpenLiveStream=true&StartTimeTicks=' + Math.round((opts.startMs || 0) * 10000) +
      (opts.audioIndex != null ? '&AudioStreamIndex=' + opts.audioIndex : '') +
      (opts.subtitleIndex != null ? '&SubtitleStreamIndex=' + opts.subtitleIndex : '') +
      '&MaxStreamingBitrate=' + PROFILE.MaxStreamingBitrate;
    var body = { DeviceProfile: PROFILE, EnableDirectPlay: !opts.forceTranscode, EnableDirectStream: !opts.forceTranscode, EnableTranscoding: true,
      AllowVideoStreamCopy: true, AllowAudioStreamCopy: true };
    if (opts.audioIndex != null) body.AudioStreamIndex = opts.audioIndex;
    if (opts.subtitleIndex != null) body.SubtitleStreamIndex = opts.subtitleIndex;
    return req('POST', '/Items/' + itemId + '/PlaybackInfo' + q, body).then(function (info) {
      var ms = info.MediaSources[0];
      var direct = ms.SupportsDirectPlay && !opts.forceTranscode;
      var url = direct
        ? SERVER + '/Videos/' + itemId + '/stream.' + (ms.Container || 'mkv').split(',')[0] + '?static=true&MediaSourceId=' + ms.Id +
          '&DeviceId=' + deviceId + '&PlaySessionId=' + info.PlaySessionId + '&api_key=' + token() + (ms.ETag ? '&Tag=' + ms.ETag : '')
        : SERVER + ms.TranscodingUrl;
      return { url: url, method: direct ? 'DirectPlay' : 'Transcode', mediaSource: ms, playSessionId: info.PlaySessionId,
               streams: ms.MediaStreams || [], defaultAudio: ms.DefaultAudioStreamIndex, defaultSubtitle: ms.DefaultSubtitleStreamIndex };
    });
  };

  // Text subtitle events as JSON (Jellyfin converts SRT/ASS/embedded text tracks).
  JF.subtitleEvents = function (itemId, mediaSourceId, index) {
    return fetch(SERVER + '/Videos/' + itemId + '/' + mediaSourceId + '/Subtitles/' + index + '/0/Stream.js?api_key=' + token())
      .then(function (r) { if (!r.ok) throw new Error('subtitle ' + r.status); return r.json(); })
      .then(function (j) {
        return (j.TrackEvents || []).map(function (e) {
          return { start: e.StartPositionTicks / 10000, end: e.EndPositionTicks / 10000, text: e.Text || '' };
        }).sort(function (a, b) { return a.start - b.start; });
      });
  };

  function ticks(ms) { return Math.round(ms * 10000); }
  JF.reportStart = function (p) { return p ? req('POST', '/Sessions/Playing', p).catch(function () {}) : Promise.resolve(); };
  JF.reportProgress = function (p) { return p ? req('POST', '/Sessions/Playing/Progress', p).catch(function () {}) : Promise.resolve(); };
  JF.reportStop = function (p) { return p ? req('POST', '/Sessions/Playing/Stopped', p).catch(function () {}) : Promise.resolve(); };
  JF.stopTranscode = function (playSessionId) {
    return req('DELETE', '/Videos/ActiveEncodings?DeviceId=' + deviceId + '&PlaySessionId=' + playSessionId).catch(function () {});
  };
  JF.ticks = ticks;
  JF.trickplayTile = function (itemId, width, index, mediaSourceId) {
    return SERVER + '/Videos/' + itemId + '/Trickplay/' + width + '/' + index + '.jpg?api_key=' + token() + '&MediaSourceId=' + mediaSourceId;
  };
})();
