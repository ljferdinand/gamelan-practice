// tone_prep.mjs
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
// Prepare per-voice sample material for tuned-percussion playback.
// No dependencies. Runs in Node and in the browser (Web Audio supplies samples
// via decodeAudioData -> AudioBuffer.getChannelData(0)).
//
// Two entry paths, matching how a user actually records:
//   splitTones()   one file containing every voice struck in turn -> clips
//   prepareTone()  one clip -> trimmed, faded, measured, scored
//   prepareSet()   the whole job: clips in, ranked and level-matched set out
//
// WHY THIS EXISTS SEPARATELY FROM THE ANALYSIS ENGINE
// Transcription only needs a fundamental. Playback needs the sample to SOUND
// like the bar. Those are different problems: a clip sliced onset-to-onset on a
// gamelan carries the previous bar's ring, so a sample that measures perfectly
// can still play a ghost of another bar under every strike. Contamination
// scoring, not pitch accuracy, is the quality metric that matters here.
//
// FUNDAMENTAL ESTIMATION — deliberately not "loudest peak"
// A struck bar rings at inharmonic flexural ratios near 1 : 2.756 : 5.404 :
// 8.933. On a real instrument a partial can beat the fundamental for loudness
// (measured 2026-08-06: a bar whose fundamental sat at relative 0.99 while its
// ~5.33x mode hit 1.00, so a loudest-peak estimator returned 1260.8 Hz for a
// 236.4 Hz bar). findFundamental() therefore takes the loudest peak as a
// starting point and checks whether a comparably strong peak sits at a
// sub-multiple corresponding to a flexural mode; if so it prefers the lower.
// Both values are reported so a disagreement is visible rather than silent.

const FLEX_RATIOS = [2.756, 5.404, 8.933];   // ideal free-bar flexural modes
const HARM_RATIOS = [2, 3, 4, 5];            // in case a voice is near-harmonic

// ----------------------------------------------------------------- utils ----
function hann(N) {
  const w = new Float64Array(N);
  if (N === 1) { w[0] = 1; return w; }
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  return w;
}

// All spectral measurement happens on a bounded window taken just after the
// attack: long enough to resolve the fundamental, short enough to stay cheap in
// a browser. The first few ms are skipped because the attack transient is
// broadband and drags the peak picker around.
const ANALYSIS_SKIP_MS = 20;
const ANALYSIS_SEC = 0.5;

function analysisWindow(x, sr, skipMs = ANALYSIS_SKIP_MS, durSec = ANALYSIS_SEC) {
  const a = Math.min(x.length, Math.round(skipMs * sr / 1000));
  const n = Math.min(x.length - a, Math.round(durSec * sr));
  return n > 0 ? x.subarray(a, a + n) : x;
}

// in-place iterative radix-2 Cooley-Tukey; lengths must be a power of two
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t;
                 t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Goertzel: exact magnitude at one arbitrary frequency, no bin-alignment error.
// Used for the handful of frequencies we specifically care about (the known bar
// fundamentals), where it beats interpolating an FFT bin.
export function goertzel(x, sr, freq, windowed = true) {
  const N = x.length;
  if (N < 8) return 0;
  const w = windowed ? hann(N) : null;
  const coeff = 2 * Math.cos(2 * Math.PI * freq / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const v = w ? x[i] * w[i] : x[i];
    const s = v + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) * 2 / N;
}

// Peak list from one zero-padded FFT, refined by parabolic interpolation on the
// log magnitudes. One transform per clip instead of hundreds of probes.
function peakList(x, sr, fLo, fHi) {
  const seg = x;
  let N = 1;
  while (N < seg.length * 4) N <<= 1;
  if (N < 4096) N = 4096;
  const w = hann(seg.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < seg.length; i++) re[i] = seg[i] * w[i];
  fft(re, im);
  const half = (N >> 1) + 1, binHz = sr / N;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  const lo = Math.max(1, Math.ceil(fLo / binHz));
  const hi = Math.min(half - 2, Math.floor(fHi / binHz));
  const peaks = [];
  for (let i = lo; i <= hi; i++) {
    if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) {
      const al = Math.log(mag[i - 1] + 1e-12), a0 = Math.log(mag[i] + 1e-12),
            ar = Math.log(mag[i + 1] + 1e-12);
      const den = al - 2 * a0 + ar;
      const d = den !== 0 ? 0.5 * (al - ar) / den : 0;
      peaks.push({ f: (i + d) * binHz, mag: mag[i] });
    }
  }
  peaks.sort((p, q) => q.mag - p.mag);
  return peaks.slice(0, 40);
}

