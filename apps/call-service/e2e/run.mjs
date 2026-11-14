#!/usr/bin/env bun
/**
 * call-service's END-TO-END CALLS (owner decision D3, 2026-11-01): the real `call-service` binary,
 * real headless Chromes and, in CI, a throwaway coturn - and a run passes only on PROOF that
 * encrypted audio crossed the path under test, every way it was owed.
 *
 *   bun apps/call-service/e2e/run.mjs                       # the 1:1 SFU call, host candidates
 *   bun apps/call-service/e2e/run.mjs --scenario mesh       # the 3-party p2p mesh (WP-GC2)
 *   bun apps/call-service/e2e/run.mjs --turn "turn:<ip>:3478?transport=udp" --turn-user u --turn-credential p
 *
 * `--scenario pair|mesh` (default `pair`), `--bin <path>` (default: the crate's debug build),
 * `--chrome <path>` (default: this machine's Chrome), `--frames <n>` (default 250, five seconds of
 * 20 ms Opus), `--keep` (keep the profiles and the logs, named at the end).
 *
 * WHAT `pair` PROVES - two browsers through the SFU (docs/wiki/services/call-service.md#the-end-to-end-call-in-ci):
 *
 * - each browser's ONLY peer connection is to the SFU, and its receiver transform - the app's own
 *   `encryption.worker.ts` - DECRYPTED at least `--frames` audio frames under the receive key, which
 *   is the OTHER browser's send key: a frame that opens was encrypted by the other participant and
 *   reached this one through the SFU, and through nothing else;
 * - no frame failed to decrypt, and the sender transform encrypted at least as many;
 * - with `--turn`, the selected candidate pair is `relay` on both browsers, and the SFU itself runs
 *   relay-only (it does whenever a TURN URL is configured) - every packet went through the TURN
 *   server, as production's media would;
 * - the SFU's own record: `ice connected` and an audio `track published` for both peers, then, after
 *   both hang up, two `session end ... disposition=client-close` lines whose `connected_ms` is a
 *   number - the ledger saw a call that happened, and its end.
 *
 * WHAT `mesh` PROVES - three browsers in a p2p room of 3 seats (WP-GC2), one key per sender (WP-GC1):
 *
 * - EVERY ONE of the 6 directed legs: the receiver's transform for that sender opened at least
 *   `--frames` frames under THAT SENDER's key (the worker's `byPeer` counts), on the peer connection
 *   to that sender, with zero frames that failed to open and zero dropped for want of a key;
 * - with `--turn`, every leg's selected pair is relay to relay;
 * - a FOURTH user, with a valid token for the same room, is refused `room-full` while the three hold
 *   their seats - the cap is the server's, signed into the token;
 * - THE NEGATIVE: one receiver's key for one sender is replaced with random bytes, and that leg -
 *   and only that leg - then fails the very predicate the positive proof used, its frames failing
 *   to open and none opening after the first failure: the per-leg verdict is not vacuous;
 * - the service's record: three `session start ... mode=p2p seats=3`, and after the hangups three
 *   `session end ... mode=p2p disposition=client-close` whose `paired_ms` is a number.
 *
 * NO CLOCK DECIDES ANYTHING. Every wait - the launch and every page call included - ends on a proof
 * of success or on a proof of failure: the service or a browser exiting, a page or its encryption
 * worker failing to load, the service refusing a Join, a signalling socket closing early, a peer
 * connection reaching `failed`, the SFU's ICE reaching `Failed`, a frame failing to decrypt, a full
 * proof's worth of packets received with none decrypted (the transform bypassed), a selected pair
 * that is not relay under `--turn`. After the hangup, a service that holds every closed socket and
 * then writes nothing for 40 reads has failed to record the end. A run in which nothing at all
 * happens and nothing fails hangs, and the CI job's `timeout-minutes` is the only bound - which is
 * the house rule (CLAUDE.md, "termination from a proof").
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeChrome,
  defaultChrome,
  killTree,
  launchChrome,
  serveDirectory,
} from '../../../tools/headless-chrome/chrome.mjs';

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const EXE = process.platform === 'win32' ? 'call-service.exe' : 'call-service';
const BIN = resolve(opt('bin', join(HERE, '..', 'target', 'debug', EXE)));
const CHROME = opt('chrome', defaultChrome());
const FRAMES = Number(opt('frames', '250'));
const TURN = opt('turn', '');
const TURN_USER = opt('turn-user', '');
const TURN_CREDENTIAL = opt('turn-credential', '');
const KEEP = args.includes('--keep');
const SCENARIO = opt('scenario', 'pair');
/**
 * Every file of a run lives in this PRIVATE directory (`mkdtemp`: random name, mode 0700), never at
 * a predictable path under the shared temp dir, where another local user could pre-create or
 * replace it (CodeQL js/insecure-temporary-file). Created by `main`, removed by `cleanupOut`.
 */
