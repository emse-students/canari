#!/usr/bin/env node
/**
 * Enters the encryption PIN in the web unlock modal, over CDP.
 *
 * Kept out of the cdp.mjs CLI for the same reason as login.mjs: the value comes from
 * scratchpad/test-accounts.json, never from argv, so it never lands in a captured shell.
 *
 * Usage: bun pin.mjs --device W2 [--stay] [--value 9999]
 *        bun pin.mjs --android          (the phone - arms the forward itself)
 *   --stay   tick "Rester connecte" (the vault path - PIN-9 depends on this being explicit)
 *   --value  override the PIN, for the wrong-PIN and short-PIN checks (PIN-2, PIN-3)
 */
import { accounts as readAccounts } from './accounts.mjs';
import { activate, connect, evaluate, listTargets, realClick, until } from './cdp.mjs';
import { declineBiometricOffer } from './chat.mjs';
import { estateOriginsAmong } from './estate-origins.mjs';
import { GATE_EXPR } from './gate-probe.mjs';
import { PORTS, SITE } from './names.mjs';
import { armIfPhone, resolveDevice } from './device.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

// ONE RESOLVER FOR EVERY ATOM. This block was a COPY of `login.mjs`'s, written an hour after it -
// the duplication the rig is being cleaned of, happening live. `device.mjs` owns it now, so the two
// commands that answer the same phone cannot drift about which phone that is.
const target = resolveDevice(argv, { defaultPort: PORTS.W2 });
const { port, account } = target;
if (!account) throw new Error(`no account known for port ${port} - pass --device or --account`);

