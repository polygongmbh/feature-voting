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
  let view = 'ranking';

  // Token aus der URL entfernen, damit er nicht in Screenshots/Verlauf landet
  if (params.get('token')) {
    ss.set(TOKEN_KEY, token);
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }

  function showGate(error) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#gateError').hidden = !error;
    $('#gateInput').focus();
  }
  $('#gateForm').addEventListener('submit', e => {
    e.preventDefault();
    token = $('#gateInput').value.trim();
    ss.set(TOKEN_KEY, token);
    connect();
  });

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

  function connect() {
    if (!token) return showGate(false);
    if (es) es.close();
    // Token vorab prüfen, weil EventSource keinen Statuscode liefert
    fetch('/api/stream?token=' + encodeURIComponent(token)).then(res => {
      if (res.status === 401) { showGate(true); return; }
      res.body?.cancel();
      $('#gate').hidden = true;
      $('#app').hidden = false;
      $('#exportLink').href = '/api/export.csv?token=' + encodeURIComponent(token);
      es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
      es.addEventListener('update', ev => update(JSON.parse(ev.data)));
      es.onopen = () => $('#liveDot').classList.add('on');
      es.onerror = () => $('#liveDot').classList.remove('on');
    }).catch(() => setTimeout(connect, 3000));
  }

  // ---------- Update ----------
  function update(data) {
    $('#title').textContent = data.title || 'Live-Auswertung';
    document.title = 'Live: ' + (data.title || 'Auswertung');
    $('#emptyState').hidden = data.total > 0;

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
    const g = [34, 197, 94], a = [245, 158, 11], s = [100, 116, 139];
    const mix = (c1, c2, k) => c1.map((v, i) => Math.round(v + (c2[i] - v) * k));
    const c = lean >= 0.5 ? mix(a, g, (lean - 0.5) * 2) : mix(s, a, lean * 2);
    return `radial-gradient(circle at 30% 25%, rgb(${c.map(v => Math.min(255, v + 60))}), rgb(${c}))`;
  }

  function renderCluster(data, prevById) {
    const area = $('#bubbles');
    const W = area.clientWidth || 900, H = area.clientHeight || 600;
    const maxN = Math.max(1, ...data.features.map(f => f.n));
    const minD = Math.max(80, Math.min(W, H) * 0.14), maxD = Math.max(140, Math.min(W, H) * 0.3);
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
      el.style.fontSize = n.r < 55 ? '.8em' : '';
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
  document.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => {
    view = btn.dataset.view;
    document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    if (prev) { const p = prev; renderCluster(p, new Map()); renderRanking(p, new Map(p.features.map((f, i) => [f.id, { ...f, pos: i }]))); }
  }));
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (prev) { renderCluster(prev, new Map()); renderRanking(prev, new Map(prev.features.map((f, i) => [f.id, { ...f, pos: i }]))); } }, 200);
  });

  connect();
})();
