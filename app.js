// === CONSTANTS ===
const SECTIONS = ['CB-105', 'PVS', 'PVSI', 'SMS', 'OP222'];
const DEBOUNCE_MS = 200;
const SAVE_INTERVAL_MS = 5000;
const STORAGE_KEY = 'pedal-tracker-session';
const HISTORY_KEY = 'pedal-tracker-history';
const SETTINGS_KEY = 'pedal-tracker-settings';
const CONFIRM_TIMEOUT_MS = 3000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const HOLD_DELAY_MS = 250;
const HOLD_FILL_MS = 1750;
const HOLD_THRESHOLD_MS = HOLD_DELAY_MS + HOLD_FILL_MS;

// === STATE ===
let session = null;
let timerInterval = null;
let lastPressTime = 0;
let lastAlertedMinute = 0;
let endConfirmTimer = null;
let endConfirmPending = false;
let clearConfirmPending = false;
let clearConfirmTimer = null;
let deleteConfirmPending = false;
let deleteConfirmTimer = null;
let audioCtx = null;
let masterGain = null;
let statusTimeout = null;
let selectedSection = null;
let viewingHistorySession = null;
let bHoldTimer = null;
let bFillTimer = null;
let bHoldFired = false;
let endHoldTimer = null;
let endFillTimer = null;
const DEFAULT_THRESHOLDS = {
  'CB-105': { warning: 45, alert: 60 },
  'PVS':    { warning: 45, alert: 60 },
  'PVSI':   { warning: 45, alert: 60 },
  'SMS':    { warning: 45, alert: 60 },
  'OP222':  { warning: 45, alert: 60 }
};
const DEFAULT_GOAL_RATES = {
  'CB-105': 0, 'PVS': 0, 'PVSI': 0, 'SMS': 0, 'OP222': 0
};
const GOAL_STEP = 5;
const GOAL_MAX = 1000;
const VOLUME_STEP = 10;
const VOLUME_KEYS = ['press', 'minuteAlert', 'nudge'];
// Per-tone peak gain at 100% volume. Calibrated for comparable perceived loudness:
// press (230Hz) and nudge (180-220Hz) run louder to compensate for low-frequency
// ear sensitivity; the minute alert (880Hz) sits near peak sensitivity and needs less.
const TONE_PEAK = {
  press: 0.28,
  minuteAlert: 0.22,
  nudge: 0.30
};
let settings = {
  volumes: { press: 100, minuteAlert: 100, nudge: 100 },
  theme: 'dark',
  thresholds: {
    'CB-105': { warning: 45, alert: 60 },
    'PVS':    { warning: 45, alert: 60 },
    'PVSI':   { warning: 45, alert: 60 },
    'SMS':    { warning: 45, alert: 60 },
    'OP222':  { warning: 45, alert: 60 }
  },
  goalRates: { ...DEFAULT_GOAL_RATES }
};

// === DOM REFS ===
const $ = (id) => document.getElementById(id);

// === STORAGE ===
const Storage = {
  save(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
      // QuotaExceededError — unlikely but safe to ignore
    }
  },
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  clear() {
    localStorage.removeItem(STORAGE_KEY);
  },
  saveToHistory(s) {
    const history = Storage.loadHistory();
    const entry = JSON.parse(JSON.stringify(s));
    delete entry.undoStack;
    delete entry.active;
    history.unshift(entry);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {}
  },
  loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },
  deleteFromHistory(id) {
    const history = Storage.loadHistory().filter(s => s.id !== id);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {}
  },
  clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }
};

// === SETTINGS ===
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Legacy boolean → volume migration
    if (typeof parsed.pressBeep === 'boolean') {
      settings.volumes.press = parsed.pressBeep ? 100 : 0;
    }
    if (typeof parsed.minuteAlert === 'boolean') {
      settings.volumes.minuteAlert = parsed.minuteAlert ? 100 : 0;
    }
    if (parsed.volumes && typeof parsed.volumes === 'object') {
      VOLUME_KEYS.forEach(k => {
        const v = parseInt(parsed.volumes[k], 10);
        if (!isNaN(v) && v >= 0) {
          settings.volumes[k] = Math.max(0, Math.min(100, Math.round(v / VOLUME_STEP) * VOLUME_STEP));
        }
      });
    }
    if (parsed.theme === 'light' || parsed.theme === 'dark') settings.theme = parsed.theme;
    if (parsed.thresholds && typeof parsed.thresholds === 'object') {
      SECTIONS.forEach(q => {
        const qt = parsed.thresholds[q];
        if (qt && typeof qt === 'object') {
          const w = parseInt(qt.warning, 10);
          const a = parseInt(qt.alert, 10);
          if (!isNaN(w) && w > 0) settings.thresholds[q].warning = w;
          if (!isNaN(a) && a > 0) settings.thresholds[q].alert = a;
        }
      });
    }
    if (parsed.goalRates && typeof parsed.goalRates === 'object') {
      SECTIONS.forEach(q => {
        const g = parseInt(parsed.goalRates[q], 10);
        if (!isNaN(g) && g >= 0) settings.goalRates[q] = Math.min(g, GOAL_MAX);
      });
    }
  } catch (e) {}
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}

