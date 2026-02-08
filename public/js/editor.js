// =========================================================================
// Ensemble — Floating Note Editor
// =========================================================================

import {
  DUR_TO_VEX, DUR_TO_BEATS,
  getKeyAccidentals, pitchToVexKey, displayAccidental, restPosition,
  buildMeasureNotes, getEffectiveSignature,
} from './renderer.js';
import { API } from './api.js';

const VF = Vex.Flow;

// Diatonic note names in order (C=0 … B=6)
const DIATONIC = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

// Map clef → base note at VexFlow line position 0 (top line)
const CLEF_BASE = {
  treble: { noteIdx: 3, octave: 5 }, // F5
  alto:   { noteIdx: 4, octave: 4 }, // G4
  bass:   { noteIdx: 5, octave: 3 }, // A3
};

// ---------------------------------------------------------------------------
// Pitch ↔ staff position helpers
// ---------------------------------------------------------------------------
/**
 * Convert a VexFlow line position to a pitch string.
 * linePos 0 = top line, 4 = bottom line, supports above/below staff.
 */
function linePosToPitch(linePos, clef, keyAccidentals) {
  const base = CLEF_BASE[clef] || CLEF_BASE.treble;
  const steps = Math.round(linePos * 2); // each 0.5 line = 1 diatonic step down
  const absPos = base.noteIdx + base.octave * 7 - steps;
  let octave = Math.floor(absPos / 7);
  let noteIdx = absPos % 7;
  if (noteIdx < 0) { noteIdx += 7; octave--; }
  const letter = DIATONIC[noteIdx];
  // Apply key signature accidental
  const keyAcc = keyAccidentals[letter] || '';
  return letter + keyAcc + octave;
}

/**
 * Convert a pitch string to a VexFlow line position (0 = top line).
 */
function pitchToLinePos(pitch, clef) {
  const m = pitch.match(/^([A-G])/);
  if (!m) return 2;
  const letter = m[1];
  const octave = parseInt(pitch[pitch.length - 1]);
  const noteIdx = DIATONIC.indexOf(letter);
  const base = CLEF_BASE[clef] || CLEF_BASE.treble;
  const pitchAbs = noteIdx + octave * 7;
  const baseAbs = base.noteIdx + base.octave * 7;
  return (baseAbs - pitchAbs) / 2;
}

// ---------------------------------------------------------------------------
// NoteEditor class
// ---------------------------------------------------------------------------
export class NoteEditor {
  constructor({ onNoteAdded, onNoteDeleted, sessionId, scoreData }) {
    this.onNoteAdded = onNoteAdded;
    this.onNoteDeleted = onNoteDeleted;
    this.sessionId = sessionId;
    this.scoreData = scoreData;

    // Current state
    this.isOpen = false;
    this.instrumentId = null;
    this.instrumentName = '';
    this.clef = 'treble';
    this.measure = 1;
    this.selectedDuration = 'quarter';
    this.selectedAccidental = null; // null, 'sharp', 'flat', 'natural'
    this.restMode = false;
    this.vibrato = false;
    this.dynamic = 'mf';
    this.placedNotes = []; // notes placed in this editing session (for undo)

    // DOM
    this.overlay = document.getElementById('editor-overlay');
    this.editorEl = document.getElementById('editor');
    this.editorScoreEl = document.getElementById('editor-score');
    this.ghostCanvas = document.getElementById('ghost-canvas');
    this.ghostCtx = this.ghostCanvas.getContext('2d');

    // Key signature info
    this.keyAccidentals = {};

    this._bindToolbar();
    this._bindEditorInteraction();
  }

