#!/usr/bin/env bun
/**
 * A desktop Chrome as the OTHER END of a phone call, and the receiver's numbers read from it.
 *
 * WHY (2026-10-19): a Mi 9T hearing an iPhone logged NetEq decode errors on 29 % of packets, and
 * neither phone can say which side is at fault - the iPhone's log cannot be paged from the bench,
 * the Mi 9T's peer connection is not reachable from its page. A desktop Chrome is the engine the
 * call-audio rig measured clean (`tools/call-audio-fidelity`), so it is the known-good counterpart:
 * the phone that sounds wrong FROM it, or makes it conceal, is the faulty one. This was done by
 * hand once; this script makes it one command.
 *
 * What it does, on one of the harness profiles (`launch.mjs`, the profile signed in on the estate
 * the phone uses):
 *   1. `--launch` starts that profile with a FAKE microphone (Chrome's beep, or `--wav <file>`) so
 *      the phone hears something known; without it, it attaches to the running profile as is;
 *   2. tracks every `RTCPeerConnection` the page creates (a subclass installed before the app
 *      loads - the app's own service is not reachable from the page), then reloads;
 *   3. `--dial` presses the conversation header's audio-call button (the conversation must be open
 *      on screen), `--accept` presses Accept when the phone rings this side;
 *   4. once a peer connection is `connected`, samples `getStats()` every second for `--seconds`
 *      (default 60) or until the call ends, and prints a line every 5 s: packets, loss, CONCEALED %,
 *      jitter, level, codec;
 *   5. writes every sample and every `[Call]` console line (the E2E worker report included) to
 *      `--out` (default: the OS temp dir) and prints the totals; `--hangup` ends the call after.
 *
 *   bun callpeer.mjs --browser w3 --launch --url https://dev.canari-emse.fr/chat --accept --seconds 60
 *   bun callpeer.mjs --browser w2 --dial --hangup
 *
 * Reads the button labels from `frontend/messages/fr.json`, never a copy: a renamed label is then a
 * failed lookup here, not a silent wait for a button that no longer exists.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, evaluate, listTargets, realClick, reloadAndWait } from './cdp.mjs';
import { BROWSERS, isUp, startBrowser } from './launch.mjs';
import { SITE } from './names.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const WHICH = opt('browser', 'w3');
const URL_ = opt('url', `${SITE}/chat`);
const SECONDS = Number(opt('seconds', '60'));
const WAV = opt('wav', '');
const OUT = opt('out', join(tmpdir(), `callpeer-${WHICH}-${Date.now()}.json`));
const CONNECT_WAIT_MS = 120_000;

function say(msg) {
  console.log(`[callpeer] ${msg}`);
}

/** The French UI label of a Paraglide key, read from the app's own catalogue. */
function label(key) {
  const fr = JSON.parse(
    readFileSync(new URL('../../frontend/messages/fr.json', import.meta.url), 'utf8')
  );
  if (typeof fr[key] !== 'string')
    throw new Error(`no message ${key} in frontend/messages/fr.json`);
  return fr[key];
}

/**
 * Installed before the app's scripts: every peer connection the page makes is kept in
 * `window.__callPeerPcs`. A subclass, so `instanceof` and every method stay the engine's.
 */
export const TRACK_PCS = `(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || Native.__callPeerTracked) return;
  const pcs = [];
  window.__callPeerPcs = pcs;
  class Tracked extends Native {
    constructor(...a) { super(...a); pcs.push(this); }
  }
  Tracked.__callPeerTracked = true;
  window.RTCPeerConnection = Tracked;
})()`;

/** Page-side: one flat sample of the newest connected peer connection, or its state. */
export const SAMPLE = `(async () => {
  const pcs = window.__callPeerPcs || [];
  const pc = [...pcs].reverse().find((p) => p.connectionState !== 'closed');
  if (!pc) return { state: pcs.length ? 'closed' : 'none' };
  const out = { state: pc.connectionState, t: performance.now() / 1000 };
  if (pc.connectionState !== 'connected') return out;
  const r = await pc.getStats();
  const byId = new Map();
  r.forEach((v) => byId.set(v.id, v));
  r.forEach((v) => {
    if (v.type === 'inbound-rtp' && v.kind === 'audio') {
      const c = byId.get(v.codecId) || {};
      Object.assign(out, {
        packetsReceived: v.packetsReceived, packetsLost: v.packetsLost, jitter: v.jitter,
        concealedSamples: v.concealedSamples, silentConcealedSamples: v.silentConcealedSamples,
        totalSamplesReceived: v.totalSamplesReceived, audioLevel: v.audioLevel,
        inserted: v.insertedSamplesForDeceleration, removed: v.removedSamplesForAcceleration,
        bytesReceived: v.bytesReceived, inCodec: c.mimeType + '/' + c.payloadType, inFmtp: c.sdpFmtpLine,
      });
    }
    if (v.type === 'outbound-rtp' && v.kind === 'audio') {
      Object.assign(out, { packetsSent: v.packetsSent, outCodec: (byId.get(v.codecId) || {}).mimeType });
    }
    if (v.type === 'candidate-pair' && v.nominated && v.state === 'succeeded') {
      const l = byId.get(v.localCandidateId) || {};
      const rm = byId.get(v.remoteCandidateId) || {};
      out.pair = l.candidateType + '->' + rm.candidateType;
    }
  });
  return out;
})()`;

