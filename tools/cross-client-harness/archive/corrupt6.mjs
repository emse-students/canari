#!/usr/bin/env node
/**
 * CORRUPT-6 - a DAMAGED device-key vault: recover or fail loudly, never a decrypt loop.
 *
 * **THE ROW HAS THREE SHAPES AND THEY ARE NOT INTERCHANGEABLE, WHICH IS THE WHOLE POINT.**
 * `loadDeviceKey` has three refusal branches and each names a different cause: a blob with no `iv`
 * separator (structurally impossible, never decryptable), a blob whose WRAP KEY is gone (ordinary
 * after a storage clear or a persistence-mode switch, explicitly *not* evidence of tampering), and a
 * blob that did not decrypt under a wrap key that IS present (everything ordinary excluded, so the
 * line accuses). Until 2026-09-08 the last two were one `catch` naming both causes and separating
 * neither - on the one path in that file where the difference is a security signal rather than a
 * detail. This row is what holds that separation in place, so it drives all three and requires each
 * to produce ITS OWN line rather than merely "a warning".
 *
 * **AND "NEVER A DECRYPT LOOP" IS ASSERTED AS A COUNT, NOT AS A FEELING.** The row's own words are
 * *recover or fail loudly, never a decrypt loop*, and the loop it forbids is the one the first branch
 * was written for: a refusal that leaves the bad blob in place fails identically on every later load,
 * for ever, having said something once. So each shape checks two things beyond the message - that the
 * blob is GONE afterwards, and that the line appeared exactly ONCE in the boot that produced it. One
 * without the other proves nothing: a cleared blob with a silent clear is the old defect, and a loud
 * line over a surviving blob is the loop.
 *
 * **WHAT IT DOES NOT ASSERT, DELIBERATELY.** That the wrap key is also removed. `clearDeviceKey`
 * drops the BLOB from both stores and leaves the wrap key, and `clearDeviceKeyAndWrapKey` is a
 * different gesture for logout and key compromise. Asserting the stronger one here would be this
 * check inventing a product decision.
 *
 * **WHERE THE VAULT ACTUALLY LIVES IS READ, NEVER ASSUMED.** `vaultStore()` is `localStorage` when
 * "stay signed in" is on and `sessionStorage` otherwise, so a runner that hard-coded either would
 * damage nothing on half the fleet and report a clean pass - a check that cannot see what it asserts
 * the absence of does not fail, it lies. The store is chosen here by reading the persistence flag the
 * product reads, and the store it picked is recorded in the row.
 *
 * **WHAT IT COSTS AND HOW IT IS GIVEN BACK.** Both vault entries are read before anything is touched
 * and written back in a `finally`, and the restore is ASSERTED against what was there. A shape that
 * cannot be set up is skipped rather than approximated: nothing here mints a vault, because a vault
 * this script created would measure this script.
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

/** How long the client is given to reach a determinate state. A deadline: it returns when it does. */
const SETTLE_BUDGET_MS = 30_000;

const BLOB_KEY = 'canari_device_key_vault';
const WRAP_KEY = 'canari_device_key_vault_key';

/**
 * The three damages, each with the line it must produce.
 *
 * The needles are the stable, cause-bearing part of each sentence and nothing more: matching a whole
 * message would make this row fail on a rewording, and matching only `[VAULT]` would let any of the
 * three satisfy any other - which is exactly the confusion the row exists to prevent.
 */
const SHAPES = [
  {
    key: 'noSeparator',
    what: 'the blob has no iv separator',
    needle: 'malformed (no iv separator)',
    // A colon-free string. Structurally impossible to split, so it can never reach a decrypt.
    damage: `(() => { const s = STORE; s.setItem(BLOB, 'nocolonhere' + s.getItem(BLOB).replace(/:/g, '')); })()`,
  },
  {
    key: 'wrapKeyGone',
    what: 'the blob is present and its wrap key is gone',
    needle: 'wrap key is gone',
    damage: `(() => { STORE.removeItem(WRAP); })()`,
  },
  {
    key: 'alteredCiphertext',
    what: 'one byte of the ciphertext is altered, wrap key present',
    needle: 'did not decrypt under a wrap key that IS present',
    // THE MIDDLE OF THE CIPHERTEXT HALF, and a fixed position for the reason `mlsdb.mjs flip` picks
    // the midpoint: a stimulus that moves between runs cannot tell a flaky product from a flaky
    // check. The base64 alphabet is rotated by one so the result stays decodable and the failure
    // happens at the AEAD tag - which is the branch being tested - rather than at `atob`.
    damage: `(() => {
      const s = STORE, v = s.getItem(BLOB), i = v.indexOf(':');
      const iv = v.slice(0, i), c = v.slice(i + 1);
      const at = Math.floor(c.length / 2);
      const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const cur = c[at], nxt = AB[(AB.indexOf(cur) + 1) % 64];
      s.setItem(BLOB, iv + ':' + c.slice(0, at) + nxt + c.slice(at + 1));
    })()`,
  },
];

