#!/usr/bin/env node
/**
 * PIN - the encryption gate, one row per invocation.
 *
 *   bun archive/pinrows.mjs --row 1         the correct PIN, and the store it was protecting
 *   bun archive/pinrows.mjs --row 2         a wrong PIN five times - records PIN-2 AND PIN-7
 *   bun archive/pinrows.mjs --row 3         a PIN too short, in BOTH components that own the rule
 *   bun archive/pinrows.mjs --row 8         the gate with the server unreachable
 *   bun archive/pinrows.mjs --row 11        the gate cannot be walked away from
 *
 * EVERY ROW LEAVES W1 UNLOCKED. The shared teardown at the bottom raises the gate one last time and
 * answers it, on every path including the ones that gave up early - a row's teardown is the next
 * row's inherited state, and a check that gave up is the one most likely to have left the client
 * somewhere it should not be.
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
import {
  APP_TAB,
  activate,
  awaitAppReady,
  client,
  evaluate,
  goto,
  pollFact,
  pressKey,
  reloadAndWait,
  requestsSince,
} from '../chat.mjs';
import { GATE_EXPR } from '../gate-probe.mjs';
import {
  BLOCK_LIST_READ_NARRATION,
  BROWSER_PASSWORD_FORM_HINT,
  dirtOf,
  gate,
  ignoringExpectedLog,
  ignoringOfflineCut,
  MLS_CLIENT_INITIALISING,
  report,
  watch,
} from '../watch.mjs';
import { exitOnRecorded, record } from '../results.mjs';
import { ACCOUNT_OF, PORTS } from '../names.mjs';
import { unlockClient } from './pingate.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const ROWS = {
  1: {
    id: 'PIN-1',
    what: 'the correct PIN, online: the gate closes AND the store it was protecting opens',
  },
  2: {
    id: 'PIN-2',
    also: ['PIN-7'],
    what: 'a wrong PIN N times: refused every time, no lockout a correct PIN cannot clear, and the messaging state untouched',
  },
  3: {
    id: 'PIN-3',
    what: 'a PIN below the minimum is refused by the client, in both components that own the rule, and no request is sent',
  },
  8: {
    id: 'PIN-8',
    what: 'the gate while the server is unreachable: a transport failure must not end the session',
  },
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
 *
 * THE TEXT IS STRIPPED OF ITS ACCENTS BEFORE IT IS MATCHED, and that is not cosmetic: the interface
 * is French, so the two controls this row is looking for read "Se deconnecter" and "PIN oublie ?"
 * WITH accents, and an ASCII needle never touches them. Written unstripped on 2026-09-05, it
 * reported `{signOut: 0, reset: 0, leaves: 0}` on a gate that carried both - a zero that says
 * "nothing found", indistinguishable from a zero that says "nothing there", which is the reading
 * this row's whole verdict turns on.
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
    var t = (c.innerText || '').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
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

/**
 * WHAT THE GATE SAYS WHEN IT REFUSES - the element, never the wording.
 *
 * `PinModal` renders exactly one error paragraph, and its PRESENCE is the fact "the unlock was
 * refused" independently of which refusal it was. The text is reported so a reader can see which
 * one happened; nothing branches on it. `pin.mjs` learnt this the hard way - its old predicate
 * waited for the word "incorrect" and spent its whole budget while the product was explaining a
 * different refusal in red on the screen.
 */
const REFUSAL = `(function () {
  var p = document.querySelector('[role=dialog] p.text-red-500, form p.text-red-500');
  return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null;
})()`;

/**
 * IS THE MESSAGING STATE STILL THERE - counted from the sidebar, which is what the PIN protects.
 *
 * The store is sealed while the gate is up, so this is only readable on an UNLOCKED client, and
 * that is exactly what makes it the right instrument: a count taken before a wrong-PIN storm and
 * again after the correct one answers "did anything get destroyed on the way" with one number.
 *
 * It is a COUNT and never a comparison of contents: this file has no business reading conversation
 * titles, and a number is enough to catch the failure the row is about (a reset that wiped the
 * local state while the user was only mistyping).
 */
const CONVERSATIONS = `document.querySelectorAll('[data-conversation-tile]').length`;

/** Where the app thinks it is - a logout shows up here as `/login`, and nowhere else. */
const WHERE = `location.pathname`;

