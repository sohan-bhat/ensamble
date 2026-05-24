const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'ensemble.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS score (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT NOT NULL DEFAULT 'Global Symphonia No. 1',
    key_signature TEXT NOT NULL DEFAULT 'D',
    time_signature TEXT NOT NULL DEFAULT '4/4',
    tempo INTEGER NOT NULL DEFAULT 100,
    total_measures INTEGER NOT NULL DEFAULT 32
  );

  CREATE TABLE IF NOT EXISTS instruments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    abbreviation TEXT NOT NULL,
    clef TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
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
  );

  CREATE TABLE IF NOT EXISTS measure_signatures (
    measure INTEGER PRIMARY KEY,
    key_signature TEXT,
    time_signature TEXT,
    tempo INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_notes_instrument ON notes(instrument_id);
  CREATE INDEX IF NOT EXISTS idx_notes_measure ON notes(measure);
  CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
`);

// Idempotent column adds — swallow "duplicate column" errors so existing dev DBs upgrade in place.
try { db.exec('ALTER TABLE measure_signatures ADD COLUMN tempo INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE notes ADD COLUMN city TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE notes ADD COLUMN country TEXT'); } catch (_) {}

const scoreExists = db.prepare('SELECT COUNT(*) as count FROM score').get();
if (scoreExists.count === 0) {
  db.prepare(`INSERT INTO score (id, title, key_signature, time_signature, tempo, total_measures)
              VALUES (1, 'Global Symphonia No. 1', 'D', '4/4', 100, 32)`).run();
} else {
  db.prepare(`UPDATE score SET title = 'Global Symphonia No. 1' WHERE id = 1`).run();
}

const instrumentCount = db.prepare('SELECT COUNT(*) as count FROM instruments').get();
if (instrumentCount.count === 0) {
  const ins = db.prepare('INSERT INTO instruments VALUES (?, ?, ?, ?, ?)');
  ins.run('violin1',    'Violin I',      'Vln. I',  'treble', 1);
  ins.run('violin2',    'Violin II',     'Vln. II', 'treble', 2);
  ins.run('viola',      'Viola',         'Vla.',    'alto',   3);
  ins.run('cello',      'Violoncello',   'Vc.',     'bass',   4);
  ins.run('contrabass', 'Contrabass',    'Cb.',     'bass',   5);
}

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
    'X-Accel-Buffering': 'no', // disables proxy buffering (nginx) so events flush immediately
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

app.get('/api/score', (req, res) => {
  const score = db.prepare('SELECT * FROM score WHERE id = 1').get();
  const instruments = db.prepare('SELECT * FROM instruments ORDER BY sort_order').all();
  const notes = db.prepare('SELECT * FROM notes ORDER BY measure, beat').all();
  const measureSignatures = db.prepare('SELECT * FROM measure_signatures ORDER BY measure').all();
  res.json({ score, instruments, notes, measureSignatures });
});

app.post('/api/notes', (req, res) => {
  const { instrument_id, pitch, measure, beat, duration, is_rest, accidental, dynamic, vibrato, session_id } = req.body;

  const score = db.prepare('SELECT total_measures FROM score WHERE id = 1').get();
  if (measure < 1 || measure > score.total_measures) {
    return res.status(400).json({ error: 'Measure out of range' });
  }

  const id = randomUUID();
  const { city, country } = req.body;
  db.prepare(`
    INSERT INTO notes (id, instrument_id, pitch, measure, beat, duration, is_rest, accidental, dynamic, vibrato, session_id, city, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, instrument_id, pitch, measure, beat, duration, is_rest ? 1 : 0, accidental || null, dynamic || 'mf', vibrato ? 1 : 0, session_id, city || null, country || null);

  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  broadcast('note-added', note);
  res.json(note);
});

app.delete('/api/notes/:id', (req, res) => {
  const { session_id } = req.body || {};
  const result = db.prepare('DELETE FROM notes WHERE id = ? AND session_id = ?').run(req.params.id, session_id);
  if (result.changes > 0) {
    broadcast('note-deleted', { id: req.params.id });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Note not found or not owned by this session' });
  }
});

app.put('/api/notes/:id', (req, res) => {
  const { pitch, beat, duration, accidental, dynamic, vibrato } = req.body;
  const result = db.prepare(`
    UPDATE notes SET pitch = ?, beat = ?, duration = ?, accidental = ?, dynamic = ?, vibrato = ?
    WHERE id = ?
  `).run(pitch, beat, duration, accidental || null, dynamic || 'mf', vibrato ? 1 : 0, req.params.id);
  if (result.changes > 0) {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
    broadcast('note-updated', note);
    res.json(note);
  } else {
    res.status(404).json({ error: 'Note not found' });
  }
});

app.put('/api/measure-signature/:measure', (req, res) => {
  const measure = parseInt(req.params.measure);
  const { key_signature, time_signature, tempo } = req.body;
  const score = db.prepare('SELECT total_measures FROM score WHERE id = 1').get();
  if (measure < 1 || measure > score.total_measures) {
    return res.status(400).json({ error: 'Measure out of range' });
  }
  if (tempo !== undefined && tempo !== null && (tempo < 20 || tempo > 300)) {
    return res.status(400).json({ error: 'Tempo must be between 20 and 300 BPM' });
  }
  db.prepare(`
    INSERT INTO measure_signatures (measure, key_signature, time_signature, tempo)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(measure) DO UPDATE SET
      key_signature = excluded.key_signature,
      time_signature = excluded.time_signature,
      tempo = excluded.tempo
  `).run(measure, key_signature || null, time_signature || null, tempo || null);
  const row = db.prepare('SELECT * FROM measure_signatures WHERE measure = ?').get(measure);
  broadcast('measure-signature', row);
  res.json(row);
});

app.delete('/api/measure-signature/:measure', (req, res) => {
  const measure = parseInt(req.params.measure);
  db.prepare('DELETE FROM measure_signatures WHERE measure = ?').run(measure);
  broadcast('measure-signature-deleted', { measure });
  res.json({ success: true });
});

app.get('/api/notes/count', (req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM notes WHERE is_rest = 0').get();
  res.json({ count });
});

app.get('/api/contributions', (req, res) => {
  const contributions = db.prepare(`
    SELECT city, country, created_at
    FROM notes
    WHERE city IS NOT NULL AND country IS NOT NULL AND is_rest = 0
    ORDER BY created_at DESC
    LIMIT 50
  `).all();
  const latest = db.prepare(`
    SELECT city, country, created_at
    FROM notes
    WHERE city IS NOT NULL AND country IS NOT NULL AND is_rest = 0
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  res.json({ contributions, latest });
});

app.listen(PORT, () => {
  console.log(`Ensemble running at http://localhost:${PORT}`);
});
