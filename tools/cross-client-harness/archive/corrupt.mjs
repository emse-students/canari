#!/usr/bin/env node
/**
 * CORRUPT - deliberate store damage, and whether the app SAYS SO rather than failing quietly.
 *
 * The phase existed on the board with ten rows and `scripts: []`: designed, never runnable. This is
 * its first runner and it answers ONE row, because the damage each row needs is different and a
 * file that claims a phase it half implements is how a rung reads green while nothing ran it.
 *
 * **CORRUPT-3 - the web vault blob replaced with valid base64 of garbage.** The row's whole claim is
 * `must surface, not hang`, and those are two assertions rather than one:
 *
 *  - NOT HANG: the app reaches a determinate state - its PIN gate - rather than sitting on a
 *    spinner. Measured as a DEADLINE, so a client that recovers instantly costs nothing.
 *  - SURFACE: a `[VAULT]` line names what was found. Until 2026-09-08 there was none: a malformed
 *    blob returned null in silence and left itself in place to fail identically on every later
 *    load, and every other failure shared one catch that named two causes and separated neither.
 *
 * And a THIRD thing the row does not say but the fix requires: the damaged blob must be GONE
 * afterwards. A vault that fails and stays is a vault that fails for ever.
 *
 * **THE DAMAGE IS SHAPED, NOT RANDOM.** `iv:cipher`, both halves valid base64, so the blob passes
 * the separator check and the base64 decode and dies at the AEAD tag - which is the case the row
 * names. Random bytes would die earlier and measure the parser instead.
 *
 * **WHAT IT COSTS AND HOW IT IS GIVEN BACK.** The vault holds the device key, so damaging it costs
 * W1 its unlocked session and nothing else: no MLS state is touched, no group, no message. The
 * teardown is the product's own recovery - `bringToReady` answers the PIN gate - and it runs on
 * every exit, including a failed one. The original blob is copied first and put back if the app
 * left it alone, so a run that proves the defect does not also destroy the evidence.
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
import { bringToReady } from './ready-repair.mjs';

const BLOB_KEY = 'canari_device_key_vault';
const WRAP_KEY = 'canari_device_key_vault_key';
const PERSIST_KEY = 'canari_device_key_persist';

/** Valid base64 on both sides of the separator, and cipher bytes no wrap key ever produced. */
const GARBAGE = 'aXYtMTIzNDU2Nzg5MDEy:dGhpcy1jaXBoZXJ0ZXh0LXdhcy1uZXZlci1zZWFsZWQtaGVyZQ==';

/** How long the app is given to reach its gate. A deadline: it returns the moment it does. */
const SETTLE_BUDGET_MS = 30_000;

const w1 = await client(PORTS.W1, APP_TAB, { focus: false });

/** Which store the vault uses is the user's "stay signed in" preference, so it is READ, not assumed. */
const storeName = await evaluate(
  w1,
  `localStorage.getItem('${PERSIST_KEY}') === 'true' ? 'localStorage' : 'sessionStorage'`
);

const before = JSON.parse(
  await evaluate(
    w1,
    `JSON.stringify({ blob: ${storeName}.getItem('${BLOB_KEY}'), wrap: ${storeName}.getItem('${WRAP_KEY}') })`
  )
);

