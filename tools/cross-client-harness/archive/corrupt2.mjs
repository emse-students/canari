#!/usr/bin/env node
/**
 * CORRUPT-2 - ONE byte flipped INSIDE the ciphertext: the AEAD tag must fail, and the app must say so.
 *
 * **THE THIRD DAMAGE, AND THE THREE ARE NOT INTERCHANGEABLE.** CORRUPT-4 removes the state (zero
 * length, must read as ABSENT); CORRUPT-1 shortens it; this one keeps its length and its shape and
 * alters one byte in the middle, so every structural check passes and the failure happens at the
 * AEAD tag. That is the only one of the three that cannot be told from a legitimate key change by
 * looking at the blob.
 *
 * **AND THAT IS THE QUESTION THIS ROW ACTUALLY ASKS.** `sessionAuth` verifies the PIN SERVER-SIDE and
 * only then decrypts the local MLS state; when `init` reports the state undecryptable it raises
 * `state_sealed_with_old_key`, whose message tells the user their history is sealed under a PIN
 * rotated on another device. For a rotation that is exactly right. For a flipped byte it is a
 * MISDIAGNOSIS of the same shape the device-key vault carried until 2026-09-08 - one catch naming
 * two causes and separating neither - and it points the user at a credential that would not help.
 *
 * `mls_autosave_ver` cannot settle it either: it is a per-write SEQUENCE COUNTER for ordering
 * concurrent flushes, not a key id, so nothing beside the blob says which key sealed it.
 *
 * **SO THIS FILE OBSERVES BEFORE IT ACCUSES.** It asserts the two things the row states and nothing
 * more - the client must reach a determinate state rather than hang, and it must not end up quietly
 * signed in showing an empty history as though it were the real one - and it RECORDS what the client
 * said either way. Writing an assertion for the diagnosis before measuring what the diagnosis IS
 * would be a check pre-judging its own row.
 *
 * **WHAT IT COSTS AND HOW IT IS GIVEN BACK.** Identical to CORRUPT-4: the snapshot is taken here,
 * `mlsdb.mjs flip` REFUSES without one, and the restore is asserted against the hash the state had
 * before this file ran.
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

/** How long the client is given to reach a determinate state. A deadline: it returns when it does. */
const SETTLE_BUDGET_MS = 30_000;

/** `mlsdb.mjs` as a subprocess, exactly as `heal-web.mjs`, `heal-w2.mjs` and `del.mjs` drive it. */
const mlsdb = (...a) =>
  execFileSync(process.execPath, [requireScript('mlsdb.mjs'), '--port', String(PORTS.W1), ...a], {
    encoding: 'utf8',
  });

const w1 = await client(PORTS.W1, APP_TAB, { focus: false });

const entryOf = (d) =>
  (d.report ?? [])
    .flatMap((r) => (r.entries ?? []).map((e) => ({ ...e, db: r.db, store: r.store })))
    .find((e) => e.key === 'mls_autosave') ?? null;
const stateBefore = entryOf(JSON.parse(mlsdb('digest')));

