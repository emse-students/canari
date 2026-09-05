#!/usr/bin/env node
/**
 * PIN - the encryption gate, one row per invocation.
 *
 *   bun archive/pinrows.mjs --row 11        the gate cannot be walked away from
 *
 * WHY THE RUNNER IS NOT CALLED `pin.mjs`: that name is taken by the GESTURE at the harness root,
 * which enters a PIN into whatever client it is pointed at. A row and a gesture are different
 * things - the gesture is a step several rows use, the row is a question with a verdict - and the
 * rig has already paid once for a runner and a gesture sharing a vocabulary (`heal-web.mjs`
 * recorded `HEAL-WEB`, an id no row ever named, and its verdicts piled up unreconciled for a week).
 *
 * THE PRECONDITION IS NEVER ASSUMED. Every row here needs the gate ON SCREEN, and no gesture in
 * this rig raises it: the app shows it when the device key vault cannot answer, which is a state
 * the campaign's own clients spend most of their life outside of. So the row RAISES it and then
 * PROVES it is up, and if it cannot it records INCONCLUSIVE naming which precondition failed -
 * never a PASS over a question it could not ask. `A precondition is NOT ambient` is the campaign's
 * rule and this is the phase that tests the precondition itself.
 */
import { APP_TAB, awaitAppReady, client, evaluate, pollFact, pressKey, reloadAndWait } from '../chat.mjs';
import { GATE_EXPR } from '../gate-probe.mjs';
import { dirtOf, gate, report, watch } from '../watch.mjs';
import { exitOnRecorded, record } from '../results.mjs';
import { ACCOUNT_OF, PORTS } from '../names.mjs';
import { unlockClient } from './pingate.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const ROWS = {
  11: {
    id: 'PIN-11',
    what: 'the gate cannot be dismissed, and it offers a way out that destroys nothing',
  },
};
const row = ROWS[opt('row', '')];
if (!row) {
  console.error(`pinrows: --row must be one of ${Object.keys(ROWS).join(', ')}`);
  process.exit(2);
}

const w1 = await client(PORTS.W1, APP_TAB);
const gateUp = () => evaluate(w1, GATE_EXPR);

/**
 * FORGETS THE DEVICE KEY, WHICH IS WHAT RAISES THE GATE - BY AN ALLOWLIST, NEVER A `clear()`.
 *
 * A reload alone does not do it: `deviceKeyVault.ts` keeps the wrap key and the blob in
 * `localStorage` when "stay signed in" is on and in `sessionStorage` otherwise, and W1 has the
 * opt-in - the first run of this row recorded INCONCLUSIVE for exactly that reason.
 *
 * The five keys are NAMED. A destructive control needs an allowlist of what it may touch: clearing
 * the whole of `localStorage` would take the language, the theme and whatever else the app keeps
 * there, and the row would then be measuring a client no user ever has. Both legacy names are
 * included because a client that never went through the Phase-5 migration keeps its key under the
 * old one, and a gate that came up for half the fleet would be worse than one that never did.
 *
 * FULLY REVERSIBLE, AND THE TEARDOWN IS NOT OPTIONAL: the rig holds the PIN, so the client goes back
 * through the gate at the end. A row's teardown is the next row's inherited state.
 */
const FORGET_DEVICE_KEY = `(function () {
  var keys = [
    'canari_device_key_vault_key',
    'canari_device_key_vault',
    'canari_device_key_persist',
    'canari_pin_vault_key',
    'canari_pin_vault'
  ];
  var removed = 0;
  for (var i = 0; i < keys.length; i++) {
    for (var s = 0; s < 2; s++) {
      var store = s === 0 ? localStorage : sessionStorage;
      try {
        if (store.getItem(keys[i]) !== null) { store.removeItem(keys[i]); removed++; }
      } catch (e) { /* a storage the engine refuses is one this row never wrote to */ }
    }
  }
  return removed;
})()`;

