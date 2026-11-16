// Cinema backend: one JSON API for the TV app. Merges Trakt + TMDB + OMDb discovery with the
// *arr stack (Sonarr, Radarr, Prowlarr-synced indexers, Bazarr) and Deluge. All API keys stay here.
// User-facing strings are sent as keys/codes; the TV app translates them (en-US / pt-BR).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// Optional env file next to the app (KEY=value lines); real environment variables win.
for (const f of [process.env.CINEMA_ENV_FILE, path.join(__dirname, '..', '.env'), path.join(__dirname, '..', 'secrets.env')]) {
  if (!f || !fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const config = require('./config');
const VERSION = require('../package.json').version;
const PORT = Number(process.env.PORT || 3817);
const C = () => config.get();
const IMG = 'https://image.tmdb.org/t/p/';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── helpers ─────────────────────────────────────────────────────────────────
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
  const text = await r.text();
  if (!r.ok) {
    const detail = /^\s*</.test(text) ? '' : ': ' + text.slice(0, 160);
    throw new HttpError(502, `${new URL(url).host} ${r.status}${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (hit && hit.pending) return hit.pending;
  const pending = fn().then((value) => { cache.set(key, { value, until: Date.now() + ttlMs }); return value; })
    .catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { ...(hit || {}), pending, until: 0 });
  return pending;
}
function clearCaches() { cache.clear(); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; try { out[n] = await fn(items[n]); } catch { out[n] = null; } }
  }));
  return out;
}

function need(v, what) { if (!v) throw new HttpError(503, `${what} is not configured (Settings)`, 'not_configured'); return v; }
const lang = () => C().prefs.metadataLanguage || 'en-US';
const lang2 = () => lang().slice(0, 2);
const region = () => (C().prefs.region || 'US').toUpperCase();
const has = (svc) => !!(C()[svc].url && (C()[svc].apiKey || C()[svc].password));

// ── external APIs ───────────────────────────────────────────────────────────
const tmdb = (p, q = {}) => {
  const u = new URL('https://api.themoviedb.org/3' + p);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return getJSON(u, { headers: { Authorization: 'Bearer ' + need(C().tmdb.token, 'TMDB'), Accept: 'application/json' } });
};
const trakt = (p) => getJSON('https://api.trakt.tv' + p, {
  headers: { 'Content-Type': 'application/json', 'User-Agent': `Cinema/${VERSION}`, 'trakt-api-version': '2', 'trakt-api-key': need(C().trakt.clientId, 'Trakt') },
});
const arr = (svc, p, opts = {}) => {
  const s = C()[svc];
  need(s.url, svc);
  return getJSON(s.url + p, { ...opts, headers: { 'X-Api-Key': need(s.apiKey, svc), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
};

// TMDB details in the metadata language, English fallback for empty overview/title.
async function tmdbDetails(type, id) {
  const kind = type === 'show' ? 'tv' : 'movie';
  return cached(`tmdb:${lang()}:${kind}:${id}`, 24 * 3600e3, async () => {
    const d = await tmdb(`/${kind}/${id}`, { language: lang(),
      append_to_response: `external_ids,videos,credits,images,recommendations,${kind === 'tv' ? 'content_ratings' : 'release_dates'}`,
      include_image_language: `${lang2()},en,null`, include_video_language: `${lang2()},en,null` });
    if (!d.overview && lang() !== 'en-US') {
      const en = await tmdb(`/${kind}/${id}`, { language: 'en-US' });
      d.overview = en.overview; if (!d.title && !d.name) { d.title = en.title; d.name = en.name; }
    }
    return d;
  });
}

async function omdbRatings(imdbId) {
  if (!imdbId || !C().omdb.apiKey) return null;
  return cached(`omdb:${imdbId}`, 7 * 24 * 3600e3, async () => {
    const d = await getJSON(`https://www.omdbapi.com/?i=${imdbId}&apikey=${C().omdb.apiKey}`);
    if (d.Response !== 'True') return null;
    const rt = (d.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    return { imdb: d.imdbRating !== 'N/A' ? d.imdbRating : null, imdbVotes: d.imdbVotes, rottenTomatoes: rt ? rt.Value : null, metascore: d.Metascore !== 'N/A' ? d.Metascore : null };
  });
}

// ── library state (Sonarr/Radarr), refreshed every minute ───────────────────
async function library() {
  return cached('library', 60e3, async () => {
    const [series, movies, sq, rq] = await Promise.all([
      has('sonarr') ? arr('sonarr', '/api/v3/series') : [],
      has('radarr') ? arr('radarr', '/api/v3/movie') : [],
      has('sonarr') ? arr('sonarr', '/api/v3/queue?pageSize=500') : { records: [] },
      has('radarr') ? arr('radarr', '/api/v3/queue?pageSize=500') : { records: [] },
    ]);
    return {
      byTvdb: new Map(series.map((s) => [s.tvdbId, s])),
      byTmdbShow: new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId, s])),
      byTmdbMovie: new Map(movies.map((m) => [m.tmdbId, m])),
      dlSeries: new Set(sq.records.map((r) => r.seriesId)),
      dlMovies: new Set(rq.records.map((r) => r.movieId)),
    };
  });
}

function statusOf(lib, type, ids) {
  if (type === 'show') {
    const s = (ids.tvdb && lib.byTvdb.get(ids.tvdb)) || (ids.tmdb && lib.byTmdbShow.get(ids.tmdb));
    if (!s) return { status: 'missing' };
    if (lib.dlSeries.has(s.id)) return { status: 'downloading', arrId: s.id };
    const st = s.statistics || {};
    return { status: st.episodeFileCount > 0 ? 'library' : 'wanted', arrId: s.id, have: st.episodeFileCount || 0, total: st.episodeCount || 0 };
  }
  const m = ids.tmdb && lib.byTmdbMovie.get(ids.tmdb);
  if (!m) return { status: 'missing' };
  if (lib.dlMovies.has(m.id)) return { status: 'downloading', arrId: m.id };
  return { status: m.hasFile ? 'library' : 'wanted', arrId: m.id };
}

// ── cards ───────────────────────────────────────────────────────────────────
function pickLogo(d) {
  const logos = (d.images && d.images.logos) || [];
  const l = logos.find((x) => x.iso_639_1 === lang2()) || logos.find((x) => x.iso_639_1 === 'en') || logos.find((x) => !x.iso_639_1);
  return l ? IMG + 'w500' + l.file_path.replace(/\.svg$/, '.png') : null;
}

async function cardFromTmdb(type, tmdbId, extra = {}) {
  const d = await tmdbDetails(type, tmdbId);
  const ext = d.external_ids || {};
  return {
    type, tmdb: d.id, tvdb: ext.tvdb_id || extra.tvdb || null, imdb: ext.imdb_id || d.imdb_id || extra.imdb || null,
    title: d.title || d.name, year: (d.release_date || d.first_air_date || '').slice(0, 4),
    poster: d.poster_path ? IMG + 'w342' + d.poster_path : null,
    backdrop: d.backdrop_path ? IMG + 'w1280' + d.backdrop_path : null,
    thumb: d.backdrop_path ? IMG + 'w780' + d.backdrop_path : null,
    logo: pickLogo(d),
    overview: d.overview, rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    ...extra.meta,
  };
}

