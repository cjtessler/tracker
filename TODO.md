# Pedal Tracker — TODO

## Priority Features

- [ ] **Pause timer** — Add a pause/resume button so the user can pause the elapsed timer (e.g., during breaks) without ending the session. Paused time should not count toward rate calculations.
- [ ] **Mute alerts** — Add a toggle to mute both audio alerts (minute beeps, press clicks) and visual alerts (flash overlay, timer color pulsing). Persist the mute preference across sessions.
- [ ] **Calmer color palette** — Replace the high-contrast red (`#e94560`) and neon green (`#00ff88`) accents with softer, muted tones. Reduce the intensity of the timer warning/alert states and the flash overlay.
- [ ] **Widgets** — Add configurable widgets to the session screen (e.g., session elapsed time, per-section mini charts, interval trend indicator, target pace tracker).
- [ ] **Stats from main page** — Add a "View Stats" button on the start screen that opens a stats view showing historical review session data and normalized performance metrics (presses/min adjusted for pauses, consistency scores, section-by-section comparisons across sessions).

---

## Recommendations

- [ ] **Session history** — Persist completed sessions to localStorage (or IndexedDB) so the user can review past sessions, not just the most recent one. This also supports the stats/normalized performance feature.
- [ ] **Export data** — Allow exporting session data as CSV or JSON for external analysis.
- [ ] **Configurable alert thresholds** — Let the user set the warning (currently 45s) and alert (currently 60s) thresholds instead of hardcoding them.
- [ ] **Target pace mode** — Set a target presses-per-minute and show a visual indicator of whether the user is above or below pace.
- [ ] **Dark/light theme toggle** — Provide a light theme option alongside the calmer color rework for different lighting conditions.
- [ ] **Keyboard shortcut hints** — Show a small hint on the session screen that `B` is the pedal key, especially for first-time use.
- [ ] **Session notes** — Let the user attach a short text note to a session before or after ending it, for context when reviewing history.