/**
 * A PIN one character below the minimum, which is the only length worth sending.
 *
 * `MIN_PIN_LENGTH` is 4 and `pinValidation.ts` says why the rule may not differ between creating a
 * PIN and entering one: the device key derives from the exact string typed, so anything a PIN could
 * pass at creation and fail at unlock would lock its owner out of their own messages. Three
 * characters is the boundary; a one-character value would pass a rule that had drifted to "at least
 * two" and this row would never know.
 */
const TOO_SHORT = '123';

/** Every endpoint a PIN flow can touch. The row asserts NONE of them was reached. */
const PIN_ENDPOINTS = /\/api\/mls\/security\/pin-(salt|check|change)/;

/**
 * Fills the change-PIN modal with a NEW pin below the minimum, and submits it.
 *
 * The current-PIN field holds an obvious placeholder: `ChangePinModal.handleSubmit` runs the length
 * check on the NEW value before it calls `onSubmit`, so nothing here ever leaves the client - and
 * this file may not read the account's real PIN in any case, which is `pin.mjs`'s whole reason for
 * existing.
 *
 * SUBMITTED THROUGH THE FORM, never by calling the handler: `requestSubmit` is what the button does,
 * so the row exercises the same path a person does. `input` is dispatched because the fields are
 * `bind:value` - a value written straight onto the element leaves Svelte's state holding the empty
 * string it had, and the modal would refuse for "fill everything in" rather than for the length.
 */
const FILL_SHORT_CHANGE = `(function () {
  var set = function (id, v) {
    var el = document.querySelector(id);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  if (!set('#current-pin', 'placeholder-not-the-real-pin')) return 'no-current';
  if (!set('#new-pin', '${TOO_SHORT}')) return 'no-new';
  if (!set('#confirm-pin', '${TOO_SHORT}')) return 'no-confirm';
  var form = document.querySelector('#new-pin').closest('form');
  if (!form) return 'no-form';
  form.requestSubmit();
  return 'submitted';
})()`;

/**
 * The network, emulated, through ONE call so it cannot be half-applied.
 *
 * The row holds this CDP session open across the whole cut: `pin.mjs` attaches a SECOND session to
 * the same target and never touches the Network domain, so the emulation set here survives its
 * visit. Restoring is not optional and not conditional - a row that threw between the cut and the
 * restore would leave the browser offline for every check that follows it, which is why the callers
 * below put the restore in a `finally`.
 */
const network = (offline) =>
  w1.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });

/**
 * How many conversations this client can see, WAITED for rather than sampled.
 *
 * The list is rendered from a database read that follows the key being unwrapped, so a count taken
 * the instant the gate closes is a count of a render that has not happened. Zero after the wait is
 * returned as zero and is a legitimate answer - the callers decide what it means, and every one of
 * them treats it as unaskable rather than as a failure.
 */
async function conversationCount() {
  await pollFact(async () => ((await evaluate(w1, CONVERSATIONS)) ?? 0) > 0, {
    timeoutMs: 10000,
    everyMs: 400,
  });
  return (await evaluate(w1, CONVERSATIONS)) ?? 0;
}

/**
 * WHAT A ROW THAT ACTUALLY OPENS THE GATE PROVOKES, and nothing else.
 *
 * Two lines, and each is named for a different reason. Chrome's password-form hint is the browser's
 * and appears the moment a gate with a password field is on screen, so every row here meets it.
 * `Initialising MLS...` is the APPLICATION's, and it appears only where a device key has just been
 * unwrapped - which is precisely what PIN-1, PIN-2 and PIN-8 arrange and then assert.
 *
 * PIN-11 takes neither of the second kind: it never gets past the gate before it reports, so a line
 * saying the MLS client was rebuilt would be a finding there. A disposition is per row because the
 * same sentence is expected in one and evidence in another.
 */
const PAST_THE_GATE = [BROWSER_PASSWORD_FORM_HINT, MLS_CLIENT_INITIALISING];

