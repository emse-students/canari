/**
 * DOES A RELOAD INSIDE THE CHECKPOINT WINDOW STILL COST A MESSAGE?
 *
 *   bun burn.mjs [--delay 300] [--device W1]
 *
 * Sending advances this device's ratchet; the checkpoint that makes the advance durable is
 * deliberately NOT awaited (1.7 s per message on a phone). So there is a window - the length of the
 * write - in which the disk is behind a frame the peer has already consumed. Reload inside it and
 * the restored client re-issues a spent generation: the peer answers `SecretReuseError` and reports
 * a message nobody lost.
 *
 * Measured on prod 2026-08-06, deterministically: reload 300 ms after a send and the next message
 * dies (twice, at generations 118 and 120); reload 20 s after and it arrives in 694 ms. That recipe
 * is what this check automates, against the repair (`reconcileSendRatchets`, which burns the
 * difference at load from a count kept outside the snapshot).
 *
 * WHAT MAKES THIS A VERDICT RATHER THAN A GREEN LIGHT. A run in which the window was MISSED - the
 * checkpoint landed before the reload - also delivers the second message, and proves nothing at all.
 * The two are separated by the repair's own line: `burned` counts the generations the load actually
 * had to make up. `burned = 0` is reported as INCONCLUSIVE, never as a pass, because it means the
 * experiment did not reproduce its own premise.
 *
 * The PIN is entered by `pin.mjs` as a subprocess: it must never be a tool-call argument, and the
 * gate is also what makes the capture reliable - the repair runs during the init the unlock starts,
 * which is after this script has re-attached and begun watching.
 */
import { spawnSync } from 'node:child_process';
import { APP_TAB, armComposer, awaitMessage, client, countMessage, ensureConversation, evaluate, fireComposer, pollFact, send } from '../chat.mjs';
import { watch, report, consoleLines } from '../watch.mjs';
import { mark } from '../results.mjs';
import { PORTS, peerNameFor } from '../names.mjs';
import { requireScript } from '../scriptpath.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const DEVICE = arg('device', 'W1');
const DELAY_MS = Number(arg('delay', 300));
const PORT = PORTS[DEVICE];

/**
 * THE TWO WITNESSES, ONE ON EACH SIDE OF THE RELOAD (rewritten for KILL-2, #2515).
 *
 * Until KILL-2 both halves of the send ledger sat in `localStorage`, and `emitted - persisted` read
 * BEFORE the reload proved the window entered. Since then `persisted` is sealed inside the MLS state,
 * which no page script can read, so that difference is unreadable and the premise moved:
 *
 * - BEFORE: `emitted` alone, in IndexedDB (`send_ratchet_emitted:<user>` in `CanariDBMls_<user>`,
 *   the same store on web and in the native WebView). It moves when a frame is counted, which is
 *   after its encrypt and before its POST - so the reload is fired the instant it moves. That
 *   TRIGGERS the experiment; it does not prove the checkpoint was beaten (a web checkpoint lands in
 *   a median of 58 ms).
 * - AFTER: the repair's own line (`Restored state for <g> was <n> generation(s) behind`). The load
 *   prints it only when the state it opened was behind a counted send, which IS the premise. A run
 *   whose line was not captured (a reload that starts its init before the re-attach) is
 *   INCONCLUSIVE, never a pass.
 *
 * Totals only, summed over accounts: group ids identify conversations and this file is committed.
 */
const EMITTED = `(async function () {
  try {
    var uids = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('mls_device_id_') === 0) uids.push(k.slice('mls_device_id_'.length));
    }
    var known = indexedDB.databases ? (await indexedDB.databases()).map(function (d) { return d.name; }) : null;
    var total = 0, present = false;
    for (var u = 0; u < uids.length; u++) {
      var name = 'CanariDBMls_' + uids[u];
      if (known && known.indexOf(name) < 0) continue;
      var counts = await new Promise(function (resolve) {
        var req = indexedDB.open(name);
        req.onerror = function () { resolve(null); };
        req.onsuccess = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('state')) { db.close(); resolve(null); return; }
          var get = db.transaction('state', 'readonly').objectStore('state').get('send_ratchet_emitted:' + uids[u]);
          get.onsuccess = function () { db.close(); resolve(get.result || null); };
          get.onerror = function () { db.close(); resolve(null); };
        };
      });
      if (!counts) continue;
      present = true;
      for (var key in counts) if (typeof counts[key] === 'number') total += counts[key];
    }
    return JSON.stringify({ present: present, emitted: total });
  } catch (e) {
    return JSON.stringify({ present: false, emitted: 0, error: String(e).slice(0, 120) });
  }
})()`;

/** The tab is back when it reports a build id again - behind the PIN gate or past it. */
const STATE = `(function () {
  try {
    var root = document.documentElement;
    return JSON.stringify({
      pin: !!document.querySelector('#encryption-pin'),
      id: root ? (root.innerHTML.match(/__sveltekit_[a-z0-9]+/) || [null])[0] : null
    });
  } catch (e) { return JSON.stringify({ pin: false, id: null }); }
})()`;