async function withStatus(cards) {
  const lib = await library().catch(() => null);
  return cards.filter(Boolean).map((c) => (lib ? { ...c, ...statusOf(lib, c.type, c) } : c));
}

// Rows: { id, titleKey | title, kind?, items }. "watchers" lets the TV render "1.2k watching".
async function traktRow(id, titleKey, p, type, withWatchers) {
  const list = await cached(`trakt:${p}`, 3 * 3600e3, () => trakt(p));
  const cards = await mapLimit(list.slice(0, 20), 6, (x) => {
    const o = x.show || x.movie || x; const t = o.ids && o.ids.tmdb;
    if (!t) return null;
    return cardFromTmdb(type, t, { tvdb: o.ids.tvdb, imdb: o.ids.imdb, meta: withWatchers ? { watchers: x.watchers } : {} });
  });
  return { id, titleKey, items: await withStatus(cards) };
}

const settle = (promises) => Promise.all(promises.map((p) => p.catch((e) => ({ error: e.message }))));
function finishRows(rows, top10Key) {
  const good = rows.filter((r) => r && r.items && r.items.length);
  const trending = good.find((r) => r.id.startsWith('trending'));
  if (trending && top10Key) good.splice(good.indexOf(trending) + 1, 0, { id: 'top10', titleKey: top10Key, kind: 'top10', items: trending.items.slice(0, 10) });
  return { rows: good, errors: rows.filter((r) => r && r.error).map((r) => r.error) };
}

// ── home / browse ───────────────────────────────────────────────────────────
async function home() {
  return cached(`home:${lang()}`, 10 * 60e3, async () => finishRows(await settle([
    traktRow('trending-shows', 'row.trendingShows', '/shows/trending?limit=20', 'show', true),
    traktRow('trending-movies', 'row.trendingMovies', '/movies/trending?limit=20', 'movie', true),
    traktRow('watched-shows', 'row.watchedShows', '/shows/watched/weekly?limit=20', 'show'),
    traktRow('anticipated-shows', 'row.anticipatedShows', '/shows/anticipated?limit=20', 'show'),
    traktRow('popular-movies', 'row.popularMovies', '/movies/popular?limit=20', 'movie'),
  ]), 'row.top10Shows'));
}

const GENRES = { show: [80, 18, 35, 10765, 9648, 16, 99], movie: [28, 53, 35, 878, 27, 18, 16, 10749] };

async function genreNames(kind) {
  return cached(`genres:${lang()}:${kind}`, 7 * 24 * 3600e3, async () => {
    const r = await tmdb(`/genre/${kind}/list`, { language: lang() });
    return new Map((r.genres || []).map((g) => [g.id, g.name]));
  });
}

async function genreRow(type, id) {
  const kind = type === 'show' ? 'tv' : 'movie';
  const [names, r] = await Promise.all([genreNames(kind), cached(`discover:${lang()}:${kind}:${id}`, 12 * 3600e3, () => tmdb(`/discover/${kind}`, {
    language: lang(), with_genres: String(id), sort_by: 'popularity.desc', 'vote_count.gte': '300', include_adult: 'false' }))]);
  const cards = await mapLimit((r.results || []).filter((x) => x.backdrop_path).slice(0, 15), 6, (x) => cardFromTmdb(type, x.id));
  return { id: `genre-${id}`, title: names.get(id) || String(id), items: await withStatus(cards) };
}

async function recentlyAdded(type) {
  if (type === 'show') {
    if (!has('sonarr')) return null;
    const series = (await arr('sonarr', '/api/v3/series')).filter((s) => s.tmdbId && s.statistics && s.statistics.episodeFileCount > 0);
    const hist = await arr('sonarr', '/api/v3/history?pageSize=200&sortKey=date&sortDirection=descending&eventType=3').catch(() => ({ records: [] }));
    const order = [], seen = new Set();
    for (const h of hist.records) if (!seen.has(h.seriesId)) { seen.add(h.seriesId); order.push(h.seriesId); }
    const byId = new Map(series.map((s) => [s.id, s]));
    const ids = order.filter((id) => byId.has(id)).concat(series.map((s) => s.id).filter((id) => !seen.has(id)));
    const cards = await mapLimit(ids.slice(0, 20).map((id) => byId.get(id)), 6, (s) => cardFromTmdb('show', s.tmdbId));
    return { id: 'recent-shows', titleKey: 'row.recentShows', items: await withStatus(cards) };
  }
  if (!has('radarr')) return null;
  const have = (await arr('radarr', '/api/v3/movie')).filter((m) => m.hasFile && m.tmdbId)
    .sort((a, b) => String((b.movieFile && b.movieFile.dateAdded) || b.added).localeCompare(String((a.movieFile && a.movieFile.dateAdded) || a.added)));
  const cards = await mapLimit(have.slice(0, 20), 6, (m) => cardFromTmdb('movie', m.tmdbId));
  return { id: 'recent-movies', titleKey: 'row.recentMovies', items: await withStatus(cards) };
}

async function browse(type) {
  return cached(`browse:${lang()}:${type}`, 10 * 60e3, async () => {
    const t = type === 'show';
    const base = await settle([
      recentlyAdded(type),
      traktRow(t ? 'trending-shows' : 'trending-movies', 'row.trendingNow', t ? '/shows/trending?limit=20' : '/movies/trending?limit=20', type, true),
      traktRow(t ? 'watched-shows' : 'watched-movies', 'row.mostWatchedWeek', t ? '/shows/watched/weekly?limit=20' : '/movies/watched/weekly?limit=20', type),
      traktRow(t ? 'anticipated-shows' : 'anticipated-movies', 'row.mostAnticipated', t ? '/shows/anticipated?limit=20' : '/movies/anticipated?limit=20', type),
      ...(t ? [] : [traktRow('popular-movies', 'row.allTimePopular', '/movies/popular?limit=20', 'movie')]),
    ]);
    const genres = await settle(GENRES[type].map((id) => genreRow(type, id)));
    return finishRows(base.concat(genres), t ? 'row.top10Shows' : 'row.top10Movies');
  });
}

async function search(q) {
  if (!q || q.trim().length < 2) return { items: [] };
  const r = await cached(`search:${lang()}:${q.toLowerCase()}`, 600e3, () => tmdb('/search/multi', { query: q, language: lang(), include_adult: 'false' }));
  const hits = r.results.filter((x) => x.media_type === 'tv' || x.media_type === 'movie').slice(0, 20);
  const cards = await mapLimit(hits, 6, (x) => cardFromTmdb(x.media_type === 'tv' ? 'show' : 'movie', x.id));
  return { items: await withStatus(cards) };
}

