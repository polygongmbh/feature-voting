(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const lang = params.get('lang') || 'de';
  const TOKEN_KEY = 'fv-admin-token';
  const BUCKET_LABEL = { want: 'Das will ich!', nice: 'Das wäre nett', no: 'Brauche ich nicht', null: 'nicht einsortiert' };

  const tx = v => (typeof v === 'string' ? v : (v?.[lang] ?? v?.de ?? Object.values(v || {})[0] ?? ''));
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* egal */ } },
  };

  let token = params.get('token') || ss.get(TOKEN_KEY) || '';
  let es = null;
  let prev = null;           // letzter Stand
  let first = true;
  const rowEls = new Map();
  const bubbleEls = new Map();
  const bubblePos = new Map(); // id -> {x, y}
  let view = 'qr';

  // Token aus der URL entfernen, damit er nicht in Screenshots/Verlauf landet
  if (params.get('token')) {
    ss.set(TOKEN_KEY, token);
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }


  // Join screen: QR code + address of the survey, shown until the first answer arrives
  function renderJoin() {
    const url = location.origin + '/';
    $('#joinUrl').textContent = location.host;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('#joinQr').innerHTML = qr.createSvgTag({ cellSize: 1, margin: 2, scalable: true, alt: url });
    } catch { $('#joinQr').hidden = true; }
  }
  renderJoin();

  // QR screen is the "qr" tab: shown automatically until the first answer, Q toggles it, click/Esc goes back
  let total = 0;
  let lastView = 'ranking';
  let autoQr = true; // still in the automatic "waiting for answers" phase
  const syncJoin = () => {
    $('#emptyState').hidden = view !== 'qr';
    $('#joinWait').hidden = total > 0;
  };
  $('#emptyState').addEventListener('click', () => setView(lastView));
  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'q' || e.key === 'Q') setView(view === 'qr' ? lastView : 'qr');
    if (e.key === 'Escape' && view === 'qr') setView(lastView);
  });

  function connect() {
    if (es) es.close();
    $('#app').hidden = false;
    // CSV export contains names/emails: only offered when an admin token was given
    $('#exportLink').hidden = !token;
    if (token) $('#exportLink').href = '/api/export.csv?token=' + encodeURIComponent(token);
    es = new EventSource('/api/stream');
    es.addEventListener('update', ev => update(JSON.parse(ev.data)));
    es.onopen = () => $('#liveDot').classList.add('on');
    es.onerror = () => $('#liveDot').classList.remove('on');
  }

  // ---------- Update ----------
  function update(data) {
    $('#title').textContent = data.title || 'Live-Auswertung';
    document.title = 'Live: ' + (data.title || 'Auswertung');
    if (view === 'responses' && token && data.total !== total) openResponses();
    // QR while there are no answers: first answer switches QR -> diagram, dropping back to 0 shows QR again
    const was = total;
    total = data.total;
    if (!first || autoQr) {
      if (view === 'qr' && total > 0 && (was === 0 || autoQr)) setView('ranking');
      else if (total === 0 && was > 0 && (view === 'ranking' || view === 'cluster')) setView('qr');
    }
    autoQr = false;
    syncJoin();

    const grew = prev && data.total > prev.total;
    animateNumber($('#total'), prev ? prev.total : 0, data.total);
    $('#totalLabel').textContent = data.total === 1 ? 'Antwort' : 'Antworten';
    if (grew && !first) {
      const t = $('.total'); t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
      const f = $('#flash'); f.textContent = '+' + (data.total - prev.total); f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    }

    const prevById = new Map((prev?.features || []).map((f, i) => [f.id, { ...f, pos: i }]));
    renderRanking(data, prevById);
    renderCluster(data, prevById);
    renderIdeas(data);

    prev = data;
    first = false;
  }

  function changed(f, p) { return p && (f.want !== p.want || f.nice !== p.nice || f.no !== p.no); }

  function animateNumber(el, from, to) {
    if (from === to) { el.textContent = to; return; }
    const start = performance.now(), dur = 700;
    const step = now => {
      const k = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- Diagramm (divergierende Balken) ----------
  function renderRanking(data, prevById) {
    const wrap = $('#rows');
    const feats = data.features;
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // Zeilenhöhe so wählen, dass alles ohne Scrollen auf den Beamer passt
    const avail = wrap.clientHeight || 600;
    const h = Math.max(3.2 * remPx, Math.min(6 * remPx, avail / Math.max(1, feats.length)));
    wrap.style.minHeight = feats.length * h + 'px';

    // Skala: links "brauche ich nicht", rechts "will ich" + "nett"
    const maxNeg = Math.max(0, ...feats.map(f => f.no));
    const maxPos = Math.max(1, ...feats.map(f => f.want + f.nice));
    const axis = maxNeg ? Math.min(40, Math.max(14, (maxNeg / (maxNeg + maxPos)) * 100)) : 0;
    const negScale = maxNeg ? axis / maxNeg : 0;
    const posScale = (100 - axis) / maxPos;
    $('#chartHead .ch-neg').style.width = axis + '%';
    $('#chartHead .ch-neg').style.visibility = maxNeg ? 'visible' : 'hidden';
    $('#chartHead .ch-pos').style.width = (100 - axis) + '%';

    const live = new Set();
    feats.forEach((f, i) => {
      live.add(f.id);
      let el = rowEls.get(f.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'row';
        el.innerHTML = '<div class="pos"></div><div class="name"><span></span><small></small></div>' +
          '<div class="chart"><div class="neg"><i class="no"><b></b></i></div>' +
          '<div class="pos-side"><i class="want"><b></b></i><i class="nice"><b></b></i></div></div>' +
          '<div class="score"></div><span class="delta"></span>';
        el.style.transform = `translateY(${i * h}px)`;
        wrap.appendChild(el);
        rowEls.set(f.id, el);
      }
      const p = prevById.get(f.id);
      el.style.height = (h - 0.5 * remPx) + 'px';
      el.classList.toggle('top3', i < 3 && f.n > 0);
      el.querySelector('.pos').textContent = f.n ? i + 1 : '–';
      el.querySelector('.name span').textContent = tx(f.title);
      el.querySelector('.name small').textContent = f.n ? `${f.n} Stimme${f.n === 1 ? '' : 'n'}` : 'noch keine Stimmen';

      const chart = el.querySelector('.chart');
      chart.style.setProperty('--axis', axis + '%');
      el.querySelector('.neg').style.width = axis + '%';
      el.querySelector('.pos-side').style.width = (100 - axis) + '%';
      const setSeg = (cls, count, scale) => {
        const seg = el.querySelector('i.' + cls);
        seg.style.width = count * scale * (100 / (cls === 'no' ? axis || 1 : 100 - axis)) + '%';
        seg.querySelector('b').textContent = count || '';
      };
      setSeg('no', f.no, negScale);
      setSeg('want', f.want, posScale);
      setSeg('nice', f.nice, posScale);

      animateNumber(el.querySelector('.score'), p ? p.score : 0, f.score);
      requestAnimationFrame(() => { el.style.transform = `translateY(${i * h}px)`; });

      if (!first && changed(f, p)) {
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
        const d = el.querySelector('.delta');
        const moved = p.pos - i;
        d.className = 'delta' + (moved > 0 ? ' up' : moved < 0 ? ' down' : '');
        d.textContent = moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '';
        setTimeout(() => { d.className = 'delta'; }, 3000);
      }
    });
    for (const [id, el] of rowEls) if (!live.has(id)) { el.remove(); rowEls.delete(id); }
  }

  // ---------- Cluster (kleine Physik-Simulation) ----------
  function bubbleColor(lean) {
    // 0 = brauche ich nicht (grau), 0.5 = nett (amber), 1 = will ich (grün)
    // same tones as the bars (--want / --nice / --no), dark enough for white text on a projector
    const g = [21, 128, 61], a = [194, 88, 12], s = [91, 102, 120];
    const mix = (c1, c2, k) => c1.map((v, i) => Math.round(v + (c2[i] - v) * k));
    const c = lean >= 0.5 ? mix(a, g, (lean - 0.5) * 2) : mix(s, a, lean * 2);
    return `rgb(${c})`;
  }

  function renderCluster(data, prevById) {
    const area = $('#bubbles');
    const W = area.clientWidth || 900, H = area.clientHeight || 600;
    const maxN = Math.max(1, ...data.features.map(f => f.n));
    const minD = Math.max(110, Math.min(W, H) * 0.2), maxD = Math.max(170, Math.min(W, H) * 0.36);
    const pad = 12, topPad = 48;

    const nodes = data.features.filter(f => f.n > 0).map(f => {
      const d = f.n ? minD + Math.sqrt(f.n / maxN) * (maxD - minD) : minD * 0.8;
      const tx = pad + d / 2 + (1 - f.lean) * (W - d - pad * 2);
      const old = bubblePos.get(f.id);
      return {
        f, r: d / 2, tx,
        x: old ? old.x : tx,
        y: old ? old.y : topPad + Math.random() * (H - topPad - d) + d / 2,
      };
    });

    const cy = (H + topPad) / 2;
    for (let it = 0; it < 260; it++) {
      for (const n of nodes) {
        n.x += (n.tx - n.x) * 0.08;
        n.y += (cy - n.y) * 0.01;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          const min = a.r + b.r + 6;
          if (dist < min) {
            if (dist < 0.02) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = Math.hypot(dx, dy); }
            const push = (min - dist) / 2;
            const ux = dx / dist, uy = dy / dist;
            a.x -= ux * push * 0.4; a.y -= uy * push;
            b.x += ux * push * 0.4; b.y += uy * push;
          }
        }
      }
      for (const n of nodes) {
        n.x = Math.max(n.r + pad, Math.min(W - n.r - pad, n.x));
        n.y = Math.max(n.r + topPad, Math.min(H - n.r - pad, n.y));
      }
    }

    const live = new Set();
    for (const n of nodes) {
      const f = n.f;
      live.add(f.id);
      bubblePos.set(f.id, { x: n.x, y: n.y });
      let el = bubbleEls.get(f.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'bubble';
        el.innerHTML = '<div><span></span><small></small></div>';
        el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px) scale(.2)`;
        area.appendChild(el);
        bubbleEls.set(f.id, el);
      }
      el.querySelector('span').textContent = tx(f.title);
      el.querySelector('small').textContent = f.n ? `${f.score} · ${f.n}×` : '–';
      el.style.width = el.style.height = n.r * 2 + 'px';
      el.style.background = bubbleColor(f.n ? f.lean : 0.5);
      el.style.opacity = f.n ? 1 : 0.35;
      el.style.fontSize = n.r < 80 ? '.8em' : '';
      requestAnimationFrame(() => { el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`; });
      if (!first && changed(f, prevById.get(f.id))) {
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      }
    }
    for (const [id, el] of bubbleEls) if (!live.has(id)) { el.remove(); bubbleEls.delete(id); bubblePos.delete(id); }
  }

  // ---------- Ideen ----------
  function renderIdeas(data) {
    const ul = $('#ideas');
    const known = new Set([...ul.children].map(li => li.dataset.key));
    $('#ideasEmpty').hidden = data.ideas.length > 0;
    $('#ideaCount').textContent = data.ideas.length ? `(${data.ideas.length})` : '';
    const items = data.ideas.map(idea => {
      const key = idea.at + '|' + idea.text;
      const li = document.createElement('li');
      li.dataset.key = key;
      li.textContent = idea.text;
      const tag = document.createElement('span');
      tag.className = 'tag ' + (idea.bucket || 'none');
      tag.textContent = BUCKET_LABEL[idea.bucket];
      li.appendChild(document.createElement('br'));
      li.appendChild(tag);
      if (!first && !known.has(key)) li.classList.add('new');
      return li;
    });
    ul.replaceChildren(...items);
  }

  // ---------- Ansicht wechseln ----------
  function setView(next) {
    if (next !== 'qr') lastView = next;
    else if (view !== 'qr') lastView = view;
    view = next;
    document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    // the QR tab is a fullscreen overlay above the last real view
    const shown = view === 'qr' ? lastView : view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + shown));
    const admin = ADMIN_VIEWS[shown];
    // admin tabs show the token form first when no token is known
    if (admin && !token) document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-token'));
    $('#app').classList.toggle('editing', !!admin);
    syncJoin();
    if (admin && !token) $('#tokenInput').focus();
    else if (admin) admin();
    else if (prev) { const p = prev; renderCluster(p, new Map()); renderRanking(p, new Map(p.features.map((f, i) => [f.id, { ...f, pos: i }]))); }
  }
  document.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

  // ---------- Optionen bearbeiten (needs the admin token) ----------
  let optLoaded = false;
  const slug = s => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'option';

  async function openOptions() {
    if (optLoaded) return;
    const cfg = await fetch('/api/config').then(r => r.json());
    $('#optList').replaceChildren(...cfg.features.map(optRow));
    optLoaded = true;
  }

  function optRow(f = {}) {
    const li = document.createElement('li');
    li.className = 'opt-row';
    if (f.id) li.dataset.id = f.id; // existing ids never change: answers reference them
    const field = (key, lang, ph) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.dataset.key = key; i.dataset.lang = lang;
      i.maxLength = key === 'title' ? 80 : 200;
      i.placeholder = ph;
      i.value = (typeof f[key] === 'string' ? (lang === 'de' ? f[key] : '') : f[key]?.[lang]) || '';
      return i;
    };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'opt-del'; del.textContent = '✕'; del.title = 'Entfernen';
    del.addEventListener('click', () => { li.remove(); setStatus('Nicht gespeichert'); });
    li.append(field('title', 'de', 'Titel'), field('title', 'en', 'Title'), field('desc', 'de', 'Beschreibung (optional)'), field('desc', 'en', 'Description (optional)'), del);
    li.addEventListener('input', () => setStatus('Nicht gespeichert'));
    return li;
  }
  const setStatus = (msg, kind = '') => { const s = $('#optStatus'); s.textContent = msg; s.className = 'opt-status ' + kind; };

  $('#optAdd').addEventListener('click', () => {
    const li = optRow();
    $('#optList').append(li);
    li.querySelector('input').focus();
    setStatus('Nicht gespeichert');
  });

  $('#optForm').addEventListener('submit', async e => {
    e.preventDefault();
    const used = new Set([...$('#optList').children].map(li => li.dataset.id).filter(Boolean));
    const features = [];
    for (const li of $('#optList').children) {
      const val = (k, l) => li.querySelector(`[data-key="${k}"][data-lang="${l}"]`).value.trim();
      const title = { de: val('title', 'de'), en: val('title', 'en') };
      if (!title.de && !title.en) continue; // empty rows are dropped
      let id = li.dataset.id;
      if (!id) {
        const base = slug(title.de || title.en);
        id = base; for (let n = 2; used.has(id); n++) id = base + '-' + n;
        used.add(id);
      }
      features.push({ id, title, desc: { de: val('desc', 'de'), en: val('desc', 'en') } });
    }
    if (!features.length) return setStatus('Mindestens eine Option nötig', 'err');
    setStatus('Speichert …');
    try {
      const res = await fetch('/api/features?token=' + encodeURIComponent(token), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ features }),
      });
      if (res.status === 401) return dropToken();
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      $('#optList').replaceChildren(...out.features.map(optRow));
      setStatus('Gespeichert ✓', 'ok');
    } catch (err) {
      setStatus('Fehler: ' + (err.message || 'nicht gespeichert'), 'err');
    }
  });

  $('#tokenForm').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('#tokenInput').value.trim();
    const ok = (await fetch('/api/admin?token=' + encodeURIComponent(t))).ok;
    $('#tokenError').hidden = ok;
    if (!ok) return;
    token = t; ss.set(TOKEN_KEY, t);
    $('#exportLink').hidden = false;
    $('#exportLink').href = '/api/export.csv?token=' + encodeURIComponent(token);
    setView(view);
  });

  function dropToken() {
    token = ''; ss.set(TOKEN_KEY, '');
    $('#exportLink').hidden = true;
    $('#tokenError').hidden = false;
    setView(view);
  }

  // ---------- Antworten ansehen und löschen (needs the admin token) ----------
  const fmtTime = iso => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  async function openResponses() {
    const [cfg, res] = await Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/responses?token=' + encodeURIComponent(token)),
    ]);
    if (res.status === 401) return dropToken();
    const { responses } = await res.json();
    const titleOf = (r, id) => tx(cfg.features.find(f => f.id === id)?.title) || r.custom.find(c => c.id === id)?.text || id;
    $('#respCount').textContent = responses.length || '';
    $('#respEmpty').hidden = responses.length > 0;
    $('#respList').replaceChildren(...responses.map(r => {
      const li = document.createElement('li');
      li.className = 'resp';
      const head = document.createElement('div');
      head.className = 'resp-head';
      const who = document.createElement('strong');
      who.textContent = [r.name, r.email].filter(Boolean).join(' · ') || 'anonym';
      const meta = document.createElement('span');
      meta.className = 'resp-meta';
      meta.textContent = fmtTime(r.created_at) + (r.lang ? ' · ' + r.lang.toUpperCase() : '');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'opt-btn resp-del'; del.textContent = 'Löschen';
      del.addEventListener('click', async () => {
        if (!confirm('Diese Antwort endgültig löschen?')) return;
        const d = await fetch(`/api/responses/${r.id}?token=` + encodeURIComponent(token), { method: 'DELETE' });
        if (d.status === 401) return dropToken();
        openResponses();
      });
      head.append(who, meta, del);
      li.append(head);
      for (const [b, label] of [['want', '🔥'], ['nice', '✨'], ['no', '💤']]) {
        const ids = r.buckets[b] || [];
        if (!ids.length) continue;
        const p = document.createElement('p');
        p.className = 'resp-line resp-' + b;
        p.textContent = label + ' ' + ids.map((id, i) => (b === 'want' ? `${i + 1}. ` : '') + titleOf(r, id)).join(', ');
        li.append(p);
      }
      for (const [id, text] of Object.entries(r.comments)) {
        const p = document.createElement('p');
        p.className = 'resp-comment';
        p.textContent = `💬 ${titleOf(r, id)}: ${text}`;
        li.append(p);
      }
      return li;
    }));
  }
  const ADMIN_VIEWS = { options: openOptions, responses: openResponses };
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    // fresh bubble layout for the new size instead of squeezing the old positions
    resizeT = setTimeout(() => { bubblePos.clear(); if (prev) { renderCluster(prev, new Map()); renderRanking(prev, new Map(prev.features.map((f, i) => [f.id, { ...f, pos: i }]))); } }, 200);
  });

  connect();
  setView('qr');
})();
