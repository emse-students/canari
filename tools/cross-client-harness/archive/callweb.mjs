/**
 * CALL-WEB-1..8 - IN-APP 1:1 AUDIO CALLS BETWEEN TWO BROWSERS, ONE ROW PER PROCESS.
 *
 *   bun archive/callweb.mjs --row CALL-WEB-1|...|CALL-WEB-8
 *
 * The table, the seat tones, the judges and the narration are `callrows.mjs`; this file plays them.
 * W2 (peer) calls W4 (third) in their DM; W5 (fourth) is CALL-WEB-7's second caller; CALL-WEB-6 closes
 * W4 and W8 (every device of the callee) and reopens them afterwards.
 *
 * EACH SEAT CAPTURES ITS OWN TONE, AND THAT IS A FACT READ, NOT A FLAG ASSUMED. Before the row, every
 * seat's fake microphone is sampled in its own page (one `getUserMedia`, an FFT, the peak frequency).
 * A seat not on its `SEAT_TONES` frequency is relaunched on a WAV of it
 * (`--use-file-for-fake-audio-capture`) and its encryption gate passed again; a seat still off its
 * tone after that is an ERROR, never a row played on a shared beep (CALL-WEB-2's six rig FAILs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { subjectFor } from '../accounts.mjs';
import { pin } from '../atoms.mjs';
import { CALL_WEB_ROWS, FLOW_SECONDS, ROUND_MS, SEAT_TONES, UNANSWERED_ROUNDS, WAIT_ROUNDS, callNarration, callOwn, toneWav } from '../callrows.mjs';
import { TRACK_PCS, SAMPLE } from '../callpeer.mjs';
import { client, evaluate, openConversation, realClick } from '../chat.mjs';
import { resolveDevices, tabMatchFor } from '../device.mjs';
import { srvLines } from '../estate.mjs';
import { createDM } from '../groupnav.mjs';
import { closeBrowser, isUp, startBrowser } from '../launch.mjs';
import { closeSeats, displayNameOf, observersOf, openSeats } from '../mlsrow.mjs';
import { STATE_DIR } from '../names.mjs';
import { errorDetail, finishObserved, keepConsoles, record } from '../results.mjs';
import { SITE } from '../site.mjs';
import { consoleDump } from '../watch.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!CALL_WEB_ROWS[id]) {
  console.error(`usage: bun archive/callweb.mjs --row ${Object.keys(CALL_WEB_ROWS).join('|')}`);
  process.exit(2);
}
const spec = CALL_WEB_ROWS[id];
const since = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${id}] ${msg}`);
let seats = null;
const cx = (d) => seats.seat[d].cx;

// The French labels the call screens carry (`messages/fr.json`), as the seats render them.
const LABEL = {
  dial: 'Appel audio',
  accept: "Accepter l'appel entrant",
  decline: "Refuser l'appel entrant",
  hangUp: 'Raccrocher',
  mute: 'Couper le micro',
  unmute: 'Activer le micro',
};
const sel = (k) => `[aria-label="${LABEL[k]}"]`;
const has = async (d, k) => (await evaluate(cx(d), `!!document.querySelector(${JSON.stringify(sel(k))})`)) === true;

/** The round a predicate first holds in, or `null` after `max` rounds of {@link ROUND_MS}. */
async function rounds(pred, max = WAIT_ROUNDS) {
  for (let r = 1; r <= max; r++) {
    if (await pred()) return r;
    await sleep(ROUND_MS);
  }
  return null;
}

// ── the seat's own tone ────────────────────────────────────────────────────────────────────────────

/** The peak frequency of this page's fake microphone, in Hz: one capture, an FFT, closed again. */
const PEAK_HZ = `(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 8192;
  ac.createMediaStreamSource(s).connect(an);
  await new Promise((r) => setTimeout(r, 1500));
  const bins = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(bins);
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  s.getTracks().forEach((t) => t.stop());
  await ac.close();
  return Math.round((best * ac.sampleRate) / an.fftSize);
})()`;
/** Within one FFT bin either side at 48 kHz / 8192, with room for the window. */
const TONE_TOLERANCE_HZ = 20;