// ── title page ──────────────────────────────────────────────────────────────
async function item(type, tmdbId) {
  const d = await tmdbDetails(type, tmdbId);
  const card = (await withStatus([await cardFromTmdb(type, tmdbId)]))[0];
  const vids = (d.videos && d.videos.results || []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const trailer = vids.find((v) => v.type === 'Trailer' && v.iso_639_1 === lang2()) || vids.find((v) => v.type === 'Trailer') || vids[0];
  let certification = null;
  if (type === 'show') {
    const c = ((d.content_ratings && d.content_ratings.results) || []).find((r) => r.iso_3166_1 === region());
    certification = c ? c.rating : null;
  } else {
    const c = ((d.release_dates && d.release_dates.results) || []).find((r) => r.iso_3166_1 === region());
    certification = c ? (c.release_dates || []).map((x) => x.certification).find(Boolean) || null : null;
  }
  const out = {
    ...card,
    tagline: d.tagline || null,
    genres: (d.genres || []).map((g) => g.name),
    runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map((c) => c.name),
    people: ((d.credits && d.credits.cast) || []).slice(0, 14).map((c) => ({ id: c.id, name: c.name, character: c.character,
      photo: c.profile_path ? IMG + 'w185' + c.profile_path : null })),
    creators: type === 'show' ? (d.created_by || []).map((c) => c.name)
      : ((d.credits && d.credits.crew) || []).filter((c) => c.job === 'Director').map((c) => c.name),
    network: type === 'show' ? ((d.networks || [])[0] || {}).name || null : ((d.production_companies || [])[0] || {}).name || null,
    certification,
    statusCode: d.status || null,   // "Returning Series", "Ended", "Released"… (translated on the TV)
    counts: type === 'show' ? { seasons: d.number_of_seasons, episodes: d.number_of_episodes } : null,
    nextEpisode: d.next_episode_to_air ? { date: d.next_episode_to_air.air_date, season: d.next_episode_to_air.season_number,
      episode: d.next_episode_to_air.episode_number, name: d.next_episode_to_air.name } : null,
    originalTitle: (d.original_name || d.original_title) !== (d.name || d.title) ? (d.original_name || d.original_title) : null,
    budget: d.budget || null, revenue: d.revenue || null,
    trailerYouTubeId: trailer ? trailer.key : null, trailerName: trailer ? trailer.name : null,
    recommendations: ((d.recommendations && d.recommendations.results) || []).filter((r) => r.backdrop_path).slice(0, 12).map((r) => ({
      type: r.media_type === 'tv' ? 'show' : 'movie', tmdb: r.id, title: r.title || r.name,
      year: (r.release_date || r.first_air_date || '').slice(0, 4), thumb: IMG + 'w780' + r.backdrop_path,
      backdrop: IMG + 'w1280' + r.backdrop_path, overview: r.overview, rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null })),
    ratings: { tmdb: card.rating, ...(await omdbRatings(card.imdb).catch(() => null) || {}) },
    seasons: type === 'show' ? (d.seasons || []).filter((s) => s.season_number > 0)
      .map((s) => ({ number: s.season_number, episodes: s.episode_count, name: s.name })) : undefined,
  };
  if (type === 'show' && card.arrId) {
    const s = await arr('sonarr', `/api/v3/series/${card.arrId}`);
    const byNum = new Map((s.seasons || []).map((x) => [x.seasonNumber, x.statistics || {}]));
    out.seasons = out.seasons.map((x) => ({ ...x, have: (byNum.get(x.number) || {}).episodeFileCount || 0 }));
    out.subtitlesMissing = await bazarrMissing('series', card.arrId);
  } else if (type === 'movie' && card.arrId) {
    out.subtitlesMissing = await bazarrMissing('movies', card.arrId);
  }
  return out;
}

async function bazarrMissing(kind, arrId) {
  if (!has('bazarr')) return null;
  try {
    const p = kind === 'series' ? `/api/series?seriesid[]=${arrId}` : `/api/movies?radarrid[]=${arrId}`;
    const r = await getJSON(C().bazarr.url + p, { headers: { 'X-API-KEY': C().bazarr.apiKey }, timeout: 6000 });
    const x = (r.data || [])[0]; if (!x) return null;
    return kind === 'series' ? (x.episodeMissingCount || 0) : ((x.missing_subtitles || []).map((s) => s.name || s.code2));
  } catch { return null; }
}

// ── add / releases / grab ───────────────────────────────────────────────────
async function pickProfile(svc) {
  const preferred = C()[svc].qualityProfile;
  const profiles = await arr(svc, '/api/v3/qualityprofile');
  return (profiles.find((p) => preferred && p.name === preferred) || profiles.find((p) => /1080/.test(p.name)) || profiles[0]).id;
}

async function add({ type, tmdb: tmdbId }) {
  const card = await cardFromTmdb(type, tmdbId);
  cache.delete('library');
  if (type === 'show') {
    if (!card.tvdb) throw new HttpError(422, 'This series has no TVDB id; Sonarr cannot add it', 'no_tvdb');
    const [found] = await arr('sonarr', `/api/v3/series/lookup?term=tvdb:${card.tvdb}`);
    if (!found) throw new HttpError(404, 'Sonarr could not find this series');
    if (found.id) return { ok: true, already: true, arrId: found.id };
    const [root] = await arr('sonarr', '/api/v3/rootfolder');
    const s = await arr('sonarr', '/api/v3/series', { method: 'POST', body: JSON.stringify({ ...found, qualityProfileId: await pickProfile('sonarr'),
      rootFolderPath: root.path, monitored: true, seasonFolder: true, addOptions: { monitor: 'all', searchForMissingEpisodes: true } }) });
    log('added series', s.title); return { ok: true, arrId: s.id };
  }
  const [found] = await arr('radarr', `/api/v3/movie/lookup?term=tmdb:${tmdbId}`);
  if (!found) throw new HttpError(404, 'Radarr could not find this movie');
  if (found.id) return { ok: true, already: true, arrId: found.id };
  const [root] = await arr('radarr', '/api/v3/rootfolder');
  const m = await arr('radarr', '/api/v3/movie', { method: 'POST', body: JSON.stringify({ ...found, qualityProfileId: await pickProfile('radarr'),
    rootFolderPath: root.path, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: true } }) });
  log('added movie', m.title); return { ok: true, arrId: m.id };
}

// Interactive search: Sonarr/Radarr query every indexer Prowlarr syncs to them.
async function releases(type, tmdbId, seasonN, episodeId) {
  const card = (await withStatus([await cardFromTmdb(type, tmdbId)]))[0];
  if (!card.arrId) throw new HttpError(409, 'Add it to the library first', 'not_in_library');
  const svc = type === 'show' ? 'sonarr' : 'radarr';
  const p = type === 'show' ? (episodeId ? `/api/v3/release?episodeId=${Number(episodeId)}` : `/api/v3/release?seriesId=${card.arrId}&seasonNumber=${Number(seasonN) || 1}`)
                            : `/api/v3/release?movieId=${card.arrId}`;
  const list = await arr(svc, p, { timeout: 90000 });
  return {
    items: list.map((r) => ({
      guid: r.guid, indexerId: r.indexerId, indexer: r.indexer, title: r.title,
      size: r.size, seeders: r.seeders, leechers: r.leechers, quality: r.quality && r.quality.quality && r.quality.quality.name,
      age: r.ageHours != null ? r.ageHours : (r.age != null ? r.age * 24 : null),
      languages: (r.languages || []).map((l) => l.name), score: r.customFormatScore,
      approved: r.approved, rejections: r.rejections || [], fullSeason: !!r.fullSeason,
    })).sort((a, b) => (b.approved - a.approved) || ((b.seeders || 0) - (a.seeders || 0))).slice(0, 60),
  };
}