// === EXPORT / IMPORT ===
const Export = {
  _download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  toJSON() {
    const history = Storage.loadHistory();
    const payload = { exportedAt: new Date().toISOString(), version: 1, sessions: history };
    const date = new Date().toISOString().slice(0, 10);
    Export._download(JSON.stringify(payload, null, 2), `pedal-tracker-${date}.json`, 'application/json');
  },

  toCSV() {
    const history = Storage.loadHistory();
    const rows = [['id', 'date', 'section', 'count', 'duration_s',
                    'avg_interval_ms', 'min_interval_ms', 'max_interval_ms', 'rate_per_min']];
    history.forEach(s => {
      const start = new Date(s.startTime).getTime();
      const end = s.endTime ? new Date(s.endTime).getTime() : start;
      const durMs = end - start;
      const m = computeMetrics(s.activeSection, s);
      rows.push([
        s.id,
        new Date(s.startTime).toISOString(),
        s.activeSection,
        m.count,
        Math.round(durMs / 1000),
        m.intervals.length > 0 ? Math.round(m.avgInterval) : '',
        m.intervals.length > 0 ? m.minInterval : '',
        m.intervals.length > 0 ? m.maxInterval : '',
        (durMs / 60000) > 0.01 ? m.pressesPerMin.toFixed(2) : ''
      ]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const date = new Date().toISOString().slice(0, 10);
    Export._download(csv, `pedal-tracker-${date}.csv`, 'text/csv');
  },

  fromJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const incoming = Array.isArray(data) ? data : (data.sessions || []);
        if (!Array.isArray(incoming)) {
          Export._showBanner('Invalid backup file.', true);
          return;
        }
        const valid = incoming.filter(s => s && s.id && s.startTime && s.sections);
        if (valid.length === 0) {
          Export._showBanner('No valid sessions in file.', true);
          return;
        }
        const existing = Storage.loadHistory();
        const existingIds = new Set(existing.map(s => s.id));
        const added = valid.filter(s => !existingIds.has(s.id));
        const merged = [...added, ...existing];
        merged.sort((a, b) => b.id - a.id);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
        } catch {
          Export._showBanner('Storage full — import failed.', true);
          return;
        }
        Export._showBanner(added.length === 0
          ? 'Already up to date.'
          : `Imported ${added.length} new session(s).`);
        renderHistoryList();
      } catch {
        Export._showBanner('Could not parse file.', true);
      }
    };
    reader.readAsText(file);
  },

  _bannerTimer: null,
  _showBanner(msg, isError = false) {
    const banner = $('history-banner');
    banner.textContent = msg;
    banner.className = isError ? 'error' : '';
    banner.style.display = 'block';
    clearTimeout(Export._bannerTimer);
    Export._bannerTimer = setTimeout(() => { banner.style.display = 'none'; }, 3000);
  }
};

// === AUDIO ===
const SoundPlayer = {
  init() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  },

  playTone(freq, duration, startDelay = 0, attack = 0, peakGain = 0.5) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain || audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    const t = audioCtx.currentTime + startDelay;
    if (attack > 0) {
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peakGain, t + attack);
    } else {
      gain.gain.setValueAtTime(peakGain, t);
    }
    gain.gain.exponentialRampToValueAtTime(0.01, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  },

  _scaled(key) {
    const vol = (settings.volumes[key] || 0) / 100;
    return TONE_PEAK[key] * vol;
  },

  playPressClick() {
    const g = SoundPlayer._scaled('press');
    if (g <= 0) return;
    SoundPlayer.playTone(230, 0.2, 0, 0.006, g);
  },

  playMinuteAlert() {
    const g = SoundPlayer._scaled('minuteAlert');
    if (g <= 0) return;
    SoundPlayer.playTone(880, 0.15, 0, 0, g);
    SoundPlayer.playTone(880, 0.15, 0.25, 0, g);
  },

  playNudge() {
    const g = SoundPlayer._scaled('nudge');
    if (g <= 0) return;
    SoundPlayer.playTone(220, 0.15, 0, 0, g);
    SoundPlayer.playTone(180, 0.15, 0.18, 0, g);
  }
};

// === SESSION ===
function createSession() {
  return {
    id: Date.now(),
    startTime: new Date().toISOString(),
    sections: {
      'CB-105': { count: 0, timestamps: [] },
      'PVS':    { count: 0, timestamps: [] },
      'PVSI':   { count: 0, timestamps: [] },
      'SMS':    { count: 0, timestamps: [] },
      'OP222':  { count: 0, timestamps: [] }
    },
    activeSection: selectedSection,
    active: true,
    undoStack: []
  };
}

function getLastTimestamp(sectionName) {
  const sec = session.sections[sectionName];
  if (sec.timestamps.length === 0) return null;
  return sec.timestamps[sec.timestamps.length - 1];
}

function getElapsedMs() {
  const lastTs = getLastTimestamp(session.activeSection);
  const ref = lastTs || new Date(session.startTime).getTime();
  return Date.now() - ref;
}

function computeMetrics(sectionName, s) {
  s = s || session;
  const sec = s.sections[sectionName];
  const ts = sec.timestamps;
  const sessionStart = new Date(s.startTime).getTime();
  const sessionEnd = s.endTime ? new Date(s.endTime).getTime() : Date.now();
  const sessionDurMin = (sessionEnd - sessionStart) / 60000;

  if (ts.length === 0) {
    return { count: 0, avgInterval: 0, minInterval: 0, maxInterval: 0, pressesPerMin: 0, intervals: [] };
  }

  if (ts.length === 1) {
    return {
      count: 1,
      avgInterval: 0,
      minInterval: 0,
      maxInterval: 0,
      pressesPerMin: sessionDurMin > 0 ? (1 / sessionDurMin) : 0,
      intervals: []
    };
  }

  const intervals = [];
  for (let i = 1; i < ts.length; i++) {
    intervals.push(ts[i] - ts[i - 1]);
  }
  const sum = intervals.reduce((a, b) => a + b, 0);

  return {
    count: ts.length,
    avgInterval: sum / intervals.length,
    minInterval: Math.min(...intervals),
    maxInterval: Math.max(...intervals),
    pressesPerMin: sessionDurMin > 0 ? (ts.length / sessionDurMin) : 0,
    intervals
  };
}