try {
  // NOT A PRECONDITION THIS CHECK MAY REPAIR. A device with no vault has nothing to corrupt, and
  // writing one here would measure a blob this script minted rather than one the product wrote.
  if (!before.blob || !before.wrap) {
    record('CORRUPT-3', 'SKIPPED', {
      reason:
        `W1 holds no device-key vault in ${storeName} (blob: ${!!before.blob}, wrap key: ${!!before.wrap}) - ` +
        'there is nothing to damage, and minting one here would measure this script rather than the product',
    });
  } else {
    const obs = await watch(w1, 'CORRUPT-3-W1');

    await evaluate(w1, `${storeName}.setItem('${BLOB_KEY}', ${JSON.stringify(GARBAGE)})`);
    // STAMP THE DOCUMENT THAT IS ABOUT TO DIE. Measured on this check's own first run: `awaitAppReady`
    // answered SIX MILLISECONDS after `Page.reload` was sent, because it was asked of the OLD
    // document, which was of course still ready - so the run reported a settle time for a page that
    // had not reloaded, and read a console and a vault the app had never been asked to touch. A
    // fresh document carries no stamp, so waiting for it to be GONE waits on the navigation itself
    // rather than on a duration somebody guessed.
    await evaluate(w1, `window.__corruptStamp = 1`);
    const damagedAt = Date.now();
    await w1.send('Page.reload', { ignoreCache: false });
    await until(w1, `!window.__corruptStamp`, SETTLE_BUDGET_MS).catch(() => null);

    // DID IT REACH A STATE. `awaitAppReady` resolves on the app, not on a clock, so a client that
    // recovers in two seconds is measured at two seconds and one that never does is measured at the
    // deadline - which is the difference between "surfaced" and "hung" stated as a number.
    let settledInMs = null;
    await awaitAppReady(w1, SETTLE_BUDGET_MS)
      .then(() => {
        settledInMs = Date.now() - damagedAt;
      })
      .catch(() => {});

    // WHERE IT ENDED, AND WHY THIS IS NOT THE SAME QUESTION AS `settledInMs`. The row's claim is
    // `must surface, not hang`, and a device that has lost its device key is ENTITLED to end at a
    // sign-in page: that is surfacing, loudly, in the product's own vocabulary. The first version of
    // this check asserted APP_READY and would have recorded `theAppNeverReachedAReadableState` for
    // it - accusing the product of a hang for a state the check had simply not anticipated, which is
    // the fault this campaign calls a check that does not fail but lies. What a hang looks like is
    // NEITHER: no /chat, no sign-in, nothing determinate before the deadline.
    const where = await evaluate(
      w1,
      `JSON.stringify({ path: location.pathname, host: location.host, hasPasswordField: !!document.querySelector('input[type=password]') })`
    ).then(JSON.parse, () => null);
    const determinate = settledInMs !== null || !!(where && (where.hasPasswordField || /login|auth/i.test(where.path)));

    const after = JSON.parse(
      await evaluate(
        w1,
        `JSON.stringify({ blob: ${storeName}.getItem('${BLOB_KEY}'), wrap: ${storeName}.getItem('${WRAP_KEY}') })`
      )
    );

    // WAITED FOR, NOT READ ONCE - and read as what it is. `consoleLines` returns STRINGS; the first
    // version of this check mapped `.text` over them, so every entry became `undefined`, the
    // `[VAULT]` filter matched nothing, and the row recorded `nothingSurfacedOnTheConsole` against a
    // client that had said exactly what was asked of it. A check that cannot see the thing whose
    // absence it asserts does not fail - it LIES, in the direction of a finding, which is the
    // expensive direction: it accuses the product and it closes the question.
    //
    // The bound is the other half of the same lesson (`awaitLine`'s own doc, from COMM-19): the
    // vault line is written during the BOOT THAT FOLLOWS the reload, so reading the instant the
    // navigation settles is a race, and an absence is only a finding against a window a reader can
    // argue with. Nine seconds, under the ten this campaign allows itself anywhere.
    await awaitLine(w1, '[VAULT]', 9_000);
    const said = consoleLines(w1).filter((t) => /\[VAULT\]/.test(t));
    const surfaced = said.some((t) => /did not decrypt|malformed|wrap key is gone/i.test(t));
    // THE DAMAGED BLOB MUST BE GONE. A vault that fails and keeps the blob fails the same way for
    // ever, one line per load, and that is the half of this the row's own wording does not carry.
    const cleared = after.blob === null;
    // Nothing else may be collateral: the wrap key is not the damaged thing and must survive, or
    // the "ordinary" branch would start firing on a device nobody touched.
    const wrapKept = after.wrap === before.wrap;

    const unmet = [];
    if (!determinate) unmet.push('theAppReachedNoDeterminateState');
    if (!surfaced) unmet.push('nothingSurfacedOnTheConsole');
    if (!cleared) unmet.push('theDamagedBlobWasLeftInPlace');
    if (!wrapKept) unmet.push('theWrapKeyWasCollateral');

    // THE ONE LINE THE DAMAGE IS GUARANTEED TO PROVOKE, and it is Chrome's rather than the app's:
    // losing the vault puts the PIN gate on screen, and Chrome hints against any form carrying a
    // password field. Named here as ONE needle rather than taken from a wider list, for the reason
    // PIN-11 gives: this row never gets past the gate before it reports, so a line saying the MLS
    // client was rebuilt would be a FINDING here and must not be forgiven alongside it.
    //
    // AND IT IS EXPLAINED RATHER THAN FIXED, deliberately. Chrome's documented remedy is a username
    // field beside the password one, which on THIS gate would invite a password manager to store an
    // end-to-end encryption secret the product promises is never transmitted anywhere. The
    // disposition is written out in full over `BROWSER_PASSWORD_FORM_HINT` in `watch.mjs`.
    const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
      W1: ignoringExpectedLog(await report(obs), [BROWSER_PASSWORD_FORM_HINT]),
    });
    record('CORRUPT-3', gated.verdict, {
      ...gated.detail,
      // The damage is the STIMULUS, so the vault lines are this check's assertion rather than dirt -
      // the same disposition, and for the same reason, as the HEAL rows that rewind a ratchet.
      unobservable:
        'replaces the device-key vault blob with valid base64 of garbage ON PURPOSE - the [VAULT] ' +
        'lines are what this row reads, not noise it tolerates',
      store: storeName,
      unmet,
      settledInMs,
      budgetMs: SETTLE_BUDGET_MS,
      determinate,
      endedAt: where,
      surfaced,
      clearedTheDamagedBlob: cleared,
      wrapKeyKept: wrapKept,
      vaultLines: said.map((t) => t.slice(0, 200)),
    });
  }
} finally {
  // THE TEARDOWN IS THE PRODUCT'S OWN RECOVERY, and it runs on every exit including a failed one:
  // a check that leaves W1 locked has moved a manual step rather than measured anything. If the app
  // left the damaged blob in place, put the original back - a run that proves that defect must not
  // also be the reason the device stays broken.
  const still = await evaluate(w1, `${storeName}.getItem('${BLOB_KEY}')`).catch(() => null);
  if (still === GARBAGE && before.blob) {
    await evaluate(
      w1,
      `${storeName}.setItem('${BLOB_KEY}', ${JSON.stringify(before.blob)})`
    ).catch(() => {});
    console.log('[corrupt] the app left the damaged blob in place - the original was restored');
  }
  const ready = await bringToReady('W1');
  console.log(`[corrupt] teardown: W1 ${ready.ok ? 'is back at a named starting point' : 'DID NOT RECOVER'}`);
}

exitOnRecorded();
