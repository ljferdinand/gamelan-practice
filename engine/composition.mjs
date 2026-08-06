// composition.mjs
//
// Copyright (C) 2026 Luke Ferdinand
// Licensed under the GNU Affero General Public License v3 or later.
// Source: https://github.com/ljferdinand/gamelan-practice
//
// Plays a written score through sampled voices, and unifies score rendering so
// that transcriptions and compositions go through ONE code path.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: the conflict it resolves
//
// The play view's buildScore() opens a new gatra every four NOTES:
//     if (i % 4 === 0) { new gatra }        // i indexes notes
// For a transcription that is correct, because a transcription has exactly one
// note per onset and no rests, so notes and beats coincide. A composition
// breaks that: a beat can be empty (a rest) or hold two notes (a subdivision).
// Measured on the Arangarang score — 122 notes across 125 beats, with 15 rests
// and 12 subdivided beats — the two groupings diverge at the FIRST gatra and
// never re-align (31 gatra by note vs 32 by beat). stepGatra() has the same
// bug: it does Math.floor(here/4)*4 on note indices.
//
// The fix is not a second renderer. It is to give a transcription a beat index
// too — beat = note index — so `beat % 4` reproduces the old `i % 4` exactly for
// transcriptions while being correct for compositions. One renderer, no fork.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY REUSES rather than reimplementing
//
// Nothing here draws a note, assigns a register, or decodes audio. The play
// view already has noteHtml() / dotsHtml() / dotAbove() / regWord() for dot
// rendering with the Javanese/Sundanese toggle, assignRegisters() /
// numberSet() / octOffset() for the register model, decodeFile() for audio, and
// buildBars() / paint() / flashBar() / scrollTo() / activeIndex() for
// follow-along. This module produces data shaped to feed those unchanged:
//   * cells[]    -> what to draw, already grouped into gatra by BEAT
//   * times[]    -> feeds the existing activeIndex() with no change
//   * noteEls[]  -> indexed by EVENT, so paint() needs no change
//   * voiceIndex -> carried on each event, so flashBar() needs no change
//
// CompositionTransport intentionally mirrors the slice of HTMLAudioElement the
// play view already consumes (currentTime, duration, paused, play, pause,
// playbackRate), so the transport can be swapped without rewriting tick(),
// the seek bar, or the speed slider.

/* ----------------------------------------------------------------- layout ---- */

/**
 * Give transcription output the same shape as score events, so both render
 * through one path. A transcription is "one note per beat, no rests", so
 * beat === note index and `beat % 4` grouping matches the existing behaviour
 * byte for byte.
 *
 * notes:  [{t, f0, snap:{index, flag}}] as produced by transcribe()
 * voices: the instrument's voices, low -> high, each {label, reg}
 */
export function eventsFromTranscription(notes, voices) {
  return notes.map((n, i) => {
    const known = n.snap && n.snap.flag !== '?';
    const v = known ? voices[n.snap.index] : null;
    return {
      beat: i,                 // one note per beat: reproduces i % 4 grouping
      t: n.t,                  // real onset time from the recording
      kind: 'note',
      degree: v ? String(v.label) : '\u00b7',
      reg: v ? (v.reg || 0) : 0,
      voiceIndex: known ? n.snap.index : null,
      unplayable: !known,      // renders with the existing .q class
    };
  });
}

/**
 * Score events -> the same shape, with each event bound to a voice on the
 * instrument. Events whose degree+register has no bar are marked unplayable and
 * carry voiceIndex null, which the existing .q styling already covers.
 *
 * events: from score_format.toEvents()
 * voices: instrument voices low -> high, each {label, reg}
 */
export function bindEvents(events, voices) {
  const table = new Map();
  voices.forEach((v, i) => table.set(`${v.label}@${v.reg | 0}`, i));
  const missing = new Map();
  const bound = events.map(e => {
    if (e.kind !== 'note') return { ...e, voiceIndex: null };
    const key = `${e.degree}@${e.reg | 0}`;
    const vi = table.get(key);
    if (vi === undefined) {
      missing.set(key, (missing.get(key) || 0) + 1);
      return { ...e, voiceIndex: null, unplayable: true };
    }
    return { ...e, voiceIndex: vi };
  });
  return { events: bound, missing: [...missing.entries()].map(([k, n]) => ({ token: k, count: n })) };
}