/**
 * Is there a control on the gate that leads out WITHOUT destroying anything?
 *
 * Read as a shape rather than by a label, because the label is a translation and the question is
 * about what the control DOES. Three kinds are distinguished and they are not interchangeable:
 *
 *   - `signOut`  - ends the session and KEEPS the messaging state. The non-destructive exit.
 *   - `reset`    - wipes the PIN-protected messaging state, keeping the account. Destructive.
 *   - `leaves`   - a link that navigates away and takes the modal with it, which is not an exit
 *                  from the state, only from the dialog: the next page raises it again.
 *
 * A user who forgot their PIN needs the first.
 */
const EXITS = `(function () {
  var dialog = null;
  var all = document.querySelectorAll('[role=dialog]');
  for (var i = 0; i < all.length; i++) {
    if ((all[i].getAttribute('aria-label') || '').indexOf('PIN de chiffrement') !== -1) dialog = all[i];
  }
  if (!dialog) return null;
  var out = { signOut: 0, reset: 0, leaves: 0 };
  var controls = dialog.querySelectorAll('button, a[href]');
  for (var j = 0; j < controls.length; j++) {
    var c = controls[j];
    var t = (c.innerText || '').trim().toLowerCase();
    if (!t) continue;
    if (t.indexOf('deconnect') !== -1 || t.indexOf('deconnex') !== -1 ||
        t.indexOf('sign out') !== -1 || t.indexOf('log out') !== -1) out.signOut++;
    else if (t.indexOf('reinitialis') !== -1 || t.indexOf('reset') !== -1 ||
             t.indexOf('oublie') !== -1) out.reset++;
    else if (c.tagName === 'A' && c.getAttribute('href')) out.leaves++;
  }
  return out;
})()`;

/**
 * Clicks the BACKDROP - the dialog's container, outside the panel.
 *
 * Never by pixels: a coordinate is a different place on every screen, and the campaign's rule is to
 * resolve by element. The backdrop is the element carrying the handler `Modal.svelte` binds, so the
 * event is dispatched on it directly, which is what a click outside the panel actually reaches.
 */
const CLICK_BACKDROP = `(function () {
  var all = document.querySelectorAll('[role=dialog]');
  for (var i = 0; i < all.length; i++) {
    if ((all[i].getAttribute('aria-label') || '').indexOf('PIN de chiffrement') === -1) continue;
    var backdrop = all[i].parentElement;
    if (!backdrop) return 'no-backdrop';
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked';
  }
  return 'no-dialog';
})()`;

/** Back to the app's root - the gate does not mount on every route (see `gate-probe.mjs`). */
const GO_HOME = `history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate'))`;

/**
 * Empties the vault, reloads, and answers whether the gate came up.
 *
 * EVERY GESTURE IS MEASURED FROM A FRESHLY RAISED GATE, and that is not tidiness. The first version
 * of this row pressed Escape, then clicked the backdrop, then navigated, against ONE gate - so the
 * moment Escape closed it the other two measured an ABSENCE and reported it as their own finding.
 * Three `false`s that were really one. A gesture that follows a successful dismissal tests nothing,
 * and a row that cannot say WHICH gesture opened the door has not answered its question.
 */
async function raiseGate() {
  await evaluate(w1, GO_HOME);
  const forgotten = await evaluate(w1, FORGET_DEVICE_KEY);
  await reloadAndWait(w1);
  await awaitAppReady(w1).catch(() => null);
  // NOT A BARE READ, AND NOT `settle` EITHER - THE ROW ASKS ABOUT THE GATE, SO ITS PROBE MUST TOO.
  //
  // A booting client shows no gate the same way an unlocked one does: `readyState` reaches
  // `complete` while the app is still deciding whether the device key is available, so a probe
  // taken straight after the reload reported "no gate" about a client one second from raising it.
  // `settle` fixes that for every OTHER caller by racing two sightings - the gate, or the chat
  // having mounted - and it is the wrong instrument HERE for the very reason this row exists: a
  // client whose gate was DISMISSED is mounted AND has no device key, so `settle` answers
  // "unlocked" about exactly the state under test. That is what left this row s third gesture
  // unmeasured on its first complete run.
  //
  // `pollFact` waits for the gate ITSELF, bounded, and reports how long it took - so a gate that
  // never comes up is a stated deadline rather than a sample taken too early.
  const seen = await pollFact(() => gateUp(), { timeoutMs: 15000, everyMs: 400 });
  return { forgotten, up: seen.ok, tookMs: seen.elapsedMs };
}

