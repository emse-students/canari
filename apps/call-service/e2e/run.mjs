#!/usr/bin/env bun
/**
 * THE SFU'S END-TO-END CALL (owner decision D3, 2026-11-01): the real `call-service` binary, two
 * real headless Chromes and, in CI, a throwaway coturn - and the run passes only on PROOF that
 * encrypted audio crossed the SFU in both directions.
 *
 *   bun apps/call-service/e2e/run.mjs                       # STUN-less, host candidates (a dev box)
 *   bun apps/call-service/e2e/run.mjs --turn "turn:<ip>:3478?transport=udp" --turn-user u --turn-credential p
 *
 * `--bin <path>` (default: the crate's debug build), `--chrome <path>` (default: this machine's
 * Chrome), `--frames <n>` (default 250, five seconds of 20 ms Opus), `--keep` (keep the profiles
 * and the logs, named at the end).
 *
 * WHAT IS PROVEN, and by what (docs/wiki/services/call-service.md#the-end-to-end-call-in-ci):
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
 * NO CLOCK DECIDES ANYTHING. Every wait - the launch and every page call included - ends on a proof
 * of success or on a proof of failure: the service or a browser exiting, a page or its encryption
 * worker failing to load, the service refusing a Join, a signalling socket closing early, a peer
 * connection reaching `failed`, the SFU's ICE reaching `Failed`, a frame failing to decrypt, a full
 * proof's worth of packets received with none decrypted (the transform bypassed), a selected pair
 * that is not relay under `--turn`. After the hangup, a service that holds both closed sockets and
 * then writes nothing for 40 reads has failed to record the end. A run in which nothing at all
 * happens and nothing fails hangs, and the CI job's `timeout-minutes` is the only bound - which is
 * the house rule (CLAUDE.md, "termination from a proof").
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const OUT = join(tmpdir(), `canari-sfu-e2e-${process.pid}`);

/** How often the driver reads the two pages' state: a polling period, never a verdict. */
const POLL_MS = 250;