/**
 * THE APPLICATION'S OWN ACCOUNT OF A LOGIN THAT DID NOT GO THROUGH, for the rows that arranged one.
 *
 * `sessionAuth`'s catch narrates an ordinary failed login - a wrong PIN, a server nobody could reach
 * - into the in-app diary, which the observer files as `unexplained` because no classifier rule
 * claims it. Correctly so: outside a row that deliberately caused one, this line is somebody's
 * client refusing to open. It is named at the two call sites that cause it, exactly as
 * `ignoringExpectedLog`'s own docstring requires.
 *
 * IT MATCHES THE ORDINARY SPELLING AND NOT THE ACCUSING ONE. `[INIT] Login failed (code)` is a
 * different sentence for a different class - the server's 5xx, a WASM that would not load, the
 * genuinely unexpected - and no row here has any business forgiving it. One of those appearing
 * would mean the wrong PIN or the network cut cost something it should not have. The two spellings
 * exist because the product now classifies its own failure, which is what `pinrows` found on
 * 2026-09-05 by reading five console errors on a product doing exactly the right thing.
 */
const LOGIN_DID_NOT_COMPLETE = /^\[INIT\] Login did not complete \(\w+\):/;

const observer = await watch(w1, 'W1');

/**
 * PIN-11 - the gate cannot be walked away from, and it offers an exit that destroys nothing.
 *
 * The story of what it found, and of the two instrument errors it cost, is in `backlog.md`.
 */
async function row11() {
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

// ── THE LOOP THE USER DESCRIBED, and it only exists while the gate can be dismissed at all ───────
//
// "elles naviguent de page en page en fermant le modal de PIN (qui s'ouvre a chaque fois)". So the
// question is not whether a navigation removes the gate - it is whether, having closed it, the user
// is put back in front of it on the next page. That is the app's only current mitigation, and it is
// worth knowing whether it holds.
//
// IT IS DRIVEN THROUGH THE APP'S OWN ROUTER, by clicking a real navigation control. The first draft
// used `history.pushState` and a synthetic `popstate`, which is not what a user does and not what
// SvelteKit expects: `pushState` overwrites the history state SvelteKit keeps its own index in, so
// the router is being handed a navigation it did not author. It reported `false` and a fix written
// against that would have been aimed at a product doing nothing wrong.
//
// Unaskable rather than failed when the gate is still up: a modal that cannot be dismissed has no
// loop to measure, which is exactly what this row is asking the product to become.
let reopenedAfterNavigation = null;
let navigatedTo = null;
if (!survivedEscape) {
  navigatedTo = await activate(w1, 'text=Agenda').catch(() => null);
  if (navigatedTo) {
    await awaitAppReady(w1).catch(() => null);
    reopenedAfterNavigation = (await pollFact(() => gateUp(), { timeoutMs: 10000, everyMs: 400 })).ok;
  }
}

const backdropOn = await raiseGate();
const backdrop = backdropOn.up ? await evaluate(w1, CLICK_BACKDROP) : 'gate-not-raised';
const survivedBackdrop = backdropOn.up ? await gateUp() : null;

// THE ONE LINE THIS ROW IS GUARANTEED TO PROVOKE, and it is Chrome's rather than the app's: every
// gesture here raises a form carrying a password field, which is exactly what the hint is about.
// One needle, named here rather than taken from a list - `FRESH_CLIENT_NARRATION` would forgive
// four more sentences this row has no business excusing. Nothing else is touched, and `badHttp`
// cannot be forgiven by this gate at all, which is how the media 404s stayed a finding.
const rep = ignoringExpectedLog(await report(observer), [BROWSER_PASSWORD_FORM_HINT]);
// A gesture whose gate could not be raised measured nothing, so it is UNDECIDED rather than a
// finding - `null` is not `false`, and the verdict must not read one as the other.
const attempted = [survivedEscape, survivedBackdrop];
const unaskable = attempted.some((a) => a === null);
const held = attempted.every((a) => a === true);
const verdict = unaskable ? 'INCONCLUSIVE' : held && exits.signOut > 0 ? 'PASS' : 'FAIL';
const gated = gate(verdict, { W1: rep });

record(row.id, gated.verdict, {
  ...gated.detail,
  scenario: row.what,
  survivedEscape,
  survivedBackdrop,
  backdrop,
  // Not part of the verdict: it measures the MITIGATION, which only exists while the defect does.
  navigatedTo,
  reopenedAfterNavigation,
  // Counted, never named: a label is a translation and printing it would put a display string in
  // the record. What matters is that exactly one non-destructive exit exists.
  exits,
  dirt: dirtOf(rep),
  failedBecause: [
    survivedEscape === false ? 'Escape closed the gate' : null,
    survivedBackdrop === false ? 'a backdrop click closed the gate' : null,
    reopenedAfterNavigation === false
      ? 'and once dismissed it did NOT come back on the next page, so the app has not even the mitigation the user described'
      : null,
    exits.signOut === 0
      ? 'the gate offers no way out that keeps the messaging state - a user who has forgotten their PIN can only reset it or leave'
      : null,
  ].filter(Boolean),
});
}

