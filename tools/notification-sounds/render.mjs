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
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAZOUILLIS, MASTER_GAIN } from '../../frontend/src/lib/utils/soundPalette.ts';

const SR = 44100;
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/src-tauri/gen/android/app/src/main/res/raw'
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

/** The room: noise shaped by (1 - i/len)^3.2, as in the prototype (mono: the files are mono). */
function impulse() {
  const rand = prng(0x0ca17a);
  const len = Math.floor(SR * REVERB_SECONDS);
  const ir = new Float32Array(len);
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

/** Direct convolution of `x` with `ir`, skipping silent input (the sounds are short). */
function convolve(x, ir) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const m = Math.min(ir.length, y.length - i);
    for (let k = 0; k < m; k++) y[i + k] += xi * ir[k];
  }
  return y;
}

function renderSound(name, ir) {
  const voices = GAZOUILLIS[name];
  const end = Math.max(...voices.map((v) => v.offset + v.dur + 0.05));
  const len = Math.ceil((end + REVERB_SECONDS) * SR);
  const dry = new Float32Array(len);
  const send = new Float32Array(len);
  for (const v of voices) renderVoice(v, dry, send);
  const wet = convolve(send, ir);
  const out = new Float32Array(len);
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
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
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
    if (Math.abs(committed.readInt16LE(i) - fresh.readInt16LE(i)) > CHECK_TOLERANCE_LSB) return false;
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
  const file = resolve(OUT, `canari_gazouillis_${name}.wav`);
  const data = wav(kept);
  if (check) {
    if (!existsSync(file) || !sameSound(readFileSync(file), data)) {
      console.error(`DRIFT: ${file} differs from the palette`);
      drift++;
    }
    continue;
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(file, data);
  console.log(`${name}: ${(kept.length / SR).toFixed(2)} s, ${data.length} bytes -> ${file}`);
}
console.log(`common gain x${gain.toFixed(2)} (loudest peak -3 dBFS)`);
if (drift) process.exit(1);