async function grab({ type, guid, indexerId }) {
  await arr(type === 'show' ? 'sonarr' : 'radarr', '/api/v3/release', { method: 'POST', body: JSON.stringify({ guid, indexerId }) });
  cache.delete('library');
  return { ok: true };
}

// ── Deluge Web JSON-RPC (cookie session) ────────────────────────────────────
let delugeCookie = null, rpcId = 0;
async function delugeRpc(method, params) {
  const r = await fetch(need(C().deluge.url, 'Deluge') + '/json', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(delugeCookie ? { Cookie: delugeCookie } : {}) },
    body: JSON.stringify({ method, params, id: ++rpcId }),
  });
  const c = r.headers.get('set-cookie'); if (c) delugeCookie = c.split(';')[0];
  return r.json();
}
async function deluge(method, params = []) {
  let j = await delugeRpc(method, params);
  if (j.error && /not authenticated/i.test(j.error.message || '')) {
    delugeCookie = null;
    const login = await delugeRpc('auth.login', [need(C().deluge.password, 'Deluge password')]);
    if (!login.result) throw new HttpError(502, 'Deluge rejected the password', 'bad_password');
    j = await delugeRpc(method, params);
  }
  if (j.error) throw new HttpError(502, 'Deluge: ' + j.error.message);
  return j.result;
}
async function delugeEnsureConnected() {
  if (await deluge('web.connected')) return;
  const hosts = await deluge('web.get_hosts');
  if (hosts && hosts[0]) await deluge('web.connect', [hosts[0][0]]);
}

async function downloads() {
  const out = { torrents: [], queue: [], errors: [] };
  if (C().deluge.url) {
    try {
      await delugeEnsureConnected();
      const ui = await deluge('web.update_ui', [['name', 'progress', 'state', 'download_payload_rate', 'upload_payload_rate', 'eta', 'total_size', 'label', 'num_seeds', 'time_added'], {}]);
      out.torrents = Object.entries(ui.torrents || {}).map(([hash, t]) => ({ hash, ...t }))
        .sort((a, b) => (a.state === 'Downloading' ? -1 : 0) - (b.state === 'Downloading' ? -1 : 0) || b.time_added - a.time_added);
      out.speed = { down: ui.stats && ui.stats.download_rate, up: ui.stats && ui.stats.upload_rate };   // external_ip intentionally dropped
    } catch (e) { out.errors.push(e.message); }
  }
  for (const svc of ['sonarr', 'radarr']) {
    if (!has(svc)) continue;
    try {
      const q = await arr(svc, `/api/v3/queue?pageSize=100&include${svc === 'sonarr' ? 'Series=true&includeEpisode=true' : 'Movie=true'}`);
      out.queue.push(...q.records.map((r) => ({
        svc, title: svc === 'sonarr' ? (r.series && r.series.title) : (r.movie && r.movie.title),
        season: r.episode ? r.episode.seasonNumber : null, episode: r.episode ? r.episode.episodeNumber : null,
        status: r.trackedDownloadState || r.status, size: r.size, left: r.sizeleft, timeleft: r.timeleft,
        messages: (r.statusMessages || []).flatMap((m) => m.messages || []).slice(0, 2),
      })));
    } catch (e) { out.errors.push(e.message); }
  }
  return out;
}

// ── torrent client (Deluge) ─────────────────────────────────────────────────
const LIST_FIELDS = ['name', 'state', 'progress', 'total_wanted', 'total_done', 'download_payload_rate', 'upload_payload_rate', 'eta',
  'num_seeds', 'total_seeds', 'num_peers', 'total_peers', 'ratio', 'label', 'time_added', 'queue', 'message', 'tracker_host', 'max_download_speed'];
const isHash = (h) => /^[a-f0-9]{40}$/i.test(h || '');

function torrentRow(hash, t) {
  return { hash, name: t.name, state: t.state, progress: Math.round((t.progress || 0) * 10) / 10, size: t.total_wanted, done: t.total_done,
    down: t.download_payload_rate || 0, up: t.upload_payload_rate || 0, eta: t.eta > 0 ? t.eta : null,
    seeds: t.num_seeds, seedsTotal: t.total_seeds, peers: t.num_peers, peersTotal: t.total_peers, ratio: t.ratio,
    label: t.label || null, added: t.time_added, queue: t.queue, message: t.message !== 'OK' ? t.message : null,
    tracker: t.tracker_host || null, limitDown: t.max_download_speed };
}

async function torrents() {
  need(C().deluge.url, 'Deluge');
  await delugeEnsureConnected();
  const ui = await deluge('web.update_ui', [LIST_FIELDS, {}]);
  const s = ui.stats || {};
  // external_ip is deliberately not passed on.
  return {
    stats: { down: s.download_rate || 0, up: s.upload_rate || 0, connections: s.num_connections, dht: s.dht_nodes,
             freeSpace: s.free_space, limitDown: s.max_download, limitUp: s.max_upload },
    paused: Object.values(ui.torrents || {}).every((t) => t.state === 'Paused') && Object.keys(ui.torrents || {}).length > 0,
    torrents: Object.entries(ui.torrents || {}).map(([h, t]) => torrentRow(h, t))
      .sort((a, b) => (b.state === 'Downloading') - (a.state === 'Downloading') || (b.added || 0) - (a.added || 0)),
  };
}

async function torrentDetail(hash) {
  if (!isHash(hash)) throw new HttpError(400, 'Invalid torrent id');
  await delugeEnsureConnected();
  const t = await deluge('web.get_torrent_status', [hash, LIST_FIELDS.concat(['total_uploaded', 'all_time_download', 'seeding_time', 'active_time',
    'completed_time', 'num_files', 'files', 'file_progress', 'file_priorities', 'peers', 'max_upload_speed', 'is_finished'])]);
  if (!t || !t.name) throw new HttpError(404, 'Torrent not found');
  return {
    ...torrentRow(hash, t),
    uploaded: t.total_uploaded, downloaded: t.all_time_download, seedingTime: t.seeding_time, activeTime: t.active_time,
    completed: t.completed_time > 0 ? t.completed_time : null, limitUp: t.max_upload_speed, finished: t.is_finished,
    files: (t.files || []).map((f, i) => ({ path: f.path, size: f.size, progress: Math.round(((t.file_progress || [])[i] || 0) * 1000) / 10,
      skipped: (t.file_priorities || [])[i] === 0 })).sort((a, b) => b.size - a.size),
    // peers: client, country and speeds only (no IP addresses)
    peers: (t.peers || []).map((p) => ({ client: p.client, country: p.country, progress: Math.round((p.progress || 0) * 1000) / 10,
      down: p.down_speed, up: p.up_speed, seed: !!p.seed })).sort((a, b) => (b.down + b.up) - (a.down + a.up)),
  };
}

