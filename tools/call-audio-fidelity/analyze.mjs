/**
 * Fidelity of a received recording against the reference it carried. Pure functions, no I/O, so
 * the self-test (`analyze.test.mjs`) can feed it signals with KNOWN damage and check each metric
 * names that damage and nothing else.
 *
 * The receiver records a LOOPED reference starting at an unknown point, through a codec, a jitter
 * buffer that may stretch time, and a gain that may move. So: one global circular alignment by
 * cross-correlation, then a fine re-alignment per 50 ms block that follows the previous one (the jitter buffer's time-stretching
 * moves the lag during a run; how far it moved is itself reported as `driftMs`), then a
 * least-squares gain per segment, and only then the comparisons.
 */
import { RATE, SEGMENTS, SWEEP_FROM_HZ, SWEEP_TO_HZ, TONES_HZ, LENGTH_S } from './signal.mjs';

/** In-place iterative radix-2 FFT. `inverse` scales by 1/n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Linear cross-correlation `c[k] = sum_i a[i] * b[i + k]` for k in [0, maxLag], by FFT.
 * `b` must be at least `a.length + maxLag` long.
 */
export function xcorr(a, b, maxLag) {
  const m = nextPow2(a.length + b.length);
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < m; i++) {
    // conj(A) * B
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return ar.subarray(0, maxLag + 1);
}

function energy(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return s;
}

function db(x) {
  return 10 * Math.log10(Math.max(x, 1e-30));
}

/**
 * Where one loop of the reference starts inside `window` (exactly one loop long): the circular lag
 * `k` such that `window[i] ~ ref[(i + k) mod N]`, and the normalised correlation at that lag.
 */
export function circularLag(window, ref) {
  const n = ref.length;
  const doubled = new Float64Array(2 * n);
  doubled.set(ref);
  doubled.set(ref, n);
  const c = xcorr(window, doubled, n - 1);
  let best = 0;
  for (let k = 1; k < n; k++) if (c[k] > c[best]) best = k;
  const norm = Math.sqrt(energy(window) * energy(ref)) || 1;
  return { lag: best, corr: c[best] / norm };
}

const BLOCK = Math.round(0.05 * RATE);
const SEARCH = Math.round(0.03 * RATE);

const WIDE = Math.round(0.25 * RATE);

/**
 * Best shift of the reference block `blk` against the recording around `center` (+/-`radius`):
 * the shift (`delta`, samples) and its normalised correlation (`coef`, 1 = identical shape).
 */
function searchLag(blk, at, center, radius) {
  const L = blk.length;
  const seg = new Float64Array(L + 2 * radius);
  for (let i = 0; i < seg.length; i++) seg[i] = at(center - radius + i);
  const c = xcorr(blk, seg, 2 * radius);
  // NORMALISED by the energy under each candidate lag: a raw correlation prefers whichever
  // shift lands on a louder stretch, and on a rising syllable that is never the true one.
  // Floored relative to the block: over silence the running sum and the FFT correlation are
  // both rounding noise, and their ratio is not a score.
  const eBlk = energy(blk);
  const floor = eBlk * 1e-3;
  let e = energy(seg, 0, L);
  const scores = new Float64Array(2 * radius + 1);
  scores[0] = c[0] / Math.sqrt(Math.max(e, floor));
  for (let k = 1; k <= 2 * radius; k++) {
    e += seg[k + L - 1] * seg[k + L - 1] - seg[k - 1] * seg[k - 1];
    scores[k] = c[k] / Math.sqrt(Math.max(e, floor));
  }
  let top = -Infinity;
  for (const s of scores) top = Math.max(top, s);
  // A periodic block (a tone, a sustained vowel) correlates equally at every period: among the
  // near-best lags, keep the one closest to the centre, never a period away.
  let best = -1;
  for (let k = 0; k <= 2 * radius; k++) {
    if (scores[k] < top - 0.02 * Math.abs(top)) continue;
    if (best < 0 || Math.abs(k - radius) < Math.abs(best - radius)) best = k;
  }
  return { delta: best - radius, coef: top / Math.sqrt(eBlk || 1e-30) };
}