/**
 * PIN-1 - the correct PIN, online.
 *
 * THE ROW IS NOT "THE MODAL CLOSED". A gate that closes has proved nothing about the thing it was
 * guarding: the PIN unwraps the device key, and the device key is what opens the local MLS store,
 * so the question is whether the CLIENT CAME BACK - conversations on screen, read from a store that
 * was sealed one second earlier.
 *
 * AND A CLIENT WITH NO CONVERSATIONS CANNOT ANSWER IT. That is INCONCLUSIVE and not FAIL: an empty
 * sidebar on an account that has never talked to anybody is a legitimate state, and reading it as a
 * failed unlock would be blaming the product for the estate. It is the only reading this row cannot
 * make, and it says which one it could not make rather than guessing.
 */
async function row1() {
  const raised = await raiseGate();
  if (!raised.up) {
    record(row.id, 'INCONCLUSIVE', {
      scenario: row.what,
      precondition: 'the PIN gate did not come up after the device key vault was emptied',
      forgotten: raised.forgotten,
      raiseTookMs: raised.tookMs,
      ...gate('INCONCLUSIVE', { W1: await report(observer) }).detail,
    });
    return;
  }

  const startedAt = Date.now();
  const unlocked = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  const unlockMs = Date.now() - startedAt;
  await awaitAppReady(w1).catch(() => null);

  const conversations = await conversationCount();
  const stillGated = await gateUp();
  const where = await evaluate(w1, WHERE);

  const rep = ignoringExpectedLog(await report(observer), PAST_THE_GATE);
  const verdict =
    unlocked.verdict !== 'unlocked' || stillGated
      ? 'FAIL'
      : conversations === 0
        ? 'INCONCLUSIVE'
        : 'PASS';
  const gated = gate(verdict, { W1: rep });

  record(row.id, gated.verdict, {
    ...gated.detail,
    scenario: row.what,
    raiseTookMs: raised.tookMs,
    unlockMs,
    unlocked: unlocked.verdict,
    stillGated,
    where,
    conversations,
    dirt: dirtOf(rep),
    why:
      conversations === 0
        ? 'the gate closed, but this client lists no conversation - so whether the STORE opened cannot be read from the sidebar, and the row refuses to call that a pass'
        : undefined,
    failedBecause: [
      unlocked.verdict !== 'unlocked' ? `the client did not come past the gate: ${unlocked.verdict}` : null,
      stillGated ? 'the gate was still up after a correct PIN' : null,
    ].filter(Boolean),
  });
}

/**
 * PIN-2, and PIN-7 out of the same evidence - a wrong PIN, several times over.
 *
 * TWO ROWS FROM ONE STORM, DELIBERATELY, because running the storm twice doubles the only real risk
 * this row carries: if the product DOES lock an account out after N attempts, the second run would
 * meet a client the first one had already locked, and neither row could then say which of them
 * caused what. They ask different questions of the same five refusals:
 *
 *   PIN-2  - the STATE. Is the account still usable with the right PIN afterwards, and is the local
 *            messaging state the same size it was before? A lockout a correct PIN cannot clear, or
 *            a wipe triggered by mistyping, are the two failures.
 *   PIN-7  - the REFUSAL ITSELF. Was the user TOLD, every time, by the product rather than by the
 *            console - and did anything break while it happened? A refusal is an ANSWER: it may
 *            cost a 401, and it may not cost a 500, an exception or a socket.
 *
 * THE WRONG VALUE IS FIXED AND THE ROW CHECKS ITS OWN PREMISE. Nothing here may read the account's
 * real PIN - that is `pin.mjs`'s business and the reason it exists - so this cannot PROVE the value
 * it sends is wrong. What it can do is notice: an attempt that UNLOCKS is reported as exactly that,
 * and the row goes INCONCLUSIVE rather than recording five refusals it did not get.
 */
