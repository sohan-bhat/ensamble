const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Serve the Vite production build. During development the React app runs on
// Vite's dev server (npm run dev → :5173) which proxies /api requests here.
app.use(express.static(path.join(__dirname, 'dist')));

// DATABASE_URL: `file:...` for local dev (default), `libsql://...` for Turso.
// Auth token only needed for hosted Turso DBs.
const DATABASE_URL = process.env.DATABASE_URL || `file:${path.join(__dirname, 'data/ensemble.db')}`;
if (DATABASE_URL.startsWith('file:')) {
  const dir = path.dirname(DATABASE_URL.slice(5));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const db = createClient({
  url: DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

// libSQL is async, so all DB setup runs inside this IIFE before app.listen().
(async () => {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS score (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      title TEXT NOT NULL DEFAULT 'Global Symphonia No. 1',
      key_signature TEXT NOT NULL DEFAULT 'D',
      time_signature TEXT NOT NULL DEFAULT '4/4',
      tempo INTEGER NOT NULL DEFAULT 100,
      total_measures INTEGER NOT NULL DEFAULT 32
    )`,
    `CREATE TABLE IF NOT EXISTS instruments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      abbreviation TEXT NOT NULL,
      clef TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      instrument_id TEXT NOT NULL,
      pitch TEXT NOT NULL,
      measure INTEGER NOT NULL,
      beat REAL NOT NULL,
      duration TEXT NOT NULL,
      is_rest INTEGER NOT NULL DEFAULT 0,
      accidental TEXT,
      dynamic TEXT DEFAULT 'mf',
      vibrato INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (instrument_id) REFERENCES instruments(id)
    )`,
    `CREATE TABLE IF NOT EXISTS measure_signatures (
      measure INTEGER PRIMARY KEY,
      key_signature TEXT,
      time_signature TEXT,
      tempo INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_instrument ON notes(instrument_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_measure    ON notes(measure)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_created    ON notes(created_at)`,
  ], 'write');

  // Idempotent column adds — swallow "duplicate column" errors so existing dev DBs upgrade in place.
  for (const stmt of [
    'ALTER TABLE measure_signatures ADD COLUMN tempo INTEGER',
    'ALTER TABLE notes ADD COLUMN city TEXT',
    'ALTER TABLE notes ADD COLUMN country TEXT',
  ]) {
    try { await db.execute(stmt); } catch (_) {}
  }

  const scoreCount = (await db.execute('SELECT COUNT(*) as count FROM score')).rows[0].count;
  if (scoreCount === 0) {
    await db.execute(`INSERT INTO score (id, title, key_signature, time_signature, tempo, total_measures)
                      VALUES (1, 'Global Symphonia No. 1', 'D', '4/4', 100, 32)`);
  } else {
    await db.execute(`UPDATE score SET title = 'Global Symphonia No. 1' WHERE id = 1`);
  }

  const instCount = (await db.execute('SELECT COUNT(*) as count FROM instruments')).rows[0].count;
  if (instCount === 0) {
    await db.batch([
      { sql: 'INSERT INTO instruments VALUES (?, ?, ?, ?, ?)', args: ['violin1',    'Violin I',    'Vln. I',  'treble', 1] },
      { sql: 'INSERT INTO instruments VALUES (?, ?, ?, ?, ?)', args: ['violin2',    'Violin II',   'Vln. II', 'treble', 2] },
      { sql: 'INSERT INTO instruments VALUES (?, ?, ?, ?, ?)', args: ['viola',      'Viola',       'Vla.',    'alto',   3] },
      { sql: 'INSERT INTO instruments VALUES (?, ?, ?, ?, ?)', args: ['cello',      'Violoncello', 'Vc.',     'bass',   4] },
      { sql: 'INSERT INTO instruments VALUES (?, ?, ?, ?, ?)', args: ['contrabass', 'Contrabass',  'Cb.',     'bass',   5] },
    ], 'write');
  }

  app.listen(PORT, () => {
    console.log(`Ensemble running at http://localhost:${PORT}`);
  });
})().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* client gone — close handler will clean up */ }
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disables proxy buffering (nginx, Render, etc.) so events flush immediately
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);

  // Periodic comment-line ping so idle connections survive proxy/browser timeouts.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/score', async (req, res) => {
  const [score, instruments, notes, measureSignatures] = await Promise.all([
    db.execute('SELECT * FROM score WHERE id = 1').then(r => r.rows[0]),
    db.execute('SELECT * FROM instruments ORDER BY sort_order').then(r => r.rows),
    db.execute('SELECT * FROM notes ORDER BY measure, beat').then(r => r.rows),
    db.execute('SELECT * FROM measure_signatures ORDER BY measure').then(r => r.rows),
  ]);
  res.json({ score, instruments, notes, measureSignatures });
});

// Mirror of the frontend DUR_TO_BEATS in vexflow-helpers.js — kept in sync by hand.
const DUR_TO_BEATS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25 };