// === TIMER ===
const Timer = {
  start() {
    Timer.stop();
    lastAlertedMinute = 0;
    timerInterval = setInterval(Timer.update, 100);
  },

  stop() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  },

  update() {
    if (!session || !session.active) return;
    const elapsed = getElapsedMs();
    Timer.renderTime(elapsed);
    Timer.checkMinuteAlert(elapsed);
  },

  renderTime(elapsedMs) {
    const totalSec = Math.floor(elapsedMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const timerEl = $('timer-value');
    timerEl.textContent = String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');

    // Color coding
    timerEl.classList.remove('warning', 'alert');
    const t = (session && session.activeSection && settings.thresholds[session.activeSection])
      ? settings.thresholds[session.activeSection]
      : { warning: 45, alert: 60 };
    if (totalSec >= t.alert) {
      timerEl.classList.add('alert');
    } else if (totalSec >= t.warning) {
      timerEl.classList.add('warning');
    }
  },

  checkMinuteAlert(elapsedMs) {
    const t = (session && session.activeSection && settings.thresholds[session.activeSection])
      ? settings.thresholds[session.activeSection]
      : { warning: 45, alert: 60 };
    const alertPeriod = Math.floor(Math.floor(elapsedMs / 1000) / t.alert);
    if (alertPeriod > lastAlertedMinute) {
      lastAlertedMinute = alertPeriod;
      SoundPlayer.playMinuteAlert();
    }
  }
};