let OUT = '';

/** Removes the run directory entry by entry (a Chrome profile can hold a lock for a moment). */
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

/** How often the driver reads the two pages' state: a polling period, never a verdict. */
const POLL_MS = 250;

function say(msg) {
  console.log(`[call-e2e:${SCENARIO}] ${msg}`);
}

if (!['pair', 'mesh'].includes(SCENARIO)) {
  say(`ERROR unknown --scenario ${SCENARIO} (pair | mesh)`);
  process.exit(2);
}

if (TURN && (!TURN_USER || !TURN_CREDENTIAL)) {
  say(
    'ERROR --turn needs --turn-user and --turn-credential (the SFU ignores a TURN_URL without them)'
  );
  process.exit(2);
}

// -------------------------------------------------------------------------------------------------
// Tokens - signed with the secrets this run gives the service, as core-service and
// chat-delivery-service sign theirs (HS256).
// -------------------------------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hs256(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url(sig)}`;
}

const JWT_SECRET = randomBytes(32).toString('hex');
const ROOM_SECRET = randomBytes(32).toString('hex');
const exp = () => Math.floor(Date.now() / 1000) + 3600;

// -------------------------------------------------------------------------------------------------
// The service under test
// -------------------------------------------------------------------------------------------------

/** Every line the service wrote (`NO_COLOR` keeps them plain): the SFU's record is read from it. */
const serviceLog = [];
let service = null;
let serviceExit = null;
let markServiceGone = () => {};
/**
 * Only ever REJECTS, when the service exits or cannot start: every wait on a browser races it, so a
 * service that died is the run's verdict rather than a page that never answers.
 */
const serviceGone = new Promise((_, reject) => {
  markServiceGone = () => reject(new Error(serviceExit));
});
serviceGone.catch(() => {});

/** Starts the service; `pageOrigin` is the one origin its socket upgrades may name. */
function startService(pageOrigin) {
  const env = {
    ...process.env,
    ALLOW_ORIGIN: pageOrigin,
    PORT: '0',
    RUST_LOG: 'info',
    NO_COLOR: '1',
    JWT_SECRET,
    CALL_ROOM_SECRET: ROOM_SECRET,
    // Never Cloudflare from a test: the env path is the one under test. Without `--turn` the SFU
    // falls back to public STUN and its host candidates carry the call (a dev box's mode).
    CLOUDFLARE_CALLS_API_TOKEN: '',
    CLOUDFLARE_TURN_KEY_ID: '',
    TURN_URL: TURN,
    TURN_USERNAME: TURN_USER,
    TURN_CREDENTIAL,
  };
  service = spawn(BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.once('exit', (code, signal) => {
    serviceExit ??= `call-service exited (code ${code}, signal ${signal})`;
    markServiceGone();
  });
  service.once('error', (e) => {
    serviceExit = `call-service could not start: ${String(e)} - build it first (cargo build)`;
    markServiceGone();
  });
  let partial = '';
  const onData = (chunk) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    serviceLog.push(...lines);
  };
  service.stdout.on('data', onData);
  service.stderr.on('data', onData);
}

