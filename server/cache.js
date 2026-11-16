// Two-level cache: memory + one JSON file per key under DATA_DIR/cache, so data from external
// services (TMDB, Trakt, OMDb) survives restarts. Expired entries are served immediately while a
// background refresh runs ("stale-while-revalidate"); only a missing entry makes a request wait.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function create(dataDir) {
  const DIR = path.join(dataDir, 'cache');
  fs.mkdirSync(DIR, { recursive: true });
  const mem = new Map();          // key -> { value, until, persist }
  const pending = new Map();      // key -> Promise
  const fileOf = (key) => path.join(DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');

  function read(key) {
    const hit = mem.get(key);
    if (hit) return hit;
    try {
      const e = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
      if (e && e.key === key) { const v = { value: e.value, until: e.until, persist: true }; mem.set(key, v); return v; }
    } catch { /* not on disk */ }
    return null;
  }
  function write(key, value, ttlMs, persist) {
    const e = { value, until: Date.now() + ttlMs, persist };
    mem.set(key, e);
    if (persist) {
      const f = fileOf(key);
      fs.writeFile(f + '.tmp', JSON.stringify({ key, until: e.until, value }), (err) => { if (!err) fs.rename(f + '.tmp', f, () => {}); });
    }
    return value;
  }
  function refresh(key, ttlMs, fn, persist) {
    if (pending.has(key)) return pending.get(key);
    const p = Promise.resolve().then(fn).then((v) => write(key, v, ttlMs, persist)).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  // get(key, ttlMs, fn, { persist = true, force = false })
  function get(key, ttlMs, fn, opts = {}) {
    const persist = opts.persist !== false;
    const hit = opts.force ? null : read(key);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
    if (hit) { refresh(key, ttlMs, fn, persist).catch(() => {}); return Promise.resolve(hit.value); }   // stale: serve now, refresh behind
    return refresh(key, ttlMs, fn, persist);
  }

  function del(key) { mem.delete(key); fs.unlink(fileOf(key), () => {}); }
  // Memory-only entries (live library state etc.) are dropped; with `all`, the disk cache too.
  function clear(all) {
    for (const [k, e] of mem) if (all || !e.persist) mem.delete(k);
    if (all) for (const f of fs.readdirSync(DIR)) fs.unlink(path.join(DIR, f), () => {});
  }
  function stats() {
    let files = 0, bytes = 0;
    for (const f of fs.readdirSync(DIR)) { try { bytes += fs.statSync(path.join(DIR, f)).size; files++; } catch { /* ignore */ } }
    return { memory: mem.size, files, bytes };
  }
  // Drop files that expired more than a week ago.
  function prune() {
    const cutoff = Date.now() - 7 * 864e5;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      try { const e = JSON.parse(fs.readFileSync(p, 'utf8')); if (!e.until || e.until < cutoff) fs.unlinkSync(p); } catch { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
  }
  return { get, del, clear, stats, prune };
}

module.exports = { create };
