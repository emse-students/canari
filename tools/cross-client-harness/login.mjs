#!/usr/bin/env node
/**
 * Drives the MiConnect (CAS) login for one of the campaign accounts, over CDP.
 *
 * This exists so that a password is NEVER an argv value: it is read from `test-accounts.json`
 * (outside the repository, see `STATE_DIR`) and handed straight to Input.insertText. Nothing it
 * prints contains the secret.
 *
 * Usage: node login.mjs --device W2          (preferred - fixes the port and the account together)
 *        node login.mjs --port 9223 --account <key as spelt in test-accounts.json>
 */
import { accountFor } from './accounts.mjs';
import { connect, evaluate, listTargets, realClick } from './cdp.mjs';
import { ACCOUNT_OF, PORTS } from './names.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

// THE ACCOUNT IS DERIVED FROM THE DEVICE, never defaulted to a spelt key. A spelt key is an identity
// in a public repository, and it is also the wrong answer the moment this is pointed at the other
// browser: the login then fails on credentials that are perfectly correct for someone else.
const device = opt('device', null);
if (device && !PORTS[device]) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);
const port = Number(opt('port', device ? PORTS[device] : 9223));
const forPort = Object.keys(PORTS).find((d) => PORTS[d] === port);
const account = opt('account', device ? ACCOUNT_OF[device] : ACCOUNT_OF[forPort]);
if (!account) throw new Error(`no account known for port ${port} - pass --device or --account`);

const creds = accountFor(account);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wanted = opt('match', null);
const targets = await listTargets(port);
const target = wanted ? targets.find((t) => t.url.includes(wanted) || t.title.includes(wanted)) : targets[0];
if (!target) throw new Error(`no target matching ${wanted}; have: ${targets.map((t) => t.url).join(' | ')}`);
const cx = connect(target.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');

const here = () => evaluate(cx, 'location.href');

// THE ONE PREDICATE FOR "the browser is back on the app". It has two readers - the classification of
// a missing form below, and the poll that ends after a submit - and they must never drift, because a
// disagreement between them would read as a login that half worked.
const onTheApp = (url) =>
  url.includes('canari-emse.fr') && !url.includes('auth.canari-emse.fr') && !url.includes('cas.emse.fr');
console.log(`[login:${account}] start ${await here()}`);

// The Canari login page is only a launcher. The hop is canari -> auth.canari (Authentik flow)
// -> cas.emse.fr, and the middle page is a real render, so poll for the FIELD rather than for a
// URL: waiting on "cas.emse.fr" alone lands on the Authentik step and reads as a failure.
//
// THE CLICK IS JUDGED BY ITS EFFECT, NOT BY BEING DELIVERED. A launcher that has painted but not yet
// hydrated takes the click and does nothing with it - `realClick`'s own recorder confirms the BUTTON
// received the event, so no layer anywhere reports a problem - and the step then spends its whole
// budget waiting for a form whose navigation was never started. That is exactly what happened on
// 2026-08-28: this read "no credential form after 30s" while the same click made by hand two minutes
// later reached /chat in two seconds. A dropped click is not cured by waiting longer for it, so the
// loop RETRIES rather than extends, and it ends on a fact instead of on a timeout.
//
// TWO FACTS END IT, because there are two legitimate outcomes and the step cannot know which it will
// get. The CAS form appears, or the browser leaves the launcher on its own because the IdP still holds
// a session for this browser - the SSO cookies live on auth.canari-emse.fr and cas.emse.fr, and
// wiping the app's origin does not touch them, which is why a device wiped to factory re-enrols with
// no field to fill and why the HEAL rows cost no 2FA.
const onTheLauncher = (url) => url.includes('/login');
let onForm = false;

// IDEMPOTENT BY READING BEFORE ACTING. What this script is for is leaving the browser holding an
// authenticated session, so a browser that already holds one needs no gesture at all - and clicking a
// launcher that is not on screen would throw on the very state being asked for. It is also what rule
// 4 of the campaign requires of every step: the same call has to be safe whatever the previous row
// left behind, rather than only from one starting page.
let theIdPAnsweredForUs = await (async () => {
  const url = await here();
  return onTheApp(url) && !onTheLauncher(url);
})();
if (theIdPAnsweredForUs) console.log(`[login:${account}] already on the app, no launcher to click`);
for (let attempt = 1; attempt <= 3 && !onForm && !theIdPAnsweredForUs; attempt++) {
  if (!(await evaluate(cx, `!!document.querySelector('#username')`))) {
    await realClick(cx, 'text=Se connecter');
  }
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evaluate(cx, `!!document.querySelector('#username')`)) {
      onForm = true;
      break;
    }
    const url = await here();
    if (onTheApp(url) && !onTheLauncher(url)) {
      theIdPAnsweredForUs = true;
      break;
    }
  }
  if (!onForm && !theIdPAnsweredForUs) {
    console.log(`[login:${account}] attempt ${attempt} produced nothing, at ${await here()}`);
  }
}

