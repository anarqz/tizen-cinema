// Settings store. Precedence: built-in defaults < environment variables < data/config.json.
// data/config.json is written by the in-app Settings screen (and the /settings web page).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

// section -> field -> { env: [names...], secret?: bool, def?: value }
const SCHEMA = {
  jellyfin: { url: { env: ['JELLYFIN_URL'] } },
  sonarr: {
    url: { env: ['SONARR_URL'] }, apiKey: { env: ['SONARR_API_KEY'], secret: true },
    qualityProfile: { env: ['SONARR_QUALITY_PROFILE', 'SONARR_PROFILE'] },
  },
  radarr: {
    url: { env: ['RADARR_URL'] }, apiKey: { env: ['RADARR_API_KEY'], secret: true },
    qualityProfile: { env: ['RADARR_QUALITY_PROFILE'] },
  },
  prowlarr: { url: { env: ['PROWLARR_URL'] }, apiKey: { env: ['PROWLARR_API_KEY'], secret: true } },
  bazarr: { url: { env: ['BAZARR_URL'] }, apiKey: { env: ['BAZARR_API_KEY'], secret: true } },
  deluge: { url: { env: ['DELUGE_URL'] }, password: { env: ['DELUGE_PASSWORD'], secret: true } },
  tmdb: { token: { env: ['TMDB_TOKEN'], secret: true } },
  trakt: { clientId: { env: ['TRAKT_CLIENT_ID'], secret: true } },
  omdb: { apiKey: { env: ['OMDB_API_KEY', 'OMDB_KEY'], secret: true } },
  prefs: {
    metadataLanguage: { env: ['METADATA_LANGUAGE', 'LANG_META'], def: 'en-US' },
    region: { env: ['REGION'], def: 'US' },
  },
  security: { pin: { env: ['SETTINGS_PIN'], secret: true } },
};

function fromEnv() {
  const out = {};
  for (const [sec, fields] of Object.entries(SCHEMA)) {
    out[sec] = {};
    for (const [f, spec] of Object.entries(fields)) {
      const v = spec.env.map((n) => process.env[n]).find((x) => x != null && x !== '');
      out[sec][f] = v != null ? String(v) : (spec.def != null ? spec.def : '');
    }
  }
  return out;
}

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

let current = null;
function load() {
  const base = fromEnv(), file = readFile();
  for (const sec of Object.keys(SCHEMA)) {
    for (const f of Object.keys(SCHEMA[sec])) {
      if (file[sec] && typeof file[sec][f] === 'string') base[sec][f] = file[sec][f];
    }
  }
  // URLs: no trailing slash
  for (const sec of Object.keys(base)) if (base[sec].url) base[sec].url = base[sec].url.replace(/\/+$/, '');
  current = base;
  return current;
}

function get() { return current || load(); }

// Secrets are never sent back: { set, hint } instead of the value.
function masked() {
  const c = get(), out = {};
  for (const [sec, fields] of Object.entries(SCHEMA)) {
    out[sec] = {};
    for (const [f, spec] of Object.entries(fields)) {
      const v = c[sec][f];
      out[sec][f] = spec.secret ? { secret: true, set: !!v, hint: v ? '…' + v.slice(-4) : '' } : v;
    }
  }
  return out;
}

// patch: { section: { field: "new value" } }. Secrets: omit (or send null) to keep the current value.
function update(patch) {
  const file = readFile();
  for (const [sec, fields] of Object.entries(patch || {})) {
    if (!SCHEMA[sec] || typeof fields !== 'object') continue;
    for (const [f, v] of Object.entries(fields)) {
      if (!SCHEMA[sec][f] || v == null || typeof v !== 'string') continue;
      file[sec] = file[sec] || {};
      file[sec][f] = f === 'url' ? v.trim().replace(/\/+$/, '') : v.trim();
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  return load();
}

module.exports = { SCHEMA, get, load, masked, update, DATA_DIR };