async function torrentAction(hash, action, body) {
  if (!isHash(hash)) throw new HttpError(400, 'Invalid torrent id');
  await delugeEnsureConnected();
  const ids = [hash];
  switch (action) {
    case 'pause': await deluge('core.pause_torrents', [ids]); break;
    case 'resume': await deluge('core.resume_torrents', [ids]); break;
    case 'recheck': await deluge('core.force_recheck', [ids]); break;
    case 'reannounce': await deluge('core.force_reannounce', [ids]); break;
    case 'top': case 'up': case 'down': case 'bottom': await deluge('core.queue_' + action, [ids]); break;
    case 'limit': await deluge('core.set_torrent_options', [ids, { max_download_speed: Number(body.down) > 0 ? Number(body.down) : -1 }]); break;
    case 'remove': await deluge('core.remove_torrent', [hash, !!body.withData]); log('removed torrent', hash, body.withData ? '(with data)' : ''); break;
    default: throw new HttpError(400, 'Unsupported action');
  }
  return { ok: true };
}

async function sessionAction({ action, down }) {
  await delugeEnsureConnected();
  if (action === 'pause') await deluge('core.pause_session');
  else if (action === 'resume') await deluge('core.resume_session');
  else if (action === 'limit') await deluge('core.set_config', [{ max_download_speed: Number(down) > 0 ? Number(down) : -1 }]);
  else throw new HttpError(400, 'Unsupported action');
  return { ok: true };
}

async function upcoming() {
  const qs = `start=${new Date().toISOString()}&end=${new Date(Date.now() + 14 * 864e5).toISOString()}`;
  const [eps, movies] = await Promise.all([
    has('sonarr') ? arr('sonarr', `/api/v3/calendar?${qs}&includeSeries=true`).catch(() => []) : [],
    has('radarr') ? arr('radarr', `/api/v3/calendar?${qs}`).catch(() => []) : [],
  ]);
  const poster = (imgs) => { const p = (imgs || []).find((i) => i.coverType === 'poster'); return p ? (p.remoteUrl || null) : null; };
  const items = [
    ...eps.map((e) => ({ type: 'show', tmdb: e.series && e.series.tmdbId, title: e.series && e.series.title,
      season: e.seasonNumber, episode: e.episodeNumber, episodeTitle: e.title || '', date: e.airDateUtc, hasFile: e.hasFile, poster: poster(e.series && e.series.images) })),
    ...movies.map((m) => ({ type: 'movie', tmdb: m.tmdbId, title: m.title,
      release: m.digitalRelease ? 'digital' : (m.physicalRelease ? 'physical' : 'cinema'),
      date: m.digitalRelease || m.physicalRelease || m.inCinemas, hasFile: m.hasFile, poster: poster(m.images) })),
  ].filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
  return { items };
}

// ── season screen ───────────────────────────────────────────────────────────
async function seriesArrId(tmdbId) {
  const card = (await withStatus([await cardFromTmdb('show', tmdbId)]))[0];
  if (!card.arrId) throw new HttpError(409, 'Series is not in the library', 'not_in_library');
  return card.arrId;
}

async function tmdbSeason(tmdbId, n) {
  return cached(`tmdb:${lang()}:season:${tmdbId}:${n}`, 12 * 3600e3, async () => {
    const loc = await tmdb(`/tv/${tmdbId}/season/${n}`, { language: lang() }).catch(() => ({ episodes: [] }));
    if (lang() !== 'en-US' && (loc.episodes || []).some((e) => !e.overview)) {
      const en = await tmdb(`/tv/${tmdbId}/season/${n}`, { language: 'en-US' }).catch(() => ({ episodes: [] }));
      const byNum = new Map((en.episodes || []).map((e) => [e.episode_number, e]));
      for (const e of loc.episodes || []) { const x = byNum.get(e.episode_number); if (x && !e.overview) e.overview = x.overview; }
    }
    return new Map((loc.episodes || []).map((e) => [e.episode_number, e]));
  });
}

async function season(tmdbId, n) {
  const sid = await seriesArrId(tmdbId);
  const [eps, queue, tm, subs] = await Promise.all([
    arr('sonarr', `/api/v3/episode?seriesId=${sid}&seasonNumber=${n}&includeEpisodeFile=true`),
    arr('sonarr', `/api/v3/queue?pageSize=500&seriesIds=${sid}`).catch(() => ({ records: [] })),
    tmdbSeason(tmdbId, n),
    has('bazarr') ? getJSON(`${C().bazarr.url}/api/episodes?seriesid[]=${sid}`, { headers: { 'X-API-KEY': C().bazarr.apiKey }, timeout: 8000 })
      .then((r) => new Map((r.data || []).map((e) => [e.sonarrEpisodeId, e]))).catch(() => null) : null,
  ]);
  const q = new Map(queue.records.filter((r) => r.episodeId).map((r) => [r.episodeId, r]));
  const now = Date.now();
  const episodes = eps.sort((a, b) => a.episodeNumber - b.episodeNumber).map((e) => {
    const t = tm.get(e.episodeNumber) || {}, dl = q.get(e.id), f = e.episodeFile, b = subs && subs.get(e.id);
    const aired = e.airDateUtc ? Date.parse(e.airDateUtc) <= now : false;
    return {
      id: e.id, number: e.episodeNumber, title: t.name || e.title, overview: t.overview || e.overview || '',
      airDate: e.airDateUtc || null, runtime: t.runtime || e.runtime || null, monitored: e.monitored,
      still: t.still_path ? IMG + 'w780' + t.still_path : null,
      status: e.hasFile ? 'downloaded' : dl ? (/importBlocked|importPending|failedPending/.test(dl.trackedDownloadState || '') ? 'blocked' : 'downloading')
        : !aired ? 'unaired' : e.monitored ? 'missing' : 'unmonitored',
      blockReason: dl ? reasonCode(((dl.statusMessages || []).flatMap((m) => m.messages || []))[0] || '') : null,
      blockMessage: dl ? (((dl.statusMessages || []).flatMap((m) => m.messages || []))[0] || null) : null,
      downloadId: dl ? dl.downloadId : null,
      progress: dl && dl.size ? Math.round(100 * (1 - dl.sizeleft / dl.size)) : null,
      downloadState: dl ? (dl.trackedDownloadState || dl.status) : null, timeleft: dl ? dl.timeleft : null,
      file: f ? { quality: f.quality && f.quality.quality && f.quality.quality.name, size: f.size, releaseGroup: f.releaseGroup || null,
                  audio: (f.languages || []).map((l) => l.name), video: f.mediaInfo ? `${f.mediaInfo.videoCodec || ''} ${f.mediaInfo.resolution || ''}`.trim() : null } : null,
      subtitles: b ? (b.subtitles || []).map((s) => ({ name: s.name, code: s.code2, embedded: !s.path })) : null,
      missingSubtitles: b ? (b.missing_subtitles || []).map((s) => ({ name: s.name, code: s.code2, forced: !!s.forced, hi: !!s.hi })) : null,
    };
  });
  return { seriesId: sid, season: Number(n), episodes };
}

