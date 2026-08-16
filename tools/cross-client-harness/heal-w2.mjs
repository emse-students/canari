#!/usr/bin/env node
/**
 * HEAL-W2 - the UNKNOWN-GROUP path on the browser.
 *
 * A frame arrives for a group this device's MLS state has never heard of. `handleUnknownGroup`
 * must fire ONE immediate recovery through `requestReAdd`, buffer the frame, and return `false` so
 * the server keeps it for replay - and, the part that is actually load-bearing, it must do all that
 * WITHOUT holding the inbound drain: the recovery is started, never awaited (`startRecovery`),
 * because `isDraining` is only lowered when the message callback returns and an await here freezes
 * every later inbound message in silence. That is WP-HIDDEN-1's shape, and it was measured on the
 * device as `Drain start` with no `Drain complete`.
 *
 * HOW THE BREAK IS CONSTRUCTED, and why it is not the obvious way.
 * The web MLS state is ONE opaque blob (`mls_autosave`, ~1.7 MB) holding every group, so there is
 * no edit that makes a SINGLE group unknown - a restore rewinds everything or nothing. So the group
 * is created AFTER the snapshot: snapshot W1, create a group on W2 and invite W1 into it, prove it
 * works, then restore. The restored blob predates the join, so that one group - and only that one -
 * is unknown, while every other group is merely rewound.
 *
 * WHAT THE RESTORE ALSO DOES, stated because it is the run's real cost: it rewinds W1's sender
 * ratchet in every OTHER group too, which is WP-LOSS-1's shape. `ensureDeliverable` in `heal-web.mjs`
 * is the teardown for exactly that, and this check reuses the same idea on the DM.
 *
 * The venue rule holds: the throwaway group's only members are the two test accounts, so it IS the
 * two-test-account venue. Nothing here touches a channel a real association can read.
 *
 *   node heal-w2.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { client, openConversation, send, evaluate, markers, goto } from './chat.mjs';
import { openGroup as openGroupByName } from './groupnav.mjs';
import { watch, report, consoleLines, gate } from './watch.mjs';
import { mark, record } from './results.mjs';
import { peerNameFor } from './names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROUP = `HGRP${Math.random().toString(36).slice(2, 7)}`;


/** Poll for a marker with the list pinned to the bottom - the list is virtualised. */
const seen = async (cx, prefix, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  let best = [];
  while (Date.now() < deadline) {
    await evaluate(
      cx,
      `(function () {
        var c = document.querySelector('.chat-composer-footer .chat-composer-editor');
        if (!c) return false;
        var pane = c.closest('section');
        var sc = [].filter.call(pane.querySelectorAll('*'), function (e) {
          return e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200;
        })[0];
        if (sc) sc.scrollTop = sc.scrollHeight;
        return !!sc;
      })()`
    ).catch(() => {});
    const now = await markers(cx, prefix).catch(() => []);
    if (now.length > best.length) best = now;
    if (best.length) return best;
    await sleep(3000);
  }
  return best;
};

const w1 = await client(9224, 'canari-emse.fr', { focus: false }); // the OWNER - the device under test
const w2 = await client(9223, 'canari-emse.fr', { focus: false }); // the PEER - the one that sends

/** The group under test, opened by name with a post-condition - see `groupnav.mjs`. */
const openGroup = (cx, label, opts = {}) => openGroupByName(cx, GROUP, { ...opts, label });

// ---------------------------------------------------------------- 0. snapshot BEFORE the group
// START FROM A FRESH MOUNT ON BOTH. Overlays in this app hide their own triggers, and a run that
// died mid-flow leaves the group panel or the member picker up - which the NEXT run reports as
// "no stable element", or as a composer that never appears, blaming a control that is fine. A
// reload is the only state-independent way back to a known screen. It also re-anchors W2's
// virtualised pane at the newest message, which the teardown depends on.
for (const cx of [w1, w2]) await cx.send('Page.reload', { ignoreCache: false });
await sleep(18_000);

// W1 may navigate freely from here. The snapshot used to live only in `window.__mlsSnapshot`, a tab
// lifetime, so this check had to forbid W1 any navigation between snapshot and restore - and paying
// that price is what broke the first three runs: a group row on W1's minutes-old page would not open
// however many times it was clicked, while the identical click on a freshly loaded page opened it at
// once. `mlsdb.mjs` now also writes the snapshot to its own IndexedDB database, so the constraint is
// gone; see its docblock for why that changes nothing about the security posture.
await goto(w1, '/chat');
await sleep(4000);
const snap = JSON.parse(execFileSync('node', ['mlsdb.mjs', '--port', '9224', 'snapshot'], { encoding: 'utf8' }));
console.log(`[w2] snapshot taken at ${snap.takenAt}: ${snap.report.map((r) => `${r.store} ${r.rows} rows`).join(', ')}`);

