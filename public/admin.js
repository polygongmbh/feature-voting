(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const TOKEN_KEY = 'fv-admin-token'; // shared with live.js
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* egal */ } },
  };
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || ss.get(TOKEN_KEY) || '';
  // keep the token out of the address bar (screenshots, history)
  if (params.get('token')) {
    ss.set(TOKEN_KEY, token);
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  }
  const withToken = path => path + '?token=' + encodeURIComponent(token);
  const slug = s => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const fmtDate = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  function showToken(error) {
    $('#panel').hidden = true;
    $('#tokenForm').hidden = false;
    $('#tokenError').hidden = !error;
    $('#tokenInput').focus();
  }

  async function load() {
    if (!token) return showToken(false);
    const res = await fetch(withToken('/api/surveys'));
    if (res.status === 401) { token = ''; ss.set(TOKEN_KEY, ''); return showToken(true); }
    const { surveys } = await res.json();
    $('#tokenForm').hidden = true;
    $('#panel').hidden = false;
    $('#empty').hidden = surveys.length > 0;
    $('#list').replaceChildren(...surveys.map(item));
    if (!surveys.length) $('#newTitle').focus();
  }

  function item(s) {
    const li = document.createElement('li');
    li.className = 'adm-item';
    const main = document.createElement('div');
    main.className = 'adm-main';
    const title = document.createElement('strong');
    title.textContent = s.title;
    const meta = document.createElement('span');
    meta.className = 'adm-meta';
    const id = document.createElement('code');
    id.textContent = '/' + s.id;
    meta.append(id, ` · ${s.total} ${s.total === 1 ? 'Antwort' : 'Antworten'} · ${s.options} ${s.options === 1 ? 'Option' : 'Optionen'} · ${fmtDate(s.created_at)}`);
    main.append(title, meta);
    const links = document.createElement('div');
    links.className = 'adm-links';
    for (const [label, href] of [['Umfrage', '/' + s.id], ['Live', '/' + s.id + '/live']]) {
      const a = document.createElement('a');
      a.className = 'opt-btn' + (label === 'Live' ? ' primary' : '');
      a.href = href; a.textContent = label;
      links.append(a);
    }
    li.append(main, links);
    return li;
  }

  $('#tokenForm').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('#tokenInput').value.trim();
    const ok = (await fetch('/api/admin?token=' + encodeURIComponent(t))).ok;
    $('#tokenError').hidden = ok;
    if (!ok) return;
    token = t; ss.set(TOKEN_KEY, t);
    load();
  });

  const hint = () => {
    const id = $('#newId').value.trim() || slug($('#newTitle').value);
    $('#newHint').textContent = id ? `Adresse: ${location.host}/${id}` : '';
  };
  $('#newTitle').addEventListener('input', hint);
  $('#newId').addEventListener('input', hint);

  $('#newForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { title: $('#newTitle').value.trim() };
    const id = $('#newId').value.trim();
    if (id) body.id = id;
    $('#newError').hidden = true;
    const res = await fetch(withToken('/api/surveys'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status === 401) { token = ''; ss.set(TOKEN_KEY, ''); return showToken(true); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#newError').textContent = out.error === 'bad survey id' ? 'Adresse ungültig oder reserviert (nur a-z, 0-9 und -).' : 'Fehler: ' + (out.error || res.status);
      $('#newError').hidden = false;
      return;
    }
    location.href = '/' + out.id + '/live#options';
  });

  load();
})();