/**
 * Tracks the lag block by block (50 ms) through ONE loop of the reference, starting at
 * `rec[start]`. Each block searches +/-30 ms around the PREVIOUS block's lag, so the jitter
 * buffer's time-stretching - which accumulates over a call (it removed up to 0.5 s in 30 s on a
 * loaded host) - is followed rather than scored as damage. A block with no signal keeps its
 * neighbour's lag. Returns the re-aligned loop and the lag trajectory (samples).
 */
function trackAlign(rec, start, ref) {
  const n = ref.length;
  const out = new Float64Array(n);
  const lags = [];
  const blockLags = [];
  const coefs = [];
  let prev = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ref[i]));
  const at = (i) => (i >= 0 && i < rec.length ? rec[i] : 0);
  for (let from = 0; from < n; from += BLOCK) {
    const to = Math.min(n, from + BLOCK);
    const blk = ref.subarray(from, to);
    let lag = prev;
    if (Math.sqrt(energy(blk) / blk.length) > peak * 0.01) {
      let found = searchLag(blk, at, start + from + prev, SEARCH);
      // Lost lock (a jump larger than the step search - NetEq removing a burst of time on a
      // loaded host): re-acquire over +/-250 ms before giving the block up.
      if (found.coef < 0.5) {
        const wide = searchLag(blk, at, start + from + prev, WIDE);
        if (wide.coef >= 0.5) found = wide;
      }
      coefs.push(found.coef);
      // A lag is only MOVED on a block that matches: where the recording lost the block (a
      // dropout, a filtered band) every shift scores alike, and following one would slide
      // neighbouring audio over the very hole the dropout count is meant to see.
      if (found.coef >= 0.5) lag = prev + found.delta;
      lags.push(lag);
    }
    prev = lag;
    blockLags.push(lag);
  }
  // Median of 5 blocks: a drift is a step that PERSISTS, a lone jump is a block whose damage
  // (a hole, a burst) let a wrong shift win - and applying it would hide that damage.
  for (let b = 0; b < blockLags.length; b++) {
    const w = blockLags.slice(Math.max(0, b - 2), b + 3).sort((x, y) => x - y);
    const lag = w[Math.floor(w.length / 2)];
    const from = b * BLOCK;
    for (let i = from; i < Math.min(n, from + BLOCK); i++) out[i] = at(start + i + lag);
  }
  coefs.sort((x, y) => x - y);
  return { aligned: out, lags, matchCoef: coefs[Math.floor(coefs.length / 2)] ?? 0 };
}

/** Least-squares gain of `y` onto `x` over [from, to). */
function lsGain(x, y, from, to) {
  let xy = 0;
  let xx = 0;
  for (let i = from; i < to; i++) {
    xy += x[i] * y[i];
    xx += x[i] * x[i];
  }
  return xx > 0 ? xy / xx : 0;
}

const FFT_N = 1024;
const HOP = 512;
const HANN = Float64Array.from(
  { length: FFT_N },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N)
);

/** Power spectra of hann-windowed frames over [from, to). */
function stft(x, from, to) {
  const frames = [];
  for (let s = from; s + FFT_N <= to; s += HOP) {
    const re = new Float64Array(FFT_N);
    const im = new Float64Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) re[i] = x[s + i] * HANN[i];
    fft(re, im);
    const p = new Float64Array(FFT_N / 2 + 1);
    for (let k = 0; k <= FFT_N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    frames.push({ start: s, p });
  }
  return frames;
}

const binHz = RATE / FFT_N;
const bin = (hz) => Math.round(hz / binHz);