async function row2() {
  const ATTEMPTS = 5;
  const WRONG = '135790';

  // The count BEFORE, read while the client is still open - the store is sealed once the gate is up.
  await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  await awaitAppReady(w1).catch(() => null);
  const before = await conversationCount();

  const raised = await raiseGate();
  if (!raised.up) {
    record(row.id, 'INCONCLUSIVE', {
      scenario: row.what,
      precondition: 'the PIN gate did not come up after the device key vault was emptied',
      forgotten: raised.forgotten,
      ...gate('INCONCLUSIVE', { W1: await report(observer) }).detail,
    });
    return;
  }

  // ── the storm, one attempt per FRESHLY RAISED gate ─────────────────────────────────────────────
  //
  // THE RELOAD BETWEEN ATTEMPTS IS NOT TIDINESS, IT IS WHAT MAKES THE SECOND ATTEMPT MEAN ANYTHING.
  // `pin.mjs` waits for "the gate closed, or an error element appeared", and after a first refusal
  // that element is ALREADY on screen - so a second attempt against the same modal would return the
  // instant it submitted, and `told: true` would be a reading of the PREVIOUS refusal. Every
  // occurrence of a stale-fact-read-as-a-fresh-one in this rig has cost a wrong verdict; a reload
  // gives each attempt a modal with nothing on it.
  //
  // The first gate is the one already raised above, so only the later attempts pay for a reload.
  const tries = [];
  for (let i = 1; i <= ATTEMPTS; i++) {
    if (i > 1) {
      const again = await raiseGate();
      if (!again.up) break;
    }
    const said = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, {
      match: APP_TAB,
      value: WRONG,
    });
    const refusal = await evaluate(w1, REFUSAL);
    const up = await gateUp();
    tries.push({ n: i, gateStillUp: up, told: refusal !== null, where: await evaluate(w1, WHERE) });
    // A wrong PIN that opened the client is not a refusal to count - stop rather than pile more
    // attempts onto a premise that has already failed.
    if (said.verdict === 'unlocked' || !up) break;
  }

  const accepted = tries.some((t) => !t.gateStillUp);

  // ── and the correct one, which is what says whether anything is locked out ─────────────────────
  const recovery = accepted
    ? null
    : await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  if (recovery) await awaitAppReady(w1).catch(() => null);
  const after = recovery?.verdict === 'unlocked' ? await conversationCount() : null;

  // The five refusals this row asked for, narrated by the application - see the needle's docstring.
  const rep = ignoringExpectedLog(await report(observer), [
    ...PAST_THE_GATE,
    LOGIN_DID_NOT_COMPLETE,
  ]);
  const toldEveryTime = tries.length > 0 && tries.every((t) => t.told);
  const stayedOnTheGate = tries.every((t) => t.where !== '/login');

  // ── PIN-2: the state ───────────────────────────────────────────────────────────────────────────
  const v2 = accepted
    ? 'INCONCLUSIVE'
    : recovery?.verdict === 'unlocked' && after === before
      ? 'PASS'
      : 'FAIL';
  const g2 = gate(v2, { W1: rep });
  record(row.id, g2.verdict, {
    ...g2.detail,
    scenario: row.what,
    attempts: tries.length,
    conversationsBefore: before,
    conversationsAfter: after,
    recovered: recovery?.verdict ?? null,
    dirt: dirtOf(rep),
    why: accepted
      ? 'the value this row sends as WRONG was accepted, so no refusal was measured and the premise failed rather than the product'
      : undefined,
    failedBecause: [
      !accepted && recovery?.verdict !== 'unlocked'
        ? `the correct PIN did not get past the gate after ${tries.length} wrong ones: ${recovery?.verdict}`
        : null,
      after !== null && after !== before
        ? `the messaging state changed size across the storm: ${before} -> ${after}`
        : null,
    ].filter(Boolean),
  });

  // ── PIN-7: the refusal ─────────────────────────────────────────────────────────────────────────
  const v7 = accepted ? 'INCONCLUSIVE' : toldEveryTime && stayedOnTheGate ? 'PASS' : 'FAIL';
  const g7 = gate(v7, { W1: rep });
  record(ROWS[2].also[0], g7.verdict, {
    ...g7.detail,
    scenario: 'a wrong PIN, N times - a clean refusal is the expected result',
    tries,
    dirt: dirtOf(rep),
    // The gate below is what makes this row more than "an error appeared": `report` counts a 500, an
    // unhandled rejection and a dropped socket, and none of them is forgiven here.
    note: 'the verdict also carries `clean`, so a refusal that cost a 5xx, an exception or a socket is a FAIL even though the user was told',
    failedBecause: [
      !toldEveryTime
        ? 'at least one wrong PIN was refused with nothing on screen - the user was left with a gate that simply did not open'
        : null,
      !stayedOnTheGate ? 'a wrong PIN moved the client to /login, which is a logout rather than a refusal' : null,
    ].filter(Boolean),
  });
}