/** Resolves with the first service line `pick` maps to a value; throws if the service exits first. */
async function serviceLine(pick, what) {
  for (let seen = 0; ;) {
    for (; seen < serviceLog.length; seen++) {
      const v = pick(serviceLog[seen]);
      if (v) return v;
    }
    if (serviceExit) throw new Error(`${serviceExit} before ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

const linesOf = (needle) => serviceLog.filter((l) => l.includes(needle));

// -------------------------------------------------------------------------------------------------
// The page
// -------------------------------------------------------------------------------------------------

async function buildPage(www) {
  mkdirSync(www, { recursive: true });
  for (const [entry, name] of [
    [join(HERE, 'page.ts'), 'page.js'],
    [join(HERE, 'group-page.ts'), 'group-page.js'],
    // The app's own worker, built from source: the transform under test, never a copy.
    [join(HERE, '../../../frontend/src/lib/workers/encryption.worker.ts'), 'encryption.worker.js'],
  ]) {
    const res = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
    if (!res.success) throw new Error(`build ${entry}: ${res.logs.map(String).join('\n')}`);
    writeFileSync(join(www, name), await res.outputs[0].text());
  }
  for (const [html, script] of [
    ['index.html', 'page.js'],
    ['group.html', 'group-page.js'],
  ])
    writeFileSync(
      join(www, html),
      // An empty icon: the browser's own `/favicon.ico` request would 404, and a 404 is a page error.
      '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>e2e</title>' +
        `<script type="module" src="/${script}"></script>`
    );
}

// -------------------------------------------------------------------------------------------------
// The proofs
// -------------------------------------------------------------------------------------------------

/** Why this side's call has FAILED, or null while it may still succeed. */
function failureOf(name, st) {
  if (st.fault) return `${name}: ${st.fault}`;
  const failures = st.report?.decryptFailures ?? 0;
  if (failures > 0) return `${name}: ${failures} frame(s) failed to decrypt`;
  if ((st.report?.transformErrors ?? 0) > 0)
    return `${name}: the transform threw ${st.report.transformErrors} time(s)`;
  // As many packets as the proof needs arrived and the receiver transform opened NONE of them: it is
  // not in the path, and no later packet will route through it - the bypass Chromium makes final
  // when a transform is assigned one task late (CALL-E2E-BYPASS-MI9T).
  if ((st.inbound?.packetsReceived ?? 0) >= FRAMES && (st.report?.decrypted?.audio ?? 0) === 0)
    return (
      `${name}: ${st.inbound.packetsReceived} audio packets received and 0 decrypted - the ` +
      'receiver transform is bypassed (CALL-E2E-BYPASS-MI9T)'
    );
  // Relay-only on both ends: a selected pair that is not relay to relay is a path the run forbade.
  if (TURN && st.pair && (st.pair.local !== 'relay' || st.pair.remote !== 'relay'))
    return `${name}: the selected pair is ${st.pair.local}->${st.pair.remote}, relay->relay owed`;
  return null;
}

/** Whether this side has PROVEN encrypted audio both ways through the SFU. */
function provenOf(st) {
  const r = st.report;
  if (!r) return false;
  const relayOk = !TURN || (st.pair?.local === 'relay' && st.pair?.remote === 'relay');
  return (
    (r.encrypted?.audio ?? 0) >= FRAMES &&
    (r.decrypted?.audio ?? 0) >= FRAMES &&
    (st.inbound?.packetsReceived ?? 0) >= FRAMES &&
    relayOk
  );
}

const brief = (st) =>
  `enc=${st.report?.encrypted?.audio ?? 0} dec=${st.report?.decrypted?.audio ?? 0} ` +
  `failed=${st.report?.decryptFailures ?? 0} rx_pkts=${st.inbound?.packetsReceived ?? 0} ` +
  `pc=${st.connectionState} pair=${st.pair ? `${st.pair.local}/${st.pair.localProtocol}->${st.pair.remote}` : '-'}`;

// -------------------------------------------------------------------------------------------------

const live = new Set();

function onSignal(signal) {
  say(`${signal}: killing ${live.size} Chrome(s) and the service`);
  for (const side of live) killTree(side, { sync: true });
  service?.kill('SIGKILL');
  process.exit(130);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/**
 * Fails the run on the SFU's own proof that a peer of `room` is lost: its ICE agent reached
 * `Failed`. Only `Failed` is final; webrtc-rs reports `Disconnected` on a missed consent check and
 * recovers from it, so that one is logged once, never a verdict.
 */
function checkSfuIce(room, disconnects) {
  for (const l of serviceLog) {
    if (!l.includes(room)) continue;
    if (/\[call\] ice Failed /.test(l))
      throw new Error(`the SFU's ICE gave up: ${l.slice(l.indexOf('[call]'))}`);
    if (/\[call\] ice Disconnected /.test(l) && !disconnects.has(l)) {
      disconnects.add(l);
      say(`transient: ${l.slice(l.indexOf('[call]'))}`);
    }
  }
}

/** Waits until every named page's socket CLOSED: the service answered each Close frame. */
async function awaitClosed(ask, names) {
  for (;;) {
    if (serviceExit) throw new Error(`${serviceExit} before every socket closed`);
    const closed = await Promise.all(names.map((n) => ask(n, 'e2e.closed()')));
    if (closed.every(Boolean)) return;
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Collects the `count` session-end lines of `room` once every socket closed. Each session's line
 * follows its socket's end with nothing in between but the peer connection's close; a service that
 * has every end and then writes NOTHING for QUIET_POLLS reads is stuck in that close or never writes
 * the line - a defect named here, not a wait for the job's timeout. The bound is on silence, never on
 * how long a call took.
 */
async function awaitSessionEnds(room, count) {
  const QUIET_POLLS = 40;
  const ends = [];
  for (let seen = 0, quiet = 0; ends.length < count; quiet++) {
    for (; seen < serviceLog.length; seen++, quiet = 0) {
      const l = serviceLog[seen];
      if (l.includes('[call] session end') && l.includes(room)) ends.push(l);
    }
    if (ends.length >= count) break;
    if (serviceExit) throw new Error(`${serviceExit} before every session end was recorded`);
    if (quiet >= QUIET_POLLS)
      throw new Error(
        `every socket closed, ${ends.length} session end line(s) of ${count} written, and the ` +
          `service has written nothing since (${QUIET_POLLS} reads): it never recorded the end`
      );
    await Bun.sleep(POLL_MS);
  }
  for (const l of ends) say(`record: ${l.slice(l.indexOf('[call]'))}`);
  return ends;
}

// -------------------------------------------------------------------------------------------------
// Scenario `pair`: two browsers through the SFU, one key per direction (`setKeys`)
// -------------------------------------------------------------------------------------------------

async function runPair({ port, iceServers, ask, launch }) {
  const roomId = randomUUID();
  const groupId = randomUUID();
  const users = { caller: `e2e-caller-${randomUUID()}`, callee: `e2e-callee-${randomUUID()}` };
  const configOf = (role) => ({
    ws: `ws://127.0.0.1:${port}/ws`,
    token: hs256({ sub: users[role], exp: exp() }, JWT_SECRET),
    roomId,
    roomToken: hs256(
      { room_id: roomId, sub: users[role], group_id: groupId, exp: exp() },
      ROOM_SECRET
    ),
    role,
    iceServers,
    iceTransportPolicy: TURN ? 'relay' : 'all',
  });
  for (const role of ['caller', 'callee']) {
    await launch(role, '');
    await ask(role, `e2e.start(${JSON.stringify(configOf(role))})`);
    say(`${role} joined room ${roomId}`);
  }

  // ---- Wait for the proof, or for a proof of failure ----
  const room = `room=${roomId}`;
  const disconnects = new Set();
  for (let poll = 0; ; poll++) {
    if (serviceExit) throw new Error(serviceExit);
    checkSfuIce(room, disconnects);
    const st = {};
    for (const role of ['caller', 'callee']) st[role] = await ask(role, 'e2e.state()');
    const failed = Object.entries(st)
      .map(([role, s]) => failureOf(role, s))
      .filter(Boolean);
    if (failed.length) throw new Error(failed.join('; '));
    const line = Object.entries(st)
      .map(([role, s]) => `${role} ${brief(s)}`)
      .join(' | ');
    if (Object.values(st).every(provenOf)) {
      say(`PROVEN: ${line}`);
      break;
    }
    // Progress every eighth read: what a hung run was waiting for is then in its log.
    if (poll % 8 === 0) say(line);
    await Bun.sleep(POLL_MS);
  }

  // ---- The SFU's own record of the call ----
  const connected = linesOf('[call] ice connected').filter((l) => l.includes(room));
  const published = linesOf('[call] track published').filter(
    (l) => l.includes(room) && l.includes('kind=audio')
  );
  if (connected.length < 2)
    throw new Error(
      `the SFU logged ${connected.length} 'ice connected' line(s) for the room, 2 owed`
    );
  if (published.length < 2)
    throw new Error(`the SFU logged ${published.length} audio 'track published' line(s), 2 owed`);
  // The SFU took the TURN server from its env (and with it the relay-only policy), rather than
  // falling back to STUN with host candidates the browsers' `relay` pair would never reach.
  if (TURN && !linesOf('SFU using TURN_URL env').length)
    throw new Error('the SFU never said it uses TURN_URL - it ran without the relay');

  // ---- Both hang up: the record must say so, and say a call happened ----
  for (const role of ['caller', 'callee']) await ask(role, 'e2e.hangup()');
  await awaitClosed(ask, ['caller', 'callee']);
  for (const l of await awaitSessionEnds(room, 2)) {
    if (!l.includes('disposition=client-close'))
      throw new Error(`a session ended with another disposition than client-close: ${l}`);
    if (/connected_ms=-/.test(l)) throw new Error(`a session ended with connected_ms=-: ${l}`);
  }
}

// -------------------------------------------------------------------------------------------------
// Scenario `mesh`: three browsers in a p2p room, one key per sender (`setGroupKeys`)
// -------------------------------------------------------------------------------------------------

/** The seats the mesh room's tokens sign: the three browsers fill it, and a fourth is past it. */
const MESH_SEATS = 3;

/**
 * Why the directed leg `sender -> receiver` has FAILED, or null while it may still succeed. `st` is
 * the RECEIVER's state; the leg is its peer connection to `sender` and its worker's counts for the
 * frames of `sender` (`byPeer`), which it opens with `sender`'s key and no other.
 */
function legFailureOf(receiver, sender, st) {
  const leg = `${sender} -> ${receiver}`;
  const c = st.report?.byPeer?.[sender];
  if ((c?.failed ?? 0) > 0)
    return `${leg}: ${c.failed} frame(s) failed to open under ${sender}'s key`;
  if ((c?.droppedNoKey ?? 0) > 0)
    return `${leg}: ${c.droppedNoKey} frame(s) dropped for want of a key`;
  const l = st.legs?.[sender];
  // As many packets as the proof needs arrived on this leg and its receiver opened NONE of them:
  // the transform is not in the path (CALL-E2E-BYPASS-MI9T).
  if ((l?.inbound?.packetsReceived ?? 0) >= FRAMES && (c?.decrypted ?? 0) === 0)
    return (
      `${leg}: ${l.inbound.packetsReceived} packets received and 0 opened - the receiver ` +
      'transform is bypassed (CALL-E2E-BYPASS-MI9T)'
    );
  if (TURN && l?.pair && (l.pair.local !== 'relay' || l.pair.remote !== 'relay'))
    return `${leg}: the selected pair is ${l.pair.local}->${l.pair.remote}, relay->relay owed`;
  return null;
}

/** Whether the directed leg `sender -> receiver` has PROVEN its encrypted audio. */
function legProvenOf(receiver, sender, st) {
  const c = st.report?.byPeer?.[sender];
  const l = st.legs?.[sender];
  const relayOk = !TURN || (l?.pair?.local === 'relay' && l?.pair?.remote === 'relay');
  return (c?.decrypted ?? 0) >= FRAMES && (l?.inbound?.packetsReceived ?? 0) >= FRAMES && relayOk;
}

/** Why this page as a whole has failed (a fault, a transform that threw, any frame without a key). */
function pageFailureOf(name, st) {
  if (st.fault) return `${name}: ${st.fault}`;
  if ((st.report?.transformErrors ?? 0) > 0)
    return `${name}: the transform threw ${st.report.transformErrors} time(s)`;
  if ((st.report?.droppedNoKey ?? 0) > 0)
    return `${name}: ${st.report.droppedNoKey} frame(s) dropped for want of a key`;
  return null;
}

/** Every directed leg of `users`: [receiver, sender] for each ordered pair of two of them. */
const directedLegs = (users) =>
  users.flatMap((r) => users.filter((s) => s !== r).map((s) => [r, s]));

/** Reads every page's state, keyed by user id. */
async function statesOf(ask, users) {
  const st = {};
  for (const u of users) st[u] = await ask(u, 'e2e.state()');
  return st;
}

/**
 * Joins the room as ONE MORE user over a bare socket - a valid access token and a valid room token
 * for this very room, signing `seats` - and resolves with the service's first answer. The socket's
 * failure or close before an answer rejects: no clock.
 */
function joinAsExtra(port, origin, roomId, groupId, mode, seats) {
  const user = `e2e-extra-${randomUUID()}`;
  const token = hs256({ sub: user, exp: exp() }, JWT_SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, {
    headers: { Origin: origin },
  });
  return new Promise((resolve, reject) => {
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'Join',
          room_id: roomId,
          room_token: hs256(
            { room_id: roomId, sub: user, group_id: groupId, max_seats: seats, exp: exp() },
            ROOM_SECRET
          ),
          mode,
        })
      );
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      ws.close(1000);
      resolve(frame);
    };
    ws.onerror = () => reject(new Error('the extra user socket failed before any answer'));
    ws.onclose = (e) =>
      reject(new Error(`the extra user socket closed (code ${e.code}) before any answer`));
  });
}

