// score_format.mjs
//
// Copyright (C) 2026 Luke Ferdinand
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. This program is distributed WITHOUT ANY WARRANTY; without even
// the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU Affero General Public License <https://www.gnu.org/licenses/> for
// more details.  Source: https://github.com/ljferdinand/gamelan-practice
//
// Plain-text score format for gamelan tuned percussion — parser + serializer.
// No dependencies. Runs in Node and in the browser.
//
// DESIGN, and why each choice is what it is (all validated against Arangarang):
//
//  * NO TIMECODE. Position is duration. Measured: 77% of note gaps are exactly
//    one beat, 19% are half-beat subdivisions, the rest are multi-beat rests.
//    A beat grid plus a tempo carries everything.
//
//  * ONE TOKEN = ONE BEAT. Notes inside a beat are joined with '-' and divide
//    the beat evenly. This keeps exactly four tokens per gatra, so gatra
//    integrity is checkable by counting, and it makes an overfull beat a
//    parse-time error rather than a silent timing bug.
//
//  * REGISTER IS SEMANTIC, NOT DOTS. '_' = one octave down, '^' = one octave
//    up, stackable, bare = middle. The renderer applies dots per the Javanese
//    or Sundanese convention. Writing "dot above" in the file would mean
//    opposite things in the two traditions. Register is an independent axis
//    from degree because the same phrase recurs an octave up (measured:
//    B[1:] === A[:15] in Arangarang).
//
//  * REPEATS AND TRANSPOSITION. Sections repeat with 'xN', and a section can be
//    declared as another section transposed ('= A oct+1'), because that is
//    literally how the piece is built.
//
// GRAMMAR
//   # comment                     -- to end of line, anywhere
//   key: value                    -- header, before the first section
//   [Name]                        -- begin section
//   [Name] xN                     -- begin section, played N times
//   [Name] = Other oct+1          -- section is Other, transposed +1 octave
//   [Name] = Other oct-1 xN       -- ...and played N times
//   tok tok | tok tok  ...        -- body; '|' is a gatra separator (advisory)
//
// TOKENS
//   3         a note: degree 3, middle register
//   _3  ^3    one octave down / up.  __3 / ^^3 stack.
//   3-3       two notes sharing one beat (even subdivision)
//   1-2-3-5   four notes sharing one beat
//   .         a rest: one beat with no new strike. The bar keeps ringing;
//             this is silence-of-attack, not damping.
//   *         damp: actively stop the sound for this beat. Present in the
//             grammar because it is a real gamelan action and is NOT the same
//             event as a rest. Unused in Arangarang.
//
// HEADER KEYS
//   name         free text
//   instrument   profile id, for validating that every register exists
//   bpm          base beats per minute        (bpm or beat, one of the two)
//   beat         seconds per beat
//   style        'jv' | 'sd' — dot convention, DISPLAY ONLY, no semantic effect

const RE_HEADER  = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const RE_SECTION = /^\[\s*([^\]]+?)\s*\]\s*(.*)$/;
const RE_NOTE    = /^([_^]*)([0-9A-Za-z]+)$/;

export class ScoreError extends Error {
  constructor(msg, line) {
    super(line != null ? `line ${line}: ${msg}` : msg);
    this.name = 'ScoreError';
    this.line = line;
  }
}

function parseToken(raw, lineNo) {
  if (raw === '.') return { kind: 'rest' };
  if (raw === '*') return { kind: 'damp' };
  const parts = raw.split('-');
  const notes = [];
  for (const p of parts) {
    if (p === '') throw new ScoreError(`empty subdivision slot in "${raw}"`, lineNo);
    if (p === '.' || p === '*') {
      notes.push({ kind: p === '.' ? 'rest' : 'damp' });
      continue;
    }
    const m = RE_NOTE.exec(p);
    if (!m) throw new ScoreError(`cannot read note "${p}" in token "${raw}"`, lineNo);
    const marks = m[1];
    let reg = 0;
    for (const ch of marks) reg += ch === '^' ? 1 : -1;
    notes.push({ kind: 'note', degree: m[2], reg });
  }
  return { kind: 'beat', notes };
}