/**
 * Robust fundamental for a struck bar.
 * Returns { f0, naive, corrected, peaks } — naive is the loudest peak,
 * f0 is the chosen value, corrected is true when they differ.
 */
export function findFundamental(x, sr, { fLo = 60, fHi = 5000, subRel = 0.25 } = {}) {
  const seg = analysisWindow(x, sr);
  const peaks = peakList(seg, sr, fLo, fHi);
  if (!peaks.length) return { f0: null, naive: null, corrected: false, peaks: [] };
  const top = peaks[0];
  let best = top.f;
  // If the loudest peak is really the Nth flexural mode, the fundamental sits
  // at f / ratio. Prefer the lower peak when one is comparably strong there.
  for (const r of [...FLEX_RATIOS, ...HARM_RATIOS]) {
    const target = top.f / r;
    if (target < fLo) continue;
    const cand = peaks.find(p => Math.abs(1200 * Math.log2(p.f / target)) < 60);
    if (cand && cand.mag >= subRel * top.mag && cand.f < best) best = cand.f;
  }
  return {
    f0: best,
    naive: top.f,
    corrected: Math.abs(1200 * Math.log2(best / top.f)) > 30,
    peaks: peaks.slice(0, 8).map(p => ({ f: +p.f.toFixed(2), rel: +(p.mag / top.mag).toFixed(3) })),
  };
}

/**
 * How much of OTHER voices is audible in this clip.
 * Frequencies coinciding with this tone's own partials are excluded, or the
 * tone's own overtones would be scored as contamination.
 * Returns { worstDb, worstHz, detail } — dB relative to this tone's fundamental.
 */
export function contamination(x, sr, f0, allF0s, { excludeCents = 60 } = {}) {
  const seg = analysisWindow(x, sr);
  const own = goertzel(seg, sr, f0);
  if (!(own > 0)) return { worstDb: 0, worstHz: null, detail: [] };
  const mine = [f0, ...FLEX_RATIOS.map(r => f0 * r), ...HARM_RATIOS.map(r => f0 * r)];
  const detail = [];
  for (const g of allF0s) {
    if (Math.abs(1200 * Math.log2(g / f0)) < excludeCents) continue;                 // itself
    if (mine.some(p => Math.abs(1200 * Math.log2(g / p)) < excludeCents)) continue;  // own partial
    detail.push({ hz: +g.toFixed(1), db: +(20 * Math.log10(goertzel(seg, sr, g) / own)).toFixed(1) });
  }
  detail.sort((a, b) => b.db - a.db);
  return {
    worstDb: detail.length ? detail[0].db : -Infinity,
    worstHz: detail.length ? detail[0].hz : null,
    detail,
  };
}

// ------------------------------------------------------- envelope helpers ----
function envelope(x, sr, winMs = 8) {
  const w = Math.max(16, Math.round(sr * winMs / 1000));
  const n = Math.floor(x.length / w);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < w; k++) { const v = x[i * w + k]; s += v * v; }
    e[i] = Math.sqrt(s / w);
  }
  return { e, hop: w };
}

/**
 * Split one recording containing several struck voices into candidate clips.
 * onsets: optional pre-computed onset times (e.g. from the analysis engine);
 * if absent, a simple energy-rise detector is used so this module stays
 * self-contained.
 */
