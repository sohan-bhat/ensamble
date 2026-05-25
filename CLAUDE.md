# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ensemble is a collaborative sheet music platform where multiple users contribute notes to an orchestral score in real-time via a web browser. Think "shared Google Doc for sheet music."

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Vite dev server at http://localhost:5173 (proxies /api → :3000)
npm run server       # Express API + static dist on http://localhost:3000 (with --watch)
npm run build        # Build the React app into dist/
npm start            # Run the Express server (production: serves dist/)
```

Typical workflow: `npm run server` in one terminal, `npm run dev` in another. The Vite dev server proxies `/api` and `/api/events` to the Express server. For production / one-port serving: `npm run build && npm start`.

## Architecture

**Backend**: `server.js` — Single-file Express server with SQLite (better-sqlite3). Serves `dist/` as static files plus an SPA fallback so client-side routes (e.g. `/app`) work on direct load.

**Frontend**: Vite + React (no TypeScript). Entry: `index.html` → `src/main.jsx` → `src/App.jsx` (react-router-dom v6). Two routes: `/` (Home / intro) and `/app` (Score editor).

### Backend (`server.js`)

- Express serves the Vite build from `dist/` and exposes a REST + SSE API
- SQLite database stored at `data/ensemble.db` (WAL mode, foreign keys enabled)
- Database auto-initializes tables and seeds default data on first run
- Four tables: `score` (single-row global metadata), `instruments` (string quintet), `notes` (user-contributed notes, with optional `city`/`country`), `measure_signatures` (per-measure overrides for key/time/tempo)
- In-place column migrations live in `server.js` as `ALTER TABLE ... ADD COLUMN` calls wrapped in try/catch — add new ones the same way so existing dev DBs upgrade automatically
- Server-side note placement check (capacity + tail overflow) is authoritative; client checks are for fast UI feedback
- Session-scoped deletions: notes can only be deleted by the session that created them (note edits via PUT are NOT session-scoped)
- SPA fallback: any non-API GET that doesn't match a static file gets `dist/index.html` so direct loads on `/app` work

### API Endpoints

- `GET /api/score` — Full score: `{ score, instruments, notes, measureSignatures }`
- `GET /api/events` — SSE stream. Emits `note-added` / `note-updated` / `note-deleted` / `measure-signature` / `measure-signature-deleted` events on every mutation. Comment-line ping every 25s keeps idle connections alive through proxies.
- `POST /api/notes` — Add a note (validated server-side; accepts optional `city`/`country`). Rejects with 409 if the measure is full, 400 if the note extends past the final beat.
- `PUT /api/notes/:id` — Edit a note (pitch/beat/duration/accidental/dynamic/vibrato)
- `DELETE /api/notes/:id` — Delete a note (requires matching session_id in body)
- `PUT /api/measure-signature/:measure` — Set key/time/tempo override for a measure
- `DELETE /api/measure-signature/:measure` — Clear a measure's override
- `GET /api/notes/count` — Total note count
- `GET /api/contributions` — Recent notes that carry location data (for the activity feed)

### Frontend layout

```
index.html                        Vite entry (loads /src/main.jsx)
vite.config.mjs                   Plugin-react + dev proxy for /api
src/
  main.jsx                        React root + global CSS imports
  App.jsx                         react-router-dom <Routes>
  api.js                          fetch wrappers around the REST endpoints
  styles/
    style.css                     Shared design tokens + Score-page styles
    welcome.css                   Home-page styles (scroll runway + scenes)
  lib/
    vexflow-helpers.js            Pure helpers + `ScoreRenderer` class (takes DOM
                                  refs, not IDs — composes cleanly with React)
    playback.js                   `PlaybackEngine` class — Web Audio sample
                                  player with MusyngKite mp3s + sine fallback
  hooks/
    useScore.js                   Fetch + EventSource subscription; exposes
                                  `scoreData`, functional setter, `noteCount`
    useSession.js                 Stable session UUID (useRef)
    useGeolocation.js             Cached ipapi.co lookup
  pages/
    Home.jsx                      Hero (dot constellation + cursor-reactive
                                  waves canvas) + sticky-stage scroll runway
                                  with 5 scenes driven by scroll progress
    Score.jsx                     Orchestrator: header + transport +
                                  ScoreRenderer + Editor + HistoryPopup
  components/
    Editor.jsx                    Floating overlay; VexFlow editor stave + beat
                                  grid + ghost canvas (mouse + touch handlers)
    HistoryPopup.jsx              Recent contributions modal
```

### Key React patterns

- `ScoreRenderer` and `PlaybackEngine` are vanilla classes stored in refs and constructed inside a `useEffect` gated on `scoreData` (so DOM refs are populated). Their callbacks (`onMeasureChange`, `onPlaybackTick`) update React state via stable setter refs.
- `scoreData` lives in `useScore`'s state. All SSE handlers use functional updates (`setScoreData(prev => ...)`) with id-based dedupe, so the local POST and the SSE broadcast can race without producing duplicates.
- `Editor.jsx` keeps an immutable `scoreDataRef` alongside the prop so its imperative pointer/keyboard handlers always read the latest notes without re-binding.
- VexFlow rendering is imperative inside a `useEffect` keyed on `scoreData` — React doesn't try to diff thousands of SVG elements.

### Key design decisions

- No authentication — users are identified by a random session UUID (`crypto.randomUUID`)
- Real-time sync uses Server-Sent Events (one-way server→client); state-changing actions still go over the REST API
- VexFlow is the `vexflow` npm package (v4.2.3), imported with named exports — not the CDN script tag
- Default score is D Major, 4/4, 32 measures, 5 string instruments — but any measure can override key/time/tempo via the `measure_signatures` table
- Location tracking is IP-based (no browser permission prompt) and best-effort: notes created before geolocation resolves, or when the API fails, persist with `null` city/country
- Database seeds a 4-measure harmonic progression (D→A→Bm→G) on empty init
