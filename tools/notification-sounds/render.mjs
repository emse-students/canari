/**
 * Renders the Android notification sounds - palette A "Gazouillis" - to `res/raw/*.wav`.
 *
 *   bun tools/notification-sounds/render.mjs          write the files
 *   bun tools/notification-sounds/render.mjs --check  fail if the committed files differ (no write)
 *
 * THE SPECS ARE NOT HERE: they are `frontend/src/lib/utils/soundPalette.ts`, the same data the
 * in-app tones schedule on Web Audio, so a change to the palette is ONE edit and this script is
 * re-run. It re-implements the prototype's synthesis offline (exponential pitch path, exponential
 * attack/decay envelope, vibrato LFO, partial) and its small bright room (a decaying noise impulse,
 * 0.9 s, 18 % wet), with a SEEDED noise so the output is byte-reproducible.
 *
 * LEVEL: the prototype was listened to at a master gain of 0.6, whose loudest peak sits near -19 dBFS
 * - far under what a notification channel plays at. All three files are scaled by ONE common factor
 * so the loudest reaches -3 dBFS, which keeps the relative levels the palette was chosen with
 * (a reaction stays softer than a message). Files are 44.1 kHz mono 16-bit WAV, the tail trimmed where
 * it falls under -70 dBFS. Only message, mention and reaction ship: send and read are in-app tones.
 *
 * THE CALLER'S RINGBACK is rendered here too (`RINGBACK_PHRASE` of the same palette file), into
 * `frontend/static/sounds/canari_ringback.wav`: one exact loop, at its own lower level - see the
 * block near the end.
 *
 * THE INCOMING-CALL RING (`RING_PHRASE`, the owner's "C1" of 2026-11-01) is rendered last: one
 * seamless loop of `RING_PERIOD_S` into `res/raw/canari_ring.wav` (Android) and
 * `static/sounds/canari_ring.wav` (the web page), and five loops of it into the iPhone's CallKit
 * ringtone `gen/apple/CallSounds/canari_ring_callkit.wav` - see the last block.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GAZOUILLIS,
  MASTER_GAIN,
  RING_PERIOD_S,
  RING_PHRASE,
  RINGBACK_PERIOD_S,
  RINGBACK_PHRASE,
} from '../../frontend/src/lib/utils/soundPalette.ts';

const SR = 44100;
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/src-tauri/gen/android/app/src/main/res/raw'
);
/** The ringback is a WEB asset (played by the page on every platform), served from `static/`. */
const RINGBACK_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/static/sounds'
);
/** The iPhone's CallKit ringtone is an app-bundle resource, beside the hand-maintained project. */
const CALLKIT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/src-tauri/gen/apple/CallSounds'
);
const SHIPPED = ['message', 'mention', 'reaction'];
const PEAK_TARGET = 0.7; // -3 dBFS
const REVERB_SECONDS = 0.9;
const WET = 0.18;
const TRIM_FLOOR = 10 ** (-70 / 20);

/** mulberry32: a tiny seeded PRNG, so the room is the same on every run. */
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compares `data` with the committed `file` under `--check`, or writes it; returns the drift count. */
function emit(file, data, label) {
  if (check) {
    if (existsSync(file) && sameSound(readFileSync(file), data)) return 0;
    console.error(`DRIFT: ${file} differs from the palette`);
    return 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`${label}, ${data.length} bytes -> ${file}`);
  return 0;
}

/** The room: noise shaped by (1 - i/len)^3.2, as in the prototype (mono: the files are mono). */
function impulse() {
  const rand = prng(0x0ca17a);
  const len = Math.floor(SR * REVERB_SECONDS);
  const ir = new Float64Array(len);
  let power = 0;
  for (let i = 0; i < len; i++) {
    ir[i] = (rand() * 2 - 1) * (1 - i / len) ** 3.2;
    power += ir[i] * ir[i];
  }
  // A ConvolverNode NORMALISES its impulse (normalize = true, the prototype's default): Chrome scales
  // it to a fixed power, -58 dB re 44.1 kHz. Without it the room would be ~20 dB too loud.
  const scale = (1 / Math.sqrt(power / len)) * 10 ** (-58 / 20) * (44100 / SR);
  for (let i = 0; i < len; i++) ir[i] *= scale;
  return ir;
}