function say(msg) {
  console.log(`[sfu-e2e] ${msg}`);
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

function startService() {
  const env = {
    ...process.env,
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
    // The app's own worker, built from source: the transform under test, never a copy.
    [join(HERE, '../../../frontend/src/lib/workers/encryption.worker.ts'), 'encryption.worker.js'],
  ]) {
    const res = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
    if (!res.success) throw new Error(`build ${entry}: ${res.logs.map(String).join('\n')}`);
    writeFileSync(join(www, name), await res.outputs[0].text());
  }
  writeFileSync(
    join(www, 'index.html'),
    // An empty icon: the browser's own `/favicon.ico` request would 404, and a 404 is a page error.
    '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>e2e</title>' +
      '<script type="module" src="/page.js"></script>'
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  say(`service ${BIN}`);
  say(TURN ? `relay-only through ${TURN} (both browsers and the SFU)` : 'no TURN: host candidates');
  const www = join(OUT, 'www');
  await buildPage(www);
  const server = serveDirectory(www);
  startService();
  const port = await serviceLine(
    (l) => /Call service listening on .*:(\d+)\s*$/.exec(l)?.[1],
    'its listening line'
  );
  say(`call-service listening on port ${port}`);

  const roomId = randomUUID();
  const groupId = randomUUID();
  const users = { caller: `e2e-caller-${randomUUID()}`, callee: `e2e-callee-${randomUUID()}` };
  const iceServers = TURN ? [{ urls: TURN, username: TURN_USER, credential: TURN_CREDENTIAL }] : [];
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

  const sides = {};
  /**
   * Evaluates `expr` in one page, raced against every proof that no answer can come: either Chrome
   * exiting or its page failing (`side.fault`), and the service exiting. A page that throws at
   * load, a Chrome that crashes, a service that dies - each ends the wait at once, named.
   */
  const ask = (role, expr) =>
    Promise.race([
      sides[role].cdp.eval(expr),
      serviceGone,
      ...Object.values(sides).map((s) => s.fault),
    ]);
  let verdict = null;
  try {
    for (const role of ['caller', 'callee']) {
      sides[role] = await launchChrome({
        chrome: CHROME,
        name: role,
        profile: join(OUT, `profile-${role}`),
        url: `http://127.0.0.1:${server.port}/`,
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
      await ask(role, `e2e.start(${JSON.stringify(configOf(role))})`);
      say(`${role} joined room ${roomId}`);
    }

    // ---- Wait for the proof, or for a proof of failure ----
    const room = `room=${roomId}`;
    const disconnects = new Set();
    for (let poll = 0; ; poll++) {
      if (serviceExit) throw new Error(serviceExit);
      // The SFU's side of the same proof: its ICE agent gave up on a peer of this room. Only
      // `Failed` is final; webrtc-rs reports `Disconnected` on a missed consent check and recovers
      // from it, so that one is logged, never a verdict.
      for (const l of serviceLog) {
        if (!l.includes(room)) continue;
        if (/\[call\] ice Failed /.test(l))
          throw new Error(`the SFU's ICE gave up: ${l.slice(l.indexOf('[call]'))}`);
        if (/\[call\] ice Disconnected /.test(l) && !disconnects.has(l)) {
          disconnects.add(l);
          say(`transient: ${l.slice(l.indexOf('[call]'))}`);
        }
      }
      const st = {};
      for (const role of Object.keys(sides)) st[role] = await ask(role, 'e2e.state()');
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
    // First the proof that the service has both ends: each page's socket CLOSED, which the
    // close handshake reaches only once the service answered the Close frame.
    for (;;) {
      if (serviceExit) throw new Error(`${serviceExit} before both sockets closed`);
      const closed = await Promise.all(['caller', 'callee'].map((r) => ask(r, 'e2e.closed()')));
      if (closed.every(Boolean)) break;
      await Bun.sleep(POLL_MS);
    }
    // Then its record. Each session's line follows its socket's end with nothing in between but
    // the peer connection's close; a service that has both ends and then writes NOTHING for
    // QUIET_POLLS reads is stuck in that close or never writes the line - a defect named here,
    // not a wait for the job's timeout. The bound is on silence, never on how long a call took.
    const QUIET_POLLS = 40;
    const ends = [];
    for (let seen = 0, quiet = 0; ends.length < 2; quiet++) {
      for (; seen < serviceLog.length; seen++, quiet = 0) {
        const l = serviceLog[seen];
        if (l.includes('[call] session end') && l.includes(room)) ends.push(l);
      }
      if (ends.length >= 2) break;
      if (serviceExit) throw new Error(`${serviceExit} before both session ends were recorded`);
      if (quiet >= QUIET_POLLS)
        throw new Error(
          `both sockets closed, ${ends.length} session end line(s) of 2 written, and the service ` +
            `has written nothing since (${QUIET_POLLS} reads): it never recorded the end`
        );
      await Bun.sleep(POLL_MS);
    }
    for (const l of ends) {
      say(`record: ${l.slice(l.indexOf('[call]'))}`);
      if (!l.includes('disposition=client-close'))
        throw new Error(`a session ended with another disposition than client-close: ${l}`);
      if (/connected_ms=-/.test(l)) throw new Error(`a session ended with connected_ms=-: ${l}`);
    }
    verdict = 'PASS';
  } catch (e) {
    verdict = `FAIL: ${e?.message ?? String(e)}`;
    for (const role of Object.keys(sides)) {
      // A Chrome that exited answers nothing: its log is then unreadable, never awaited.
      const log = sides[role].cdp
        ? await Promise.race([
            sides[role].cdp.eval('e2e.log()'),
            sides[role].exited.then(() => null),
          ]).catch(() => null)
        : null;
      say(`--- ${role} page log ---\n${(log ?? ['(unreadable)']).join('\n')}`);
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
      for (const d of readdirSync(OUT)) {
        try {
          rmSync(join(OUT, d), { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        } catch (e) {
          say(`WARN ${d} could not be removed (${e.code}) - delete ${OUT} by hand`);
        }
      }
    }
  }
  say(verdict);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

await main();