export function parseScore(text) {
  const header = {};
  const sections = [];       // {name, times, from, octShift, beats:[token...], gatra:[counts]}
  let cur = null;
  let sawSection = false;
  const warnings = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;

    const ms = RE_SECTION.exec(line);
    if (ms) {
      sawSection = true;
      const name = ms[1].trim();
      const rest = ms[2].trim();
      let times = 1, from = null, octShift = 0;
      if (rest) {
        const eq = /^=\s*([^\s]+)\s*(.*)$/.exec(rest);
        let tail = rest;
        if (eq) { from = eq[1]; tail = eq[2].trim(); }
        for (const tk of tail.split(/\s+/).filter(Boolean)) {
          const mx = /^x(\d+)$/i.exec(tk);
          const mo = /^oct([+-]\d+)$/i.exec(tk);
          if (mx) times = parseInt(mx[1], 10);
          else if (mo) octShift = parseInt(mo[1], 10);
          else throw new ScoreError(`unknown section modifier "${tk}"`, lineNo);
        }
      }
      if (times < 1) throw new ScoreError(`repeat count must be >= 1`, lineNo);
      cur = { name, times, from, octShift, beats: [], gatra: [], line: lineNo };
      sections.push(cur);
      continue;
    }

    const mh = RE_HEADER.exec(line);
    if (mh && !sawSection) { header[mh[1].toLowerCase()] = mh[2].trim(); continue; }

    if (!cur) {
      cur = { name: '', times: 1, from: null, octShift: 0, beats: [], gatra: [], line: lineNo };
      sections.push(cur);
    }
    if (cur.from) throw new ScoreError(
      `section "${cur.name}" is defined as a copy of "${cur.from}" and cannot also have a body`, lineNo);

    let run = 0;
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      if (raw === '|') { cur.gatra.push(run); run = 0; continue; }
      cur.beats.push(parseToken(raw, lineNo));
      run++;
    }
    if (run) cur.gatra.push(run);
  }

  // beat/bpm
  let beatSec = null;
  if (header.beat) beatSec = parseFloat(header.beat);
  else if (header.bpm) beatSec = 60 / parseFloat(header.bpm);
  if (!beatSec || !(beatSec > 0)) throw new ScoreError('header needs a valid bpm or beat');

  // Gatra advisory check. A trailing partial gatra is normal (a piece can end
  // mid-gatra), so only interior groups are checked — otherwise nearly every
  // real score warns, which trains the user to ignore warnings.
  for (const s of sections) {
    const interior = s.gatra.slice(0, -1);
    const bad = interior.map((g, i) => [i, g]).filter(([, g]) => g !== 4);
    if (interior.length && bad.length) {
      warnings.push(`section "${s.name || '(unnamed)'}" (line ${s.line}): ` +
        `gatra group(s) not 4 beats at position(s) ` +
        bad.map(([i, g]) => `${i + 1}(=${g})`).join(', '));
    }
  }

  // resolve '= Other' references
  const byName = new Map(sections.filter(s => s.name).map(s => [s.name, s]));
  for (const s of sections) {
    if (!s.from) continue;
    const src = byName.get(s.from);
    if (!src) throw new ScoreError(`section "${s.name}" references unknown section "${s.from}"`, s.line);
    if (src.from) throw new ScoreError(`section "${s.name}" references "${s.from}", which is itself a reference`, s.line);
    s.beats = src.beats;
    s.gatra = src.gatra;
  }

  return { header, sections, beatSec, style: (header.style || 'jv').toLowerCase(), warnings };
}

// Expand to a flat event list. Times in seconds from the first beat.
export function toEvents(score) {
  const { sections, beatSec } = score;
  const events = [];
  let beat = 0;
  for (const s of sections) {
    for (let rep = 0; rep < s.times; rep++) {
      for (const tk of s.beats) {
        if (tk.kind === 'rest') { beat++; continue; }
        if (tk.kind === 'damp') { events.push({ t: beat * beatSec, beat, kind: 'damp' }); beat++; continue; }
        const n = tk.notes.length;
        tk.notes.forEach((nt, k) => {
          const sub = beat + k / n;
          if (nt.kind === 'note') {
            events.push({ t: sub * beatSec, beat: sub, kind: 'note',
                          degree: nt.degree, reg: nt.reg + s.octShift,
                          section: s.name, rep });
          } else if (nt.kind === 'damp') {
            events.push({ t: sub * beatSec, beat: sub, kind: 'damp', section: s.name, rep });
          }
        });
        beat++;
      }
    }
  }
  return { events, totalBeats: beat, duration: beat * beatSec };
}

// Serialize an event list back to score text (flat, no sections/repeats).
export function serializeFlat(events, { name, instrument, bpm, style } = {}) {
  const out = [];
  if (name) out.push(`name: ${name}`);
  if (instrument) out.push(`instrument: ${instrument}`);
  if (bpm) out.push(`bpm: ${bpm}`);
  if (style) out.push(`style: ${style}`);
  out.push('');
  const byBeat = new Map();
  let maxBeat = -1;
  for (const e of events) {
    const b = Math.floor(e.beat + 1e-9);
    if (!byBeat.has(b)) byBeat.set(b, []);
    byBeat.get(b).push(e);
    if (b > maxBeat) maxBeat = b;
  }
  const mark = (r) => r === 0 ? '' : (r > 0 ? '^'.repeat(r) : '_'.repeat(-r));
  const toks = [];
  for (let b = 0; b <= maxBeat; b++) {
    const g = (byBeat.get(b) || []).sort((p, q) => p.beat - q.beat);
    if (!g.length) { toks.push('.'); continue; }
    toks.push(g.map(e => e.kind === 'damp' ? '*' : `${mark(e.reg)}${e.degree}`).join('-'));
  }
  const lines = [];
  for (let i = 0; i < toks.length; i += 16) {
    const row = toks.slice(i, i + 16);
    const gats = [];
    for (let k = 0; k < row.length; k += 4) gats.push(row.slice(k, k + 4).join(' '));
    lines.push('  ' + gats.join(' | '));
  }
  return out.concat(lines).join('\n') + '\n';
}

// Map score events onto a measured instrument profile.
// voices: [{label, f0, reg}] as produced by the calibration flow.
export function bindToInstrument(events, voices) {
  const key = (d, r) => `${d}@${r}`;
  const table = new Map();
  for (const v of voices) table.set(key(String(v.label), v.reg | 0), v);
  const bound = [], missing = new Map();
  for (const e of events) {
    if (e.kind !== 'note') { bound.push({ ...e, voice: null }); continue; }
    const v = table.get(key(e.degree, e.reg));
    if (!v) {
      const k = key(e.degree, e.reg);
      missing.set(k, (missing.get(k) || 0) + 1);
      bound.push({ ...e, voice: null, unplayable: true });
    } else {
      bound.push({ ...e, voice: v });
    }
  }
  return { bound, missing: [...missing.entries()].map(([k, n]) => ({ token: k, count: n })) };
}
