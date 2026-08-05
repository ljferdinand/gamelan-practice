// gamelan_engine.mjs
// Self-calibrating tuned-percussion analysis — pure JavaScript, no dependencies.
// Runs in Node (for tests) and in the browser (Web Audio supplies the samples:
// decodeAudioData -> AudioBuffer.getChannelData(0) -> Float32Array).
//
// The engine assumes NOTHING about the scale. Every gamelan is tuned to itself,
// so the "tuning" is whatever fundamentals you measure from the instrument's own
// voices (calibrate*). Transcription then snaps strikes to that measured set.

// ------------------------------------------------------------------ FFT ----
// in-place iterative radix-2 Cooley-Tukey; re/im length must be a power of two
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr;
                 const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function hann(N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  return w;
}
// magnitude spectrum of real signal x, zero-padded to N (power of two); len N/2+1
function rfftMag(x, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const lim = Math.min(x.length, N);
  for (let i = 0; i < lim; i++) re[i] = x[i];
  fft(re, im);
  const half = (N >> 1) + 1, mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
// centered moving average, reflect edges (approx numpy uniform_filter1d default)
function movavg(a, size) {
  const n = a.length, r = (size - 1) >> 1, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (j < 0) j = -j - 1;
      if (j >= n) j = 2 * n - j - 1;
      if (j < 0) j = 0; else if (j >= n) j = n - 1;
      s += a[j];
    }
    out[i] = s / size;
  }
  return out;
}

// -------------------------------------------------------- onset detection ----
export function detectOnsets(x, sr, opts = {}) {
  const sensitivity = opts.sensitivity ?? 0.5, minGap = opts.minGap ?? 0.09;
  const win = 2048, hop = 512, w = hann(win);
  const nf = 1 + Math.max(0, Math.floor((x.length - win) / hop));
  if (nf < 2) return [];
  const half = (win >> 1) + 1;
  const mags = new Array(nf); const rms = new Float64Array(nf);
  const seg = new Float64Array(win);
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = 0; i < win; i++) { const v = x[f * hop + i] || 0; seg[i] = v * w[i]; s += v * v; }
    rms[f] = Math.sqrt(s / win);
    const m = rfftMag(seg, win);
    const lm = new Float64Array(half);
    for (let i = 0; i < half; i++) lm[i] = Math.log1p(50 * m[i]);
    mags[f] = lm;
  }
  const flux = new Float64Array(nf);
  for (let f = 1; f < nf; f++) {
    let s = 0; const a = mags[f], b = mags[f - 1];
    for (let i = 0; i < half; i++) { const d = a[i] - b[i]; if (d > 0) s += d; }
    flux[f] = s;
  }
  let mx = 0; for (let f = 0; f < nf; f++) if (flux[f] > mx) mx = flux[f];
  if (mx > 0) for (let f = 0; f < nf; f++) flux[f] /= mx;
  const wf = Math.max(3, Math.round(0.10 * sr / hop));
  const local = movavg(flux, wf * 2 + 1);
  const mult = 2.6 - 1.9 * sensitivity, delta = 0.14 - 0.11 * sensitivity;
  const rmsGate = Math.max(0.02, 0.04 * (1 - sensitivity) + 0.01);
  const gap = Math.max(1, Math.round(minGap * sr / hop));
  const onsets = [];
  for (let f = 1; f < nf - 1; f++) {
    const thr = local[f] * mult + delta;
    if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && rms[f] > rmsGate) {
      if (onsets.length && (f - onsets[onsets.length - 1][0]) < gap) {
        if (flux[f] > onsets[onsets.length - 1][1]) onsets[onsets.length - 1] = [f, flux[f]];
      } else onsets.push([f, flux[f]]);
    }
  }
  return onsets.map(([f]) => f * hop / sr);
}

// ----------------------------------------------------------------- pitch ----
export function estimateF0(x, sr, t0, t1, opts = {}) {
  const attackSkip = opts.attackSkip ?? 0.04, maxDur = opts.maxDur ?? 0.45,
        guard = opts.guard ?? 0.02, fLo = opts.fLo ?? 250, fHi = opts.fHi ?? 2200;
  let a = Math.floor((t0 + attackSkip) * sr);
  let b = Math.min(Math.floor((t0 + maxDur) * sr), Math.floor((t1 - guard) * sr), x.length);
  let seg = x.subarray(a, Math.max(a, b));
  if (seg.length < Math.floor(0.022 * sr)) {
    const a2 = Math.floor(t0 * sr), b2 = Math.min(a2 + Math.floor(0.03 * sr), x.length);
    seg = x.subarray(a2, Math.max(a2, b2));
    if (seg.length < 256) return null;
  }
  const w = hann(seg.length), sw = new Float64Array(seg.length);
  for (let i = 0; i < seg.length; i++) sw[i] = seg[i] * w[i];
  const N = nextPow2(seg.length) * 8, mag = rfftMag(sw, N), binHz = sr / N;
  const lo = Math.ceil(fLo / binHz), hi = Math.floor(fHi / binHz);
  if (hi <= lo + 1) return null;
  let pk = lo, best = -1;
  for (let i = lo; i < hi; i++) if (mag[i] > best) { best = mag[i]; pk = i; }
  let dd = 0;
  if (pk > 0 && pk < mag.length - 1) {
    const al = Math.log(mag[pk - 1] + 1e-12), a0 = Math.log(mag[pk] + 1e-12), ar = Math.log(mag[pk + 1] + 1e-12);
    const den = al - 2 * a0 + ar;
    dd = den !== 0 ? 0.5 * (al - ar) / den : 0;
  }
  return (pk + dd) * binHz;
}