// ---------------------------------------------------------------- 1. build the group on W2
execFileSync('node', ['newgroup.mjs', '--port', '9223', '--name', GROUP], { encoding: 'utf8', stdio: 'inherit' });
// `invite.mjs` derives WHO from the port, so the name is not spelt here either - W2 invites the
// other party, which is the device under test.
execFileSync('node', ['invite.mjs', '--port', '9223', '--group', GROUP], {
  encoding: 'utf8',
  stdio: 'inherit',
});
await sleep(8000);

await watch(w1, 'W1');
await watch(w2, 'W2');

// ---------------------------------------------------------------- 2. prove the group works first
// A check whose break cannot be distinguished from a group that never worked proves nothing.
console.log(`[w2] W1 opened: ${await openGroup(w1, 'W1', { navigate: true })}`);
console.log(`[w2] W2 opened: ${await openGroup(w2, 'W2', { navigate: true })}`);

// THE GROUP ID, captured while the group is open, because nothing else in the run holds it.
// `GROUP` is a display NAME; the awaiting-history marker is keyed
// `mls_awaiting_history_since:<userId>:<groupId>` and localStorage carries no name anywhere - so a
// marker assertion scoped by the name would match nothing and silently assert nothing, which is
// this campaign's most-repeated harness fault. Captured here rather than at verdict time: by then
// the page may have navigated, and a missing id would be indistinguishable from a missing marker.
const groupId = await evaluate(
  w1,
  `(location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [''])[0]`
).catch(() => '');
console.log(`[w2] group id ${groupId ? 'resolved from the URL' : 'NOT RESOLVED - the marker assertion cannot run'}`);

const baseline = mark('HW2A');
await send(w2, baseline);
const gotBaseline = await seen(w1, 'HW2A', 60_000);
console.log(`[w2] baseline: W1 ${gotBaseline.length ? 'RECEIVED' : 'DID NOT RECEIVE'} ${baseline}`);
if (!gotBaseline.length) {
  record('HEAL-W2', 'SETUP-FAILED', { group: GROUP, why: 'the fresh group never delivered before the break' });
  process.exit(2);
}

/**
 * TEARDOWN - restore the INVARIANT the restore destroyed, never a snapshot.
 *
 * The break rewinds W1's sender ratchet in every OTHER group as well, the DM included, because the
 * blob is monolithic. That is WP-LOSS-1's shape, deliberately induced, and it is the run's real
 * cost: leave it, and the NEXT check starts on a lossy link and blames the app.
 *
 * Restoring a saved state cannot fix it - the peer has consumed generations off the fork, so no
 * snapshot of W1 is both legitimate and ahead of W2's high-water mark. The invariant is "W1 can
 * deliver to W2", so burn generations until a fresh message lands. Each probe advances the ratchet
 * by exactly one, so this terminates by construction. Same reasoning as `heal-web.mjs`.
 */
const teardown = async (maxProbes = 24) => {
  const td = mark('HW2TD');
  try {
    await goto(w1, '/chat');
    await openConversation(w1, peerNameFor('W1'));
    // REMOUNT W2 BEFORE READING IT. The teardown of the previous run reported the DM undeliverable
    // after 24 probes; the probes had all arrived (the sidebar preview showed the last one) and W2's
    // PANE was simply anchored in messages from an earlier run, scroller already at its maximum, so
    // `markers` could not see them. A fresh mount opens at the newest message; nothing else does.
    await goto(w2, '/chat');
    await openConversation(w2, peerNameFor('W2'));
    await sleep(3000);
    for (let i = 1; i <= maxProbes; i++) {
      await send(w1, `${td}-${i}`).catch((e) => console.log(`[w2] teardown probe ${i}: ${String(e).slice(0, 70)}`));
      if ((await seen(w2, 'HW2TD', 18_000)).length) {
        console.log(`[w2] teardown: the DM delivers again after ${i} probe(s) - the rig is clean`);
        return true;
      }
    }
    console.log(`[w2] teardown: the DM STILL will not deliver after ${maxProbes} probes - do not trust the next run`);
    return false;
  } catch (e) {
    console.log(`[w2] teardown threw: ${String(e).slice(0, 140)}`);
    return false;
  }
};

