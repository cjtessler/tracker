# Pedal Tracker — TODO

## Backlog

- [ ] **Session notes & tags** — Optional free-text note and up to 3 tags per session, editable on the summary screen and visible in history detail. Tags filter the history list and can be overlaid on the stats chart (e.g., tag color dots per point).
- [ ] **Daily & weekly summaries** — New stats tab showing per-day totals (presses, sessions, avg rate) and a 7-day rolling view. Highlight best/worst days and surface streaks (consecutive days with at least one session).
- [ ] **Cross-section overlay on stats chart** — Option on the stats screen to overlay all sections on one chart (color-coded lines) instead of one section at a time. Helps spot sections where pace consistently lags the others.
- [ ] **Widgets** — Add configurable widgets to the session screen (e.g., per-section mini charts, interval trend indicator).

---

## Completed

- [x] **Audio volume controls** — Tones routed through a master gain node and normalized so press, minute alert, and nudge sound comparable at default. Replaced mute toggles with 0–100% volume steppers (10% increments) per sound type, each with a speaker preview button. Legacy `pressBeep`/`minuteAlert` booleans migrate to volume values on load.
- [x] **Goal-setting per section** — Tap the goal stat during a session to set a target rate (presses/hr) via a stepper modal. Per Hour turns red below goal and green at/above. Goals persist per section in settings. *(194d010)*
- [x] **Dark/light theme toggle** — CSS custom properties for full theming (dark default, light variant). Theme toggle in settings panel, persisted to localStorage. *(692f862)*
- [x] **Configurable alert thresholds** — Per-section warning/alert threshold steppers (5s increments) in settings modal. Timer color coding reads configured thresholds instead of hardcoded 45/60s. *(0656af6)*
- [x] **Mute alerts** — Toggle switches for press beep and minute alert sounds in settings panel. Preference persisted to localStorage. *(0656af6)*
- [x] **Settings modal** — Gear button on start and session screens opens a persistent settings panel with mute toggles, per-section thresholds, goal rates, theme toggle, and a reload button. *(0656af6, 4d236a5, 9bd17fd)*
- [x] **Stats screen** — Stats page with queue selector and chart canvas showing per-session rate over time with a dashed average reference line. Accessible from start screen. *(7cb6543, 0b7f10b)*
- [x] **Per Hour live stat** — Per Hour rate displayed on the session screen during active sessions. *(7cb6543)*
- [x] **Hold-to-end from pedal** — B key hold ends an active session (tap still records a press). *(7cb6543)*
- [x] **Export data (JSON/CSV)** — Download full session history as lossless JSON backup or summary CSV for spreadsheet analysis. *(f5bdb6e)*
- [x] **Import data (JSON)** — Merge sessions from a backup file, skipping duplicates by id. Feedback banner confirms result. *(f5bdb6e)*
- [x] **Session history** — Persist completed sessions to localStorage with history list and detail screens. *(0d5622c)*
- [x] **Hold-to-start from pedal** — B key hold starts a session from the start screen (tap cycles sections). *(0d5622c)*
- [x] **Calmer color palette** — Softer timer warning/alert colors and pulse animation. *(7cb6543)*
- [x] **Touch-friendly UI** — Larger section buttons, touch targets, and fonts for 5-inch touchscreen use. *(8f5b077, 6f07db8)*
- [x] **Dev utilities** — Sample data JSON and standalone sound tester page for local development. *(76b4458)*
z