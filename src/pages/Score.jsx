import { useEffect, useRef, useState, useCallback } from 'react';
import useScore from '../hooks/useScore.js';
import useSession from '../hooks/useSession.js';
import useGeolocation from '../hooks/useGeolocation.js';
import { ScoreRenderer, getEffectiveSignature } from '../lib/vexflow-helpers.js';
import { PlaybackEngine } from '../lib/playback.js';
import { API } from '../api.js';
import Editor from '../components/Editor.jsx';
import HistoryPopup from '../components/HistoryPopup.jsx';

const KEY_NAMES = {
  C: 'C Major', G: 'G Major', D: 'D Major', A: 'A Major',
  E: 'E Major', B: 'B Major', 'F#': 'F♯ Major', 'C#': 'C♯ Major',
  F: 'F Major', Bb: 'B♭ Major', Eb: 'E♭ Major', Ab: 'A♭ Major',
  Db: 'D♭ Major', Gb: 'G♭ Major', Cb: 'C♭ Major',
};
const formatKey = (k) => KEY_NAMES[k] || k + ' Major';

export default function Score() {
  const sessionId = useSession();
  const location = useGeolocation();
  const { scoreData, setScoreData, error, noteCount, refreshCount } = useScore();

  const [currentMeasure, setCurrentMeasure] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [editorTarget, setEditorTarget] = useState(null); // { instrumentId, instrumentName, clef, measure }
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lastLocation, setLastLocation] = useState(null);

  const scoreContainerRef = useRef(null);
  const labelsContainerRef = useRef(null);
  const scoreWrapperRef = useRef(null);
  const playheadRef = useRef(null);
  const seekOverlayRef = useRef(null);
  const rendererRef = useRef(null);
  const playbackRef = useRef(null);
  const scoreDataRef = useRef(scoreData);
  const currentMeasureRef = useRef(currentMeasure);
  scoreDataRef.current = scoreData;
  currentMeasureRef.current = currentMeasure;

  // ---- Instantiate ScoreRenderer + PlaybackEngine once scoreData (and the
  // associated DOM nodes) are available, then re-render on scoreData changes. ----
  useEffect(() => {
    if (!scoreData || !scoreContainerRef.current) return;

    if (!rendererRef.current) {
      rendererRef.current = new ScoreRenderer(scoreContainerRef.current, labelsContainerRef.current);
    }
    if (!playbackRef.current) {
      playbackRef.current = new PlaybackEngine();
      playbackRef.current.onMeasureChange = (m) => setCurrentMeasure(m);
      playbackRef.current.onPlaybackTick = (data) => {
        const el = playheadRef.current;
        if (!el) return;
        if (data.stopped) { el.style.display = 'none'; setPlaying(false); return; }
        const bounds = rendererRef.current.getSystemBoundsForMeasure(data.measure);
        if (!bounds) { el.style.display = 'none'; return; }
        const xPos = bounds.noteStartX + data.beatFraction * (bounds.noteEndX - bounds.noteStartX);
        el.style.display = 'block';
        el.style.left = `${xPos}px`;
        el.style.top = `${bounds.topY}px`;
        el.style.height = `${bounds.bottomY - bounds.topY}px`;
      };
    }

    rendererRef.current.render(scoreData);
  }, [scoreData]);

  // ---- Re-render on resize, debounced ----
  useEffect(() => {
    if (!scoreData) return;
    let t;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => rendererRef.current?.render(scoreData), 250);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, [scoreData]);

  // ---- Fetch latest contribution for the header text ----
  const refreshLastLocation = useCallback(async () => {
    try {
      const { latest } = await API.fetchContributions();
      if (latest && latest.city && latest.country) {
        setLastLocation(`last updated from ${latest.city}, ${latest.country}`);
      }
    } catch (_) {}
  }, []);
  useEffect(() => { refreshLastLocation(); }, [refreshLastLocation]);

  // ---- Transport ----
  const togglePlayback = useCallback(async () => {
    if (!scoreDataRef.current) return;
    const p = playbackRef.current;
    if (p.playing) {
      p.stop();
      setPlaying(false);
    } else {
      setPlaying(true);
      await p.play(scoreDataRef.current, currentMeasureRef.current);
    }
  }, []);

  const stepMeasure = useCallback((delta) => {
    setCurrentMeasure(prev => {
      const next = prev + delta;
      const max = scoreDataRef.current?.score.total_measures || prev;
      return Math.min(Math.max(1, next), max);
    });
  }, []);

  // ---- Global keyboard shortcuts (only when editor is closed) ----
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (editorTarget) return; // Editor handles its own shortcuts
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlayback(); break;
        case 'ArrowLeft':  e.preventDefault(); stepMeasure(-1); break;
        case 'ArrowRight': e.preventDefault(); stepMeasure(+1); break;
        case 'e': case 'E':
          if (scoreDataRef.current) {
            // Editor defaults to the first instrument — users can switch from within the editor.
            const inst = scoreDataRef.current.instruments[0];
            setEditorTarget({
              instrumentId: inst.id, instrumentName: inst.name, clef: inst.clef,
              measure: currentMeasureRef.current,
            });
          }
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editorTarget, togglePlayback, stepMeasure]);

  // ---- Score click → open editor ----
  const onScoreClick = (e) => {
    if (editorTarget) return;
    const hit = rendererRef.current?.hitTest(e.clientX, e.clientY);
    if (hit) {
      setEditorTarget({
        instrumentId: hit.instrumentId, instrumentName: hit.instrumentName,
        clef: hit.clef, measure: hit.measure,
      });
    }
  };

  // ---- Seek overlay drag-to-jump (waits for scoreData so the DOM exists) ----
  useEffect(() => {
    if (!scoreData) return;
    const overlay = seekOverlayRef.current;
    const wrapper = scoreWrapperRef.current;
    if (!overlay || !wrapper) return;

    const seekToX = (clientX) => {
      const renderer = rendererRef.current;
      const score = scoreDataRef.current;
      if (!renderer || !score) return;
      const rect = wrapper.getBoundingClientRect();
      const x = clientX - rect.left + wrapper.scrollLeft;
      // Only match staves on the first instrument so we get one measure per X.
      for (const s of renderer.staveMap) {
        if (x >= s.x && x <= s.x + s.width && s.instrumentId === score.instruments[0].id) {
          setCurrentMeasure(s.measure);
          if (playbackRef.current.playing) {
            playbackRef.current.stop();
            setPlaying(true);
            playbackRef.current.play(score, s.measure);
          }
          return;
        }
      }
    };

    const onMouseDown = (e) => {
      seekToX(e.clientX);
      const onMove = (ev) => seekToX(ev.clientX);
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const onTouchStart = (e) => { if (e.touches[0]) seekToX(e.touches[0].clientX); };
    const onTouchMove = (e) => { e.preventDefault(); if (e.touches[0]) seekToX(e.touches[0].clientX); };

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('touchstart', onTouchStart, { passive: true });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      overlay.removeEventListener('mousedown', onMouseDown);
      overlay.removeEventListener('touchstart', onTouchStart);
      overlay.removeEventListener('touchmove', onTouchMove);
    };
  }, [scoreData]);

  if (error) {
    return (
      <p style={{ padding: '2rem', color: '#9A9590' }}>
        Could not load score. Is the server running?
      </p>
    );
  }
  if (!scoreData) return null;

  const eSig = getEffectiveSignature(currentMeasure, scoreData);

  return (
    <>
      <header className="site-header">
        <h1 className="logo">Ensemble</h1>
        <p className="tagline">A shared score for the world</p>
      </header>

      <div className="score-meta">
        <h2 className="piece-title">{scoreData.score.title}</h2>
        <div className="note-count">
          <span id="note-count-num">{noteCount}</span> notes shared across the world
        </div>
        <div className="location-info">
          <span id="last-location">{lastLocation}</span>
          <button id="history-btn" className="history-btn" onClick={() => setHistoryOpen(true)}>History</button>
        </div>
      </div>

      <div className="transport">
        <div className="transport-left">
          <button className="transport-btn" onClick={togglePlayback} title="Play / Pause (Space)">
            {playing
              ? <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                  <rect x="2" y="1" width="5" height="16"/>
                  <rect x="11" y="1" width="5" height="16"/>
                </svg>
              : <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                  <polygon points="3,1 15,9 3,17"/>
                </svg>
            }
          </button>
          <button className="transport-btn" onClick={() => { playbackRef.current?.stop(); setPlaying(false); }} title="Stop">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <rect x="3" y="3" width="12" height="12"/>
            </svg>
          </button>
        </div>
        <div className="transport-center">
          <button className="transport-btn-sm" onClick={() => stepMeasure(-1)}>&larr;</button>
          <span id="measure-indicator">Bar {currentMeasure}</span>
          <button className="transport-btn-sm" onClick={() => stepMeasure(+1)}>&rarr;</button>
        </div>
        <div className="transport-right">
          <span className="transport-info">
            <span className="transport-tag">{formatKey(eSig.key)}</span>
            <span className="transport-tag">{eSig.time}</span>
            <span className="transport-tag">♩ = {eSig.tempo}</span>
          </span>
        </div>
      </div>

      <div className="shortcut-hint">
        <span>Space</span> Play &nbsp;
        <span>E</span> Edit &nbsp;
        <span>Esc</span> Close &nbsp;
        <span>1-5</span> Duration &nbsp;
        <span>R</span> Rest &nbsp;
        <span>V</span> Vibrato
      </div>

      <div id="score-wrapper" ref={scoreWrapperRef}>
        <div id="instrument-labels" ref={labelsContainerRef}></div>
        <div id="score" ref={scoreContainerRef} onClick={onScoreClick}></div>
        <div className="playhead-line" ref={playheadRef} style={{ display: 'none' }}></div>
        <div className="seek-overlay" ref={seekOverlayRef} style={{ display: playing ? 'block' : 'none' }}></div>
      </div>

      <div className="add-instrument-area">
        <button className="add-instrument-btn" disabled title="Coming soon">
          + Add Instrument <span className="coming-soon">Coming soon</span>
        </button>
      </div>

      {editorTarget && (
        <Editor
          scoreData={scoreData}
          setScoreData={setScoreData}
          sessionId={sessionId}
          location={location}
          {...editorTarget}
          onClose={() => setEditorTarget(null)}
          onMeasureChange={(m) => setEditorTarget(t => ({ ...t, measure: m }))}
          onNoteAdded={(note) => {
            refreshCount();
            refreshLastLocation();
            setCurrentMeasure(note.measure || currentMeasureRef.current);
          }}
          onNoteDeleted={() => refreshCount()}
        />
      )}

      <HistoryPopup open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}