/** Per-segment comparison of the aligned recording `y` against the reference `x`. */
function segmentMetrics(x, y, from, to, name) {
  const g = lsGain(x, y, from, to);
  let num = 0;
  let den = 0;
  for (let i = from; i < to; i++) {
    const e = y[i] - g * x[i];
    num += g * x[i] * (g * x[i]);
    den += e * e;
  }
  const fx = stft(x, from, to);
  const fy = stft(y, from, to);
  const maxE = Math.max(...fx.map((f) => f.p.reduce((a, b) => a + b, 0)));
  const lo = bin(100);
  const hi = bin(16_000);
  let lsdSum = 0;
  let lsdFrames = 0;
  let hfRef = 0;
  let hfRec = 0;
  let lfRef = 0;
  let lfRec = 0;
  const g2 = g * g || 1e-12;
  for (let f = 0; f < fx.length; f++) {
    const px = fx[f].p;
    const py = fy[f].p;
    const e = px.reduce((a, b) => a + b, 0);
    for (let k = bin(4000); k <= bin(20_000); k++) {
      hfRef += g2 * px[k];
      hfRec += py[k];
    }
    for (let k = bin(100); k < bin(4000); k++) {
      lfRef += g2 * px[k];
      lfRec += py[k];
    }
    if (e < maxE * 1e-4) continue;
    // Floor at 60 dB below the frame's strongest bin, so a bin the reference does not populate
    // is not scored as an infinite mismatch.
    let pk = 0;
    for (let k = lo; k <= hi; k++) pk = Math.max(pk, g2 * px[k]);
    const floor = pk * 1e-6 + 1e-20;
    let s = 0;
    for (let k = lo; k <= hi; k++) {
      const d = db((py[k] + floor) / (g2 * px[k] + floor));
      s += d * d;
    }
    lsdSum += Math.sqrt(s / (hi - lo + 1));
    lsdFrames++;
  }
  return {
    name,
    gainDb: 20 * Math.log10(Math.max(Math.abs(g), 1e-9)),
    snrDb: db(num / (den || 1e-30)),
    lsdDb: lsdFrames ? lsdSum / lsdFrames : NaN,
    // Spectral TILT above 4 kHz: high-band loss relative to the low band, so a level change that
    // hits every frequency equally (an AGC) is not counted as a lost high band.
    hfLossDb: db(hfRec / (hfRef || 1e-30)) - db(lfRec / (lfRef || 1e-30)),
  };
}

/** Highest sweep frequency still within `dropDb` of the sweep's 300-3000 Hz level. */
function sweepBandwidth(x, y, seg, dropDb = 10) {
  const from = Math.round(seg.start * RATE);
  const to = Math.round(seg.end * RATE);
  const fx = stft(x, from, to);
  const fy = stft(y, from, to);
  const pts = [];
  const T = seg.end - seg.start;
  const k = Math.log(SWEEP_TO_HZ / SWEEP_FROM_HZ);
  for (let f = 0; f < fx.length; f++) {
    const t = (fx[f].start + FFT_N / 2 - from) / RATE;
    const hz = SWEEP_FROM_HZ * Math.exp((k * t) / T);
    const b = bin(hz);
    if (b < 2 || b > FFT_N / 2 - 3) continue;
    let ex = 0;
    let ey = 0;
    for (let d = -2; d <= 2; d++) {
      ex += fx[f].p[b + d];
      ey += fy[f].p[b + d];
    }
    pts.push({ hz, rel: db(ey / (ex || 1e-30)) });
  }
  const mid = pts.filter((p) => p.hz >= 300 && p.hz <= 3000).map((p) => p.rel);
  mid.sort((a, b) => a - b);
  const ref = mid[Math.floor(mid.length / 2)] ?? 0;
  let bw = 0;
  for (const p of pts) if (p.rel >= ref - dropDb) bw = p.hz;
  return Math.round(bw);
}

/** Level of each tone relative to the 1 kHz tone, dB. */
function toneLevels(x, y, seg) {
  const each = Math.round(((seg.end - seg.start) / TONES_HZ.length) * RATE);
  const from = Math.round(seg.start * RATE);
  const rel = TONES_HZ.map((_, i) => {
    const a = from + i * each + Math.round(0.03 * RATE);
    const b = from + (i + 1) * each - Math.round(0.03 * RATE);
    return db(energy(y, a, b) / (energy(x, a, b) || 1e-30));
  });
  const ref = rel[TONES_HZ.indexOf(1000)];
  return Object.fromEntries(TONES_HZ.map((f, i) => [f, Math.round((rel[i] - ref) * 10) / 10]));
}

/**
 * Dropouts: runs of >= 2 consecutive 10 ms frames, inside the scored segments, where the
 * recording sits 30 dB below what the reference (at the segment's gain) predicts.
 */