  updateScoreData(data) {
    this.scoreData = data;
    const eSig = getEffectiveSignature(this.measure, data);
    this.keyAccidentals = getKeyAccidentals(eSig.key);
    if (this.isOpen) this._renderEditorStave();
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------
  open(instrumentId, instrumentName, clef, measure) {
    this.instrumentId = instrumentId;
    this.instrumentName = instrumentName;
    this.clef = clef;
    this.measure = measure;
    this.placedNotes = [];
    this.isOpen = true;

    document.getElementById('editor-instrument-name').textContent = instrumentName;
    document.getElementById('editor-measure-label').textContent = `Measure ${measure}`;
    this.overlay.classList.remove('hidden');

    this._renderEditorStave();
  }

  close() {
    this.isOpen = false;
    this.overlay.classList.add('hidden');
    this.editorScoreEl.innerHTML = '';
    this._clearGhost();
  }

  prevMeasure() {
    if (this.measure > 1) {
      this.measure--;
      this.placedNotes = [];
      document.getElementById('editor-measure-label').textContent = `Measure ${this.measure}`;
      this._renderEditorStave();
    }
  }

  nextMeasure() {
    if (this.scoreData && this.measure < this.scoreData.score.total_measures) {
      this.measure++;
      this.placedNotes = [];
      document.getElementById('editor-measure-label').textContent = `Measure ${this.measure}`;
      this._renderEditorStave();
    }
  }

  // -------------------------------------------------------------------------
  // Render the editor stave (1 measure, zoomed in)
  // -------------------------------------------------------------------------
  _getEffectiveSig() {
    return getEffectiveSignature(this.measure, this.scoreData);
  }

  _renderEditorStave() {
    this.editorScoreEl.innerHTML = '';
    const width = this.editorScoreEl.clientWidth || 700;
    const height = 160;

    const renderer = new VF.Renderer(this.editorScoreEl, VF.Renderer.Backends.SVG);
    renderer.resize(width, height);
    const ctx = renderer.getContext();

    const eSig = this._getEffectiveSig();
    this.keyAccidentals = getKeyAccidentals(eSig.key);

    const pad = width < 400 ? 10 : 20;
    const staveW = width - pad * 2;
    const stave = new VF.Stave(pad, 20, staveW);
    stave.addClef(this.clef);
    stave.addKeySignature(eSig.key);
    stave.addTimeSignature(eSig.time);
    stave.setContext(ctx).draw();

    this._editorStave = stave;
    this._editorCtx = ctx;
    this._editorWidth = staveW;

    // Update signature selectors to reflect current measure
    this._updateSigSelectors(eSig);

    // Get notes for this instrument/measure
    const mNotes = this.scoreData.notes.filter(
      n => n.instrument_id === this.instrumentId && n.measure === this.measure
    );

    const [beatsNum] = eSig.time.split('/').map(Number);
    const vexNotes = buildMeasureNotes(mNotes, this.clef, this.keyAccidentals, beatsNum);

    if (vexNotes.length > 0) {
      const voice = new VF.Voice({
        num_beats: beatsNum,
        beat_value: parseInt(eSig.time.split('/')[1]),
      });
      voice.setMode(VF.Voice.Mode.SOFT);
      voice.addTickables(vexNotes);
      const noteAreaWidth = stave.getNoteEndX() - stave.getNoteStartX();
      new VF.Formatter().joinVoices([voice]).format([voice], noteAreaWidth - 20);
      voice.draw(ctx, stave);

      try {
        const beamable = vexNotes.filter(
          n => !n.isRest() && (n.getDuration() === '8' || n.getDuration() === '16')
        );
        if (beamable.length >= 2) {
          VF.Beam.generateBeams(beamable).forEach(b => b.setContext(ctx).draw());
        }
      } catch (_) {}
    }

    // Draw beat grid
    this._drawBeatGrid();

    // Resize ghost canvas to match — scale for device pixel ratio (retina)
    const dpr = window.devicePixelRatio || 1;
    const canvasW = this.editorScoreEl.clientWidth;
    const canvasH = height;
    this.ghostCanvas.width = canvasW * dpr;
    this.ghostCanvas.height = canvasH * dpr;
    this.ghostCanvas.style.width = canvasW + 'px';
    this.ghostCanvas.style.height = canvasH + 'px';
    this.ghostCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _updateSigSelectors(eSig) {
    const keySel = document.getElementById('key-sig-select');
    const timeSel = document.getElementById('time-sig-select');
    const tempoInput = document.getElementById('tempo-input');
    if (keySel) keySel.value = eSig.key;
    if (timeSel) timeSel.value = eSig.time;
    if (tempoInput) tempoInput.value = eSig.tempo;
  }

  async _changeMeasureSignature({ key_signature, time_signature, tempo }) {
    const eSig = this._getEffectiveSig();
    const newKey = key_signature || eSig.key;
    const newTime = time_signature || eSig.time;
    const newTempo = tempo || eSig.tempo;

    try {
      const saved = await API.setMeasureSignature(this.measure, {
        key_signature: newKey,
        time_signature: newTime,
        tempo: newTempo,
      });
      // Update local data
      if (!this.scoreData.measureSignatures) this.scoreData.measureSignatures = [];
      const existing = this.scoreData.measureSignatures.find(s => s.measure === this.measure);
      if (existing) {
        existing.key_signature = saved.key_signature;
        existing.time_signature = saved.time_signature;
        existing.tempo = saved.tempo;
      } else {
        this.scoreData.measureSignatures.push(saved);
        this.scoreData.measureSignatures.sort((a, b) => a.measure - b.measure);
      }

      this.keyAccidentals = getKeyAccidentals(newKey);
      this._renderEditorStave();
      if (this.onNoteAdded) this.onNoteAdded({ measure: this.measure });
    } catch (err) {
      console.error('Failed to change measure signature:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Beat grid lines in editor SVG
  // -------------------------------------------------------------------------
  _drawBeatGrid() {
    if (!this._editorStave) return;
    const stave = this._editorStave;
    const eSig = this._getEffectiveSig();
    const [beatsNum] = eSig.time.split('/').map(Number);

    const noteStartX = stave.getNoteStartX();
    const noteEndX = stave.getNoteEndX();
    const musicWidth = noteEndX - noteStartX;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);

    const svgEl = this.editorScoreEl.querySelector('svg');
    if (!svgEl) return;

    for (let b = 0; b <= beatsNum; b++) {
      const x = noteStartX + (b / beatsNum) * musicWidth;

      // Beat number labels below the staff
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

      // Dashed vertical lines (skip first and last — they overlap barlines)
      if (b > 0 && b < beatsNum) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x);
        line.setAttribute('y1', topY);
        line.setAttribute('x2', x);
        line.setAttribute('y2', botY);
        line.setAttribute('stroke', '#DDD5CC');
        line.setAttribute('stroke-width', '0.5');
        line.setAttribute('stroke-dasharray', '2,3');
        line.setAttribute('pointer-events', 'none');
        svgEl.appendChild(line);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ghost note drawing
  // -------------------------------------------------------------------------
  _clearGhost() {
    const dpr = window.devicePixelRatio || 1;
    this.ghostCtx.clearRect(0, 0, this.ghostCanvas.width / dpr, this.ghostCanvas.height / dpr);
  }

  _drawGhost(x, y, pitch, snapX, color) {
    this._clearGhost();
    const ctx = this.ghostCtx;
    const c = color || '#6B8CA6';
    ctx.save();

    // Pitch highlight band across the music area
    if (!this.restMode && this._editorStave) {
      const stave = this._editorStave;
      const nsX = stave.getNoteStartX();
      const neX = stave.getNoteEndX();
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(nsX, y - 4, neX - nsX, 8);
    }

    ctx.globalAlpha = 0.5;

    if (this.restMode) {
      // Draw rest symbol placeholder
      ctx.fillStyle = c;
      ctx.font = '24px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const restSymbols = { whole: '𝄻', half: '𝄼', quarter: '𝄽', eighth: '𝄾', sixteenth: '𝄿' };
      ctx.fillText(restSymbols[this.selectedDuration] || '𝄽', x, y);
    } else {
      // Draw note head
      const filled = ['quarter', 'eighth', 'sixteenth'].includes(this.selectedDuration);
      ctx.beginPath();
      ctx.ellipse(x, y, 7, 5, -0.2, 0, Math.PI * 2);
      ctx.fillStyle = c;
      if (filled) {
        ctx.fill();
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = c;
        ctx.stroke();
      }

      // Draw stem (unless whole note)
      if (this.selectedDuration !== 'whole') {
        const linePos = this._yToLinePos(y);
        const stemUp = linePos > 2; // below middle line → stem up
        ctx.beginPath();
        if (stemUp) {
          ctx.moveTo(x + 6, y);
          ctx.lineTo(x + 6, y - 35);
        } else {
          ctx.moveTo(x - 6, y);
          ctx.lineTo(x - 6, y + 35);
        }
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Draw ledger lines if needed
      this._drawLedgerLines(ctx, x, y);

      // Draw accidental symbol
      if (this.selectedAccidental) {
        const symbols = { sharp: '♯', flat: '♭', natural: '♮' };
        ctx.fillStyle = c;
        ctx.font = '16px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(symbols[this.selectedAccidental] || '', x - 16, y);
      }

      // Show pitch label
      ctx.fillStyle = c;
      ctx.font = '11px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(pitch, x, y + (this.selectedDuration === 'whole' ? 12 : 8));
    }

    ctx.restore();
  }

  _drawLedgerLines(ctx, x, y) {
    if (!this._editorStave) return;
    const stave = this._editorStave;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);
    const spacing = (botY - topY) / 4;

    ctx.strokeStyle = '#6B8CA6';
    ctx.lineWidth = 1;

    // Above staff
    for (let ly = topY - spacing; ly >= y - 2; ly -= spacing) {
      ctx.beginPath();
      ctx.moveTo(x - 12, ly);
      ctx.lineTo(x + 12, ly);
      ctx.stroke();
    }
    // Below staff
    for (let ly = botY + spacing; ly <= y + 2; ly += spacing) {
      ctx.beginPath();
      ctx.moveTo(x - 12, ly);
      ctx.lineTo(x + 12, ly);
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Replace highlight — red tint on existing note being hovered for replace
  // -------------------------------------------------------------------------
  _highlightExistingNote(beat) {
    if (!this._editorStave) return;
    const note = this.scoreData.notes.find(
      n => n.instrument_id === this.instrumentId &&
           n.measure === this.measure &&
           Math.abs(n.beat - beat) < 0.01
    );
    if (!note) return;

    const noteX = this._snapX(note.beat);
    const linePos = pitchToLinePos(note.pitch, this.clef);
    const noteY = this._snapY(linePos);

    const ctx = this.ghostCtx;
    ctx.save();
    ctx.globalAlpha = 0.35;

    // Red circle around the existing note
    ctx.beginPath();
    ctx.arc(noteX, noteY, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#E53935';
    ctx.fill();

    // "x" symbol
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u00d7', noteX, noteY);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Mouse → pitch/beat conversion
  // -------------------------------------------------------------------------
  _yToLinePos(y) {
    if (!this._editorStave) return 2;
    const stave = this._editorStave;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);
    const spacing = (botY - topY) / 4;
    const halfSpacing = spacing / 2;
    const rawPos = (y - topY) / halfSpacing;
    return Math.round(rawPos * 2) / 2; // snap to half-positions
  }

  _xToBeat(x) {
    if (!this._editorStave) return 1;
    const stave = this._editorStave;
    const noteStartX = stave.getNoteStartX();
    const noteEndX = stave.getNoteEndX();
    const musicWidth = noteEndX - noteStartX;

    const eSig = this._getEffectiveSig();
    const [beatsNum] = eSig.time.split('/').map(Number);
    const durBeats = DUR_TO_BEATS[this.selectedDuration] || 1;
    const subdivisions = beatsNum / durBeats;

    const relX = x - noteStartX;
    const gridPos = Math.round((relX / musicWidth) * subdivisions);
    const clamped = Math.max(0, Math.min(gridPos, subdivisions - 1));
    return 1 + clamped * durBeats;
  }

  _snapY(linePos) {
    if (!this._editorStave) return 0;
    const stave = this._editorStave;
    const topY = stave.getYForLine(0);
    const botY = stave.getYForLine(4);
    const halfSpacing = (botY - topY) / 8;
    return topY + linePos * halfSpacing * 2;
    // Actually: each line position unit = halfSpacing
    // linePos 0 → topY, linePos 4 → botY
  }

  _snapX(beat) {
    if (!this._editorStave) return 0;
    const stave = this._editorStave;
    const noteStartX = stave.getNoteStartX();
    const noteEndX = stave.getNoteEndX();
    const musicWidth = noteEndX - noteStartX;

    const eSig = this._getEffectiveSig();
    const [beatsNum] = eSig.time.split('/').map(Number);
    const fraction = (beat - 1) / beatsNum;
    return noteStartX + fraction * musicWidth;
  }

  // -------------------------------------------------------------------------
  // Toolbar bindings
  // -------------------------------------------------------------------------
  _bindToolbar() {
    // Duration buttons
    document.querySelectorAll('.dur-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedDuration = btn.dataset.duration;
      });
    });

    // Accidental buttons
    document.querySelectorAll('.acc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) {
          btn.classList.remove('active');
          this.selectedAccidental = null;
        } else {
          document.querySelectorAll('.acc-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.selectedAccidental = btn.dataset.accidental;
        }
      });
    });

    // Rest toggle
    document.getElementById('rest-toggle').addEventListener('click', () => {
      this.restMode = !this.restMode;
      document.getElementById('rest-toggle').classList.toggle('active', this.restMode);
    });

    // Vibrato toggle
    document.getElementById('vibrato-toggle').addEventListener('click', () => {
      this.vibrato = !this.vibrato;
      document.getElementById('vibrato-toggle').classList.toggle('active', this.vibrato);
    });

    // Dynamic
    document.getElementById('dynamic-select').addEventListener('change', (e) => {
      this.dynamic = e.target.value;
    });

    // Key signature change
    document.getElementById('key-sig-select').addEventListener('change', (e) => {
      this._changeMeasureSignature({ key_signature: e.target.value });
    });

    // Time signature change
    document.getElementById('time-sig-select').addEventListener('change', (e) => {
      this._changeMeasureSignature({ time_signature: e.target.value });
    });

    // Tempo (BPM) change
    document.getElementById('tempo-input').addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      if (val >= 20 && val <= 300) {
        this._changeMeasureSignature({ tempo: val });
      } else {
        // Reset to current effective tempo
        const eSig = this._getEffectiveSig();
        e.target.value = eSig.tempo;
      }
    });

    // Undo
    document.getElementById('undo-btn').addEventListener('click', () => this.undo());

    // Close
    document.getElementById('editor-close').addEventListener('click', () => this.close());

    // Measure navigation
    document.getElementById('editor-prev-measure').addEventListener('click', () => this.prevMeasure());
    document.getElementById('editor-next-measure').addEventListener('click', () => this.nextMeasure());

    // Click overlay background to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  // -------------------------------------------------------------------------
  // Editor interaction (hover + click)
  // -------------------------------------------------------------------------
  _bindEditorInteraction() {
    const wrapper = document.getElementById('editor-score-wrapper');

    // Shared logic for pointer position (mouse or touch)
    const handlePointerMove = (clientX, clientY) => {
      if (!this.isOpen || !this._editorStave) return;
      const rect = this.ghostCanvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;

      const noteStartX = this._editorStave.getNoteStartX();
      const noteEndX = this._editorStave.getNoteEndX();
      const clampedX = Math.max(noteStartX, Math.min(mx, noteEndX));

      const linePos = this._yToLinePos(my);
      const beat = this._xToBeat(clampedX);
      const snappedY = this._snapY(linePos);
      const snappedX = this._snapX(beat);

      const pitch = linePosToPitch(linePos, this.clef, this.keyAccidentals);
      this._currentGhost = { pitch, beat, linePos, x: snappedX, y: snappedY };

      const existing = this.scoreData.notes.find(
        n => n.instrument_id === this.instrumentId &&
             n.measure === this.measure &&
             !n.is_rest &&
             Math.abs(n.beat - beat) < 0.01
      );

      if (existing) {
        this._drawGhost(snappedX, snappedY, pitch, null, '#4CAF50');
        this._highlightExistingNote(existing.beat);
      } else {
        this._drawGhost(snappedX, snappedY, pitch, null, '#6B8CA6');
      }
    };

    const handlePointerPlace = () => {
      if (!this.isOpen || !this._currentGhost) return;
      const { pitch, beat } = this._currentGhost;

      const existing = this.scoreData.notes.find(
        n => n.instrument_id === this.instrumentId &&
             n.measure === this.measure &&
             Math.abs(n.beat - beat) < 0.01
      );
      if (existing) {
        this._deleteExistingNote(existing);
      } else {
        this._placeNote(pitch, beat);
      }
    };

    // Mouse events
    wrapper.addEventListener('mousemove', (e) => handlePointerMove(e.clientX, e.clientY));
    wrapper.addEventListener('mouseleave', () => {
      this._clearGhost();
      this._currentGhost = null;
    });
    wrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      handlePointerPlace();
    });

