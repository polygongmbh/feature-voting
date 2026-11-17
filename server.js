// Feature-Voting: Umfrage mit Drag & Drop + Live-Auswertung
// Keine Frameworks, nur Node >= 22.13 (node:sqlite) und SortableJS fürs Frontend.

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Feature list edited in the live view; overrides config.json's features (config.json is mounted read-only)
const FEATURES_PATH = path.join(DATA_DIR, 'features.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BUCKETS = ['want', 'nice', 'no'];

if (!ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN ist nicht gesetzt: Live-Ansicht und Export sind deaktiviert.');

// ---------- Datenbank ----------
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'responses.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    name TEXT,
    email TEXT,
    lang TEXT,
    payload TEXT NOT NULL
  );
`);
// edit_key lets the submitter add name/email right after submitting (hash only, the key stays in their browser)
try { db.exec('ALTER TABLE responses ADD COLUMN edit_key TEXT'); } catch { /* column exists */ }
const insertStmt = db.prepare('INSERT INTO responses (id, created_at, name, email, lang, payload, edit_key) VALUES (?, ?, ?, ?, ?, ?, ?)');
const contactStmt = db.prepare('UPDATE responses SET name = ?, email = ? WHERE id = ? AND edit_key = ?');
const sha256 = s => createHash('sha256').update(s).digest('hex');
const allStmt = db.prepare('SELECT * FROM responses ORDER BY created_at ASC');
const deleteStmt = db.prepare('DELETE FROM responses WHERE id = ?');

// ---------- Konfiguration (wird bei Änderungen ohne Neustart übernommen) ----------
let configCache = null;
let configMtimeKey = '';
function readOptional(file) {
  try { return readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}
function getConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const rawFeatures = readOptional(FEATURES_PATH);
    const key = createHash('sha1').update(raw).update('\0').update(rawFeatures).digest('hex');
    if (key !== configMtimeKey) {
      const cfg = JSON.parse(raw);
      if (rawFeatures) cfg.features = JSON.parse(rawFeatures);
      configCache = cfg;
      configMtimeKey = key;
    }
  } catch (err) {
    if (!configCache) throw err;
    console.error('[config] Fehler beim Lesen, nutze letzte gültige Version:', err.message);
  }
  return configCache;
}
const txt = (v, lang = 'de') => (typeof v === 'string' ? v : (v?.[lang] ?? v?.de ?? Object.values(v || {})[0] ?? ''));

// ---------- Auswertung ----------
function aggregate() {
  const cfg = getConfig();
  const lang = cfg.defaultLang || 'de';
  const stats = new Map(cfg.features.map(f => [f.id, {
    id: f.id, title: f.title, want: 0, nice: 0, no: 0, rankSum: 0,
  }]));
  const ideas = [];
  const rows = allStmt.all();

  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    for (const b of BUCKETS) {
      const list = p.buckets?.[b] || [];
      const known = list.filter(id => stats.has(id));
      known.forEach((id, i) => {
        const s = stats.get(id);
        s[b]++;
        // Position in "will ich": Platz 1 zählt voll, letzter Platz halb
        if (b === 'want') s.rankSum += known.length > 1 ? 1 - (i / (known.length - 1)) * 0.5 : 1;
      });
    }
    for (const c of p.custom || []) {
      const bucket = BUCKETS.find(b => (p.buckets?.[b] || []).includes(c.id)) || null;
      ideas.push({ text: c.text, bucket, at: r.created_at });
    }
  }

  const features = [...stats.values()].map(s => {
    const n = s.want + s.nice + s.no;
    // Punkte: will ich = 2 + Positionsbonus (0.5..1), nett = 1, brauche ich nicht = -1
    const avg = n ? (s.want * 2 + s.rankSum + s.nice - s.no) / n : 0;
    return {
      id: s.id,
      title: s.title,
      want: s.want, nice: s.nice, no: s.no, n,
      score: n ? Math.round(((avg + 1) / 4) * 100) : 0, // 0..100
      lean: n ? (s.want + s.nice * 0.5) / n : 0.5,       // 1 = will ich, 0 = brauche ich nicht
    };
  }).sort((a, b) => b.score - a.score || b.n - a.n);

  return {
    title: txt(cfg.title, lang),
    total: rows.length,
    features,
    ideas: ideas.slice(-40).reverse(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- Validierung ----------
// Returns the cleaned feature list or an error string
function validateFeatures(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 60) return 'need 1 to 60 features';
  const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const ids = new Set();
  const out = [];
  for (const f of list) {
    const id = String(f?.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || id.startsWith('c_')) return 'bad feature id';
    if (ids.has(id)) return 'duplicate feature id';
    ids.add(id);
    const title = { de: str(f.title?.de, 80), en: str(f.title?.en, 80) };
    const desc = { de: str(f.desc?.de, 200), en: str(f.desc?.en, 200) };
    if (!title.de && !title.en) return 'feature without title';
    if (!title.de) title.de = title.en;
    if (!title.en) delete title.en;
    if (!desc.de && desc.en) desc.de = desc.en;
    if (!desc.en) delete desc.en;
    out.push(desc.de ? { id, title, desc } : { id, title });
  }
  return out;
}

function validate(body, cfg) {
  if (!body || typeof body !== 'object') return 'invalid body';
  const featureIds = new Set(cfg.features.map(f => f.id));
  const maxCustom = cfg.maxCustomIdeas ?? 5;

  const custom = Array.isArray(body.custom) ? body.custom : [];
  if (custom.length > maxCustom) return 'too many custom ideas';
  const customIds = new Set();
  const cleanCustom = [];
  for (const c of custom) {
    if (typeof c?.id !== 'string' || !/^c_[a-z0-9]{4,20}$/i.test(c.id)) return 'bad custom id';
    const text = String(c.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 140);
    if (!text) continue;
    customIds.add(c.id);
    cleanCustom.push({ id: c.id, text });
  }

  const buckets = {};
  const seen = new Set();
  let sorted = 0;
  for (const b of BUCKETS) {
    const list = Array.isArray(body.buckets?.[b]) ? body.buckets[b] : [];
    buckets[b] = [];
    for (const id of list) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!featureIds.has(id) && !customIds.has(id)) continue;
      seen.add(id);
      buckets[b].push(id);
      sorted++;
    }
  }
  if (sorted === 0) return 'nothing sorted';

  const name = String(body.name ?? '').trim().slice(0, 80) || null;
  let email = String(body.email ?? '').trim().slice(0, 120) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'invalid email';
  const lang = ['de', 'en'].includes(body.lang) ? body.lang : null;

  // optional comment per feature or own idea
  const comments = {};
  if (body.comments && typeof body.comments === 'object') {
    for (const [id, v] of Object.entries(body.comments)) {
      if (!featureIds.has(id) && !customIds.has(id)) continue;
      const text = String(v ?? '').trim().slice(0, 500);
      if (text) comments[id] = text;
    }
  }

  return { buckets, custom: cleanCustom, comments, name, email, lang };
}

// ---------- Live-Verbindungen (Server-Sent Events) ----------
const liveClients = new Set();
let broadcastTimer = null;
function scheduleBroadcast() {
  // mehrere Antworten kurz hintereinander werden gebündelt
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = `event: update\ndata: ${JSON.stringify(aggregate())}\n\n`;
    for (const res of liveClients) res.write(data);
  }, 300);
}
setInterval(() => { for (const res of liveClients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- Einfaches Rate-Limit ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some(t => now - t < 10 * 60 * 1000)) hits.delete(ip);
}, 60 * 1000).unref();

// ---------- Helfer ----------
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function isAdmin(url) {
  const token = url.searchParams.get('token') || '';
  if (!ADMIN_TOKEN || !token) return false;
  const a = Buffer.from(token), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/live': ['public/live.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/live.css': ['public/live.css', 'text/css; charset=utf-8'],
  '/survey.js': ['public/survey.js', 'text/javascript; charset=utf-8'],
  '/live.js': ['public/live.js', 'text/javascript; charset=utf-8'],
  '/vendor/Sortable.min.js': ['node_modules/sortablejs/Sortable.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-dispatch.js': ['node_modules/d3-dispatch/dist/d3-dispatch.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-quadtree.js': ['node_modules/d3-quadtree/dist/d3-quadtree.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-timer.js': ['node_modules/d3-timer/dist/d3-timer.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-force.js': ['node_modules/d3-force/dist/d3-force.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.js': ['node_modules/qrcode-generator/dist/qrcode.js', 'text/javascript; charset=utf-8'],
};
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = await readFile(path.join(__dirname, file));
      return send(res, 200, body, type, { 'Cache-Control': 'no-cache' });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg = getConfig();
      return send(res, 200, {
        defaultLang: cfg.defaultLang || 'de',
        title: cfg.title, intro: cfg.intro, privacy: cfg.privacy,
        testflight: cfg.testflight, maxCustomIdeas: cfg.maxCustomIdeas ?? 5,
        features: cfg.features,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/responses') {
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'rate limited' });
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const clean = validate(body, getConfig());
      if (typeof clean === 'string') return send(res, 400, { error: clean });
      const id = randomUUID();
      const key = randomUUID();
      insertStmt.run(id, new Date().toISOString(), clean.name, clean.email, clean.lang,
        JSON.stringify({ buckets: clean.buckets, custom: clean.custom, comments: clean.comments }), sha256(key));
      scheduleBroadcast();
      return send(res, 201, { ok: true, id, key });
    }

    // Submitter adds or changes name/email on their own response
    const contactMatch = req.method === 'PATCH' && url.pathname.match(/^\/api\/responses\/([0-9a-f-]{36})$/);
    if (contactMatch) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const name = String(body?.name ?? '').trim().slice(0, 80) || null;
      const email = String(body?.email ?? '').trim().slice(0, 120) || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'invalid email' });
      const { changes } = contactStmt.run(name, email, contactMatch[1], sha256(String(body?.key ?? '')));
      if (!changes) return send(res, 404, { error: 'not found' });
      return send(res, 200, { ok: true });
    }

    // Live view is public (only aggregates and ideas); names/emails stay behind the token in the CSV export
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: update\ndata: ${JSON.stringify(aggregate())}\n\n`);
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      if (!isAdmin(url)) return send(res, 401, { error: 'unauthorized' });
      const cfg = getConfig();
      const ids = cfg.features.map(f => f.id);
      const header = ['id', 'created_at', 'name', 'email', 'lang', ...ids, 'custom_ideas', 'comments'];
      const lines = [header.map(csvCell).join(',')];
      for (const r of allStmt.all()) {
        const p = JSON.parse(r.payload);
        const cell = id => {
          for (const b of BUCKETS) {
            const i = (p.buckets[b] || []).indexOf(id);
            if (i >= 0) return b === 'want' ? `want #${i + 1}` : b;
          }
          return '';
        };
        const custom = (p.custom || []).map(c => {
          const b = BUCKETS.find(b => (p.buckets[b] || []).includes(c.id)) || 'unsorted';
          return `${c.text} [${b}]`;
        }).join(' | ');
        const title = id => txt(cfg.features.find(f => f.id === id)?.title) || (p.custom || []).find(c => c.id === id)?.text || id;
        const comments = Object.entries(p.comments || {}).map(([id, c]) => `${title(id)}: ${c}`).join(' | ');
        lines.push([r.id, r.created_at, r.name, r.email, r.lang, ...ids.map(cell), custom, comments].map(csvCell).join(','));
      }
      return send(res, 200, '﻿' + lines.join('\n'), 'text/csv; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="feature-voting.csv"',
      });
    }

    // Admin: list single responses (incl. names/emails) and delete bogus ones
    if (req.method === 'GET' && url.pathname === '/api/responses') {
      if (!isAdmin(url)) return send(res, 401, { error: 'unauthorized' });
      const list = allStmt.all().reverse().map(r => {
        let p = {};
        try { p = JSON.parse(r.payload); } catch { /* skip broken payload */ }
        return { id: r.id, created_at: r.created_at, name: r.name, email: r.email, lang: r.lang,
          buckets: p.buckets || {}, custom: p.custom || [], comments: p.comments || {} };
      });
      return send(res, 200, { responses: list });
    }
    const delMatch = req.method === 'DELETE' && url.pathname.match(/^\/api\/responses\/([0-9a-f-]{36})$/);
    if (delMatch) {
      if (!isAdmin(url)) return send(res, 401, { error: 'unauthorized' });
      const { changes } = deleteStmt.run(delMatch[1]);
      if (!changes) return send(res, 404, { error: 'not found' });
      scheduleBroadcast();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin') {
      return send(res, isAdmin(url) ? 200 : 401, { ok: isAdmin(url) });
    }

    if (req.method === 'PUT' && url.pathname === '/api/features') {
      if (!isAdmin(url)) return send(res, 401, { error: 'unauthorized' });
      let body;
      try { body = JSON.parse(await readBody(req, 128 * 1024)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const features = validateFeatures(body?.features);
      if (typeof features === 'string') return send(res, 400, { error: features });
      // why: write-then-rename so a crash never leaves a half-written file that getConfig would choke on
      const tmp = FEATURES_PATH + '.tmp';
      writeFileSync(tmp, JSON.stringify(features, null, 2) + '\n');
      renameSync(tmp, FEATURES_PATH);
      scheduleBroadcast();
      return send(res, 200, { ok: true, features });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Umfrage:        http://localhost:${PORT}/`);
  console.log(`Live-Ansicht:   http://localhost:${PORT}/live`);
});
