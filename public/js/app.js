// =========================================================================
// Ensemble — Main Application
// =========================================================================

import { API } from './api.js';
import { ScoreRenderer } from './renderer.js';
import { NoteEditor } from './editor.js';
import { PlaybackEngine } from './playback.js';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const SESSION_ID = crypto.randomUUID();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scoreData = null;
let currentMeasure = 1;
let lastFetchTime = null;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
const renderer = new ScoreRenderer('score');
const playback = new PlaybackEngine();
let editor = null; // initialized after first fetch

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    scoreData = await API.fetchScore();
  } catch (err) {
    document.getElementById('score').innerHTML =
      '<p style="padding:2rem;color:#9A9590;">Could not load score. Is the server running?</p>';
    console.error(err);
    return;
  }

  // Set metadata in UI
  const { score } = scoreData;
  document.querySelector('.piece-title').textContent = score.title;
  document.getElementById('tempo-value').textContent = score.tempo;
  document.querySelector('.key-sig').textContent = formatKey(score.key_signature);
  document.querySelector('.time-sig').textContent = score.time_signature;
  document.querySelector('.tempo-display').innerHTML = `&#9833; = ${score.tempo}`;

  updateNoteCount();

  // Render score
  renderer.render(scoreData);

  // Init editor
  editor = new NoteEditor({
    sessionId: SESSION_ID,
    scoreData,
    onNoteAdded: (note) => {
      renderer.render(scoreData);
      updateNoteCount();
      // Set playback start to this measure so user hears their new note
      currentMeasure = note.measure;
      document.getElementById('measure-indicator').textContent = `Measure ${currentMeasure}`;
    },
    onNoteDeleted: () => {
      renderer.render(scoreData);
      updateNoteCount();
    },
  });

  // Playback measure callback
  playback.onMeasureChange = (m) => {
    currentMeasure = m;
    document.getElementById('measure-indicator').textContent = `Measure ${m}`;
  };

  // Playhead line
  const playheadEl = document.createElement('div');
  playheadEl.className = 'playhead-line';
  document.getElementById('score-wrapper').appendChild(playheadEl);

  playback.onPlaybackTick = (data) => {
    if (data.stopped) {
      playheadEl.style.display = 'none';
      return;
    }
    const bounds = renderer.getSystemBoundsForMeasure(data.measure);
    if (!bounds) { playheadEl.style.display = 'none'; return; }

    const xPos = bounds.noteStartX + data.beatFraction * (bounds.noteEndX - bounds.noteStartX);
    playheadEl.style.display = 'block';
    playheadEl.style.left = `${xPos}px`;
    playheadEl.style.top = `${bounds.topY}px`;
    playheadEl.style.height = `${bounds.bottomY - bounds.topY}px`;
  };

  // Bind UI
  bindTransport();
  bindScoreClicks();
  bindKeyboard();
  startPolling();

  // Re-render on resize / orientation change for responsive layout
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (scoreData) renderer.render(scoreData);
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Format key signature for display
// ---------------------------------------------------------------------------
function formatKey(key) {
  const names = {
    C: 'C Major', G: 'G Major', D: 'D Major', A: 'A Major',
    E: 'E Major', B: 'B Major', 'F#': 'F♯ Major', 'C#': 'C♯ Major',
    F: 'F Major', Bb: 'B♭ Major', Eb: 'E♭ Major', Ab: 'A♭ Major',
    Db: 'D♭ Major', Gb: 'G♭ Major', Cb: 'C♭ Major',
  };
  return names[key] || key + ' Major';
}

