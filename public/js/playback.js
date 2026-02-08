// =========================================================================
// Ensemble — Playback Engine (Sample-based, Web Audio API)
//
// Uses real instrument samples from the FluidR3_GM soundfont (clean,
// non-vibrato recordings) via the MIDI.js Soundfonts project.
// Vibrato is only applied when explicitly enabled per-note.
// Falls back to sine synthesis if a sample can't be loaded.
// =========================================================================

import { DUR_TO_BEATS, getEffectiveSignature } from './renderer.js';

// ---------------------------------------------------------------------------
// Sample source — FluidR3_GM: clean, dry, no baked-in vibrato
// ---------------------------------------------------------------------------
const SAMPLE_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';

const INST_TO_SOUNDFONT = {
  violin1:    'violin',
  violin2:    'violin',
  viola:      'viola',
  cello:      'cello',
  contrabass: 'contrabass',
};

// Soundfont note names use flats (Db not C#)
const SHARP_TO_FLAT = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
};

function pitchToSampleKey(pitch) {
  const m = pitch.match(/^([A-G])(#|b)?(\d)$/);
  if (!m) return 'C4';
  const [, letter, acc, oct] = m;
  if (acc === '#') {
    const flat = SHARP_TO_FLAT[letter + '#'];
    if (flat) return flat + oct;
  }
  return letter + (acc || '') + oct;
}

// ---------------------------------------------------------------------------
// Synthesis fallback
// ---------------------------------------------------------------------------
const NOTE_SEMITONES = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

function pitchToFreq(pitch) {
  const m = pitch.match(/^([A-G])(#|b)?(\d)$/);
  if (!m) return 440;
  const [, note, acc, oct] = m;
  let semitones = NOTE_SEMITONES[note] + (parseInt(oct) - 4) * 12;
  if (acc === '#') semitones += 1;
  if (acc === 'b') semitones -= 1;
  return 440 * Math.pow(2, semitones / 12);
}

// Dynamic → gain multiplier
const DYNAMIC_GAIN = {
  pp: 0.3, p: 0.5, mp: 0.7, mf: 1.0, f: 1.3, ff: 1.6,
};

// Schedule audio slightly after visual so the playhead reaches the note
// position before the sound plays (accounts for VexFlow formatter padding).
const SCHEDULE_AHEAD = 0.12; // seconds

// Per-instrument gain scaling (balance the ensemble)
const INST_GAIN = {
  violin1: 0.9, violin2: 0.85, viola: 0.9, cello: 1.0, contrabass: 1.1,
};

// ---------------------------------------------------------------------------
// SampleCache
// ---------------------------------------------------------------------------
class SampleCache {
  constructor() {
    this._cache = new Map();
    this._pending = new Map();
  }

  async preload(audioCtx, notes) {
    const jobs = [];
    const seen = new Set();
    for (const n of notes) {
      if (n.is_rest) continue;
      const sfInst = INST_TO_SOUNDFONT[n.instrument_id] || 'violin';
      const sampleKey = pitchToSampleKey(n.pitch);
      const cacheKey = `${sfInst}:${sampleKey}`;
      if (seen.has(cacheKey) || this._cache.has(cacheKey)) continue;
      seen.add(cacheKey);
      jobs.push(this._load(audioCtx, sfInst, sampleKey, cacheKey));
    }
    await Promise.all(jobs);
  }

  async _load(audioCtx, sfInst, sampleKey, cacheKey) {
    if (this._pending.has(cacheKey)) return this._pending.get(cacheKey);
    const promise = (async () => {
      try {
        const url = `${SAMPLE_BASE}/${sfInst}-mp3/${sampleKey}.mp3`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const audio = await audioCtx.decodeAudioData(buf);
        this._cache.set(cacheKey, audio);
      } catch (err) {
        console.warn(`Sample load failed (${cacheKey}):`, err.message);
      } finally {
        this._pending.delete(cacheKey);
      }
    })();
    this._pending.set(cacheKey, promise);
    return promise;
  }

  get(instrumentId, pitch) {
    const sfInst = INST_TO_SOUNDFONT[instrumentId] || 'violin';
    const sampleKey = pitchToSampleKey(pitch);
    return this._cache.get(`${sfInst}:${sampleKey}`) || null;
  }
}

// ---------------------------------------------------------------------------
// Build an impulse response buffer for convolution reverb
// ---------------------------------------------------------------------------
function createReverbImpulse(audioCtx, seconds = 1.8, decay = 2.5) {
  const rate = audioCtx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = audioCtx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PlaybackEngine
// ---------------------------------------------------------------------------
export class PlaybackEngine {
  constructor() {
    this.audioCtx = null;
    this.playing = false;
    this.loading = false;
    this.startTime = 0;
    this.startMeasure = 1;
    this.scheduledNodes = [];
    this.mutedInstruments = new Set();
    this.soloInstrument = null;
    this.onMeasureChange = null;
    this.onPlaybackTick = null;
    this._animFrame = null;
    this._samples = new SampleCache();
    this._reverbBuf = null;
  }

  _ensureContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    // Pre-create reverb impulse once
    if (!this._reverbBuf) {
      this._reverbBuf = createReverbImpulse(this.audioCtx);
    }
  }

  async play(scoreData, fromMeasure = 1) {
    this._ensureContext();
    this.stop();

    this.playing = true;
    this.loading = true;
    this.startMeasure = fromMeasure;
    this._scoreData = scoreData;

    const { score, notes } = scoreData;

    // Pre-load samples
    const playable = notes.filter(n => !n.is_rest && n.measure >= fromMeasure);
    await this._samples.preload(this.audioCtx, playable);
    if (!this.playing) return;
    this.loading = false;

    // ---- Master audio graph ----

    // Compressor → destination
    this._compressor = this.audioCtx.createDynamicsCompressor();
    this._compressor.threshold.value = -15;
    this._compressor.knee.value = 10;
    this._compressor.ratio.value = 3;
    this._compressor.attack.value = 0.005;
    this._compressor.release.value = 0.2;
    this._compressor.connect(this.audioCtx.destination);

    // Convolution reverb (hall-like) mixed into compressor
    this._reverb = this.audioCtx.createConvolver();
    this._reverb.buffer = this._reverbBuf;
    const reverbWet = this.audioCtx.createGain();
    reverbWet.gain.value = 0.25;
    this._reverb.connect(reverbWet);
    reverbWet.connect(this._compressor);

    // Dry bus → compressor
    this._dryBus = this.audioCtx.createGain();
    this._dryBus.gain.value = 1.0;
    this._dryBus.connect(this._compressor);
    this._dryBus.connect(this._reverb); // feed reverb from dry bus

    this.startTime = this.audioCtx.currentTime;

    // Find the last measure that actually has notes (skip trailing empty measures)
    let lastNotesMeasure = fromMeasure;
    for (const n of notes) {
      if (!n.is_rest && n.measure >= fromMeasure && n.measure > lastNotesMeasure) {
        lastNotesMeasure = n.measure;
      }
    }
    this._lastPlayMeasure = lastNotesMeasure;

    // Cumulative measure timing with per-measure tempo
    this._measureStartTimes = {};
    this._measureSecPerBeat = {};
    let cumTime = 0;
    for (let m = fromMeasure; m <= lastNotesMeasure; m++) {
      this._measureStartTimes[m] = cumTime;
      const mSig = getEffectiveSignature(m, scoreData);
      const mTempo = mSig.tempo || score.tempo;
      const mSecPerBeat = 60 / mTempo;
      this._measureSecPerBeat[m] = mSecPerBeat;
      const [mBeats] = mSig.time.split('/').map(Number);
      cumTime += mBeats * mSecPerBeat;
    }
    this._totalDuration = cumTime;

    // Schedule notes using per-measure tempo
    for (const note of notes) {
      if (note.is_rest) continue;
      if (note.measure < fromMeasure) continue;
      if (this.soloInstrument && note.instrument_id !== this.soloInstrument) continue;
      if (this.mutedInstruments.has(note.instrument_id)) continue;

      const measureStart = this._measureStartTimes[note.measure] || 0;
      const secPerBeat = this._measureSecPerBeat[note.measure] || 60 / score.tempo;
      const noteStart = this.startTime + SCHEDULE_AHEAD + measureStart + (note.beat - 1) * secPerBeat;
      const durBeats = DUR_TO_BEATS[note.duration] || 1;
      const noteDur = durBeats * secPerBeat;

      this._scheduleNote(note, noteStart, noteDur);
    }

    this._animateMeasure(scoreData);
  }

  stop() {
    this.playing = false;
    this.loading = false;
    for (const node of this.scheduledNodes) {
      try { node.stop(); } catch (_) {}
    }
    this.scheduledNodes = [];
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this.onPlaybackTick) this.onPlaybackTick({ stopped: true });
  }

  toggleMute(instrumentId) {
    if (this.mutedInstruments.has(instrumentId)) {
      this.mutedInstruments.delete(instrumentId);
    } else {
      this.mutedInstruments.add(instrumentId);
    }
  }

  toggleSolo(instrumentId) {
    this.soloInstrument = this.soloInstrument === instrumentId ? null : instrumentId;
  }

  // -------------------------------------------------------------------------
  // Schedule a single note
  // -------------------------------------------------------------------------
  _scheduleNote(note, startTime, duration) {
    const ctx = this.audioCtx;
    const dynGain = DYNAMIC_GAIN[note.dynamic] || 1.0;
    const instGain = INST_GAIN[note.instrument_id] || 1.0;
    const totalGain = dynGain * instGain;
    const useVibrato = note.vibrato === 1;
    const buffer = this._samples.get(note.instrument_id, note.pitch);

    // Per-note gain node → dry bus
    const noteGain = ctx.createGain();
    noteGain.gain.value = 0;
    noteGain.connect(this._dryBus);

    if (buffer) {
      // ---- Sample-based ----
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // Warmth filter — gentle low-pass to tame harsh highs in the samples
      const warmth = ctx.createBiquadFilter();
      warmth.type = 'lowpass';
      warmth.frequency.value = 6000;
      warmth.Q.value = 0.5;
      source.connect(warmth);
      warmth.connect(noteGain);

      // Vibrato via pitch detune — ONLY when explicitly enabled
      if (useVibrato) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = 5.2;
        // Delayed onset: no vibrato at start, ramp in naturally
        lfoGain.gain.setValueAtTime(0, startTime);
        lfoGain.gain.linearRampToValueAtTime(
          12, startTime + Math.min(0.4, duration * 0.5)
        );
        lfo.connect(lfoGain);
        lfoGain.connect(source.detune);
        lfo.start(startTime);
        lfo.stop(startTime + duration + 0.1);
        this.scheduledNodes.push(lfo);
      }

      // Smooth bow-like envelope
      const attack = Math.min(0.06, duration * 0.15);
      const release = Math.min(0.2, duration * 0.3);
      const sustainStart = startTime + attack;
      const releaseStart = startTime + duration - release;

      noteGain.gain.setValueAtTime(0.001, startTime);
      noteGain.gain.exponentialRampToValueAtTime(totalGain, sustainStart);
      // Gentle sustain decay (natural bow fading slightly)
      noteGain.gain.setValueAtTime(totalGain, sustainStart);
      noteGain.gain.exponentialRampToValueAtTime(
        Math.max(totalGain * 0.85, 0.001), releaseStart
      );
      // Release
      noteGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      source.start(startTime);
      source.stop(startTime + duration + 0.1);
      this.scheduledNodes.push(source);

    } else {
      // ---- Synthesis fallback ----
      const freq = pitchToFreq(note.pitch);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(noteGain);

      if (useVibrato) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = 5.2;
        lfoGain.gain.setValueAtTime(0, startTime);
        lfoGain.gain.linearRampToValueAtTime(3, startTime + Math.min(0.4, duration * 0.5));
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        lfo.start(startTime);
        lfo.stop(startTime + duration + 0.05);
        this.scheduledNodes.push(lfo);
      }

      noteGain.gain.setValueAtTime(0.001, startTime);
      noteGain.gain.exponentialRampToValueAtTime(totalGain * 0.12, startTime + 0.05);
      noteGain.gain.setValueAtTime(totalGain * 0.1, startTime + duration - 0.1);
      noteGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
      this.scheduledNodes.push(osc);
    }
  }

  // -------------------------------------------------------------------------
  // Animate playhead
  // -------------------------------------------------------------------------
  _animateMeasure(scoreData) {
    const { score } = scoreData;
    const lastMeasure = this._lastPlayMeasure;
    const tick = () => {
      if (!this.playing) return;

      const elapsed = this.audioCtx.currentTime - this.startTime;
      if (elapsed >= this._totalDuration + SCHEDULE_AHEAD) {
        this.stop();
        if (this.onMeasureChange) this.onMeasureChange(this.startMeasure);
        return;
      }

      let currentMeasure = this.startMeasure;
      for (let m = this.startMeasure; m <= lastMeasure; m++) {
        const mStart = this._measureStartTimes[m] || 0;
        if (elapsed >= mStart) currentMeasure = m;
        else break;
      }

      if (this.onMeasureChange) this.onMeasureChange(currentMeasure);

      const mSig = getEffectiveSignature(currentMeasure, scoreData);
      const [mBeats] = mSig.time.split('/').map(Number);
      const mSecPerBeat = this._measureSecPerBeat[currentMeasure] || 60 / score.tempo;
      const secPerMeasure = mBeats * mSecPerBeat;
      const measureStartTime = this._measureStartTimes[currentMeasure] || 0;
      const elapsedInMeasure = elapsed - measureStartTime;
      const beatFraction = elapsedInMeasure / secPerMeasure;

      if (this.onPlaybackTick) {
        this.onPlaybackTick({ measure: currentMeasure, beatFraction, stopped: false });
      }

      this._animFrame = requestAnimationFrame(tick);
    };

    this._animFrame = requestAnimationFrame(tick);
  }
}