export function splitTones(x, sr, { onsets = null, minGap = 0.40, riseDb = 9 } = {}) {
  let ts = onsets;
  if (!ts) {
    const { e, hop } = envelope(x, sr);
    const peak = Math.max(...e);
    const floorv = peak * Math.pow(10, -50 / 20);
    ts = [];
    const gapFrames = Math.round(minGap * sr / hop);
    let last = -1e9;
    for (let i = 2; i < e.length - 1; i++) {
      if (e[i] < floorv) continue;
      const prev = Math.max(e[i - 1], e[i - 2]) + 1e-12;
      const rise = 20 * Math.log10(e[i] / prev);
      if (rise > riseDb && e[i] >= e[i + 1] * 0.5 && i - last >= gapFrames) {
        ts.push(i * hop / sr); last = i;
      }
    }
  }
  return ts.map((t0, i) => ({
    t0,
    t1: i + 1 < ts.length ? ts[i + 1] : x.length / sr,
    samples: null,
  }));
}

/**
 * Is this clip really ONE struck voice?
 *
 * Scores the strongest spectral peak that cannot be explained as a partial (or
 * sub-multiple) of f0. This does NOT need a known voice list, which is the
 * point: a clip can contain a second bar that was never itself measured, so
 * checking only against already-measured voices misses it. Measured 2026-08-06:
 * a clip of a struck 358.9 Hz bar read as 310.9 Hz because a previously struck
 * bar was still ringing louder — the contamination check against known voices
 * was blind to it, this one is not.
 *
 * Returns { db, hz } — dB of the strongest unexplained peak relative to f0.
 * Around -6 dB or higher means two voices are competing and the clip is not
 * usable as a single-tone sample.
 */
export function independentContent(x, sr, f0, { fLo = 60, fHi = 5000, tolCents = 70 } = {}) {
  const seg = analysisWindow(x, sr);
  const peaks = peakList(seg, sr, fLo, fHi);
  if (!peaks.length) return { db: -Infinity, hz: null };
  const own = goertzel(seg, sr, f0);
  if (!(own > 0)) return { db: -Infinity, hz: null };
  // everything f0 can legitimately produce, plus everything that could produce f0
  const explained = [f0];
  for (const r of [...FLEX_RATIOS, ...HARM_RATIOS]) { explained.push(f0 * r); explained.push(f0 / r); }
  let worst = { db: -Infinity, hz: null };
  for (const p of peaks) {
    if (explained.some(e => Math.abs(1200 * Math.log2(p.f / e)) < tolCents)) continue;
    const db = 20 * Math.log10(goertzel(seg, sr, p.f) / own);
    if (db > worst.db) worst = { db: +db.toFixed(1), hz: +p.f.toFixed(1) };
  }
  return worst;
}

/**
 * Trim, declick and fade one tone clip.
 *
 * Keeps as much ring as the material allows, because the ring is the sound —
 * but stops at whichever comes first: an intruding strike, decay below
 * tailDb relative to peak, or maxDur.
 */
