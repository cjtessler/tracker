// === CONSTANTS ===
const SECTIONS = ['CB-105', 'PVS', 'PVSI'];
const DEBOUNCE_MS = 200;
const SAVE_INTERVAL_MS = 5000;
const STORAGE_KEY = 'pedal-tracker-session';
const HISTORY_KEY = 'pedal-tracker-history';
const CONFIRM_TIMEOUT_MS = 3000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

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
let statusTimeout = null;
let selectedSection = null;
let viewingHistorySession = null;

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

// === AUDIO ===
const SoundPlayer = {
  init() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  },

  playTone(freq, duration, startDelay = 0) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    const t = audioCtx.currentTime + startDelay;
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  },

  playMinuteAlert() {
    SoundPlayer.playTone(880, 0.15, 0);
    SoundPlayer.playTone(880, 0.15, 0.25);
  },

  playPressClick() {
    SoundPlayer.playTone(600, 0.05, 0);
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
      'PVSI':   { count: 0, timestamps: [] }
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
    if (totalSec >= 60) {
      timerEl.classList.add('alert');
    } else if (totalSec >= 45) {
      timerEl.classList.add('warning');
    }
  },

  checkMinuteAlert(elapsedMs) {
    const elapsedMin = Math.floor(elapsedMs / 60000);
    if (elapsedMin > lastAlertedMinute) {
      lastAlertedMinute = elapsedMin;
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
    const metrics = computeMetrics(session.activeSection);
    const sessionStart = new Date(session.startTime).getTime();
    const sessionDurMin = (Date.now() - sessionStart) / 60000;
    const count = session.sections[session.activeSection].count;

    $('stat-rate').textContent = sessionDurMin > 0.01
      ? (count / sessionDurMin).toFixed(1) + '/min'
      : '--/min';

    $('stat-avg').textContent = metrics.intervals.length > 0
      ? formatDuration(metrics.avgInterval)
      : '--';

    $('stat-total').textContent = count;
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

    $('summary-duration').textContent = 'Duration: ' + formatDuration(durMs) +
      ' | Ended: ' + new Date(sessionEnd).toLocaleTimeString();

    const name = session.activeSection;
    const m = computeMetrics(name);

    $('summary-sections').innerHTML = `
      <div class="summary-section">
        <div class="summary-section-name">${name}</div>
        <div class="summary-stats">
          <span class="label">Count</span><span class="value">${m.count}</span>
          <span class="label">Avg interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.avgInterval) : '--'}</span>
          <span class="label">Min interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.minInterval) : '--'}</span>
          <span class="label">Max interval</span><span class="value">${m.intervals.length > 0 ? formatDuration(m.maxInterval) : '--'}</span>
          <span class="label">Rate</span><span class="value">${m.pressesPerMin > 0 ? m.pressesPerMin.toFixed(1) + '/min' : '--'}</span>
        </div>
      </div>`;

    const sessionDurMin = durMs / 60000;
    $('summary-totals').innerHTML = `
      <div class="total-line">Total presses: ${m.count}</div>
      <div class="total-line">Overall rate: ${sessionDurMin > 0.01 ? (m.count / sessionDurMin).toFixed(1) + '/min' : '--'}</div>
    `;
  }
};

// === INPUT HANDLERS ===
const Input = {
  handleKeyPress(e) {
    if (e.key !== 'b' || e.repeat) return;
    e.preventDefault();

    // B on start screen → start session (or nudge if no section)
    if (!session || !session.active) {
      if ($('start-screen').style.display !== 'none') {
        if (!selectedSection) {
          nudgeSectionSelector();
          return;
        }
        SoundPlayer.init();
        session = createSession();
        Storage.save(session);
        showScreen('session');
        Timer.start();
      }
      return;
    }
    const now = Date.now();
    if (now - lastPressTime < DEBOUNCE_MS) return;
    lastPressTime = now;
    Input.recordPress(now);
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
function showScreen(name) {
  ['start-screen', 'resume-screen', 'session-screen', 'save-discard-screen', 'summary-screen'].forEach(id => {
    $(id).style.display = 'none';
  });
  $(name + '-screen').style.display = 'flex';
  if (name === 'session') UI.render();
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
  SoundPlayer.playTone(220, 0.15, 0);
  SoundPlayer.playTone(180, 0.15, 0.18);
  const el = $('section-selector');
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
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
  document.addEventListener('keydown', Input.handleKeyPress);

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

  // Save session from save/discard screen
  $('save-btn').addEventListener('click', () => {
    Storage.save(session);
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

  // Periodic save
  setInterval(() => {
    if (session && session.active) Storage.save(session);
  }, SAVE_INTERVAL_MS);
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