    // Touch events (mobile)
    wrapper.addEventListener('touchmove', (e) => {
      e.preventDefault(); // prevent scrolling while editing
      const t = e.touches[0];
      if (t) handlePointerMove(t.clientX, t.clientY);
    }, { passive: false });

    wrapper.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if (t) handlePointerMove(t.clientX, t.clientY);
    }, { passive: true });

    wrapper.addEventListener('touchend', (e) => {
      e.preventDefault();
      handlePointerPlace();
      // Clear ghost after a short delay so user sees feedback
      setTimeout(() => {
        this._clearGhost();
        this._currentGhost = null;
      }, 200);
    });
  }

  // -------------------------------------------------------------------------
  // Place a note
  // -------------------------------------------------------------------------
  async _placeNote(pitch, beat) {
    // Check beat capacity — don't exceed time signature
    const eSig = this._getEffectiveSig();
    const [beatsNum] = eSig.time.split('/').map(Number);
    const existingNotes = this.scoreData.notes.filter(
      n => n.instrument_id === this.instrumentId && n.measure === this.measure
    );
    const usedBeats = existingNotes.reduce((sum, n) => sum + (DUR_TO_BEATS[n.duration] || 0), 0);
    const newNoteBeats = DUR_TO_BEATS[this.selectedDuration] || 1;
    // Block if total beats would overflow OR if note extends past end of measure
    if (usedBeats + newNoteBeats > beatsNum || beat + newNoteBeats - 1 > beatsNum) {
      this.editorEl.style.borderColor = '#c44';
      setTimeout(() => { this.editorEl.style.borderColor = ''; }, 400);
      return;
    }

    // Apply selected accidental override
    let finalPitch = pitch;
    if (this.selectedAccidental && !this.restMode) {
      const letter = pitch[0];
      const octave = pitch[pitch.length - 1];
      switch (this.selectedAccidental) {
        case 'sharp':   finalPitch = letter + '#' + octave; break;
        case 'flat':    finalPitch = letter + 'b' + octave; break;
        case 'natural': finalPitch = letter + octave; break;
      }
    }

    const noteData = {
      instrument_id: this.instrumentId,
      pitch: finalPitch,
      measure: this.measure,
      beat,
      duration: this.selectedDuration,
      is_rest: this.restMode,
      accidental: this.selectedAccidental || null,
      dynamic: this.dynamic,
      vibrato: this.vibrato,
      session_id: this.sessionId,
    };

    try {
      const saved = await API.addNote(noteData);
      this.placedNotes.push(saved);

      // Add to local data
      this.scoreData.notes.push(saved);

      // Re-render editor stave to show the new note
      this._renderEditorStave();

      // Notify parent to re-render main score
      if (this.onNoteAdded) this.onNoteAdded(saved);
    } catch (err) {
      console.error('Failed to place note:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Undo last placed note
  // -------------------------------------------------------------------------
  async undo() {
    if (this.placedNotes.length === 0) return;
    const last = this.placedNotes.pop();

    try {
      await API.deleteNote(last.id, this.sessionId);

      // Remove from local data
      const idx = this.scoreData.notes.findIndex(n => n.id === last.id);
      if (idx !== -1) this.scoreData.notes.splice(idx, 1);

      this._renderEditorStave();
      if (this.onNoteDeleted) this.onNoteDeleted(last);
    } catch (err) {
      console.error('Failed to undo note:', err);
      this.placedNotes.push(last); // re-add on failure
    }
  }

  // -------------------------------------------------------------------------
  // Delete an existing note (click-to-replace)
  // -------------------------------------------------------------------------
  async _deleteExistingNote(note) {
    try {
      await API.deleteNote(note.id, this.sessionId);
    } catch (_) {
      // If session mismatch, try re-adding as our own note at the same position
      // For now, just remove locally for UX
    }
    const idx = this.scoreData.notes.findIndex(n => n.id === note.id);
    if (idx !== -1) this.scoreData.notes.splice(idx, 1);
    this._renderEditorStave();
    if (this.onNoteDeleted) this.onNoteDeleted(note);
  }

  // -------------------------------------------------------------------------
  // Duration selection by number key
  // -------------------------------------------------------------------------
  selectDuration(n) {
    const durations = ['whole', 'half', 'quarter', 'eighth', 'sixteenth'];
    if (n >= 1 && n <= 5) {
      this.selectedDuration = durations[n - 1];
      document.querySelectorAll('.dur-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.duration === this.selectedDuration);
      });
    }
  }

  toggleRest() {
    this.restMode = !this.restMode;
    document.getElementById('rest-toggle').classList.toggle('active', this.restMode);
  }

  toggleVibrato() {
    this.vibrato = !this.vibrato;
    document.getElementById('vibrato-toggle').classList.toggle('active', this.vibrato);
  }
}