async function effectiveBeatsForMeasure(measure) {
  const score = (await db.execute('SELECT time_signature FROM score WHERE id = 1')).rows[0];
  const sigs = (await db.execute({
    sql: 'SELECT measure, time_signature FROM measure_signatures WHERE measure <= ? ORDER BY measure',
    args: [measure],
  })).rows;
  let time = score.time_signature;
  for (const s of sigs) {
    if (s.time_signature) time = s.time_signature;
  }
  return parseInt(time.split('/')[0], 10);
}

app.post('/api/notes', async (req, res) => {
  const { instrument_id, pitch, measure, beat, duration, is_rest, accidental, dynamic, vibrato, session_id, city, country } = req.body;

  const score = (await db.execute('SELECT total_measures FROM score WHERE id = 1')).rows[0];
  if (measure < 1 || measure > score.total_measures) {
    return res.status(400).json({ error: 'Measure out of range' });
  }

  const newBeats = DUR_TO_BEATS[duration];
  if (newBeats === undefined) return res.status(400).json({ error: 'Invalid duration' });
  const beatsPerMeasure = await effectiveBeatsForMeasure(measure);
  if (beat + newBeats - 1 > beatsPerMeasure) {
    return res.status(400).json({ error: 'Note extends past end of measure' });
  }
  const existing = (await db.execute({
    sql: 'SELECT duration FROM notes WHERE instrument_id = ? AND measure = ?',
    args: [instrument_id, measure],
  })).rows;
  const usedBeats = existing.reduce((sum, n) => sum + (DUR_TO_BEATS[n.duration] || 0), 0);
  if (usedBeats + newBeats > beatsPerMeasure) {
    return res.status(409).json({ error: 'Measure is full' });
  }

  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO notes (id, instrument_id, pitch, measure, beat, duration, is_rest, accidental, dynamic, vibrato, session_id, city, country)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, instrument_id, pitch, measure, beat, duration, is_rest ? 1 : 0, accidental || null, dynamic || 'mf', vibrato ? 1 : 0, session_id, city || null, country || null],
  });

  const note = (await db.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [id] })).rows[0];
  broadcast('note-added', note);
  res.json(note);
});

app.delete('/api/notes/:id', async (req, res) => {
  const { session_id } = req.body || {};
  const result = await db.execute({
    sql: 'DELETE FROM notes WHERE id = ? AND session_id = ?',
    args: [req.params.id, session_id],
  });
  if (result.rowsAffected > 0) {
    broadcast('note-deleted', { id: req.params.id });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Note not found or not owned by this session' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  const { pitch, beat, duration, accidental, dynamic, vibrato } = req.body;
  const result = await db.execute({
    sql: `UPDATE notes SET pitch = ?, beat = ?, duration = ?, accidental = ?, dynamic = ?, vibrato = ?
          WHERE id = ?`,
    args: [pitch, beat, duration, accidental || null, dynamic || 'mf', vibrato ? 1 : 0, req.params.id],
  });
  if (result.rowsAffected > 0) {
    const note = (await db.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [req.params.id] })).rows[0];
    broadcast('note-updated', note);
    res.json(note);
  } else {
    res.status(404).json({ error: 'Note not found' });
  }
});

app.put('/api/measure-signature/:measure', async (req, res) => {
  const measure = parseInt(req.params.measure);
  const { key_signature, time_signature, tempo } = req.body;
  const score = (await db.execute('SELECT total_measures FROM score WHERE id = 1')).rows[0];
  if (measure < 1 || measure > score.total_measures) {
    return res.status(400).json({ error: 'Measure out of range' });
  }
  if (tempo !== undefined && tempo !== null && (tempo < 20 || tempo > 300)) {
    return res.status(400).json({ error: 'Tempo must be between 20 and 300 BPM' });
  }
  await db.execute({
    sql: `INSERT INTO measure_signatures (measure, key_signature, time_signature, tempo)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(measure) DO UPDATE SET
            key_signature = excluded.key_signature,
            time_signature = excluded.time_signature,
            tempo = excluded.tempo`,
    args: [measure, key_signature || null, time_signature || null, tempo || null],
  });
  const row = (await db.execute({
    sql: 'SELECT * FROM measure_signatures WHERE measure = ?',
    args: [measure],
  })).rows[0];
  broadcast('measure-signature', row);
  res.json(row);
});

app.delete('/api/measure-signature/:measure', async (req, res) => {
  const measure = parseInt(req.params.measure);
  await db.execute({ sql: 'DELETE FROM measure_signatures WHERE measure = ?', args: [measure] });
  broadcast('measure-signature-deleted', { measure });
  res.json({ success: true });
});

app.get('/api/notes/count', async (req, res) => {
  const { count } = (await db.execute('SELECT COUNT(*) as count FROM notes WHERE is_rest = 0')).rows[0];
  res.json({ count });
});

app.get('/api/contributions', async (req, res) => {
  const contributions = (await db.execute(`
    SELECT city, country, created_at
    FROM notes
    WHERE city IS NOT NULL AND country IS NOT NULL AND is_rest = 0
    ORDER BY created_at DESC
    LIMIT 50
  `)).rows;
  const latest = contributions[0] || null;
  res.json({ contributions, latest });
});

// SPA fallback: any non-API GET that didn't match a static file gets the
// React index so client-side routing (e.g. /app) works on direct load.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else next();
});
