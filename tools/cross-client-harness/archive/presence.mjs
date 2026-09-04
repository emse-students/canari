#!/usr/bin/env node
/**
 * Asks the GATEWAY whether each client's socket is really up - the pre-flight gate MSG-2 was
 * missing, measured at the far end where the answer is a fact rather than a belief.
 *
 *   bun presence.mjs [--ports 9224,9223,9333]
 *
 * WHY THE FAR END. A delivery check run against a client with no transport measures the transport's
 * absence, and MSG-2 failed exactly that way on 2026-08-13: `copiesOnPhone: 0` after 25 s, the
 * message arriving on the phone's NEXT reconnect, and the check unattributable because nothing in
 * the pre-flight had ever asked whether the phone was connected. Unlocked is not connected.
 *
 * `gateway.mjs` answers the same question from the browser side by watching frames, and cannot
 * answer it for the phone at all: a Tauri client's socket lives in RUST, so the WebView's Network
 * domain sees nothing and an honest script must say so rather than report `DOWN`. The gateway's own
 * `user:online:{userId}:{deviceId}` key has no such blind spot - it is written when the socket
 * opens, refreshed to a 20 s TTL on every frame the connection carries (the clients ping every 8 s),
 * and DELETED by a `Drop` guard when the connection task exits for any reason. So the key existing
 * means: this device is talking to the gateway right now, whichever client it is.
 *
 * IDS NEVER LEAVE AS ARGUMENTS AND NEVER LAND IN THE OUTPUT WHOLE. The ids are read from the page,
 * sent to `redis-cli` through the ssh command line built here, and printed as 8-character prefixes -
 * enough to line up with `identity.mjs` and useless to anyone reading a public transcript.
 *
 * Exits non-zero unless every client asked about is ONLINE, and an ssh that cannot be reached is
 * reported as UNDECIDED rather than as a healthy client: a failed read is not an empty answer.
 */
import { client, evaluate } from '../chat.mjs';
import { PORTS } from '../names.mjs';
import { redis } from '../estate.mjs';
import { installTag, userTag } from '../devices.mjs';

const flag = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const wanted = flag('ports', null)
  ?.split(',')
  .map((p) => Number(p.trim()))
  .filter(Boolean);

/** The device id, read from where the app actually keeps it rather than from a constructed name. */
const WHO = `(function () {
  var k = Object.keys(localStorage).filter(function (n) { return n.indexOf('mls_device_id_') === 0; })[0];
  if (!k) return 'null';
  return JSON.stringify({ user: k.slice('mls_device_id_'.length), device: localStorage.getItem(k) });
})()`;

/** Who a client is, straight from its own storage. `null` when it holds no identity at all. */
export async function whoIs(cx) {
  const seen = JSON.parse(await evaluate(cx, WHO));
  return seen?.device ? seen : null;
}

/**
 * The TTL the gateway holds for a device: `> 0` connected, `-2` no such key, `-1` a key that never
 * expires (which this one never is - seeing it would itself be the finding).
 *
 * Throws rather than returning a number when the gateway cannot be asked, so no caller can mistake
 * an unreachable server for a disconnected client.
 */
export function ttlOf(user, device) {
  return Number(redis(`TTL 'user:online:${user}:${device}'`));
}

/**
 * EVERY device of one user that is talking to the gateway right now, whether or not this rig drives
 * it.
 *
 * WHY THE INVERSE QUESTION IS ITS OWN FUNCTION. `ttlOf` asks "is the client I drive up", which is
 * the pre-flight's question and answers nothing about who ELSE is holding the same account open. A
 * campaign account is not a fleet by decree: on 2026-08-24 GRP-8 went PASS-DIRTY on a `[KICK] Stale
 * leaf`, and the cause was two live web sessions of the test user that no runner drives - they were
 * fanned into the group like any other device of the creator, were slow to process their Welcome,
 * and one asked for it again through the path that repairs by kick + re-add. Nothing in the rig
 * could see them, so the row cost a session to attribute instead of a line to read.
 *
 * The scan is anchored on the user id and a PREFIX is enough, which is what the pre-flight holds.
 */
export function onlineDevicesOf(userId) {
  return redis(`--scan --pattern 'user:online:${userId}*'`)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((k) => k.slice(k.indexOf(':', 'user:online:'.length) + 1))
    .filter(Boolean);
}

