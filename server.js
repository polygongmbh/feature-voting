// Feature-Voting: mehrere Umfragen mit Drag & Drop + Live-Auswertung.
// Keine Frameworks, nur Node >= 22.13 (node:sqlite); SortableJS, d3-force und qrcode-generator fürs Frontend.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { send, readJson, makeIsAdmin, clientIp, rateLimited } from './lib/http.js';
import {
  slugify, SURVEY_ID_RE, RESERVED_IDS, validateSurveyData, validateResponse, validateContact,
  aggregate, responseList, toCsv,
} from './lib/survey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const isAdmin = makeIsAdmin(process.env.ADMIN_TOKEN || '');
if (!process.env.ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN ist nicht gesetzt: Verwaltung und Export sind deaktiviert.');

const db = openDb(DATA_DIR, path.join(__dirname, 'migrations'));
const sha256 = s => createHash('sha256').update(s).digest('hex');

// Global settings (privacy text, idea limit); re-read on every request, so edits apply without restart
let config = { privacy: '', maxCustomIdeas: 5 };
function getConfig() {
  try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (err) { console.error('[config]', err.message); }
  return config;
}

// ---------- Live-Verbindungen (Server-Sent Events), je Umfrage ----------
const liveClients = new Map(); // survey id -> Set<res>
const timers = new Map();
function scheduleBroadcast(id) {
  // mehrere Antworten kurz hintereinander werden gebündelt
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const survey = db.getSurvey(id);
    const clients = liveClients.get(id);
    if (!survey || !clients?.size) return;
    const data = `event: update\ndata: ${JSON.stringify(aggregate(survey, db.responses(id)))}\n\n`;
    for (const res of clients) res.write(data);
  }, 300));
}
setInterval(() => { for (const set of liveClients.values()) for (const res of set) res.write(': ping\n\n'); }, 25000).unref();