async function episodeSearch({ episodeId }) {
  const c = await arr('sonarr', '/api/v3/command', { method: 'POST', body: JSON.stringify({ name: 'EpisodeSearch', episodeIds: [Number(episodeId)] }) });
  return { ok: true, commandId: c.id };
}
async function seasonSearch({ seriesId, season: n }) {
  const c = await arr('sonarr', '/api/v3/command', { method: 'POST', body: JSON.stringify({ name: 'SeasonSearch', seriesId: Number(seriesId), seasonNumber: Number(n) }) });
  return { ok: true, commandId: c.id };
}

// ── subtitles (Bazarr): per-episode search, provider search, download, sync ─
const bz = (p, opts = {}) => getJSON(need(C().bazarr.url, 'Bazarr') + p, { ...opts, headers: { 'X-API-KEY': need(C().bazarr.apiKey, 'Bazarr'), ...(opts.headers || {}) }, timeout: opts.timeout || 120000 });
async function bzSend(method, p, params) {
  const r = await fetch(need(C().bazarr.url, 'Bazarr') + p + '?' + new URLSearchParams(params), {
    method, headers: { 'X-API-KEY': need(C().bazarr.apiKey, 'Bazarr') }, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `Bazarr ${r.status}${/^\s*</.test(text) ? '' : ': ' + text.slice(0, 160)}`);
  return text;
}

async function episodeSubtitles({ seriesId, episodeId }) {
  const r = await bz(`/api/episodes?episodeid[]=${episodeId}`);
  const missing = ((r.data || [])[0] || {}).missing_subtitles || [];
  if (!missing.length) return { ok: true, searched: [], nothingMissing: true };
  const done = [];
  for (const m of missing) {
    const res = await fetch(`${C().bazarr.url}/api/episodes/subtitles?seriesid=${seriesId}&episodeid=${episodeId}&language=${m.code2}&forced=${!!m.forced}&hi=${!!m.hi}`,
      { method: 'PATCH', headers: { 'X-API-KEY': C().bazarr.apiKey }, signal: AbortSignal.timeout(120000) });
    done.push({ language: m.name, ok: res.ok });
  }
  return { ok: done.some((d) => d.ok), searched: done };
}

// The player identifies what it plays by TMDB id (+ season/episode); map that to Sonarr/Radarr ids.
async function resolveArr(type, tmdbId, seasonN, episodeN) {
  const card = (await withStatus([await cardFromTmdb(type, Number(tmdbId))]))[0];
  if (!card.arrId) throw new HttpError(409, type === 'show' ? 'Series is not in Sonarr' : 'Movie is not in Radarr', 'not_in_library');
  if (type === 'movie') return { kind: 'movie', radarrId: card.arrId };
  const ep = (await arr('sonarr', `/api/v3/episode?seriesId=${card.arrId}&seasonNumber=${Number(seasonN)}`)).find((e) => e.episodeNumber === Number(episodeN));
  if (!ep) throw new HttpError(404, 'Episode not found in Sonarr');
  return { kind: 'episode', seriesId: card.arrId, episodeId: ep.id };
}

async function subsState(q) {
  const t = await resolveArr(q.type, q.tmdb, q.season, q.episode);
  const r = t.kind === 'episode' ? await bz(`/api/episodes?episodeid[]=${t.episodeId}`) : await bz(`/api/movies?radarrid[]=${t.radarrId}`);
  const x = (r.data || [])[0] || {};
  return { target: t, subtitles: (x.subtitles || []).map((s) => ({ name: s.name, code: s.code2, path: s.path, forced: !!s.forced, hi: !!s.hi, embedded: !s.path })),
           missing: (x.missing_subtitles || []).map((s) => ({ name: s.name, code: s.code2 })) };
}

async function subsCandidates(q) {
  const t = await resolveArr(q.type, q.tmdb, q.season, q.episode);
  const r = t.kind === 'episode' ? await bz(`/api/providers/episodes?episodeid=${t.episodeId}`) : await bz(`/api/providers/movies?radarrid=${t.radarrId}`);
  return { target: t, items: (r.data || []).map((c, i) => ({
    i, provider: c.provider, language: (c.language && (c.language.name || c.language)) || c.language,
    languageCode: c.language && c.language.code2, score: c.score, hi: !!c.hearing_impaired, forced: !!c.forced,
    release: [].concat(c.release_info || []).join(' / ').slice(0, 140), original_format: c.original_format, subtitle: c.subtitle,
  })).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 40) };
}

async function subsDownload(body) {
  const t = await resolveArr(body.type, body.tmdb, body.season, body.episode);
  const c = body.candidate || {};
  const common = { hi: String(!!c.hi), forced: String(!!c.forced), original_format: String(!!c.original_format), provider: c.provider, subtitle: c.subtitle };
  if (t.kind === 'episode') await bzSend('POST', '/api/providers/episodes', { seriesid: t.seriesId, episodeid: t.episodeId, ...common });
  else await bzSend('POST', '/api/providers/movies', { radarrid: t.radarrId, ...common });
  return { ok: true };
}

async function subsSync(body) {
  const st = await subsState(body);
  const sub = st.subtitles.find((s) => s.code === body.language && s.path);
  if (!sub) throw new HttpError(404, 'Only external subtitle files can be synced', 'external_only');
  const t = st.target;
  await bzSend('PATCH', '/api/subtitles', { action: 'sync', language: sub.code, path: sub.path, type: t.kind === 'episode' ? 'episode' : 'movie',
    id: t.kind === 'episode' ? t.episodeId : t.radarrId, forced: String(sub.forced), hi: String(sub.hi) });
  return { ok: true };
}

// ── library sync: import finished downloads, surface blocked imports ───────
async function syncNow() {
  const out = {};
  for (const svc of ['sonarr', 'radarr']) {
    if (!has(svc)) continue;
    const c = await arr(svc, '/api/v3/command', { method: 'POST', body: JSON.stringify({ name: 'RefreshMonitoredDownloads' }) }).catch((e) => ({ error: e.message }));
    out[svc] = c.error ? c.error : 'ok';
  }
  clearCaches();
  return { ok: true, ...out };
}

function reasonCode(msg) {
  if (/Destination already exists/i.test(msg)) return 'destination_exists';
  if (/Manual Import required/i.test(msg)) return 'manual_import';
  if (/No files found are eligible/i.test(msg)) return 'no_eligible_files';
  if (/Not an upgrade/i.test(msg)) return 'not_upgrade';
  if (/sample/i.test(msg)) return 'sample_only';
  return 'other';
}

