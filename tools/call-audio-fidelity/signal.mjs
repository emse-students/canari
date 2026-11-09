/**
 * The reference signal the rig feeds into Chrome's fake microphone, and the WAV codec it travels in.
 *
 * Deterministic: a seeded PRNG, no clock, so two runs feed byte-identical audio and a difference in
 * the result is a difference in the TRANSMISSION. Nothing large is committed - the WAV is rebuilt in
 * the run's scratch directory every time.
 *
 * The file is a sequence of named SEGMENTS, each probing one thing a voice path can damage:
 * `sweep` (bandwidth), `speech` (what a person sounds like), `tones` (narrow-band level per
 * frequency), `noise` (stationary broadband - what a noise suppressor is BUILT to remove, so it is
 * reported, never scored). The segment table is exported because the analysis reads it.
 */

/** Sample rate of the reference and of the receiver capture. Opus runs at 48 kHz. */
export const RATE = 48_000;

/** Named segments, in seconds. Gaps between them are digital silence. Total length = `LENGTH_S`. */
export const SEGMENTS = [
  { name: 'sweep', start: 0.5, end: 3.5 },
  { name: 'speech', start: 4.0, end: 8.0 },
  { name: 'tones', start: 8.3, end: 10.3 },
  { name: 'noise', start: 10.5, end: 11.7 },
];

/** Loop length of the reference, in seconds. Chrome loops the fake capture file. */
export const LENGTH_S = 12;

/** Tone frequencies of the `tones` segment, 0.25 s each. */
export const TONES_HZ = [300, 600, 1000, 2000, 3000, 5000, 7000, 10000];

/** Sweep bounds (log sweep), Hz. */
export const SWEEP_FROM_HZ = 80;
export const SWEEP_TO_HZ = 20_000;

/** Mulberry32 - a 32-bit seeded PRNG; the only randomness in the signal. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raised-cosine fade over `n` samples at both ends, in place. */
function fade(buf, from, to, n) {
  for (let i = 0; i < n && from + i < to; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    buf[from + i] *= g;
    buf[to - 1 - i] *= g;
  }
}

/** One-pole high-pass + low-pass, cheap band shaping for the noise bursts. */
function bandShape(buf, lowHz, highHz) {
  const out = new Float64Array(buf.length);
  const aHp = Math.exp((-2 * Math.PI * lowHz) / RATE);
  const aLp = Math.exp((-2 * Math.PI * highHz) / RATE);
  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let lp = 0;
  for (let i = 0; i < buf.length; i++) {
    const hp = aHp * (hpPrevOut + buf[i] - hpPrevIn);
    hpPrevIn = buf[i];
    hpPrevOut = hp;
    lp = (1 - aLp) * hp + aLp * lp;
    out[i] = lp;
  }
  return out;
}

