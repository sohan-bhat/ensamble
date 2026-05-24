# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ensemble is a collaborative sheet music platform where multiple users contribute notes to an orchestral score in real-time via a web browser. Think "shared Google Doc for sheet music."

## Commands

```bash
npm install          # Install dependencies
npm start            # Start server at http://localhost:3000
npm run dev          # Start with auto-reload (node --watch)
```

There is no build step, test suite, or linter configured. Frontend files are served as static assets.

## Architecture

**Backend**: `server.js` — Single-file Express server with SQLite (better-sqlite3).

**Frontend**: Vanilla ES6 modules in `public/js/`, no bundler. Loaded via `<script type="module">` in `public/index.html`.

### Backend (`server.js`)

- Express serves static files from `public/` and exposes a REST API
- SQLite database stored at `data/ensemble.db` (WAL mode, foreign keys enabled)
- Database auto-initializes tables and seeds default data on first run
- Four tables: `score` (single-row global metadata), `instruments` (string quintet), `notes` (user-contributed notes, with optional `city`/`country`), `measure_signatures` (per-measure overrides for key/time/tempo)
- In-place column migrations live in `server.js` as `ALTER TABLE ... ADD COLUMN` calls wrapped in try/catch — add new ones the same way so existing dev DBs upgrade automatically
- Session-scoped deletions: notes can only be deleted by the session that created them (note edits via PUT are NOT session-scoped)

### API Endpoints

- `GET /api/score` — Full score: `{ score, instruments, notes, measureSignatures }`
- `GET /api/events` — SSE stream. Emits `note-added` / `note-updated` / `note-deleted` / `measure-signature` / `measure-signature-deleted` events on every mutation. Comment-line ping every 25s keeps idle connections alive through proxies.
- `POST /api/notes` — Add a note (validated server-side; accepts optional `city`/`country`)
- `PUT /api/notes/:id` — Edit a note (pitch/beat/duration/accidental/dynamic/vibrato)
- `DELETE /api/notes/:id` — Delete a note (requires matching session_id in body)
- `PUT /api/measure-signature/:measure` — Set key/time/tempo override for a measure
- `DELETE /api/measure-signature/:measure` — Clear a measure's override
- `GET /api/notes/count` — Total note count
- `GET /api/contributions` — Recent notes that carry location data (for the activity feed)

### Frontend Modules (`public/js/`)

- **app.js** — Main controller. Bootstraps all modules, manages state (`scoreData`, `currentMeasure`), handles keyboard shortcuts, and runs an `EventSource` against `/api/events` for real-time collaborative sync (every reconnect refetches the full score for catch-up). Also fetches IP-based geolocation (ipapi.co) on load and caches it in `localStorage` under `ensemble_location`; the city/country are then attached to every new note the user creates.
- **renderer.js** — Renders the full orchestral score as SVG using VexFlow (loaded from CDN). Handles multi-system layout (4 measures/system), key signature accidentals, auto-resting, and hit-testing for click interactions. Per-measure signature overrides from `measureSignatures` change the key/time/tempo mid-score.
- **editor.js** — Floating overlay for adding/editing notes in a measure. Supports pitch selection via visual staff, duration (1-5 keys), accidentals, rests (R key), dynamics, undo (Ctrl+Z), and ghost note preview. Has parallel mouse + touch handlers so the editor works on mobile.
- **playback.js** — Sample-based playback via Web Audio. Loads MusyngKite mp3s from the MIDI.js Soundfonts project on demand and caches decoded buffers in a `SampleCache`. Master chain is per-note Gain → dry bus → ConvolverReverb + Compressor → destination. Falls back to a sine oscillator if a sample fails to load. Soundfont filenames use flats (Db4, not C#4) — see `SHARP_TO_FLAT`.
- **api.js** — Thin fetch wrapper around all backend endpoints

### Key Design Decisions

- No authentication — users are identified by a random session UUID (`crypto.randomUUID`)
- Real-time sync uses Server-Sent Events (one-way server→client); state-changing actions still go over the REST API
- VexFlow 4.2.3 is loaded from CDN, not bundled
- Default score is D Major, 4/4, 32 measures, 5 string instruments — but any measure can override key/time/tempo via the `measure_signatures` table
- Location tracking is IP-based (no browser permission prompt) and best-effort: notes created before geolocation resolves, or when the API fails, persist with `null` city/country
- Database seeds a 4-measure harmonic progression (D→A→Bm→G) on empty init