// --------------------------------------------------- snap to measured set ----
export function snap(f0, refFreqs, offTuneCents = 45) {
  if (f0 == null || f0 <= 0) return null;
  const nearest = (c) => {
    let j = 0, ba = Infinity, be = 0;
    for (let i = 0; i < refFreqs.length; i++) {
      const e = 1200 * Math.log2(c / refFreqs[i]); const av = Math.abs(e);
      if (av < ba) { ba = av; j = i; be = e; }
    }
    return [j, be];
  };
  let [j, err] = nearest(f0), used = f0;
  if (Math.abs(err) > offTuneCents) {
    for (const cand of [f0 / 2, f0 * 2, f0 / 3, f0 * 3]) {
      const [j2, e2] = nearest(cand);
      if (Math.abs(e2) < Math.abs(err)) { j = j2; err = e2; used = cand; }
    }
  }
  return { index: j, refHz: refFreqs[j], cents: err, usedHz: used,
           flag: Math.abs(err) > offTuneCents ? '?' : '' };
}

// -------------------------------------------- calibration (self-tuning) ----
// Measure one struck-tone clip: its fundamental + a quality score (spectral
// prominence). The UI uses quality to accept a sample or ask for a re-record.
export function measureTone(x, sr, opts = {}) {
  const fLo = opts.fLo ?? 60, fHi = opts.fHi ?? 5000;
  const dur = x.length / sr;
  const f0 = estimateF0(x, sr, 0, dur, { attackSkip: 0.02, maxDur: Math.min(0.6, dur), guard: 0, fLo, fHi });
  if (!f0) return { f0: null, quality: 0 };
  // prominence of the fundamental peak vs the median in-band magnitude
  const a = Math.floor(0.02 * sr), b = Math.min(a + Math.floor(0.5 * sr), x.length);
  const seg = x.subarray(a, Math.max(a, b));
  const w = hann(seg.length), sw = new Float64Array(seg.length);
  for (let i = 0; i < seg.length; i++) sw[i] = seg[i] * w[i];
  const N = nextPow2(seg.length) * 4, mag = rfftMag(sw, N), binHz = sr / N;
  const lo = Math.ceil(fLo / binHz), hi = Math.min(mag.length - 1, Math.floor(fHi / binHz));
  let peak = 0; const band = [];
  for (let i = lo; i < hi; i++) { band.push(mag[i]); if (mag[i] > peak) peak = mag[i]; }
  band.sort((p, q) => p - q);
  const med = band.length ? band[band.length >> 1] : 1e-9;
  const quality = peak / (med + 1e-9);   // higher = cleaner single tone
  return { f0, quality };
}

// Calibrate from one slow "sweep" recording (each voice struck once, in order):
// split into strikes, measure each fundamental. Returns [{t, f0}] in play order.
export function calibrateFromSweep(x, sr, opts = {}) {
  const onsets = detectOnsets(x, sr, {
    sensitivity: opts.sensitivity ?? 0.30, minGap: opts.minGap ?? 0.40,
  });
  const fLo = opts.fLo ?? 250, fHi = opts.fHi ?? 2200;
  const bars = [];
  for (let i = 0; i < onsets.length; i++) {
    const t1 = i + 1 < onsets.length ? onsets[i + 1] : onsets[i] + 1.0;
    const f0 = estimateF0(x, sr, onsets[i], t1, { fLo, fHi });
    if (f0) bars.push({ t: onsets[i], f0 });
  }
  return bars;
}

// Calibrate from one clip per voice: [{name, samples}] -> [{name, f0, quality}]
export function calibrateFromSamples(voiceClips, sr, opts = {}) {
  return voiceClips.map(v => ({ name: v.name, ...measureTone(v.samples, sr, opts) }));
}

// ------------------------------------------------------------ transcribe ----
export function transcribe(x, sr, refFreqs, opts = {}) {
  const onsets = detectOnsets(x, sr, {
    sensitivity: opts.sensitivity ?? 0.5, minGap: opts.minGap ?? 0.09,
  });
  const fLo = opts.fLo ?? Math.min(...refFreqs) / 1.06;
  const fHi = opts.fHi ?? Math.max(...refFreqs) * 1.06;
  const notes = [];
  for (let i = 0; i < onsets.length; i++) {
    const t1 = i + 1 < onsets.length ? onsets[i + 1] : onsets[i] + 1.0;
    const f0 = estimateF0(x, sr, onsets[i], t1, { fLo, fHi, attackSkip: opts.attackSkip ?? 0.04 });
    notes.push({ t: onsets[i], f0, snap: snap(f0, refFreqs) });
  }
  return notes;
}
