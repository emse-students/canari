#!/usr/bin/env node
/**
 * Drives the login for one of the campaign accounts, over CDP.
 *
 * This exists so that a password is NEVER an argv value: it is read from `test-accounts.json`
 * (outside the repository, see `STATE_DIR`) and handed straight to Input.insertText. Nothing it
 * prints contains the secret.
 *
 * TWO IDENTITY PATHS, AND THE DEFAULT IS THE CAMPAIGN'S. `--flow service-account` (the default)
 * takes the "Connexion externe (service-account)" link and answers Authentik's own two-stage flow;
 * `--flow cas` takes the main button and answers the school's CAS form, which ends at a 2FA no tool
 * here can pass. See `LAUNCHER_BUTTON` below for why that is the default rather than an option.
 *
 * Usage: bun login.mjs --device W2          (preferred - fixes the port and the account together)
 *        bun login.mjs --port 9223 --account <key as spelt in test-accounts.json>
 *        bun login.mjs --device W1 --flow cas
 */
import { accountFor } from './accounts.mjs';
import { connect, evaluate, listTargets, realClick } from './cdp.mjs';
import { forwardIdpBrowser } from './phone.mjs';
import { armIfPhone, resolveDevice } from './device.mjs';
import { PORTS, SITE } from './names.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

// ONE RESOLVER FOR EVERY ATOM - `device.mjs`. This is where `--android`, the port, the account and
// the phone-arming ladder used to be spelt out, and `pin.mjs` then grew a COPY of them an hour
// later. Two commands answering the same phone must not carry two ideas of which phone that is.
//
// THE ACCOUNT IS DERIVED FROM THE DEVICE, never defaulted to a spelt key: a spelt key is an identity
// in a public repository, and the wrong answer the moment this is pointed at the other browser.
const target = resolveDevice(argv, { defaultPort: PORTS.W2 });
const { device, port, account, isPhone } = target;
if (!account) throw new Error(`no account known for port ${port} - pass --device or --account`);

const creds = accountFor(account);

await armIfPhone(target, `login:${account}`);

// THE MOBILE FORM IS NOT IN THE APP. Tauri hands the OIDC hop to a Chrome Custom Tab, which is a
// different browser and therefore a different devtools endpoint - `phone.mjs` forwards the app's
// WebView on the device port and Chrome's own on the next one up. Everything below used to attach to
// the WebView alone, so a phone whose IdP session had expired sat on a form this script could not
// see, and reported "no credential form" about a form plainly on screen (measured 2026-08-28, A1
// after a factory wipe: CAS's cookie had expired while Authentik's had not).
//
// "THE NEXT PORT UP" IS A1'S CONVENTION AND NOBODY ELSE'S, and applying it to a browser is a
// COLLISION rather than a wasted lookup: W2 is 9223, so its "Custom Tab port" was 9224, which is
// W1. Measured 2026-09-04 - logging W2 in while W1 happened to be sitting on the IdP found W1's page
// through this, drove the form in the wrong browser, and then failed on a tab that had never been
// asked for anything. So the phone's port arithmetic is done only for the phone; a browser has no
// Custom Tab, and `null` says so instead of pointing at a neighbour.
const TAB_PORT = opt('tabPort', null) ? Number(opt('tabPort', null)) : isPhone ? port + 1 : null;

/**
 * The credential form when it is in the phone's BROWSER rather than in the app, or null.
 *
 * IT FORWARDS THE PORT BEFORE LOOKING, WHICH IS THE HALF THAT WAS MISSING. `TAB_PORT` was computed
 * and then listed, and nothing had ever created the forward - so this answered `null` for every
 * phone login ever attempted. The visible symptom was the phone sitting on "Redirection..." while
 * the script clicked the launcher and then timed out on `Input.dispatchTouchEvent` against a WebView
 * that had already handed the page away; nothing was typed into the IdP form at any point. Measured
 * 2026-09-04, and noticed by a person watching the screen rather than by any assertion here.
 *
 * The browser is DISCOVERED, never named: this device is LineageOS and the hop lands in
 * `org.lineageos.jelly`, so a forward written for Chrome would have found nothing even once the
 * missing call was added. See `forwardIdpBrowser`.
 *
 * The forward is re-made on every call rather than once: the abstract socket carries the browser's
 * pid, and a Custom Tab that is dismissed and re-opened is a different process.
 */
