// Generates sample_data_month.json — a month of realistic pedal tracker usage
// ending on 2026-04-16. Run with: node generate_sample_month.js

const fs = require('fs');
const path = require('path');

const SECTIONS = ['CB-105', 'PVS', 'PVSI', 'SMS', 'OP222'];

// Per-section baseline presses/hour and natural variability
const SECTION_PROFILE = {
  'CB-105': { rateMean: 62, rateStd: 8,  minDurMin: 15, maxDurMin: 45 },
  'PVS':    { rateMean: 82, rateStd: 10, minDurMin: 10, maxDurMin: 35 },
  'PVSI':   { rateMean: 70, rateStd: 9,  minDurMin: 12, maxDurMin: 30 },
  'SMS':    { rateMean: 95, rateStd: 12, minDurMin: 10, maxDurMin: 40 },
  'OP222':  { rateMean: 56, rateStd: 7,  minDurMin: 15, maxDurMin: 45 }
};

// Seeded PRNG (mulberry32) so output is reproducible
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260416);

function randRange(lo, hi) { return lo + rng() * (hi - lo); }
function randInt(lo, hi) { return Math.floor(randRange(lo, hi + 1)); }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

// Approximate Gaussian via Box-Muller (two uniforms)
function gauss(mean, std) {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

function emptySections() {
  return {
    'CB-105': { count: 0, timestamps: [] },
    'PVS':    { count: 0, timestamps: [] },
    'PVSI':   { count: 0, timestamps: [] },
    'SMS':    { count: 0, timestamps: [] },
    'OP222':  { count: 0, timestamps: [] }
  };
}

// Generate a single session for a given section starting at startMs.
// Returns { session, endMs }.
function makeSession(section, startMs) {
  const profile = SECTION_PROFILE[section];
  const durMin = Math.max(profile.minDurMin,
    Math.min(profile.maxDurMin, gauss((profile.minDurMin + profile.maxDurMin) / 2, 6)));
  const durMs = Math.round(durMin * 60_000);

  // Target rate for this session (presses / hour)
  const targetRate = Math.max(25, gauss(profile.rateMean, profile.rateStd));
  const meanIntervalMs = 3_600_000 / targetRate;

  // Emit presses with jittered intervals, starting a few seconds after start
  const timestamps = [];
  let t = startMs + Math.round(randRange(2000, 8000));
  const endMs = startMs + durMs;

  while (t < endMs - meanIntervalMs * 0.3) {
    timestamps.push(t);
    // Log-normal-ish jitter: mostly near mean, occasional longer pauses
    let jitter = gauss(meanIntervalMs, meanIntervalMs * 0.25);
    // Occasional pause: 1 in ~25 intervals is 2-4x longer
    if (rng() < 0.04) jitter *= randRange(2, 4);
    jitter = Math.max(400, jitter); // respect minimum reaction time
    t += Math.round(jitter);
  }

  const sections = emptySections();
  sections[section] = { count: timestamps.length, timestamps };

  return {
    endMs,
    session: {
      id: startMs,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      activeSection: section,
      sections
    }
  };
}

// Build a day's sessions. dayStart is a Date at local 00:00.
function makeDaySessions(dayStart) {
  const dow = dayStart.getDay(); // 0 = Sun, 6 = Sat
  const isWeekend = dow === 0 || dow === 6;

  // Session count distribution
  let sessionCount;
  if (isWeekend) {
    sessionCount = rng() < 0.55 ? 0 : (rng() < 0.7 ? 1 : 2);
  } else {
    const r = rng();
    if (r < 0.10) sessionCount = 1;
    else if (r < 0.50) sessionCount = 2;
    else if (r < 0.85) sessionCount = 3;
    else sessionCount = 4;
  }
  if (sessionCount === 0) return [];

  // Work hours: roughly 8am - 5pm local, earlier on weekends
  const startHour = isWeekend ? 10 : 8;
  const endHour = isWeekend ? 15 : 17;

  // Distribute sessions across the day with gaps
  const sessions = [];
  let cursor = new Date(dayStart);
  cursor.setHours(startHour, randInt(0, 30), 0, 0);

  for (let i = 0; i < sessionCount; i++) {
    const section = pick(SECTIONS);
    const { session, endMs } = makeSession(section, cursor.getTime());
    sessions.push(session);

    // Gap between sessions: 15 minutes to ~2 hours
    const gapMin = randInt(15, 110);
    cursor = new Date(endMs + gapMin * 60_000);

    // Stop if we'd run past the workday
    if (cursor.getHours() >= endHour) break;
  }

  return sessions;
}

// Build 30 days of data ending on 2026-04-16 (today per project context)
const END_DAY = new Date(2026, 3, 16); // April 16, 2026 local
END_DAY.setHours(0, 0, 0, 0);
const DAYS = 30;

const allSessions = [];
for (let d = DAYS - 1; d >= 0; d--) {
  const day = new Date(END_DAY);
  day.setDate(END_DAY.getDate() - d);
  allSessions.push(...makeDaySessions(day));
}

// Newest first (history order in the app)
allSessions.sort((a, b) => b.id - a.id);

const payload = {
  exportedAt: '2026-04-16T17:00:00.000Z',
  version: 1,
  sessions: allSessions
};

const outPath = path.join(__dirname, 'sample_data_month.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

// Quick summary
const bySec = {};
let totalPresses = 0;
for (const s of allSessions) {
  bySec[s.activeSection] = (bySec[s.activeSection] || 0) + 1;
  totalPresses += s.sections[s.activeSection].count;
}
console.log(`Wrote ${outPath}`);
console.log(`Sessions: ${allSessions.length}`);
console.log(`Total presses: ${totalPresses}`);
console.log(`By section:`, bySec);