export function prepareTone(x, sr, {
  leadMs = 8, fadeInMs = 1.5, fadeOutMs = 120,
  tailDb = -45, maxDur = 4.0, guardMs = 30, intrudeDb = 6,
} = {}) {
  const warnings = [];
  const { e, hop } = envelope(x, sr);
  if (!e.length) return { samples: new Float32Array(0), warnings: ['clip too short'] };

  // attack = first frame within 12 dB of the clip's peak, walked back to the
  // last frame that was still quiet
  let peakIdx = 0, peak = 0;
  for (let i = 0; i < e.length; i++) if (e[i] > peak) { peak = e[i]; peakIdx = i; }
  const attackThresh = peak * Math.pow(10, -12 / 20);
  let aFrame = 0;
  for (let i = 0; i <= peakIdx; i++) if (e[i] >= attackThresh) { aFrame = i; break; }
  while (aFrame > 0 && e[aFrame - 1] > peak * Math.pow(10, -40 / 20)) aFrame--;

  // intruding strike: a later frame that rises sharply again
  let intrudeFrame = -1;
  for (let i = peakIdx + Math.round(0.15 * sr / hop); i < e.length - 1; i++) {
    const prev = Math.max(e[i - 1], e[i - 2] ?? 0) + 1e-12;
    if (20 * Math.log10(e[i] / prev) > intrudeDb && e[i] > peak * Math.pow(10, -30 / 20)) {
      intrudeFrame = i; break;
    }
  }

  // tail: decay below tailDb of peak
  const tailThresh = peak * Math.pow(10, tailDb / 20);
  let tailFrame = e.length;
  for (let i = peakIdx; i < e.length; i++) if (e[i] < tailThresh) { tailFrame = i; break; }

  let endFrame = Math.min(tailFrame, e.length);
  if (intrudeFrame > 0) {
    const guarded = intrudeFrame - Math.round(guardMs * sr / 1000 / hop);
    if (guarded > aFrame + 2) {
      if (guarded < endFrame) warnings.push(
        `truncated at ${(guarded * hop / sr).toFixed(2)}s: another strike intrudes`);
      endFrame = Math.min(endFrame, guarded);
    }
  }

  let start = Math.max(0, aFrame * hop - Math.round(leadMs * sr / 1000));
  let end = Math.min(x.length, endFrame * hop);
  const maxLen = Math.round(maxDur * sr);
  if (end - start > maxLen) { end = start + maxLen; warnings.push(`capped at ${maxDur}s`); }
  if (end - start < Math.round(0.05 * sr)) return {
    samples: new Float32Array(0), warnings: [...warnings, 'usable region under 50 ms'],
    start: start / sr, end: end / sr, peak,
  };

  const out = new Float32Array(end - start);
  out.set(x.subarray(start, end));

  // declick the head without erasing the attack transient
  const fi = Math.min(out.length >> 1, Math.round(fadeInMs * sr / 1000));
  for (let i = 0; i < fi; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
  // raised-cosine tail so the cut ring does not click
  const fo = Math.min(out.length - fi, Math.round(fadeOutMs * sr / 1000));
  for (let i = 0; i < fo; i++) {
    const k = out.length - fo + i;
    out[k] *= 0.5 + 0.5 * Math.cos(Math.PI * i / fo);
  }

  let p = 0, s = 0;
  const rmsWin = Math.min(out.length, Math.round(0.30 * sr));
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > p) p = a; }
  for (let i = 0; i < rmsWin; i++) s += out[i] * out[i];
  return {
    samples: out, warnings,
    start: start / sr, end: end / sr,
    duration: out.length / sr,
    peak: p, rms: Math.sqrt(s / rmsWin),
  };
}

/**
 * Score takes of the same voice and pick the cleanest.
 * Contamination dominates: a quieter but clean take beats a loud dirty one,
 * because the dirt is audible under every note the sample ever plays.
 */
export function chooseBestTake(takes) {
  let bestI = 0, bestScore = -Infinity;
  takes.forEach((t, i) => {
    const contam = Number.isFinite(t.contamDb) ? t.contamDb : -80;
    const score = -contam * 1.0 + Math.min(t.duration ?? 0, 2.5) * 2 + (t.peak ?? 0) * 4;
    if (score > bestScore) { bestScore = score; bestI = i; }
  });
  return bestI;
}

/**
 * Match perceived level across a set. RMS over the first 300 ms after the
 * attack is the target, because that is the part the ear weights; a peak
 * ceiling then prevents clipping. Raw recordings routinely span 10+ dB of
 * level that is recording artifact rather than musical intent.
 */
export function levelMatch(tones, { targetRms = 0.12, ceiling = 0.89 } = {}) {
  return tones.map(t => {
    if (!t.samples || !t.samples.length || !(t.rms > 0)) return { ...t, gain: 1 };
    let g = targetRms / t.rms;
    if (t.peak * g > ceiling) g = ceiling / t.peak;
    const out = new Float32Array(t.samples.length);
    for (let i = 0; i < out.length; i++) out[i] = t.samples[i] * g;
    return { ...t, samples: out, gain: g,
             peak: t.peak * g, rms: t.rms * g,
             gainDb: +(20 * Math.log10(g)).toFixed(2) };
  });
}

