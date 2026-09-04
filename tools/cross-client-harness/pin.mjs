#!/usr/bin/env node
/**
 * Enters the encryption PIN in the web unlock modal, over CDP.
 *
 * Kept out of the cdp.mjs CLI for the same reason as login.mjs: the value comes from
 * scratchpad/test-accounts.json, never from argv, so it never lands in a captured shell.
 *
 * Usage: bun pin.mjs --device W2 [--stay] [--value 9999]
 *   --stay   tick "Rester connecte" (the vault path - PIN-9 depends on this being explicit)
 *   --value  override the PIN, for the wrong-PIN and short-PIN checks (PIN-2, PIN-3)
 */
import { accounts as readAccounts } from './accounts.mjs';
import { activate, connect, evaluate, listTargets, realClick, until } from './cdp.mjs';
import { declineBiometricOffer } from './chat.mjs';
import { GATE_EXPR } from './gate-probe.mjs';
import { ACCOUNT_OF, PORTS } from './names.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

// `--device W1` is the form to prefer: it fixes the port AND the account together, from the one
// place that knows which is which. `--port`/`--account` still work for a one-off, but nothing stops
// them disagreeing - and a mismatched pair types the other account's PIN and blames the PIN.
const device = opt('device', null);
if (device && !PORTS[device]) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);
const port = Number(opt('port', device ? PORTS[device] : 9223));
const forPort = Object.keys(PORTS).find((d) => PORTS[d] === port);
const account = opt('account', device ? ACCOUNT_OF[device] : ACCOUNT_OF[forPort]);
if (!account) throw new Error(`no account known for port ${port} - pass --device or --account`);
const accounts = readAccounts();
const pin = opt('value', accounts[account]?.pin);
if (!pin) throw new Error(`no PIN for account ${account}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wanted = opt('match', null);
const targets = await listTargets(port);
const target = wanted ? targets.find((t) => t.url.includes(wanted) || t.title.includes(wanted)) : targets[0];
if (!target) throw new Error(`no target matching ${wanted}; have: ${targets.map((t) => t.url).join(' | ')}`);
const cx = connect(target.webSocketDebuggerUrl);
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
const ms = await until(cx, `(${gone}) || document.body.innerText.indexOf('incorrect') !== -1`, 25000);
console.log(`[pin] settled in ${ms}ms`);

const offer = await declineBiometricOffer(cx);
if (offer !== 'none') console.log(`[pin] biometric offer: ${offer}`);

const state = await evaluate(
  cx,
  `JSON.stringify({ url: location.href, modal: ${GATE_EXPR}, body: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300) })`,
);
console.log(`[pin] after: ${state}`);
cx.close();