/**
 * Waits until the gateway agrees the device is GONE - the only proof a browser can offer that it is
 * really offline.
 *
 * CDP's offline emulation blocks requests; it does not close a WebSocket that is already open, and
 * `net.mjs` says so in its own comments. MSG-9 sent its message into that gap on 2026-08-13, the
 * receiver took it live over the surviving socket, and the check reported `whileOffline: 1` as a
 * product failure. The gateway's `Drop` guard deletes the presence key when the connection task
 * exits, and the key expires 20 s after the last frame regardless, so its ABSENCE is the far-end
 * fact that "offline" is supposed to mean.
 *
 * @returns milliseconds waited, or `null` if the device was still online at the deadline.
 */
export async function awaitOffline(user, device, timeoutMs = 45000) {
  const started = Date.now();
  for (;;) {
    if (ttlOf(user, device) <= 0) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * The mirror of {@link awaitOffline}: waits until the gateway holds a connection again.
 *
 * Lifting a network cut only PERMITS a reconnect. A check that then measures delivery is measuring
 * the reconnect as well, and a client that never comes back reads as a message that never arrived -
 * the same substitution of the transport for the product, in the other direction.
 *
 * @returns milliseconds waited, or `null` if it was still absent at the deadline.
 */
export async function awaitOnline(user, device, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    if (ttlOf(user, device) > 0) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Everything below is the command line; importing this file runs none of it.
if (/presence\.mjs$/.test(process.argv[1] || '')) {
  const cut = (s) => (s ? s.slice(0, 8) : '?');
  let bad = 0;
  /** Full device ids this rig is driving, per full user id - the other half of the fleet diff. */
  const driven = new Map();

  for (const [label, port] of Object.entries(PORTS)) {
    if (wanted && !wanted.includes(port)) continue;

    let who;
    try {
      const cx = await client(port, null, { focus: false });
      who = await whoIs(cx);
      cx.close();
    } catch (e) {
      bad += 1;
      console.log(`${label} (${port}): UNREACHABLE - ${e.message}`);
      continue;
    }
    if (!who) {
      bad += 1;
      console.log(`${label} (${port}): UNDECIDED - this client holds no device id`);
      continue;
    }

    if (!driven.has(who.user)) driven.set(who.user, new Set());
    driven.get(who.user).add(who.device);

    let seconds;
    try {
      seconds = ttlOf(who.user, who.device);
    } catch (e) {
      bad += 1;
      console.log(
        `${label} (${port}): UNDECIDED - the gateway could not be asked (${e.message.split('\n')[0]})`
      );
      continue;
    }

    // -2 is "no such key" (never connected, or the Drop guard removed it); -1 would be a key with
    // no expiry, which this one never has and would itself be a defect worth seeing.
    const verdict =
      seconds > 0 ? `ONLINE (TTL ${seconds}s)` : seconds === -2 ? 'OFFLINE' : `SUSPECT (TTL ${seconds})`;
    if (seconds <= 0) bad += 1;
    console.log(`${label} (${port}): ${verdict} - user=${cut(who.user)} device=${cut(who.device)}`);
  }

  // WHOEVER ELSE IS HOLDING THIS ACCOUNT OPEN, named before a check starts rather than after a
  // verdict has to be explained.
  //
  // IT IS A NOTE, NOT A FAILURE, and deliberately does not touch the exit code. An uncontrolled
  // device is not broken and not always avoidable - the campaign account is a real account - so
  // refusing to start would block the ladder on someone closing a browser. What it must never do
  // again is stay INVISIBLE: every device of the creator is fanned into every group a check makes,
  // and one that is slow to process its Welcome reaches the kick + re-add repair, whose `[KICK]`
  // line is `unexplained` BY DESIGN. That is a legitimate dirty row about a real device, and the
  // only thing missing was the line saying the device was there.
  for (const [user, mine] of driven) {
    let online;
    try {
      online = onlineDevicesOf(user);
    } catch {
      // A gateway that cannot be asked is already reported by the per-client lines above, and
      // guessing here would turn one unreachable read into a fleet nobody can trust.
      continue;
    }
    const extra = online.filter((d) => !mine.has(d));
    if (extra.length) {
      console.log(
        `FLEET ${userTag(user)}: ${extra.length} device(s) online that this run does not drive - ${extra
          .map(installTag)
          .join(', ')}`
      );
    }
  }

  if (bad > 0) process.exitCode = 5;
}