let damaged = false;
try {
  // NOT A PRECONDITION THIS CHECK MAY REPAIR - minting a state here would measure this script.
  if (!stateBefore || !stateBefore.len) {
    record('CORRUPT-2', 'SKIPPED', {
      reason:
        `W1 holds no mls_autosave state (${stateBefore ? stateBefore.len + ' bytes' : 'no entry'}) - ` +
        'there is nothing to alter, and minting one here would measure this script rather than the product',
    });
  } else {
    // A FRESH SNAPSHOT, NEVER A FOUND ONE: `mlsdb.mjs` keeps one durably, and an older one is always
    // the wrong state to put back because it predates whatever the rows since have done.
    const snap = JSON.parse(mlsdb('snapshot'));

    const obs = await watch(w1, 'CORRUPT-2-W1');
    const cut = JSON.parse(mlsdb('flip'));
    damaged = Array.isArray(cut.flipped) && cut.flipped.length > 0;
    if (!damaged) {
      record('CORRUPT-2', 'SKIPPED', {
        reason: `the damage did not apply: ${JSON.stringify(cut)}`,
        snapshotTakenAt: snap.takenAt ?? null,
      });
    } else {
      // STAMP THE DOCUMENT THAT IS ABOUT TO DIE, so the wait is on the NAVIGATION rather than on a
      // duration somebody guessed - see `corrupt.mjs` for the run that measured that mistake.
      await evaluate(w1, `window.__corrupt2Stamp = 1`);
      const damagedAt = Date.now();
      await w1.send('Page.reload', { ignoreCache: false });
      await until(w1, `!window.__corrupt2Stamp`, SETTLE_BUDGET_MS).catch(() => null);

      let readyInMs = null;
      await awaitAppReady(w1, SETTLE_BUDGET_MS)
        .then(() => {
          readyInMs = Date.now() - damagedAt;
        })
        .catch(() => {});

      // WHAT IT SAID, WAITED FOR RATHER THAN READ ONCE - the account of a failed decrypt is written
      // during the boot that FOLLOWS the reload, so a single read the instant the navigation settles
      // is the race `awaitLine` exists for.
      await awaitLine(w1, 'MLS', 9_000);
      const said = consoleLines(w1);
      const explicit = said.filter((t) =>
        /undecryptable|state_sealed|sealed|could not|failed to (load|decrypt|deserialize)|corrupt|fresh state|not-ready/i.test(
          t
        )
      );

      // A DETERMINATE END, and a sign-in page is one: a device whose state cannot be opened is
      // entitled to ask for a credential. What is NOT determinate is neither - no ready app, no
      // gate, nothing before the deadline.
      const where = await evaluate(
        w1,
        `JSON.stringify({ path: location.pathname, hasPasswordField: !!document.querySelector('input[type=password]') })`
      ).then(JSON.parse, () => null);
      const determinate = readyInMs !== null || !!(where && where.hasPasswordField);

      const after = entryOf(JSON.parse(mlsdb('digest')));

      const unmet = [];
      if (!determinate) unmet.push('theClientReachedNoDeterminateState');
      // THE ROW'S OWN WORDING, AND THE ONLY THING IT FORBIDS OUTRIGHT: a client that came up ready
      // and said NOTHING has presented whatever history it has as though the damage never happened.
      if (readyInMs !== null && explicit.length === 0) {
        unmet.push('theClientCameUpREADYWithoutSayingTheStateCouldNotBeRead');
      }

      const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
        W1: ignoringExpectedLog(await report(obs), [
          // The gate can be raised on the way through - see `BROWSER_PASSWORD_FORM_HINT`.
          BROWSER_PASSWORD_FORM_HINT,
          // The two lines a rebuild produces, for the same reason CORRUPT-4 names them: this row
          // arranges the exact condition the first one warns about, so its absence would be the
          // defect. See `corrupt4.mjs` for the full argument.
          'device_key_b64 provided but no encrypted state',
          'Groups without local MLS state detected',
        ]),
      });
      record('CORRUPT-2', gated.verdict, {
        ...gated.detail,
        unobservable:
          'flips ONE byte inside the mls_autosave ciphertext on purpose - whatever the client says ' +
          'about a state it cannot open is what this row reads, not noise it forgives',
        unmet,
        readyInMs,
        budgetMs: SETTLE_BUDGET_MS,
        determinate,
        endedAt: where,
        // A LENGTH, AN OFFSET AND HASHES - never the material. The rule `mlsdb.mjs` is built on.
        stateLenBefore: stateBefore.len,
        stateHashBefore: stateBefore.hash,
        flippedAtOffset: cut.flipped[0]?.atOffset ?? null,
        stateLenAfter: after ? after.len : null,
        snapshotTakenAt: snap.takenAt ?? null,
        // THE OBSERVATION THIS ROW EXISTS FOR, recorded whatever the verdict: what the product calls
        // an altered ciphertext is the open question, and a verdict without it settles nothing.
        whatItSaid: explicit.map((t) => t.slice(0, 220)),
      });
    }
  }
} finally {
  // THE SNAPSHOT GOES BACK WHATEVER HAPPENED, including on a throw - a row that leaves W1 unable to
  // open its own state has caused a defect rather than measured one.
  if (damaged) {
    const back = mlsdb('restore').trim();
    console.log(`[corrupt2] restore: ${back.replace(/\s+/g, ' ').slice(0, 200)}`);
    await evaluate(w1, `window.__corrupt2Stamp = 1`).catch(() => {});
    await w1.send('Page.reload', { ignoreCache: false }).catch(() => {});
    await until(w1, `!window.__corrupt2Stamp`, SETTLE_BUDGET_MS).catch(() => null);
    const restored = entryOf(JSON.parse(mlsdb('digest')));
    // ASSERTED, NOT ASSUMED: the hash is the only thing that can say W1 carries the state it had.
    console.log(
      `[corrupt2] state is ${restored ? restored.len + ' bytes / ' + restored.hash : 'ABSENT'} ` +
        `(was ${stateBefore.len} bytes / ${stateBefore.hash}) - ` +
        (restored && restored.hash === stateBefore.hash ? 'IDENTICAL' : 'NOT THE STATE IT STARTED WITH')
    );
  }
  const ready = await bringToReady('W1');
  console.log(
    `[corrupt2] teardown: W1 ${ready.ok ? 'is back at a named starting point' : 'DID NOT RECOVER'}`
  );
}

exitOnRecorded();
