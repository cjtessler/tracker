# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pedal Tracker is a vanilla HTML/CSS/JS application that tracks foot pedal presses across three sections (CB-105, PVS, PVSI). It is designed for a **fixed 800x480 viewport** and deployed on a 5-inch touchscreen running FullPageOS. There is no build system, package manager, or test framework.

## Running

Open `index.html` directly in a browser. No build step or server required.

## Architecture

All application logic lives in three files:

- **app.js** — Single-file application using object-literal modules: `Storage` (localStorage wrapper), `SoundPlayer` (Web Audio API tones), `Timer` (elapsed time + minute alerts), `UI` (rendering + flash feedback), `Input` (keydown handler + undo). Global `session` object holds all state.
- **style.css** — Hardcoded to 800x480 dimensions. Dark theme with `#6367FF` accent color.
- **index.html** — Five screen divs toggled via `showScreen()`: start, resume, session, save-discard, summary.

## Key Behaviors

- The **`B` key** is the pedal input — it records a press during an active session or starts a session from the start screen.
- Presses are **debounced at 200ms** (`DEBOUNCE_MS`).
- Sessions **auto-save to localStorage** every 5 seconds. Sessions inactive for 30+ minutes trigger a resume prompt.
- The "End Session" button requires a **double-tap confirmation** (3-second window).
- Timer turns warning color at 45s and alert/pulsing at 60s since last press.
- Each session is locked to a single section (selected on start screen).

## Planned Work

See `TODO.md` for the feature backlog: pause timer, mute toggle, widgets, session history/stats, and export.
