// === CONSTANTS ===
const SECTIONS = ['CB-105', 'PVS', 'PVSI'];
const DEBOUNCE_MS = 200;
const SAVE_INTERVAL_MS = 5000;
const STORAGE_KEY = 'pedal-tracker-session';
const CONFIRM_TIMEOUT_MS = 3000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// === STATE ===
let session = null;
let timerInterval = null;
let lastPressTime = 0;
let lastAlertedMinute = 0;
let endConfirmTimer = null;
let endConfirmPending = false;
let audioCtx = null;
let statusTimeout = null;
let selectedSection = 'CB-105';

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

function computeMetrics(sectionName) {
  const sec = session.sections[sectionName];
  const ts = sec.timestamps;
  const sessionStart = new Date(session.startTime).getTime();
  const sessionEnd = session.endTime ? new Date(session.endTime).getTime() : Date.now();
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
    UI.renderTabs();
    UI.renderStats();
    UI.renderUndoState();
  },

  renderTabs() {
    SECTIONS.forEach(name => {
      const tab = document.querySelector(`.tab[data-section="${name}"]`);
      const countEl = $('count-' + name);
      countEl.textContent = session.sections[name].count;
      tab.classList.toggle('active', name === session.activeSection);
    });
  },

  renderStats() {
    const metrics = computeMetrics(session.activeSection);
    const sessionStart = new Date(session.startTime).getTime();
    const sessionDurMin = (Date.now() - sessionStart) / 60000;
    const totalCount = SECTIONS.reduce((s, n) => s + session.sections[n].count, 0);

    $('stat-rate').textContent = sessionDurMin > 0.01
      ? (totalCount / sessionDurMin).toFixed(1) + '/min'
      : '--/min';

    $('stat-avg').textContent = metrics.intervals.length > 0
      ? formatDuration(metrics.avgInterval)
      : '--';

    $('stat-total').textContent = totalCount;
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
    const el = $('status-text');
    el.textContent = msg;
    el.classList.remove('fade-out');
    if (statusTimeout) clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      el.classList.add('fade-out');
    }, 2000);
  },

  renderSummary() {
    const sessionStart = new Date(session.startTime).getTime();
    const sessionEnd = session.endTime ? new Date(session.endTime).getTime() : Date.now();
    const durMs = sessionEnd - sessionStart;

    $('summary-duration').textContent = 'Duration: ' + formatDuration(durMs) +
      ' | Ended: ' + new Date(sessionEnd).toLocaleTimeString();

    let totalCount = 0;
    let sectionsHtml = '';

    SECTIONS.forEach(name => {
      const m = computeMetrics(name);
      totalCount += m.count;

      sectionsHtml += `
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
    });

    $('summary-sections').innerHTML = sectionsHtml;

    const sessionDurMin = durMs / 60000;
    $('summary-totals').innerHTML = `
      <div class="total-line">Total presses: ${totalCount}</div>
      <div class="total-line">Overall rate: ${sessionDurMin > 0.01 ? (totalCount / sessionDurMin).toFixed(1) + '/min' : '--'}</div>
    `;
  }
};

// === INPUT HANDLERS ===
const Input = {
  handleKeyPress(e) {
    if (e.key !== 'b' || e.repeat || !session || !session.active) return;
    e.preventDefault();
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

  handleTabSwitch(sectionName) {
    if (!session || session.activeSection === sectionName) return;
    session.activeSection = sectionName;
    lastAlertedMinute = 0;
    Storage.save(session);
    UI.render();
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

    // Second tap — end session
    clearTimeout(endConfirmTimer);
    endConfirmPending = false;
    session.active = false;
    session.endTime = new Date().toISOString();
    Timer.stop();
    Storage.save(session);
    UI.renderSummary();
    showScreen('summary');
  }
};

// === SCREEN MANAGEMENT ===
function showScreen(name) {
  ['start-screen', 'resume-screen', 'session-screen', 'summary-screen'].forEach(id => {
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
      showScreen('resume');

      $('resume-btn').addEventListener('click', () => {
        SoundPlayer.init();
        session = saved;
        showScreen('session');
        Timer.start();
        showAudioBanner();
      });

      $('discard-btn').addEventListener('click', () => {
        Storage.clear();
        showScreen('start');
      });
    } else {
      // Auto-resume recent session
      session = saved;
      SoundPlayer.init();
      showScreen('session');
      Timer.start();
      showAudioBanner();
    }
  } else {
    showScreen('start');
  }

  // Start button
  $('start-btn').addEventListener('click', () => {
    SoundPlayer.init();
    session = createSession();
    Storage.save(session);
    showScreen('session');
    Timer.start();
  });

  // Foot pedal
  document.addEventListener('keydown', Input.handleKeyPress);

  // Tab switches
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      Input.handleTabSwitch(tab.dataset.section);
    });
  });

  // Undo
  $('undo-btn').addEventListener('click', Input.handleUndo);

  // End session
  $('end-btn').addEventListener('click', Input.handleEndSession);

  // New session from summary
  $('new-session-btn').addEventListener('click', () => {
    Storage.clear();
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
