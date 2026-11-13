#!/usr/bin/env bun
/**
 * Q4 (calls-revival-plan section 14, WP-GC3's first step): DO FRAMES THE APP'S E2E TRANSFORM
 * ENCRYPTED CROSS CLOUDFLARE REALTIME'S RAW SFU INTACT?
 *
 *   CLOUDFLARE_SFU_APP_ID=... CLOUDFLARE_SFU_APP_SECRET=... bun tools/sfu-e2ee-probe/probe.mjs
 *
 * `--frames <n>` audio frames to prove (default 250, five seconds of 20 ms Opus), `--video-frames
 * <n>` (default 150, five seconds at 30 fps), `--audio-only`, `--chrome <path>`, `--keep`.
 *
 * The credentials are read from the ENVIRONMENT ONLY, never from an argument (a process list shows
 * arguments), and neither is ever printed. In CI it runs as the `sfu-probe` job of `scheduled.yml`,
 * which declares the `development` environment and so reads the DEV app's pair - never production's.
 *
 * THE PATH (docs: developers.cloudflare.com/realtime/sfu/https-api/):
 *   1. publisher Chrome: one send-only transceiver per track, the app's sender transform assigned in
 *      the task that created it, a local offer;
 *   2. `POST sessions/new` (session A), `POST sessions/A/tracks/new` with that offer and the tracks as
 *      `location: local` -> Cloudflare's answer, applied;
 *   3. once the publisher's connection is `connected`: `POST sessions/new` (session B), `POST
 *      sessions/B/tracks/new` with the same tracks as `location: remote, sessionId: A` -> Cloudflare's
 *      offer (`requiresImmediateRenegotiation`); the subscriber Chrome answers it, its receiver
 *      transforms assigned in `ontrack`; `PUT sessions/B/renegotiate` with that answer.
 *
 * WHAT IS PROVEN, and by what (`lib.mjs`):
 * - the subscriber's receiver transform - the app's own worker - DECRYPTED at least `--frames` audio
 *   frames (and `--video-frames` VP8 frames, one key frame among them) under the publisher's send
 *   key: a frame that opens was encrypted by the publisher and reached the subscriber through
 *   Cloudflare, the only peer either connection has;
 * - zero frames failed to decrypt, zero transform errors;
 * - the transforms were not bypassed: packets received while the receiver transform was handed no
 *   frame, or opened none, is a FAIL;
 * - and, measured beside the proof: every frame the subscriber's transform was handed is BYTE FOR
 *   BYTE a frame the publisher's transform wrote (`probe-worker.ts` digests both sides).
 *
 * NO CLOCK DECIDES ANYTHING. Every wait ends on a proof of success or of failure: a Chrome exiting,
 * a page or its worker failing, a Cloudflare call refused (HTTP status or `errorCode`), a peer
 * connection reaching `failed`, a frame failing to decrypt, a full proof's worth of packets with no
 * frame opened, audio four times past its proof with no video packet. A run in which nothing at all
 * happens hangs, and the CI job's `timeout-minutes` is the only bound (CLAUDE.md, "termination from
 * a proof").
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome,
  defaultChrome,
  killTree,
  launchChrome,
  serveDirectory,
} from '../headless-chrome/chrome.mjs';
import { brief, compareDigests, failureOf, provenOf } from './lib.mjs';

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const OPTS = {
  frames: Number(opt('frames', '250')),
  videoFrames: Number(opt('video-frames', '150')),
  video: !args.includes('--audio-only'),
};
const CHROME = opt('chrome', defaultChrome());
const KEEP = args.includes('--keep');
const API = 'https://rtc.live.cloudflare.com/v1';
/** How often the driver reads the two pages: a polling period, never a verdict. */
const POLL_MS = 250;

const APP_ID = process.env.CLOUDFLARE_SFU_APP_ID ?? '';
const APP_SECRET = process.env.CLOUDFLARE_SFU_APP_SECRET ?? '';

