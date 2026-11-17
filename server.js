// Feature-Voting: Umfrage mit Drag & Drop + Live-Auswertung
// Keine Frameworks, nur Node >= 22.13 (node:sqlite) und SortableJS fürs Frontend.

import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
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
const insertStmt = db.prepare('INSERT INTO responses (id, created_at, name, email, lang, payload) VALUES (?, ?, ?, ?, ?, ?)');
const allStmt = db.prepare('SELECT * FROM responses ORDER BY created_at ASC');

// ---------- Konfiguration (wird bei Änderungen ohne Neustart übernommen) ----------
let configCache = null;
let configMtimeKey = '';
function getConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const key = createHash('sha1').update(raw).digest('hex');
    if (key !== configMtimeKey) {
      configCache = JSON.parse(raw);
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

  return { buckets, custom: cleanCustom, name, email, lang };
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
  '/backend.js': ['public/backend.js', 'text/javascript; charset=utf-8'],
  '/live.js': ['public/live.js', 'text/javascript; charset=utf-8'],
  '/vendor/Sortable.min.js': ['node_modules/sortablejs/Sortable.min.js', 'text/javascript; charset=utf-8'],
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
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const clean = validate(body, getConfig());
      if (typeof clean === 'string') return send(res, 400, { error: clean });
      const id = randomUUID();
      insertStmt.run(id, new Date().toISOString(), clean.name, clean.email, clean.lang,
        JSON.stringify({ buckets: clean.buckets, custom: clean.custom }));
      scheduleBroadcast();
      return send(res, 201, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      if (!isAdmin(url)) return send(res, 401, { error: 'unauthorized' });
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
      const header = ['id', 'created_at', 'name', 'email', 'lang', ...ids, 'custom_ideas'];
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
        lines.push([r.id, r.created_at, r.name, r.email, r.lang, ...ids.map(cell), custom].map(csvCell).join(','));
      }
      return send(res, 200, '﻿' + lines.join('\n'), 'text/csv; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="feature-voting.csv"',
      });
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
  if (ADMIN_TOKEN) console.log(`Live-Ansicht:   http://localhost:${PORT}/live?token=<ADMIN_TOKEN>`);
});