/** Exponential ramps through `[t, v]` points, held after the last (Web Audio semantics). */
function expAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1];
      const [t1, v1] = points[i];
      return v0 * (v1 / v0) ** ((t - t0) / (t1 - t0));
    }
  }
  return points[points.length - 1][1];
}

/** Renders one voice into `dry` and `send` (the reverb feed), summed in place. */
function renderVoice(v, dry, send) {
  const start = Math.floor(v.offset * SR);
  const n = Math.floor((v.dur + 0.05) * SR);
  const env = [
    [0, 0.0001],
    [v.attack, v.peak * MASTER_GAIN],
    [v.dur, 0.0001],
  ];
  let phase = 0;
  for (let i = 0; i < n && start + i < dry.length; i++) {
    const t = i / SR;
    let f = expAt(v.path, t);
    if (v.vib) f += v.vib * Math.sin(2 * Math.PI * v.vibHz * t);
    phase += (2 * Math.PI * f) / SR;
    const s = Math.sin(phase) * expAt(env, t);
    dry[start + i] += s;
    send[start + i] += s * v.send;
  }
}

/** In-place iterative radix-2 complex FFT (`inverse` scales by 1/n). */
function fft(re, im, inverse) {
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
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
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

/**
 * Convolution of `x` with `ir`, truncated to `x`'s length, by FFT: the ring is five seconds of
 * sustained notes, where a direct convolution would take minutes. Same result as the direct sum to
 * far under a 16-bit step.
 */
function convolve(x, ir) {
  let n = 1;
  while (n < x.length + ir.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(x);
  br.set(ir);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
  }
  fft(ar, ai, true);
  return ar.subarray(0, x.length);
}

function renderSound(name, ir) {
  return renderVoices(GAZOUILLIS[name], ir);
}

/** Renders a list of voices with its room: dry + 18 % wet, the reverb tail included. */
function renderVoices(voices, ir) {
  const end = Math.max(...voices.map((v) => v.offset + v.dur + 0.05));
  const len = Math.ceil((end + REVERB_SECONDS) * SR);
  const dry = new Float64Array(len);
  const send = new Float64Array(len);
  for (const v of voices) renderVoice(v, dry, send);
  const wet = convolve(send, ir);
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = dry[i] + wet[i] * WET;
  return out;
}

/** 16-bit mono PCM WAV. */
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) =>
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2)
  );
  return buf;
}

/**
 * Whether a committed file IS the palette's rendering, for `--check`.
 *
 * The format fields of the header (rate, channels, depth) must match; the samples may differ by
 * `CHECK_TOLERANCE_LSB` and the length by `CHECK_TOLERANCE_SAMPLES` (the tail trim sits at -70 dBFS),
 * because `Math.sin` is not bit-identical across engines and platforms (this is checked on Linux CI
 * and rendered on Windows) and a rounding flip of one 16-bit step is inaudible. A real palette
 * change moves samples by hundreds of steps and the length by thousands, so the tolerance cannot
 * hide one.
 */
const CHECK_TOLERANCE_LSB = 2;
const CHECK_TOLERANCE_SAMPLES = 8;
function sameSound(committed, fresh) {
  if (!committed.subarray(8, 36).equals(fresh.subarray(8, 36))) return false;
  if (Math.abs(committed.length - fresh.length) > CHECK_TOLERANCE_SAMPLES * 2) return false;
  const end = Math.min(committed.length, fresh.length) - 1;
  for (let i = 44; i < end; i += 2) {
    if (Math.abs(committed.readInt16LE(i) - fresh.readInt16LE(i)) > CHECK_TOLERANCE_LSB)
      return false;
  }
  return true;
}