// CLASSIFIED HERE, AT THE THROW, because downstream the two outcomes are the same sentence - "no
// #username" - and a caller reading that as a failure records a rig fault where the product behaved.
// It cost exactly that on 2026-08-28: HEAL-NEW-0 and all four HEAL-REVOKE rows died on `login: false`
// while their own console showed the device enrolled and the census carrying its new id.
//
// IT DOES NOT CLAIM WHOSE SESSION IT IS, deliberately. This script cannot map a spelt account key to
// a uuid, and inventing the mapping is how a confident wrong answer gets made. It PRINTS the landing
// instead, so the caller that cares proves the identity with what it already holds - `newdevice.mjs`
// compares the account before the wipe with the account after it, which no session cookie can fake.
if (!onForm) {
  const url = await here();
  if (!theIdPAnsweredForUs) {
    throw new Error(`no credential form, and still on the launcher after 3 attempt(s), at ${url}`);
  }
  console.log(`[login:${account}] already authenticated - the IdP kept its session, nothing to fill`);
  console.log(`[login:${account}] final ${url}`);
  cx.close();
  process.exit(0);
}
console.log(`[login:${account}] form at ${await here()}`);

// Focused BY ELEMENT, never by a synthetic click - the same reasoning the submit below already
// carried, and it applies to the fields for the same reason. On the phone's narrow CAS layout a
// click resolved to the "mot de passe oublié" link sitting beside the password field and navigated
// away mid-fill, which surfaced as a null `#username` on the read below rather than as a wrong
// click. `Input.insertText` targets whatever holds focus, so focus is the only thing that must be
// right, and it is now asserted instead of assumed.
for (const [selector, value] of [
  ['#username', creds.username],
  ['#password', creds.password],
]) {
  const focused = await evaluate(
    cx,
    `(function () {
      var e = document.querySelector('${selector}');
      if (!e) return 'missing';
      e.value = '';
      e.focus();
      return document.activeElement === e ? 'ok' : 'active=' + (document.activeElement && document.activeElement.id);
    })()`,
  );
  if (focused !== 'ok') throw new Error(`cannot focus ${selector}: ${focused}`);
  await cx.send('Input.insertText', { text: value });
}

const filled = await evaluate(
  cx,
  `JSON.stringify({ user: document.querySelector('#username').value, pwLen: document.querySelector('#password').value.length })`,
);
console.log(`[login:${account}] fields ${filled}`);

// Activate the button BY ELEMENT, not by coordinates. On the phone the focused field raises the
// IME, the viewport resizes, and a centre computed a moment earlier lands somewhere else - a race
// that costs a silent non-submit. CAS is a third-party server-rendered form, not the system under
// test, so event fidelity buys nothing here; every click INSIDE Canari still goes through
// realClick.
const submitted = await evaluate(
  cx,
  `(function () {
    var b = document.querySelector('#submitBtn');
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`,
);
console.log(`[login:${account}] submit: ${submitted}`);

// CAS -> auth.canari-emse.fr -> back to the app. Poll rather than guess a single delay.
for (let i = 0; i < 300; i++) {
  await sleep(100);
  const url = await here();
  if (onTheApp(url)) {
    console.log(`[login:${account}] landed ${url} after ${i + 1}s`);
    break;
  }
  if (i === 299) console.log(`[login:${account}] STILL AT ${url}`);
}

console.log(`[login:${account}] final ${await here()}`);
console.log(await evaluate(cx, 'document.body.innerText.replace(/\\s+/g," ").slice(0,500)'));
cx.close();
