(() => {
  'use strict';

  const BUCKETS = ['want', 'nice', 'no'];
  const DRAFT_KEY = 'fv-draft-v1';
  const DONE_KEY = 'fv-submitted-v1';

  const I18N = {
    de: {
      ideaLabel: 'Fehlt dir etwas?', poolHint: 'Einfach von oben nach unten durchgehen',
      pool: 'Noch zu sortieren', want: 'Das will ich!', nice: 'Das wäre nett', no: 'Brauche ich nicht',
      wantHint: 'Ganz oben = am wichtigsten', dropHere: 'Noch leer. Hierher ziehen oder antippen.', poolEmpty: 'Alles sortiert 🎉',
      ideaPlaceholder: 'Deine Idee …', add: 'Hinzufügen', yourIdea: 'Deine Idee',
      ideaLimit: n => `Maximal ${n} eigene Ideen.`, ideaAdded: 'Idee unter "Das will ich!" eingefügt.',
      next: 'Weiter', progress: (a, b, c) => `${a} will ich · ${b} nett · ${c} nein`,
      needOne: 'Sortiere mindestens ein Feature ein.',
      unsortedLeft: n => `${n} noch offen. Trotzdem weiter?`,
      detailsTitle: 'Fast geschafft', detailsIntro: 'Name und E-Mail sind freiwillig. Du kannst auch einfach anonym abschicken.',
      name: 'Name (optional)', email: 'E-Mail (optional)', emailInvalid: 'Die E-Mail-Adresse sieht nicht richtig aus.',
      back: 'Zurück', submit: 'Abschicken', sending: 'Wird gesendet …',
      submitFail: 'Das hat nicht geklappt. Bitte versuch es nochmal.',
      thanks: 'Danke dir!', tfButton: 'Zur TestFlight-Beta',
      backToPool: 'Zurück in den Stapel', toTop: 'Ganz nach oben', delete: 'Idee löschen', close: 'Schließen',
      movedTo: b => `→ ${I18N.de[b]}`, langSwitch: 'EN',
      quickWant: 'Will ich', quickNice: 'Nett', quickNo: 'Nein',
      openMenu: 'Optionen',
      comment: 'Kommentar', commentLabel: 'Kommentar (optional)', commentPlaceholder: 'Was ist dir dabei wichtig?',
    },
    en: {
      ideaLabel: 'Something missing?', poolHint: 'Just go from top to bottom',
      pool: 'To sort', want: 'I want this!', nice: 'Nice to have', no: "Don't need it",
      wantHint: 'Top = most important', dropHere: 'Empty. Drag here or tap a card.', poolEmpty: 'All sorted 🎉',
      ideaPlaceholder: 'Your idea …', add: 'Add', yourIdea: 'Your idea',
      ideaLimit: n => `Up to ${n} ideas of your own.`, ideaAdded: 'Idea added under "I want this!".',
      next: 'Next', progress: (a, b, c) => `${a} want · ${b} nice · ${c} no`,
      needOne: 'Sort at least one feature.',
      unsortedLeft: n => `${n} still open. Continue anyway?`,
      detailsTitle: 'Almost done', detailsIntro: 'Name and email are optional. You can also submit anonymously.',
      name: 'Name (optional)', email: 'Email (optional)', emailInvalid: "That email address doesn't look right.",
      back: 'Back', submit: 'Submit', sending: 'Sending …',
      submitFail: "That didn't work. Please try again.",
      thanks: 'Thank you!', tfButton: 'Join the TestFlight beta',
      backToPool: 'Back to the pile', toTop: 'Move to top', delete: 'Delete idea', close: 'Close',
      movedTo: b => `→ ${I18N.en[b]}`, langSwitch: 'DE',
      quickWant: 'Want', quickNice: 'Nice', quickNo: 'No',
      openMenu: 'Options',
      comment: 'Comment', commentLabel: 'Comment (optional)', commentPlaceholder: 'What matters to you here?',
    },
  };

  // ---------- State ----------
  let cfg = null;
  let lang = 'de';
  let state = { order: { want: [], nice: [], no: [] }, custom: [], comments: {} };
  let sheetId = null;
  let justDragged = false;

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const t = (k, ...a) => { const v = I18N[lang][k] ?? I18N.de[k] ?? k; return typeof v === 'function' ? v(...a) : v; };
  const ct = v => (typeof v === 'string' ? v : (v?.[lang] ?? v?.[cfg?.defaultLang] ?? Object.values(v || {})[0] ?? ''));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
  };

  const featureById = id => cfg.features.find(f => f.id === id) || state.custom.find(c => c.id === id);
  const isCustom = id => id.startsWith('c_');
  const totalItems = () => cfg.features.length + state.custom.length;
  // why: every participant starts from their own random order, so list position can't bias the votes
  const shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------- Start ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    if (params.has('reset')) { store.del(DRAFT_KEY); store.del(DONE_KEY); }

    try {
      const res = await fetch('/api/config');
      cfg = await res.json();
    } catch {
      document.body.innerHTML = '<p style="padding:2rem;font-family:system-ui">Konnte die Umfrage nicht laden. / Could not load the survey.</p>';
      return;
    }

    const navLang = (navigator.language || '').slice(0, 2);
    lang = params.get('lang') || store.get('fv-lang') || (I18N[navLang] ? navLang : cfg.defaultLang) || 'de';
    if (!I18N[lang]) lang = 'de';

    loadDraft();
    setupSortable();
    bindEvents();
    applyLang();

    if (store.get(DONE_KEY)) showStep('done');
  }

  function loadDraft() {
    const ids = cfg.features.map(f => f.id);
    const draft = store.get(DRAFT_KEY);
    if (draft?.order && Array.isArray(draft.custom)) {
      state.custom = draft.custom.filter(c => c && /^c_/.test(c.id) && c.text);
      const valid = new Set([...ids, ...state.custom.map(c => c.id)]);
      const seen = new Set();
      for (const b of BUCKETS) {
        state.order[b] = (draft.order[b] || []).filter(id => valid.has(id) && !seen.has(id) && seen.add(id));
      }
      // neue Features aus der Config landen in der Mitte
      state.order.nice.push(...shuffle([...valid].filter(id => !seen.has(id))));
      const comments = draft.comments && typeof draft.comments === 'object' ? draft.comments : {};
      state.comments = Object.fromEntries(Object.entries(comments).filter(([id, c]) => valid.has(id) && typeof c === 'string'));
    } else {
      state.order.nice = shuffle(ids);
    }
  }
  const saveDraft = () => store.set(DRAFT_KEY, state);

  // ---------- Rendering ----------
  function cardEl(id) {
    const item = featureById(id);
    const el = document.createElement('div');
    el.className = 'card' + (isCustom(id) ? ' custom' : '');
    el.dataset.id = id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const handle = document.createElement('span');
    handle.className = 'grip';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '≡';
    el.appendChild(handle);

    const rank = document.createElement('span');
    rank.className = 'rank';
    el.appendChild(rank);

    const body = document.createElement('div');
    body.className = 'card-body';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = isCustom(id) ? item.text : ct(item.title);
    body.appendChild(title);
    const descText = isCustom(id) ? t('yourIdea') : ct(item.desc);
    if (descText) {
      const desc = document.createElement('div');
      desc.className = 'card-desc';
      desc.textContent = descText;
      body.appendChild(desc);
    }
    el.appendChild(body);

    const note = document.createElement('button');
    note.type = 'button';
    note.className = 'note-btn' + (state.comments[id] ? ' has-note' : '');
    note.dataset.note = '';
    note.setAttribute('aria-label', t('comment'));
    note.title = state.comments[id] || t('comment');
    note.textContent = '💬';
    el.appendChild(note);

    return el;
  }

  const GROUP_META = {
    want: { icon: '🔥', hint: 'wantHint', empty: 'dropHere' },
    nice: { icon: '✨', hint: null, empty: 'dropHere' },
    no:   { icon: '💤', hint: null, empty: 'dropHere' },
  };

  function dividerEl(b) {
    const el = document.createElement('div');
    el.className = `divider divider-${b}` + (state.order[b].length ? '' : ' is-empty');
    el.dataset.group = b;
    const head = document.createElement('div');
    head.className = 'divider-head';
    head.innerHTML = `<span class="divider-icon">${GROUP_META[b].icon}</span><h2></h2><span class="count"></span>`;
    head.querySelector('h2').textContent = t(b);
    head.querySelector('.count').textContent = state.order[b].length || '';
    el.appendChild(head);
    if (GROUP_META[b].hint && state.order[b].length) {
      const hint = document.createElement('p');
      hint.className = 'divider-hint';
      hint.textContent = t(GROUP_META[b].hint);
      el.appendChild(hint);
    }
    const empty = document.createElement('p');
    empty.className = 'divider-empty';
    empty.textContent = t(GROUP_META[b].empty);
    el.appendChild(empty);
    return el;
  }

  function render(highlightId) {
    const nodes = [];
    for (const b of BUCKETS) {
      nodes.push(dividerEl(b));
      state.order[b].forEach((id, i) => {
        const c = cardEl(id);
        c.classList.add('in-' + b);
        if (b === 'want') c.querySelector('.rank').textContent = i + 1;
        nodes.push(c);
      });
    }
    $('#list').replaceChildren(...nodes);
    if (highlightId) {
      const el = document.querySelector(`.card[data-id="${CSS.escape(highlightId)}"]`);
      if (el) {
        el.classList.add('pop');
        setTimeout(() => el.classList.remove('pop'), 600);
      }
    }
    updateMeta();
  }

  function updateMeta() {
    $('#progressText').textContent = t('progress', state.order.want.length, state.order.nice.length, state.order.no.length);
    const total = totalItems() || 1;
    $('#progressFill').style.setProperty('--w', state.order.want.length / total * 100 + '%');
    $('#progressFill').style.setProperty('--n', state.order.nice.length / total * 100 + '%');
    $('#progressFill').style.setProperty('--x', state.order.no.length / total * 100 + '%');
  }

  function applyLang() {
    document.documentElement.lang = lang;
    $('#langBtn').textContent = t('langSwitch');
    $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    const title = ct(cfg.title);
    $('#title').textContent = title;
    document.title = title;
    $('#intro').textContent = ct(cfg.intro);
    $('#privacy').textContent = ct(cfg.privacy);
    $('#tfText').textContent = ct(cfg.testflight?.text);
    const url = cfg.testflight?.url || '';
    $('#tfLink').href = url || '#';
    $('#tfLink').hidden = !url;
    $('#tfUrl').textContent = url;
    render();
  }

  // ---------- Drag & Drop ----------
  function setupSortable() {
    Sortable.create($('#list'), {
      animation: 180,
      easing: 'cubic-bezier(.2,.8,.2,1)',
      // whole card drags; on touch a short hold starts the drag so swiping still scrolls
      delay: 150,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      draggable: '.card, .divider',
      filter: '.divider',
      preventOnFilter: false,
      ghostClass: 'ghost',
      chosenClass: 'chosen',
      dragClass: 'dragging',
      scroll: true,
      scrollSensitivity: 90,
      bubbleScroll: true,
      // Karten dürfen nicht über den ersten Abschnitt geschoben werden
      onMove: evt => !(evt.related === $('#list').firstElementChild && !evt.willInsertAfter),
      onStart: () => document.body.classList.add('is-dragging'),
      onEnd: () => {
        document.body.classList.remove('is-dragging');
        // why: some browsers fire a click after the drop, which would open the sheet
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0);
        syncFromDom();
      },
    });
  }

  function syncFromDom() {
    const order = { want: [], nice: [], no: [] };
    let current = 'want';
    for (const el of $('#list').children) {
      if (el.classList.contains('divider')) current = el.dataset.group;
      else if (el.dataset.id) order[current].push(el.dataset.id);
    }
    state.order = order;
    saveDraft();
    render();
  }

  function moveTo(id, target, { position = 'end' } = {}) {
    for (const b of BUCKETS) state.order[b] = state.order[b].filter(x => x !== id);
    if (position === 'top') state.order[target].unshift(id); else state.order[target].push(id);
    saveDraft();
    render(id);
  }

  function reorder(id, dir) {
    const b = BUCKETS.find(b => state.order[b].includes(id));
    const list = state.order[b];
    const i = list.indexOf(id);
    let j = dir === 'up' ? i - 1 : dir === 'down' ? i + 1 : 0;
    j = Math.max(0, Math.min(list.length - 1, j));
    if (i === j) return;
    list.splice(i, 1);
    list.splice(j, 0, id);
    saveDraft();
    render(id);
  }

  // ---------- Aktions-Sheet ----------
  function openSheet(id, focusComment = false) {
    sheetId = id;
    const item = featureById(id);
    const bucket = BUCKETS.find(b => state.order[b].includes(id));
    $('#sheetTitle').textContent = isCustom(id) ? item.text : ct(item.title);
    $('#sheetDesc').textContent = isCustom(id) ? t('yourIdea') : ct(item.desc);
    $$('.sheet-moves .move').forEach(btn => {
      btn.classList.toggle('current', btn.dataset.move === bucket);
    });
    const list = state.order[bucket];
    $('.sheet-order').hidden = list.length < 2;
    $('[data-order="top"]').disabled = $('[data-order="up"]').disabled = list[0] === id;
    $('[data-order="down"]').disabled = list[list.length - 1] === id;
    $('[data-delete]').hidden = !isCustom(id);
    $('#sheetComment').value = state.comments[id] || '';
    $('#sheet').hidden = false;
    requestAnimationFrame(() => $('#sheet').classList.add('open'));
    if (focusComment) $('#sheetComment').focus({ preventScroll: true });
    else $('.sheet-moves .move:not([hidden])').focus({ preventScroll: true });
  }
  function closeSheet() {
    const sheet = $('#sheet');
    if (sheetId) render(); // reflect a changed comment on the row
    sheet.classList.remove('open');
    const returnTo = sheetId;
    sheetId = null;
    setTimeout(() => { sheet.hidden = true; }, 220);
    const el = returnTo && document.querySelector(`.card[data-id="${CSS.escape(returnTo)}"]`);
    if (el) el.focus({ preventScroll: true });
  }

  // ---------- Schritte ----------
  function showStep(step) {
    for (const s of ['sort', 'details', 'done']) $(`#step-${s}`).hidden = s !== step;
    $$('.steps .dot').forEach((d, i) => d.classList.toggle('active', i <= ['sort', 'details', 'done'].indexOf(step)));
    if (step === 'details') renderSummary();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSummary() {
    const box = $('#summary');
    box.replaceChildren();
    for (const b of ['want', 'nice', 'no']) {
      if (!state.order[b].length) continue;
      const group = document.createElement('div');
      group.className = `sum-group sum-${b}`;
      const h = document.createElement('h3');
      h.textContent = t(b);
      group.appendChild(h);
      const ol = document.createElement(b === 'want' ? 'ol' : 'ul');
      for (const id of state.order[b]) {
        const li = document.createElement('li');
        const item = featureById(id);
        li.textContent = isCustom(id) ? item.text : ct(item.title);
        ol.appendChild(li);
      }
      group.appendChild(ol);
      box.appendChild(group);
    }
  }

  async function submit(e) {
    e.preventDefault();
    const email = $('#emailInput').value.trim();
    const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    $('#emailError').hidden = emailOk;
    if (!emailOk) { $('#emailInput').focus(); return; }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = t('sending');
    $('#submitError').hidden = true;

    const usedCustom = state.custom; // auch unsortierte Ideen mitschicken
    try {
      const res = await fetch('/api/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buckets: { want: state.order.want, nice: state.order.nice, no: state.order.no },
          custom: usedCustom,
          comments: Object.fromEntries(Object.entries(state.comments).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)),
          name: $('#nameInput').value.trim(),
          email,
          lang,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      store.set(DONE_KEY, true);
      store.del(DRAFT_KEY);
      showStep('done');
    } catch {
      $('#submitError').textContent = t('submitFail');
      $('#submitError').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = t('submit');
    }
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- Events ----------
  function bindEvents() {
    $('#langBtn').addEventListener('click', () => {
      lang = lang === 'de' ? 'en' : 'de';
      store.set('fv-lang', lang);
      applyLang();
    });

    $('#list').addEventListener('click', e => {
      const card = e.target.closest('.card');
      if (!card || justDragged) return;
      if (e.target.closest('[data-note]')) { openSheet(card.dataset.id, true); return; }
      const quick = e.target.closest('[data-quick]');
      if (quick) {
        moveTo(card.dataset.id, quick.dataset.quick);
        toast(t('movedTo', quick.dataset.quick));
        return;
      }
      openSheet(card.dataset.id);
    });
    $('#list').addEventListener('keydown', e => {
      const card = e.target.closest('.card');
      if (!card || e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(card.dataset.id); }
      if (e.key === '1') moveTo(card.dataset.id, 'want');
      if (e.key === '2') moveTo(card.dataset.id, 'nice');
      if (e.key === '3') moveTo(card.dataset.id, 'no');
    });

    $('#sheet').addEventListener('click', e => {
      if (!sheetId) return;
      const id = sheetId;
      if (e.target.closest('[data-close]')) return closeSheet();
      const move = e.target.closest('[data-move]');
      if (move) { closeSheet(); moveTo(id, move.dataset.move); return; }
      const order = e.target.closest('[data-order]');
      if (order) { reorder(id, order.dataset.order); openSheet(id); return; }
      if (e.target.closest('[data-delete]')) {
        state.custom = state.custom.filter(c => c.id !== id);
        delete state.comments[id];
        for (const b of BUCKETS) state.order[b] = state.order[b].filter(x => x !== id);
        saveDraft();
        closeSheet();
        render();
      }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetId) closeSheet(); });
    $('#sheetComment').addEventListener('input', e => {
      if (!sheetId) return;
      const v = e.target.value.slice(0, 500);
      if (v.trim()) state.comments[sheetId] = v; else delete state.comments[sheetId];
      saveDraft();
    });

    $('#ideaForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#ideaInput');
      const text = input.value.trim().replace(/\s+/g, ' ');
      if (!text) return;
      const max = cfg.maxCustomIdeas ?? 5;
      if (state.custom.length >= max) {
        $('#ideaHint').textContent = t('ideaLimit', max);
        $('#ideaHint').hidden = false;
        return;
      }
      const id = 'c_' + Math.random().toString(36).slice(2, 10);
      state.custom.push({ id, text });
      state.order.want.push(id);
      input.value = '';
      $('#ideaHint').hidden = true;
      saveDraft();
      render(id);
      toast(t('ideaAdded'));
    });

    $('#toDetails').addEventListener('click', () => showStep('details'));
    $('#backBtn').addEventListener('click', () => showStep('sort'));
    $('#detailsForm').addEventListener('submit', submit);
  }

  init();
})();