/** Proves that one more user, past the signed cap of `seats`, is refused `room-full`. */
async function provePastTheCap({ port, origin }, roomId, groupId, mode, seats) {
  const answer = await Promise.race([
    joinAsExtra(port, origin, roomId, groupId, mode, seats),
    serviceGone,
  ]);
  if (answer.type !== 'Refused' || answer.reason !== 'room-full')
    throw new Error(`the user past ${seats} seats got ${JSON.stringify(answer)}, room-full owed`);
  say(`the user past ${seats} seats: ${JSON.stringify(answer)}`);
}

/**
 * Waits until EVERY directed leg of `users` proved its sender's frames, failing at the first leg or
 * page that proves the run failed. `extra(st)` adds a scenario's own failure reasons.
 */
async function proveEveryLeg(ask, users, extra = () => []) {
  const legs = directedLegs(users);
  const short = (u) => u.slice(0, 12);
  for (let poll = 0; ; poll++) {
    if (serviceExit) throw new Error(serviceExit);
    const st = await statesOf(ask, users);
    const failed = [
      ...extra(st),
      ...users.map((u) => pageFailureOf(u, st[u])),
      ...legs.map(([r, s]) => legFailureOf(r, s, st[r])),
    ].filter(Boolean);
    if (failed.length) throw new Error(failed.join('; '));
    const line = legs
      .map(([r, s]) => `${short(s)}->${short(r)} ${st[r].report?.byPeer?.[s]?.decrypted ?? 0}`)
      .join(' | ');
    const encOk = users.every((u) => (st[u].report?.encrypted?.audio ?? 0) >= FRAMES);
    if (encOk && legs.every(([r, s]) => legProvenOf(r, s, st[r]))) {
      say(`PROVEN, all ${legs.length} directed legs: ${line}`);
      return;
    }
    if (poll % 8 === 0) say(`opened per leg: ${line}`);
    await Bun.sleep(POLL_MS);
  }
}