/**
 * Group events into beat cells for rendering. A cell is ONE BEAT and holds zero
 * notes (a rest), one note, or several (a subdivision). Gatra is by beat.
 *
 * Returns [{ beat, gatra, notes:[{event, eventIndex}] }] covering every beat
 * from 0 to totalBeats-1, so rests occupy real cells and the grid reads true.
 */
export function layoutBeats(events, totalBeats, beatsPerGatra = 4) {
  const n = totalBeats != null
    ? totalBeats
    : (events.length ? Math.floor(Math.max(...events.map(e => e.beat))) + 1 : 0);
  const cells = [];
  for (let b = 0; b < n; b++) cells.push({ beat: b, gatra: Math.floor(b / beatsPerGatra), notes: [] });
  events.forEach((e, i) => {
    const b = Math.floor(e.beat + 1e-9);
    if (b >= 0 && b < cells.length) cells[b].notes.push({ event: e, eventIndex: i });
  });
  cells.forEach(c => c.notes.sort((p, q) => p.event.beat - q.event.beat));
  return cells;
}

/**
 * Beat-aware gatra stepping, replacing the note-index arithmetic in stepGatra().
 * Returns the event index to seek to, or null when there is nothing to move to.
 */
export function gatraStepTarget(events, currentEventIndex, dir, beatsPerGatra = 4) {
  if (!events.length) return null;
  const here = currentEventIndex >= 0 ? events[currentEventIndex].beat : -1;
  const g = Math.floor(Math.max(0, here) / beatsPerGatra);
  const targetBeat = (here < 0 && dir < 0) ? 0 : (g + dir) * beatsPerGatra;
  if (targetBeat < 0) return 0;
  // first event at or after the target beat; clamp to the last event
  for (let i = 0; i < events.length; i++) if (events[i].beat >= targetBeat - 1e-9) return i;
  return events.length - 1;
}

/* -------------------------------------------------------------- transport ---- */

/**
 * Plays score events by scheduling sampled voices against an AudioContext.
 *
 * Mirrors the part of HTMLAudioElement the play view already uses so the two
 * are interchangeable: currentTime, duration, paused, play(), pause(),
 * playbackRate. Time is reported in SCORE seconds at 1x, so the seek bar and
 * the clock readout need no adjustment for speed.
 *
 * buffers: Array indexed to match voices — buffers[voiceIndex] is an AudioBuffer,
 *          or null when that voice has no sample.
 */
export class CompositionTransport {
  constructor(ctx, { events, totalBeats, beatSec, buffers, gain = 1 }) {
    this.ctx = ctx;
    this.events = events.filter(e => e.kind === 'note' && e.voiceIndex != null);
    this.allEvents = events;
    this.beatSec = beatSec;
    this.buffers = buffers;
    this._duration = (totalBeats != null ? totalBeats : 0) * beatSec;
    this._rate = 1;
    this._pos = 0;          // score seconds, valid when paused
    this._anchor = 0;       // ctx.currentTime at the last (re)start
    this._paused = true;
    this._next = 0;         // index of the next event to schedule
    this._live = [];        // scheduled sources, so pause can stop them
    this._timer = 0;
    this.onended = null;
    this.LOOKAHEAD = 0.35;  // score seconds scheduled in advance
    this.TICK_MS = 90;
    this._out = ctx.createGain();
    this._out.gain.value = gain;
    this._out.connect(ctx.destination);
  }

  get duration() { return this._duration; }
  get paused() { return this._paused; }
  get playbackRate() { return this._rate; }

  get currentTime() {
    if (this._paused) return this._pos;
    return this._pos + (this.ctx.currentTime - this._anchor) * this._rate;
  }

