#!/usr/bin/env node
/**
 * CORRUPT-1 - a SHORTENED MLS store: explicit failure and RECOVERY, never a silent empty history.
 *
 * **THE THIRD SHAPE OF THE SAME DAMAGE, AND THE ONE THAT ACTUALLY HAPPENS.** CORRUPT-4 removes the
 * state entirely and CORRUPT-2 alters a byte inside it; this one leaves a PREFIX - which is what an
 * interrupted flush, a full disk or a killed tab actually leave behind. Half the bytes, written by
 * the product, ending mid-structure.
 *
 * **AND IT ASKS THE HALF ITS SIBLINGS DO NOT.** CORRUPT-2 measured what the client SAYS about a
 * state it cannot open, and the answer was a P1: it reports a PIN rotated on another device, at a
 * moment when the PIN in the user's hands has just been verified server-side. What that row did not
 * ask is whether the user has a way BACK - and this row's wording demands one in as many words:
 * *explicit failure and recovery*. So the recovery is exercised here, with the product's own
 * gesture: the correct PIN is entered at the gate the failure raises, and whether the client reaches
 * a named starting point afterwards is the measurement.
 *
 * A misdiagnosis the user can walk out of is a bad message. A misdiagnosis they cannot is a locked
 * door, and the two deserve different severities - which is why this row exists separately rather
 * than being folded into CORRUPT-2 as another assertion.
 *
 * **WHAT IT COSTS AND HOW IT IS GIVEN BACK.** Identical to its siblings: the snapshot is taken here,
 * `mlsdb.mjs truncate` REFUSES without one, and the restore is asserted against the hash the state
 * carried before this file ran - so a run that proves a defect does not also become one.
 */