/**
 * THE NEGATIVE: `victim`'s receive key for `wronged` is replaced with random bytes, and that leg -
 * and only that leg - must then fail the predicate the positive proof used. After the FIRST frame
 * that fails under the wrong key nothing of that leg may open again: a receiver transform handles
 * its frames one at a time, so every later frame met the new key.
 */
async function proveWrongKeyFails(ask, users, victim, wronged) {
  await ask(victim, `e2e.rekeyWrong(${JSON.stringify(wronged)})`);
  const legs = directedLegs(users).filter(([r, s]) => !(r === victim && s === wronged));
  let firstFailure = null;
  for (let poll = 0; ; poll++) {
    if (serviceExit) throw new Error(serviceExit);
    const st = await statesOf(ask, users);
    const pageFailed = users.map((u) => pageFailureOf(u, st[u])).filter(Boolean);
    if (pageFailed.length) throw new Error(pageFailed.join('; '));
    const others = legs.map(([r, s]) => legFailureOf(r, s, st[r])).filter(Boolean);
    if (others.length)
      throw new Error(`a leg the negative did not touch failed: ${others.join('; ')}`);
    const c = st[victim].report?.byPeer?.[wronged] ?? { decrypted: 0, failed: 0 };
    if (c.failed > 0 && !firstFailure) {
      firstFailure = { ...c };
      say(`negative: a frame of ${wronged} failed on ${victim} (${c.decrypted} opened before)`);
    }
    if (firstFailure && c.decrypted > firstFailure.decrypted)
      throw new Error(
        `negative: ${c.decrypted - firstFailure.decrypted} frame(s) of ${wronged} opened on ` +
          `${victim} under a RANDOM key - the receive key is not what opens the leg`
      );
    if (firstFailure && c.failed - firstFailure.failed >= FRAMES) {
      const verdict = legFailureOf(victim, wronged, st[victim]);
      if (!verdict) throw new Error('negative: the leg stopped opening and its verdict passed it');
      say(`NEGATIVE PROVEN: ${verdict}`);
      return;
    }
    if (poll % 8 === 0)
      say(`negative: ${wronged} -> ${victim} opened=${c.decrypted} failed=${c.failed}`);
    await Bun.sleep(POLL_MS);
  }
}

