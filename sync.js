// Sync module — mirrors completed sessions to Supabase via PostgREST.
// Offline-first: localStorage stays the source of truth; this is a fan-out
// + startup pull-and-merge. No SDK; raw fetch keeps the app dependency-free.
window.Sync = (() => {
  const QUEUE_KEY    = 'pedal-tracker-sync-queue';
  const DEAD_KEY     = 'pedal-tracker-sync-deadletter';
  const DEVICE_KEY   = 'pedal-tracker-device-id';
  const HISTORY_KEY  = 'pedal-tracker-history';
  const PULL_LIMIT   = 500;
  const RETRY_MS     = 30000;
  const REQUEST_MS   = 10000;
  const MAX_FAILURES = 3;

  let cfg = null;
  let state = 'disabled';
  let queue = [];
  const listeners = [];
  let retryTimer = null;
  let flushing = false;

  const deviceId = (() => {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = (crypto.randomUUID && crypto.randomUUID()) ||
          ('dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  })();

  function persistQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
  }
  function loadQueue() {
    try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
    catch (e) { queue = []; }
  }
  function pushDead(item, reason) {
    let dead = [];
    try { dead = JSON.parse(localStorage.getItem(DEAD_KEY)) || []; } catch (e) {}
    dead.push({ ...item, reason, droppedAt: new Date().toISOString() });
    try { localStorage.setItem(DEAD_KEY, JSON.stringify(dead)); } catch (e) {}
  }

  function setState(next) {
    if (state === next) {
      notify();
      return;
    }
    state = next;
    notify();
  }
  function notify() {
    const snapshot = { state, queueLen: queue.length };
    listeners.forEach(fn => { try { fn(snapshot); } catch (e) {} });
  }

  function configured() {
    return cfg && cfg.supabaseUrl && cfg.supabaseAnonKey &&
      !cfg.supabaseUrl.includes('YOUR-PROJECT') &&
      !cfg.supabaseAnonKey.includes('YOUR-ANON-KEY');
  }

  function headers(extra) {
    return Object.assign({
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + cfg.supabaseAnonKey,
      'Content-Type': 'application/json'
    }, extra || {});
  }

  function toRow(s) {
    return {
      id: s.id,
      start_time: s.startTime,
      end_time: s.endTime || null,
      active_section: s.activeSection,
      sections: s.sections,
      device_id: deviceId
    };
  }
  function fromRow(r) {
    return {
      id: Number(r.id),
      startTime: r.start_time,
      endTime: r.end_time || undefined,
      activeSection: r.active_section,
      sections: r.sections
    };
  }

  function fetchWithTimeout(url, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_MS);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal }))
      .finally(() => clearTimeout(t));
  }

  async function performOp(item) {
    if (item.op === 'upsert') {
      const res = await fetchWithTimeout(cfg.supabaseUrl + '/rest/v1/sessions', {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(toRow(item.payload))
      });
      if (!res.ok) {
        const err = new Error('http ' + res.status);
        err.status = res.status;
        throw err;
      }
      return;
    }
    if (item.op === 'delete') {
      const res = await fetchWithTimeout(
        cfg.supabaseUrl + '/rest/v1/sessions?id=eq.' + encodeURIComponent(item.payload),
        { method: 'DELETE', headers: headers() }
      );
      if (!res.ok) {
        const err = new Error('http ' + res.status);
        err.status = res.status;
        throw err;
      }
      return;
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, RETRY_MS);
  }

  async function flush() {
    if (!configured() || flushing) return;
    if (!queue.length) { setState('idle'); return; }
    flushing = true;
    setState('syncing');
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          await performOp(item);
          queue.shift();
          persistQueue();
          notify();
        } catch (e) {
          if (e.status >= 400 && e.status < 500) {
            item.failures = (item.failures || 0) + 1;
            if (item.failures >= MAX_FAILURES) {
              pushDead(item, 'http ' + e.status);
              queue.shift();
              persistQueue();
              continue;
            }
            persistQueue();
            setState('error');
            scheduleRetry();
            return;
          }
          setState('offline');
          scheduleRetry();
          return;
        }
      }
      setState('idle');
    } finally {
      flushing = false;
    }
  }

  async function pull() {
    if (!configured()) return;
    let res;
    try {
      res = await fetchWithTimeout(
        cfg.supabaseUrl + '/rest/v1/sessions?select=*&order=start_time.desc&limit=' + PULL_LIMIT,
        { method: 'GET', headers: headers() }
      );
    } catch (e) {
      setState('offline');
      scheduleRetry();
      return;
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) setState('error');
      else setState('offline');
      scheduleRetry();
      return;
    }
    let rows;
    try { rows = await res.json(); } catch (e) { return; }
    if (!Array.isArray(rows) || !rows.length) { notify(); return; }

    let local = [];
    try { local = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { local = []; }
    const seen = new Set(local.map(s => s.id));
    let added = 0;
    for (const r of rows) {
      const s = fromRow(r);
      if (!seen.has(s.id)) { local.push(s); seen.add(s.id); added++; }
    }
    if (added) {
      local.sort((a, b) => b.id - a.id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(local)); } catch (e) {}
    }
    notify();
  }

  return {
    init() {
      cfg = window.APP_CONFIG || null;
      loadQueue();
      if (!configured()) { setState('disabled'); return; }
      setState(queue.length ? 'idle' : 'idle');
      window.addEventListener('online', () => flush());
      pull().then(() => flush());
    },
    upsert(s) {
      if (state === 'disabled') return;
      queue.push({ op: 'upsert', payload: s });
      persistQueue();
      notify();
      flush();
    },
    remove(id) {
      if (state === 'disabled') return;
      queue.push({ op: 'delete', payload: id });
      persistQueue();
      notify();
      flush();
    },
    removeAll(ids) {
      if (state === 'disabled') return;
      ids.forEach(id => queue.push({ op: 'delete', payload: id }));
      persistQueue();
      notify();
      flush();
    },
    pull,
    flush,
    subscribe(fn) {
      listeners.push(fn);
      try { fn({ state, queueLen: queue.length }); } catch (e) {}
    },
    getState() { return { state, queueLen: queue.length }; }
  };
})();
