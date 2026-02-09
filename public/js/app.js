// =========================================================================
// Ensemble — Main Application
// =========================================================================

import { API } from './api.js';
import { ScoreRenderer, getEffectiveSignature } from './renderer.js';
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
// Restore cached location immediately so it's available before geocode resolves
const cachedLoc = localStorage.getItem('ensemble_location');
let userLocation = cachedLoc ? JSON.parse(cachedLoc) : { city: null, country: null };

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
  updateTransportInfo(currentMeasure);

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
      updateLastLocation();
      // Set playback start to this measure so user hears their new note
      currentMeasure = note.measure;
      document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
    },
    onNoteDeleted: () => {
      renderer.render(scoreData);
      updateNoteCount();
    },
  });

  // Get user location and pass to editor
  initGeolocation();

  // Playback measure callback
  playback.onMeasureChange = (m) => {
    currentMeasure = m;
    document.getElementById('measure-indicator').textContent = `Bar ${m}`;
    updateTransportInfo(m);
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

  // Seek overlay — click/drag on score to jump playback position
  const seekOverlay = document.createElement('div');
  seekOverlay.className = 'seek-overlay';
  document.getElementById('score-wrapper').appendChild(seekOverlay);

  function seekToX(clientX) {
    if (!scoreData) return;
    const wrapper = document.getElementById('score-wrapper');
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left + wrapper.scrollLeft;

    // Find which measure this X falls in
    for (const s of renderer.staveMap) {
      if (x >= s.x && x <= s.x + s.width && s.instrumentId === scoreData.instruments[0].id) {
        currentMeasure = s.measure;
        document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
        updateTransportInfo(currentMeasure);

        // If playing, restart from this measure
        if (playback.playing) {
          playback.stop();
          setPlayingUI(true);
          playback.play(scoreData, currentMeasure).then(() => {
            const checkStop = setInterval(() => {
              if (!playback.playing) { setPlayingUI(false); clearInterval(checkStop); }
            }, 200);
          });
        }
        return;
      }
    }
  }

  seekOverlay.addEventListener('mousedown', (e) => {
    seekToX(e.clientX);
    const onMove = (ev) => seekToX(ev.clientX);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  seekOverlay.addEventListener('touchstart', (e) => {
    if (e.touches[0]) seekToX(e.touches[0].clientX);
  }, { passive: true });

  seekOverlay.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches[0]) seekToX(e.touches[0].clientX);
  }, { passive: false });

  // Show seek overlay when playing
  const origSetPlayingUI = setPlayingUI;

  // Bind UI
  bindTransport();
  bindScoreClicks();
  bindKeyboard();
  bindHistory();
  startPolling();
  updateLastLocation();

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
// Update transport bar info for a given measure
// ---------------------------------------------------------------------------
function updateTransportInfo(measure) {
  if (!scoreData) return;
  const eSig = getEffectiveSignature(measure, scoreData);
  const keyEl = document.getElementById('transport-key');
  const timeEl = document.getElementById('transport-time');
  const tempoEl = document.getElementById('transport-tempo');
  if (keyEl) keyEl.textContent = formatKey(eSig.key);
  if (timeEl) timeEl.textContent = eSig.time;
  if (tempoEl) tempoEl.innerHTML = `&#9833; = ${eSig.tempo}`;
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
      document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
      updateTransportInfo(currentMeasure);
    }
  });

  nextBtn.addEventListener('click', () => {
    if (scoreData && currentMeasure < scoreData.score.total_measures) {
      currentMeasure++;
      document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
      updateTransportInfo(currentMeasure);
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
  const overlay = document.querySelector('.seek-overlay');
  if (overlay) overlay.style.display = playing ? 'block' : 'none';
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
          document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
          updateTransportInfo(currentMeasure);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (editor && editor.isOpen) {
          editor.nextMeasure();
        } else if (scoreData && currentMeasure < scoreData.score.total_measures) {
          currentMeasure++;
          document.getElementById('measure-indicator').textContent = `Bar ${currentMeasure}`;
          updateTransportInfo(currentMeasure);
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
// Geolocation
// ---------------------------------------------------------------------------
async function initGeolocation() {
  // Apply cached location to editor right away
  if (editor && (userLocation.city || userLocation.country)) {
    editor.location = userLocation;
  }
  // Use IP-based geolocation — no permission needed, works on all devices
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (!res.ok) return;
    const data = await res.json();
    const parts = [data.city, data.region, data.country_name].filter(Boolean);
    userLocation.city = parts.slice(0, -1).join(', ') || null;
    userLocation.country = data.country_name || null;
    localStorage.setItem('ensemble_location', JSON.stringify(userLocation));
    if (editor) editor.location = userLocation;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Last location display
// ---------------------------------------------------------------------------
async function updateLastLocation() {
  try {
    const { latest } = await API.fetchContributions();
    const el = document.getElementById('last-location');
    if (el && latest && latest.city && latest.country) {
      el.textContent = `last updated from ${latest.city}, ${latest.country}`;
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// History popup
// ---------------------------------------------------------------------------
function bindHistory() {
  const historyBtn = document.getElementById('history-btn');
  const overlay = document.getElementById('history-overlay');
  const closeBtn = document.getElementById('history-close');

  historyBtn.addEventListener('click', async () => {
    overlay.classList.remove('hidden');
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = '<p class="history-empty">Loading...</p>';

    try {
      const { contributions } = await API.fetchContributions();
      if (contributions.length === 0) {
        listEl.innerHTML = '<p class="history-empty">No contributions with location yet.</p>';
        return;
      }
      listEl.innerHTML = '';
      for (const c of contributions) {
        const entry = document.createElement('div');
        entry.className = 'history-entry';
        const timeAgo = formatTimeAgo(c.created_at);
        entry.innerHTML = `
          <span class="history-location">${escapeHtml(c.city)}, ${escapeHtml(c.country)}</span>
          <span class="history-time">${timeAgo}</span>
        `;
        listEl.appendChild(entry);
      }
    } catch (_) {
      listEl.innerHTML = '<p class="history-empty">Failed to load history.</p>';
    }
  });

  closeBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
}

function formatTimeAgo(isoString) {
  const date = new Date(isoString + 'Z');
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