async function runMesh(ctx) {
  const { port, iceServers, ask, launch } = ctx;
  const roomId = randomUUID();
  const groupId = randomUUID();
  // Lowercase, as the signalling and the key contexts name a participant (`senderContext`).
  const users = [0, 1, 2].map((i) => `e2e-mesh-${i}-${randomUUID()}`);
  const exporterSecret = randomBytes(32).toString('hex');
  const configOf = (user) => ({
    ws: `ws://127.0.0.1:${port}/ws`,
    token: hs256({ sub: user, exp: exp() }, JWT_SECRET),
    roomId,
    roomToken: hs256(
      { room_id: roomId, sub: user, group_id: groupId, max_seats: MESH_SEATS, exp: exp() },
      ROOM_SECRET
    ),
    groupId,
    self: user,
    participants: users,
    exporterSecret,
    iceServers,
    iceTransportPolicy: TURN ? 'relay' : 'all',
    mode: 'mesh',
  });
  for (const user of users) {
    await launch(user, 'group.html');
    await ask(user, `e2e.start(${JSON.stringify(configOf(user))})`);
    say(`${user} joined room ${roomId}`);
  }

  await proveEveryLeg(ask, users);
  await provePastTheCap(ctx, roomId, groupId, 'p2p', MESH_SEATS);
  await proveWrongKeyFails(ask, users, users[0], users[1]);

  // ---- Everyone hangs up: the record must say three seats were paired, and ended ----
  const room = `room=${roomId}`;
  const starts = linesOf('[call] session start').filter(
    (l) => l.includes(room) && l.includes(`mode=p2p seats=${MESH_SEATS}`)
  );
  if (starts.length !== users.length)
    throw new Error(
      `the service logged ${starts.length} p2p session start(s), ${users.length} owed`
    );
  for (const u of users) await ask(u, 'e2e.expectEnd()');
  for (const u of users) await ask(u, 'e2e.hangup()');
  await awaitClosed(ask, users);
  for (const l of await awaitSessionEnds(room, users.length)) {
    if (!l.includes('mode=p2p') || !l.includes('disposition=client-close'))
      throw new Error(`a seat ended otherwise than a p2p client-close: ${l}`);
    if (/paired_ms=-/.test(l)) throw new Error(`a seat ended never paired: ${l}`);
  }
}

