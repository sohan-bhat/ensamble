import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Renderer, Stave, Voice, Formatter, Beam,
} from 'vexflow';
import {
  DUR_TO_BEATS, getKeyAccidentals, buildMeasureNotes, getEffectiveSignature,
} from '../lib/vexflow-helpers.js';
import { API } from '../api.js';

const DIATONIC = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const CLEF_BASE = {
  treble: { noteIdx: 3, octave: 5 }, // F5
  alto:   { noteIdx: 4, octave: 4 }, // G4
  bass:   { noteIdx: 5, octave: 3 }, // A3
};

function linePosToPitch(linePos, clef, keyAccidentals) {
  const base = CLEF_BASE[clef] || CLEF_BASE.treble;
  const steps = Math.round(linePos * 2); // each 0.5 line = 1 diatonic step down
  const absPos = base.noteIdx + base.octave * 7 - steps;
  let octave = Math.floor(absPos / 7);
  let noteIdx = absPos % 7;
  if (noteIdx < 0) { noteIdx += 7; octave--; }
  const letter = DIATONIC[noteIdx];
  return letter + (keyAccidentals[letter] || '') + octave;
}

function pitchToLinePos(pitch, clef) {
  const m = pitch.match(/^([A-G])/);
  if (!m) return 2;
  const letter = m[1];
  const octave = parseInt(pitch[pitch.length - 1]);
  const noteIdx = DIATONIC.indexOf(letter);
  const base = CLEF_BASE[clef] || CLEF_BASE.treble;
  return ((base.noteIdx + base.octave * 7) - (noteIdx + octave * 7)) / 2;
}

const DURATIONS = ['whole', 'half', 'quarter', 'eighth', 'sixteenth'];
const REST_SYMBOLS = { whole: '𝄻', half: '𝄼', quarter: '𝄽', eighth: '𝄾', sixteenth: '𝄿' };
const ACC_SYMBOLS = { sharp: '♯', flat: '♭', natural: '♮' };