/**
 * PIN-8 - the gate while the server is unreachable.
 *
 * **A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT**, and this is the gate where that rule
 * costs the most: the unlock has to ask the server for the PIN salt and the verifier, so a dead
 * radio produces a rejection that looks exactly like a wrong PIN if nobody classified it. Reading
 * it as an answer would log the user out - of a session that is perfectly valid - and take the
 * device key with it.
 *
 * SO THE ROW MEASURES THE THREE THINGS THAT SEPARATE THE TWO. The gate must still be up; the client
 * must still be on the app rather than on `/login`; and the correct PIN must work once the network
 * comes back, WITHOUT anything else being done to the client - which is the whole difference between
 * a refusal that was survived and one that was acted on.
 *
 * The cut is emulated on this row's own CDP session and restored in a `finally`: a row that threw
 * in between would otherwise hand every later check an offline browser.
 */
async function row8() {
  const raised = await raiseGate();
  if (!raised.up) {
    record(row.id, 'INCONCLUSIVE', {
      scenario: row.what,
      precondition: 'the PIN gate did not come up after the device key vault was emptied',
      forgotten: raised.forgotten,
      ...gate('INCONCLUSIVE', { W1: await report(observer) }).detail,
    });
    return;
  }

  let offlineAttempt = null;
  let refusal = null;
  let gateAfterCut = null;
  let whereAfterCut = null;
  try {
    await w1.send('Network.enable');
    await network(true);
    offlineAttempt = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
    refusal = await evaluate(w1, REFUSAL);
    gateAfterCut = await gateUp();
    whereAfterCut = await evaluate(w1, WHERE);
  } finally {
    await network(false).catch(() => null);
  }

  // ── and back, with nothing else done to the client ─────────────────────────────────────────────
  const recovery = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  if (recovery.verdict === 'unlocked') await awaitAppReady(w1).catch(() => null);
  const conversations = recovery.verdict === 'unlocked' ? await conversationCount() : null;

  // THE CUT ITSELF IS EXPECTED NOISE AND ITS DISPOSITION IS `ignoringOfflineCut`, not a wider one:
  // every request in flight when the radio died reports a transport failure, and those lines are the
  // row working. Nothing about the REFUSAL is forgiven - a 5xx or an exception still breaks `clean`.
  const rep = ignoringOfflineCut(
    ignoringExpectedLog(await report(observer), [...PAST_THE_GATE, LOGIN_DID_NOT_COMPLETE]),
  );
  const survivedTheCut = gateAfterCut === true && whereAfterCut !== '/login';
  // WHAT THE PERSON WAS TOLD IS PART OF THE ANSWER, and it is asserted as a NEGATIVE because that is
  // the only stable thing to assert. The row may not name the product's own sentence - that is a
  // translation, and a check keyed on one breaks the day it is reworded - but the ENGINE's strings
  // are a fixed foreign vocabulary, and finding one on screen means a raw rejection was rendered
  // instead of being classified. Measured 2026-09-05: `refusal: "Failed to fetch"`, in a modal whose
  // every other word is French, on a screen where it reads exactly like "your PIN is wrong".
  //
  // A denylist rather than an allowlist, deliberately, and the campaign's rule about allowlists is
  // about DESTRUCTIVE CONTROLS - what a gesture may touch. This is a DETECTOR: it names the small
  // fixed set of strings the three engines produce, and a fourth one appearing would be a miss, not
  // a mistaken action.
  const ENGINE_STRINGS = ['Failed to fetch', 'NetworkError', 'Load failed', 'network error'];
  const leakedEngineString = refusal !== null && ENGINE_STRINGS.some((s) => refusal.includes(s));
  const verdict =
    offlineAttempt?.verdict === 'unlocked'
      ? 'INCONCLUSIVE'
      : survivedTheCut && recovery.verdict === 'unlocked' && !leakedEngineString
        ? 'PASS'
        : 'FAIL';
  const gated = gate(verdict, { W1: rep });

  record(row.id, gated.verdict, {
    ...gated.detail,
    scenario: row.what,
    offlineAttempt: offlineAttempt?.verdict ?? null,
    // Reported in full so a reader can see WHICH refusal it was; judged only on whether it is one
    // of the engine's own strings, which is a fact about vocabulary and not about wording.
    refusal,
    leakedEngineString,
    gateAfterCut,
    whereAfterCut,
    recovered: recovery.verdict,
    conversations,
    dirt: dirtOf(rep),
    why:
      offlineAttempt?.verdict === 'unlocked'
        ? 'the client came past the gate with the network cut, so the cut did not reach the unlock and the row measured nothing'
        : undefined,
    failedBecause: [
      gateAfterCut === false ? 'the gate came down on a transport failure' : null,
      whereAfterCut === '/login'
        ? 'a transport failure logged the user out - a dead radio was read as an answer'
        : null,
      recovery.verdict !== 'unlocked'
        ? `the correct PIN did not work once the network was back: ${recovery.verdict}`
        : null,
      leakedEngineString
        ? `the person at the gate was shown the browser's own words rather than the product's: ${refusal}`
        : null,
    ].filter(Boolean),
  });
}