// -------------------------------------------------------------------------------------------------

async function main() {
  OUT = mkdtempSync(join(tmpdir(), 'canari-call-e2e-'));
  say(`service ${BIN}`);
  say(TURN ? `relay-only through ${TURN} (every browser and the SFU)` : 'no TURN: host candidates');
  const www = join(OUT, 'www');
  await buildPage(www);
  const server = serveDirectory(www);
  const origin = `http://127.0.0.1:${server.port}`;
  startService(origin);
  const port = await serviceLine(
    (l) => /Call service listening on .*:(\d+)\s*$/.exec(l)?.[1],
    'its listening line'
  );
  say(`call-service listening on port ${port}`);
  const iceServers = TURN ? [{ urls: TURN, username: TURN_USER, credential: TURN_CREDENTIAL }] : [];

  const sides = {};
  /**
   * Evaluates `expr` in one page, raced against every proof that no answer can come: any Chrome
   * exiting or its page failing (`side.fault`), and the service exiting. A page that throws at
   * load, a Chrome that crashes, a service that dies - each ends the wait at once, named.
   */
  const ask = (name, expr) =>
    Promise.race([
      sides[name].cdp.eval(expr),
      serviceGone,
      ...Object.values(sides).map((s) => s.fault),
    ]);
  /** Launches one participant's Chrome on `page` (`''` is the 1:1 page). */
  const launch = async (name, page) => {
    sides[name] = await launchChrome({
      chrome: CHROME,
      name,
      profile: join(OUT, `profile-${name}`),
      url: `${origin}/${page}`,
      readyTitle: 'e2e-ready',
      live,
      keep: KEEP,
      log: say,
      // No clock: the launch and every eval end on a proof (`fault`, `abortOn`, `ask`).
      answerMs: Infinity,
      readyMs: Infinity,
      failOnPageError: true,
      abortOn: serviceGone,
    });
  };
  const ctx = { port, origin, iceServers, ask, launch };
  let verdict = null;
  try {
    if (SCENARIO === 'mesh') await runMesh(ctx);
    else await runPair(ctx);
    verdict = 'PASS';
  } catch (e) {
    verdict = `FAIL: ${e?.message ?? String(e)}`;
    for (const name of Object.keys(sides)) {
      // A Chrome that exited answers nothing: its log is then unreadable, never awaited.
      const log = sides[name].cdp
        ? await Promise.race([
            sides[name].cdp.eval('e2e.log()'),
            sides[name].exited.then(() => null),
          ]).catch(() => null)
        : null;
      say(`--- ${name} page log ---\n${(log ?? ['(unreadable)']).join('\n')}`);
    }
    say(`--- call-service log (last 80 lines) ---\n${serviceLog.slice(-80).join('\n')}`);
  } finally {
    for (const side of Object.values(sides))
      await closeChrome(side, { live, keep: KEEP, log: say });
    service?.kill('SIGKILL');
    server.stop(true);
    if (KEEP) {
      writeFileSync(join(OUT, 'call-service.log'), serviceLog.join('\n'));
      say(`kept: ${OUT}`);
    } else {
      cleanupOut();
    }
  }
  say(verdict);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

try {
  await main();
} catch (e) {
  // A failure before `main`'s own `finally` (page build, service start) must not leave the run
  // directory behind either; the error still surfaces.
  if (!KEEP) cleanupOut();
  throw e;
}