const observer = await watch(w1, 'W1');

// ── the precondition, raised and then proved ────────────────────────────────────────────────────
const first = await raiseGate();
if (!first.up) {
  // NOT A PASS AND NOT A FAILURE OF THE PRODUCT. The question is unaskable in this state, and
  // naming which precondition failed is the only honest verdict.
  record(row.id, 'INCONCLUSIVE', {
    scenario: row.what,
    precondition: 'the PIN gate did not come up after the device key vault was emptied',
    forgotten: first.forgotten,
    raiseTookMs: first.tookMs,
    why: first.forgotten
      ? 'the vault keys were removed and the gate still did not mount - something else answers for the device key on this client'
      : 'this client held none of the five vault keys, so it was never keeping a device key here',
    ...gate('INCONCLUSIVE', { W1: await report(observer) }).detail,
  });
  exitOnRecorded();
}

// ── one gesture per raised gate ─────────────────────────────────────────────────────────────────
const exits = (await evaluate(w1, EXITS)) ?? { signOut: 0, reset: 0, leaves: 0 };

await pressKey(w1, 'Escape');
const survivedEscape = await gateUp();

const backdropOn = await raiseGate();
const backdrop = backdropOn.up ? await evaluate(w1, CLICK_BACKDROP) : 'gate-not-raised';
const survivedBackdrop = backdropOn.up ? await gateUp() : null;

// THE THIRD WAY OUT IS THE ONE THE USER DESCRIBED: not closing the modal but walking past it, page
// after page. Whatever the two gestures above did, the gate must still be there after the app has
// changed route.
const navOn = await raiseGate();
if (navOn.up) {
  await evaluate(
    w1,
    `history.pushState({}, '', '/agenda'); dispatchEvent(new PopStateEvent('popstate'))`
  );
  await awaitAppReady(w1).catch(() => null);
}
const survivedNavigation = navOn.up ? await gateUp() : null;

const rep = await report(observer);
// A gesture whose gate could not be raised measured nothing, so it is UNDECIDED rather than a
// finding - `null` is not `false`, and the verdict must not read one as the other.
const attempted = [survivedEscape, survivedBackdrop, survivedNavigation];
const unaskable = attempted.some((a) => a === null);
const held = attempted.every((a) => a === true);
const verdict = unaskable ? 'INCONCLUSIVE' : held && exits.signOut > 0 ? 'PASS' : 'FAIL';
const gated = gate(verdict, { W1: rep });

record(row.id, gated.verdict, {
  ...gated.detail,
  scenario: row.what,
  survivedEscape,
  survivedBackdrop,
  survivedNavigation,
  backdrop,
  // Counted, never named: a label is a translation and printing it would put a display string in
  // the record. What matters is that exactly one non-destructive exit exists.
  exits,
  dirt: dirtOf(rep),
  failedBecause: [
    survivedEscape === false ? 'Escape closed the gate' : null,
    survivedBackdrop === false ? 'a backdrop click closed the gate' : null,
    survivedNavigation === false ? 'the gate was gone after a navigation to another route' : null,
    exits.signOut === 0
      ? 'the gate offers no way out that keeps the messaging state - a user who has forgotten their PIN can only reset it or leave'
      : null,
  ].filter(Boolean),
});

// ── the teardown, which is the next row's inherited state ────────────────────────────────────────
// RAISE IT ONE LAST TIME BEFORE UNLOCKING, because the row may have left the client with the modal
// DISMISSED - which is not the same as unlocked, and is exactly the state this row exists to
// report. `pin.mjs` against a dismissed gate spends its whole deadline and reports "no unlock
// modal", which is how the first run of this row left W1 walking the app with no device key.
await raiseGate();
const back = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
console.log(`[pinrows] teardown: W1 ${back.verdict}`);

exitOnRecorded();