function rms(buf, from = 0, to = buf.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * A speech-LIKE signal: syllables of voiced harmonic sound (gliding f0, three formants) and
 * fricative noise bursts, separated by short pauses. Not intelligible, but it has speech's
 * spectrum, its 3-5 Hz syllabic rhythm and its pauses - the three things a voice codec, a noise
 * suppressor and an automatic gain control react to.
 */
function speechLike(n, rand) {
  const out = new Float64Array(n);
  let i = Math.floor(0.05 * RATE);
  while (i < n) {
    const dur = Math.floor((0.15 + 0.12 * rand()) * RATE);
    const gap = Math.floor((0.04 + 0.12 * rand()) * RATE);
    const end = Math.min(n, i + dur);
    const voiced = rand() < 0.72;
    const seg = new Float64Array(end - i);
    if (voiced) {
      const f0a = 105 + 70 * rand();
      const f0b = f0a * (0.85 + 0.35 * rand());
      const f1 = 450 + 400 * rand();
      const f2 = 1000 + 1200 * rand();
      const f3 = 2400 + 600 * rand();
      let phase = 0;
      for (let k = 0; k < seg.length; k++) {
        const t = k / seg.length;
        const f0 = f0a + (f0b - f0a) * t + 3 * Math.sin(2 * Math.PI * 5.5 * (k / RATE));
        phase += (2 * Math.PI * f0) / RATE;
        let v = 0;
        for (let h = 1; h * f0 < 7000; h++) {
          const f = h * f0;
          const formant =
            Math.exp(-(((f - f1) / 160) ** 2)) +
            0.7 * Math.exp(-(((f - f2) / 220) ** 2)) +
            0.4 * Math.exp(-(((f - f3) / 300) ** 2)) +
            0.03;
          v += (formant / Math.sqrt(h)) * Math.sin(h * phase);
        }
        seg[k] = v;
      }
    } else {
      const white = new Float64Array(seg.length);
      for (let k = 0; k < seg.length; k++) white[k] = rand() * 2 - 1;
      const shaped = bandShape(white, 2500 + 1500 * rand(), 9000);
      for (let k = 0; k < seg.length; k++) seg[k] = shaped[k] * 3;
    }
    // Syllabic envelope: a raised-cosine hump, so onsets and decays are smooth like speech.
    const peak = rms(seg) || 1;
    for (let k = 0; k < seg.length; k++) {
      const env = Math.sin((Math.PI * k) / seg.length) ** 1.5;
      out[i + k] = (seg[k] / peak) * env * (voiced ? 0.22 : 0.08);
    }
    i = end + gap;
  }
  return out;
}

/**
 * Builds the reference signal as Float64 samples in [-1, 1], `LENGTH_S` seconds at `RATE`.
 * `seed` changes the speech-like syllables only; seed 1 is the caller, seed 2 the far end.
 * `gain` scales everything (the far-end talker is quieter than the measured one). `talkOnly` builds
 * the FAR END's signal: speech-like from start to end and nothing else, so it shares no sweep, tone
 * or noise burst with the reference and any correlation between the two is a real leak.
 */
export function buildReference({ seed = 1, gain = 1, talkOnly = false } = {}) {
  const rand = prng(seed);
  const n = LENGTH_S * RATE;
  if (talkOnly) return speechLike(n, rand).map((v) => Math.max(-1, Math.min(1, v * gain)));
  const out = new Float64Array(n);
  const at = (s) => Math.round(s * RATE);

  const sw = SEGMENTS[0];
  {
    const from = at(sw.start);
    const to = at(sw.end);
    const T = (to - from) / RATE;
    const k = Math.log(SWEEP_TO_HZ / SWEEP_FROM_HZ);
    for (let i = from; i < to; i++) {
      const t = (i - from) / RATE;
      const phase = ((2 * Math.PI * SWEEP_FROM_HZ * T) / k) * (Math.exp((t * k) / T) - 1);
      out[i] = 0.3 * Math.sin(phase);
    }
    fade(out, from, to, at(0.02));
  }

  const sp = SEGMENTS[1];
  out.set(speechLike(at(sp.end) - at(sp.start), rand), at(sp.start));

  const tn = SEGMENTS[2];
  {
    const each = at((tn.end - tn.start) / TONES_HZ.length);
    TONES_HZ.forEach((f, idx) => {
      const from = at(tn.start) + idx * each;
      for (let i = 0; i < each; i++) out[from + i] = 0.25 * Math.sin((2 * Math.PI * f * i) / RATE);
      fade(out, from, from + each, at(0.01));
    });
  }

  const nz = SEGMENTS[3];
  {
    const from = at(nz.start);
    const to = at(nz.end);
    const white = new Float64Array(to - from);
    for (let i = 0; i < white.length; i++) white[i] = rand() * 2 - 1;
    const shaped = bandShape(white, 100, 12_000);
    const g = 0.1 / (rms(shaped) || 1);
    for (let i = 0; i < shaped.length; i++) out[from + i] = shaped[i] * g;
    fade(out, from, to, at(0.02));
  }

  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i] * gain));
  return out;
}

/** SNR of the noisy reference: the speech segment's RMS over the background's, dB. */
export const NOISY_SNR_DB = 10;

/**
 * The reference under a STEADY background, for the noise-suppression rows: band-shaped noise
 * (80 Hz - 5 kHz, a room's fan or a street) plus a 100 Hz hum, from start to end of the loop - gaps
 * included - at {@link NOISY_SNR_DB} below the speech segment's RMS. Seeded, so deterministic. The
 * row is still SCORED against the clean reference: what a suppressor removes is what it is for.
 */
export function withBackground(ref, { seed = 3, snrDb = NOISY_SNR_DB } = {}) {
  const rand = prng(seed);
  const white = new Float64Array(ref.length);
  for (let i = 0; i < white.length; i++) white[i] = rand() * 2 - 1;
  const bed = bandShape(white, 80, 5000);
  const bedRms = rms(bed) || 1;
  for (let i = 0; i < bed.length; i++) {
    bed[i] = bed[i] / bedRms + 0.5 * Math.sin((2 * Math.PI * 100 * i) / RATE);
  }
  const sp = SEGMENTS[1];
  const speechRms = rms(ref, Math.round(sp.start * RATE), Math.round(sp.end * RATE));
  const g = speechRms / 10 ** (snrDb / 20) / (rms(bed) || 1);
  return ref.map((v, i) => Math.max(-1, Math.min(1, v + bed[i] * g)));
}

/** Encodes mono samples in [-1, 1] as a 16-bit PCM WAV - the format Chrome's fake capture reads. */
export function encodeWav(samples, rate = RATE) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** The reference AS CHROME READS IT: the 16-bit quantised samples, back to floats. */
export function quantised(samples) {
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767) / 32767;
  }
  return out;
}
