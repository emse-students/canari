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

// THE MOBILE FORM IS NOT IN THE APP. Tauri hands the OIDC hop to a Chrome Custom Tab, which is a
// different browser and therefore a different devtools endpoint - `phone.mjs` forwards the app's
// WebView on the device port and Chrome's own on the next one up. Everything below used to attach to
// the WebView alone, so a phone whose IdP session had expired sat on a form this script could not
// see, and reported "no credential form" about a form plainly on screen (measured 2026-08-28, A1
// after a factory wipe: CAS's cookie had expired while Authentik's had not).
const TAB_PORT = Number(opt('tabPort', port + 1));

/** The credential form when it is in Chrome rather than in the app, or null. */
const casTab = async () => {
  const seen = await listTargets(TAB_PORT).catch(() => []);
  return seen.find((t) => t.url.includes('cas.emse.fr') || t.url.includes('auth.canari-emse.fr')) ?? null;
};

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
//
// THE PHONE'S APP IS NOT ON canari-emse.fr AT ALL. A Tauri client serves its embedded frontend from
// `tauri.localhost` (`frontendDist: "../build"`), so this answered `false` for every landing A1 has
// ever made and the step could only end on its own timeout.
const onTheApp = (url) =>
  (url.includes('canari-emse.fr') || url.includes('tauri.localhost')) &&
  !url.includes('auth.canari-emse.fr') &&
  !url.includes('cas.emse.fr');
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
// Which client holds the form. `cx` on the web, a Custom Tab target on the phone - and the two are
// filled by the SAME code below, because a second copy is a second place for the focus assertion to
// rot.
let tabTarget = null;
let formCx = cx;

// IDEMPOTENT BY READING BEFORE ACTING. What this script is for is leaving the browser holding an
// authenticated session, so a browser that already holds one needs no gesture at all - and clicking a
// launcher that is not on screen would throw on the very state being asked for. It is also what rule
// 4 of the campaign requires of every step: the same call has to be safe whatever the previous row
// left behind, rather than only from one starting page.
/**
 * Whether this browser ALREADY holds a session - asked of the app, never of the address bar.
 *
 * A URL IS NOT A SESSION, AND READING IT AS ONE COST HEAL-REVOKE-5 A WHOLE RUN ON 2026-08-29. The
 * revoked device had just wiped itself and was still PAINTING /chat in the two seconds before its
 * own redirect to /login landed. This read caught that instant, concluded "the IdP kept its
 * session, nothing to fill", and exited 0 without logging anyone in. The caller was handed
 * `ok: true`, the app booted with no credential at all, and the server said so in one line:
 * `Refresh refused: no canari_refresh cookie`. The row then spent 600 s asking a logged-out page
 * for a sidebar.
 *
 * `canari_saved_user` is what the app itself writes at login and erases at logout, and it is the
 * same key `currentUserId()` reads before it will even attempt a silent refresh. So the question is
 * put to the state the product keeps, not to the page it happens to be rendering - which removes
 * the race rather than waiting it out. It is deliberately CONSERVATIVE: a false negative costs one
 * redundant login, which this script is idempotent about by design, while a false positive costs
 * the caller its entire measurement.
 */
const holdsASession = async () => {
  const url = await here();
  if (!onTheApp(url) || onTheLauncher(url)) return false;
  return (await evaluate(cx, `!!localStorage.getItem('canari_saved_user')`)) === true;
};

/**
 * WHICH OF THE TWO STATES THE APP HAS COMMITTED TO, or null while it is still between them.
 *
 * ACTING ON A PAGE THE APP IS ABOUT TO LEAVE IS THE RACE, and reading the URL harder does not
 * remove it. A freshly wiped client paints /chat for about two seconds before its own redirect to
 * /login lands, and in that window it is neither authenticated nor on the launcher: the first
 * version of this file read the URL and claimed a session it did not have, and the second one
 * clicked a launcher button that was not on screen. Both were the same mistake at different
 * moments.
 *
 * There are exactly two states this script can act on, and each has a POSITIVE proof: the launcher
 * is a route, a live session is a key the app itself wrote. Anything else is a page mid-decision,
 * so it is not an answer and is not treated as one - the wait below ends when the app has decided,
 * never on a clock, and the bound only exists so a page that never decides is REPORTED.
 */
const whatTheAppHasCommittedTo = async () => {
  const url = await here();
  if (onTheLauncher(url)) return 'launcher';
  if (onTheApp(url) && (await holdsASession())) return 'session';
  return null;
};