const STATIC = {
  '/admin': ['public/admin.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/live.css': ['public/live.css', 'text/css; charset=utf-8'],
  '/admin.css': ['public/admin.css', 'text/css; charset=utf-8'],
  '/survey.js': ['public/survey.js', 'text/javascript; charset=utf-8'],
  '/live.js': ['public/live.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['public/admin.js', 'text/javascript; charset=utf-8'],
  '/vendor/Sortable.min.js': ['node_modules/sortablejs/Sortable.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-dispatch.js': ['node_modules/d3-dispatch/dist/d3-dispatch.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-quadtree.js': ['node_modules/d3-quadtree/dist/d3-quadtree.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-timer.js': ['node_modules/d3-timer/dist/d3-timer.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3-force.js': ['node_modules/d3-force/dist/d3-force.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.js': ['node_modules/qrcode-generator/dist/qrcode.js', 'text/javascript; charset=utf-8'],
};
const serveFile = async (res, file, type) => send(res, 200, await readFile(path.join(__dirname, file)), type, { 'Cache-Control': 'no-cache' });
const publicSurvey = s => {
  const { privacy, maxCustomIdeas = 5 } = getConfig();
  return { id: s.id, title: s.title, intro: s.intro, thanks: s.thanks, linkUrl: s.linkUrl, linkLabel: s.linkLabel, features: s.features, privacy, maxCustomIdeas };
};

// ---------- API ----------
async function api(req, res, url, parts) {
  const [, , a, b, c] = parts; // '', 'api', a, b, c
  const admin = isAdmin(url);
  const deny = () => send(res, 401, { error: 'unauthorized' });

  if (a === 'config' && req.method === 'GET') return send(res, 200, getConfig());
  if (a === 'admin' && req.method === 'GET') return send(res, admin ? 200 : 401, { ok: admin });

  if (a === 'surveys' && !b) {
    if (!admin) return deny();
    if (req.method === 'GET') {
      return send(res, 200, { surveys: db.listSurveys().map(s => ({ id: s.id, title: s.title, created_at: s.created_at, total: s.total, options: s.features.length })) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const data = validateSurveyData({ ...body, features: [] });
      if (typeof data === 'string') return send(res, 400, { error: data });
      let id = body?.id ? String(body.id) : slugify(data.title);
      if (!SURVEY_ID_RE.test(id) || RESERVED_IDS.has(id)) return send(res, 400, { error: 'bad survey id' });
      const base = id;
      for (let n = 2; db.getSurvey(id); n++) id = `${base}-${n}`;
      db.createSurvey(id, data);
      return send(res, 201, { id, ...data });
    }
  }

  if (a === 'surveys' && b) {
    const survey = db.getSurvey(b);
    if (!survey) return send(res, 404, { error: 'not found' });

    if (!c && req.method === 'GET') return send(res, 200, publicSurvey(survey));
    if (!c && req.method === 'PUT') {
      if (!admin) return deny();
      const data = validateSurveyData(await readJson(req, 128 * 1024));
      if (typeof data === 'string') return send(res, 400, { error: data });
      db.updateSurvey(b, data);
      scheduleBroadcast(b);
      return send(res, 200, { id: b, ...data });
    }
    if (c === 'responses' && req.method === 'POST') {
      if (rateLimited(clientIp(req, TRUST_PROXY))) return send(res, 429, { error: 'rate limited' });
      const body = await readJson(req, 64 * 1024);
      if (body === undefined) return send(res, 400, { error: 'invalid json' });
      const clean = validateResponse(body, survey, getConfig().maxCustomIdeas ?? 5);
      if (typeof clean === 'string') return send(res, 400, { error: clean });
      const id = randomUUID(), key = randomUUID();
      db.insertResponse(id, new Date().toISOString(), null, null, clean.lang,
        JSON.stringify({ buckets: clean.buckets, custom: clean.custom, comments: clean.comments }), sha256(key), b);
      scheduleBroadcast(b);
      return send(res, 201, { ok: true, id, key });
    }
    if (c === 'responses' && req.method === 'GET') {
      return admin ? send(res, 200, { responses: responseList(db.responses(b)) }) : deny();
    }
    if (c === 'export.csv' && req.method === 'GET') {
      if (!admin) return deny();
      return send(res, 200, toCsv(survey, db.responses(b)), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${b}.csv"`,
      });
    }
    // Live view is public (aggregates and idea texts only); names/emails need the token
    if (c === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: update\ndata: ${JSON.stringify(aggregate(survey, db.responses(b)))}\n\n`);
      if (!liveClients.has(b)) liveClients.set(b, new Set());
      liveClients.get(b).add(res);
      req.on('close', () => liveClients.get(b)?.delete(res));
      return;
    }
  }

  if (a === 'responses' && /^[0-9a-f-]{36}$/.test(b || '') && !c) {
    // submitter adds name/email with the key they got on submit
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const contact = validateContact(body);
      if (typeof contact === 'string') return send(res, 400, { error: contact });
      const { changes } = db.setContact(contact.name, contact.email, b, sha256(String(body?.key ?? '')));
      return changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      if (!admin) return deny();
      const surveyId = db.surveyOfResponse(b);
      if (!surveyId) return send(res, 404, { error: 'not found' });
      db.deleteResponse(b);
      scheduleBroadcast(surveyId);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  try {
    if (parts[1] === 'api') return await api(req, res, url, parts);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (STATIC[url.pathname]) return await serveFile(res, ...STATIC[url.pathname]);

    // the start page is the survey overview
    if (url.pathname === '/') return await serveFile(res, 'public/admin.html', 'text/html; charset=utf-8');
    // /<survey> and /<survey>/live
    const [, id, sub, extra] = parts;
    if (id && SURVEY_ID_RE.test(id) && extra === undefined && db.getSurvey(id)) {
      if (!sub) return await serveFile(res, 'public/index.html', 'text/html; charset=utf-8');
      if (sub === 'live') return await serveFile(res, 'public/live.html', 'text/html; charset=utf-8');
    }
    send(res, 404, 'Nicht gefunden.', 'text/plain; charset=utf-8');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Umfragen:       http://localhost:${PORT}/admin`);
});