function say(msg) {
  console.log(`[sfu-q4] ${msg}`);
}

/** Every string this run prints passes here: neither credential can leave in a log line. */
function redact(text) {
  let s = String(text);
  for (const v of [APP_SECRET, APP_ID]) if (v) s = s.split(v).join('***');
  return s;
}

/** The verdict and the measured facts, in the run log and in the job summary when there is one. */
function summarise(lines) {
  for (const l of lines) say(redact(l));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map(redact).join('\n')}\n`);
}

// -------------------------------------------------------------------------------------------------
// Cloudflare Realtime - called from here, with the app secret; the pages only ever see SDP.
// -------------------------------------------------------------------------------------------------

/** One API call. A non-2xx status or an `errorCode` in the body is a named failure. */
async function cf(method, path, body) {
  const res = await fetch(`${API}/apps/${APP_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${APP_SECRET}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare ${method} ${redact(path)} answered ${res.status} with no JSON`);
  }
  if (!res.ok || json.errorCode)
    throw new Error(
      `Cloudflare ${method} ${redact(path)} answered ${res.status}` +
        `${json.errorCode ? ` ${json.errorCode}: ${json.errorDescription ?? ''}` : ''}`
    );
  return json;
}

/** A per-track refusal inside a 200 (Cloudflare reports them per track) is a named failure too. */
function assertTracks(what, json) {
  for (const t of json.tracks ?? [])
    if (t.errorCode)
      throw new Error(
        `${what}: track ${t.trackName ?? t.mid} refused ${t.errorCode}: ${t.errorDescription ?? ''}`
      );
}

// -------------------------------------------------------------------------------------------------

let OUT = '';

function cleanupOut() {
  if (!OUT) return;
  for (const d of readdirSync(OUT)) {
    try {
      rmSync(join(OUT, d), { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    } catch (e) {
      say(`WARN ${d} could not be removed (${e.code}) - delete ${OUT} by hand`);
    }
  }
  rmSync(OUT, { recursive: true, force: true });
}

async function buildPage(www) {
  mkdirSync(www, { recursive: true });
  for (const [entry, name] of [
    [join(HERE, 'page', 'page.ts'), 'page.js'],
    [join(HERE, 'page', 'probe-worker.ts'), 'probe-worker.js'],
  ]) {
    const res = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
    if (!res.success) throw new Error(`build ${entry}: ${res.logs.map(String).join('\n')}`);
    writeFileSync(join(www, name), await res.outputs[0].text());
  }
  writeFileSync(
    join(www, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>q4</title>' +
      '<script type="module" src="/page.js"></script>'
  );
}

const live = new Set();
function onSignal(signal) {
  say(`${signal}: killing ${live.size} Chrome(s)`);
  for (const side of live) killTree(side, { sync: true });
  process.exit(130);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

async function main() {
  if (!APP_ID || !APP_SECRET) {
    summarise([
      'NOT RUN: CLOUDFLARE_SFU_APP_ID and/or CLOUDFLARE_SFU_APP_SECRET is empty - in CI, the job ' +
        'must declare the `development` environment, which holds them',
    ]);
    process.exit(2);
  }
  OUT = mkdtempSync(join(tmpdir(), 'canari-sfu-q4-'));
  say(`proving ${OPTS.frames} audio${OPTS.video ? ` + ${OPTS.videoFrames} VP8 video` : ''} frames`);
  const www = join(OUT, 'www');
  await buildPage(www);
  const server = serveDirectory(www);

  // One key per direction, crossed: the subscriber opens with the publisher's send key.
  const k1 = randomBytes(32).toString('hex');
  const k2 = randomBytes(32).toString('hex');
  const configs = {
    publisher: { role: 'publisher', sendKey: k1, receiveKey: k2, video: OPTS.video },
    subscriber: { role: 'subscriber', sendKey: k2, receiveKey: k1, video: OPTS.video },
  };

  const sides = {};
  const ask = (role, expr) =>
    Promise.race([sides[role].cdp.eval(expr), ...Object.values(sides).map((s) => s.fault)]);
  const both = async () => ({
    pub: await ask('publisher', 'probe.state()'),
    sub: await ask('subscriber', 'probe.state()'),
  });
  let verdict = null;
  const facts = [];
  try {
    for (const role of ['publisher', 'subscriber']) {
      sides[role] = await launchChrome({
        chrome: CHROME,
        name: role,
        profile: join(OUT, `profile-${role}`),
        url: `http://127.0.0.1:${server.port}/`,
        readyTitle: 'probe-ready',
        live,
        keep: KEEP,
        log: say,
        answerMs: Infinity,
        readyMs: Infinity,
        failOnPageError: true,
      });
      await ask(role, `probe.init(${JSON.stringify(configs[role])})`);
    }

    // ---- 1-2. Push: session A takes the publisher's tracks ----
    const offer = await ask('publisher', 'probe.publishOffer()');
    const a = await cf('POST', '/sessions/new');
    const pushed = await cf('POST', `/sessions/${a.sessionId}/tracks/new`, {
      sessionDescription: { type: 'offer', sdp: offer.sdp },
      tracks: offer.tracks.map(({ mid, trackName }) => ({ location: 'local', mid, trackName })),
    });
    assertTracks('push', pushed);
    if (pushed.sessionDescription?.type !== 'answer')
      throw new Error(
        `push: Cloudflare returned no answer (${pushed.sessionDescription?.type ?? 'none'})`
      );
    await ask('publisher', `probe.applyAnswer(${JSON.stringify(pushed.sessionDescription.sdp)})`);
    say(`pushed ${offer.tracks.map((t) => `${t.kind}(mid ${t.mid})`).join(', ')} to session A`);

    // The pull asks for a track Cloudflare is receiving: wait for the publisher's connection.
    for (;;) {
      const st = await ask('publisher', 'probe.state()');
      if (st.fault) throw new Error(`publisher: ${st.fault}`);
      if (st.connectionState === 'failed')
        throw new Error('publisher: the connection to Cloudflare FAILED');
      if (st.connectionState === 'connected') break;
      await Bun.sleep(POLL_MS);
    }
    say('publisher connected to Cloudflare');

    // ---- 3. Pull: session B asks for session A's tracks, renegotiates, answers ----
    const b = await cf('POST', '/sessions/new');
    const pulled = await cf('POST', `/sessions/${b.sessionId}/tracks/new`, {
      tracks: offer.tracks.map(({ trackName }) => ({
        location: 'remote',
        sessionId: a.sessionId,
        trackName,
      })),
    });
    assertTracks('pull', pulled);
    if (!pulled.requiresImmediateRenegotiation || pulled.sessionDescription?.type !== 'offer')
      throw new Error(
        `pull: Cloudflare asked for no renegotiation (requiresImmediateRenegotiation=${pulled.requiresImmediateRenegotiation}, ${pulled.sessionDescription?.type ?? 'no'} description)`
      );
    const answer = await ask(
      'subscriber',
      `probe.answerOffer(${JSON.stringify(pulled.sessionDescription.sdp)})`
    );
    await cf('PUT', `/sessions/${b.sessionId}/renegotiate`, {
      sessionDescription: { type: 'answer', sdp: answer },
    });
    say(`pulled ${pulled.tracks?.length ?? 0} track(s) into session B`);

    // ---- The proof, or a proof of failure ----
    let st;
    for (let poll = 0; ; poll++) {
      st = await both();
      const failed = failureOf(st.pub, st.sub, OPTS);
      if (failed) throw new Error(failed);
      if (provenOf(st.pub, st.sub, OPTS)) {
        say(`PROVEN: ${brief(st.pub, st.sub)}`);
        break;
      }
      if (poll % 8 === 0) say(brief(st.pub, st.sub));
      await Bun.sleep(POLL_MS);
    }

    // ---- Byte identity, measured on what the two taps saw ----
    const pubD = await ask('publisher', 'probe.digests()');
    const subD = await ask('subscriber', 'probe.digests()');
    if (!pubD || !subD) throw new Error('a worker died before handing its digests over');
    const kinds = OPTS.video ? ['audio', 'video'] : ['audio'];
    const cmp = Object.fromEntries(
      kinds.map((k) => [k, compareDigests(pubD.sent[k], subD.received[k])])
    );
    const r = (s) => s.report ?? {};
    facts.push(
      `## Q4 - E2E frames through Cloudflare Realtime's SFU`,
      '',
      `- publisher: encrypted audio=${r(st.pub).encrypted?.audio} video=${r(st.pub).encrypted?.video}; ` +
        `sent codecs audio=${st.pub.outbound.audio?.codec} video=${st.pub.outbound.video?.codec ?? '-'}; ` +
        `pair ${st.pub.pair?.local}/${st.pub.pair?.protocol}->${st.pub.pair?.remote}`,
      `- subscriber: decrypted audio=${r(st.sub).decrypted?.audio} video=${r(st.sub).decrypted?.video}, ` +
        `failed=${r(st.sub).decryptFailures}, keyframes=${r(st.sub).videoKeyframesIn}, ` +
        `transform frames in=${r(st.sub).framesIn?.receiver}; ` +
        `received audio pkts=${st.sub.inbound.audio?.packetsReceived} lost=${st.sub.inbound.audio?.packetsLost}, ` +
        `video pkts=${st.sub.inbound.video?.packetsReceived ?? '-'} decoded=${st.sub.inbound.video?.framesDecoded ?? '-'} ` +
        `codec=${st.sub.inbound.video?.codec ?? '-'}; pair ${st.sub.pair?.local}/${st.sub.pair?.protocol}->${st.sub.pair?.remote}`
    );
    for (const k of kinds) {
      const c = cmp[k];
      facts.push(
        `- ${k}: ${c.matched} of ${c.matched + c.unmatched} received frames byte-identical to a sent one ` +
          `(byteIdentical=${c.byteIdentical}); sent sizes min/median/max ${c.sentSizes.min}/${c.sentSizes.median}/${c.sentSizes.max} B ` +
          `over ${c.sentSizes.count}, received ${c.receivedSizes.min}/${c.receivedSizes.median}/${c.receivedSizes.max} B` +
          (c.unmatched ? `; first unmatched: ${c.unmatchedSamples.join(' ')}` : '')
      );
      if (!c.byteIdentical)
        throw new Error(
          `${k}: ${c.unmatched} frame(s) handed to the receiver transform match no frame the sender wrote - the SFU altered payloads`
        );
    }
    verdict = 'PASS';
  } catch (e) {
    verdict = `FAIL: ${e?.message ?? String(e)}`;
    for (const role of Object.keys(sides)) {
      const log = sides[role].cdp
        ? await Promise.race([
            sides[role].cdp.eval('probe.log()'),
            sides[role].exited.then(() => null),
          ]).catch(() => null)
        : null;
      say(`--- ${role} page log ---\n${redact((log ?? ['(unreadable)']).join('\n'))}`);
    }
  } finally {
    for (const side of Object.values(sides)) {
      await side.cdp?.eval('probe.close()').catch(() => {});
      await closeChrome(side, { live, keep: KEEP, log: say });
    }
    server.stop(true);
    if (KEEP) say(`kept: ${OUT}`);
    else cleanupOut();
  }
  summarise([...facts, '', `**${verdict}**`]);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

try {
  await main();
} catch (e) {
  if (!KEEP) cleanupOut();
  say(redact(`FAIL: ${e?.message ?? String(e)}`));
  process.exit(1);
}