let committed = null;
for (let i = 0; i < 150 && committed === null; i++) {
  committed = await whatTheAppHasCommittedTo();
  if (committed === null) await sleep(100);
}
if (committed === null) {
  throw new Error(
    `the app committed to neither the launcher nor a session within 15s, at ${await here()}`,
  );
}
let theIdPAnsweredForUs = committed === 'session';
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
    tabTarget = await casTab();
    if (tabTarget) {
      onForm = true;
      break;
    }
    if (await holdsASession()) {
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
if (tabTarget) {
  formCx = connect(tabTarget.webSocketDebuggerUrl);
  await formCx.ready;
  await formCx.send('Runtime.enable');
  // The TARGET appears before its render does, so the fields are waited for on the tab as they are
  // on the app - and a tab that never grows a `#username` is a throw, not a fill against nothing.
  for (let i = 0; i < 100; i++) {
    if (await evaluate(formCx, `!!document.querySelector('#username')`)) break;
    await sleep(100);
    if (i === 99) throw new Error(`the Custom Tab on ${TAB_PORT} never rendered a credential form`);
  }
  console.log(`[login:${account}] form in the Custom Tab on ${TAB_PORT}`);
} else {
  console.log(`[login:${account}] form at ${await here()}`);
}

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
    formCx,
    `(function () {
      var e = document.querySelector('${selector}');
      if (!e) return 'missing';
      e.value = '';
      e.focus();
      return document.activeElement === e ? 'ok' : 'active=' + (document.activeElement && document.activeElement.id);
    })()`,
  );
  if (focused !== 'ok') throw new Error(`cannot focus ${selector}: ${focused}`);
  await formCx.send('Input.insertText', { text: value });
}

const filled = await evaluate(
  formCx,
  `JSON.stringify({ user: document.querySelector('#username').value, pwLen: document.querySelector('#password').value.length })`,
);
console.log(`[login:${account}] fields ${filled}`);

// Activate the button BY ELEMENT, not by coordinates. On the phone the focused field raises the
// IME, the viewport resizes, and a centre computed a moment earlier lands somewhere else - a race
// that costs a silent non-submit. CAS is a third-party server-rendered form, not the system under
// test, so event fidelity buys nothing here; every click INSIDE Canari still goes through
// realClick.
const submitted = await evaluate(
  formCx,
  `(function () {
    var b = document.querySelector('#submitBtn');
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`,
);
console.log(`[login:${account}] submit: ${submitted}`);

// THE APP'S WEBVIEW CAN BE GONE BY NOW, and the socket opened before the hop then answers nothing.
// Android is free to kill the Tauri process while the Custom Tab is in front, and it did - measured
// 2026-08-28 on A1, where polling the pre-hop target reported the same `/login` for sixty seconds
// while the login had in fact moved to Chrome. So the landing is read by RE-RESOLVING the app's
// target on its own port, and only the web path keeps using the connection it already holds.
const landing = async () => {
  if (!tabTarget) return here();
  const seen = await listTargets(port).catch(() => []);
  const app = seen.find((t) => onTheApp(t.url));
  return app ? app.url : '(the app has no target yet)';
};

// CAS -> auth.canari-emse.fr -> back to the app. Poll rather than guess a single delay.
for (let i = 0; i < 300; i++) {
  await sleep(100);
  const url = await landing();
  if (onTheApp(url)) {
    console.log(`[login:${account}] landed ${url} after ${((i + 1) / 10).toFixed(1)}s`);
    break;
  }
  if (i === 299) console.log(`[login:${account}] STILL AT ${url}`);
}

// Read the app through a FRESH connection on the tab path, for the same reason.
let readCx = cx;
if (tabTarget) {
  formCx.close();
  const seen = await listTargets(port).catch(() => []);
  const app = seen.find((t) => onTheApp(t.url));
  if (!app) throw new Error(`the Custom Tab submitted but the app has no target on ${port}`);
  readCx = connect(app.webSocketDebuggerUrl);
  await readCx.ready;
  await readCx.send('Runtime.enable');
}

console.log(`[login:${account}] final ${await evaluate(readCx, 'location.href')}`);
console.log(await evaluate(readCx, 'document.body.innerText.replace(/\\s+/g," ").slice(0,500)'));
readCx.close();
if (readCx !== cx) cx.close();