function dropouts(x, y, segs, gains) {
  const fr = Math.round(0.01 * RATE);
  let events = 0;
  let ms = 0;
  segs.forEach((seg, si) => {
    const g2 = gains[si] ** 2;
    const from = Math.round(seg.start * RATE);
    const to = Math.round(seg.end * RATE);
    let run = 0;
    const flush = () => {
      if (run >= 2) {
        events++;
        ms += run * 10;
      }
      run = 0;
    };
    for (let s = from; s + fr <= to; s += fr) {
      const ex = energy(x, s, s + fr) * g2;
      const ey = energy(y, s, s + fr);
      // Only frames where the reference is clearly active (> -50 dBFS RMS at the segment's gain).
      if (ex / fr < 1e-5 * g2) {
        flush();
        continue;
      }
      if (ey < ex * 1e-3) run++;
      else flush();
    }
    flush();
  });
  return { events, ms };
}

/**
 * Full analysis of one recording. `recording` is the receiver capture (Float32/64, `RATE`),
 * `ref` the reference exactly as fed (quantised), `far` the other party's reference (optional:
 * how much of it leaks into this direction). `skipS` drops the first seconds (AGC convergence):
 * the scored loop is the first WHOLE loop of the reference that starts after it.
 */
export function analyze(recording, ref, { far = null, skipS = 8 } = {}) {
  const n = ref.length;
  if (n !== LENGTH_S * RATE) throw new Error(`reference must be ${LENGTH_S} s`);
  const skip = Math.round(skipS * RATE);
  if (recording.length < skip + 2 * n) {
    throw new Error(
      `recording too short: ${(recording.length / RATE).toFixed(1)} s, need ${(skip + 2 * n) / RATE} s`
    );
  }
  const window = Float64Array.from(recording.subarray(skip, skip + n));
  const { lag, corr } = circularLag(window, ref);
  // window[i] ~ ref[(i + lag) mod n], so ref[0] sits at window index (n - lag) mod n.
  const start = skip + ((n - lag) % n);
  const { aligned, lags, matchCoef } = trackAlign(recording, start, ref);
  // How far the jitter buffer moved the audio in time over the loop (accelerate/decelerate).
  const driftMs = lags.length ? ((Math.max(...lags) - Math.min(...lags)) / RATE) * 1000 : 0;

  const segs = SEGMENTS.map((s) =>
    segmentMetrics(ref, aligned, Math.round(s.start * RATE), Math.round(s.end * RATE), s.name)
  );
  const scored = SEGMENTS.filter((s) => s.name !== 'noise');
  const gains = scored.map((s) => 10 ** (segs.find((m) => m.name === s.name).gainDb / 20));

  let clipped = 0;
  for (let i = 0; i < recording.length; i++) if (Math.abs(recording[i]) >= 0.999) clipped++;

  // Floor in the digital silence between segments: comfort noise, leakage, or residual hiss.
  const gaps = [
    [0.05, 0.45],
    [3.55, 3.95],
    [8.05, 8.25],
    [11.75, 11.95],
  ];
  let gE = 0;
  let gN = 0;
  for (const [a, b] of gaps) {
    gE += energy(aligned, Math.round(a * RATE), Math.round(b * RATE));
    gN += Math.round(b * RATE) - Math.round(a * RATE);
  }

  let farLeakDb = null;
  if (far) {
    const { corr: fc } = circularLag(window, far);
    farLeakDb = 20 * Math.log10(Math.max(Math.abs(fc), 1e-6));
  }

  return {
    alignCorr: corr,
    // Median normalised correlation of the 50 ms blocks with the reference: near 1 when the
    // decoded audio IS the reference, near 0 when it is unrelated noise or silence.
    matchCoef,
    driftMs,
    segments: Object.fromEntries(segs.map((s) => [s.name, s])),
    bandwidthHz: sweepBandwidth(ref, aligned, SEGMENTS[0]),
    tonesDb: toneLevels(ref, aligned, SEGMENTS[2]),
    dropouts: dropouts(ref, aligned, scored, gains),
    clippedSamples: clipped,
    silenceFloorDbfs: db(gE / (gN || 1)),
    farLeakDb,
  };
}