/**
 * ATTACHING, AND RELOADING, DIFFER BY PLATFORM - the experiment does not.
 *
 * A1 serves its own assets from the APK, so it is matched by nothing and must not be focused (that
 * is a real phone). And it has no `Page.reload` worth issuing: a Tauri page load is driven by
 * navigating, which is what rebuilds the MLS client from `mls.bin` - the same rewind a browser
 * refresh performs, reached by the only route this platform has.
 */
const IS_NATIVE = DEVICE === 'A1';
const attach = () => client(PORT, IS_NATIVE ? null : APP_TAB, { focus: !IS_NATIVE });
const reloadWith = (cx) =>
  IS_NATIVE
    ? evaluate(cx, `location.href = ${JSON.stringify('http://tauri.localhost/chat')}`)
    : cx.send('Page.reload', { ignoreCache: false });

const stateOf = async () => {
  const cx = await attach();
  return JSON.parse(await evaluate(cx, STATE));
};

const out = { device: DEVICE, delayMs: DELAY_MS };

// ── The peer, watching for the fault this whole thing exists to prevent ──────────────────────────
const w2 = await client(PORTS.W2, APP_TAB);
// `ensureConversation`, never `ensureChat` + `openConversation`: on a phone the sidebar has zero
// width while a thread is open, so the plain opener times out looking for a row it can see in the
// DOM but not on screen - and the header is the only thing that NAMES the conversation anyway.
await ensureConversation(w2, peerNameFor('W2'));
const peerWatch = await watch(w2, 'burn-W2');

// ── A baseline, so a failure below is about the window and not about the pair ────────────────────
let w1 = await attach();
await ensureConversation(w1, peerNameFor(DEVICE));
const baseline = mark('BURN0');
await send(w1, `${baseline} baseline before the window`);
out.baselineDelivered = await awaitMessage(w2, baseline, 25_000).then(
  () => true,
  () => false
);

// ── THE WINDOW: send, then reload WHILE the checkpoint is still outstanding ──────────────────────
//
// A FIXED DELAY IS A RACE, AND ON WEB IT IS A RACE THIS LOSES. The 300 ms recipe was calibrated on
// 2026-08-06; `f391c199` then stopped durability gating delivery and `6bfd805d` removed the phone's
// duplicate write, and a web checkpoint now lands in a median of 58 ms. So sleeping 300 ms and
// reloading reports INCONCLUSIVE every time - correctly, but uselessly, and it looks identical to a
// run where the repair simply had nothing to do.
//
// The premise is not "reload fast", it is "reload while a frame is unpersisted". The page can no
// longer state that (see the witnesses above), so the reload is fired the instant the frame is
// COUNTED - the earliest moment the client could have been killed with the frame on the wire - and
// the load's own repair line says afterwards whether the checkpoint was beaten. Several sends may
// be needed on a fast disk; if none is beaten the verdict is INCONCLUSIVE, never PASS.
const inWindow = mark('BURN1');
let counted = JSON.parse(await evaluate(w1, EMITTED));
out.emittedBaseline = counted;
const emittedBefore = counted.emitted;
out.windowAttempts = 0;
for (let i = 0; i < 6 && counted.emitted <= emittedBefore; i++) {
  out.windowAttempts++;
  // ARM, THEN FIRE WITHOUT AWAITING, AND POLL BESIDE IT. `fireComposer` only returns once the
  // composer has emptied, which it establishes by polling at 100 ms - already longer than the
  // checkpoint it is racing. Awaiting the send therefore guarantees the window has closed before
  // the first look. The rejection is captured rather than dropped: an unhandled one would take the
  // run down somewhere unrelated, and a send that failed to submit must be reported as itself.
  await armComposer(w1, `${inWindow}-${i} sent, then reloaded inside the checkpoint window`);
  let sendError = null;
  const firing = fireComposer(w1).catch((e) => {
    sendError = String(e).slice(0, 160);
  });
  const t0 = Date.now();
  while (Date.now() - t0 < Math.max(DELAY_MS, 600)) {
    counted = JSON.parse(await evaluate(w1, EMITTED).catch(() => JSON.stringify(counted)));
    if (counted.emitted > emittedBefore) break;
    await sleep(5);
  }
  if (counted.emitted > emittedBefore) break;
  await firing;
  if (sendError) {
    out.sendError = sendError;
    break;
  }
}
// READ BEFORE THE RELOAD: a run in which no send was ever counted never reached the window at all.
out.emittedBeforeReload = counted;
await reloadWith(w1).catch(() => {});
w1.close();

const back = await pollFact(
  async () => {
    const s = await stateOf().catch(() => null);
    return s && s.id ? s : null;
  },
  { timeoutMs: 60_000, everyMs: 500 }
);
out.reloadedInMs = back.elapsedMs;