// ---------------------------------------------------------------------------
// Note count
// ---------------------------------------------------------------------------
async function updateNoteCount() {
  try {
    const { count } = await API.fetchNoteCount();
    document.getElementById('note-count-num').textContent = count;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Transport controls
// ---------------------------------------------------------------------------
function bindTransport() {
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const prevBtn = document.getElementById('prev-measure');
  const nextBtn = document.getElementById('next-measure');

  playBtn.addEventListener('click', togglePlayback);
  stopBtn.addEventListener('click', () => {
    playback.stop();
    setPlayingUI(false);
  });

  prevBtn.addEventListener('click', () => {
    if (currentMeasure > 1) {
      currentMeasure--;
      document.getElementById('measure-indicator').textContent = `Measure ${currentMeasure}`;
    }
  });

  nextBtn.addEventListener('click', () => {
    if (scoreData && currentMeasure < scoreData.score.total_measures) {
      currentMeasure++;
      document.getElementById('measure-indicator').textContent = `Measure ${currentMeasure}`;
    }
  });
}

async function togglePlayback() {
  if (playback.playing) {
    playback.stop();
    setPlayingUI(false);
  } else {
    setPlayingUI(true);
    await playback.play(scoreData, currentMeasure);

    // When playback finishes naturally, reset UI
    const checkStop = setInterval(() => {
      if (!playback.playing) {
        setPlayingUI(false);
        clearInterval(checkStop);
      }
    }, 200);
  }
}

function setPlayingUI(playing) {
  document.getElementById('play-icon').style.display = playing ? 'none' : 'block';
  document.getElementById('pause-icon').style.display = playing ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Score click → open editor
// ---------------------------------------------------------------------------
function bindScoreClicks() {
  document.getElementById('score').addEventListener('click', (e) => {
    if (editor && editor.isOpen) return;
    const hit = renderer.hitTest(e.clientX, e.clientY);
    if (hit) {
      editor.updateScoreData(scoreData);
      editor.open(hit.instrumentId, hit.instrumentName, hit.clef, hit.measure);
    }
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlayback();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (editor && editor.isOpen) {
          editor.prevMeasure();
        } else if (currentMeasure > 1) {
          currentMeasure--;
          document.getElementById('measure-indicator').textContent = `Measure ${currentMeasure}`;
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (editor && editor.isOpen) {
          editor.nextMeasure();
        } else if (scoreData && currentMeasure < scoreData.score.total_measures) {
          currentMeasure++;
          document.getElementById('measure-indicator').textContent = `Measure ${currentMeasure}`;
        }
        break;
      case 'e':
      case 'E':
        // Open editor on currently selected instrument (first instrument by default)
        if (editor && !editor.isOpen && scoreData) {
          const inst = scoreData.instruments[0];
          editor.updateScoreData(scoreData);
          editor.open(inst.id, inst.name, inst.clef, currentMeasure);
        }
        break;
      case 'Escape':
        if (editor && editor.isOpen) editor.close();
        break;
      case '1': case '2': case '3': case '4': case '5':
        if (editor && editor.isOpen) {
          editor.selectDuration(parseInt(e.key));
        }
        break;
      case 'r':
      case 'R':
        if (editor && editor.isOpen) editor.toggleRest();
        break;
      case 'v':
      case 'V':
        if (editor && editor.isOpen) editor.toggleVibrato();
        break;
      case 'z':
        if ((e.metaKey || e.ctrlKey) && editor && editor.isOpen) {
          e.preventDefault();
          editor.undo();
        }
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Polling for new notes from other contributors
// ---------------------------------------------------------------------------
function startPolling() {
  lastFetchTime = new Date().toISOString();

  setInterval(async () => {
    if (!lastFetchTime) return;
    try {
      const { notes: newNotes } = await API.fetchNotesSince(lastFetchTime);
      if (newNotes.length > 0) {
        // Merge new notes (avoid duplicates)
        const existingIds = new Set(scoreData.notes.map(n => n.id));
        let added = 0;
        for (const n of newNotes) {
          if (!existingIds.has(n.id)) {
            scoreData.notes.push(n);
            added++;
          }
        }
        if (added > 0) {
          renderer.render(scoreData);
          updateNoteCount();
        }
      }
      lastFetchTime = new Date().toISOString();
    } catch (_) {}
  }, 15000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