const atAnIdP = (url) => url.includes('auth.canari-emse.fr') || url.includes('cas.emse.fr');

/**
 * The IdP page on port `p` THAT IS ACTUALLY ON SCREEN, or null - and the choice is MEASURED.
 *
 * POSITION IS NOT A PREDICATE, AND USING IT AS ONE TYPED A PASSWORD INTO A DEAD TAB. This took the
 * LAST match on the theory that it was the newest; `/json/list` promises no such order, and the
 * phone's browser is `org.lineageos.jelly`, which KEEPS EVERY TAB IT HAS EVER OPENED - eight of
 * them on 2026-09-04, two still showing Authentik's "Redirect URI Error" from before the provider
 * was fixed. So the credential went into a tab nobody was looking at, repeatedly, while the live
 * form sat untouched and the script reported a form it had filled.
 *
 * `document.visibilityState` is the question actually being asked - WHICH ONE IS THE USER LOOKING AT
 * - put to each candidate rather than inferred from its rank. A tab that will not answer is not the
 * one being shown, so a dead endpoint disqualifies itself instead of throwing.
 *
 * IT IS A TIE-BREAK, NOT A REQUIREMENT, and that asymmetry is deliberate. With a single candidate
 * there is nothing to choose between and the measurement is skipped - which keeps the WEB path
 * exactly as it was, where the form is the profile's only tab and a merely occluded window would
 * otherwise read as "no form at all".
 */
const idpTargetOn = async (p) => {
  const seen = await listTargets(p).catch(() => []);
  const idp = seen.filter((t) => atAnIdP(t.url));
  if (idp.length <= 1) return idp[0] ?? null;
  for (const t of idp) {
    const c = connect(t.webSocketDebuggerUrl);
    try {
      await c.ready;
      await c.send('Runtime.enable');
      if ((await evaluate(c, 'document.visibilityState')) === 'visible') return t;
    } catch {
      /* a tab that cannot answer is not the one on screen - and `connect` is bounded, so this ends */
    } finally {
      c.close();
    }
  }
  console.log(`[login:${account}] ${idp.length} IdP tab(s) on ${p} and NONE is on screen`);
  return null;
};

