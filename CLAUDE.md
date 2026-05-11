# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pedal Tracker is a vanilla HTML/CSS/JS application that tracks foot pedal presses across three sections (CB-105, PVS, PVSI). It is designed for a **fixed 800x480 viewport** and deployed on a 5-inch touchscreen running FullPageOS. There is no build system, package manager, or test framework.

## Running

Open `index.html` directly in a browser. No build step or server required.

## Local Testing — Do Not Pollute Production

`config.js` is committed with **live production Supabase credentials**. Opening `index.html` on a dev machine with that file unmodified writes test sessions straight into the production `sessions` table. Always set up a local override before doing any verification work.

**Override mechanism.** `index.html` loads `config.js`, then `config.local.js`, then `sync.js`. `config.local.js` is gitignored. When it exists it overwrites `window.APP_CONFIG` before sync reads it; when it doesn't exist the script tag 404s silently and production values stand (correct behavior on the Pi).

**Setup (one-time on each dev machine):**
1. `cp config.local.example.js config.local.js`
2. Leave it on the default **offline mode** — `supabaseUrl` / `supabaseAnonKey` set to the placeholder strings `"YOUR-PROJECT"` / `"YOUR-ANON-KEY"`. `Sync.configured()` returns false, sync goes to `disabled` state, no network calls leave the browser. This is the default for almost all dev work.
3. Only switch to **sandbox mode** (a second, throwaway Supabase project — apply `supabase-schema.sql` there first) when you specifically need to test sync code paths end-to-end. Never paste production credentials into `config.local.js`.

**Switching between test and production data on the same machine** (e.g., you ran in offline mode for a while and now want to test against the real Pi data): clear all eight `pedal-tracker-*` localStorage keys via DevTools → Application → Local Storage → right-click origin → Clear. Otherwise the offline-mode session/history rows persist and look like production rows.

**Sanity check before you commit:** confirm `config.local.js` is still gitignored (`git status` should not show it) and that any code change you made still works against production credentials when `config.local.js` is removed.

## Architecture

All application logic lives in these files:

- **app.js** — Single-file application using object-literal modules: `Storage` (localStorage wrapper), `SoundPlayer` (Web Audio API tones), `Timer` (elapsed time + minute alerts), `UI` (rendering + flash feedback), `Input` (keydown handler + undo), `PinGate` (4-digit unlock screen). Global `session` object holds all state.
- **sync.js** — `window.Sync` module that mirrors completed sessions to Supabase via PostgREST (raw `fetch`, no SDK). Exposes `init`, `upsert`, `remove`, `removeAll`, `pull`, `flush`, `syncNow`, `subscribe`, `getLastSyncAt`. Used by Storage method wrappers in `app.js`.
- **config.js** — Hardcoded constants: `supabaseUrl`, `supabaseAnonKey`, `pin`. Edited per-deployment and committed (anon key is public-by-design; PIN is a UX gate).
- **supabase-schema.sql** — DDL for the `public.sessions` table + anon-role RLS policies. Paste into the Supabase SQL editor once.
- **style.css** — Hardcoded to 800x480 dimensions. Dark theme with `#6367FF` accent color.
- **index.html** — Screen divs toggled via `showScreen()`: pin, start, resume, session, save-discard, summary, history, history-detail, stats.

### Sync & PIN

- **Offline-first**: localStorage is the source of truth. The app remains fully functional with `config.js` missing or with no network.
- **Scheduled sync, not live**: `Sync.init()` does no network. Completed-session writes are queued locally but **not** flushed immediately. A scheduler fires once a day at **9:00 PM America/New_York** (DST-safe) and runs `flush → pull → flush`. The user can also tap the **"Sync Now"** button in the History footer at any time. There is no 30 s retry loop, no `window.online` flush, and no startup sync — strict 9 PM only. This trades cross-device freshness for zero background CPU/network during work hours (the device is on overnight).
- **Sync queue** persists in `pedal-tracker-sync-queue`. Items that 4xx three times move to `pedal-tracker-sync-deadletter`. If a scheduled or manual sync fails (offline / 5xx), the queue is preserved and drains on the next 9 PM run or the next Sync Now tap.
- **Last-sync timestamp** persists in `pedal-tracker-last-sync-at` (ISO) and is rendered in the History footer.
- **Pull-only-adds policy**: `Sync.pull()` never deletes local rows that are missing remotely. Trade-off: a "ghost" row can survive cross-device deletes; clear via History → Delete.
- **PIN gate**: a 4-digit numeric PIN (defined in `config.js`) is required once per device on first load. Verified flag stored in `localStorage['pedal-tracker-pin-verified']`. Remove that key to re-prompt.

## Key Behaviors

- The **`B` key** is the pedal input — it records a press during an active session or starts a session from the start screen.
- Presses are **debounced at 200ms** (`DEBOUNCE_MS`).
- Sessions **auto-save to localStorage** every 5 seconds. Sessions inactive for 30+ minutes trigger a resume prompt.
- The "End Session" button requires a **double-tap confirmation** (3-second window).
- Timer turns warning color at 45s and alert/pulsing at 60s since last press.
- Each session is locked to a single section (selected on start screen).
- **Per-hour rate is the headline metric.** Presses per hour is the most important number for the operator — display it most prominently wherever session results are shown (especially the End Session / save-discard screen, the in-session stats bar, and the post-session Summary). Other stats (avg interval, presses per minute, totals) are supporting context, not the lead.

## Versioning

- `APP_VERSION` in [app.js](app.js) (top of file) is rendered in the Settings header. **Bump it on every user-visible change** (UI tweaks, new behavior, bug fixes that change interaction). Use semver: patch for fixes, minor for new behavior, major for breaking UX. Bump as part of the same commit so the displayed version always matches the deployed code.

## Planned Work

See `TODO.md` for the feature backlog: pause timer, mute toggle, widgets, session history/stats, and export.
