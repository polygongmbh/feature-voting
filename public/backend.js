// Backend-Adapter: dasselbe Frontend läuft mit dem Node-Server (SSE) und dem PHP-Port (Polling).
// why: der PHP-Build setzt <meta name="fv-backend" content="php"> und schaltet damit Endpunkte und Live-Transport um.
(() => {
  'use strict';

  const isPhp = document.querySelector('meta[name="fv-backend"]')?.content === 'php';
  const enc = encodeURIComponent;

  const urls = isPhp ? {
    config: 'api.php?a=config',
    submit: 'api.php?a=submit',
    stats: t => `api.php?a=stats&token=${enc(t)}`,
    export: t => `api.php?a=export&token=${enc(t)}`,
  } : {
    config: 'api/config',
    submit: 'api/responses',
    stream: t => `api/stream?token=${enc(t)}`,
    export: t => `api/export.csv?token=${enc(t)}`,
  };

  function subscribeSse(token, h) {
    let es = null, stopped = false, retry;
    // Token vorab prüfen, weil EventSource keinen Statuscode liefert
    const start = () => fetch(urls.stream(token)).then(res => {
      if (stopped) return;
      if (res.status === 401) { h.onUnauthorized(); return; }
      res.body?.cancel();
      es = new EventSource(urls.stream(token));
      es.addEventListener('update', ev => h.onData(JSON.parse(ev.data)));
      es.onopen = () => h.onStatus(true);
      es.onerror = () => h.onStatus(false);
    }).catch(() => { retry = setTimeout(start, 3000); });
    start();
    return () => { stopped = true; clearTimeout(retry); es?.close(); };
  }

  function subscribePolling(token, h) {
    let timer, stopped = false, lastSig = '';
    const poll = async () => {
      try {
        const res = await fetch(urls.stats(token), { cache: 'no-store' });
        if (res.status === 401) { h.onUnauthorized(); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        h.onStatus(true);
        const sig = `${data.total}|${JSON.stringify(data.features)}|${data.ideas.length}`;
        if (sig !== lastSig) { lastSig = sig; h.onData(data); }
      } catch {
        h.onStatus(false);
      }
      if (!stopped) timer = setTimeout(poll, document.hidden ? 10000 : 2000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }

  window.fvBackend = {
    kind: isPhp ? 'php' : 'node',
    urls,
    // h: { onData(stats), onUnauthorized(), onStatus(connected) }; gibt eine Abmelde-Funktion zurück
    subscribe: (token, h) => (isPhp ? subscribePolling : subscribeSse)(token, h),
  };
})();
