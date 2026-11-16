// Trailers: download from YouTube with yt-dlp (+ ffmpeg to merge video and audio) into a small
// cache, then serve the MP4 with HTTP range support so the TV's own player can seek.
// yt-dlp and ffmpeg are taken from PATH, or downloaded once into DATA_DIR/bin.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const log = (...a) => console.log(new Date().toISOString(), '[trailers]', ...a);
const ID = /^[\w-]{6,20}$/;

function create(dataDir) {
  const BIN = path.join(dataDir, 'bin');
  const CACHE = path.join(dataDir, 'trailers');
  fs.mkdirSync(CACHE, { recursive: true });
  const jobs = new Map();
  let tools = null, toolsPending = null;

  const which = (name) => {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const musl = () => fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1');
  const arm = process.arch === 'arm64';

  async function download(url, dest, gunzip) {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`download failed (${r.status}) ${url}`);
    let buf = Buffer.from(await r.arrayBuffer());
    if (gunzip) buf = zlib.gunzipSync(buf);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', buf, { mode: 0o755 });
    fs.renameSync(dest + '.tmp', dest);
  }

  async function ensureTools() {
    if (tools) return tools;
    if (toolsPending) return toolsPending;
    toolsPending = (async () => {
      const local = (n) => (fs.existsSync(path.join(BIN, n)) ? path.join(BIN, n) : null);
      let ytdlp = process.env.YTDLP_PATH || local('yt-dlp') || which('yt-dlp');
      let ffmpeg = process.env.FFMPEG_PATH || local('ffmpeg') || which('ffmpeg');
      if (!ytdlp && process.platform === 'linux') {
        const asset = (musl() ? 'yt-dlp_musllinux' : 'yt-dlp_linux') + (arm ? '_aarch64' : '');
        log('downloading', asset);
        await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, path.join(BIN, 'yt-dlp'));
        ytdlp = path.join(BIN, 'yt-dlp');
      }
      if (!ffmpeg && process.platform === 'linux') {
        log('downloading ffmpeg (static)');
        await download(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-${arm ? 'arm64' : 'x64'}.gz`, path.join(BIN, 'ffmpeg'), true);
        ffmpeg = path.join(BIN, 'ffmpeg');
      }
      if (!ytdlp || !ffmpeg) throw new Error('yt-dlp and ffmpeg are required for trailers');
      tools = { ytdlp, ffmpeg, own: ytdlp.startsWith(BIN) };
      if (tools.own) setInterval(selfUpdate, 24 * 3600e3).unref();
      return tools;
    })().finally(() => { toolsPending = null; });
    return toolsPending;
  }
  function selfUpdate() {
    if (!tools || !tools.own) return;
    spawn(tools.ytdlp, ['-U'], { stdio: 'ignore' }).on('close', (c) => log('yt-dlp self-update exit', c));
  }

  const file = (id) => path.join(CACHE, id + '.mp4');
  function subsOf(id) {
    return fs.readdirSync(CACHE).filter((f) => f.startsWith(id + '.') && f.endsWith('.vtt'))
      .map((f) => f.slice(id.length + 1, -4)).map((lang) => ({ lang, label: lang }));
  }
  function status(id) {
    if (!ID.test(id)) return { state: 'error', error: 'invalid id' };
    if (fs.existsSync(file(id)) && !(jobs.get(id) && jobs.get(id).state === 'downloading')) {
      return { state: 'ready', url: `/trailers/${id}.mp4`, subs: subsOf(id) };
    }
    const j = jobs.get(id);
    return j ? { state: j.state, progress: Math.round(j.progress), error: j.error || null } : { state: 'none' };
  }

  const baseArgs = (t) => ['--no-playlist', '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', t.ffmpeg];

  async function prepare(id, subLangs) {
    if (!ID.test(id)) throw new Error('invalid id');
    const st = status(id);
    if (st.state === 'ready' || st.state === 'downloading' || st.state === 'starting') return st;
    const job = { state: 'starting', progress: 0, streams: 0, last: 0 };
    jobs.set(id, job);
    try { await ensureTools(); } catch (e) { job.state = 'error'; job.error = e.message; return status(id); }
    const t = tools, url = `https://www.youtube.com/watch?v=${id}`;
    job.state = 'downloading';
    // H.264 + AAC (what every Samsung TV decodes), up to 1080p, merged into one MP4.
    const p = spawn(t.ytdlp, [...baseArgs(t), '--newline', '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
      '--merge-output-format', 'mp4', '-o', path.join(CACHE, '%(id)s.part.%(ext)s'), url]);
    let err = '';
    const onLine = (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        const pct = Number(m[1]);
        if (pct >= 100 && job.last < 100) job.streams++;
        job.last = pct;
        job.progress = Math.min(99, ((job.streams + (pct < 100 ? pct / 100 : 0)) / 2) * 100);
      }
    };
    p.stdout.on('data', (b) => String(b).split('\n').forEach(onLine));
    p.stderr.on('data', (b) => { err = (err + b).slice(-400); String(b).split('\n').forEach(onLine); });   // progress may go to either stream
    p.on('close', (code) => {
      const out = path.join(CACHE, `${id}.part.mp4`);
      if (code === 0 && fs.existsSync(out)) {
        fs.renameSync(out, file(id)); job.state = 'ready'; job.progress = 100;
        log('ready', id);
        // Subtitles are best-effort and must never block playback (YouTube rate-limits them).
        spawn(t.ytdlp, [...baseArgs(t), '-i', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', subLangs,
          '--sub-format', 'vtt', '-o', path.join(CACHE, '%(id)s.%(ext)s'), url], { stdio: 'ignore' });
      } else {
        job.state = 'error'; job.error = (err.match(/ERROR: (.*)/) || [null, err.trim() || `yt-dlp exited ${code}`])[1].slice(0, 200);
        log('failed', id, job.error);
      }
    });
    return status(id);
  }

  // WebVTT -> [{ start, end, text }] in ms (same shape the player uses for Jellyfin subtitles).
  function subtitles(id, lang) {
    if (!ID.test(id) || !/^[\w-]{2,10}$/.test(lang)) throw new Error('invalid');
    const f = path.join(CACHE, `${id}.${lang}.vtt`);
    if (!fs.existsSync(f)) return { events: [] };
    const ms = (s) => { const p = s.trim().split(':').map(Number); return Math.round(((p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1])) * 1000); };
    const events = [], seen = new Set();
    for (const block of fs.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n\n')) {
      const m = block.match(/([\d:.]+)\s+-->\s+([\d:.]+)[^\n]*\n([\s\S]+)/);
      if (!m) continue;
      const text = m[3].replace(/<[^>]+>/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      const key = m[1] + text;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      events.push({ start: ms(m[1]), end: ms(m[2]), text });
    }
    // auto-captions repeat the previous line; keep only lines that add new text
    return { events: events.filter((e, i) => !(i && events[i - 1].text.endsWith(e.text))) };
  }

  // Static MP4 with Range support (needed for seeking).
  function serve(req, res, id) {
    const f = file(id);
    if (!ID.test(id) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    if (range) {
      const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(f).pipe(res);
  }

  // Keep the cache small: drop trailers older than 3 days.
  function cleanup() {
    const cutoff = Date.now() - 3 * 864e5;
    for (const f of fs.readdirSync(CACHE)) {
      const p = path.join(CACHE, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  cleanup(); setInterval(cleanup, 6 * 3600e3).unref();

  return { prepare, status, subtitles, serve, ensureTools };
}

module.exports = { create };