  /** Changing speed mid-play reschedules from the current position: a tempo
   *  change, not a resampling. Slowing a composition must not alter pitch. */
  set playbackRate(r) {
    const rate = Math.max(0.1, Math.min(4, +r || 1));
    if (rate === this._rate) return;
    if (this._paused) { this._rate = rate; return; }
    const at = this.currentTime;
    this._stopLive();
    this._rate = rate;
    this._pos = at;
    this._anchor = this.ctx.currentTime;
    this._seekIndex(at);
  }

  play() {
    if (!this._paused) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this._pos >= this._duration) this._pos = 0;
    this._paused = false;
    this._anchor = this.ctx.currentTime;
    this._seekIndex(this._pos);
    this._pump();
    this._timer = setInterval(() => this._pump(), this.TICK_MS);
  }

  pause() {
    if (this._paused) return;
    this._pos = this.currentTime;
    this._paused = true;
    clearInterval(this._timer); this._timer = 0;
    this._stopLive();
  }

  seek(t) {
    const at = Math.max(0, Math.min(this._duration, +t || 0));
    if (this._paused) { this._pos = at; this._seekIndex(at); return; }
    this._stopLive();
    this._pos = at;
    this._anchor = this.ctx.currentTime;
    this._seekIndex(at);
    this._pump();
  }

  dispose() {
    this.pause();
    try { this._out.disconnect(); } catch (e) { /* already gone */ }
  }

  // ---- internals ----

  _seekIndex(at) {
    this._next = 0;
    while (this._next < this.events.length && this.events[this._next].t < at - 1e-9) this._next++;
  }

  _stopLive() {
    for (const s of this._live) { try { s.stop(); } catch (e) { /* already ended */ } }
    this._live = [];
  }

  /** Schedule everything due within the look-ahead, then check for the end. */
  _pump() {
    if (this._paused) return;
    const now = this.currentTime;
    const horizon = now + this.LOOKAHEAD;
    while (this._next < this.events.length && this.events[this._next].t <= horizon) {
      const e = this.events[this._next++];
      const buf = this.buffers[e.voiceIndex];
      if (!buf) continue;
      // score time -> context time, accounting for rate
      const when = this._anchor + (e.t - this._pos) / this._rate;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this._out);
      src.start(Math.max(this.ctx.currentTime, when));
      this._live.push(src);
      src.onended = () => {
        const k = this._live.indexOf(src);
        if (k >= 0) this._live.splice(k, 1);
      };
    }
    if (now >= this._duration) {
      this.pause();
      this._pos = this._duration;
      if (this.onended) this.onended();
    }
  }
}

/** Wraps an HTMLAudioElement in the same shape, so both modes share one caller. */
export class AudioFileTransport {
  constructor(audio) {
    this.audio = audio;
    this.onended = null;
    audio.addEventListener('ended', () => { if (this.onended) this.onended(); });
  }
  get duration() { return this.audio.duration || 0; }
  get paused() { return this.audio.paused; }
  get currentTime() { return this.audio.currentTime; }
  get playbackRate() { return this.audio.playbackRate; }
  set playbackRate(r) { this.audio.playbackRate = r; }
  play() { this.audio.play(); }
  pause() { this.audio.pause(); }
  seek(t) { this.audio.currentTime = t; }
  dispose() { this.audio.pause(); }
}

/* ------------------------------------------------------------- bundle load --- */

/**
 * Decode a tone bundle's base64 WAVs into AudioBuffers, indexed to match voices.
 * The bundle is an instrument profile that also carries samples, so the same
 * file supplies both the tuning and the audio.
 */
export async function buffersFromBundle(ctx, bundle, voices) {
  const byKey = new Map();
  for (const v of (bundle.voices || [])) {
    if (v.wav) byKey.set(`${v.label}@${v.reg | 0}`, v.wav);
  }
  const out = new Array(voices.length).fill(null);
  const missing = [];
  for (let i = 0; i < voices.length; i++) {
    const key = `${voices[i].label}@${voices[i].reg | 0}`;
    const b64 = byKey.get(key);
    if (!b64) { missing.push(key); continue; }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    out[i] = await ctx.decodeAudioData(bytes.buffer);
  }
  return { buffers: out, missing };
}
