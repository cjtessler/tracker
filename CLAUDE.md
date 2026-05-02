# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pedal Tracker is a vanilla HTML/CSS/JS application that tracks foot pedal presses across three sections (CB-105, PVS, PVSI). It is designed for a **fixed 800x480 viewport** and deployed on a 5-inch touchscreen running FullPageOS. There is no build system, package manager, or test framework.

## Running

Open `index.html` directly in a browser. No build step or server required.

## Architecture

All application logic lives in these files:

- **app.js** — Single-file application using object-literal modules: `Storage` (localStorage wrapper), `SoundPlayer` (Web Audio API tones), `Timer` (elapsed time + minute alerts), `UI` (rendering + flash feedback), `Input` (keydown handler + undo), `PinGate` (4-digit unlock screen). Global `session` object holds all state.
- **sync.js** — `window.Sync` module that mirrors completed sessions to Supabase via PostgREST (raw `fetch`, no SDK). Exposes `init`, `upsert`, `remove`, `removeAll`, `pull`, `flush`, `subscribe`. Used by Storage method wrappers in `app.js`.
- **config.js** — Hardcoded constants: `supabaseUrl`, `supabaseAnonKey`, `pin`. Edited per-deployment and committed (anon key is public-by-design; PIN is a UX gate).
- **supabase-schema.sql** — DDL for the `public.sessions` table + anon-role RLS policies. Paste into the Supabase SQL editor once.
- **style.css** — Hardcoded to 800x480 dimensions. Dark theme with `#6367FF` accent color.
- **index.html** — Screen divs toggled via `showScreen()`: pin, start, resume, session, save-discard, summary, history, history-detail, stats.

### Sync & PIN

- **Offline-first**: localStorage is the source of truth. `sync.js` is a write fan-out + a startup pull-and-merge. The app remains fully functional with `config.js` missing or with no network.
- **Sync queue** persists in `pedal-tracker-sync-queue`; failed pushes retry every 30s and on `window.online`. Items that 4xx three times move to `pedal-tracker-sync-deadletter`.
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

## Planned Work

See `TODO.md` for the feature backlog: pause timer, mute toggle, widgets, session history/stats, and export.
