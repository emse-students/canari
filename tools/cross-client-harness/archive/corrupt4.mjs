#!/usr/bin/env node
/**
 * CORRUPT-4 - a ZERO-LENGTH MLS state must read as ABSENT, and the device must re-enrol cleanly.
 *
 * A SEPARATE FILE FROM `corrupt.mjs` ON PURPOSE. The two rows share a shape - damage, reload, read
 * what the client says - and nothing else: different store, different damage, different recovery.
 * More to the point, a single script that threw on the first row would take the second with it and
 * the phase would report one row where two were owed, which is the failure `checks.mjs` calls a rung
 * reading green while nothing ran it.
 *
 * **WHAT THE ROW IS ABOUT.** `sessionAuth` passes `noFreshStart: !!bytes` to `init`, and that flag
 * exists to stop a device that HAS history from silently starting over and dropping it. Until
 * 2026-09-08 the web branch of `loadMlsState` returned an empty `Uint8Array` as-is - and an empty
 * `Uint8Array` is TRUTHY - so zero bytes armed the guard against itself: init was handed no state
 * and simultaneously forbidden to start without one. The phone, whose branch guarded `length > 0`,
 * re-enrolled cleanly from the identical damage. One predicate now decides it at both returns.
 *
 * **SO THE ASSERTION IS THE LOGIN ITSELF**, not a log line: pre-fix the client cannot get in at all,
 * post-fix it does. That is why this row is worth an end-to-end runner even though a unit test
 * already pins the predicate - the unit test proves `null`, and what the row claims is that a device
 * whose state was written short by an interrupted flush or a full disk can still sign in.
 *
 * **WHAT IT COSTS AND HOW IT IS GIVEN BACK.** A clean re-enrolment rebuilds W1's MLS client, so the
 * device loses its group memberships locally until the snapshot goes back - which is why nothing
 * here runs without one, and why `mlsdb.mjs truncate` REFUSES without one rather than trusting this
 * file to have taken it. The device id is NOT part of the damage: `resolveDeviceId` reads a stored
 * id and decrypts nothing, so the re-enrolment reuses it and leaves no orphan device on the server.
 */
import { APP_TAB, awaitAppReady, client, evaluate } from '../chat.mjs';
import { until } from '../cdp.mjs';
import {
  BROWSER_PASSWORD_FORM_HINT,
  awaitLine,
  consoleLines,
  gate,
  ignoringExpectedLog,
  report,
  watch,
} from '../watch.mjs';
import { record, exitOnRecorded } from '../results.mjs';
import { PORTS } from '../names.mjs';
import { requireScript } from '../scriptpath.mjs';
import { bringToReady } from './ready-repair.mjs';
import { execFileSync } from 'node:child_process';

/** How long the client is given to sign in on a rebuilt state. A deadline: it returns when it does. */
const SETTLE_BUDGET_MS = 30_000;

/** `mlsdb.mjs` as a subprocess, exactly as `heal-web.mjs`, `heal-w2.mjs` and `del.mjs` drive it. */
const mlsdb = (...a) =>
  execFileSync(process.execPath, [requireScript('mlsdb.mjs'), '--port', String(PORTS.W1), ...a], {
    encoding: 'utf8',
  });

const w1 = await client(PORTS.W1, APP_TAB, { focus: false });

/** What is there BEFORE anything is touched - and the row's one precondition. */
const before = JSON.parse(mlsdb('digest'));
const entryOf = (d) =>
  (d.report ?? [])
    .flatMap((r) => (r.entries ?? []).map((e) => ({ ...e, db: r.db, store: r.store })))
    .find((e) => e.key === 'mls_autosave') ?? null;
const stateBefore = entryOf(before);