async function peakOf(seat) {
  const [target] = resolveDevices(['--device', seat]);
  const c = await client(target.port, tabMatchFor(target), { focus: false });
  try {
    return await evaluate(c, PEAK_HZ);
  } finally {
    c.close();
  }
}

/** The WAV a seat's fake microphone plays, written once under `STATE_DIR`. */
function wavOf(seat) {
  const dir = join(STATE_DIR, 'call-tones');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${seat}-${SEAT_TONES[seat]}hz.wav`);
  writeFileSync(file, toneWav(SEAT_TONES[seat]));
  return file;
}

/** Chrome's fake media, on this seat's own tone when it has one. */
const mediaFlags = (seat) => [
  '--use-fake-device-for-media-stream=fps=30',
  '--use-fake-ui-for-media-stream',
  ...(SEAT_TONES[seat] ? [`--use-file-for-fake-audio-capture=${wavOf(seat)}`] : []),
];

/** Closes (when up) and starts a seat's browser, then passes its encryption gate. */
async function relaunch(seat, flags) {
  const which = seat.toLowerCase();
  if (await isUp(which)) await closeBrowser(which);
  await startBrowser(which, `${SITE}/chat`, flags);
  const r = pin(seat);
  // `pin.mjs` exits 2 for a seat already past its gate - not a failure (`atoms.mjs`).
  if (r.code !== 0 && r.code !== 2) throw new Error(`${seat}: the encryption gate did not pass after the relaunch (exit ${r.code}): ${r.out.slice(-400)}`);
  log(`${seat} relaunched${flags.length ? ' on fake media' : ''}`);
}

/** Every seat of the row on its own tone - read, relaunched once if not, an ERROR if still not. */
async function tonesSet() {
  const read = {};
  for (const seat of spec.devices) {
    const want = SEAT_TONES[seat];
    let hz = await peakOf(seat).catch(() => null);
    if (hz === null || Math.abs(hz - want) > TONE_TOLERANCE_HZ) {
      log(`${seat} captures ${hz ?? 'nothing'} Hz, not its ${want} Hz - relaunching it on its tone`);
      await relaunch(seat, mediaFlags(seat));
      hz = await peakOf(seat);
    }
    if (Math.abs(hz - want) > TONE_TOLERANCE_HZ) throw new Error(`${seat} captures ${hz} Hz after its relaunch, not its ${want} Hz`);
    read[seat] = hz;
  }
  return read;
}

// ── the call's measurements ────────────────────────────────────────────────────────────────────────

const HEARD = `(async () => { const pc = [...(window.__callPeerPcs || [])].reverse().find((p) => p.connectionState !== 'closed'); if (!pc) return null; let e = null; (await pc.getStats()).forEach((v) => { if (v.type === 'inbound-rtp' && v.kind === 'audio') e = v.totalAudioEnergy; }); return e; })()`;
const SENDER = `(async () => { const pc = [...(window.__callPeerPcs || [])].reverse().find((p) => p.connectionState !== 'closed'); if (!pc) return null; const s = pc.getSenders().find((x) => x.track && x.track.kind === 'audio'); let bytes = null; (await pc.getStats()).forEach((v) => { if (v.type === 'outbound-rtp' && v.kind === 'audio') bytes = v.bytesSent; }); return { track: !!s, enabled: s ? s.track.enabled : null, readyState: s ? s.track.readyState : null, bytesSent: bytes }; })()`;

/** One stats sample (`callpeer.mjs` SAMPLE) with the cumulative audio energy this seat RECEIVED. */
const sample = async (d) => ({ ...(await evaluate(cx(d), SAMPLE)), heardEnergy: await evaluate(cx(d), HEARD) });

/** What flowed each way over {@link FLOW_SECONDS}: packets, bytes, and the audio energy heard. */
async function flowing(a, b) {
  const a0 = await sample(a);
  const b0 = await sample(b);
  await sleep(FLOW_SECONDS * 1000);
  const a1 = await sample(a);
  const b1 = await sample(b);
  const side = (x0, x1) => ({
    state: x1.state,
    pair: x1.pair,
    codec: x1.inCodec,
    recv: (x1.packetsReceived ?? 0) - (x0.packetsReceived ?? 0),
    bytes: (x1.bytesReceived ?? 0) - (x0.bytesReceived ?? 0),
    sent: (x1.packetsSent ?? 0) - (x0.packetsSent ?? 0),
    lost: x1.packetsLost,
    heard: (x1.heardEnergy ?? 0) - (x0.heardEnergy ?? 0),
  });
  return { [a]: side(a0, a1), [b]: side(b0, b1) };
}

const connected = (d) => rounds(async () => (await sample(d)).state === 'connected');
const ended = (d) => rounds(async () => !['connected', 'connecting', 'new'].includes((await sample(d)).state) && !(await has(d, 'hangUp')));
const rings = (d, max = WAIT_ROUNDS) => rounds(() => has(d, 'accept'), max);

async function dial(from, callee) {
  await openConversation(cx(from), callee);
  await realClick(cx(from), sel('dial'));
}
async function answered(callee) {
  await dial('W2', callee);
  const rang = await rings('W4');
  if (rang === null) return { rang };
  await realClick(cx('W4'), sel('accept'));
  return { rang, up: { W2: await connected('W2'), W4: await connected('W4') } };
}
const bothEnd = async (first, second) => ({ [first]: await ended(first), [second]: await ended(second) });

/** Each scenario's gestures, returning what `CALL_JUDGES[scenario]` reads. */
const PLAY = {
  async basic(callee) {
    const a = await answered(callee);
    if (a.rang === null) return a;
    const flow = await flowing('W2', 'W4');
    await realClick(cx('W2'), sel('hangUp'));
    return { ...a, flow, down: await bothEnd('W2', 'W4') };
  },
  async mute(callee) {
    const a = await answered(callee);
    if (a.rang === null) return a;
    const before = await flowing('W2', 'W4');
    await realClick(cx('W2'), sel('mute'));
    const muteShown = await rounds(() => has('W2', 'unmute'));
    const senderAtMute = await evaluate(cx('W2'), SENDER);
    const muted = await flowing('W2', 'W4');
    await realClick(cx('W2'), sel('unmute'));
    const senderAtUnmute = await evaluate(cx('W2'), SENDER);
    const after = await flowing('W2', 'W4');
    await realClick(cx('W2'), sel('hangUp'));
    return { ...a, before, muteShown, senderAtMute, muted, senderAtUnmute, after, down: await bothEnd('W2', 'W4') };
  },
  async 'callee-hangup'(callee) {
    const a = await answered(callee);
    if (a.rang === null) return a;
    const flow = await flowing('W2', 'W4');
    await realClick(cx('W4'), sel('hangUp'));
    return { ...a, flow, down: await bothEnd('W4', 'W2') };
  },
  async decline(callee) {
    await dial('W2', callee);
    const rang = await rings('W4');
    if (rang === null) return { rang };
    await realClick(cx('W4'), sel('decline'));
    const down = await bothEnd('W4', 'W2');
    return { rang, down, neverConnected: (await sample('W2')).state !== 'connected' };
  },
  async cancel(callee) {
    await dial('W2', callee);
    const rang = await rings('W4');
    if (rang === null) return { rang };
    await realClick(cx('W2'), sel('hangUp'));
    const ringStopped = await rounds(async () => !(await has('W4', 'accept')));
    return { rang, ringStopped, down: { W2: await ended('W2') } };
  },
  async offline(callee) {
    await dial('W2', callee);
    // PAST THE SERVER'S 60 s RING WINDOW (`UNANSWERED_ROUNDS`), so the window closes before the rig would.
    const end = await rounds(async () => !(await has('W2', 'hangUp')), UNANSWERED_ROUNDS);
    if (end === null) await realClick(cx('W2'), sel('hangUp'));
    return { ended: end };
  },
  async busy(callee) {
    const a = await answered(callee);
    if (a.rang === null) return a;
    await dial('W5', callee);
    // W4 must not ring over the call in progress: watched for as long as W5's own ring may last.
    let secondRing = null;
    const secondEnded = await rounds(async () => {
      if (secondRing === null && (await has('W4', 'accept'))) secondRing = true;
      return !(await has('W5', 'hangUp'));
    }, UNANSWERED_ROUNDS);
    if (secondEnded === null) await realClick(cx('W5'), sel('hangUp'));
    const flow = await flowing('W2', 'W4');
    await realClick(cx('W2'), sel('hangUp'));
    return { ...a, secondRing, secondEnded, flow, down: await bothEnd('W2', 'W4') };
  },
  async reload(callee) {
    const a = await answered(callee);
    if (a.rang === null) return a;
    const flow = await flowing('W2', 'W4');
    await cx('W4').send('Page.reload', {});
    const callerEnded = await ended('W2');
    if (callerEnded === null && (await has('W2', 'hangUp'))) await realClick(cx('W2'), sel('hangUp'));
    return { ...a, flow, callerEnded };
  },
};

/** The measurement shaped for its judge: a missing ring leaves every later fact `null`, never absent. */
function filled(scenario, m) {
  const none = { W2: null, W4: null };
  const noFlow = { W2: { state: null, heard: 0 }, W4: { state: null, heard: 0 } };
  return { up: none, down: none, flow: noFlow, before: noFlow, muted: noFlow, after: noFlow, ringStopped: null, neverConnected: false, ended: null, secondRing: null, secondEnded: null, callerEnded: null, ...m };
}

// ── the row ────────────────────────────────────────────────────────────────────────────────────────

try {
  const tones = await tonesSet();
  log(`tones read: ${JSON.stringify(tones)}`);
  for (const seat of spec.closed ?? []) {
    if (await isUp(seat.toLowerCase())) await closeBrowser(seat.toLowerCase());
    log(`${seat} closed - no device of the callee may answer`);
  }
  seats = await openSeats(spec.devices, id);
  const [callee] = resolveDevices(['--device', 'W4']);
  const calleeName = displayNameOf(subjectFor(callee.account));
  // THE ROW'S DM, made once per caller and found thereafter (`createDM` is idempotent).
  for (const caller of spec.devices.filter((d) => d !== 'W4')) log(`${caller} -> ${calleeName}: ${await createDM(cx(caller), calleeName, { label: id })}`);
  for (const d of spec.devices) await evaluate(cx(d), TRACK_PCS);

  const measured = filled(spec.scenario, await PLAY[spec.scenario](calleeName));
  const { verdict, failures } = callOwn(spec.scenario, measured);
  for (const f of failures) log(f);
  log(`assertions: ${verdict}`);
  const logs = Object.fromEntries(spec.devices.map((d) => [d, callNarration(id, d)]));
  const observers = await observersOf(seats, { logs });
  await finishObserved(
    id,
    verdict,
    { scenario: spec.scenario, tones, ...measured, failures, callService: srvLines('call-service', since).slice(-60), serverWindowSince: since },
    observers,
    async () => {
      closeSeats(seats);
      // THE CLOSED SEATS COME BACK, once the verdict is on disk: W4 on its tone, W8 as it was.
      for (const seat of spec.closed ?? []) await relaunch(seat, SEAT_TONES[seat] ? mediaFlags(seat) : []).catch((e) => log(`${seat} was NOT reopened: ${String(e?.message ?? e)}`));
    }
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  let consoles = null;
  try {
    consoles = seats ? keepConsoles(id, consoleDump(Object.fromEntries(Object.entries(seats.seat ?? {}).map(([d, s]) => [d, { cx: s?.cx }])))) : null;
  } catch (k) {
    console.error(`[${id}] the seats' consoles could not be kept: ${String(k?.message ?? k)}`);
  }
  record(id, 'ERROR', { ...errorDetail(e), ...(consoles ? { consoles } : {}) });
  closeSeats(seats);
  for (const seat of spec.closed ?? []) await relaunch(seat, SEAT_TONES[seat] ? mediaFlags(seat) : []).catch((k) => log(`${seat} was NOT reopened: ${String(k?.message ?? k)}`));
  process.exit(1);
}