import { APP_TAB, awaitAppReady, client, evaluate } from '../chat.mjs';
import { until } from '../cdp.mjs';
import {
  BROWSER_PASSWORD_FORM_HINT,
  awaitLine,
  consoleLines,
  gate,
  ignoringExpectedLog,
  MLS_CLIENT_INITIALISING,
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
  // NOT A PRECONDITION THIS CHECK MAY REPAIR - minting a state here would measure this script. The
  // floor is two bytes because a one-byte state cannot be shortened to a non-empty prefix, and this
  // row is about a prefix: at zero it would silently become CORRUPT-4 and answer the wrong question.
  if (!stateBefore || stateBefore.len < 2) {
    record('CORRUPT-1', 'SKIPPED', {
      reason:
        `W1 holds no shortenable mls_autosave state (${stateBefore ? stateBefore.len + ' bytes' : 'no entry'}) - ` +
        'a prefix needs something to be a prefix OF, and minting one here would measure this script',
    });
  } else {
    const snap = JSON.parse(mlsdb('snapshot'));

    const obs = await watch(w1, 'CORRUPT-1-W1');
    // HALF, so the survivor is unambiguously a PREFIX of real product output and unambiguously not
    // the whole of it. A fixed fraction rather than a random cut, for the reason `flip` picks the
    // midpoint: a stimulus that moves between runs cannot tell a flaky product from a flaky check.
    const keepBytes = Math.floor(stateBefore.len / 2);
    const cut = JSON.parse(mlsdb('truncate', '--to', String(keepBytes)));
    damaged = Array.isArray(cut.truncated) && cut.truncated.length > 0;
    if (!damaged) {
      record('CORRUPT-1', 'SKIPPED', {
        reason: `the damage did not apply: ${JSON.stringify(cut)}`,
        snapshotTakenAt: snap.takenAt ?? null,
      });
    } else {
      await evaluate(w1, `window.__corrupt1Stamp = 1`);
      const damagedAt = Date.now();
      await w1.send('Page.reload', { ignoreCache: false });
      await until(w1, `!window.__corrupt1Stamp`, SETTLE_BUDGET_MS).catch(() => null);

      let readyInMs = null;
      await awaitAppReady(w1, SETTLE_BUDGET_MS)
        .then(() => {
          readyInMs = Date.now() - damagedAt;
        })
        .catch(() => {});

      // WAITED FOR, NOT READ ONCE - the account of a failed load is written during the boot that
      // FOLLOWS the reload, which is the race `awaitLine` exists for.
      await awaitLine(w1, 'MLS', 9_000);
      const said = consoleLines(w1);
      const explicit = said.filter((t) =>
        /undecryptable|state_sealed|sealed|could not|failed to (load|decrypt|deserialize)|corrupt|fresh state|not-ready/i.test(
          t
        )
      );

      const where = await evaluate(
        w1,
        `JSON.stringify({ path: location.pathname, hasPasswordField: !!document.querySelector('input[type=password]') })`
      ).then(JSON.parse, () => null);

      // THE HALF THIS ROW IS FOR. `bringToReady` is the PRODUCT's recovery, not the harness's: it
      // answers the gate with the correct PIN, exactly as a user would. It runs BEFORE the restore
      // on purpose - afterwards the state is whole again and the question would answer itself.
      const recovery = await bringToReady('W1');

      const unmet = [];
      if (readyInMs === null && !(where && where.hasPasswordField)) {
        unmet.push('theClientReachedNoDeterminateState');
      }
      if (readyInMs !== null && explicit.length === 0) {
        unmet.push('theClientCameUpREADYWithoutSayingTheStateCouldNotBeRead');
      }
      // The row's own second word, and the one CORRUPT-2 never asked: a failure the user cannot
      // walk out of with the credential they actually hold is a locked door, not a message.
      if (!recovery.ok) unmet.push('theCORRECTpinDidNotGetTheUserBackIn');

      const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
        W1: ignoringExpectedLog(await report(obs), [
          BROWSER_PASSWORD_FORM_HINT,
          // The two rebuild lines, named for the reason `corrupt4.mjs` sets out in full: this row
          // arranges the exact condition the first one warns about, so its absence would be a defect.
          'device_key_b64 provided but no encrypted state',
          'Groups without local MLS state detected',
          // AND THE ONE NEEDLE ONLY THIS ROW OF THE FOUR TAKES. `Initialising MLS...` appears where
          // a device key has just been unwrapped, which is what answering the gate CAUSES - and
          // answering the gate with the correct PIN is this row's own assertion, not a side effect.
          // `corrupt2.mjs` and `corrupt4.mjs` report BEFORE any such gesture, so the same sentence
          // would be a finding there: a disposition is per row because one row's evidence is
          // another's defect.
          MLS_CLIENT_INITIALISING,
        ]),
      });
      record('CORRUPT-1', gated.verdict, {
        ...gated.detail,
        unobservable:
          'shortens the mls_autosave state to half its length on purpose - whatever the client says ' +
          'about a state it cannot read is what this row reads, not noise it forgives',
        unmet,
        readyInMs,
        budgetMs: SETTLE_BUDGET_MS,
        endedAt: where,
        // A LENGTH AND A HASH, never the material - the rule `mlsdb.mjs` is built on.
        stateLenBefore: stateBefore.len,
        stateHashBefore: stateBefore.hash,
        keptBytes: keepBytes,
        snapshotTakenAt: snap.takenAt ?? null,
        // BOTH HALVES RECORDED WHATEVER THE VERDICT: what the product calls a short state, and
        // whether the correct PIN was a way back out of it.
        whatItSaid: explicit.map((t) => t.slice(0, 220)),
        recoveredWithTheCorrectPin: recovery.ok,
        recoveryTrail: recovery.trail ?? null,
      });
    }
  }
} finally {
  if (damaged) {
    const back = mlsdb('restore').trim();
    console.log(`[corrupt1] restore: ${back.replace(/\s+/g, ' ').slice(0, 200)}`);
    await evaluate(w1, `window.__corrupt1Stamp = 1`).catch(() => {});
    await w1.send('Page.reload', { ignoreCache: false }).catch(() => {});
    await until(w1, `!window.__corrupt1Stamp`, SETTLE_BUDGET_MS).catch(() => null);
    const restored = entryOf(JSON.parse(mlsdb('digest')));
    console.log(
      `[corrupt1] state is ${restored ? restored.len + ' bytes / ' + restored.hash : 'ABSENT'} ` +
        `(was ${stateBefore.len} bytes / ${stateBefore.hash}) - ` +
        (restored && restored.hash === stateBefore.hash ? 'IDENTICAL' : 'NOT THE STATE IT STARTED WITH')
    );
  }
  const ready = await bringToReady('W1');
  console.log(
    `[corrupt1] teardown: W1 ${ready.ok ? 'is back at a named starting point' : 'DID NOT RECOVER'}`
  );
}

exitOnRecorded();