// === UI ===
const UI = {
  render() {
    if (!session) return;
    UI.updateSessionHeader();
    UI.renderStats();
    UI.renderUndoState();
  },

  updateSessionHeader() {
    $('session-section-name').textContent = session.activeSection;
  },

  renderStats() {
    const sessionStart = new Date(session.startTime).getTime();
    const sessionDurMin = (Date.now() - sessionStart) / 60000;
    const count = session.sections[session.activeSection].count;

    const perMin = sessionDurMin > 0.01 ? count / sessionDurMin : 0;
    const perHour = Math.round(perMin * 60);
    const rateEl = $('stat-rate-hr');
    rateEl.textContent = perMin > 0 ? perHour + '/hr' : '--/hr';

    const goal = settings.goalRates[session.activeSection] || 0;
    $('stat-goal-value').textContent = goal > 0 ? goal + '/hr' : '--/hr';

    rateEl.classList.remove('stat-below', 'stat-above');
    if (goal > 0 && count > 0) {
      rateEl.classList.add(perHour < goal ? 'stat-below' : 'stat-above');
    }
  },

  renderUndoState() {
    $('undo-btn').disabled = session.undoStack.length === 0;
  },

  flash() {
    const el = $('flash-overlay');
    el.classList.remove('flash');
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add('flash');
  },

  showStatus(msg) {
    // status bar removed
  },

  renderSummary() {
    const sessionStart = new Date(session.startTime).getTime();
    const sessionEnd = session.endTime ? new Date(session.endTime).getTime() : Date.now();
    const durMs = sessionEnd - sessionStart;
    const durMin = durMs / 60000;
    const startTime = new Date(sessionStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endTime = new Date(sessionEnd).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    const name = session.activeSection;
    const m = computeMetrics(name);
    const perHour = durMin > 0.01 ? Math.round(m.count / durMin * 60) + '/hr' : '--';

    $('summary-sections').innerHTML = `
      <div class="summary-section">
        <div class="summary-section-name">${name}</div>
        <div class="summary-meta">
          <span>${startTime} &ndash; ${endTime}</span>
          <span>${formatDuration(durMs)}</span>
        </div>
        <div class="summary-stats">
          <span class="label">Count</span><span class="value">${m.count}</span>
          <span class="label">Per hour</span><span class="value">${perHour}</span>
          <span class="label">Per min</span><span class="value">${m.pressesPerMin > 0 ? m.pressesPerMin.toFixed(1) + '/min' : '--'}</span>
          <span class="label">Avg interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.avgInterval) : '--'}</span>
          <span class="label">Min interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.minInterval) : '--'}</span>
          <span class="label">Max interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.maxInterval) : '--'}</span>
        </div>
      </div>`;
  }
};

// === INPUT HANDLERS ===
const Input = {
  handleKeyDown(e) {
    if (e.key !== 'b' || e.repeat) return;
    e.preventDefault();

    // B on save/discard screen → save session
    if (!session || !session.active) {
      if ($('save-discard-screen').style.display !== 'none') {
        $('save-btn').click();
        return;
      }
      // B on summary screen → new session
      if ($('summary-screen').style.display !== 'none') {
        $('new-session-btn').click();
        return;
      }
      // B on start screen → tap cycles section, hold starts session
      if ($('start-screen').style.display !== 'none') {
        bHoldFired = false;
        const startBtn = $('start-btn');
        if (selectedSection) {
          bFillTimer = setTimeout(() => {
            startBtn.classList.remove('filling');
            void startBtn.offsetWidth;
            startBtn.classList.add('filling');
          }, HOLD_DELAY_MS);
        }
        bHoldTimer = setTimeout(() => {
          bHoldFired = true;
          startBtn.classList.remove('filling');
          if (!selectedSection) {
            nudgeSectionSelector();
            return;
          }
          SoundPlayer.init();
          session = createSession();
          Storage.save(session);
          showScreen('session');
          Timer.start();
        }, HOLD_THRESHOLD_MS);
      }
      return;
    }
    // Active session → tap records press, hold ends session
    const now = Date.now();
    if (now - lastPressTime < DEBOUNCE_MS) return;
    lastPressTime = now;

    bHoldFired = false;
    const endBtn = $('end-btn');
    bFillTimer = setTimeout(() => {
      endBtn.classList.remove('filling');
      void endBtn.offsetWidth;
      endBtn.classList.add('filling');
    }, HOLD_DELAY_MS);

    bHoldTimer = setTimeout(() => {
      bHoldFired = true;
      endBtn.classList.remove('filling');
      if (endConfirmPending) {
        clearTimeout(endConfirmTimer);
        endConfirmPending = false;
      }
      endBtn.textContent = 'End Session';
      endBtn.classList.remove('confirm');
      session.active = false;
      session.endTime = new Date().toISOString();
      Timer.stop();
      const sec = session.sections[session.activeSection];
      const durMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
      const durMin = durMs / 60000;
      const metrics = computeMetrics(session.activeSection);
      const rate = durMin > 0.01 ? (sec.count / durMin).toFixed(1) + '/min' : '--/min';
      const avg = metrics.intervals.length > 0 ? formatDuration(metrics.avgInterval) : '--';
      $('save-discard-stats').innerHTML =
        `<div>${session.activeSection} &mdash; ${sec.count} presses in ${formatDuration(durMs)}</div>` +
        `<div class="save-discard-details">` +
          `<span>Rate: ${rate}</span>` +
          `<span>Avg: ${avg}</span>` +
          `<span>Total: ${sec.count}</span>` +
        `</div>`;
      showScreen('save-discard');
    }, HOLD_THRESHOLD_MS);
  },

  handleKeyUp(e) {
    if (e.key !== 'b') return;
    if (bFillTimer) {
      clearTimeout(bFillTimer);
      bFillTimer = null;
    }
    if (bHoldTimer) {
      clearTimeout(bHoldTimer);
      bHoldTimer = null;
    }
    $('start-btn').classList.remove('filling');
    $('end-btn').classList.remove('filling');
    if (!bHoldFired) {
      if (!session || !session.active) {
        if ($('start-screen').style.display !== 'none') {
          cycleSection();
        }
      } else {
        Input.recordPress(lastPressTime);
      }
    }
  },

  recordPress(timestamp) {
    const sec = session.sections[session.activeSection];
    sec.timestamps.push(timestamp);
    sec.count++;
    session.undoStack.push({ section: session.activeSection, timestamp });

    // Reset minute alert counter
    lastAlertedMinute = 0;

    Storage.save(session);
    UI.flash();
    SoundPlayer.playPressClick();
    UI.render();
    UI.showStatus('Press recorded \u2014 ' + session.activeSection);
  },

  handleUndo() {
    if (!session || session.undoStack.length === 0) return;

    const last = session.undoStack.pop();
    const sec = session.sections[last.section];
    const idx = sec.timestamps.lastIndexOf(last.timestamp);
    if (idx !== -1) {
      sec.timestamps.splice(idx, 1);
      sec.count--;
    }

    // Reset minute alert for new timing context
    lastAlertedMinute = 0;

    Storage.save(session);
    UI.render();
    UI.showStatus('Undone \u2014 ' + last.section);
  },

  handleEndSession() {
    if (!session || !session.active) return;

    if (!endConfirmPending) {
      // First tap — arm confirmation
      endConfirmPending = true;
      const btn = $('end-btn');
      btn.textContent = 'Confirm End?';
      btn.classList.add('confirm');
      endConfirmTimer = setTimeout(() => {
        endConfirmPending = false;
        btn.textContent = 'End Session';
        btn.classList.remove('confirm');
      }, CONFIRM_TIMEOUT_MS);
      return;
    }

    // Second tap — show save/discard prompt
    clearTimeout(endConfirmTimer);
    endConfirmPending = false;
    $('end-btn').textContent = 'End Session';
    $('end-btn').classList.remove('confirm');
    session.active = false;
    session.endTime = new Date().toISOString();
    Timer.stop();

    // Show quick stats on save/discard screen
    const sec = session.sections[session.activeSection];
    const durMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
    const durMin = durMs / 60000;
    const metrics = computeMetrics(session.activeSection);
    const rate = durMin > 0.01 ? (sec.count / durMin).toFixed(1) + '/min' : '--/min';
    const avg = metrics.intervals.length > 0 ? formatDuration(metrics.avgInterval) : '--';
    $('save-discard-stats').innerHTML =
      `<div>${session.activeSection} &mdash; ${sec.count} presses in ${formatDuration(durMs)}</div>` +
      `<div class="save-discard-details">` +
        `<span>Rate: ${rate}</span>` +
        `<span>Avg: ${avg}</span>` +
        `<span>Total: ${sec.count}</span>` +
      `</div>`;

    showScreen('save-discard');
  }
};

// === SCREEN MANAGEMENT ===
let clockInterval = null;
function updateClock() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const full = date + '  \u2022  ' + time;
  $('start-clock-text').textContent = full;
  $('session-clock').textContent = date + '  \u2022  ' + time;
}

function showScreen(name) {
  ['start-screen', 'resume-screen', 'session-screen', 'save-discard-screen', 'summary-screen', 'history-screen', 'history-detail-screen', 'stats-screen'].forEach(id => {
    $(id).style.display = 'none';
  });
  $(name + '-screen').style.display = 'flex';
  if (name === 'session') UI.render();
  if (name === 'start' || name === 'session') {
    updateClock();
    clearInterval(clockInterval);
    clockInterval = setInterval(updateClock, 10000);
  } else {
    clearInterval(clockInterval);
    clockInterval = null;
  }
}

// === HELPERS ===
function formatDuration(ms) {
  if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return totalSec + 's';
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return min + 'm ' + sec + 's';
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return hr + 'h ' + remMin + 'm';
}

