// Sync module — mirrors completed sessions to Supabase via PostgREST.
// Offline-first: localStorage stays the source of truth. Sync does NOT
// run live — writes queue locally and drain on a single daily run at
// 9:00 PM America/New_York, or whenever the user taps "Sync Now".
window.Sync = (() => {
  const QUEUE_KEY      = 'pedal-tracker-sync-queue';
  const DEAD_KEY       = 'pedal-tracker-sync-deadletter';
  const DEVICE_KEY     = 'pedal-tracker-device-id';
  const HISTORY_KEY    = 'pedal-tracker-history';
  const SYNCED_IDS_KEY = 'pedal-tracker-synced-ids';
  const LAST_SYNC_KEY  = 'pedal-tracker-last-sync-at';
  const PULL_LIMIT   = 500;
  const REQUEST_MS   = 10000;
  const MAX_FAILURES = 3;
  const SCHEDULED_HOUR_ET = 21; // 9 PM America/New_York

  let cfg = null;
  let state = 'disabled';
  let queue = [];
  let syncedIds = new Set();
  let lastSyncAt = null;
  const listeners = [];
  let scheduleTimer = null;
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
  function loadSyncedIds() {
    try {
      const arr = JSON.parse(localStorage.getItem(SYNCED_IDS_KEY)) || [];
      syncedIds = new Set(arr.map(Number));
    } catch (e) { syncedIds = new Set(); }
  }
  function persistSyncedIds() {
    try { localStorage.setItem(SYNCED_IDS_KEY, JSON.stringify(Array.from(syncedIds))); }
    catch (e) {}
  }
  function loadLastSyncAt() {
    lastSyncAt = localStorage.getItem(LAST_SYNC_KEY) || null;
  }
  function setLastSyncAt(iso) {
    lastSyncAt = iso;
    try { localStorage.setItem(LAST_SYNC_KEY, iso); } catch (e) {}
  }
  function markSynced(id) {
    if (id == null) return;
    syncedIds.add(Number(id));
    persistSyncedIds();
  }
  function markUnsynced(id) {
    if (id == null) return;
    if (syncedIds.delete(Number(id))) persistSyncedIds();
  }
  function pushDead(item, reason) {
    let dead = [];
    try { dead = JSON.parse(localStorage.getItem(DEAD_KEY)) || []; } catch (e) {}
    dead.push({ ...item, reason, droppedAt: new Date().toISOString() });
    try { localStorage.setItem(DEAD_KEY, JSON.stringify(dead)); } catch (e) {}
  }

  function setState(next) {
    if (state !== next) state = next;
    notify();
  }
  function notify() {
    const snapshot = { state, queueLen: queue.length, lastSyncAt };
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
      markSynced(item.payload && item.payload.id);
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
      markUnsynced(item.payload);
      return;
    }
  }

  // Queue upserts for any local sessions that haven't been confirmed on the
  // server yet. Run on init so existing-on-device data gets backed up.
  function queueLocalBackup() {
    let local = [];
    try { local = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return 0; }
    if (!local.length) return 0;
    const queuedUpsertIds = new Set(
      queue.filter(i => i.op === 'upsert' && i.payload && i.payload.id != null)
           .map(i => Number(i.payload.id))
    );
    let added = 0;
    for (const s of local) {
      if (!s || s.id == null) continue;
      const id = Number(s.id);
      if (syncedIds.has(id) || queuedUpsertIds.has(id)) continue;
      queue.push({ op: 'upsert', payload: s });
      queuedUpsertIds.add(id);
      added++;
    }
    if (added) persistQueue();
    return added;
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
            return;
          }
          setState('offline');
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
      return;
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) setState('error');
      else setState('offline');
      return;
    }
    let rows;
    try { rows = await res.json(); } catch (e) { return; }
    if (!Array.isArray(rows)) { notify(); return; }

    // Server-confirmed rows are synced by definition — record them so we
    // don't redundantly re-upload on later inits.
    let dirtySynced = false;
    rows.forEach(r => {
      if (r && r.id != null) {
        const id = Number(r.id);
        if (!syncedIds.has(id)) { syncedIds.add(id); dirtySynced = true; }
      }
    });
    if (dirtySynced) persistSyncedIds();

    if (!rows.length) { notify(); return; }

    // Don't resurrect rows the user has locally deleted but whose delete
    // hasn't been flushed yet.
    const pendingDeletes = new Set(
      queue.filter(i => i.op === 'delete' && i.payload != null)
           .map(i => Number(i.payload))
    );

    let local = [];
    try { local = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { local = []; }
    const seen = new Set(local.map(s => s.id));
    let added = 0;
    for (const r of rows) {
      const s = fromRow(r);
      if (pendingDeletes.has(s.id)) continue;
      if (!seen.has(s.id)) { local.push(s); seen.add(s.id); added++; }
    }
    if (added) {
      local.sort((a, b) => b.id - a.id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(local)); } catch (e) {}
    }
    notify();
  }

  // Full sync round-trip: drain queue, pull remote, drain again to cover
  // anything queued during pull. Only stamps lastSyncAt on full success.
  async function runFullSync() {
    if (!configured()) return;
    await flush();
    if (state === 'offline' || state === 'error') return;
    await pull();
    if (state === 'offline' || state === 'error') return;
    await flush();
    if (state === 'offline' || state === 'error') return;
    setLastSyncAt(new Date().toISOString());
    notify();
  }

  // Returns the UTC instant of the next 9:00 PM in America/New_York.
  // DST is handled implicitly by reading the current ET wall-clock; a
  // sleep that crosses a DST boundary may fire up to an hour off, but
  // the next scheduleNext9pmET() call after firing self-corrects.
  function nextNinePmET() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(now).reduce((o, p) => {
      if (p.type !== 'literal') o[p.type] = p.value;
      return o;
    }, {});
    // hour12:false may emit '24' for midnight in some locales — normalize.
    const hour = parts.hour === '24' ? 0 : +parts.hour;
    // Treat ET wall-clock as if it were UTC to compute the offset.
    const etAsUtc = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      hour, +parts.minute, +parts.second
    );
    const etOffsetMs = etAsUtc - now.getTime();
    // Today's 21:00 ET as a UTC instant.
    let target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, SCHEDULED_HOUR_ET, 0, 0) - etOffsetMs;
    if (target <= now.getTime()) {
      target += 24 * 60 * 60 * 1000;
    }
    return new Date(target);
  }

  function scheduleNext9pmET() {
    clearTimeout(scheduleTimer);
    if (!configured()) return;
    const target = nextNinePmET();
    const delayMs = Math.max(1000, target.getTime() - Date.now());
    scheduleTimer = setTimeout(() => {
      runFullSync().finally(scheduleNext9pmET);
    }, delayMs);
  }

  return {
    init() {
      cfg = window.APP_CONFIG || null;
      loadQueue();
      loadSyncedIds();
      loadLastSyncAt();
      if (!configured()) { setState('disabled'); return; }
      queueLocalBackup();
      setState('idle');
      scheduleNext9pmET();
    },
    upsert(s) {
      if (state === 'disabled') return;
      markUnsynced(s && s.id);
      queue.push({ op: 'upsert', payload: s });
      persistQueue();
      notify();
    },
    remove(id) {
      if (state === 'disabled') return;
      queue.push({ op: 'delete', payload: id });
      persistQueue();
      notify();
    },
    removeAll(ids) {
      if (state === 'disabled') return;
      ids.forEach(id => queue.push({ op: 'delete', payload: id }));
      persistQueue();
      notify();
    },
    syncNow() {
      if (!configured() || flushing) return Promise.resolve();
      return runFullSync();
    },
    pull,
    flush,
    subscribe(fn) {
      listeners.push(fn);
      try { fn({ state, queueLen: queue.length, lastSyncAt }); } catch (e) {}
    },
    getState() { return { state, queueLen: queue.length, lastSyncAt }; },
    getLastSyncAt() { return lastSyncAt; },
    // Exposed for testing — schedules a one-shot sync N ms from now.
    _scheduleInMs(ms) {
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(() => {
        runFullSync().finally(scheduleNext9pmET);
      }, Math.max(0, ms));
    },
    _nextScheduledAt() {
      return nextNinePmET().toISOString();
    }
  };
})();