export default function Editor({
  scoreData, setScoreData, sessionId, location,
  instrumentId, instrumentName, clef, measure,
  onClose, onMeasureChange, onNoteAdded, onNoteDeleted,
}) {
  const [selectedDuration, setSelectedDuration] = useState('quarter');
  const [selectedAccidental, setSelectedAccidental] = useState(null);
  const [restMode, setRestMode] = useState(false);
  const [vibrato, setVibrato] = useState(false);
  const [dynamic, setDynamic] = useState('mf');
  const [placedNotes, setPlacedNotes] = useState([]);
  const [borderColor, setBorderColor] = useState('');

  const overlayRef = useRef(null);
  const editorScoreRef = useRef(null);
  const ghostCanvasRef = useRef(null);
  const editorStaveRef = useRef(null);
  const currentGhostRef = useRef(null);
  const placingRef = useRef(false);
  // The latest scoreData inside imperative handlers — avoids stale closures.
  const scoreDataRef = useRef(scoreData);
  scoreDataRef.current = scoreData;

  const eSig = getEffectiveSignature(measure, scoreData);
  const [beatsNum] = eSig.time.split('/').map(Number);
  const keyAccidentals = getKeyAccidentals(eSig.key);

  // Reset placed-notes tracking when the user navigates to a different measure.
  useEffect(() => { setPlacedNotes([]); }, [measure, instrumentId]);

  const flashError = useCallback(() => {
    setBorderColor('#c44');
    setTimeout(() => setBorderColor(''), 400);
  }, []);

  // ---- Render the editor stave + beat grid whenever the measure or notes change ----
  useEffect(() => {
    const container = editorScoreRef.current;
    const canvas = ghostCanvasRef.current;
    if (!container || !canvas) return;

    container.innerHTML = '';
    const width = container.clientWidth || 700;
    const height = 160;

    const renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const ctx = renderer.getContext();

    const pad = width < 400 ? 10 : 20;
    const staveW = width - pad * 2;
    const stave = new Stave(pad, 20, staveW);
    stave.addClef(clef);
    stave.addKeySignature(eSig.key);
    stave.addTimeSignature(eSig.time);
    stave.setContext(ctx).draw();
    editorStaveRef.current = stave;

    const mNotes = scoreData.notes.filter(
      n => n.instrument_id === instrumentId && n.measure === measure
    );
    const vexNotes = buildMeasureNotes(mNotes, clef, keyAccidentals, beatsNum);

    if (vexNotes.length > 0) {
      const voice = new Voice({
        num_beats: beatsNum,
        beat_value: parseInt(eSig.time.split('/')[1]),
      });
      voice.setMode(Voice.Mode.SOFT);
      voice.addTickables(vexNotes);
      const noteAreaWidth = stave.getNoteEndX() - stave.getNoteStartX();
      new Formatter().joinVoices([voice]).format([voice], noteAreaWidth - 20);
      voice.draw(ctx, stave);

      try {
        const beamable = vexNotes.filter(
          n => !n.isRest() && (n.getDuration() === '8' || n.getDuration() === '16')
        );
        if (beamable.length >= 2) {
          Beam.generateBeams(beamable).forEach(b => b.setContext(ctx).draw());
        }
      } catch (_) {}
    }

    // ---- Beat grid (labels + dashed gridlines) ----
    const svgEl = container.querySelector('svg');
    if (svgEl) {
      const noteStartX = stave.getNoteStartX();
      const noteEndX = stave.getNoteEndX();
      const musicWidth = noteEndX - noteStartX;
      const topY = stave.getYForLine(0);
      const botY = stave.getYForLine(4);

      for (let b = 0; b <= beatsNum; b++) {
        const x = noteStartX + (b / beatsNum) * musicWidth;
        // Don't label the right barline — that's not a beat, it's the measure end.
        if (b < beatsNum) {
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', x);
          text.setAttribute('y', botY + 16);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('fill', '#9A9590');
          text.setAttribute('font-size', '9');
          text.setAttribute('font-family', 'DM Sans, sans-serif');
          text.setAttribute('pointer-events', 'none');
          text.textContent = b + 1;
          svgEl.appendChild(text);
        }
        // Skip first and last gridlines — they would overdraw the barlines.
        if (b > 0 && b < beatsNum) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', x); line.setAttribute('y1', topY);
          line.setAttribute('x2', x); line.setAttribute('y2', botY);
          line.setAttribute('stroke', '#DDD5CC');
          line.setAttribute('stroke-width', '0.5');
          line.setAttribute('stroke-dasharray', '2,3');
          line.setAttribute('pointer-events', 'none');
          svgEl.appendChild(line);
        }
      }
    }

    // Scale the ghost canvas for the device pixel ratio so notes stay crisp on retina.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [scoreData, instrumentId, clef, measure, beatsNum, eSig.key, eSig.time, keyAccidentals]);

  // ---- Snapping + ghost drawing helpers (use refs to read latest values without re-binding) ----

  const snapY = (linePos) => {
    const stave = editorStaveRef.current;
    if (!stave) return 0;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);
    const halfSpacing = (botY - topY) / 8;
    return topY + linePos * halfSpacing * 2;
  };
  const snapX = (beat) => {
    const stave = editorStaveRef.current;
    if (!stave) return 0;
    const musicWidth = stave.getNoteEndX() - stave.getNoteStartX();
    return stave.getNoteStartX() + ((beat - 1) / beatsNum) * musicWidth;
  };
  const yToLinePos = (y) => {
    const stave = editorStaveRef.current;
    if (!stave) return 2;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);
    const halfSpacing = (botY - topY) / 8;
    return Math.round(((y - topY) / halfSpacing)) / 2;
  };
  const xToBeat = (x) => {
    const stave = editorStaveRef.current;
    if (!stave) return 1;
    const musicWidth = stave.getNoteEndX() - stave.getNoteStartX();
    const durBeats = DUR_TO_BEATS[selectedDuration] || 1;
    const subdivisions = beatsNum / durBeats;
    const relX = x - stave.getNoteStartX();
    const gridPos = Math.round((relX / musicWidth) * subdivisions);
    const clamped = Math.max(0, Math.min(gridPos, subdivisions - 1));
    return 1 + clamped * durBeats;
  };

  const clearGhost = () => {
    const c = ghostCanvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.getContext('2d').clearRect(0, 0, c.width / dpr, c.height / dpr);
  };

  const drawGhost = (x, y, pitch, color) => {
    clearGhost();
    const stave = editorStaveRef.current;
    const c = ghostCanvasRef.current;
    if (!stave || !c) return;
    const ctx = c.getContext('2d');
    ctx.save();

    if (!restMode) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(stave.getNoteStartX(), y - 4, stave.getNoteEndX() - stave.getNoteStartX(), 8);
    }
    ctx.globalAlpha = 0.5;

    if (restMode) {
      ctx.fillStyle = color;
      ctx.font = '24px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(REST_SYMBOLS[selectedDuration] || '𝄽', x, y);
    } else {
      const filled = ['quarter', 'eighth', 'sixteenth'].includes(selectedDuration);
      ctx.beginPath();
      ctx.ellipse(x, y, 7, 5, -0.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      if (filled) ctx.fill();
      else { ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke(); }

      if (selectedDuration !== 'whole') {
        const linePos = yToLinePos(y);
        const stemUp = linePos > 2;
        ctx.beginPath();
        if (stemUp) { ctx.moveTo(x + 6, y); ctx.lineTo(x + 6, y - 35); }
        else        { ctx.moveTo(x - 6, y); ctx.lineTo(x - 6, y + 35); }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Ledger lines
      const topY = stave.getYForLine(0);
      const botY = stave.getYForLine(4);
      const spacing = (botY - topY) / 4;
      ctx.strokeStyle = '#6B8CA6';
      ctx.lineWidth = 1;
      for (let ly = topY - spacing; ly >= y - 2; ly -= spacing) {
        ctx.beginPath(); ctx.moveTo(x - 12, ly); ctx.lineTo(x + 12, ly); ctx.stroke();
      }
      for (let ly = botY + spacing; ly <= y + 2; ly += spacing) {
        ctx.beginPath(); ctx.moveTo(x - 12, ly); ctx.lineTo(x + 12, ly); ctx.stroke();
      }

      if (selectedAccidental) {
        ctx.fillStyle = color;
        ctx.font = '16px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ACC_SYMBOLS[selectedAccidental] || '', x - 16, y);
      }

      ctx.fillStyle = color;
      ctx.font = '11px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(pitch, x, y + (selectedDuration === 'whole' ? 12 : 8));
    }
    ctx.restore();
  };

  const highlightExistingNote = (beat) => {
    const stave = editorStaveRef.current;
    const c = ghostCanvasRef.current;
    if (!stave || !c) return;
    const note = scoreDataRef.current.notes.find(
      n => n.instrument_id === instrumentId && n.measure === measure && Math.abs(n.beat - beat) < 0.01
    );
    if (!note) return;
    const noteX = snapX(note.beat);
    const noteY = snapY(pitchToLinePos(note.pitch, clef));
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(noteX, noteY, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#E53935';
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', noteX, noteY);
    ctx.restore();
  };

  // ---- Placement / deletion / undo ----

  const placeNote = async (pitch, beat) => {
    // Drop overlapping clicks — the server check is authoritative, but the
    // local check reads pre-await state and two rapid taps would both pass.
    if (placingRef.current) return;
    placingRef.current = true;
    try {
      const score = scoreDataRef.current;
      const existing = score.notes.filter(n => n.instrument_id === instrumentId && n.measure === measure);
      const usedBeats = existing.reduce((sum, n) => sum + (DUR_TO_BEATS[n.duration] || 0), 0);
      const newNoteBeats = DUR_TO_BEATS[selectedDuration] || 1;
      // Reject if the measure is full, or the note's tail would extend past the final beat.
      if (usedBeats + newNoteBeats > beatsNum || beat + newNoteBeats - 1 > beatsNum) {
        flashError();
        return;
      }

      // Toolbar accidental overrides whatever the key signature would imply.
      let finalPitch = pitch;
      if (selectedAccidental && !restMode) {
        const letter = pitch[0];
        const octave = pitch[pitch.length - 1];
        if (selectedAccidental === 'sharp')   finalPitch = letter + '#' + octave;
        if (selectedAccidental === 'flat')    finalPitch = letter + 'b' + octave;
        if (selectedAccidental === 'natural') finalPitch = letter + octave;
      }

      try {
        const saved = await API.addNote({
          instrument_id: instrumentId, pitch: finalPitch, measure, beat,
          duration: selectedDuration, is_rest: restMode,
          accidental: selectedAccidental || null, dynamic, vibrato,
          session_id: sessionId,
          city: location.city || null, country: location.country || null,
        });
        setPlacedNotes(prev => [...prev, saved]);
        // SSE may have already pushed this note — dedupe by id.
        setScoreData(prev => {
          if (!prev || prev.notes.some(n => n.id === saved.id)) return prev;
          return { ...prev, notes: [...prev.notes, saved] };
        });
        if (onNoteAdded) onNoteAdded(saved);
      } catch (err) {
        console.error('Failed to place note:', err);
        flashError();
      }
    } finally {
      placingRef.current = false;
    }
  };

  const deleteExistingNote = async (note) => {
    try { await API.deleteNote(note.id, sessionId); }
    catch (_) {
      // Server may reject (different session owns the note); strip locally
      // anyway so the UI doesn't lie about the click.
    }
    setScoreData(prev => {
      if (!prev) return prev;
      const notes = prev.notes.filter(n => n.id !== note.id);
      return notes.length === prev.notes.length ? prev : { ...prev, notes };
    });
    if (onNoteDeleted) onNoteDeleted(note);
  };

  const undo = async () => {
    const last = placedNotes[placedNotes.length - 1];
    if (!last) return;
    try {
      await API.deleteNote(last.id, sessionId);
      setPlacedNotes(prev => prev.slice(0, -1));
      setScoreData(prev => {
        if (!prev) return prev;
        return { ...prev, notes: prev.notes.filter(n => n.id !== last.id) };
      });
      if (onNoteDeleted) onNoteDeleted(last);
    } catch (err) {
      console.error('Failed to undo note:', err);
    }
  };

  const changeMeasureSignature = async (patch) => {
    const newKey   = patch.key_signature  || eSig.key;
    const newTime  = patch.time_signature || eSig.time;
    const newTempo = patch.tempo          || eSig.tempo;
    try {
      const saved = await API.setMeasureSignature(measure, {
        key_signature: newKey, time_signature: newTime, tempo: newTempo,
      });
      setScoreData(prev => {
        if (!prev) return prev;
        const sigs = prev.measureSignatures || [];
        const idx = sigs.findIndex(s => s.measure === measure);
        const next = idx === -1
          ? [...sigs, saved].sort((a, b) => a.measure - b.measure)
          : sigs.map((s, i) => i === idx ? saved : s);
        return { ...prev, measureSignatures: next };
      });
    } catch (err) {
      console.error('Failed to change measure signature:', err);
    }
  };

  // ---- Pointer handlers (mouse + touch share the same conversion logic) ----
  useEffect(() => {
    const wrapper = document.getElementById('editor-score-wrapper');
    if (!wrapper) return;

    const onMove = (clientX, clientY) => {
      const stave = editorStaveRef.current;
      const canvas = ghostCanvasRef.current;
      if (!stave || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const clampedX = Math.max(stave.getNoteStartX(), Math.min(mx, stave.getNoteEndX()));
      const linePos = yToLinePos(my);
      const beat = xToBeat(clampedX);
      const snappedY = snapY(linePos);
      const snappedX = snapX(beat);
      const pitch = linePosToPitch(linePos, clef, keyAccidentals);
      currentGhostRef.current = { pitch, beat, x: snappedX, y: snappedY };

      const score = scoreDataRef.current;
      const existing = score.notes.find(
        n => n.instrument_id === instrumentId && n.measure === measure
             && !n.is_rest && Math.abs(n.beat - beat) < 0.01
      );
      drawGhost(snappedX, snappedY, pitch, existing ? '#4CAF50' : '#6B8CA6');
      if (existing) highlightExistingNote(existing.beat);
    };

    const onPlace = () => {
      const g = currentGhostRef.current;
      if (!g) return;
      const score = scoreDataRef.current;
      const existing = score.notes.find(
        n => n.instrument_id === instrumentId && n.measure === measure
             && Math.abs(n.beat - g.beat) < 0.01
      );
      if (existing) deleteExistingNote(existing);
      else placeNote(g.pitch, g.beat);
    };

    const mm = (e) => onMove(e.clientX, e.clientY);
    const ml = () => { clearGhost(); currentGhostRef.current = null; };
    const cl = (e) => { e.stopPropagation(); onPlace(); };

    const tm = (e) => { e.preventDefault(); const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY); };
    const ts = (e) => { const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY); };
    const te = (e) => {
      e.preventDefault();
      onPlace();
      // Keep the ghost visible briefly after a tap so users get a confirmation flash.
      setTimeout(() => { clearGhost(); currentGhostRef.current = null; }, 200);
    };

    wrapper.addEventListener('mousemove', mm);
    wrapper.addEventListener('mouseleave', ml);
    wrapper.addEventListener('click', cl);
    wrapper.addEventListener('touchmove', tm, { passive: false });
    wrapper.addEventListener('touchstart', ts, { passive: true });
    wrapper.addEventListener('touchend', te);

    return () => {
      wrapper.removeEventListener('mousemove', mm);
      wrapper.removeEventListener('mouseleave', ml);
      wrapper.removeEventListener('click', cl);
      wrapper.removeEventListener('touchmove', tm);
      wrapper.removeEventListener('touchstart', ts);
      wrapper.removeEventListener('touchend', te);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentId, measure, clef, selectedDuration, selectedAccidental, restMode, vibrato, dynamic, keyAccidentals, beatsNum]);

  // ---- Keyboard shortcuts inside the editor ----
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (measure > 1) onMeasureChange(measure - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (scoreData && measure < scoreData.score.total_measures) onMeasureChange(measure + 1);
          break;
        case 'Escape': onClose(); break;
        case '1': case '2': case '3': case '4': case '5':
          setSelectedDuration(DURATIONS[parseInt(e.key) - 1]);
          break;
        case 'r': case 'R': setRestMode(v => !v); break;
        case 'v': case 'V': setVibrato(v => !v); break;
        case 'z':
          if (e.metaKey || e.ctrlKey) { e.preventDefault(); undo(); }
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, scoreData, placedNotes]);

  const onAccBtn = (acc) => setSelectedAccidental(prev => prev === acc ? null : acc);

  return (
    <div id="editor-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div id="editor" style={{ borderColor }}>
        <div className="editor-header">
          <span id="editor-instrument-name">{instrumentName}</span>
          <button className="transport-btn-sm" onClick={() => measure > 1 && onMeasureChange(measure - 1)}>&larr;</button>
          <span id="editor-measure-label">Bar {measure}</span>
          <button className="transport-btn-sm" onClick={() => scoreData && measure < scoreData.score.total_measures && onMeasureChange(measure + 1)}>&rarr;</button>
          <button id="editor-close" onClick={onClose}>&times;</button>
        </div>
        <div className="editor-toolbar">
          <div className="toolbar-group">
            <span className="toolbar-label">Duration</span>
            {DURATIONS.map(d => (
              <button key={d}
                className={`dur-btn${selectedDuration === d ? ' active' : ''}`}
                onClick={() => setSelectedDuration(d)}>
                {durIcon(d)}
              </button>
            ))}
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Mode</span>
            <button id="rest-toggle" className={`tool-btn${restMode ? ' active' : ''}`} onClick={() => setRestMode(v => !v)}>Rest</button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Expr.</span>
            <button id="vibrato-toggle" className={`tool-btn${vibrato ? ' active' : ''}`} onClick={() => setVibrato(v => !v)}>Vibrato</button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Accidental</span>
            <button className={`acc-btn${selectedAccidental === 'sharp' ? ' active' : ''}`} onClick={() => onAccBtn('sharp')}>&#9839;</button>
            <button className={`acc-btn${selectedAccidental === 'flat' ? ' active' : ''}`} onClick={() => onAccBtn('flat')}>&#9837;</button>
            <button className={`acc-btn${selectedAccidental === 'natural' ? ' active' : ''}`} onClick={() => onAccBtn('natural')}>&#9838;</button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Dynamic</span>
            <select id="dynamic-select" value={dynamic} onChange={(e) => setDynamic(e.target.value)}>
              {['pp','p','mp','mf','f','ff'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Key</span>
            <select id="key-sig-select" value={eSig.key} onChange={(e) => changeMeasureSignature({ key_signature: e.target.value })}>
              {['C','G','D','A','E','B','F#','F','Bb','Eb','Ab','Db','Gb'].map(k => <option key={k} value={k}>{k.replace('#','♯').replace('b','♭')}</option>)}
            </select>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Time</span>
            <select id="time-sig-select" value={eSig.time} onChange={(e) => changeMeasureSignature({ time_signature: e.target.value })}>
              {['2/4','3/4','4/4','5/4','6/4','6/8','3/8'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">BPM</span>
            <input id="tempo-input" type="number" min="20" max="300" defaultValue={eSig.tempo}
              key={`tempo-${measure}-${eSig.tempo}`}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (v >= 20 && v <= 300) changeMeasureSignature({ tempo: v });
                else e.target.value = eSig.tempo;
              }} />
          </div>
          <div className="toolbar-group">
            <button id="undo-btn" className="tool-btn" onClick={undo}>Undo</button>
          </div>
        </div>
        <div id="editor-score-wrapper">
          <div id="editor-score" ref={editorScoreRef}></div>
          <canvas id="ghost-canvas" ref={ghostCanvasRef}></canvas>
        </div>
        <div className="editor-hint">Hover to preview note position. Click to place. Keys: 1-5 duration, R rest, V vibrato, Ctrl+Z undo.</div>
      </div>
    </div>
  );
}

// Tiny inline SVG glyphs for the duration buttons — matches the original markup.
function durIcon(d) {
  switch (d) {
    case 'whole':
      return <svg width="20" height="20" viewBox="0 0 20 20">
        <ellipse cx="10" cy="10" rx="7" ry="4.5" fill="none" stroke="currentColor" strokeWidth="2"/>
      </svg>;
    case 'half':
      return <svg width="20" height="24" viewBox="0 0 20 24">
        <ellipse cx="8" cy="16" rx="6" ry="4" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(-20 8 16)"/>
        <line x1="13.5" y1="14" x2="13.5" y2="2" stroke="currentColor" strokeWidth="2"/>
      </svg>;
    case 'quarter':
      return <svg width="20" height="24" viewBox="0 0 20 24">
        <ellipse cx="8" cy="16" rx="6" ry="4" fill="currentColor" transform="rotate(-20 8 16)"/>
        <line x1="13.5" y1="14" x2="13.5" y2="2" stroke="currentColor" strokeWidth="2"/>
      </svg>;
    case 'eighth':
      return <svg width="20" height="24" viewBox="0 0 20 24">
        <ellipse cx="8" cy="16" rx="6" ry="4" fill="currentColor" transform="rotate(-20 8 16)"/>
        <line x1="13.5" y1="14" x2="13.5" y2="2" stroke="currentColor" strokeWidth="2"/>
        <path d="M13.5 2 C16 3.5 18 6 16 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </svg>;
    case 'sixteenth':
      return <svg width="20" height="24" viewBox="0 0 20 24">
        <ellipse cx="8" cy="16" rx="6" ry="4" fill="currentColor" transform="rotate(-20 8 16)"/>
        <line x1="13.5" y1="14" x2="13.5" y2="2" stroke="currentColor" strokeWidth="2"/>
        <path d="M13.5 2 C16 3.5 18 6 16 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        <path d="M13.5 6 C16 7.5 18 10 16 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </svg>;
  }
}