/** Concealed share of the samples received between two stats samples, %. */
function concealedPct(a, b) {
  const recv = (b.totalSamplesReceived ?? 0) - (a.totalSamplesReceived ?? 0);
  if (recv <= 0) return null;
  return Math.round((((b.concealedSamples ?? 0) - (a.concealedSamples ?? 0)) / recv) * 1000) / 10;
}

/** Waits for an element by CSS selector, then clicks it for real. */
async function clickWhenThere(cx, selector, what, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(cx, `!!document.querySelector(${JSON.stringify(selector)})`)) {
      await realClick(cx, selector);
      say(`pressed ${what}`);
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`${what} (${selector}) never appeared in ${timeoutMs} ms`);
}

async function main() {
  const { port } = BROWSERS[WHICH] ?? {};
  if (!port) throw new Error(`unknown --browser ${WHICH} (one of ${Object.keys(BROWSERS)})`);
  if (flag('launch')) {
    // A fake microphone cannot be given to a running browser: the flags are read at start.
    if (await isUp(WHICH)) {
      throw new Error(`${WHICH} is already up - close it first (bun launch.mjs close ${WHICH})`);
    }
    const mic = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
    if (WAV) mic.push(`--use-file-for-fake-audio-capture=${WAV}`);
    say(`starting ${WHICH} with a fake microphone (${WAV || "Chrome's beep"}) on ${URL_}`);
    await startBrowser(WHICH, URL_, mic);
  } else if (!(await isUp(WHICH))) {
    throw new Error(`${WHICH} is not up - start it, or pass --launch`);
  }
  const [target] = await listTargets(port, 5_000);
  if (!target) throw new Error(`${WHICH} has no page target`);
  const cx = connect(target.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  await cx.send('Page.enable');
  await cx.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACK_PCS });
  await reloadAndWait(cx);
  say(`tracking peer connections on ${await evaluate(cx, 'location.href')}`);

  if (flag('dial')) {
    await clickWhenThere(
      cx,
      `[aria-label="${label('chat_audio_call_label')}"]`,
      'the audio-call button',
      30_000
    );
  }
  if (flag('accept')) {
    say('waiting for the phone to ring this side');
    await clickWhenThere(
      cx,
      `[aria-label="${label('call_accept_incoming_label')}"]`,
      'Accept',
      CONNECT_WAIT_MS
    );
  }

  const t0 = Date.now();
  let s = await evaluate(cx, SAMPLE);
  while (s.state !== 'connected') {
    if (Date.now() - t0 > CONNECT_WAIT_MS) {
      throw new Error(`no connected peer connection in ${CONNECT_WAIT_MS} ms (last: ${s.state})`);
    }
    await Bun.sleep(500);
    s = await evaluate(cx, SAMPLE);
  }
  say(`connected (${s.pair ?? '?'}); sampling for ${SECONDS} s`);

  const samples = [s];
  for (let i = 1; i <= SECONDS; i++) {
    await Bun.sleep(1000);
    s = await evaluate(cx, SAMPLE);
    if (s.state !== 'connected') {
      say(`the call left 'connected' (${s.state}) after ${i} s`);
      break;
    }
    samples.push(s);
    if (i % 5 === 0) {
      const a = samples.at(-6) ?? samples[0];
      say(
        `t=${i}s pkts +${(s.packetsReceived ?? 0) - (a.packetsReceived ?? 0)} lost +${(s.packetsLost ?? 0) - (a.packetsLost ?? 0)} concealed ${concealedPct(a, s) ?? '-'}% jitter ${Math.round((s.jitter ?? 0) * 1000)} ms level ${(s.audioLevel ?? 0).toFixed(3)} ${s.inCodec ?? '?'}`
      );
    }
  }

  if (flag('hangup')) {
    await clickWhenThere(cx, `[aria-label="${label('call_hang_up_label')}"]`, 'hang up', 10_000);
    // The worker's end-of-call report is written after the cleanup (1.5 s, plus its answer).
    await Bun.sleep(4_000);
  }

  const callLines = cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    .filter((l) => l.includes('[Call]'));
  // Skip the first 3 s: the jitter buffer fills and NetEq conceals by design while it does.
  const first = samples[Math.min(3, samples.length - 1)];
  const last = samples.at(-1);
  const totals = {
    seconds: samples.length - 1,
    codec: last.inCodec,
    fmtp: last.inFmtp,
    pair: last.pair,
    packetsReceived: (last.packetsReceived ?? 0) - (first.packetsReceived ?? 0),
    packetsLost: (last.packetsLost ?? 0) - (first.packetsLost ?? 0),
    concealedPct: concealedPct(first, last),
  };
  writeFileSync(
    OUT,
    JSON.stringify({ browser: WHICH, url: URL_, totals, samples, callLines }, null, 2)
  );
  say(`totals ${JSON.stringify(totals)}`);
  for (const l of callLines.filter((x) => /E2E|ERROR/.test(x))) say(`  ${l}`);
  say(`written ${OUT}`);
  cx.close();
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`[callpeer] ERROR ${e?.stack ?? String(e)}`);
    process.exit(1);
  });