const w1 = await client(PORTS.W1, APP_TAB, { focus: false });

/** Runs a snippet against the store the PRODUCT would use, with BLOB/WRAP/STORE bound. */
const inVault = (body) =>
  evaluate(
    w1,
    `(() => {
       const STORE = localStorage.getItem('canari_device_key_persist') === 'true' ? localStorage : sessionStorage;
       const BLOB = ${JSON.stringify(BLOB_KEY)}, WRAP = ${JSON.stringify(WRAP_KEY)};
       ${body}
     })()`
  );

const readVault = () =>
  inVault(
    `return JSON.stringify({
       store: STORE === localStorage ? 'localStorage' : 'sessionStorage',
       blob: STORE.getItem(BLOB), wrap: STORE.getItem(WRAP),
     });`
  ).then(JSON.parse);

const before = await readVault();

let touched = false;
try {
  // NOT A PRECONDITION THIS CHECK MAY BUILD. A vault minted here would be this script's, and the
  // three branches would then be measured against a blob no product code ever wrote.
  if (!before.blob || !before.wrap) {
    record('CORRUPT-6', 'SKIPPED', {
      reason:
        `W1 holds no device-key vault in ${before.store} ` +
        `(blob ${before.blob ? 'present' : 'ABSENT'}, wrap key ${before.wrap ? 'present' : 'ABSENT'}) - ` +
        'this device has not opted into a stored device key, and minting one here would measure this script',
      store: before.store,
    });
  } else {
    const results = [];
    for (const shape of SHAPES) {
      // EACH SHAPE STARTS FROM THE INTACT VAULT, so a later shape never inherits an earlier one's
      // damage - three independent measurements rather than one compounding sequence.
      await inVault(
        `STORE.setItem(BLOB, ${JSON.stringify(before.blob)}); STORE.setItem(WRAP, ${JSON.stringify(before.wrap)});`
      );

      const obs = await watch(w1, `CORRUPT-6-${shape.key}`);
      await inVault(shape.damage);
      touched = true;

      await evaluate(w1, `window.__corrupt6Stamp = 1`);
      const damagedAt = Date.now();
      await w1.send('Page.reload', { ignoreCache: false });
      await until(w1, `!window.__corrupt6Stamp`, SETTLE_BUDGET_MS).catch(() => null);

      let readyInMs = null;
      await awaitAppReady(w1, SETTLE_BUDGET_MS)
        .then(() => {
          readyInMs = Date.now() - damagedAt;
        })
        .catch(() => {});

      // WAITED FOR, NOT READ ONCE - the account of a refused vault is written during the boot that
      // FOLLOWS the reload, which is the race `awaitLine` exists for.
      await awaitLine(w1, '[VAULT]', 9_000).catch(() => null);
      const said = consoleLines(w1).filter((t) => t.includes('[VAULT]'));
      const matching = said.filter((t) => t.includes(shape.needle));

      const after = await readVault();
      const where = await evaluate(
        w1,
        `JSON.stringify({ path: location.pathname, hasPasswordField: !!document.querySelector('input[type=password]') })`
      ).then(JSON.parse, () => null);

      const unmet = [];
      if (matching.length === 0) unmet.push('theRefusalDidNotNameThisCause');
      // THE LOOP THE ROW FORBIDS. Twice in one boot is a retry nobody asked for; the durable half is
      // the cleared blob below, and both are needed - see the docblock.
      if (matching.length > 1) unmet.push('theSameRefusalWasPrintedMoreThanOnceInOneBoot');
      if (after.blob !== null)
        unmet.push('theUnusableBlobWasLeftInPlaceToFailAgainOnEveryLaterLoad');
      if (readyInMs === null && !(where && where.hasPasswordField)) {
        unmet.push('theClientReachedNoDeterminateState');
      }
      // A refusal that names ANOTHER branch's cause is the confusion this row exists to catch, and it
      // is recorded separately from "said nothing" because the two want different fixes.
      const otherCauses = SHAPES.filter((s) => s.key !== shape.key)
        .filter((s) => said.some((t) => t.includes(s.needle)))
        .map((s) => s.key);
      if (otherCauses.length > 0) unmet.push(`theRefusalAlsoNamed:${otherCauses.join('+')}`);

      results.push({
        shape: shape.key,
        what: shape.what,
        unmet,
        readyInMs,
        endedAt: where,
        blobClearedAfterwards: after.blob === null,
        wrapKeySurvived: after.wrap !== null,
        timesTheCauseWasNamed: matching.length,
        // RECORDED WHATEVER THE VERDICT: what the product says about each damage is the observation,
        // and a verdict without it settles nothing next time the wording moves.
        whatItSaid: said.map((t) => t.slice(0, 200)),
        observation: ignoringExpectedLog(await report(obs), [
          BROWSER_PASSWORD_FORM_HINT,
          // THIS ROW'S EVIDENCE IS ALSO A WARNING, and forgiving it here is per-row on purpose: a
          // `[VAULT]` refusal is the thing being asserted three lines above, so counting it as dirt
          // would make every correct run fail. It is forgiven for the GATE and asserted by `unmet`,
          // which is the only arrangement where both statements stay true.
          /^\[VAULT\] /,
        ]),
      });
    }

    const failed = results.filter((r) => r.unmet.length > 0);
    // EVERY SHAPE'S OBSERVATION IS GATED, not just the last. Three boots happen here and each can be
    // dirty on its own; gating one of them would let the other two carry an unexplained line into a
    // clean verdict, which is the failure mode a per-row disposition is supposed to make impossible.
    const gated = gate(
      failed.length > 0 ? 'FAIL' : 'PASS',
      Object.fromEntries(results.map((r) => [`W1-${r.shape}`, r.observation]))
    );
    record('CORRUPT-6', gated.verdict, {
      ...gated.detail,
      unobservable:
        'damages the device-key vault three ways on purpose - every [VAULT] refusal here is this ' +
        "row's evidence, not noise it forgives",
      unmet: failed.flatMap((r) => r.unmet.map((u) => `${r.shape}:${u}`)),
      store: before.store,
      shapes: results.map(({ observation: _drop, ...rest }) => rest),
    });
  }
} finally {
  if (touched) {
    // THE VAULT GOES BACK WHATEVER HAPPENED, including on a throw - a row that leaves W1 unable to
    // restore its own device key has caused a defect rather than measured one.
    await inVault(
      `STORE.setItem(BLOB, ${JSON.stringify(before.blob)}); STORE.setItem(WRAP, ${JSON.stringify(before.wrap)});`
    ).catch(() => {});
    await evaluate(w1, `window.__corrupt6Stamp = 1`).catch(() => {});
    await w1.send('Page.reload', { ignoreCache: false }).catch(() => {});
    await until(w1, `!window.__corrupt6Stamp`, SETTLE_BUDGET_MS).catch(() => null);
    const back = await readVault().catch(() => null);
    // ASSERTED, NOT ASSUMED: only a comparison can say the vault carries what it started with.
    console.log(
      `[corrupt6] vault restored in ${before.store}: blob ${back && back.blob === before.blob ? 'IDENTICAL' : 'NOT THE ONE IT STARTED WITH'}, ` +
        `wrap key ${back && back.wrap === before.wrap ? 'IDENTICAL' : 'NOT THE ONE IT STARTED WITH'}`
    );
  }
  const ready = await bringToReady('W1');
  console.log(
    `[corrupt6] teardown: W1 ${ready.ok ? 'is back at a named starting point' : 'DID NOT RECOVER'}`
  );
}

exitOnRecorded();
