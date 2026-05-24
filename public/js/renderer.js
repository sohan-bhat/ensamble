const VF = Vex.Flow;

// Duration name → VexFlow code.
const DUR_TO_VEX = {
  whole: 'w', half: 'h', quarter: 'q', eighth: '8', sixteenth: '16',
};

// Duration name → number of quarter-note beats.
const DUR_TO_BEATS = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
};

// Longest-first so rest-filling can greedily place the largest rest that fits.
const REST_DURATIONS = [
  [4, 'w'], [2, 'h'], [1, 'q'], [0.5, '8'], [0.25, '16'],
];

function getKeyAccidentals(key) {
  const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flats  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  const map = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  };
  const n = map[key] || 0;
  const result = {};
  if (n > 0) for (let i = 0; i < n; i++) result[sharps[i]] = '#';
  if (n < 0) for (let i = 0; i < -n; i++) result[flats[i]] = 'b';
  return result;
}

// "D5" → "d/5" — VexFlow key format, position only (no accidental).
function pitchToVexKey(pitch) {
  const m = pitch.match(/^([A-G])(#|b)?(\d)$/);
  if (!m) return 'b/4';
  return `${m[1].toLowerCase()}/${m[3]}`;
}

function pitchAccidental(pitch) {
  const m = pitch.match(/^[A-G](#|b)?/);
  return m && m[1] ? m[1] : '';
}

function pitchLetter(pitch) {
  return pitch[0];
}

// Whether to draw an accidental glyph in front of this pitch, given the key sig.
function displayAccidental(pitch, keyAccidentals) {
  const letter = pitchLetter(pitch);
  const acc = pitchAccidental(pitch);
  const keyAcc = keyAccidentals[letter] || '';

  if (acc === keyAcc) return null;
  if (acc === '#') return '#';
  if (acc === 'b') return 'b';
  if (acc === '' && keyAcc) return 'n';
  return null;
}

// Rest defaults to mid-staff per clef.
function restPosition(clef) {
  if (clef === 'treble') return 'b/4';
  if (clef === 'alto')   return 'c/4';
  if (clef === 'bass')   return 'd/3';
  return 'b/4';
}

// Walk forward through measureSignatures applying any override at or before `measure`.
// The latest override wins, so later sigs in the list shadow earlier ones.
function getEffectiveSignature(measure, scoreData) {
  const sigs = scoreData.measureSignatures || [];
  let key = scoreData.score.key_signature;
  let time = scoreData.score.time_signature;
  let tempo = scoreData.score.tempo;
  for (const s of sigs) {
    if (s.measure <= measure) {
      if (s.key_signature) key = s.key_signature;
      if (s.time_signature) time = s.time_signature;
      if (s.tempo) tempo = s.tempo;
    }
  }
  return { key, time, tempo };
}

// Build the VexFlow note sequence for one measure, auto-filling rests in gaps.
function buildMeasureNotes(notes, clef, keyAccidentals, beatsPerMeasure) {
  const sorted = [...notes].sort((a, b) => a.beat - b.beat);
  const vexNotes = [];
  let cursor = 1; // beats are 1-based

  for (const note of sorted) {
    if (note.beat > cursor + 0.001) {
      pushRests(vexNotes, note.beat - cursor, clef);
      cursor = note.beat;
    }

    const beats = DUR_TO_BEATS[note.duration] || 1;
    const vexDur = DUR_TO_VEX[note.duration] || 'q';

    if (note.is_rest) {
      vexNotes.push(new VF.StaveNote({
        clef, keys: [restPosition(clef)], duration: vexDur + 'r',
      }));
    } else {
      const key = pitchToVexKey(note.pitch);
      const sn = new VF.StaveNote({
        clef, keys: [key], duration: vexDur, auto_stem: true,
      });
      const acc = displayAccidental(note.pitch, keyAccidentals);
      if (acc) {
        sn.addModifier(new VF.Accidental(acc), 0);
      }
      if (note.vibrato) {
        try {
          sn.addModifier(new VF.Vibrato());
        } catch (_) { /* VF.Vibrato is missing in some builds — silently skip the marking */ }
      }
      sn._ensembleId = note.id;
      vexNotes.push(sn);
    }

    cursor += beats;
  }

  const remaining = beatsPerMeasure - cursor + 1;
  if (remaining > 0.001) {
    pushRests(vexNotes, remaining, clef);
  }

  return vexNotes;
}

function pushRests(arr, beats, clef) {
  let rem = beats;
  for (const [durBeats, durVex] of REST_DURATIONS) {
    while (rem >= durBeats - 0.001) {
      arr.push(new VF.StaveNote({
        clef, keys: [restPosition(clef)], duration: durVex + 'r',
      }));
      rem -= durBeats;
    }
  }
}

export class ScoreRenderer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.labelsContainer = document.getElementById('instrument-labels');
    this.staveMap = []; // populated by render(); used by hitTest and the seek overlay
  }

  _getResponsiveSettings() {
    const w = window.innerWidth;
    if (w <= 480) {
      return { measuresPerSystem: 1, staveSpacing: 65, systemGap: 25, leftMargin: 40 };
    } else if (w <= 768) {
      return { measuresPerSystem: 2, staveSpacing: 70, systemGap: 30, leftMargin: 40 };
    }
    return { measuresPerSystem: 4, staveSpacing: 75, systemGap: 35, leftMargin: 40 };
  }

  render(data) {
    const { score, instruments, notes } = data;
    this.container.innerHTML = '';
    this.staveMap = [];
    this._tempoMarks = [];

    const rs = this._getResponsiveSettings();
    const measuresPerSystem = rs.measuresPerSystem;
    const staveSpacing = rs.staveSpacing;
    const systemGap = rs.systemGap;
    const leftMargin = rs.leftMargin;

    const totalMeasures = score.total_measures;
    const numSystems = Math.ceil(totalMeasures / measuresPerSystem);

    const noteMap = {};
    for (const n of notes) {
      const k = `${n.instrument_id}__${n.measure}`;
      (noteMap[k] = noteMap[k] || []).push(n);
    }

    // Fit the viewport; clamp to 320px so very narrow phones still get a usable stave.
    const containerWidth = Math.max(this.container.clientWidth, 320);
    const systemHeight = instruments.length * staveSpacing;
    const totalHeight = numSystems * (systemHeight + systemGap) + 60;

    const renderer = new VF.Renderer(this.container, VF.Renderer.Backends.SVG);
    renderer.resize(containerWidth, totalHeight);
    const ctx = renderer.getContext();
    ctx.scale(1, 1);

    for (let sys = 0; sys < numSystems; sys++) {
      const startMeasure = sys * measuresPerSystem + 1;
      const systemY = sys * (systemHeight + systemGap) + 20;

      // Last system may be shorter than measuresPerSystem.
      const measCount = Math.min(measuresPerSystem, totalMeasures - startMeasure + 1);

      const availableWidth = containerWidth - leftMargin - 10;
      const staveWidth = (availableWidth) / measCount;

      let firstStavesOfSystem = []; // top + bottom stave of column 0, used to draw the system bracket

      for (let i = 0; i < instruments.length; i++) {
        const inst = instruments[i];
        const y = systemY + i * staveSpacing;
        const stavesInRow = [];

        for (let m = 0; m < measCount; m++) {
          const measureNum = startMeasure + m;
          const isFirst = m === 0;
          const isFirstSystem = sys === 0;
          const x = leftMargin + m * staveWidth;

          const eSig = getEffectiveSignature(measureNum, data);
          const prevSig = measureNum > 1 ? getEffectiveSignature(measureNum - 1, data) : null;
          const keyChanged = prevSig && prevSig.key !== eSig.key;
          const timeChanged = prevSig && prevSig.time !== eSig.time;
          const tempoChanged = prevSig && prevSig.tempo !== eSig.tempo;

          const stave = new VF.Stave(x, y, staveWidth);

          if (isFirst) {
            stave.addClef(inst.clef);
            stave.addKeySignature(eSig.key);
            if (isFirstSystem) {
              stave.addTimeSignature(eSig.time);
            }
          }

          // Re-draw key/time when they change mid-piece — otherwise the change is invisible.
          if (!isFirst) {
            if (keyChanged) stave.addKeySignature(eSig.key);
            if (timeChanged) stave.addTimeSignature(eSig.time);
          }

          stave.setContext(ctx).draw();
          stavesInRow.push(stave);

          if (i === 0 && (measureNum === 1 || tempoChanged)) {
            this._tempoMarks = this._tempoMarks || [];
            this._tempoMarks.push({ x: x + 5, y: y - 5, tempo: eSig.tempo });
          }

          this.staveMap.push({
            instrumentId: inst.id,
            instrumentName: inst.name,
            clef: inst.clef,
            measure: measureNum,
            x, y, width: staveWidth,
            height: staveSpacing,
            stave,
          });

          const mKeyAcc = getKeyAccidentals(eSig.key);
          const [mBeatsNum] = eSig.time.split('/').map(Number);
          const mNotes = noteMap[`${inst.id}__${measureNum}`] || [];
          const vexNotes = buildMeasureNotes(mNotes, inst.clef, mKeyAcc, mBeatsNum);

          if (vexNotes.length > 0) {
            const voice = new VF.Voice({
              num_beats: mBeatsNum,
              beat_value: parseInt(eSig.time.split('/')[1]),
            });
            voice.setMode(VF.Voice.Mode.SOFT);
            voice.addTickables(vexNotes);

            const fmtWidth = Math.max(stave.getNoteEndX() - stave.getNoteStartX() - 10, 50);
            new VF.Formatter()
              .joinVoices([voice])
              .format([voice], fmtWidth);

            voice.draw(ctx, stave);

            try {
              const beamable = vexNotes.filter(
                n => !n.isRest() &&
                  (n.getDuration() === '8' || n.getDuration() === '16')
              );
              if (beamable.length >= 2) {
                const beams = VF.Beam.generateBeams(beamable);
                beams.forEach(b => b.setContext(ctx).draw());
              }
            } catch (_) { /* beam generation can fail on edge-case voices — non-critical, skip */ }
          }

          if (m === 0) {
            if (i === 0) firstStavesOfSystem[0] = stave;
            if (i === instruments.length - 1) firstStavesOfSystem[1] = stave;
          }
        }
      }

      if (firstStavesOfSystem[0] && firstStavesOfSystem[1]) {
        const bracket = new VF.StaveConnector(firstStavesOfSystem[0], firstStavesOfSystem[1]);
        bracket.setType(VF.StaveConnector.type.BRACKET);
        bracket.setContext(ctx).draw();

        const line = new VF.StaveConnector(firstStavesOfSystem[0], firstStavesOfSystem[1]);
        line.setType(VF.StaveConnector.type.SINGLE_LEFT);
        line.setContext(ctx).draw();
      }
    }

    this._addMeasureHoverRects(ctx, instruments, totalMeasures);
    this._drawTempoMarks();
    this._renderLabels(instruments);

    return this.staveMap;
  }

  _drawTempoMarks() {
    if (!this._tempoMarks || this._tempoMarks.length === 0) return;
    const svgEl = this.container.querySelector('svg');
    if (!svgEl) return;

    for (const mark of this._tempoMarks) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', mark.x);
      text.setAttribute('y', mark.y);
      text.setAttribute('font-family', '"DM Sans", sans-serif');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', '#2C2C2C');
      text.setAttribute('pointer-events', 'none');
      text.textContent = `\u2669 = ${mark.tempo}`;
      svgEl.appendChild(text);
    }
    this._tempoMarks = [];
  }

  _addMeasureHoverRects(ctx, instruments, totalMeasures) {
    const svgEl = this.container.querySelector('svg');
    if (!svgEl) return;

    for (const s of this.staveMap) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', s.x);
      rect.setAttribute('y', s.y);
      rect.setAttribute('width', s.width);
      rect.setAttribute('height', s.height);
      rect.setAttribute('class', 'measure-hover-rect');
      rect.setAttribute('data-measure', s.measure);
      rect.setAttribute('data-instrument', s.instrumentId);
      svgEl.appendChild(rect);
    }
  }

  _renderLabels(instruments) {
    if (!this.labelsContainer) return;
    this.labelsContainer.innerHTML = '';

    for (const inst of instruments) {
      const entry = this.staveMap.find(s => s.instrumentId === inst.id);
      if (!entry) continue;

      const label = document.createElement('div');
      label.className = 'instrument-label';
      // +20 centers the label on the stave lines (the row is ~75px but the actual staff sits ~20px down).
      label.style.top = `${entry.y + 20}px`;
      label.textContent = inst.abbreviation;
      this.labelsContainer.appendChild(label);
    }
  }

  hitTest(clientX, clientY) {
    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left + this.container.scrollLeft;
    const y = clientY - rect.top + this.container.scrollTop;

    for (const s of this.staveMap) {
      if (x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height) {
        return s;
      }
    }
    return null;
  }

  // Used by the playhead to know the column geometry for one measure across all instruments.
  getSystemBoundsForMeasure(measureNum) {
    const staves = this.staveMap.filter(s => s.measure === measureNum);
    if (staves.length === 0) return null;

    const first = staves[0];
    const last = staves[staves.length - 1];
    return {
      noteStartX: first.stave.getNoteStartX(),
      noteEndX: first.stave.getNoteEndX(),
      topY: first.y,
      bottomY: last.y + last.height,
    };
  }
}

export {
  DUR_TO_VEX, DUR_TO_BEATS, REST_DURATIONS,
  getKeyAccidentals, pitchToVexKey, pitchAccidental, pitchLetter,
  displayAccidental, restPosition, buildMeasureNotes, pushRests,
  getEffectiveSignature,
};