const ir = impulse();
const rendered = SHIPPED.map((name) => ({ name, samples: renderSound(name, ir) }));
const peak = Math.max(...rendered.flatMap((r) => [Math.max(...r.samples.map(Math.abs))]));
const gain = PEAK_TARGET / peak;
const check = process.argv.includes('--check');
let drift = 0;
for (const { name, samples } of rendered) {
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last] * gain) < TRIM_FLOOR) last--;
  // A short linear fade over the last 20 ms so the trim never clicks.
  const kept = samples.slice(0, last + 1).map((s) => s * gain);
  const fade = Math.min(kept.length, Math.floor(SR * 0.02));
  for (let i = 0; i < fade; i++) kept[kept.length - 1 - i] *= i / fade;
  const data = wav(kept);
  drift += emit(
    resolve(OUT, `canari_gazouillis_${name}.wav`),
    data,
    `${name}: ${(kept.length / SR).toFixed(2)} s`
  );
}
console.log(`common gain x${gain.toFixed(2)} (loudest peak -3 dBFS)`);

// THE CALLER'S RINGBACK (`RINGBACK_PHRASE`, calls.md "The caller's ringback"). Its own level, not the
// notifications' common gain: it plays for up to the whole ring window, on the earpiece, so its
// loudest peak sits at RINGBACK_PEAK_DBFS. The file is EXACTLY one loop - the phrase, its room, then
// silence up to RINGBACK_PERIOD_S - because the `<audio loop>` playing it repeats the whole file, and
// the pause between phrases is that silence. No fade: the tail is already under the floor long before
// the end, and the loop point is silence on both sides.
{
  const RINGBACK_PEAK_DBFS = -14;
  const phrase = renderVoices(RINGBACK_PHRASE, ir);
  const length = Math.round(RINGBACK_PERIOD_S * SR);
  if (phrase.length > length) {
    console.error(
      `RINGBACK: the phrase (${phrase.length} samples) is longer than its loop (${length})`
    );
    process.exit(1);
  }
  const ringPeak = Math.max(...phrase.map(Math.abs));
  const ringGain = 10 ** (RINGBACK_PEAK_DBFS / 20) / ringPeak;
  const loop = new Float32Array(length);
  for (let i = 0; i < phrase.length; i++) loop[i] = phrase[i] * ringGain;
  drift += emit(
    resolve(RINGBACK_OUT, 'canari_ringback.wav'),
    wav(loop),
    `ringback: ${RINGBACK_PERIOD_S} s loop`
  );
}

// THE INCOMING-CALL RING (`RING_PHRASE`, the owner's "C1" of 2026-11-01; calls.md "The incoming
// ring"). Rendered exactly as the candidate the owner approved: the voices with their room, then
// FOLDED circularly onto one loop of RING_PERIOD_S - every sample past the loop's end (the cadence's
// tail, the room) is added back at its start - so a player's `loop` repeats it with no seam. Its own
// level, -1 dBFS: a ring must carry across a room, and it plays on the RINGTONE stream, whose volume
// the user sets apart from the notifications'.
//
// Three files, one rendering: the loop for Android (`res/raw`, the channel and the native in-app
// ring) and for the web page (`static/sounds`, the tone output), and FIVE loops - 25 s, seamless,
// under the 30 s Apple allows a bundled sound - for CallKit's `ringtoneSound`, which repeats it.
{
  const RING_PEAK_DBFS = -1;
  const CALLKIT_LOOPS = 5;
  const length = Math.round(RING_PERIOD_S * SR);
  const voices = renderVoices(RING_PHRASE, ir);
  const loop = new Float64Array(length);
  for (let i = 0; i < voices.length; i++) loop[i % length] += voices[i];
  let ringPeak = 0;
  for (const s of loop) ringPeak = Math.max(ringPeak, Math.abs(s));
  const ringGain = 10 ** (RING_PEAK_DBFS / 20) / ringPeak;
  for (let i = 0; i < length; i++) loop[i] *= ringGain;
  const one = wav(loop);
  const label = `ring: ${RING_PERIOD_S} s loop`;
  drift += emit(resolve(OUT, 'canari_ring.wav'), one, label);
  drift += emit(resolve(RINGBACK_OUT, 'canari_ring.wav'), one, label);
  const callkit = new Float64Array(length * CALLKIT_LOOPS);
  for (let r = 0; r < CALLKIT_LOOPS; r++) callkit.set(loop, r * length);
  drift += emit(
    resolve(CALLKIT_OUT, 'canari_ring_callkit.wav'),
    wav(callkit),
    `ring (CallKit): ${CALLKIT_LOOPS * RING_PERIOD_S} s`
  );
}
if (drift) process.exit(1);