/**
 * PIN-3 - a PIN below the minimum, at every flow that can ask for one.
 *
 * THE ROW READS "SETUP, CHANGE, RECOVERY AND UNLOCK" AS TWO COMPONENTS, and that is a measurement
 * rather than a shortcut: `PinModal.handleSubmit` serves setup AND unlock - `isFirstSetup` changes
 * the labels and nothing else - and `ChangePinModal.handleSubmit` serves change AND recovery, whose
 * own comment says why the rule cannot be stricter in either ("in 'recover' the new field is the PIN
 * already chosen on another device"). Two `isValidPin` call sites, four flows, and driving both
 * components is what covers all four. A row that drove only the gate would be measuring half a rule
 * and reporting on a whole one.
 *
 * AND THE ASSERTION IS NOT ONLY "IT SAID NO". A length rule that refuses AFTER a round trip has told
 * the server a PIN attempt happened, which is a rate-limit budget and a log line spent on a string
 * the client could see was too short. So the row also proves the client sent NOTHING - the three
 * endpoints a PIN flow can touch, counted over the window in which the refusal happened.
 */
async function row3() {
  // ── 1. the gate: setup and unlock, one handler ────────────────────────────────────────────────
  const raised = await raiseGate();
  if (!raised.up) {
    record(row.id, 'INCONCLUSIVE', {
      scenario: row.what,
      precondition: 'the PIN gate did not come up after the device key vault was emptied',
      forgotten: raised.forgotten,
      ...gate('INCONCLUSIVE', { W1: await report(observer) }).detail,
    });
    return;
  }

  const beforeGate = w1.events.length;
  await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB, value: TOO_SHORT });
  const gateRefusal = await evaluate(w1, REFUSAL);
  const gateHeld = await gateUp();
  const gateAsked = requestsSince(w1, PIN_ENDPOINTS, beforeGate);

  // ── 2. the change modal: change and recovery, one handler ─────────────────────────────────────
  //
  // The client has to be UNLOCKED to reach settings at all, so the gate is answered first - and with
  // the real PIN, which is the teardown's job anyway. Everything below is client-side: the length
  // check runs before `onSubmit` is called, so the CURRENT pin field can hold anything at all and
  // nothing is ever sent. It is filled with an obvious placeholder rather than the real PIN, which
  // this file may not read.
  //
  // AND THE UNLOCK IS THIS ROW'S POSITIVE CONTROL. "No request was sent" is only evidence if the
  // instrument could have seen one, and a `Network` domain that was never enabled answers `[]` to
  // every question - the vacuous pass this campaign refuses everywhere. A real unlock DOES call
  // `pin-salt` and `pin-check`, so counting them over that window proves the probe can see traffic
  // before the row believes an empty list means silence.
  const beforeControl = w1.events.length;
  const unlocked = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  const controlAsked = requestsSince(w1, PIN_ENDPOINTS, beforeControl);
  let changeRefusal = null;
  let changeStillOpen = null;
  let changeAsked = [];
  let opened = null;
  let filled = null;
  if (unlocked.verdict === 'unlocked') {
    await goto(w1, '/settings');
    await awaitAppReady(w1).catch(() => null);
    opened = (await pollFact(() => evaluate(w1, `!!document.querySelector('[data-change-pin]')`), {
      timeoutMs: 15000,
      everyMs: 400,
    })).ok;
    if (opened) {
      await activate(w1, '[data-change-pin]');
      await pollFact(() => evaluate(w1, `!!document.querySelector('#new-pin')`), { timeoutMs: 10000 });
      const beforeChange = w1.events.length;
      filled = await evaluate(w1, FILL_SHORT_CHANGE);
      changeRefusal = await evaluate(w1, REFUSAL);
      changeStillOpen = await evaluate(w1, `!!document.querySelector('#new-pin')`);
      changeAsked = requestsSince(w1, PIN_ENDPOINTS, beforeChange);
    }
  }

  // THE SETTINGS PAGE IS A VIEW THIS ROW MOUNTS, and it reads the block list on the way in.
  // `[blocks.listBlockedUsers]` is the bare function-entry tag `CLAUDE.md` requires of every
  // exported function - content-free, no payload that could be a finding - and it appears here
  // because PIN-3 is the only PIN row that leaves the app's root. Named at the call site that
  // caused it; the payload-carrying spellings of the same store are forgiven by nothing.
  const rep = ignoringExpectedLog(await report(observer), [
    ...PAST_THE_GATE,
    ...BLOCK_LIST_READ_NARRATION,
  ]);
  const gateRefused = gateHeld === true && gateRefusal !== null && gateAsked.length === 0;
  const changeRefused =
    filled === 'submitted' &&
    changeStillOpen === true &&
    changeRefusal !== null &&
    changeAsked.length === 0;
  const verdict = opened === false || unlocked.verdict !== 'unlocked' || controlAsked.length === 0
    ? 'INCONCLUSIVE'
    : gateRefused && changeRefused
      ? 'PASS'
      : 'FAIL';
  const gated = gate(verdict, { W1: rep });

  record(row.id, gated.verdict, {
    ...gated.detail,
    scenario: row.what,
    // Both refusals are reported and neither is matched on - they are translations. What is judged
    // is that one appeared, that the dialog stayed, and that nothing left the client.
    gateRefusal,
    gateHeld,
    gateAsked,
    // The positive control: a real unlock's own traffic, which is what makes the two empty lists
    // above mean "nothing was sent" rather than "nothing was watched".
    controlAsked,
    filled,
    changeRefusal,
    changeStillOpen,
    changeAsked,
    dirt: dirtOf(rep),
    why:
      unlocked.verdict !== 'unlocked'
        ? 'the client could not be brought past the gate, so the change modal was never reachable'
        : opened === false
          ? 'the settings page never showed the change-PIN control, so half the rule was unmeasured'
          : controlAsked.length === 0
            ? 'a REAL unlock sent no PIN request either, so this row cannot see traffic and its two empty lists mean nothing'
            : undefined,
    failedBecause: [
      gateHeld === false ? 'a PIN below the minimum closed the gate' : null,
      gateRefusal === null ? 'the gate refused a too-short PIN with nothing on screen' : null,
      gateAsked.length ? `the gate asked the server about a PIN it could see was too short: ${gateAsked.join(' ')}` : null,
      changeStillOpen === false ? 'the change modal closed on a new PIN below the minimum' : null,
      changeRefusal === null ? 'the change modal refused a too-short PIN with nothing on screen' : null,
      changeAsked.length ? `the change modal asked the server about a PIN it could see was too short: ${changeAsked.join(' ')}` : null,
      filled !== null && filled !== 'submitted' ? `the change modal could not be filled: ${filled}` : null,
    ].filter(Boolean),
  });
}

const RUNNERS = { 1: row1, 2: row2, 3: row3, 8: row8, 11: row11 };
await RUNNERS[opt('row', '')]();

// ── the teardown, which is the next row's inherited state ────────────────────────────────────────
// RAISE IT ONE LAST TIME BEFORE UNLOCKING, because a row may have left the client with the modal
// DISMISSED - which is not the same as unlocked, and is exactly the state PIN-11 exists to report.
// `pin.mjs` against a dismissed gate spends its whole deadline and reports "no unlock modal", which
// is how the first run of that row left W1 walking the app with no device key.
//
// IT RUNS FOR EVERY ROW AND ON EVERY PATH, including the ones that recorded INCONCLUSIVE: a row's
// teardown is the next row's inherited state, and a check that gave up early is exactly the one
// most likely to have left the client somewhere it should not be.
await raiseGate();
const back = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
console.log(`[pinrows] teardown: W1 ${back.verdict}`);

exitOnRecorded();