/** 16-bit PCM WAV. Returns Uint8Array. */
export function encodeWav(samples, sr, bitDepth = 16) {
  const bytes = bitDepth === 16 ? 2 : 4;
  const buf = new ArrayBuffer(44 + samples.length * bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 16 ? 1 : 3, true);   // 1 = PCM, 3 = float
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * bytes, true); v.setUint16(32, bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, samples.length * bytes, true);
  let o = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < samples.length; i++, o += 2) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  } else {
    for (let i = 0; i < samples.length; i++, o += 4) v.setFloat32(o, samples[i], true);
  }
  return new Uint8Array(buf);
}

/**
 * Whole job. clips: [{label?, samples}] already separated per strike.
 * Measures each, folds repeat strikes of the same bar, keeps the cleanest take,
 * level-matches, and reports everything the user needs to judge the result.
 */
export function prepareSet(clips, sr, opts = {}) {
  const { mergeCents = 25, fLo = 60, fHi = 5000, polyRejectDb = -6 } = opts;

  // pass 1: trim + measure, so the voice set is known before scoring dirt
  let takes = clips.map((c, i) => {
    const prep = prepareTone(c.samples, sr, opts);
    const fund = prep.samples.length
      ? findFundamental(prep.samples, sr, { fLo, fHi })
      : { f0: null, naive: null, corrected: false, peaks: [] };
    return { index: i, label: c.label ?? String(i + 1), ...prep, ...fund };
  }).filter(t => t.f0);

  // pass 2: is each clip a single voice at all? This check needs no voice list,
  // so it catches a second bar that was never measured in its own right.
  takes = takes.map(t => {
    const ind = independentContent(t.samples, sr, t.f0, { fLo, fHi });
    const suspect = ind.db >= polyRejectDb;
    return { ...t, polyDb: ind.db, polyHz: ind.hz, suspect,
      warnings: suspect
        ? [...t.warnings, `NOT A SINGLE VOICE: ${ind.hz} Hz sits at ${ind.db > 0 ? '+' : ''}${ind.db} dB ` +
            `relative to the ${t.f0.toFixed(1)} Hz reading and is not one of its partials — ` +
            `the measured pitch may be the wrong bar`]
        : t.warnings };
  });

  // pass 3: contamination against the deduplicated measured voice set
  const voices = [];
  for (const f of takes.map(t => t.f0).sort((a, b) => a - b)) {
    if (!voices.length || Math.abs(1200 * Math.log2(f / voices[voices.length - 1])) > mergeCents)
      voices.push(f);
  }
  takes = takes.map(t => {
    const c = contamination(t.samples, sr, t.f0, voices);
    return { ...t, contamDb: c.worstDb, contamHz: c.worstHz, contamDetail: c.detail };
  });

  // pass 4: group takes of the same bar, keep the cleanest
  takes.sort((a, b) => a.f0 - b.f0);
  const groups = [];
  for (const t of takes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(1200 * Math.log2(t.f0 / g[0].f0)) <= mergeCents) g.push(t);
    else groups.push([t]);
  }
  const chosen = groups.map(g => {
    const pick = g[chooseBestTake(g)];
    const extra = [];
    // A group whose members disagree about being single-voiced is a warning in
    // itself: two clips measuring the same pitch where one is polyphonic often
    // means they are actually different bars.
    if (g.length > 1 && g.some(t => t.suspect) && !g.every(t => t.suspect))
      extra.push(`${g.filter(t => t.suspect).length} of ${g.length} takes at this pitch are ` +
                 `polyphonic — these may not all be the same bar`);
    return { ...pick, takeCount: g.length,
             warnings: [...pick.warnings, ...extra],
             alternates: g.filter(t => t !== pick).map(t => ({
               index: t.index, label: t.label, contamDb: t.contamDb,
               polyDb: t.polyDb, duration: t.duration })) };
  });

  return {
    tones: levelMatch(chosen, opts),
    groups: groups.length,
    rawTakes: takes.length,
    suspect: chosen.filter(t => t.suspect).length,
  };
}
