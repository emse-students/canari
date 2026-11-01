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
 * seat's fake microphone is sampled in its own page (one `getUserMedia`, frames of an FFT, the peak
 * frequency and how far its level swings). A seat not on its `SEAT_TONES` frequency, or not PULSED,
 * is relaunched on a WAV of it (`--use-file-for-fake-audio-capture`) and its encryption gate passed
 * again; a seat still off its tone after that is an ERROR, never a row played on a shared beep
 * (CALL-WEB-2's six rig FAILs) or on a steady one a noise suppressor may learn.
 *
 * AND EACH ROW READS THE CALL'S RECORD IN THE CONVERSATION (B15, `RECORD_SEATS`): the newest system
 * pill of the DM on each end, once it has finalised - an answered call must read as one that lasted,
 * an unanswered one must not.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { subjectFor } from '../accounts.mjs';
import { pin } from '../atoms.mjs';
import { CALL_SOCKET_PATH, CALL_WEB_ROWS, FLOW_SECONDS, RECORD_SEATS, ROUND_MS, SEAT_TONES, UNANSWERED_ROUNDS, WAIT_ROUNDS, callNarration, callOwn, recordForm, toneWav } from '../callrows.mjs';
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

/**
 * This page's fake microphone, read once and closed again: its peak frequency in Hz, and how far the
 * level of that frequency swings between frames in dB - the PULSE (callrows.mjs toneWav). A steady
 * tone swings by almost nothing, so `swingDb` is what tells a seat on the pulsed file from one still
 * on a steady file with the same frequency. No smoothing, and frames shorter than the pulse's
 * silence, so some frames fall wholly in one.
 */
const PEAK = `(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0;
  ac.createMediaStreamSource(s).connect(an);
  const bins = new Float32Array(an.frequencyBinCount);
  const frames = [];
  for (let f = 0; f < 24; f++) {
    await new Promise((r) => setTimeout(r, 60));
    an.getFloatFrequencyData(bins);
    frames.push(Float32Array.from(bins));
  }
  s.getTracks().forEach((t) => t.stop());
  await ac.close();
  let best = 1;
  let bestDb = -Infinity;
  for (const fr of frames) for (let i = 1; i < fr.length; i++) if (fr[i] > bestDb) { bestDb = fr[i]; best = i; }
  const levels = frames.map((fr) => (Number.isFinite(fr[best]) ? fr[best] : -200));
  return { hz: Math.round((best * ac.sampleRate) / an.fftSize), swingDb: Math.round(Math.max(...levels) - Math.min(...levels)) };
})()`;
/** Within one FFT bin either side at 48 kHz / 4096 (11.7 Hz), with room for the window. */
const TONE_TOLERANCE_HZ = 20;
/** The least swing a pulsed tone shows between a frame in a pulse and a frame in a silence. */
const PULSE_SWING_DB = 20;

async function peakOf(seat) {
  const [target] = resolveDevices(['--device', seat]);
  const c = await client(target.port, tabMatchFor(target), { focus: false });
  try {
    return await evaluate(c, PEAK);
  } finally {
    c.close();
  }
}

/**
 * The WAV a seat's fake microphone plays, under `STATE_DIR`, REWRITTEN on every call: Chrome reopens
 * the file at each capture, so a running seat picks a new tone up at its next call without a relaunch.
 */
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

/** Every seat of the row on its own PULSED tone - read, relaunched once if not, an ERROR if still not. */
async function tonesSet() {
  const read = {};
  const onTone = (p, want) => p !== null && Math.abs(p.hz - want) <= TONE_TOLERANCE_HZ && p.swingDb >= PULSE_SWING_DB;
  for (const seat of spec.devices) {
    const want = SEAT_TONES[seat];
    wavOf(seat);
    let p = await peakOf(seat).catch(() => null);
    if (!onTone(p, want)) {
      log(`${seat} captures ${JSON.stringify(p)}, not its pulsed ${want} Hz - relaunching it on its tone`);
      await relaunch(seat, mediaFlags(seat));
      p = await peakOf(seat);
    }
    if (!onTone(p, want)) throw new Error(`${seat} captures ${JSON.stringify(p)} after its relaunch, not its pulsed ${want} Hz (swing >= ${PULSE_SWING_DB} dB)`);
    read[seat] = p;
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

// ── the call's record in the conversation (B15) ─────────────────────────────────────────────────────

/** The system pills of the open thread, in order (`ChatMessageGroups.svelte` centres each in `my-3 flex justify-center`). */
const PILLS = `[...document.querySelectorAll('div.my-3.flex.justify-center')].map((e) => e.innerText.trim()).filter(Boolean)`;
const nameOf = (seat) => displayNameOf(subjectFor(resolveDevices(['--device', seat])[0].account));

/** Each record seat on its DM, and how many pills that DM held before the row's call. */
async function recordsBefore(plan) {
  const before = {};
  for (const [seat, other] of Object.entries(plan ?? {})) {
    await openConversation(cx(seat), nameOf(other));
    before[seat] = (await evaluate(cx(seat), PILLS)).length;
  }
  return before;
}

/**
 * The row's record on each seat: the newest pill once the DM holds one more than before the call
 * and it is no longer a bare "started" - a record finalises when the end reaches it, so this waits
 * on that fact, in rounds. `null` when no new pill came at all.
 */
async function recordsAfter(plan, before) {
  const out = {};
  for (const [seat, other] of Object.entries(plan ?? {})) {
    await openConversation(cx(seat), nameOf(other));
    let last = null;
    await rounds(async () => {
      const pills = await evaluate(cx(seat), PILLS);
      last = pills.length > before[seat] ? pills[pills.length - 1] : null;
      return last !== null && recordForm(last) !== 'started';
    });
    out[seat] = last;
  }
  return out;
}

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

  const plan = RECORD_SEATS[spec.scenario] ?? null;
  const pillsBefore = await recordsBefore(plan);
  const played = await PLAY[spec.scenario](calleeName);
  const measured = filled(spec.scenario, { ...played, ...(plan ? { records: await recordsAfter(plan, pillsBefore) } : {}) });
  const { verdict, failures } = callOwn(spec.scenario, measured);
  for (const f of failures) log(f);
  log(`assertions: ${verdict}`);
  const logs = Object.fromEntries(spec.devices.map((d) => [d, callNarration(id, d)]));
  // THE CALL SOCKET'S OWN CLOSE IS THE HANG-UP (`forgivingSocketCloses`): every seat of the row may close `/api/call`, nothing else.
  const sockets = Object.fromEntries(spec.devices.map((d) => [d, [CALL_SOCKET_PATH]]));
  const observers = await observersOf(seats, { logs, sockets });
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