// Attached BEFORE the unlock, so the repair - which runs inside the init the unlock starts - lands
// in a buffer that already exists. Attaching afterwards is how a capture misses the one line it came
// for and reports its absence as a fact about the application.
w1 = await attach();
const loadWatch = await watch(w1, `burn-${DEVICE}`);

if (back.value?.pin) {
  const pin = spawnSync(process.execPath, [requireScript('pin.mjs'), '--device', DEVICE], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  });
  out.unlocked = pin.status === 0;
  if (pin.status !== 0) out.pinStderr = String(pin.stderr || '').slice(0, 200);
} else {
  out.unlocked = 'was not locked';
}

// ── What the repair says it had to make up ───────────────────────────────────────────────────────
const BURN_LINE = /Restored state for (\S+) was (\d+) generation\(s\) behind/;
const burnt = await pollFact(
  () => {
    const hit = consoleLines(w1).find((l) => BURN_LINE.test(l));
    return hit ? hit.match(BURN_LINE) : null;
  },
  { timeoutMs: 45_000, everyMs: 500 }
);
out.burnedLine = burnt.value ? Number(burnt.value[2]) : null;
/**
 * INFORMATIONAL, AND DELIBERATELY NOT A POST-CONDITION.
 *
 * The first version of this check failed A1 on a deficit still standing after the load (then
 * `emitted - persisted`, read from `localStorage`), reasoning that the repair must leave nothing behind. That is wrong, and the run that exposed it was the application
 * behaving perfectly: the deficit is a LIVE quantity, bumped by every send and cleared 1.7 s later by
 * the phone's checkpoint, and by the time this line runs the restored session has already opened a
 * conversation and sent its read receipts. Reading it late measures ordinary traffic, not damage.
 *
 * The same run showed the other half of it: `burnedLine` was 2 where the pre-reload snapshot said 1,
 * because a send landed between that snapshot and the reload. The repair burnt what the ledger held
 * AT LOAD, which is exactly right - and any check comparing the two figures for equality would call
 * that a fault. `emittedAfterLoad` is kept for the same reading: a count, never a post-condition.
 */
out.emittedAfterLoad = JSON.parse(await evaluate(w1, EMITTED));
out.burned = out.burnedLine ?? 0;

// ── The frame that used to die ───────────────────────────────────────────────────────────────────
await ensureConversation(w1, peerNameFor(DEVICE));
await sleep(1_000);
const after = mark('BURN2');
const at = Date.now();
await send(w1, `${after} the first send after the reload`);
out.afterDeliveredMs = await awaitMessage(w2, after, 30_000).then(
  () => Date.now() - at,
  () => null
);
out.inWindowDelivered = (await countMessage(w2, inWindow)) === 1;
out.afterDelivered = (await countMessage(w2, after)) === 1;

// ── The peer's own account of the run ────────────────────────────────────────────────────────────
const peer = await report(peerWatch);
const lossLines = consoleLines(w2).filter((l) => /LOST frame|SecretReuse/i.test(l));
out.peerLossLines = lossLines.length;
out.peerLossSample = lossLines.slice(0, 2);
out.peerClean = peer.clean;

const load = await report(loadWatch);
out.senderClean = load.clean;
out.senderUnexplained = load.unexplained.slice(0, 3);

// ── The verdict, with the premise separated from the result ──────────────────────────────────────
out.verdict =
  !out.baselineDelivered
    ? 'INCONCLUSIVE - the pair could not deliver a baseline, nothing here is about the window'
    : !out.emittedBeforeReload.present || out.emittedBeforeReload.emitted <= emittedBefore
      ? 'INCONCLUSIVE - no send was counted before the reload, so the window was never reached'
      : out.burnedLine === null
        ? 'INCONCLUSIVE - the load printed no repair line: the checkpoint landed before the reload, or the line was missed by the re-attach'
        : out.burned === 0
          ? 'INCONCLUSIVE - the checkpoint landed before the reload, so the window was never entered'
          : // THE ASSERTION IS THE ABSENCE OF THE FAULT, and the fault has two halves that must BOTH
          // be absent: the frame the rewind used to kill arrives, and the peer reports no loss. The
          // repair's own line is the PREMISE since KILL-2, never the verdict: a missed line is
          // INCONCLUSIVE above, so a healthy run whose re-attach was late is never called a FAIL.
          out.afterDelivered && out.peerLossLines === 0
          ? `PASS - reload inside the window (${out.burned} unpersisted), the next frame decrypted in ${out.afterDeliveredMs}ms, no loss reported`
          : `FAIL - delivered=${out.afterDelivered}, peer loss lines=${out.peerLossLines}`;

console.log(JSON.stringify(out, null, 1));
process.exit(out.verdict.startsWith('PASS') ? 0 : 1);