const casTab = async () => {
  if (TAB_PORT === null) return null;
  if (isPhone) {
    const fwd = forwardIdpBrowser(TAB_PORT);
    if (!fwd.ok) return null;
  }
  return idpTargetOn(TAB_PORT);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wanted = opt('match', null);

/**
 * The APP's page, connected ON FIRST USE rather than at startup - and that laziness is the fix.
 *
 * ANDROID FREEZES THE APP WHILE THE IdP FORM IS IN FRONT, and this script used to begin by talking
 * to it. Once the hop leaves for the browser the Tauri process is backgrounded and then frozen, so
 * its devtools socket is still LISTED and still ACCEPTS a connection while answering nothing: the
 * first line of work blocked on a phone whose login was one password away from finishing. Reading
 * the app is not what this atom is for - it is for answering a form - and the form lives in a
 * DIFFERENT process, which asks the app for nothing at all.
 *
 * So the order is now: find the visible IdP tab, fill it, submit it, and only THEN look at the app -
 * by which time the deep link has woken it. Nothing before the submit touches the WebView unless
 * there is no form to answer, which is the web path and the first-run path, where the app is
 * necessarily awake because it is what is on screen.
 */
let cx = null;
const appCx = async () => {
  if (cx) return cx;
  const targets = await listTargets(port);
  const target = wanted
    ? targets.find((t) => t.url.includes(wanted) || t.title.includes(wanted))
    : targets[0];
  if (!target) throw new Error(`no target matching ${wanted}; have: ${targets.map((t) => t.url).join(' | ')}`);
  cx = connect(target.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  return cx;
};

const here = async () => evaluate(await appCx(), 'location.href');

// THE ONE PREDICATE FOR "the browser is back on the app". It has two readers - the classification of
// a missing form below, and the poll that ends after a submit - and they must never drift, because a
// disagreement between them would read as a login that half worked.
//
// THE PHONE'S APP IS NOT ON canari-emse.fr AT ALL. A Tauri client serves its embedded frontend from
// `tauri.localhost` (`frontendDist: "../build"`), so this answered `false` for every landing A1 has
// ever made and the step could only end on its own timeout.
//
// AND IT IS DERIVED FROM `SITE`, NOT SPELT. Spelling `canari-emse.fr` here made this predicate FALSE
// for every landing on the local estate, which is where the campaign has run since 2026-09-03: the
// browser came back to `http://localhost:1420/chat` and this said "not on the app", so the poll
// below spent its whole 30 s budget and every caller was handed a login that had in fact succeeded.
// It is the anchored comparison the resume page measured as ZERO - it was written after that count.
const APP_ORIGIN = new URL(SITE).origin;
const onTheApp = (url) =>
  (url.startsWith(APP_ORIGIN) || url.includes('tauri.localhost')) &&
  !url.includes('auth.canari-emse.fr') &&
  !url.includes('cas.emse.fr');
console.log(`[login:${account}] start ${await here()}`);

/**
 * WHICH LAUNCHER BUTTON, and why the campaign's default is not the main one.
 *
 * The main button federates to the school: canari -> auth.canari-emse.fr -> cas.emse.fr, and CAS
 * asks for the EMSE 2FA, which no tool here can answer. The campaign's two accounts are ordinary
 * Authentik users instead, and they sign in through the "Connexion externe (service-account)" link
 * the login page already carries - `PASSWORD_LOGIN_FLOW_SLUG` in `frontend/src/lib/stores/auth.ts`,
 * a flow with identification + password and NO `AuthenticatorValidateStage`. That is the whole
 * reason losing a Chrome profile costs no 2FA, so it is the DEFAULT here rather than an option
 * somebody has to remember; `--flow cas` is for driving a real school account by hand.
 */
const FLOW = opt('flow', 'service-account');
const LAUNCHER_BUTTON =
  FLOW === 'cas' ? 'text=Se connecter' : 'text=Connexion externe (service-account)';

/**
 * Resolves a selector THROUGH SHADOW ROOTS, because one of the two forms lives inside one.
 *
 * Authentik's flow executor renders its stages in web components, so `document.querySelector` sees
 * none of its fields: the identification stage's `input[name=uidField]` and the password stage's
 * `input[type=password]` are both several shadow roots down. A probe that cannot see them reports
 * "no credential form" about a form filling the screen - the same failure shape the CAS half of
 * this file was written to stop. Plain DOM lookups still work: the walk starts at `document`.
 *
 * IT PREFERS A VISIBLE MATCH, and that is not cosmetic. Authentik ships a hidden autofill trio -
 * `username`, `password`, `code` - on every stage, so `input[type=password]` matches an invisible
 * field while the identification stage is still on screen. Typing into it succeeds silently and
 * submits nothing, which is a filled form that never logs anybody in.
 */
const DEEP = `(function (sel) {
  var hits = [];
  (function walk(root) {
    Array.prototype.push.apply(hits, root.querySelectorAll(sel));
    root.querySelectorAll('*').forEach(function (n) { if (n.shadowRoot) walk(n.shadowRoot); });
  })(document);
  var shown = hits.filter(function (e) {
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return shown[0] || null;
})`;

/**
 * THE TWO CREDENTIAL FORMS, each named by what it actually renders.
 *
 * `cas` is the school's server-rendered page (`#username`, `#password`, `#submitBtn`, top level).
 * `authentik` is the service-account flow, which is TWO stages one after the other on the same URL:
 * the identifier first, then the password, each its own render. So the fill loop below is a loop -
 * it answers whichever stage is on screen and looks again - rather than a fixed pair of fields.
 */
const FORM_SHAPE = `(function () {
  var q = ${DEEP};
  if (document.querySelector('#username')) return 'cas';
  if (q('input[name=uidField]')) return 'authentik-uid';
  if (q('input[type=password]')) return 'authentik-password';
  return null;
})()`;

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
let formCx = null;

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
  return (await evaluate(await appCx(), `!!localStorage.getItem('canari_saved_user')`)) === true;
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
 * There are THREE states this script can act on, and each has a POSITIVE proof: the launcher is a
 * route, a live session is a key the app itself wrote, and an IdP page is an IdP host. Anything
 * else is a page mid-decision, so it is not an answer and is not treated as one - the wait below
 * ends when the app has decided, never on a clock, and the bound only exists so a page that never
 * decides is REPORTED.
 *
 * THE THIRD ONE IS THE INTERRUPTED FLOW, and it used to be a throw. A run killed between the two
 * Authentik stages, or a browser relaunched while the IdP still had the form up, leaves the profile
 * sitting on `auth.canari-emse.fr` - neither the launcher nor a session - and this reported "the app
 * committed to neither within 15s" about a credential form on screen, for a client one password away
 * from being logged in. There is no launcher to click from there and no session to keep: the form is
 * already the state, so it is named rather than refused.
 */
const whatTheAppHasCommittedTo = async () => {
  const url = await here();
  if (onTheLauncher(url)) return 'launcher';
  if (atAnIdP(url)) return 'idp';
  if (onTheApp(url) && (await holdsASession())) return 'session';
  return null;
};

// THE FORM IS LOOKED FOR FIRST, AND THIS ORDER IS THE WHOLE POINT OF THE MOVE.
//
// Everything below asks the APP a question, and on the phone the app is frozen precisely when there
// is a form to answer - so the cheapest, safest question comes first, and it is put to the BROWSER:
// is a credential form on screen right now? A `yes` means the flow is already mid-hop, there is no
// launcher to click and nothing to learn from a WebView Android has suspended.
//
// It used to sit AFTER the commitment wait, which is why `--device A1` hung on its first line: the
// app was asked to describe itself while frozen behind the very form this script exists to fill.
tabTarget = await casTab();
if (tabTarget) {
  onForm = true;
  console.log(`[login:${account}] the IdP is already open in the phone's browser - the app is not touched`);
}

let committed = null;
for (let i = 0; i < 150 && committed === null && !onForm; i++) {
  committed = await whatTheAppHasCommittedTo();
  if (committed === null) await sleep(100);
}
// A SPENT `/auth/callback` IS A PAGE THAT NEVER DECIDES, and it is the one this rig parks on. An
// authorization code is single-use, so a browser relaunched - or a run interrupted - on the callback
// URL replays a code the IdP has already burnt: the app cannot exchange it, cannot claim a session,
// and is not on the launcher either, so the wait above spends its whole budget and throws about a
// client that only needed sending back to the launcher. Measured 2026-09-04, three times in a row.
// The recovery is a NAVIGATION rather than a wider predicate, because there is nothing on that page
// to wait for; and it is attempted ONCE, so a launcher that genuinely never renders still throws.
if (!onForm && committed === null && String(await here()).includes('/auth/callback')) {
  console.log(`[login:${account}] parked on a spent /auth/callback - back to the launcher`);
  await evaluate(await appCx(), `location.href=${JSON.stringify(`${SITE}/login`)}`).catch(() => {});
  for (let i = 0; i < 150 && committed === null; i++) {
    committed = await whatTheAppHasCommittedTo();
    if (committed === null) await sleep(100);
  }
}
if (!onForm && committed === null) {
  throw new Error(
    `the app committed to neither the launcher nor a session within 15s, at ${await here()}`,
  );
}
let theIdPAnsweredForUs = committed === 'session';
if (theIdPAnsweredForUs) console.log(`[login:${account}] already on the app, no launcher to click`);

// THE FORM MAY ALREADY BE OPEN SOMEWHERE ELSE, AND ON THE PHONE THAT IS THE NORMAL CASE.
//
// On the web the launcher navigates the same tab, so being on `/login` means the form is not up
// yet. On the phone it hands the hop to an EXTERNAL browser, and the app's own page stays on
// `/login` for ever afterwards, showing "Redirection...". So `committed === 'launcher'` says
// nothing about whether the IdP is already waiting - and clicking again is not merely redundant:
// the WebView that has handed its page away stops answering `Input.dispatchTouchEvent`, so the
// click TIMES OUT and the script dies without ever having typed a character. Measured 2026-09-04,
// on a phone that had four live Authentik tabs open at the time.
//
// Reading before acting is what the rest of this file already does for the session; this is the
// same rule applied to the form.
for (let attempt = 1; attempt <= 3 && !onForm && !theIdPAnsweredForUs; attempt++) {
  // THE CLICK IS GATED ON BEING ON THE LAUNCHER, because that is the only page carrying the button.
  // Reached mid-flow (`committed === 'idp'`) there is nothing to click, and asking `realClick` for a
  // button that is not there is a throw - which would turn a recoverable interrupted login into a
  // rig fault.
  if (!(await evaluate(await appCx(), FORM_SHAPE)) && onTheLauncher(await here())) {
    await realClick(await appCx(), LAUNCHER_BUTTON);
  }
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evaluate(await appCx(), FORM_SHAPE)) {
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
  cx?.close();
  process.exit(0);
}
if (tabTarget) {
  formCx = connect(tabTarget.webSocketDebuggerUrl);
  await formCx.ready;
  await formCx.send('Runtime.enable');
  // The TARGET appears before its render does, so the fields are waited for on the tab as they are
  // on the app - and a tab that never grows a `#username` is a throw, not a fill against nothing.
  for (let i = 0; i < 100; i++) {
    if (await evaluate(formCx, FORM_SHAPE)) break;
    await sleep(100);
    if (i === 99) throw new Error(`the Custom Tab on ${TAB_PORT} never rendered a credential form`);
  }
  console.log(`[login:${account}] form in the Custom Tab on ${TAB_PORT}`);
} else {
  console.log(`[login:${account}] form at ${await here()}`);
}

/**
 * What each shape wants typed into it, and what submits it.
 *
 * CAS puts both credentials on one page; the service-account flow asks for them in two successive
 * renders. Expressing them as one table rather than two code paths is what keeps the fill loop
 * below a loop over STAGES instead of a branch that has to know which IdP it is talking to.
 */
const STAGE = {
  cas: { fields: [['#username', creds.username], ['#password', creds.password]], submit: '#submitBtn' },
  'authentik-uid': { fields: [['input[name=uidField]', creds.username]], submit: 'button[type=submit]' },
  'authentik-password': { fields: [['input[type=password]', creds.password]], submit: 'button[type=submit]' },
};

// Focused BY ELEMENT, never by a synthetic click - the same reasoning the submit below already
// carried, and it applies to the fields for the same reason. On the phone's narrow CAS layout a
// click resolved to the "mot de passe oublié" link sitting beside the password field and navigated
// away mid-fill, which surfaced as a null `#username` on the read below rather than as a wrong
// click. `Input.insertText` targets whatever holds focus, so focus is the only thing that must be
// right, and it is now asserted instead of assumed.
//
// THE ASSERTION IS MADE ON THE FIELD'S OWN ROOT. `document.activeElement` is the shadow HOST for
// anything inside a web component, so comparing against it would fail on every Authentik stage
// while the focus was perfectly correct. `getRootNode().activeElement` is the same question asked
// where the answer lives.
const answerOneStage = async (shape, formCx) => {
  for (const [selector, value] of STAGE[shape].fields) {
    const focused = await evaluate(
      formCx,
      `(function () {
        var e = ${DEEP}(${JSON.stringify(selector)});
        if (!e) return 'missing';
        e.value = '';
        e.focus();
        return e.getRootNode().activeElement === e ? 'ok' : 'not-focused';
      })()`,
    );
    if (focused !== 'ok') throw new Error(`cannot focus ${selector} on the ${shape} stage: ${focused}`);
    await formCx.send('Input.insertText', { text: value });
    const len = await evaluate(
      formCx,
      `(function () { var e = ${DEEP}(${JSON.stringify(selector)}); return e ? e.value.length : -1; })()`,
    );
    console.log(`[login:${account}] ${shape}: ${selector} <- ${len} chars`);
  }
  // Activate the button BY ELEMENT, not by coordinates. On the phone the focused field raises the
  // IME, the viewport resizes, and a centre computed a moment earlier lands somewhere else - a race
  // that costs a silent non-submit. Neither IdP is the system under test, so event fidelity buys
  // nothing here; every click INSIDE Canari still goes through realClick.
  const submitted = await evaluate(
    formCx,
    `(function () {
      var b = ${DEEP}(${JSON.stringify(STAGE[shape].submit)});
      if (!b) return 'no button';
      b.click();
      return 'clicked';
    })()`,
  );
  console.log(`[login:${account}] ${shape}: submit ${submitted}`);
  if (submitted !== 'clicked') throw new Error(`no submit button on the ${shape} stage`);
};

/**
 * A connection to whatever page holds the credential flow RIGHT NOW - re-resolved, never reused.
 *
 * A CDP CONNECTION SURVIVES A NAVIGATION AND ITS EXECUTION CONTEXT DOES NOT, and that is the whole
 * reason this exists. Measured 2026-09-04 driving the service-account flow: every submit landed, the
 * flow advanced identification -> password -> the app, and the very same connection kept answering
 * `authentik-uid` and the PRE-SUBMIT url afterwards. So the loop re-typed a stage that was no longer
 * on screen four times and then reported "still on a form after 4 stages" about a client already
 * sitting on the feed - a login that had entirely succeeded, recorded as a failure.
 *
 * Reading the URL harder does not fix it, because the stale answer IS the URL. The fix is to stop
 * holding a handle across the navigation: resolve the target again, and read the document that
 * exists now. It is the same move the phone path already makes for the landing, and for the same
 * reason.
 *
 * `null` MEANS THE FLOW IS DONE WITH US: no page on that port is at an IdP any more. That is a fact
 * about the browser rather than about a form's absence - Authentik shows no field at all for a frame
 * or two between its two stages, and treating THAT as the end would exit with the password never
 * typed.
 */
const formPort = tabTarget ? TAB_PORT : port;
const freshFormCx = async () => {
  // THE SAME CHOICE, SO THE SAME PREDICATE. This used to take the FIRST IdP target on the port,
  // which on the phone is one of the stale tabs `idpTargetOn` exists to reject - so a run that had
  // correctly found the live form would hand the NEXT stage to a dead one and report that the flow
  // never advanced. Two places choosing a tab must not choose it two ways.
  const at = await idpTargetOn(formPort);
  if (!at) return null;
  const c = connect(at.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  return c;
};

// ONE STAGE AT A TIME, ending on a FACT rather than on a count. The service-account flow renders
// identification and password as two separate stages on the SAME url, so nothing about the address
// says how many are left - the loop asks what is on screen and answers it. The bound exists only so
// a flow that keeps producing stages is REPORTED rather than looping for ever; `MAX_STAGES` is
// deliberately larger than the two either IdP asks for today.
// THE STAGE JUST ANSWERED IS NOT THE NEXT ONE, and reading it as such is what makes this loop
// re-type a field it has already submitted. Authentik re-renders in place: for a second or so after
// the click the identification stage is STILL on screen, so a wait that ends on "some form is up"
// ends on the one that was just answered - measured 2026-09-04, four rounds of typing the username
// into a stage that had already accepted it, then a throw about a login one keystroke from done.
// So the wait ends on a DIFFERENT shape, on leaving the IdP, or on neither - and those are three
// outcomes with three messages, never one silence.
const MAX_STAGES = 4;
let answered = null;
for (let n = 0; n <= MAX_STAGES; n++) {
  let cxNow = null;
  let shape = null;
  let atAnIdPStill = true;
  for (let i = 0; i < 60; i++) {
    cxNow = await freshFormCx();
    if (!cxNow) {
      atAnIdPStill = false;
      break;
    }
    shape = await evaluate(cxNow, FORM_SHAPE).catch(() => null);
    if (shape && shape !== answered) break;
    shape = null;
    cxNow.close();
    cxNow = null;
    await sleep(400);
  }
  if (!atAnIdPStill) break;
  if (!shape) throw new Error(`the ${answered} stage never gave way to another within 24s`);
  if (n === MAX_STAGES) {
    cxNow.close();
    throw new Error(`still on a ${shape} form after ${MAX_STAGES} stages`);
  }
  await answerOneStage(shape, cxNow);
  answered = shape;
  cxNow.close();
}

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

// `/auth/callback` IS NOT A LANDING, IT IS THE EXCHANGE STILL RUNNING. The deep link returns the
// app to that route carrying a code, and the app is on the app's own origin from that instant - so a
// poll that ends on the ORIGIN ends while the screen still says "Echange du code d'autorisation..."
// and no session has been written yet. Measured 2026-09-04: this atom exited 0 on
// `/auth/callback?code=...`, and the login only finished afterwards, unobserved. A caller handed
// that would go on to ask a logged-out app for a sidebar, which is the failure the session predicate
// upstream was written to remove - the same mistake, one page later.
//
// An atom ends on a FACT. The fact here is the one the app itself writes.
const stillExchanging = (url) => url.includes('/auth/callback');

// CAS -> auth.canari-emse.fr -> back to the app. Poll rather than guess a single delay.
let arrived = null;
for (let i = 0; i < 300; i++) {
  await sleep(100);
  const url = await landing();
  if (onTheApp(url) && !stillExchanging(url)) {
    arrived = url;
    console.log(`[login:${account}] landed ${url} after ${((i + 1) / 10).toFixed(1)}s`);
    break;
  }
  if (i === 299) console.log(`[login:${account}] STILL AT ${url}`);
}
if (!arrived) console.log(`[login:${account}] the code exchange never left /auth/callback`);

// Read the app through a FRESH connection on the tab path, for the same reason - and on the tab path
// `cx` may never have been opened at all, which is now the NORMAL phone case rather than an edge.
let readCx = tabTarget ? null : await appCx();
if (tabTarget) {
  formCx.close();
  const seen = await listTargets(port).catch(() => []);
  const app = seen.find((t) => onTheApp(t.url));
  if (!app) throw new Error(`the Custom Tab submitted but the app has no target on ${port}`);
  readCx = connect(app.webSocketDebuggerUrl);
  await readCx.ready;
  await readCx.send('Runtime.enable');
}

// THE POST-CONDITION, ASSERTED RATHER THAN ASSUMED - and read through the target that exists NOW.
// `canari_saved_user` is what the app writes at login and erases at logout, the same key the
// idempotence check at the top of this file reads. Saying "logged in" without it is saying "a page
// rendered".
const session = await evaluate(readCx, `!!localStorage.getItem('canari_saved_user')`);
console.log(`[login:${account}] session held: ${session}`);
console.log(`[login:${account}] final ${await evaluate(readCx, 'location.href')}`);
console.log(await evaluate(readCx, 'document.body.innerText.replace(/\\s+/g," ").slice(0,500)'));
readCx.close();
if (cx && readCx !== cx) cx.close();

// A NON-ZERO EXIT, because a caller reads the code and not the prose. This atom's whole purpose is
// to leave the client holding a session, so not holding one is a failure however far the flow got.
if (!session) {
  throw new Error(`the flow completed but no session was written - the app is not logged in`);
}