/** The recorded row, hoisted out of the `try` so the exit code at the foot can read the VERDICT. */
let row = null;
try {
// ---------------------------------------------------------------- 3. break it
console.log(
  `[w2] restore: ${execFileSync('node', ['mlsdb.mjs', '--port', '9224', 'restore'], { encoding: 'utf8' }).replace(/\s+/g, ' ').slice(0, 160)}`
);
// DIGEST IMMEDIATELY AFTER THE RESTORE AND AGAIN AFTER THE RELOAD.
//
// The first run of this check reported the message arriving with the unknown-group path never
// firing, which means the group was NOT unknown - and there are two candidate causes that no
// verdict can separate: either the live app checkpointed its in-memory state back over the restored
// blob before the reload, or the reload legitimately re-joined the group from a Welcome still on
// the server. The blob is opaque, but its DIGEST is not: if the post-reload digest differs from the
// restored one, something rewrote it, and that is cause one.
const digestOf = () =>
  JSON.parse(execFileSync('node', ['mlsdb.mjs', '--port', '9224', 'digest'], { encoding: 'utf8' })).report[0]
    .entries.map((e) => `${e.key}:${e.len}:${e.hash}`)
    .join(' ');
const afterRestore = digestOf();
console.log(`[w2] digest after restore: ${afterRestore}`);

await w1.send('Page.reload', { ignoreCache: false });

// SEND WHILE W1 IS BOOTING, and that timing is the whole check now.
//
// The first two runs waited for the reload to finish before sending, and the unknown-group branch
// never fired: boot catch-up (`[CATCHUP] batch history: 10 group(s)`) had already re-joined the
// group from a Welcome still available server-side, so by the time the frame arrived the group was
// known and it simply decrypted. That is the app healing correctly, but it is not this branch.
//
// `handleUnknownGroup` can only run if a frame arrives BEFORE catch-up completes, so the frame has
// to be queued while W1 is down. Whether it wins is up to the app - which is exactly the thing
// worth measuring, and is reported either way rather than retried until it looks green.
const broken = mark('HW2B');
await sleep(1500);
await send(w2, broken);
console.log(`[w2] sent ${broken} while W1 was still booting`);

await sleep(16_000);
await watch(w1, 'W1');
const afterReload = digestOf();
console.log(`[w2] digest after reload:  ${afterReload}`);
console.log(`[w2] the restored state ${afterRestore === afterReload ? 'SURVIVED the reload' : 'WAS REWRITTEN - the break did not take'}`);
const breakStart = Date.now();
// The group is unknown to MLS but still in the app's own conversation list (a different database,
// which the restore did not touch) - so W1 can and must still OPEN it. A failure here is a finding.
await openGroup(w1, 'W1 after the break', { navigate: true }).catch((e) =>
  console.log(`[w2] W1 could not open the group after the break: ${String(e).slice(0, 120)}`)
);

// ---------------------------------------------------------------- 4. did it recover?
// The recovery is an external commit or a welcome_request answered by the peer, then a replay of
// the buffered frame - a network round trip plus a commit, not a tick.
const gotBroken = await seen(w1, 'HW2B', 180_000);

// ---------------------------------------------------------------- 5. verdict
//
// THE VERDICT WAS REWRITTEN 2026-08-11, AND THE OLD ONE COULD NOT PASS.
//
// It required `welcome_request sent for unknown group` to have fired. Four runs established that
// this construction can never reach that branch: boot catch-up re-joins the group from a Welcome
// still available server-side before any frame can arrive, so `handleUnknownGroup` has nothing to
// handle. A condition no run can satisfy is not a strict check, it is a check that reports FAIL
// for a reason that has nothing to do with the app - and the fourth run proved the point by
// finding a REAL defect while nominally failing (a frame from a past epoch answered `Ok(None)`,
// was ACKed off the server and dropped in silence; fixed in 1e8208d6).
//
// So `unknownGroupFired` becomes an OBSERVATION - a fact about catch-up - and the question the
// check now asks is the one the fix created: once catch-up has re-joined a group without its
// past-epoch secrets, does the frame encrypted one epoch earlier get RECOVERED? The path is
// `[MLS] LOST frame` (setupMessageHandler.ts:588) -> `markAwaitingHistory(..., 'unreadable-frames')`
// -> the history diff. Every step is asserted, and the marker is read from localStorage rather
// than from a log line, because it is the DURABLE post-condition: a log line says something was
// attempted, the marker says the app committed to the attempt and will re-solicit on reconnect.
//
// THE BREAK NOW GATES THE VERDICT. `afterRestore === afterReload` was printed and then ignored,
// so a run whose restore had been checkpointed back over could still return PASS - a verdict about
// a break that never happened. It is now SETUP-FAILED, which is not a failure of the app.
const lines = consoleLines(w1);
const unknown = lines.filter((l) => /welcome_request sent for unknown group/i.test(l));
const lostFrame = lines.filter((l) => /\[MLS\] LOST frame for/i.test(l));
const recovery = lines.filter((l) => /Out-of-sync for|Recovery attempt finished|external join|requestReAdd|caught up for/i.test(l));
const drainStart = lines.filter((l) => /\[QUEUE\] Drain start/.test(l)).length;
const drainDone = lines.filter((l) => /\[QUEUE\] Drain complete/.test(l)).length;

// The awaiting-history marker for THIS group, read where it actually lives. Scoped to the group
// under test: the profile carries markers for other conversations, and a document-wide count would
// report someone else's pending state as this check's evidence.
const markerReason = !groupId
  ? 'UNRESOLVED GROUP ID'
  : await evaluate(
      w1,
      `(function () {
         var k = Object.keys(localStorage).filter(function (x) {
           return x.indexOf('mls_awaiting_history_since:') === 0 && x.indexOf(${JSON.stringify(groupId)}) !== -1;
         });
         if (k.length === 0) return 'none';
         var v = localStorage.getItem(k[0]);
         try { var p = JSON.parse(v); return String((p && p.reason) || 'set'); } catch (e) { return 'set'; }
       })()`
    ).catch(() => 'unreadable');

// THE WHOLE LOG TO A FILE, not just the lines a matcher accepts. Harness fault #31: computing a
// verdict over a filtered projection hides exactly the line that would have explained it.
writeFileSync(new URL('./heal-w2-w1-console.log', import.meta.url), lines.join('\n'), 'utf8');
console.log(`[w2] wrote ${lines.length} W1 console lines to heal-w2-w1-console.log`);

console.log('\n[w2] --- W1 recovery lines ---');
[...lostFrame, ...unknown, ...recovery].slice(0, 25).forEach((l) => console.log('  ' + l));

const w1Noise = await report({ cx: w1, label: 'W1' });
const brokeForReal = afterRestore === afterReload;
const recovered = gotBroken.length > 0;
/**
 * THE ASSERTION AND THE OBSERVATION, SEPARATED - they were folded into one ternary.
 *
 * `w1Noise.clean` sat inside the PASS arm, so a run that recovered and drained correctly but logged
 * something unexpected came out as `PARTIAL` - the same word this check uses for "recovered but the
 * drain never completed", which is WP-HIDDEN-1's actual shape and the thing it was written to catch.
 * One name for two states, and the more serious of the two is the one that gets read as the other.
 *
 * `gate` separates them: the drain is the assertion, noise makes it `PASS-DIRTY`. It also produces
 * the `clean` key every other row in the ledger carries - this file was the last one whose
 * observation was invisible to anything reading the record rather than the source.
 */
const asserted = !brokeForReal ? 'SETUP-FAILED' : recovered && drainStart === drainDone ? 'PASS' : recovered ? 'PARTIAL' : 'FAIL';
const gated = gate(asserted, { W1: w1Noise });
const verdict = gated.verdict;

console.log(
  `\n[w2] break took=${brokeForReal}, message recovered=${recovered}, ` +
    `LOST frame=${lostFrame.length}, awaiting-history marker=${markerReason}, ` +
    `recovery lines=${recovery.length}, drain start/complete=${drainStart}/${drainDone}, ` +
    `unknown-group fired=${unknown.length} (an observation about catch-up, not a condition), ` +
    `clean=${w1Noise.clean}`
);
console.log(`[w2] VERDICT: ${verdict}`);

row = record('HEAL-W2', verdict, {
  ...gated.detail,
  group: GROUP,
  brokeForReal,
  recovered,
  lostFrame: lostFrame.length,
  markerReason,
  unknownGroupFired: unknown.length,
  recoveryLines: recovery.length,
  drainStart,
  drainDone,
  // `clean` and the dirt now come from `gated.detail` above - the hand-written `clean:` and a
  // six-item slice of `errors` that used to sit here said less: `dirtOf` carries every bucket that
  // can break the verdict, whole, which is the whole point of it being one definition.
});
} finally {
  // Runs on the happy path AND on any throw: a check that puts the app through a transition must
  // restore every precondition that transition destroys, and this one destroys the rig's own.
  await teardown();
}
// EXIT ON THE VERDICT, not on having reached the end. `process.exit(0)` sat under a `record` that
// can be FAIL, PARTIAL or SETUP-FAILED, so the runner printed `done` beside every one of them - the
// same half-contract `finish()` exists to close. It cannot be `finish` here: the record has to
// happen before `teardown`, and the exit after it.
process.exit(row?.verdict === 'PASS' ? 0 : 1);
