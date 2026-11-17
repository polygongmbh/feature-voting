// Survey content, response validation, scoring and CSV export. Pure functions, no I/O.
export const BUCKETS = ['want', 'nice', 'no'];
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export const SURVEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// path segments that belong to the app itself and can't be survey ids
export const RESERVED_IDS = new Set(['api', 'admin', 'live', 'vendor', 'healthz']);

// Survey texts are single strings in whatever language the survey is written in.
// Returns the cleaned survey data or an error string.
export function validateSurveyData(body) {
  if (!body || typeof body !== 'object') return 'invalid body';
  const title = str(body.title, 120);
  if (!title) return 'title required';
  const linkUrl = str(body.linkUrl, 300);
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) return 'link must start with http(s)://';
  const features = validateFeatures(body.features ?? []);
  if (typeof features === 'string') return features;
  return {
    title,
    intro: str(body.intro, 400),
    thanks: str(body.thanks, 400),
    linkUrl,
    linkLabel: str(body.linkLabel, 60),
    features,
  };
}

function validateFeatures(list) {
  if (!Array.isArray(list) || list.length > 60) return 'up to 60 options';
  const ids = new Set();
  const out = [];
  for (const f of list) {
    const id = String(f?.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || id.startsWith('c_')) return 'bad option id';
    if (ids.has(id)) return 'duplicate option id';
    ids.add(id);
    const title = str(f.title, 120);
    if (!title) return 'option without title';
    const desc = str(f.desc, 200);
    out.push(desc ? { id, title, desc } : { id, title });
  }
  return out;
}

// Returns the cleaned response or an error string
export function validateResponse(body, survey, maxCustom) {
  if (!body || typeof body !== 'object') return 'invalid body';
  const featureIds = new Set(survey.features.map(f => f.id));

  const custom = Array.isArray(body.custom) ? body.custom : [];
  if (custom.length > maxCustom) return 'too many custom ideas';
  const customIds = new Set();
  const cleanCustom = [];
  for (const c of custom) {
    if (typeof c?.id !== 'string' || !/^c_[a-z0-9]{4,20}$/i.test(c.id)) return 'bad custom id';
    const text = str(c.text, 140);
    if (!text) continue;
    customIds.add(c.id);
    cleanCustom.push({ id: c.id, text });
  }

  const buckets = {};
  const seen = new Set();
  let sorted = 0;
  for (const b of BUCKETS) {
    buckets[b] = [];
    for (const id of Array.isArray(body.buckets?.[b]) ? body.buckets[b] : []) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!featureIds.has(id) && !customIds.has(id)) continue;
      seen.add(id);
      buckets[b].push(id);
      sorted++;
    }
  }
  if (sorted === 0) return 'nothing sorted';

  const comments = {};
  if (body.comments && typeof body.comments === 'object') {
    for (const [id, v] of Object.entries(body.comments)) {
      if (!featureIds.has(id) && !customIds.has(id)) continue;
      const text = String(v ?? '').trim().slice(0, 500);
      if (text) comments[id] = text;
    }
  }
  const lang = ['de', 'en'].includes(body.lang) ? body.lang : null;
  return { buckets, custom: cleanCustom, comments, lang };
}

export function validateContact(body) {
  const name = str(body?.name, 80) || null;
  const email = str(body?.email, 120) || null;
  if (email && !EMAIL_RE.test(email)) return 'invalid email';
  return { name, email };
}

export function aggregate(survey, rows) {
  const stats = new Map(survey.features.map(f => [f.id, { id: f.id, title: f.title, want: 0, nice: 0, no: 0, rankSum: 0 }]));
  const ideas = [];
  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    for (const b of BUCKETS) {
      const known = (p.buckets?.[b] || []).filter(id => stats.has(id));
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
      id: s.id, title: s.title, want: s.want, nice: s.nice, no: s.no, n,
      score: n ? Math.round(((avg + 1) / 4) * 100) : 0, // 0..100
      lean: n ? (s.want + s.nice * 0.5) / n : 0.5,       // 1 = will ich, 0 = brauche ich nicht
    };
  }).sort((a, b) => b.score - a.score || b.n - a.n);
  return { id: survey.id, title: survey.title, total: rows.length, features, ideas: ideas.slice(-40).reverse(), updatedAt: new Date().toISOString() };
}

// Admin view of single responses (with names and emails)
export const responseList = rows => rows.slice().reverse().map(r => {
  let p = {};
  try { p = JSON.parse(r.payload); } catch { /* skip broken payload */ }
  return { id: r.id, created_at: r.created_at, name: r.name, email: r.email, lang: r.lang,
    buckets: p.buckets || {}, custom: p.custom || [], comments: p.comments || {} };
});

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
export function toCsv(survey, rows) {
  const ids = survey.features.map(f => f.id);
  const lines = [['id', 'created_at', 'name', 'email', 'lang', ...survey.features.map(f => f.title), 'custom_ideas', 'comments'].map(csvCell).join(',')];
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    const cell = id => {
      for (const b of BUCKETS) {
        const i = (p.buckets[b] || []).indexOf(id);
        if (i >= 0) return b === 'want' ? `want #${i + 1}` : b;
      }
      return '';
    };
    const custom = (p.custom || []).map(c => `${c.text} [${BUCKETS.find(b => (p.buckets[b] || []).includes(c.id)) || 'unsorted'}]`).join(' | ');
    const title = id => survey.features.find(f => f.id === id)?.title || (p.custom || []).find(c => c.id === id)?.text || id;
    const comments = Object.entries(p.comments || {}).map(([id, c]) => `${title(id)}: ${c}`).join(' | ');
    lines.push([r.id, r.created_at, r.name, r.email, r.lang, ...ids.map(cell), custom, comments].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\n');
}