async function attention() {
  const items = [];
  for (const svc of ['sonarr', 'radarr']) {
    if (!has(svc)) continue;
    const q = await arr(svc, `/api/v3/queue?pageSize=500&include${svc === 'sonarr' ? 'Series=true&includeEpisode=true' : 'Movie=true'}`).catch(() => ({ records: [] }));
    const groups = new Map();
    for (const r of q.records.filter((x) => ['importBlocked', 'importPending', 'failedPending'].includes(x.trackedDownloadState) || x.trackedDownloadStatus === 'error')) {
      const k = r.downloadId || r.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r);
    }
    for (const [downloadId, recs] of groups) {
      const r = recs[0];
      const msg = recs.flatMap((x) => (x.statusMessages || []).flatMap((m) => m.messages || []))[0] || r.errorMessage || r.trackedDownloadState;
      const reason = reasonCode(msg);
      let action = null;
      if (svc === 'sonarr' && (reason === 'destination_exists' || reason === 'not_upgrade')) {
        if (recs.every((x) => x.episode && x.episode.hasFile)) action = 'clear';
        else if (reason === 'destination_exists') action = 'rescan';
      } else if (svc === 'radarr' && reason === 'manual_import') action = 'import';
      else if (svc === 'radarr' && (reason === 'destination_exists' || reason === 'not_upgrade') && r.movie && r.movie.hasFile) action = 'clear';
      items.push({ svc, downloadId, queueIds: recs.map((x) => x.id), title: r.title,
        name: svc === 'sonarr' ? (r.series ? r.series.title : '') : (r.movie ? r.movie.title : ''), episodes: svc === 'sonarr' ? recs.length : null,
        reason, raw: msg, action, movieId: r.movieId || null, seriesId: r.seriesId || null });
    }
  }
  return { items };
}

async function resolve({ svc, action, queueIds, downloadId, movieId, seriesId }) {
  if (!['sonarr', 'radarr'].includes(svc)) throw new HttpError(400, 'Invalid service');
  if (action === 'clear') {
    // Stop tracking the download only: files stay, the torrent keeps seeding.
    await arr(svc, '/api/v3/queue/bulk?removeFromClient=false&blocklist=false&skipRedownload=true', { method: 'DELETE', body: JSON.stringify({ ids: queueIds }) });
    return { ok: true };
  }
  if (action === 'rescan' && svc === 'sonarr') {
    // Sonarr re-reads the series folder and registers files already there; nothing is moved or deleted.
    await arr('sonarr', '/api/v3/command', { method: 'POST', body: JSON.stringify({ name: 'RescanSeries', seriesId: Number(seriesId) }) });
    cache.delete('library');
    return { ok: true };
  }
  if (action === 'import' && svc === 'radarr') {
    const files = await arr('radarr', `/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=false`);
    const pick = files.filter((f) => !/sample/i.test(f.path)).map((f) => ({ path: f.path, movieId: (f.movie && f.movie.id) || movieId, downloadId,
      quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup, indexerFlags: f.indexerFlags || 0 }));
    if (!pick.length) throw new HttpError(404, 'No files to import');
    await arr('radarr', '/api/v3/command', { method: 'POST', body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: pick }) });
    cache.delete('library');
    return { ok: true, files: pick.length };
  }
  throw new HttpError(400, 'Unsupported action');
}

// ── person page ─────────────────────────────────────────────────────────────
async function person(id) {
  return cached(`person:${lang()}:${id}`, 24 * 3600e3, async () => {
    const p = await tmdb(`/person/${id}`, { language: lang(), append_to_response: 'combined_credits,external_ids' });
    if (!p.biography && lang() !== 'en-US') { const en = await tmdb(`/person/${id}`, { language: 'en-US' }).catch(() => ({})); p.biography = en.biography || ''; }
    const seen = new Set();
    const credits = ((p.combined_credits && p.combined_credits.cast) || [])
      .concat(((p.combined_credits && p.combined_credits.crew) || []).filter((c) => c.job === 'Director'))
      .filter((c) => (c.media_type === 'movie' || c.media_type === 'tv') && c.backdrop_path && !(c.genre_ids || []).some((g) => g === 10767 || g === 10763))
      .filter((c) => { const k = c.media_type + c.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((c) => ({ type: c.media_type === 'tv' ? 'show' : 'movie', tmdb: c.id, title: c.title || c.name,
        year: (c.release_date || c.first_air_date || '').slice(0, 4), thumb: IMG + 'w780' + c.backdrop_path, backdrop: IMG + 'w1280' + c.backdrop_path,
        poster: c.poster_path ? IMG + 'w342' + c.poster_path : null, overview: c.overview,
        rating: c.vote_average ? Math.round(c.vote_average * 10) / 10 : null,
        badge: c.character || null, badgeKey: !c.character && c.job === 'Director' ? 'role.director' : null, votes: c.vote_count || 0 }));
    const born = p.birthday ? new Date(p.birthday) : null, died = p.deathday ? new Date(p.deathday) : null;
    return {
      id: p.id, name: p.name, photo: p.profile_path ? IMG + 'h632' + p.profile_path : null, biography: p.biography || '',
      department: p.known_for_department || null, birthday: p.birthday, deathday: p.deathday,
      age: born ? Math.floor(((died || new Date()) - born) / (365.25 * 864e5)) : null, place: p.place_of_birth || null, count: credits.length,
      rows: [{ id: 'known', titleKey: 'row.knownFor', items: await withStatus(credits.slice().sort((a, b) => b.votes - a.votes).slice(0, 15)) },
             { id: 'recent', titleKey: 'row.filmography', items: await withStatus(credits.filter((c) => c.year).sort((a, b) => b.year.localeCompare(a.year)).slice(0, 25)) }]
        .filter((r) => r.items.length),
    };
  });
}


// ── trailers ────────────────────────────────────────────────────────────────
// YouTube refuses embeds from pages without a real origin (the TV app runs from local files),
// so the embed is served from this server. Fallback: open it in the TV's YouTube app via DIAL.
function trailerPage(id) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}</style></head>
<body><iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1&controls=0"
allow="autoplay; encrypted-media; fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`;
}
async function trailerOnTv(req, { id, tvIp }) {
  if (!/^[\w-]{6,20}$/.test(id || '')) throw new HttpError(400, 'Invalid video id');
  const ip = (tvIp || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new HttpError(400, 'Could not tell the TV address');
  const r = await fetch(`http://${ip}:8080/ws/apps/YouTube`, { method: 'POST', body: `v=${id}`,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }, signal: AbortSignal.timeout(8000) });
  if (r.status >= 400) throw new HttpError(502, `TV refused to open YouTube (${r.status})`);
  return { ok: true };
}

// ── settings, status, public config ─────────────────────────────────────────
function checkPin(req) {
  const pin = C().security.pin;
  if (pin && req.headers['x-cinema-pin'] !== pin) throw new HttpError(401, 'PIN required', 'pin_required');
}