// === NUDGE ===
function nudgeSectionSelector() {
  SoundPlayer.init();
  SoundPlayer.playNudge();
  const el = $('section-selector');
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// === CYCLE SECTION ===
function cycleSection() {
  const currentIdx = selectedSection ? SECTIONS.indexOf(selectedSection) : -1;
  const nextIdx = (currentIdx + 1) % SECTIONS.length;
  selectedSection = SECTIONS[nextIdx];
  document.querySelectorAll('.section-option').forEach(b => b.classList.remove('active'));
  document.querySelector(`.section-option[data-section="${selectedSection}"]`).classList.add('active');
  $('start-btn').disabled = false;
  SoundPlayer.init();
  SoundPlayer.playPressClick();
}

// === HISTORY ===
function renderHistoryList() {
  const history = Storage.loadHistory();
  const list = $('history-list');
  const empty = $('history-empty');

  // Reset clear confirmation
  clearConfirmPending = false;
  $('history-clear-btn').textContent = 'Clear All';
  $('history-clear-btn').classList.remove('confirm');

  if (history.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    $('history-clear-btn').style.display = 'none';
    $('export-json-btn').style.display = 'none';
    $('export-csv-btn').style.display = 'none';
    return;
  }

  list.style.display = 'block';
  empty.style.display = 'none';
  $('history-clear-btn').style.display = 'block';
  $('export-json-btn').style.display = '';
  $('export-csv-btn').style.display = '';

  list.innerHTML = history.map(s => {
    const start = new Date(s.startTime);
    const end = s.endTime ? new Date(s.endTime) : start;
    const durMs = end.getTime() - start.getTime();
    const sec = s.sections[s.activeSection];
    const durMin = durMs / 60000;
    const rate = durMin > 0.01 ? (sec.count / durMin).toFixed(1) + '/min' : '--';
    const dateStr = start.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    }) + ' ' + start.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    });
    return `<div class="history-item" data-id="${s.id}">
      <div class="history-item-top">
        <span class="history-item-date">${dateStr}</span>
        <span class="history-item-section">${s.activeSection}</span>
      </div>
      <div class="history-item-stats">${sec.count} presses &middot; ${formatDuration(durMs)} &middot; ${rate}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = Number(item.dataset.id);
      const s = history.find(h => h.id === id);
      if (s) renderHistoryDetail(s);
    });
  });
}

function renderHistoryDetail(s) {
  viewingHistorySession = s;

  const start = new Date(s.startTime);
  const end = s.endTime ? new Date(s.endTime) : start;
  const durMs = end.getTime() - start.getTime();

  const durMin = durMs / 60000;
  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  $('detail-duration').innerHTML =
    `<span>${dateStr}</span>` +
    `<span>${startTime} &ndash; ${endTime}</span>` +
    `<span>${formatDuration(durMs)}</span>`;

  const name = s.activeSection;
  const m = computeMetrics(name, s);
  const perHour = durMin > 0.01 ? Math.round(m.count / durMin * 60) + '/hr' : '--';

  $('detail-sections').innerHTML = `
    <div class="summary-section">
      <div class="summary-section-name">${name}</div>
      <div class="summary-stats">
        <span class="label">Count</span><span class="value">${m.count}</span>
        <span class="label">Per hour</span><span class="value">${perHour}</span>
        <span class="label">Per min</span><span class="value">${m.pressesPerMin > 0 ? m.pressesPerMin.toFixed(1) + '/min' : '--'}</span>
        <span class="label">Avg interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.avgInterval) : '--'}</span>
        <span class="label">Min interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.minInterval) : '--'}</span>
        <span class="label">Max interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.maxInterval) : '--'}</span>
      </div>
    </div>`;

  $('detail-totals').innerHTML = `
    <div class="total-line">Total presses: ${m.count}</div>
  `;

  deleteConfirmPending = false;
  $('detail-delete-btn').textContent = 'Delete';
  $('detail-delete-btn').classList.remove('confirm');

  showScreen('history-detail');
}

// === THEME ===
function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme);
}

// === SETTINGS MODAL ===
function openSettings() {
  $('toggle-theme').checked = settings.theme === 'light';
  VOLUME_KEYS.forEach(k => {
    $('vol-val-' + k).textContent = settings.volumes[k] + '%';
  });
  SECTIONS.forEach(q => {
    $('thresh-warn-' + q).querySelector('.thresh-val').textContent = settings.thresholds[q].warning;
    $('thresh-alert-' + q).querySelector('.thresh-val').textContent = settings.thresholds[q].alert;
    $('thresh-goal-' + q).querySelector('.thresh-val').textContent = settings.goalRates[q] || 0;
  });
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() {
  $('settings-modal').classList.add('hidden');
}

// === GOAL MODAL ===
function openGoalModal() {
  if (!session) return;
  const section = session.activeSection;
  $('goal-modal-section').textContent = section;
  $('goal-stepper-val').textContent = settings.goalRates[section] || 0;
  $('goal-modal').classList.remove('hidden');
}
function closeGoalModal() {
  $('goal-modal').classList.add('hidden');
}
function adjustGoal(dir) {
  if (!session) return;
  const section = session.activeSection;
  const current = settings.goalRates[section] || 0;
  const next = Math.max(0, Math.min(GOAL_MAX, current + dir * GOAL_STEP));
  if (next === current) return;
  settings.goalRates[section] = next;
  saveSettings();
  $('goal-stepper-val').textContent = next;
  UI.renderStats();
}

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  applyTheme();

  // Check for saved session
  const saved = Storage.load();
  if (saved && saved.active) {
    // Determine if session is stale
    const lastActivity = getLastActivityTime(saved);
    const gap = Date.now() - lastActivity;

    if (gap > STALE_THRESHOLD_MS) {
      // Show resume prompt
      const gapMin = Math.round(gap / 60000);
      $('resume-info').textContent =
        `Last activity was ${gapMin} minutes ago. Resume or start fresh?`;
      $('resume-section').textContent = `Section: ${saved.activeSection}`;
      showScreen('resume');

      $('resume-btn').addEventListener('click', () => {
        SoundPlayer.init();
        session = saved;
        UI.updateSessionHeader();
        showScreen('session');
        Timer.start();
        showAudioBanner();
      });

      $('discard-btn').addEventListener('click', () => {
        Storage.clear();
        selectedSection = null;
        document.querySelectorAll('.section-option').forEach(b => b.classList.remove('active'));
        $('start-btn').disabled = true;
        showScreen('start');
      });
    } else {
      // Auto-resume recent session
      session = saved;
      SoundPlayer.init();
      UI.updateSessionHeader();
      showScreen('session');
      Timer.start();
      showAudioBanner();
    }
  } else {
    showScreen('start');
  }

  // Start button
  $('start-btn').addEventListener('click', () => {
    if (!selectedSection) {
      nudgeSectionSelector();
      return;
    }
    SoundPlayer.init();
    session = createSession();
    Storage.save(session);
    showScreen('session');
    Timer.start();
  });

  // Foot pedal
  document.addEventListener('keydown', Input.handleKeyDown);
  document.addEventListener('keyup', Input.handleKeyUp);

  // Section selector on start screen
  document.querySelectorAll('.section-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.section-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSection = btn.dataset.section;
      $('start-btn').disabled = false;
    });
  });

  // Undo
  $('undo-btn').addEventListener('click', Input.handleUndo);

  // End session
  $('end-btn').addEventListener('click', Input.handleEndSession);

  // Hold-to-end (3 second long press)
  function startEndHold() {
    if (!session || !session.active) return;
    const btn = $('end-btn');
    btn.classList.remove('filling');
    endFillTimer = setTimeout(() => {
      endFillTimer = null;
      void btn.offsetWidth;
      btn.classList.add('filling');
    }, HOLD_DELAY_MS);
    endHoldTimer = setTimeout(() => {
      endHoldTimer = null;
      btn.classList.remove('filling');
      // Cancel any pending double-tap confirmation
      if (endConfirmPending) {
        clearTimeout(endConfirmTimer);
        endConfirmPending = false;
      }
      btn.textContent = 'End Session';
      btn.classList.remove('confirm');
      // End the session
      session.active = false;
      session.endTime = new Date().toISOString();
      Timer.stop();
      const sec = session.sections[session.activeSection];
      const durMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
      const durMin = durMs / 60000;
      const metrics = computeMetrics(session.activeSection);
      const rate = durMin > 0.01 ? (sec.count / durMin).toFixed(1) + '/min' : '--/min';
      const avg = metrics.intervals.length > 0 ? formatDuration(metrics.avgInterval) : '--';
      $('save-discard-stats').innerHTML =
        `<div>${session.activeSection} &mdash; ${sec.count} presses in ${formatDuration(durMs)}</div>` +
        `<div class="save-discard-details">` +
          `<span>Rate: ${rate}</span>` +
          `<span>Avg: ${avg}</span>` +
          `<span>Total: ${sec.count}</span>` +
        `</div>`;
      showScreen('save-discard');
    }, HOLD_THRESHOLD_MS);
  }

  function cancelEndHold() {
    if (endFillTimer) {
      clearTimeout(endFillTimer);
      endFillTimer = null;
    }
    if (endHoldTimer) {
      clearTimeout(endHoldTimer);
      endHoldTimer = null;
    }
    $('end-btn').classList.remove('filling');
  }

  $('end-btn').addEventListener('pointerdown', startEndHold);
  $('end-btn').addEventListener('pointerup', cancelEndHold);
  $('end-btn').addEventListener('pointerleave', cancelEndHold);
  $('end-btn').addEventListener('pointercancel', cancelEndHold);

  // Save session from save/discard screen
  $('save-btn').addEventListener('click', () => {
    Storage.save(session);
    Storage.saveToHistory(session);
    UI.renderSummary();
    showScreen('summary');
  });

  // Discard session from save/discard screen
  $('discard-session-btn').addEventListener('click', () => {
    Storage.clear();
    session = null;
    selectedSection = null;
    document.querySelectorAll('.section-option').forEach(b => b.classList.remove('active'));
    $('start-btn').disabled = true;
    showScreen('start');
  });

  // New session from summary
  $('new-session-btn').addEventListener('click', () => {
    Storage.clear();
    selectedSection = null;
    document.querySelectorAll('.section-option').forEach(b => b.classList.remove('active'));
    $('start-btn').disabled = true;
    showScreen('start');
  });

  // View history
  $('history-btn').addEventListener('click', () => {
    renderHistoryList();
    showScreen('history');
  });

  // History back
  $('history-back-btn').addEventListener('click', () => {
    showScreen('start');
  });

  // History clear all (double-tap confirmation)
  $('history-clear-btn').addEventListener('click', () => {
    if (!clearConfirmPending) {
      clearConfirmPending = true;
      $('history-clear-btn').textContent = 'Confirm?';
      $('history-clear-btn').classList.add('confirm');
      clearConfirmTimer = setTimeout(() => {
        clearConfirmPending = false;
        $('history-clear-btn').textContent = 'Clear All';
        $('history-clear-btn').classList.remove('confirm');
      }, CONFIRM_TIMEOUT_MS);
      return;
    }
    clearTimeout(clearConfirmTimer);
    clearConfirmPending = false;
    $('history-clear-btn').textContent = 'Clear All';
    $('history-clear-btn').classList.remove('confirm');
    Storage.clearHistory();
    renderHistoryList();
  });

  // History detail back
  $('detail-back-btn').addEventListener('click', () => {
    renderHistoryList();
    showScreen('history');
  });

  // History detail delete (double-tap confirmation)
  $('detail-delete-btn').addEventListener('click', () => {
    if (!viewingHistorySession) return;
    if (!deleteConfirmPending) {
      deleteConfirmPending = true;
      $('detail-delete-btn').textContent = 'Confirm?';
      $('detail-delete-btn').classList.add('confirm');
      deleteConfirmTimer = setTimeout(() => {
        deleteConfirmPending = false;
        $('detail-delete-btn').textContent = 'Delete';
        $('detail-delete-btn').classList.remove('confirm');
      }, CONFIRM_TIMEOUT_MS);
      return;
    }
    clearTimeout(deleteConfirmTimer);
    deleteConfirmPending = false;
    $('detail-delete-btn').textContent = 'Delete';
    $('detail-delete-btn').classList.remove('confirm');
    Storage.deleteFromHistory(viewingHistorySession.id);
    viewingHistorySession = null;
    renderHistoryList();
    showScreen('history');
  });

  // Export / Import
  $('export-json-btn').addEventListener('click', Export.toJSON);
  $('export-csv-btn').addEventListener('click', Export.toCSV);
  $('import-file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) Export.fromJSON(e.target.files[0]);
    e.target.value = '';
  });

  // Stats
  $('stats-btn').addEventListener('click', () => {
    showScreen('stats');
    renderStatsChart();
  });

  $('stats-back-btn').addEventListener('click', () => {
    showScreen('start');
  });

  document.querySelectorAll('.stats-queue-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stats-queue-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statsQueue = btn.dataset.section;
      renderStatsChart();
    });
  });

  // Periodic save
  setInterval(() => {
    if (session && session.active) Storage.save(session);
  }, SAVE_INTERVAL_MS);

  // Settings modal
  document.querySelectorAll('.settings-gear-btn').forEach(btn => {
    btn.addEventListener('click', openSettings);
  });
  $('settings-close-btn').addEventListener('click', closeSettings);
  $('reload-page-btn').addEventListener('click', () => location.reload(true));
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target === $('settings-modal')) closeSettings();
  });
  $('toggle-theme').addEventListener('change', (e) => {
    settings.theme = e.target.checked ? 'light' : 'dark';
    applyTheme();
    saveSettings();
    renderStatsChart();
  });
  document.querySelectorAll('.vol-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.vol;
      const dir = parseInt(btn.dataset.dir, 10);
      const current = settings.volumes[key] || 0;
      const next = Math.max(0, Math.min(100, current + dir * VOLUME_STEP));
      if (next === current) return;
      settings.volumes[key] = next;
      saveSettings();
      $('vol-val-' + key).textContent = next + '%';
    });
  });
  document.querySelectorAll('.vol-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SoundPlayer.init();
      const key = btn.dataset.vol;
      if (key === 'press') SoundPlayer.playPressClick();
      else if (key === 'minuteAlert') SoundPlayer.playMinuteAlert();
      else if (key === 'nudge') SoundPlayer.playNudge();
    });
  });
  document.querySelectorAll('.thresh-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.queue;
      const type = btn.dataset.type;
      const dir = parseInt(btn.dataset.dir, 10);
      if (type === 'goal') {
        const current = settings.goalRates[q] || 0;
        const next = Math.max(0, Math.min(GOAL_MAX, current + dir * GOAL_STEP));
        if (next === current) return;
        settings.goalRates[q] = next;
        saveSettings();
        $('thresh-goal-' + q).querySelector('.thresh-val').textContent = next;
        if (session && session.active && session.activeSection === q) {
          UI.renderStats();
        }
        return;
      }
      const t = settings.thresholds[q];
      if (type === 'warning') {
        const v = t.warning + dir * 5;
        if (v >= 5 && v < t.alert) t.warning = v;
      } else {
        const v = t.alert + dir * 5;
        if (v > t.warning && v <= 300) t.alert = v;
      }
      saveSettings();
      $('thresh-warn-' + q).querySelector('.thresh-val').textContent = t.warning;
      $('thresh-alert-' + q).querySelector('.thresh-val').textContent = t.alert;
    });
  });

  // Goal modal
  $('stat-goal').addEventListener('click', openGoalModal);
  $('goal-close-btn').addEventListener('click', closeGoalModal);
  $('goal-done').addEventListener('click', closeGoalModal);
  $('goal-modal').addEventListener('click', (e) => {
    if (e.target === $('goal-modal')) closeGoalModal();
  });
  $('goal-inc').addEventListener('click', () => adjustGoal(1));
  $('goal-dec').addEventListener('click', () => adjustGoal(-1));
});

function getLastActivityTime(s) {
  let latest = new Date(s.startTime).getTime();
  SECTIONS.forEach(name => {
    const ts = s.sections[name].timestamps;
    if (ts.length > 0) {
      latest = Math.max(latest, ts[ts.length - 1]);
    }
  });
  return latest;
}

function showAudioBanner() {
  if (!audioCtx || audioCtx.state === 'running') return;
  const banner = $('audio-banner');
  banner.style.display = 'flex';

  const unlock = () => {
    SoundPlayer.init();
    banner.style.display = 'none';
    document.removeEventListener('click', unlock);
    document.removeEventListener('touchstart', unlock);
  };
  document.addEventListener('click', unlock);
  document.addEventListener('touchstart', unlock);
}

// === STATS CHART ===
let statsQueue = 'CB-105';

function renderStatsChart() {
  const history = Storage.loadHistory();
  const sessions = history.filter(s => s.activeSection === statsQueue && s.endTime);

  const canvas = $('stats-canvas');
  const wrap = $('stats-chart-wrap');
  const emptyEl = $('stats-empty');

  if (sessions.length === 0) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }
  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  // Build data points: { date (day string), time (ms), perHour }
  const points = [];
  sessions.forEach(s => {
    const start = new Date(s.startTime).getTime();
    const end = new Date(s.endTime).getTime();
    const durMin = (end - start) / 60000;
    if (durMin < 0.5) return; // skip very short sessions
    const count = s.sections[s.activeSection].count;
    const perHour = Math.round(count / durMin * 60);
    points.push({ time: start, perHour });
  });

  if (points.length === 0) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }

  points.sort((a, b) => a.time - b.time);

  // Group by day
  const dayMap = new Map();
  points.forEach(p => {
    const d = new Date(p.time);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(p);
  });
  const days = Array.from(dayMap.keys()).sort();

  // Chart dimensions
  const dpr = window.devicePixelRatio || 1;
  const chartHeight = wrap.clientHeight - 4;
  const padTop = 32;
  const padBottom = 44;
  const padLeft = 52;
  const padRight = 20;
  const dayWidth = 140;
  const totalDays = days.length;
  const chartWidth = Math.max(800, padLeft + padRight + totalDays * dayWidth);

  canvas.width = chartWidth * dpr;
  canvas.height = chartHeight * dpr;
  canvas.style.width = chartWidth + 'px';
  canvas.style.height = chartHeight + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Clear
  ctx.clearRect(0, 0, chartWidth, chartHeight);

  const plotTop = padTop;
  const plotBottom = chartHeight - padBottom;
  const plotHeight = plotBottom - plotTop;
  const plotLeft = padLeft;

  // Y-axis range
  const allRates = points.map(p => p.perHour);
  const maxRate = Math.max(...allRates);
  const yMax = Math.ceil(maxRate / 10) * 10 || 10;
  const ySteps = 5;
  const yStep = yMax / ySteps;

  // Theme-aware colors
  const isLight = settings.theme === 'light';
  const chartGridColor  = isLight ? '#e0e0ff' : '#1a2744';
  const chartLabelColor = isLight ? '#8888aa' : '#666';
  const chartDateColor  = isLight ? '#7777aa' : '#888';
  const chartDivColor   = isLight ? '#e8eaff' : '#16213e';
  const chartValColor   = isLight ? '#4a4a6a' : '#ccc';
  const chartAvgColor   = isLight ? '#C46A00' : '#FFB74D';

  // Grid lines and Y labels
  ctx.strokeStyle = chartGridColor;
  ctx.lineWidth = 1;
  ctx.fillStyle = chartLabelColor;
  ctx.font = '14px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round(i * yStep);
    const y = plotBottom - (i / ySteps) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(chartWidth - padRight, y);
    ctx.stroke();
    ctx.fillText(val + '/hr', plotLeft - 6, y);
  }

  // X positions: each day gets a column
  function dayX(dayIdx) {
    return plotLeft + dayIdx * dayWidth + dayWidth / 2;
  }

  // Day labels on X axis
  ctx.fillStyle = chartDateColor;
  ctx.font = '14px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  days.forEach((day, i) => {
    const x = dayX(i);
    const d = new Date(day + 'T12:00:00');
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    ctx.fillText(label, x, plotBottom + 6);

    // Day divider
    ctx.strokeStyle = chartDivColor;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  });

  // Plot points and lines — spread sessions within a day
  function yPos(rate) {
    return plotBottom - (rate / yMax) * plotHeight;
  }

  // Build flat list of { x, y, perHour } for the line
  const plotPoints = [];
  days.forEach((day, di) => {
    const daySessions = dayMap.get(day);
    daySessions.sort((a, b) => a.time - b.time);
    const cx = dayX(di);

    if (daySessions.length === 1) {
      plotPoints.push({ x: cx, y: yPos(daySessions[0].perHour), perHour: daySessions[0].perHour });
    } else {
      const spread = Math.min(dayWidth * 0.7, daySessions.length * 20);
      const startX = cx - spread / 2;
      daySessions.forEach((p, j) => {
        const x = startX + (spread * j) / (daySessions.length - 1);
        plotPoints.push({ x, y: yPos(p.perHour), perHour: p.perHour });
      });
    }
  });

  // Draw line
  if (plotPoints.length > 1) {
    ctx.strokeStyle = '#6367FF';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(plotPoints[0].x, plotPoints[0].y);
    for (let i = 1; i < plotPoints.length; i++) {
      ctx.lineTo(plotPoints[i].x, plotPoints[i].y);
    }
    ctx.stroke();

    // Fill area under the line
    ctx.fillStyle = 'rgba(99, 103, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(plotPoints[0].x, plotBottom);
    plotPoints.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(plotPoints[plotPoints.length - 1].x, plotBottom);
    ctx.closePath();
    ctx.fill();
  }

  // Mean rate dashed line — resets monthly, so only includes current-month sessions
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthRates = points.filter(p => p.time >= monthStart).map(p => p.perHour);
  if (monthRates.length > 0) {
    const meanRate = monthRates.reduce((a, b) => a + b, 0) / monthRates.length;
    const meanY = yPos(meanRate);
    ctx.save();
    ctx.strokeStyle = chartAvgColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, meanY);
    ctx.lineTo(chartWidth - padRight, meanY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = chartAvgColor;
    ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const monthLabel = now.toLocaleDateString('en-US', { month: 'short' });
    ctx.fillText(monthLabel + ' avg ' + Math.round(meanRate) + '/hr', chartWidth - padRight - 6, meanY - 3);
    ctx.restore();
  }

  // Draw dots + value labels
  plotPoints.forEach(p => {
    ctx.fillStyle = '#6367FF';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Value label above dot
    ctx.fillStyle = chartValColor;
    ctx.font = '13px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.perHour, p.x, p.y - 8);
  });

  // Scroll to show last 5 days
  if (totalDays > 5) {
    const scrollTarget = dayX(totalDays - 5) - padLeft - 20;
    wrap.scrollLeft = Math.max(0, scrollTarget);
  } else {
    wrap.scrollLeft = 0;
  }
}