const accounts = readAccounts();
const pin = opt('value', accounts[account]?.pin);
if (!pin) throw new Error(`no PIN for account ${account}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await armIfPhone(target, `pin:${account}`);

const wanted = opt('match', null);
const targets = await listTargets(port);
// `pageTarget`, not `target`: the resolved DEVICE above already owns that name, and two different
// things sharing one is how the wrong one gets read.
const pageTarget = wanted ? targets.find((t) => t.url.includes(wanted) || t.title.includes(wanted)) : targets[0];
if (!pageTarget) throw new Error(`no target matching ${wanted}; have: ${targets.map((t) => t.url).join(' | ')}`);
const cx = connect(pageTarget.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');

const field = '#encryption-pin';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// A GATE THAT HAS NOT MOUNTED YET IS NOT A GATE THAT IS NOT COMING, and this file used to read the
// DOM exactly once. On 2026-08-28 that cost HEAL-NEW-0: `newdevice.mjs` spawned this the moment the
// OIDC callback landed on `/`, the client had not finished routing to `/chat`, and the single read
// answered "no unlock modal on screen" - exit 2, `pinGate: none shown`, no device minted, `FAIL` on
// the primitive eleven rows rest on. The modal was up 400 ms later.
//
// BOTH EXITS ARE PROOFS AND THE CLOCK IS ONLY A BOUND: the gate being present, or the client being
// demonstrably past it - on `/chat` with a rendered sidebar, the same proof `run.mjs`'s READY uses
// and for the same reason (not seeing the gate is not being past it, because a booting client shows
// no gate either). Only a page answering NEITHER within the deadline is a timeout, and it says so
// rather than reporting the absence as a verdict.
const GATE_DEADLINE_MS = 25000;
const GATE_PROBE = `(function () {
  var f = !!document.querySelector('#encryption-pin');
  var k = [].some.call(document.querySelectorAll('button'), function (b) { return b.innerText.trim() === '\\u232b'; });
  var sidebar = document.querySelectorAll('aside button, nav button').length;
  return JSON.stringify({
    field: f,
    keypad: k,
    gate: ${GATE_EXPR},
    path: location.pathname,
    onChat: location.pathname.indexOf('/chat') === 0,
    sidebar: sidebar
  });
})()`;

let seen = JSON.parse(await evaluate(cx, GATE_PROBE));
const waitUntil = Date.now() + GATE_DEADLINE_MS;
while (!seen.gate && !(seen.onChat && seen.sidebar > 0) && Date.now() < waitUntil) {
  await sleepMs(400);
  seen = JSON.parse(await evaluate(cx, GATE_PROBE));
}
let hasField = seen.field;
let hasKeypad = seen.keypad;

// PREFER THE TEXT FIELD, even on mobile. The keypad has no readable buffer: you cannot assert
// what it holds, leftovers from a previous attempt survive, and after a failed try the first tap
// dismisses the error instead of entering a digit - so a blind 4 taps submits a 3-digit PIN and
// the run reports "PIN incorrect" for a PIN that is perfectly correct. "Saisie manuelle" swaps in
// a real input whose value can be set AND read back.
if (!hasField && hasKeypad) {
  const switched = await evaluate(
    cx,
    `(function () {
      var b = [].filter.call(document.querySelectorAll('button'), function (x) { return /Saisie manuelle/i.test(x.innerText); })[0];
      if (!b) return false;
      b.click();
      return true;
    })()`,
  );
  if (switched) {
    await sleepMs(300);
    hasField = await evaluate(cx, `!!document.querySelector('${field}')`);
    if (hasField) {
      hasKeypad = false;
      console.log('[pin] switched keypad -> manual input');
    }
  }
}

/**
 * WHICH ESTATE THE APP IS ACTUALLY TALKING TO, MEASURED ON THE RUNNING CLIENT.
 *
 * A phone client embeds its frontend (`frontendDist: "../build"`), so the origins it calls are BAKED
 * INTO THE APK and no deploy can move them. `a1apk.mjs` asserts them at BUILD time by grepping the
 * packaged chunks - and `--no-build`, which is the flag every session actually uses, skips that
 * branch entirely and installs the artefact anyway. An APK built against production would then run
 * every `+A1` row against the real estate while the ledger recorded the verdict against localhost.
 *
 * IT CANNOT BE ANSWERED FROM THE ARTEFACT. Measured 2026-09-05: the APK carries no plain copy of
 * either origin - Tauri compresses the bundle into `libmines_app_lib.so`, so a grep of the file
 * finds `localhost:8081` zero times and `canari-emse.fr` twice, which is the CSP and not a caller.
 *
 * SO IT IS ASKED OF THE CLIENT, HERE, WHERE THE ANSWER CANNOT BE VACUOUS. This runs on both ways out
 * of the gate - answered, or already past it. An EMPTY resource timeline is a failure rather than a
 * pass ("contacted nothing" is not "contacted the right thing", and a gate over an empty set is the
 * vacuous pass this rig refuses everywhere else) - but it is WAITED for first, up to ten seconds,
 * because a cold-started client that has just answered the gate may legitimately not have reached
 * the API yet. `tauri.localhost` and `ipc.localhost` are the engine's own two schemes, not an
 * estate, and are excused - as is the OPAQUE origin, which is not an origin at all.
 *
 * **AN OPAQUE ORIGIN IS THE STRING `'null'`, AND IT IS NOT A STRANGER.** `new URL(name).origin`
 * answers `'null'` for every `data:` and `blob:` resource - they have no host to be an estate of.
 * This guard compared that string against `SITE`, found it different, and REFUSED, with the loudest
 * message it has: *"THIS CLIENT IS NOT ON THE LOCAL ESTATE: it called null"*, telling the reader to
 * rebuild an APK. Measured on W1, 2026-09-05: the offender is the application's own noise texture,
 * a `data:image/svg+xml` in its CSS that is on EVERY page. It is INTERMITTENT, which is worse - the
 * resource timeline holds 250 entries by default and is cleared by a navigation, so whether the
 * texture is still in it depends on how long the tab has been up and what it has fetched since. A
 * gate that refuses the correct estate some of the time, naming the most alarming cause it knows,
 * costs more than no gate.
 *
 * IT REFUSES AS WELL AS ACCEPTS, which is the half a gate usually lacks. Exercised 2026-09-05 on
 * five origin sets: local only ACCEPTED; production, `dev.`, engine-schemes-only, and local WITH a
 * production stray alongside it - all four REFUSED. The stray case is why the test is "every estate
 * origin is SITE" rather than "SITE is among them".
 *
 * @param {object} cx CDP connection to the client
 * @returns {Promise<void>} exits the process 1 rather than returning, when the estate is wrong
 */
async function assertLocalEstate(cx) {
  // THE PAGE-SIDE READ IS ALL THAT LIVES HERE. What counts as an estate is `estate-origins.mjs`,
  // which imports nothing and is therefore gatable - see `archive/estate-selftest.mjs`.
  const read = async () =>
    estateOriginsAmong(
      JSON.parse(
        await evaluate(
          cx,
          `JSON.stringify([...new Set(performance.getEntriesByType('resource').map(function (e) {
             try { return new URL(e.name).origin; } catch (_) { return 'unparseable:' + e.name; }
           }))])`,
        ),
      ),
    );
  // WAITED FOR, NOT SAMPLED ONCE. A client that has just answered the gate on a COLD START may not
  // have reached the API yet, and the first version of this called that a failure - a vacuity guard
  // firing on a legitimate state, which is its own kind of wrong answer. Ten seconds is the cap this
  // campaign puts on every wait: enough to show it works, and long enough that a client still silent
  // afterwards is not one whose estate can be established.
  let estates = await read();
  for (const deadline = Date.now() + 10_000; !estates.length && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 400));
    estates = await read();
  }
  const strangers = estates.filter((o) => o !== SITE);
  console.log(`[pin] estate origins contacted: ${estates.join(' ') || '(none)'}`);
  if (!strangers.length && estates.length > 0) return;
  console.error(
    estates.length === 0
      ? `[pin] THIS CLIENT CONTACTED NO ESTATE IN TEN SECONDS, so which one it is built against is ` +
          `unknown - and a row that ran now would record a verdict nothing corroborates`
      : `[pin] THIS CLIENT IS NOT ON THE LOCAL ESTATE: it called ${strangers.join(' ')} and the rig ` +
          `reports on ${SITE}. Rebuild and reinstall the APK (bun a1apk.mjs) - a --no-build install ` +
          `keeps whatever origins the artefact on disk was baked with`,
  );
  cx.close();
  process.exit(1);
}

if (!hasField && !hasKeypad) {
  // THREE OUTCOMES, THREE MESSAGES. "No modal" was one line for two situations wanting opposite
  // repairs - a client already unlocked needs nothing, a client that never mounted the gate needs
  // looking at - and a caller recording the same string for both cannot tell them apart afterwards.
  if (seen.onChat && seen.sidebar > 0) {
    console.log('[pin] no gate to answer - the client is already past it');
  } else {
    console.log(
      `[pin] no unlock modal within ${GATE_DEADLINE_MS} ms - on ${seen.path}, sidebar ${seen.sidebar}`,
    );
  }
  // The estate is asserted on THIS way out too. "Already unlocked" is the ordinary path on every
  // run after the first, so skipping it here would mean the check almost never ran.
  await assertLocalEstate(cx);
  process.exit(2);
}

if (hasField) {
  await realClick(cx, field);
  await evaluate(cx, `(function(){var e=document.querySelector('${field}'); e.value=''; e.focus();})()`);
  await cx.send('Input.insertText', { text: pin });
} else {
  // MOBILE SHAPE: no input at all, a numeric KEYPAD of <button>s (and a "Saisie manuelle" escape
  // hatch). `#encryption-pin` simply does not exist there, so a check that keys off it reports
  // "no modal" while the modal is plainly on screen. Tap the digits - that is also the real path.
  console.log('[pin] keypad shape (mobile)');
  // The keypad KEEPS its buffer between attempts: a failed run leaves its digits behind and the
  // next one submits a longer, wrong PIN. Always clear before entering.
  const tap = async (label) => {
    const hit = await evaluate(
      cx,
      `(function () {
        var b = [].filter.call(document.querySelectorAll('button'), function (x) { return x.innerText.trim() === ${JSON.stringify(label)}; })[0];
        if (!b) return null;
        var r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
    if (!hit) throw new Error(`no keypad button ${label}`);
    const point = [{ x: Math.round(hit.x), y: Math.round(hit.y), radiusX: 12, radiusY: 12, force: 1 }];
    await cx.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
    await cx.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // A keypad is a state machine driven by taps; firing them back to back outruns its updates.
    await sleep(90);
  };
  for (let i = 0; i < 12; i++) await tap('⌫');
  for (const digit of String(pin)) await tap(digit);
}


if (has('stay')) {
  const box = await evaluate(
    cx,
    `(function(){var c=document.querySelector('input[type=checkbox]'); if(!c) return null; if(!c.checked) c.click(); return c.checked;})()`,
  );
  console.log(`[pin] stay-signed-in = ${box}`);
}

// The keypad shape has no input to read back, so report what it can: the number of taps.
const len = hasField
  ? await evaluate(cx, `document.querySelector('${field}')?.value.length ?? -1`)
  : String(pin).length;
console.log(`[pin] ${account}: ${len} ${hasField ? 'chars' : 'taps'}${has('value') ? ' (override)' : ''}`);

// THE GATE HAS TWO SHAPES AND ONE FORM, AND THIS USED TO NAME ONLY ONE OF THEM. `PinModal` renders
// a single `<form>` whose submit button says "Deverrouiller" for a returning device and
// "Creer mon PIN" on an account that has never set one - same field, same submit, different LABEL.
// Matching the label therefore threw `no element to activate: text=Deverrouiller` on exactly the
// gesture the campaign's fourth restart step is made of ("set each PIN from test-accounts.json"),
// on a modal plainly on screen. A localized string is not a handle: the button is identified by
// what it IS in the form, which is the same in both shapes and in every locale.
await activate(cx, 'form button[type=submit]');
// The modal either closes (unlocked) or shows an error - poll for whichever comes first.
// "Gone" is the gate predicate NEGATED, never a second reading of it: the keypad shape carries
// no `#encryption-pin`, so a check keyed on the input alone never settles there.
const gone = `!(${GATE_EXPR})`;

// THE REFUSAL IS AN OUTCOME, NOT A TIMEOUT - and this waited for one WORD of one of them.
//
// The old predicate ended on the gate closing or on the body containing "incorrect". The product has
// at least one other refusal and it says something else entirely: *"Votre PIN a ete change sur un
// autre appareil. Recuperez vos messages avec votre ancien PIN."* Measured on A1, 2026-09-04. So the
// atom spent its whole budget and threw `until() timed out` while the application was explaining
// itself in red on the screen - the least useful thing it could have said, about a state it could
// see.
//
// A FRENCH LABEL IS NOT AN API, so the new predicate is the ERROR ELEMENT rather than any wording:
// the modal renders exactly one, and its presence is the fact "the unlock was refused" independently
// of which refusal it was. The text is then REPORTED, never matched on.
const ERROR_IN_GATE = `document.querySelector('[role=dialog] p.text-red-500, form p.text-red-500')`;
const ms = await until(cx, `(${gone}) || !!${ERROR_IN_GATE}`, 25000);
const refusal = await evaluate(cx, `(${ERROR_IN_GATE} || {}).innerText || null`);
console.log(`[pin] settled in ${ms}ms`);
if (refusal) {
  // Exit non-zero: the caller reads the code, and "the PIN was refused" must not read as success.
  // It is NOT exit 2 - that code already means "there was no gate to answer", which is a legitimate
  // outcome on an unlocked client and must stay distinguishable from a refusal.
  console.error(`[pin] REFUSED by the product: ${refusal.replace(/\s+/g, ' ')}`);
  cx.close();
  process.exit(1);
}

const offer = await declineBiometricOffer(cx);
if (offer !== 'none') console.log(`[pin] biometric offer: ${offer}`);

const state = await evaluate(
  cx,
  `JSON.stringify({ url: location.href, modal: ${GATE_EXPR}, body: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300) })`,
);
console.log(`[pin] after: ${state}`);
await assertLocalEstate(cx);

// THE SUCCESS PATH HAS TO END AS DELIBERATELY AS THE FAILURE ONES, and for fourteen days it did not.
// Every refusal above closes the socket and names an exit code; a PIN that WORKED just fell off the
// end of the file with the CDP WebSocket still open, and an open socket keeps the event loop alive
// for ever. `phone.unlockPin()` runs this under `execFileSync(..., { timeout: 120_000 })`, so the
// ordinary outcome was: unlock the app in 2.7 s, sit there for 117 more, get killed, and report
// `pin.mjs failed` - a FALSE failure recorded against a pin that had worked, on every `+A1` row that
// met the gate. DEL-7 carried it as dirt on 2026-09-05 (`pinOnWake: pin.mjs failed`) while the
// screenshot showed the app unlocked and past it.
//
// It hid behind exit 2. A client ALREADY unlocked leaves at line 196 and its caller reads `no modal`
// instantly, which is the state of the phone on every run but the first after a restart - so the
// hang only appeared on the rows that restart the app, which is exactly the population that cannot
// afford two lost minutes.
cx.close();
process.exit(0);