async function testService(name) {
  const c = C()[name];
  const t0 = Date.now();
  const ok = (extra) => ({ state: 'ok', ms: Date.now() - t0, ...extra });
  try {
    switch (name) {
      case 'jellyfin': { if (!c.url) return { state: 'off' }; const r = await getJSON(c.url + '/System/Info/Public', { timeout: 6000 }); return ok({ version: r.Version, name: r.ServerName }); }
      case 'sonarr': case 'radarr': { if (!c.url || !c.apiKey) return { state: 'off' }; const r = await arr(name, '/api/v3/system/status', { timeout: 6000 }); return ok({ version: r.version }); }
      case 'prowlarr': { if (!c.url || !c.apiKey) return { state: 'off' }; const r = await getJSON(c.url + '/api/v1/system/status', { headers: { 'X-Api-Key': c.apiKey }, timeout: 6000 }); return ok({ version: r.version }); }
      case 'bazarr': { if (!c.url || !c.apiKey) return { state: 'off' }; const r = await getJSON(c.url + '/api/system/status', { headers: { 'X-API-KEY': c.apiKey }, timeout: 6000 }); return ok({ version: r.data && r.data.bazarr_version }); }
      case 'deluge': { if (!c.url || !c.password) return { state: 'off' }; delugeCookie = null; await deluge('web.connected'); return ok(); }
      case 'tmdb': { if (!c.token) return { state: 'off' }; await getJSON('https://api.themoviedb.org/3/configuration', { headers: { Authorization: 'Bearer ' + c.token }, timeout: 6000 }); return ok(); }
      case 'trakt': { if (!c.clientId) return { state: 'off' }; await trakt('/movies/trending?limit=1'); return ok(); }
      case 'omdb': { if (!c.apiKey) return { state: 'off' }; const r = await getJSON(`https://www.omdbapi.com/?i=tt0111161&apikey=${c.apiKey}`, { timeout: 6000 }); if (r.Response !== 'True') throw new Error(r.Error || 'invalid key'); return ok(); }
      default: return { state: 'off' };
    }
  } catch (e) { return { state: 'error', message: e.message.slice(0, 160) }; }
}
const SERVICES = ['jellyfin', 'sonarr', 'radarr', 'prowlarr', 'bazarr', 'deluge', 'tmdb', 'trakt', 'omdb'];
async function status() {
  const results = await Promise.all(SERVICES.map((s) => testService(s)));
  return { services: Object.fromEntries(SERVICES.map((s, i) => [s, results[i]])) };
}

async function options() {
  const prof = async (svc) => (has(svc) ? (await arr(svc, '/api/v3/qualityprofile').catch(() => [])).map((p) => p.name) : []);
  return { sonarrProfiles: await prof('sonarr'), radarrProfiles: await prof('radarr') };
}

function publicConfig() {
  const c = C();
  return { app: 'cinema', version: VERSION, jellyfinUrl: c.jellyfin.url || null, metadataLanguage: lang(), region: region(),
    pinRequired: !!c.security.pin, ready: !!c.tmdb.token };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new HttpError(400, 'Invalid JSON')); } });
  });
}
const body = (fn) => async (m, u, req) => fn(await readBody(req));
const routes = [
  ['GET', /^\/health$/, () => ({ ok: true, version: VERSION })],
  ['GET', /^\/api\/public$/, () => publicConfig()],
  ['GET', /^\/api\/settings$/, (m, u, req) => { checkPin(req); return { settings: config.masked(), pinRequired: !!C().security.pin }; }],
  ['PUT', /^\/api\/settings$/, async (m, u, req) => { checkPin(req); config.update(await readBody(req)); clearCaches(); delugeCookie = null; return { ok: true, settings: config.masked() }; }],
  ['GET', /^\/api\/settings\/status$/, () => status()],
  ['GET', /^\/api\/settings\/options$/, () => options()],
  ['GET', /^\/api\/home$/, () => home()],
  ['GET', /^\/api\/browse\/(show|movie)$/, (m) => browse(m[1])],
  ['GET', /^\/api\/search$/, (m, u) => search(u.searchParams.get('q'))],
  ['GET', /^\/api\/item\/(show|movie)\/(\d+)$/, (m) => item(m[1], Number(m[2]))],
  ['GET', /^\/api\/person\/(\d+)$/, (m) => person(Number(m[1]))],
  ['POST', /^\/api\/add$/, body(add)],
  ['GET', /^\/api\/releases\/(show|movie)\/(\d+)$/, (m, u) => releases(m[1], Number(m[2]), u.searchParams.get('season'), u.searchParams.get('episodeId'))],
  ['POST', /^\/api\/grab$/, body(grab)],
  ['GET', /^\/api\/season\/(\d+)\/(\d+)$/, (m) => season(Number(m[1]), Number(m[2]))],
  ['POST', /^\/api\/episode\/search$/, body(episodeSearch)],
  ['POST', /^\/api\/season\/search$/, body(seasonSearch)],
  ['POST', /^\/api\/episode\/subtitles$/, body(episodeSubtitles)],
  ['GET', /^\/api\/subs\/state$/, (m, u) => subsState(Object.fromEntries(u.searchParams))],
  ['GET', /^\/api\/subs\/candidates$/, (m, u) => subsCandidates(Object.fromEntries(u.searchParams))],
  ['POST', /^\/api\/subs\/download$/, body(subsDownload)],
  ['POST', /^\/api\/subs\/sync$/, body(subsSync)],
  ['GET', /^\/api\/downloads$/, () => downloads()],
  ['GET', /^\/api\/torrents$/, () => torrents()],
  ['POST', /^\/api\/torrents\/session$/, body(sessionAction)],
  ['GET', /^\/api\/torrent\/([a-fA-F0-9]{40})$/, (m) => torrentDetail(m[1])],
  ['POST', /^\/api\/torrent\/([a-fA-F0-9]{40})\/(\w+)$/, async (m, u, req) => torrentAction(m[1], m[2], await readBody(req))],
  ['GET', /^\/api\/upcoming$/, () => upcoming()],
  ['POST', /^\/api\/sync$/, () => syncNow()],
  ['GET', /^\/api\/sync\/attention$/, () => attention()],
  ['POST', /^\/api\/sync\/resolve$/, body(resolve)],
  ['POST', /^\/api\/trailer\/youtube$/, async (m, u, req) => trailerOnTv(req, await readBody(req))],
];

const WEB = path.join(__dirname, 'web');
http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Cinema-Pin', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const tm = req.method === 'GET' && u.pathname.match(/^\/trailer\/([\w-]{6,20})$/);
  if (tm) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); return res.end(trailerPage(tm[1])); }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/settings')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(WEB, 'settings.html')));
  }
  for (const [method, re, fn] of routes) {
    const m = u.pathname.match(re);
    if (m && req.method === method) {
      try {
        const out = JSON.stringify(await fn(m, u, req));
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(out);
      } catch (e) {
        if (e.status !== 401) log(req.method, u.pathname, e.message);
        res.writeHead(e.status || 500, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: e.message, code: e.code || null }));
      }
    }
  }
  res.writeHead(404, cors); res.end();
}).listen(PORT, '0.0.0.0', () => log(`Cinema ${VERSION} listening on :${PORT} (data: ${config.DATA_DIR})`));