let damaged = false;
try {
  // NOT A PRECONDITION THIS CHECK MAY REPAIR. A client with no MLS state has nothing to truncate,
  // and writing one here would measure a state this script minted rather than one the product wrote.
  if (!stateBefore || !stateBefore.len) {
    record('CORRUPT-4', 'SKIPPED', {
      reason:
        `W1 holds no mls_autosave state (${stateBefore ? stateBefore.len + ' bytes' : 'no entry'}) - ` +
        'there is nothing to truncate, and minting one here would measure this script rather than the product',
    });
  } else {
    // A FRESH SNAPSHOT, NEVER A FOUND ONE. `mlsdb.mjs` keeps its snapshot in a durable database, so
    // one from an earlier run is always available and is always the WRONG state to put back: it
    // predates whatever the rows since have done. Taking one here is what makes the damage safe.
    const snap = JSON.parse(mlsdb('snapshot'));

    const obs = await watch(w1, 'CORRUPT-4-W1');
    const cut = JSON.parse(mlsdb('truncate'));
    damaged = Array.isArray(cut.truncated) && cut.truncated.length > 0;
    if (!damaged) {
      record('CORRUPT-4', 'SKIPPED', {
        reason: `the damage did not apply: ${JSON.stringify(cut)}`,
        snapshotTakenAt: snap.takenAt ?? null,
      });
    } else {
      // STAMP THE DOCUMENT THAT IS ABOUT TO DIE, so the wait is on the NAVIGATION rather than on a
      // duration somebody guessed - `awaitAppReady` asked of the old document answers instantly and
      // truthfully about a page that never reloaded. Measured on `corrupt.mjs`'s first run.
      await evaluate(w1, `window.__corrupt4Stamp = 1`);
      const damagedAt = Date.now();
      await w1.send('Page.reload', { ignoreCache: false });
      await until(w1, `!window.__corrupt4Stamp`, SETTLE_BUDGET_MS).catch(() => null);

      // THE ASSERTION. Pre-fix this never resolves: `noFreshStart` is armed by the empty state and
      // init is forbidden to rebuild, so the login has no path back and the client sits there.
      let signedInInMs = null;
      await awaitAppReady(w1, SETTLE_BUDGET_MS)
        .then(() => {
          signedInInMs = Date.now() - damagedAt;
        })
        .catch(() => {});

      // AND THE OTHER HALF, because "did not hang" is not "did the right thing": a client that
      // reported the state sealed under an old PIN has told the user their history is gone behind a
      // credential they may not have, which is the WRONG diagnosis for a truncated file.
      await awaitLine(w1, 'state_sealed', 3_000);
      const said = consoleLines(w1);
      const misdiagnosed = said.filter((t) =>
        /state_sealed|sealed under|MLS_LOCAL_STATE_UNDECRYPTABLE|UNDECRYPTABLE/i.test(t)
      );

      const after = entryOf(JSON.parse(mlsdb('digest')));

      const unmet = [];
      if (signedInInMs === null) unmet.push('theClientNeverSignedInOnARebuiltState');
      if (misdiagnosed.length) unmet.push('theEmptyStateWasReportedAsSealedRatherThanAbsent');

      const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
        W1: ignoringExpectedLog(await report(obs), [
          // The PIN gate can be raised on the way through, and Chrome hints against any form
          // carrying a password field - see `BROWSER_PASSWORD_FORM_HINT` in `watch.mjs` for why it
          // is explained rather than fixed.
          BROWSER_PASSWORD_FORM_HINT,
          // THE TWO LINES THIS ROW EXISTS TO PROVOKE, and the first of them is one `watch.mjs`
          // explicitly says is a FINDING wherever it appears. That is right, and it is why it is
          // named HERE and nowhere wider: the warning fires when a device key arrives with no
          // encrypted state beside it AND a state was genuinely expected, which since 2026-08-31 the
          // caller states rather than guesses. CORRUPT-4 arranges precisely that condition on
          // purpose - a device that HAD 18 MB of state, truncated to zero one second earlier. The
          // warning firing is the mechanism working; its ABSENCE here would be the defect.
          'device_key_b64 provided but no encrypted state',
          // And the product's own account of what it does next, which is the row's claim in the
          // app's words: the groups are marked not-ready and re-joined. The `[READD] ... rejoined
          // via external commit (self-service)` lines that follow are already `notable`.
          'Groups without local MLS state detected',
        ]),
      });
      record('CORRUPT-4', gated.verdict, {
        ...gated.detail,
        // The truncation is the STIMULUS. Whatever the client says about rebuilding a state is this
        // row's evidence rather than noise it tolerates - the same disposition, for the same reason,
        // as the HEAL rows that rewind a ratchet.
        unobservable:
          'truncates mls_autosave to ZERO BYTES on purpose - a client rebuilding its MLS state is ' +
          'what this row asserts, not noise it forgives',
        unmet,
        signedInInMs,
        budgetMs: SETTLE_BUDGET_MS,
        // A LENGTH, NEVER THE BYTES - live key material for a real account, and the rule the whole
        // of `mlsdb.mjs` is built on.
        stateLenBefore: stateBefore.len,
        stateHashBefore: stateBefore.hash,
        stateLenAfter: after ? after.len : null,
        snapshotTakenAt: snap.takenAt ?? null,
        misdiagnosed: misdiagnosed.map((t) => t.slice(0, 200)),
      });
    }
  }
} finally {
  // THE SNAPSHOT GOES BACK WHATEVER HAPPENED, including on a throw. A row that leaves W1 with a
  // rebuilt MLS client has not measured a defect, it has caused one - every later row would then be
  // measuring a device that lost its groups here, and would name this file nowhere.
  if (damaged) {
    const back = mlsdb('restore').trim();
    console.log(`[corrupt4] restore: ${back.replace(/\s+/g, ' ').slice(0, 200)}`);
    await evaluate(w1, `window.__corrupt4Stamp = 1`).catch(() => {});
    await w1.send('Page.reload', { ignoreCache: false }).catch(() => {});
    await until(w1, `!window.__corrupt4Stamp`, SETTLE_BUDGET_MS).catch(() => null);
    const restored = entryOf(JSON.parse(mlsdb('digest')));
    // THE RESTORE IS ASSERTED, NOT ASSUMED. `stateHashBefore` is the only thing that can say the
    // state W1 carries now is the state it carried before this file ran.
    console.log(
      `[corrupt4] state is ${restored ? restored.len + ' bytes / ' + restored.hash : 'ABSENT'} ` +
        `(was ${stateBefore ? stateBefore.len + ' bytes / ' + stateBefore.hash : 'absent'}) - ` +
        (restored && stateBefore && restored.hash === stateBefore.hash
          ? 'IDENTICAL'
          : 'NOT THE STATE IT STARTED WITH')
    );
  }
  const ready = await bringToReady('W1');
  console.log(
    `[corrupt4] teardown: W1 ${ready.ok ? 'is back at a named starting point' : 'DID NOT RECOVER'}`
  );
}

exitOnRecorded();
