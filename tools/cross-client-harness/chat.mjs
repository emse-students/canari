/**
 * Chat primitives shared by every check in the campaign.
 *
 * Deliberately a MODULE, not a CLI: each check composes send/read/reconcile differently, and the
 * one thing they must all share is the definition of "a message arrived" - otherwise two checks
 * disagree about a pass for reasons that belong to the harness rather than to the app.
 *
 * See docs/wiki/cross-client-testing.md section 9 (evidence rule).
 */
import { IS_MOVING_FN, RESOLVE, activate, clickAtPoint, connect, dragTo, evaluate, listTargets, pressKey, realClick, stablePoint, until } from './cdp.mjs';
// For the device check in `goto`: the phone is the one client a reload costs something on.
import { PORTS, SITE } from './names.mjs';

/**
 * THE SUBSTRING THAT IDENTIFIES THE APP'S OWN TAB, and it is DERIVED rather than spelt.
 *
 * `client(port, match)` and every `listTargets(...).find(...)` pick a tab by matching a substring of
 * its URL, and sixty-six call sites spelt `'canari-emse.fr'`. The resume page counted them and
 * concluded they were harmless - "matched by SUBSTRING, no anchored comparison" - which is true of
 * the COMPARISON and false of the NEEDLE: a needle no local URL contains matches nothing, so every
 * one of those call sites threw `no target on 9224 matching canari-emse.fr` against a browser
 * sitting on the app. The one-line switch of estates was one line plus these.
 *
 * `APP_TAB` is the host WITH its port, because that is what a URL contains and what distinguishes
 * two local estates. `APP_HOST` is the hostname alone, for the one question that is not about a URL:
 * a COOKIE's `domain`, which carries no port and never will.
 */
export const APP_TAB = new URL(SITE).host;

/** The app's hostname, without a port: what a cookie's `domain` can be compared against. */
export const APP_HOST = new URL(SITE).hostname;
import { OVERLAYS } from './overlay-probe.mjs';

// SCOPED TO THE CHAT, and that scoping is the whole point.
//
// `.chat-composer-editor` is a class of the SHARED `MentionComposerInput`, which the social feed
// also uses for its "Ajouter un commentaire..." boxes. So a bare `.chat-composer-editor` is present
// on `/posts` too, and every "am I in a conversation?" post-condition built on it answered YES on
// the FEED - which is exactly the fiction the post-conditions exist to prevent (NOTIF-7 killed
// reported `composer: true` while the app was sitting on the social feed). `send()` is worse: on
// the feed it would have typed the marker into a COMMENT box on somebody's post.
//
// `.chat-composer-footer` belongs to `ChatComposer.svelte` alone.
export const COMPOSER = '.chat-composer-footer .chat-composer-editor';

/** True once the send control exists and is no longer disabled - see the race in `send`. */
export const SEND_ENABLED = `(function () {
  var b = [...document.querySelectorAll('button')].find(function (e) {
    return (e.getAttribute('aria-label') || '').includes('Envoyer le message');
  });
  return !!b && !b.disabled;
})()`;

/**
 * The open conversation's pane, as page-side JS.
 *
 * Counting on `document.body` double-counts EVERY message: the sidebar renders the last one as a
 * preview, so a single delivered message reads as two copies and the duplicate assertion - the
 * whole point of MSG-1 - is meaningless. The pane is a <section>, and the sidebar is a sibling of it.
 *
 * ANCHORED ON THE MESSAGE LIST, NOT ON THE COMPOSER, since 2026-08-20. It was the composer's nearest
 * <section> for a year, which was true of every conversation there had ever been - until a salon
 * reserved for administrators started replacing the composer with the reason. The pane then read
 * `null` for a member who could still READ perfectly well, and COMM-7 reported `hasPane: false`:
 * the harness saying "this client has no conversation open" about a client watching one, and
 * failing the row on the ADMINISTRATOR's message. **A conversation is a place where messages are
 * DISPLAYED; being able to write in it is a permission.** `.chat-messages-scroll` is the app's own
 * class on that list, exactly as `.chat-composer-footer` was - no attribute was added for the
 * harness.
 */
export const PANE = `(function () {
  var list = document.querySelector('.chat-messages-scroll');
  return list ? list.closest('section') : null;
})()`;

/**
 * WHAT THE CONVERSATION PANE IS SHOWING: `'composer'`, `'removed'`, or `'nothing'`.
 *
 * THREE CALL SITES INFERRED "no conversation is open" FROM "no composer", AND ALL THREE WERE WRONG
 * IN THE SAME WAY. `ChatArea.svelte` renders a conversation the peer deleted with a notice and a
 * "Supprimer localement" button IN PLACE OF the composer (`lifecycle === 'removed'`), so a pane can
 * be showing a conversation and have no composer at all - by design, not by failure:
 *
 *   - `groupnav.openGroup` waited twelve seconds for a control the product does not draw there, three
 *     times, and then threw "would not open" - which reads as a product defect and is not one. It
 *     cost READ-10 every verdict it had ever tried to produce.
 *   - `openConversation`'s post-condition did the same with a bare `until`, so the failure named
 *     neither the client nor the conversation.
 *   - `read.leaveConversation` had it INVERTED and that was the expensive one: it returned
 *     `'already outside a conversation'` the moment the composer was absent, so on a phone holding a
 *     dead conversation it parked NOTHING and reported success. Mobile gives the whole screen to the
 *     conversation, so the next step looked for a sidebar row in a sidebar that was not on screen and
 *     died reporting an empty conversation list on a device with thirteen rows.
 *
 * One predicate, exported, because the fault was never the wait - it was three files each holding a
 * different third of what "open" means. `'removed'` is a conversation and `'nothing'` is not.
 */
export const PANE_STATE = `(function () {
  if (document.querySelector('${COMPOSER}')) return 'composer';
  var dead = [].slice.call(document.querySelectorAll('button')).some(function (b) {
    return (b.innerText || '').indexOf('Supprimer localement') !== -1;
  });
  return dead ? 'removed' : 'nothing';
})()`;

/** True when the pane holds a conversation, whether or not that conversation can be typed in. */
export const PANE_HAS_CONVERSATION = `(${PANE_STATE} !== 'nothing')`;

/**
 * Leaves whatever conversation this client has OPEN, so it stops reading what arrives in it.
 *
 * `ensureChat` cannot be used for this and it is not a near-miss: it returns `'already'` the instant
 * `location.pathname === '/chat'`, and a phone sitting in a DM is on `/chat` with that DM selected.
 * So a check that called it to get another device out of the way changed nothing at all - which is
 * how READ-3 came to blame a hidden tab for a receipt the PHONE had sent, the read watermark being
 * per-user rather than per-device.
 *
 * Mobile gives the whole screen to the conversation and carries a back control; the desktop layout
 * keeps the list beside it and has none, so a browser is left as it is and its callers open a
 * different route instead. Addressed by ACCESSIBLE NAME, which is the part of a control that cannot
 * change silently.
 *
 * READS THE COMPOSER FIRST, AND THAT ORDER IS THE POINT. "No back control" has TWO legitimate
 * causes - no conversation is open, or this layout has no such control - and they mean opposite
 * things: the first is the state this function exists to reach, the second is a failure to reach
 * it. Collapsing them into one string made READ-3 report `no back control on this layout` on a
 * phone that was in fact already out, which reads as an unarmed precondition when it is a satisfied
 * one. The return value is what a later verdict is judged against, so it has to separate them.
 */
export async function parkConversation(cx) {
  const BACK = '[aria-label="Retour au menu"]';
  // THE COMPOSER IS NOT WHAT "A CONVERSATION IS OPEN" MEANS, and reading it as such made this
  // function a no-op that reported success. A conversation the peer deleted draws a notice and
  // "Supprimer localement" INSTEAD of the composer, so on 2026-08-21 A1 - holding exactly such a
  // conversation, left there by an earlier failed run - was declared "already outside a
  // conversation" and never parked. Mobile gives the whole screen to the conversation, so the next
  // step went looking for a sidebar row in a sidebar that was not on screen, and READ-9 died
  // reporting an EMPTY conversation list on a device that had thirteen rows.
  //
  // `PANE_STATE` is shared with `openConversation` and `groupnav` for that reason: three files each
  // held a different third of this and all three were wrong about the same state.
  const state = await evaluate(cx, PANE_STATE);
  if (state === 'nothing') return 'already outside a conversation';
  const visible = `(function () {
    var b = document.querySelector('${BACK}');
    if (!b) return false;
    var r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`;
  if (!(await evaluate(cx, visible))) return 'a conversation is open and this layout offers no back control';
  await realClick(cx, BACK);
  const gone = await until(cx, `${PANE_STATE} === 'nothing'`, 8000).catch(() => null);
  return gone === null ? `back clicked but the pane stayed on a conversation (${state})` : 'left';
}

/**
 * The pane's text WITHOUT the composer's - the composer is inside the pane.
 *
 * Without the subtraction, text sitting in the composer reads back as a delivered message: a send
 * that failed to submit still "arrives", `awaitMessage` returns instantly on the sender, and a
 * triage says the sender has its message when what it actually has is an unsent draft. That is
 * exactly how MSG-8b first read as an app-level loss (2026-08-06). The composer's own text is
 * removed by string, not by DOM surgery, so `innerText` keeps its visible-only semantics - which
 * the virtualised-list reconciliation depends on.
 */
const PANE_TEXT = `(function () {
  var list = document.querySelector('.chat-messages-scroll');
  var pane = list ? list.closest('section') : null;
  if (!pane) return '';
  var text = pane.innerText;
  // THERE MAY BE NO COMPOSER AT ALL - a salon this account may not write in replaces it with the
  // reason. Nothing to subtract then, and the pane's text is already the transcript's.
  var c = document.querySelector('.chat-composer-footer .chat-composer-editor');
  var draft = c ? (c.innerText || '').trim() : '';
  return draft ? text.split(draft).join('') : text;
})()`;

/**
 * Connect to a client by port, optionally picking the tab whose URL contains `match`.
 *
 * FOCUS EMULATION IS ON BY DEFAULT, and it is not a convenience.
 *
 * Only one OS window can hold the focus, and this harness drives THREE clients plus a terminal - so
 * at least two of them always report `document.hasFocus() === false`, which is a lie about what a
 * real user's window is doing. Two product paths read exactly that bit:
 * `MainChatPage.svelte:435` refuses to emit a read receipt unless the window is focused AND the tab
 * visible, and `useMessaging.svelte.ts:376` fires the web system notification only when it is not.
 * NOTIF-4 therefore FAILED twice (2026-08-06, 22:21 and 22:34) with `dismissedInMs: null` for a
 * reason that belonged entirely to the harness: W1 read the message, never sent the receipt, so the
 * phone was never told to cancel its notification. Harness fault #18.
 *
 * `Emulation.setFocusEmulationEnabled` makes the page report focused and active without giving it
 * the real OS focus, so all three clients can be "the focused window" at once. It does NOT touch
 * `document.visibilityState`, which is what the TAB phase manipulates - backgrounding a tab by
 * focusing a SIBLING TAB still works, and those checks keep their meaning.
 *
 * Pass `{ focus: false }` where the unfocused state is the thing under test.
 *
 * AND IT REFUSES AN AMBIGUOUS BROWSER, because `find` returning the first of several matches is a
 * silent wrong-tab pick and the check that follows measures a client nobody chose. Measured
 * 2026-08-16: W2 had SEVEN app tabs left over from the TAB probes, and a send-and-receive probe read
 * six console lines from the tab it happened to attach to while the profile's snapshot counter
 * advanced seventeen times in another. Two consequences, both of which had already been filed as
 * application questions: `MSG-9` read INVALID because cutting one tab's network leaves the user
 * present at the gateway through the other six, and two verdicts were PASS-DIRTY on
 * `[MLS] Skipping stale MLS state write`, which is the write-if-newer guard doing its job against
 * seven MLS clients sharing one IndexedDB - the multi-tab class, manufactured by the rig itself.
 *
 * `{ allowMany: true }` is for a check that opens a sibling ON PURPOSE and knows which it wants.
 */
export async function client(port, match = null, { focus = true, allowMany = false } = {}) {
  const targets = await listTargets(port);
  const hits = match ? targets.filter((x) => x.url.includes(match)) : targets;
  // The check is the same with and without `match`, because the fault is the same: `hits[0]` is a
  // POSITION. Seventeen call sites pass no match at all and were relying on the browser having one
  // page - true after the preflight, and silently false the moment anything leaves a tab behind.
  if (!allowMany && hits.length > 1)
    throw new Error(
      `${hits.length} tabs on ${port}${match ? ` match ${match}` : ''}, so no tab can be chosen: ` +
        `${hits.map((x) => new URL(x.url).pathname).join(' | ')}. ` +
        'Close the extras (bun onetab.mjs) or pass { allowMany: true } if the sibling is deliberate.'
    );
  const t = hits[0];
  if (!t) throw new Error(`no target on ${port} matching ${match}; have ${targets.map((x) => x.url).join(' | ')}`);
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  cx.port = port;
  if (focus) {
    // Not supported by the Tauri WebView on some builds; a check must not die because of it, but a
    // silent failure would put the campaign right back where fault #18 left it, so it is recorded.
    cx.focusEmulated = await cx
      .send('Emulation.setFocusEmulationEnabled', { enabled: true })
      .then(() => true, () => false);
  }
  return cx;
}

/**
 * Navigate to a top-level app section. The app is a SPA whose conversations are NOT routes
 * (see DURABLE RULES: `/c/<groupId>` is not a route), so section navigation is by URL but
 * conversation selection is by click.
 *
 * A1 IS REFUSED, because "DO NOT USE ON A1" was written here as prose and three call sites did it
 * anyway. A reload of the Tauri webview costs two things, and only the first was known:
 *
 * - it re-locks the encryption PIN, so the check waits on a modal it never expected - the run does
 *   not fail, it HANGS, and prints nothing;
 * - it replaces the document under Tauri's own IPC. Every command that returns an error, and every
 *   scalar response, is delivered by the Rust side EVALUATING
 *   `window.__TAURI_INTERNALS__.runCallback(...)` into the page (`format_raw_js`, tauri 2.11). A
 *   response issued before the navigation lands in the new document, whose init script has not run
 *   yet, and reading `.runCallback` off an undefined object throws - which is MUT-18's
 *   `Cannot read properties of undefined (reading 'runCallback')` at `(no url):1:28`, column 28
 *   being exactly where `runCallback` sits in that string. Three sightings, 2026-08-16, dirt the
 *   harness manufactured and then reported as the application's.
 *
 * Use `ensureChat` instead - which is also the more faithful path, since a real user clicks. Where a
 * relaunch IS the subject, say so: `goto(cx, path, { relaunch: 'why' })` keeps it, and makes every
 * surviving A1 reload greppable by that word.
 */
export async function goto(cx, path, { relaunch = null } = {}) {
  if (cx.port === PORTS.A1 && !relaunch)
    throw new Error(
      `goto('${path}') on A1 reloads the Tauri webview: it re-locks the PIN and breaks Tauri's ` +
        'IPC callbacks into the old document. Use ensureChat/openConversation, or pass ' +
        "{ relaunch: 'why this check needs a reload' } if that is the subject."
    );
  const before = cx.events.length;
  await cx.send('Page.navigate', { url: `${await origin(cx)}${path}` });
  await until(cx, `document.readyState === 'complete'`, 20000);
  const ms = await awaitGatewayConnected(cx, before);
  if (ms === null) console.log(`  [goto] ${path}: no gateway connection line within 30 s - the client may still be coming up`);
  return ms;
}

/**
 * Waits for the socket the navigation just tore down to come back, and RETURNS HOW LONG IT TOOK.
 *
 * A NAVIGATION IS A DISCONNECTION, and `readyState === 'complete'` says nothing about it. Every
 * `goto` reloads the SPA, which drops the gateway socket and opens a new one; the composer renders
 * from cached data long before that finishes. A check that sends in that window measures its own
 * navigation - MSG-5 failed exactly there on 2026-08-13 (`copies.A1: 0`, `latency.A1: null`) and
 * passed alone four minutes later with A1 at 547 ms, the difference being nothing but how much of
 * the phone's boot had gone by. The phone shows it worst because `openChannel` navigated it at all,
 * against `goto`'s own written rule, but the window exists on every client.
 *
 * The proof is the app's own line, `[WS] Connected to Chat Gateway`, and it is only asked for after
 * an event index taken BEFORE the navigation - so it can never be satisfied by the connection that
 * was already there, which is the trap in every "is it connected yet" probe. A client that is not
 * navigating cannot use this: it has nothing to wait for. That question is `presence.mjs`, which
 * asks the gateway instead of the client.
 *
 * @returns milliseconds waited, or `null` if the line never came - never an exception, because a
 *   check that dies here reports a harness failure where there may be a real one.
 */
export async function awaitGatewayConnected(cx, sinceIndex, timeoutMs = 30000) {
  const started = Date.now();
  const CONNECTED = /\[WS\] Connected to Chat Gateway/;
  for (;;) {
    for (let i = sinceIndex; i < cx.events.length; i++) {
      const ev = cx.events[i];
      if (ev.method !== 'Runtime.consoleAPICalled') continue;
      const text = (ev.params?.args || []).map((a) => String(a.value ?? '')).join(' ');
      if (CONNECTED.test(text)) return Date.now() - started;
    }
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Waits for a request matching `pattern` to be SENT, and returns its `requestId`.
 *
 * Needed by any check that must act while something is in flight: an event that has already been
 * observed is the only honest way to know a window is open, and `Network.enable` must be on before
 * the window can be entered - a listener attached afterwards can only ever see the end of it.
 *
 * `pattern` is a RegExp OR a predicate over the url. The predicate form exists because the
 * interesting request is often a SIBLING of an uninteresting one on the same path - the history
 * route serves a `limit=1` existence probe and a `limit=1000` replay page from the same URL - and
 * a regex that encodes "this one but not that one" is unreadable at the call site, which is where
 * the distinction has to be obvious.
 *
 * @returns the requestId, or `null` if nothing matched before the deadline.
 */
export async function awaitRequest(cx, pattern, sinceIndex, timeoutMs = 25000) {
  const started = Date.now();
  const matches = typeof pattern === 'function' ? pattern : (url) => pattern.test(url);
  for (;;) {
    for (let i = sinceIndex; i < cx.events.length; i++) {
      const ev = cx.events[i];
      if (ev.method === 'Network.requestWillBeSent' && matches(ev.params?.request?.url || '')) {
        return ev.params.requestId;
      }
    }
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Waits until nothing matching `pattern` has been SENT for `quietMs`, and nothing is still in flight.
 *
 * The precondition of any check that wants to observe ONE load: a page that has just been navigated
 * to is still running its own bootstrap, and a check that acts during it is racing something it does
 * not control. MSG-1b was non-deterministic for exactly that reason - its primer sometimes reached
 * the receiver while the conversation-list bootstrap was still replaying, which consumed it and left
 * the deliberate cold open with nothing new to fetch. Quiescence is the fact that ends the bootstrap;
 * a sleep is a guess about it.
 *
 * @returns milliseconds waited, or `null` if it never went quiet before the deadline.
 */
export async function awaitRequestsQuiet(cx, pattern, { quietMs = 3000, timeoutMs = 30000 } = {}) {
  const matches = typeof pattern === 'function' ? pattern : (url) => pattern.test(url);
  const started = Date.now();
  let inFlight = new Set();
  let lastActivity = Date.now();
  let cursor = 0;
  for (;;) {
    for (; cursor < cx.events.length; cursor++) {
      const ev = cx.events[cursor];
      if (ev.method === 'Network.requestWillBeSent' && matches(ev.params?.request?.url || '')) {
        inFlight.add(ev.params.requestId);
        lastActivity = Date.now();
      } else if (
        (ev.method === 'Network.loadingFinished' || ev.method === 'Network.loadingFailed') &&
        inFlight.delete(ev.params?.requestId)
      ) {
        lastActivity = Date.now();
      }
    }
    if (inFlight.size === 0 && Date.now() - lastActivity >= quietMs) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Every matching request URL sent since `sinceIndex`, in order.
 *
 * The companion of `awaitRequest` for the case where it returns `null`: "the request I wanted never
 * came" has several causes and they need different fixes, and the ones that DID come name which.
 * A check that reports only the absence sends its reader looking in the wrong place.
 */
export function requestsSince(cx, pattern, sinceIndex = 0) {
  const matches = typeof pattern === 'function' ? pattern : (url) => pattern.test(url);
  return cx.events
    .slice(sinceIndex)
    .filter((ev) => ev.method === 'Network.requestWillBeSent' && matches(ev.params?.request?.url || ''))
    .map((ev) => ev.params.request.url);
}

/** Has that request finished (or failed) yet? The question "is the window still open" asked exactly. */
export function requestSettled(cx, requestId) {
  return cx.events.some(
    (ev) =>
      (ev.method === 'Network.loadingFinished' || ev.method === 'Network.loadingFailed') &&
      ev.params?.requestId === requestId
  );
}

export const origin = (cx) => evaluate(cx, 'location.origin');

/**
 * A CLIENT THAT CAN BE DRIVEN: past the PIN gate, with something actually rendered.
 *
 * The sibling of `run.mjs`'s `READY`, deliberately narrower. That one has to TELL APART `LOCKED`,
 * `booting` and `unknown` because it repairs each differently; a check only ever needs the single
 * boolean, and giving it the richer probe would tempt it into repairing things mid-measurement.
 *
 * `readyState === 'complete'` is NOT this condition and never was: it goes complete while the app is
 * still deciding whether the encryption key is available, so it certifies a client one second away
 * from raising a PIN prompt. Something RENDERED is the proof.
 */
export const APP_READY = `(function () {
  if (document.querySelector('#encryption-pin')) return false;
  return document.querySelectorAll('aside button, nav button').length > 0;
})()`;

/**
 * True when the client is asking to LOG IN, which is a different loss from asking for the PIN.
 *
 * The distinction is the whole point of every cold-start check: a PIN prompt means the profile kept
 * its session and only the encryption key is locked, while a login form means the session itself did
 * not survive - so the `#encryption-pin` test comes FIRST and short-circuits, or a locked client on a
 * page that happens to say "connexion" would be read as logged out.
 *
 * AND THE FIRST VERSION GOT IT BACKWARDS, which is why the order is written down here: the unlock
 * field is `#encryption-pin`, an `input[type=password]`, so "a password field is on screen" scored
 * the PIN modal as a re-login and failed a check that had actually passed.
 *
 * Lived in `tab236.mjs` until TAB-3b needed the same question asked the same way.
 */
export const LOGIN_SHOWING = `(function () {
  if (document.querySelector('#encryption-pin')) return false;
  if (document.querySelector('input[type=email], input[name=email], input[autocomplete=username]')) return true;
  if (/^\\/(auth|login)/.test(location.pathname)) return true;
  var t = document.body ? document.body.innerText : '';
  return /se connecter|connexion avec|identifiant/i.test(t) && !document.querySelector('.chat-composer-editor');
})()`;

/**
 * Waits for a reloaded or relaunched client to be usable, and FAILS on the deadline.
 *
 * Every caller of this used to be `await sleep(6000)` - or 10 000, or 12 000, each number a guess
 * about the slowest machine anyone had tried. That costs both ways at once: on a fast run it burns
 * the whole budget after the app has been ready for five seconds, and on a slow one it hands the
 * next line a client that is not up yet, which then fails as though the application were broken.
 * Polling a fact does neither. The number stops being a duration and becomes what it should always
 * have been - the point past which we no longer believe the client is coming back.
 */
export async function awaitAppReady(cx, timeoutMs = 30000) {
  return until(cx, APP_READY, timeoutMs);
}

/**
 * POLLS A HOST-SIDE FACT TO A DEADLINE - the shape `sleep(n)` is standing in for almost everywhere.
 *
 * `until` polls a PAGE-SIDE expression, which covers the cases where the whole question fits in one
 * `Runtime.evaluate`. It does not cover the ones where the fact is assembled here - two clients
 * compared, a count plus a DOM read, adb output beside a browser state - and those are exactly the
 * call sites that had settled on a fixed sleep.
 *
 * The user's standing rule on this: "il faudrait utiliser un minimum de sleep. A la limite au bout
 * d'un moment on considere que le temps alloue etait trop long et on passe en fail, mais sinon ca se
 * traduit par des attentes interminables alors que le process est deja fini depuis longtemps". Both
 * halves are here - it returns the instant the fact holds, and the deadline expiring is a RESULT
 * (`ok: false`) the caller must judge, never a thrown error that reads as an instrument failure.
 *
 * The predicate's own return value comes back too, so a caller does not have to compute it twice.
 *
 * @param {() => Promise<any>} fn truthy when the fact holds
 * @returns {Promise<{ok: boolean, elapsedMs: number, value: any}>}
 */
export async function pollFact(fn, { timeoutMs = 15000, everyMs = 400 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return { ok: true, elapsedMs: Date.now() - t0, value };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, value };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * A COUNT THAT HAS STOPPED CHANGING - the honest form of "wait, then count".
 *
 * Counting a marker is the campaign's central measurement, and the question is almost never "has it
 * arrived" (`awaitMessage` answers that) but "has a SECOND copy arrived" - a duplicate, the class
 * this whole campaign exists to see. That is the absence of an event, and no fact can be waited on
 * for it, which is why every call site had settled on `sleep(2500)` and a single read.
 *
 * A fixed sleep answers a different question than the one asked, in both directions: it reports a
 * duplicate that lands at 2 600 ms as absent, and it charges 2.5 s to the ninety-nine reads where
 * nothing was ever going to change. Stability is the observable that was wanted: poll, and return as
 * soon as the value has held still for `quietMs`. The common case returns almost at once.
 *
 * `settled: false` IS A RESULT, not an error. A count still moving at the deadline means the system
 * had not finished doing whatever it was doing, so the number is not evidence of anything - the
 * caller must record that rather than quietly treat a snapshot of a moving value as a measurement.
 */
export async function settledCount(cx, marker, { quietMs = 700, timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let value = await countMessage(cx, marker);
  let since = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    if (Date.now() - since >= quietMs) return { count: value, settled: true, elapsedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 120));
    const now = await countMessage(cx, marker);
    if (now !== value) {
      value = now;
      since = Date.now();
    }
  }
  return { count: value, settled: false, elapsedMs: Date.now() - t0 };
}

// ONE DEFINITION, in the pure module, re-exported so no caller had to move. See overlay-probe.mjs
// for why it could not stay in this file.
export { OVERLAYS };

/**
 * Leaves the screen with nothing covering it, and REPORTS what it had to remove.
 *
 * This is the half of check isolation that no assertion can replace. Every other precondition in
 * this file answers "am I in the right place"; none of them answers "can I click", and a client can
 * satisfy all of them with a modal on top - `ensureConversation` reads the header, which is still
 * there BEHIND the dialog, so it returns `already` and the next `realClick` dies with `no stable
 * element`. That is not a hypothetical: it is the aftermath that killed four MSG scripts in a row
 * once one of them crashed with a sheet open.
 *
 * The return value is EVIDENCE, not bookkeeping. An empty array means the previous check left the
 * rig clean; anything else names debris, and the runner prints it precisely because a check that
 * leaves a modal behind is a fault in that check even when its own verdict was PASS.
 *
 * Idempotent and cheap: the common case is one round trip and no key press. Escape first because it
 * is what dismisses a dialog, the backdrop click second because the sheets that ignore Escape only
 * close on an outside click. Bounded at four rounds - a modal that survives all four is reported and
 * left alone rather than beaten on, since `Modal.svelte` can be constructed non-dismissible and
 * clicking blindly at that point would be pressing whatever button happens to be under the cursor.
 *
 * A DIALOG THAT IGNORES ESCAPE STILL HAS A CLOSE CONTROL, and giving up before using it is what made
 * this function poison a whole run. On 2026-08-14 the create-channel modal came up on W1 with focus
 * in its text input; Escape did nothing, this reported `STUCK ... left alone`, and every one of the
 * eleven checks after MSG-5 was BLOCKED against a client that one click would have freed.
 *
 * So Escape escalates to the dialog's OWN close control - found structurally, never by caption:
 * a visible, enabled, icon-only button (no innerText) whose centre sits in the dialog's top-right
 * corner. `[aria-label="Fermer"]` is not usable here and the previous attempt at this proved it -
 * that caption is a Paraglide string that reads "Close" on an `en` client. The icon-only rule is
 * also what keeps this safe: every confirming control in this app carries a word ("Creer le canal",
 * "Supprimer"), so a button with no text cannot be one, and nothing here can confirm a destructive
 * action by accident.
 */
export async function clearOverlays(cx) {
  const read = async () => JSON.parse(await evaluate(cx, OVERLAYS));
  const cleared = [];

  // ANSWERED, not merely removed, and FIRST. The biometric offer is dismissible, so Escape below
  // would clear it - and it would come back, because an offer Escaped is a question left open. It
  // also must never be answered the other way: "Activer" erases the PIN, which is the only
  // credential this rig can present. `declineBiometricOffer` says why at length.
  if ((await declineBiometricOffer(cx)) === 'declined') {
    cleared.push({ kind: 'offer', label: 'Connexion rapide' });
  }
  const TAG = 'data-harness-backdrop';
  const CLOSE = 'data-harness-close';
  let escaped = false;
  // NOT a once-only flag. `closeClicked` used to be one, and that alone limited this function to
  // closing exactly ONE dialog per call - so a stacked pair survived, the rig stayed blocked, and the
  // loop spent its remaining rounds re-reading a state it had decided not to act on.
  //
  // WHAT LICENSES ANOTHER CLOSE IS THE LAST CLOSE HAVING WORKED, not the round having made progress.
  // The first attempt at this gated on the round, and Escape is the first round's action: Escape does
  // nothing to these dialogs, so the count never dropped, so no close was ever licensed and the fix
  // fixed nothing. This holds the count AT THE LAST CLOSE - so the first close is always allowed, and
  // a further one only after the previous one removed something. A dialog that will not close is met
  // exactly once, which is the point of the icon-only rule: pressing on would be clicking blindly.
  let countAtLastClose = null;

  /** Tags the dialog's icon-only top-right control, and says whether there was one. */
  const tagCloseControl = async () =>
    (await evaluate(
      cx,
      `(function () {
        // THE TOPMOST DIALOG, NOT THE FIRST IN THE DOM. With two stacked - a group settings panel
        // holding a member picker - querySelector returns the OUTER one, whose close button is then
        // covered by the inner one's own backdrop. The click died with 'no stable element', and
        // because it THREW it took the whole preflight with it. Stacking is not exotic: any check
        // that opens a picker from a settings panel and fails inside it leaves exactly this.
        var all = [].slice.call(document.querySelectorAll('[role=dialog][aria-modal=true]'));
        if (all.length === 0) return 'no-dialog';
        var z = function (e) {
          var v = 0;
          for (var n = e; n && n !== document.body; n = n.parentElement) {
            var s = getComputedStyle(n);
            var zi = parseInt(s.zIndex, 10);
            if (!isNaN(zi) && zi > v) v = zi;
          }
          return v;
        };
        // Highest stacking context wins; DOM order breaks a tie, because a portal appended later is
        // on top of one appended earlier at the same z-index.
        var d = all[0];
        for (var i = 1; i < all.length; i++) if (z(all[i]) >= z(d)) d = all[i];
        var dr = d.getBoundingClientRect();
        var hit = [].slice.call(d.querySelectorAll('button')).filter(function (b) {
          if (b.disabled) return false;
          if ((b.innerText || '').trim()) return false;
          var r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          var cx0 = r.left + r.width / 2;
          var cy0 = r.top + r.height / 2;
          return cx0 > dr.left + dr.width / 2 && cy0 < dr.top + dr.height / 2;
        })[0];
        if (!hit) return 'none';
        hit.setAttribute('${CLOSE}', '1');
        return 'tagged';
      })()`
    )) === 'tagged';

  for (let round = 0; round < 4; round += 1) {
    const found = await read();
    if (found.length === 0) return cleared;
    const mayClose = countAtLastClose === null || found.length < countAtLastClose;

    const dialog = found.find((o) => o.kind === 'dialog');
    let escalationLeft = false;
    if (dialog) {
      if (!escaped) {
        await pressKey(cx, 'Escape');
        escaped = true;
        escalationLeft = true;
      } else if (mayClose && (await tagCloseControl())) {
        countAtLastClose = found.length;
        try {
          // CAUGHT, because this function's own contract is that a modal it cannot close is
          // REPORTED and left alone - "rather than beaten on". A throw here did the opposite: it
          // aborted the preflight of every check in the phase, over debris a later round or a
          // later run would have cleared. The failure is evidence, not a reason to stop.
          await realClick(cx, `[${CLOSE}]`);
        } catch (e) {
          cleared.push({ kind: 'close-refused', why: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        } finally {
          await evaluate(
            cx,
            `(function () { var e = document.querySelector('[${CLOSE}]'); if (e) e.removeAttribute('${CLOSE}'); return 'cleared'; })()`
          );
        }
      }
    } else {
      // Tag then click the tagged element, so the click addresses exactly what the predicate chose -
      // the same rule `openConversation` learnt the hard way. The tag is always removed: a stray one
      // would be picked up by the next call, which is how a harness fix becomes a harness fault.
      await evaluate(
        cx,
        `(function () {
          var area = window.innerWidth * window.innerHeight;
          var b = [].slice.call(document.querySelectorAll('button')).filter(function (e) {
            var r = e.getBoundingClientRect();
            return r.width * r.height >= 0.8 * area;
          })[0];
          if (b) b.setAttribute('${TAG}', '1');
          return b ? 'tagged' : 'gone';
        })()`,
      );
      try {
        await realClick(cx, `[${TAG}]`);
      } finally {
        await evaluate(
          cx,
          `(function () { var e = document.querySelector('[${TAG}]'); if (e) e.removeAttribute('${TAG}'); return 'cleared'; })()`,
        );
      }
    }

    // Wait on the FACT that the count dropped, never on a duration: these panels animate out over
    // 180-220 ms and a fixed sleep would be either flaky or slower than every check that calls this.
    const before = found.length;
    await until(cx, `JSON.parse(${OVERLAYS}).length < ${before}`, 3000).catch(() => null);

    const after = await read();
    // NOT STUCK WHILE AN ESCALATION IS STILL OWED. Declaring it on the first failed Escape is what
    // let one unclosed modal block eleven checks: the verdict was reached before the repair that
    // would have worked had been tried.
    if (after.length >= before && !escalationLeft) {
      const stuck = found.map((o) => `${o.kind}${o.label ? `(${o.label})` : ''}`).join(', ');
      console.log(`[overlay] STUCK after ${round + 1} attempt(s): ${stuck} - left alone, not forced`);
      return cleared.concat(found.map((o) => ({ ...o, stuck: true })));
    }
    cleared.push(...found.filter((o) => !after.some((a) => a.kind === o.kind && a.label === o.label)));
  }
  return cleared;
}

/** Click the sidebar/list entry whose visible text contains `name`, and wait for the composer. */
/**
 * Puts the client on the Discussions list, by the in-app link when it is elsewhere.
 *
 * Checks must not start by reloading: a full load warms caches and finishes bootstraps that a real
 * user's click does not, and that difference is itself a bug this campaign has already found once.
 */
export async function ensureChat(cx) {
  // BEFORE the route test, not after: an overlay is what stops the clicks below from landing, and
  // the early return would otherwise hand back `already` for a screen nothing can be clicked on.
  await clearOverlays(cx);
  if ((await evaluate(cx, 'location.pathname')) === '/chat') return 'already';

  // LEAVE THE OPEN CONVERSATION FIRST, ON A PHONE. The mobile layout gives the whole screen to the
  // conversation, so the "Discussions" link is not on it and `realClick` dies with `no stable
  // element` - which reads as a broken app and is a layout. It cost MSG-8 and MSG-8b a whole run.
  //
  // Addressed by its ACCESSIBLE NAME rather than a class: that string is what a screen reader
  // announces, so it is the one part of this control that cannot change silently. Visibility is
  // tested, not merely presence - the desktop layout keeps the list beside the conversation and has
  // no such control on screen, and clicking a hidden one would navigate a browser out of its view.
  const BACK = '[aria-label="Retour au menu"]';
  const backVisible = `(function () {
    var b = document.querySelector('${BACK}');
    if (!b) return false;
    var r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`;
  if (await evaluate(cx, backVisible)) {
    await realClick(cx, BACK);
    await until(cx, `!document.querySelector('${COMPOSER}')`, 8000).catch(() => null);
  }

  await realClick(cx, 'text=Discussions');
  await until(cx, `location.pathname === '/chat'`, 15000);
  return 'navigated';
}

/**
 * Opens a DM by peer name, from a full load of `/chat`.
 *
 * THE REASON FOR THE FULL LOAD IS REFUTED, AND THE LOAD IS STILL HERE ON PURPOSE. It was written
 * when the DM rows showed "Utilisateur inconnu" after any client-side navigation (fixed in
 * `ace0596a`), so only a load resolved the names. Measured on the deployed build, 2026-08-16, both
 * journeys on both browsers: `unknown=0` immediately and throughout - W1 with 10 rows, W2 with 2,
 * client-side and full load alike. There is nothing left for the load to work around, and it costs a
 * gateway socket and ~2 s on every check that opens a DM.
 *
 * It is NOT dropped yet only because doing so changes the navigation shape of nearly every check,
 * and the phases owed right now are verifying an application fix. One variable at a time: drop it
 * once those re-runs are taken, then re-run them again against the new shape.
 *
 * Checks that care about the navigation itself must not use this.
 *
 * ON A1 IT IS ALREADY GONE. The phone reaches the list the way its user does, because a reload there
 * re-locks the PIN and breaks Tauri's in-flight IPC callbacks (see `goto`). That is the same removal
 * this comment defers for the browsers, taken early on the one client where the load is not merely
 * wasteful but harmful - and it leaves the browser checks' navigation shape untouched, so no
 * measurement taken on W1/W2 has to be re-baselined.
 */
export async function openDM(cx, name) {
  if (cx.port === PORTS.A1) {
    await ensureChat(cx);
    // THE TWO BRANCHES OWED THE SAME PRECONDITION AND ONLY ONE DELIVERED IT. `goto('/chat')` reloads,
    // so the desktop branch always arrives with the conversation LIST on screen. `ensureChat` cannot
    // reload - that re-locks the PIN - so on the phone an already-open conversation stays open, and
    // mobile gives it the whole screen: `openConversation` then hunts for a sidebar row in a sidebar
    // that is not rendered. MUT-18 died exactly there on 2026-08-22, reporting `listedEntries: 0` on
    // a device whose list has ten. Parking is a no-op when nothing is open, so this costs the phone
    // one evaluate and buys every A1 check the precondition the desktop path got for free.
    await parkConversation(cx);
  } else await goto(cx, '/chat');
  return openConversation(cx, name);
}

/**
 * Waits until the app has stopped MOVING - not until a duration has passed.
 *
 * THE STATE THIS NAMES. `MainChatPage` puts its status strips ("En attente de connexion",
 * "Synchronisation des messages...") IN THE LAYOUT FLOW, above `main`. Each one therefore shoves the
 * entire application down by its own height when it appears and lets it snap back when it goes -
 * 29 px, measured. A startup sync raises one at ~480 ms and drops it at ~2 286 ms, and every
 * `openChannel` meets that window because it navigates.
 *
 * WHY A CHECK MUST WAIT FOR IT. On 2026-08-14 a click aimed at the `general` row was received by the
 * "Ajouter un canal" button 29 px below it: the strip vanished between the hit test and the dispatch.
 * `stableCentreOf` cannot see that coming - it proves the point belonged to the element 120 ms ago,
 * and no amount of re-proving it removes a race against a layout that is still settling. So the
 * precondition is a STATE, read off the page: no status strip up, and `main` at the same offset for
 * three consecutive reads. That is what a human tester waits for without noticing they do.
 *
 * At rest this returns almost immediately - measured 481 samples over 30 s with zero transitions.
 */
export async function awaitAppSettled(cx, timeoutMs = 20000) {
  const READ = `(function () {
    var strip = null, all = document.querySelectorAll('div');
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (!(r.height > 0 && r.height < 60 && r.top < 120)) continue;
      var t = (all[i].innerText || '').trim();
      if (/^(Synchronisation|En attente)/.test(t)) { strip = t.replace(/\\s+/g, ' ').slice(0, 32); break; }
    }
    var m = document.querySelector('main');
    return JSON.stringify({ strip: strip, top: m ? Math.round(m.getBoundingClientRect().top) : null });
  })()`;

  const t0 = Date.now();
  let stable = 0;
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const now = await evaluate(cx, READ);
    const { strip } = JSON.parse(now);
    stable = !strip && now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 2) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 80));
  }
  // NOT AN ERROR. A page that keeps moving is a finding for the caller to carry into its own
  // failure, not a reason to abort here - and a check that clicks anyway will now SAY that it did.
  return null;
}

/**
 * Opens the campaign's channel: community "Campagne de test", channel `general`.
 *
 * THE FAILURE CARRIES THE SCREEN, because the bare timeout did not and cost a whole run to diagnose.
 * `until() timed out: !!document.querySelector('.chat-composer-editor')` says the composer never
 * came; it does not say that the click had opened the CREATE-CHANNEL modal instead, which is what
 * had happened on 2026-08-14 - and since the modal then swallowed every later click, four checks
 * accused an application that was working. A click is dispatched at COORDINATES, so what received it
 * is a fact the harness can read and must: `realClick` returns the point, and the hit test below
 * names the element that was actually under it.
 */
export async function openChannel(cx, community = 'Campagne de test', channel = 'general') {
  /** The screen, at the moment something did not happen. */
  const screen = async (point) =>
    JSON.parse(
      await evaluate(
        cx,
        `(function () {
          var at = ${point ? `document.elementFromPoint(${point.x}, ${point.y})` : 'null'};
          return JSON.stringify({
            // The FULL url, not just the pathname: a channel is selected in the query string, so
            // the bare path cannot say whether the click selected anything. NO BACKTICKS IN HERE -
            // this comment lives inside a template literal, and a quoted identifier would close it.
            url: location.pathname + location.search,
            dialogs: [].slice.call(document.querySelectorAll('[role=dialog][aria-modal=true]'))
              .map(function (d) { return d.getAttribute('aria-label') || '(unlabelled)'; }),
            hitAt: at ? (at.tagName + (at.innerText || '').trim().slice(0, 40)) : null,
            composer: !!document.querySelector('.chat-composer-footer .chat-composer-editor')
          });
        })()`
      )
    );

  // A1 reloads here, DECLARED rather than accidental: there is no click path to `/communities` from
  // an arbitrary screen on the phone the way `ensureChat` gives one to `/chat`, so this is the only
  // way in until one is written. It costs what `goto` documents - a PIN re-lock and, if a command is
  // in flight, a `runCallback` exception into the fresh document - so a phone verdict that goes dirty
  // on either of those inside a channel check is the RIG, not the app. Writing that click path is
  // what removes the last A1 reload from the campaign.
  await goto(cx, '/communities', { relaunch: 'no click path to /communities on the phone yet' });
  await awaitListed(cx, `!!${RESOLVE}('text=${community}')`, 20000, 'the community', cx.port);
  // SETTLE BEFORE EVERY CLICK, not once at the top: the community click itself starts work that can
  // raise a strip again, so the state has to be re-established rather than assumed to persist.
  const settledBefore = await awaitAppSettled(cx);
  await realClick(cx, `text=${community}`);
  await awaitListed(cx, `!!${RESOLVE}('text=${channel}')`, 15000, 'the channel', cx.port);
  const settledAfter = await awaitAppSettled(cx);
  const point = await realClick(cx, `text=${channel}`);

  // HIT-TEST NOW, NOT AT THE FAILURE. This used to read `elementFromPoint` only inside the catch -
  // fifteen seconds after the click - and then present the answer as `hitAtClick`, which it was not.
  // On 2026-08-14 that named the "Ajouter un canal" button as the thing clicked and sent a whole
  // diagnosis chasing a locator bug, when `stableCentreOf` had already pinned the row and hit-tested
  // the exact integer coordinates it was about to dispatch. A report must carry the evidence that
  // separates the causes it cannot itself distinguish: `atClick` says whether the click LANDED,
  // `atFailure` says what the page became while nothing happened. The two together tell a missed
  // click apart from a channel that opened and never rendered its composer.
  const atClick = await screen(point);

  // AND THE CLICK ITSELF, which is the only witness that separates the two causes above. `atClick`
  // once reported the create-channel modal covering the very coordinates `stableCentreOf` had just
  // cleared - a contradiction no reading of the page can resolve, because both readings describe a
  // moment the click did not happen. `realClick` now records what received it: if that is not the
  // channel row, the click MISSED, and no amount of waiting for a composer is going to say so.
  const received = point.received;
  const hitTheRow =
    received && `${received.text} ${received.label}`.toLowerCase().includes(channel.toLowerCase());

  // THE SELECTION, ASSERTED BEFORE THE COMPOSER - the discriminator, taken where the decision is.
  //
  // A composer that never appears has two causes with opposite fixes: the click was not HANDLED, or
  // it was handled and the chat area rendered nothing (`ChatArea` renders NOTHING - header, list and
  // composer - while its conversation is missing from the store). Waiting fifteen seconds for the
  // composer cannot tell them apart, and on 2026-08-15 it did not: TYPE-5 failed once in five passes
  // and the report could only say that a composer was absent.
  //
  // A channel selection changes NO url - `onSelectChannelConversation` is a state assignment - so
  // the address bar can never witness it. `aria-current` was added to the selected row for this (and
  // for the screen reader that had the same problem), which makes the two states separable from
  // outside the component. Not a gate on its own: it is recorded and read in the failure below.
  const selectedMs = await until(
    cx,
    `[].slice.call(document.querySelectorAll('button[aria-current]')).some(function (el) {
       return (el.innerText || '').toLowerCase().indexOf(${JSON.stringify(channel.toLowerCase())}) >= 0;
     })`,
    5000
  ).catch(() => null);

  try {
    if (received && !hitTheRow) throw new Error('click landed elsewhere');
    await until(cx, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 15000);
  } catch {
    const atFailure = await screen(point);
    throw new Error(
      `openChannel: no composer in ${community}/${channel} on port ${cx.port} - ${
        selectedMs === null
          ? 'and the row never became aria-current: the click was RECEIVED and not HANDLED'
          : `the row WAS selected after ${selectedMs}ms, so the chat area rendered nothing for a selected channel`
      } - ${JSON.stringify({
        clickedAt: { x: point.x, y: point.y },
        received,
        hitTheRow,
        selectedMs,
        // null means the app was STILL MOVING when it was clicked - the one condition under which a
        // verified coordinate can still deliver the click somewhere else.
        settledBefore,
        settledAfter,
        atClick,
        atFailure,
      })}`
    );
  }
  return `${community}/${channel}`;
}

/**
 * Waits for an entry to be LISTED, and says what the list held when it never was.
 *
 * `until(RESOLVE('text=X'))` rethrows its own source on timeout, which is forty lines of resolver
 * and no state at all. Four sightings on 2026-08-16 - MUT-13, MUT-19, and one each on MUT-7 and
 * MUT-8 - died that way, and none of them could be attributed: the same message covers a list that
 * never loaded, a list that loaded WITHOUT this entry, and an entry present under a label the
 * search cannot match. Those are one instrument fault and two application defects.
 *
 * `listedEntries` is the discriminator, and it names no one: ZERO is a fetch that did not land or a
 * surface that never mounted, while a populated list missing this one entry is a membership or a
 * labelling question. The rows themselves are never printed - this runs against a real account
 * whose sidebar carries real conversations, and `unknownLabelRows` covers the only row text worth
 * counting: a conversation rendered under the "Utilisateur inconnu" fallback exists but can never
 * match a search by name.
 *
 * Takes a PREDICATE rather than a selector because its two callers search differently -
 * `openChannel` by `RESOLVE('text=')`, `openConversation` by a sidebar-scoped shortest-match - and
 * a helper that fits only one of them is how the second caller keeps its bare timeout.
 */
export async function awaitListed(cx, predicate, timeoutMs, what, port) {
  try {
    return await until(cx, predicate, timeoutMs);
  } catch {
    const state = JSON.parse(
      await evaluate(
        cx,
        `JSON.stringify((function () {
          var panel = document.querySelector('.sidebar-panel');
          var scope = panel || document.body;
          var rows = [].slice.call(scope.querySelectorAll('button, [role=button], a, li')).filter(function (e) {
            return e.getBoundingClientRect().width > 0;
          });
          return {
            path: location.pathname + location.search,
            sidebarPanel: !!panel,
            listedEntries: rows.length,
            unknownLabelRows: rows.filter(function (e) {
              return (e.innerText || '').indexOf('Utilisateur inconnu') !== -1;
            }).length,
            bodyChars: (document.body.innerText || '').length,
          };
        })())`
      )
    );
    throw new Error(
      `${what} was never listed within ${timeoutMs}ms on port ${port} - ${JSON.stringify(state)}`
    );
  }
}

export async function openConversation(cx, name) {
  // SEARCH THE SIDEBAR, NEVER THE DOCUMENT.
  //
  // This used to look at every button/link on the page and take the shortest match. The peer's name
  // is not unique on that page: it labels their message rows, and - the case that actually broke
  // MSG-4 - the author link above a REPLY quote, whose innerText is EXACTLY the name and therefore
  // always shorter than the sidebar row's ("<name>\n<last message preview>"). So the shortest-match
  // rule preferred it, the click navigated to `/profile/<hash>`, and the next `until()` waited 15 s
  // for a composer on a profile page before dying. The check did not fail where the fault was.
  //
  // `.sidebar-panel` is a stable hook added to the conversation list for this (its `aria-label` is
  // localized prose, so it cannot be the selector). Scoping first also means the shortest-match rule
  // now only ever chooses BETWEEN CONVERSATION ROWS, which is what it was written for.
  const scope = `(document.querySelector('.sidebar-panel') || document.body)`;
  // The list is fetched, so it is EMPTY for the first few hundred ms after a navigation. Failing
  // on the first look would make every check that navigates flaky for a reason that is the
  // harness's, not the app's.
  const find = `(function () {
      var wanted = ${JSON.stringify(name)}.toLowerCase();
      var els = [].slice.call(${scope}.querySelectorAll('button, [role=button], a, li'));
      var best = els.filter(function (e) {
        var t = (e.innerText || '').trim();
        return t && t.toLowerCase().indexOf(wanted) !== -1 && e.getBoundingClientRect().width > 0;
      });
      best.sort(function (a, b) { return a.innerText.length - b.innerText.length; });
      if (!best.length) return null;
      best[0].scrollIntoView({ block: 'center' });
      return best[0].innerText.trim().slice(0, 60);
    })()`;
  // THE TIMEOUT HERE USED TO RETHROW THE PREDICATE, WHICH IS BOTH USELESS AND UNSAFE.
  //
  // Useless: `until() timed out: (function () { var wanted = ... })() !== null` says the row never
  // came and nothing about WHY - an empty list, a list that loaded without this row, or a row whose
  // label never resolved are three different findings and two of them are the application's. It
  // fired on MUT-19 and again on MUT-7 on 2026-08-16 and neither sighting could be attributed.
  //
  // Unsafe: `find` embeds the peer's display name, so the message carries a real person's name into
  // a run log. The rig is anonymised BY CONSTRUCTION - no check spells a name - but an error built
  // at runtime escapes that, and `idcheck.mjs` cannot see it because it guards the git index only.
  //
  // So the state is read instead, and it names no one: counts, not labels. The sidebar lists the
  // owner's REAL conversations, so dumping row text would leak far more than the peer's name.
  // `unknownLabelRows` is the discriminator that matters - a row rendered under the "Utilisateur
  // inconnu" fallback exists but can never match a search by name.
  await awaitListed(cx, `${find} !== null`, 20000, "the peer's conversation row", cx.port);
  const hit = await evaluate(cx, find);
  if (!hit) throw new Error(`no conversation entry matching the requested peer on port ${cx.port}`);

  // CLICK THE ELEMENT WE FOUND, not a description of it.
  //
  // This used to hand `realClick` a `text=<first line>` selector, so the element was located
  // TWICE by two different rules - and the second one is ambiguous by construction: a peer's name
  // appears in the DM row AND in the preview line of every group they were added to ("<peer> a
  // ajoute <owner> au groupe"). Eight elements matched on W2, `realClick` picked one that
  // failed its own hit test, and the check died with `no stable element` - after the reload only,
  // because until then the conversation was already open and nothing ever clicked.
  //
  // The found element is tagged instead, so the click addresses exactly what the search chose.
  // The attribute is removed afterwards: a stray marker left in the DOM would be picked up by the
  // NEXT call, which is how a harness fix becomes the next harness fault.
  const TAG = 'data-harness-open-conversation';
  await evaluate(cx, find.replace('return best[0].innerText.trim().slice(0, 60);', `best[0].setAttribute('${TAG}', '1'); return best[0].innerText.trim().slice(0, 60);`));
  try {
    await realClick(cx, `[${TAG}]`);
  } finally {
    await evaluate(cx, `(function () { var e = document.querySelector('[${TAG}]'); if (e) e.removeAttribute('${TAG}'); return 'cleared'; })()`);
  }
  // THE POST-CONDITION MUST SAY WHAT IT SAW, and this one said nothing for as long as it existed.
  //
  // `openChannel` above learnt this the hard way and got a sentence naming the port, the target and
  // whether the row ever became `aria-current`. This call site kept a bare `until`, so READ-9 died as
  // `until() timed out after 15000ms: !!document.querySelector('.chat-composer-footer ...')` - which
  // names neither the client, nor the conversation, nor which of three causes fired. One sentence for
  // three different fixes is rule 16's shape exactly, and it cost a run.
  //
  // IT WAITS FOR EITHER OUTCOME, and that is the substance rather than the wording. A conversation
  // the peer deleted renders a notice and "Supprimer localement" INSTEAD of a composer
  // (`ChatArea.svelte`, `lifecycle === 'removed'`), so waiting only for the composer is waiting for
  // something the product deliberately does not draw - the fault that cost READ-10 its verdict for a
  // fortnight, in `groupnav.mjs` this time. Waiting for "the pane rendered something" keeps the
  // deadline where it belongs, on the render, and lets the sentence below name the state.
  await until(cx, PANE_HAS_CONVERSATION, 15000).catch(() => null);
  const state = await evaluate(cx, PANE_STATE);
  if (state !== 'composer') {
    const openAs = await evaluate(cx, HEADER_NAME).catch(() => '(unreadable)');
    throw new Error(
      `openConversation: no composer for ${JSON.stringify(name)} on port ${cx.port} - ` +
        (state === 'removed'
          ? 'the pane IS showing a conversation, and it is one the peer DELETED - which draws a notice ' +
            'and "Supprimer localement" where the composer would be. That is the product working: a ' +
            'check that needs to type here has been handed a dead conversation.'
          : 'nothing is open at all - the click was received and not handled.') +
        ` header=${JSON.stringify(openAs)} clickedRow=${JSON.stringify(hit)}`
    );
  }
  return hit;
}

/**
 * What the OPEN conversation's header names. `''` when no conversation is open.
 *
 * The single source of truth for "which conversation am I looking at" - {@link SAMPLE} reads it too,
 * so the answer cannot drift between a sample and a precondition.
 */
export const HEADER_NAME = String.raw`(function () {
  var pane = ${PANE};
  var h = pane ? pane.querySelector('header') : null;
  return h ? h.innerText.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) : '';
})()`;

/**
 * Guarantees `name`'s conversation is the OPEN one, and PROVES it before returning.
 *
 * A COMPOSER ON SCREEN PROVES THAT SOME CONVERSATION IS OPEN, NEVER WHICH ONE. Several checks
 * inferred the second from the first - `msg8`/`msg8b` carried "A1 is already in the DM, so only open
 * it when the composer is absent". On 2026-08-13 A1 had been left in the campaign CHANNEL by an
 * earlier check, so the open composer satisfied that test, the DM was never opened, and three MSG-8
 * markers went to the channel while the receiver watched the DM. The check reported a delivery loss
 * that had not happened - the harness's own fault #29 wearing the costume of one.
 *
 * The header is the only thing that NAMES the open conversation, so it is what the precondition
 * tests, and it is re-read AFTER opening: a check may not proceed on an unverified assumption about
 * where its own traffic is going. Cheap, too - the common case is one CDP round trip and no click.
 */
export async function ensureConversation(cx, name) {
  const wanted = name.toLowerCase();
  const named = async () => (await evaluate(cx, HEADER_NAME)).toLowerCase();

  // The header is readable THROUGH a modal, so the `already` branch is precisely the one that would
  // certify a screen a check cannot then use. Clear first, and the precondition means what it says.
  await clearOverlays(cx);
  if ((await named()).includes(wanted)) return 'already';

  await ensureChat(cx);
  await openConversation(cx, name);

  const now = await named();
  if (!now.includes(wanted)) {
    throw new Error(`wrong conversation open: header says ${JSON.stringify(now)}, wanted ${name}`);
  }
  return 'opened';
}

/**
 * The campaign markers currently rendered, in DOM order.
 *
 * There is NO `data-message-id` in the rendered DOM, so a message cannot be identified by an
 * attribute. Every check therefore stamps its own unique marker into the text it sends, and
 * ordering, gaps and duplicates are all read back from that - which has the side benefit of
 * proving the text actually decrypted, not merely that a row appeared.
 */
export async function markers(cx, prefix) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((${PANE_TEXT}.match(new RegExp(${JSON.stringify(prefix)} + '-[0-9a-z]+', 'g')) || []))`,
  );
  return JSON.parse(raw);
}

/** Wait until a message whose text contains `marker` is rendered; returns the elapsed ms. */
export async function awaitMessage(cx, marker, timeoutMs = 20000) {
  try {
    return await until(cx, `${PANE_TEXT}.indexOf(${JSON.stringify(marker)}) !== -1`, timeoutMs, 50);
  } catch {
    // A BARE TIMEOUT NAMES ONLY THE EXPRESSION THAT FAILED, which is the one thing already known.
    // MUT-9 and MUT-12 both died on the channel in pass 3 of the 2026-08-16 run and neither said
    // whether the message was missing, late, or simply BELOW the render window - `ChatArea` keeps a
    // sliding window and a pane scrolled up genuinely does not render what arrives under it
    // (`hiddenBelowCount`). Those are three different defects, one of which is not a defect at all.
    throw new Error(
      `${marker} never appeared in ${timeoutMs}ms - ${JSON.stringify(await paneState(cx, marker))}`
    );
  }
}

/**
 * What the message pane looked like at the moment a miss was declared.
 *
 * `fromBottomPx` IS THE DISCRIMINATOR the earlier misses lacked: at 0 the pane is at the bottom and
 * an absent marker is a real absence, while a large value means the app is showing older messages
 * and is expected to render nothing new - a precondition the CHECK owes, not a delivery fault.
 * The scroller is found by taking the deepest-overflowing descendant rather than by class name, so
 * a styling change cannot silently turn this into `null`.
 */
export async function paneState(cx, marker) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var c = document.querySelector('${COMPOSER}');
      var pane = c ? c.closest('section') : null;
      if (!pane) return { hasPane: false };
      var ps = [].slice.call(pane.querySelectorAll('p'));
      var sc = null;
      [].slice.call(pane.querySelectorAll('*')).forEach(function (d) {
        var over = d.scrollHeight - d.clientHeight;
        if (over > 40 && (!sc || over > sc.scrollHeight - sc.clientHeight)) sc = d;
      });
      return {
        hasPane: true,
        renderedParagraphs: ps.length,
        inPane: pane.innerText.indexOf(${JSON.stringify(marker)}) !== -1,
        inBody: document.body.innerText.indexOf(${JSON.stringify(marker)}) !== -1,
        lastRendered: ps.slice(-3).map(function (e) { return (e.textContent || '').slice(0, 40); }),
        scroll: sc
          ? {
              fromBottomPx: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop),
              heightPx: sc.scrollHeight,
              viewPx: sc.clientHeight
            }
          : null
      };
    })())`
  ).catch(() => null);
  return raw && raw !== 'null' ? JSON.parse(raw) : { unreadable: true };
}

/** How many times `marker` appears in the open conversation - the duplicate check. */
export function countMessage(cx, marker) {
  return evaluate(cx, `${PANE_TEXT}.split(${JSON.stringify(marker)}).length - 1`);
}

/**
 * ONE sample of the receiver: the marker's count PLUS the facts that say what a zero means.
 *
 * A bare count cannot be interpreted. Zero has three readings and they need different fixes:
 * the PANE is gone (composer unmounted, `PANE_TEXT` degrades to '' and every count reads 0), the
 * MESSAGE is gone, or the harness is looking at the wrong conversation. So every sample carries the
 * composer's presence, the pane's size, the WHOLE BODY's count and which conversation the header
 * names - a marker in the body but not in the pane is the sidebar preview of a conversation nobody
 * opened, a harness fault wearing the costume of a delivery loss (fault #29, 2026-08-12).
 */
export const SAMPLE = (marker) => `(function () {
  var c = document.querySelector('${COMPOSER}');
  var pane = c ? c.closest('section') : null;
  var text = pane ? pane.innerText : '';
  var draft = c ? (c.innerText || '').trim() : '';
  var net = draft ? text.split(draft).join('') : text;
  return JSON.stringify({
    composer: !!c,
    paneChars: text.length,
    netChars: net.length,
    draftChars: draft.length,
    count: net.split(${JSON.stringify(marker)}).length - 1,
    bodyCount: (document.body.innerText || '').split(${JSON.stringify(marker)}).length - 1,
    header: ${HEADER_NAME}
  });
})()`;

/** Take a single {@link SAMPLE}. */
export async function sample(cx, marker) {
  return JSON.parse(await evaluate(cx, SAMPLE(marker)));
}

/**
 * Watch a delivery CONTINUOUSLY instead of reading it twice.
 *
 * TWO READINGS CANNOT CLASSIFY WHAT THEY FIND. MSG-1 returned `latencyMs: 987` and
 * `copiesOnReceiver: 0` in the same record (2026-08-12): both readings were honest, and between
 * them the message had been rendered and then dropped. A check that can fail BY DISAPPEARANCE has
 * to sample across the whole window, so use this - not `awaitMessage` + `countMessage` - wherever
 * the message's absence is the thing being measured.
 *
 * Stops early once the marker has been seen and has then held still for `settleMs`, so the common
 * case stays fast; a message that never arrives costs the full `timeoutMs`.
 */
export async function traceArrival(cx, marker, { timeoutMs = 15000, everyMs = 250, settleMs = 3000 } = {}) {
  const t0 = Date.now();
  const samples = [];
  let firstSeen = null;
  let lost = null;
  let regained = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await sample(cx, marker);
    const at = Date.now() - t0;
    samples.push({ at, ...s });
    if (s.count > 0 && firstSeen === null) firstSeen = at;
    if (firstSeen !== null && s.count === 0 && lost === null) lost = at;
    if (lost !== null && s.count > 0 && regained === null) regained = at;
    // A stable sighting ends the trace, but ONLY if nothing has disappeared yet: once it has, the
    // whole remaining window is evidence about whether it comes back on its own.
    if (firstSeen !== null && lost === null && at - firstSeen >= settleMs) break;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { firstSeen, lost, regained, samples, last: samples[samples.length - 1] ?? null, elapsedMs: Date.now() - t0 };
}

/**
 * When the marker is NOT on screen at the end of a trace, name the mechanism.
 *
 * Three causes produce the same empty pane and need completely different fixes, so the two cheapest
 * discriminators run in order:
 *
 *   - back after SCROLLING to the bottom -> the row was merely unmounted by the virtualised list;
 *     the data is intact and it is a scroll-anchor defect;
 *   - back only after REOPENING -> the in-memory list was overwritten by a page fetched before the
 *     message existed, and the store had it all along - a stale-response overwrite (the WP fixed in
 *     `dabed2f2`);
 *   - back after neither -> it never reached the store, which is a real delivery loss.
 *
 * `reopen` is passed in rather than assumed because only the caller knows which conversation is
 * under test.
 */
export async function classifyDisappearance(cx, marker, reopen) {
  await evaluate(
    cx,
    `(function () {
      var c = document.querySelector('${COMPOSER}');
      var pane = c ? c.closest('section') : null;
      var sc = pane ? [].slice.call(pane.querySelectorAll('*')).filter(function (e) { return e.scrollHeight > e.clientHeight + 50; }) : [];
      sc.forEach(function (e) { e.scrollTop = e.scrollHeight; });
      return sc.length;
    })()`,
  );
  await new Promise((r) => setTimeout(r, 2500));
  const scrolled = await sample(cx, marker);
  if (scrolled.count > 0) return { verdict: 'SCROLL ANCHOR', scrolled, reopened: null };

  await reopen();
  await new Promise((r) => setTimeout(r, 8000));
  const reopened = await sample(cx, marker);
  return {
    verdict: reopened.count > 0 ? 'STALE OVERWRITE' : 'NOT IN THE STORE EITHER',
    scrolled,
    reopened,
  };
}

/**
 * Put `text` in the composer and wait until the send control is live - everything but the send.
 *
 * SPLIT OUT SO A CHECK CAN AIM AT A WINDOW IT DOES NOT CONTROL. The WP-ECHO-1 window is the app's
 * own bulk-ingest phase, which lasts anywhere from 40 ms to 3.5 s on this device, so a send driven
 * by `sleep` misses it every time - measured: seven own sends, zero inside a window. Arming first
 * leaves exactly one CDP round trip (`fireComposer`) between the decision and the submit, which is
 * short enough to land inside a window observed in the LOG rather than guessed at.
 */
export async function armComposer(cx, text) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  // ARM ON AN EMPTY BOX, ALWAYS. `Input.insertText` inserts at the caret, so arming over a draft
  // the previous attempt failed to submit produces ONE message carrying BOTH markers - which a
  // marker count then reads as two deliveries. Seen 2026-08-11: eleven sends, twelve markers on
  // screen, and the surplus was the app faithfully delivering what the harness had typed.
  // `selectAll` + insertText replaces the selection, and Svelte sees the resulting input event.
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text });
  const typed = await evaluate(cx, `document.querySelector('${COMPOSER}').innerText.trim()`);
  if (!typed.includes(text.slice(0, 20))) throw new Error(`composer did not take the text (has ${JSON.stringify(typed)})`);
  // The send button is DISABLED while the composer is empty and Svelte re-enables it a tick after
  // the input event, so clicking straight after `Input.insertText` lands on a disabled control and
  // is discarded in silence. On the desktop clients the extra CDP round trips hid the race; on the
  // phone's WebView it lost MSG-8b outright and the draft stayed in the box. Wait for the state,
  // never for a delay.
  await until(cx, SEND_ENABLED, 5000, 50);
}

/** The composer chip a picked mention becomes - `mentionEditor.ts` `MENTION_CHIP_SELECTOR`. */
export const MENTION_CHIP = '[data-mention-id].mention-editor-chip';

/**
 * The suggestion dropdown. No role or data hook exists on it, so the first match IS the top
 * suggestion: `MentionDropdown` renders the server's order with no re-sort.
 */
export const MENTION_SUGGESTION = '.mention-composer ul button';

/**
 * Clears the composer, types `@<query>`, waits for the dropdown, clicks the TOP suggestion, and
 * returns the resulting chip's `data-mention-id` - the ground truth for anything asserting WHO was
 * mentioned.
 *
 * SHARED because two phases need the same gesture for two different questions: MENTION asks what
 * the SENDER puts on the wire (`mentionedUserIds`, the one documented cleartext field), COMM-14 asks
 * what the SERVER does with it. A second copy would be a second place for the chip selector and the
 * dropdown's ordering assumption to drift.
 *
 * `query` must be specific enough that the intended person is the first hit. Against a two-account
 * test environment a first name is - which is the harness's guarantee, not the app's.
 */
export async function mentionInComposer(cx, query) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text: '' }); // clear any leftover draft before arming
  await cx.send('Input.insertText', { text: `@${query}` });
  await until(cx, `!!document.querySelector('${MENTION_SUGGESTION}')`, 6000);
  await realClick(cx, MENTION_SUGGESTION);
  await until(cx, `!!document.querySelector('${MENTION_CHIP}')`, 4000);
  return evaluate(
    cx,
    `(function () {
      var chip = document.querySelector('${MENTION_CHIP}');
      return chip ? chip.dataset.mentionId : null;
    })()`
  );
}

/**
 * Submit whatever {@link armComposer} left in the box. Returns the client-side timestamp.
 *
 * Separate from arming so that the only work between "the window opened" and "the message is
 * submitted" is this call.
 */
export async function fireComposer(cx) {
  // ACTIVATE, NOT TAP, and only because coordinates are unusable here - see the rule in
  // `activate`. Focusing the composer opens the soft keyboard, which on Android shrinks the VISUAL
  // viewport (914 -> 572) while the LAYOUT viewport stays 914. The composer bar is pinned above
  // the keyboard, so `getBoundingClientRect` reports the send button at y=511 - correct for the
  // page - while `Input.dispatchTouchEvent` addresses the layout viewport, and the tap lands on
  // <html>. Measured 2026-08-06: coordinates re-read and stable, hit-test clean, touchstart and
  // touchend delivered, target <html>, no click, draft still in the box. `.click()` sends every
  // time. The app is not at fault and the mobile tap path is verified separately, on device.
  const at = Date.now();
  await activate(cx, 'text=Envoyer le message');

  // POST-CONDITION, not a nicety: the click can land and the composer keep its text - on MSG-8b
  // the phone's send button did nothing, the draft stayed put, and the check read the DRAFT as a
  // delivered message and reported an app-level loss. An action that cannot prove it happened
  // must fail here, where the cause is still on screen, not three assertions later.
  const emptied = await until(cx, `!document.querySelector('${COMPOSER}').innerText.trim()`, 5000, 100).catch(
    () => null
  );
  if (emptied === null) {
    const left = await evaluate(cx, `document.querySelector('${COMPOSER}').innerText.trim()`);
    throw new Error(`send did not submit - composer still holds ${JSON.stringify(left.slice(0, 80))}`);
  }
  return at;
}

/**
 * Type into the composer and send.
 *
 * The composer is a contenteditable (`mention-composer-editor`), so the value cannot be assigned:
 * Svelte never sees it. Focus with a real click, then Input.insertText, then activate the send
 * button. Returns the client-side timestamp of the send.
 */
export async function send(cx, text) {
  await armComposer(cx, text);
  return fireComposer(cx);
}

/**
 * Message bubbles are `<p>` leaves inside the pane; this is their viewport centre.
 *
 * THE MISS CARRIES ITS OWN EVIDENCE, because `no bubble matching <marker>` did not survive contact
 * with a real failure. MUT-11/dm and MUT-12/dm died on that sentence in the first MUT run, having
 * already confirmed the message ARRIVED ON THE PEER - so the sender was missing a message it had
 * just sent and the words gave a reader nothing to act on. A probe run minutes later found the
 * bubble (`hits: 1`), which is the worst outcome: a fault that does not reproduce and left no trace.
 *
 * The three states it could not tell apart are the three that matter, and each wants a different
 * fix: the pane was never found (a layout change, and every check breaks); the text is in the pane
 * but not in a `<p>` (a markup change, and only this lookup breaks); or it is nowhere, which is the
 * only one that accuses the application. The rendered window is reported with it - the DM holds 5474
 * messages and the pane renders about 60, so "not rendered yet" is a real and expected state that
 * says nothing about delivery.
 *
 * `textMatch` MAY INSTEAD BE '#msg-<messageId>', and for a message whose text is about to change it
 * must be: an edit rewrites the body and a delete replaces it with a tombstone, after which the
 * text this was called with locates nothing - not because the message left, but because it stopped
 * being called that. The id is `MessageBubble.svelte`'s own, on the row wrapper itself.
 */
export async function bubbleCentre(cx, textMatch) {
  const p = await evaluate(
    cx,
    `JSON.stringify((function () {
      var editor = document.querySelector('${'.chat-composer-footer .chat-composer-editor'}');
      var pane = editor && editor.closest('section');
      if (!pane) return { miss: true, hasEditor: !!editor, hasPane: false };
      var byId = ${JSON.stringify(textMatch)}.charAt(0) === '#'
        ? document.getElementById(${JSON.stringify(textMatch)}.slice(1)) : null;
      if (${JSON.stringify(textMatch)}.charAt(0) === '#') {
        if (!byId || !pane.contains(byId)) return {
          miss: true, hasEditor: true, hasPane: true, byId: !!byId,
          renderedParagraphs: pane.querySelectorAll('p').length,
          note: byId ? 'that row exists but is outside the message pane' : 'no element carries that id'
        };
        byId.scrollIntoView({ block: 'center' });
        var br = byId.getBoundingClientRect();
        return {
          x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2),
          text: (byId.textContent || '').slice(0, 50)
        };
      }
      var ps = [].slice.call(pane.querySelectorAll('p'));
      var hits = ps.filter(function (e) {
        return (e.textContent || '').indexOf(${JSON.stringify(textMatch)}) !== -1;
      });
      if (!hits.length) return {
        miss: true,
        hasEditor: true,
        hasPane: true,
        renderedParagraphs: ps.length,
        inPaneText: pane.innerText.indexOf(${JSON.stringify(textMatch)}) !== -1,
        inBodyText: document.body.innerText.indexOf(${JSON.stringify(textMatch)}) !== -1,
        lastRendered: ps.slice(-4).map(function (e) { return (e.textContent || '').slice(0, 40); }),
        overlays: JSON.parse(${OVERLAYS}).length
      };
      var el = hits[hits.length - 1];
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.slice(0, 50) };
    })())`,
  );
  const seen = p && p !== 'null' ? JSON.parse(p) : { miss: true, unreadable: true };
  if (seen.miss) {
    const why = !seen.hasPane
      ? 'the composer/pane could not be located at all - this is a layout change, not a missing message'
      : seen.note
        ? seen.note
        : seen.inPaneText
        ? 'the text IS in the pane but not inside any <p> - the bubble markup changed'
        : seen.inBodyText
          ? 'the text is on the page but outside the message pane - wrong conversation open?'
          : `absent from the page; the pane has ${seen.renderedParagraphs} rendered paragraph(s)`;
    // The scroll position decides between "not delivered" and "delivered below the render window",
    // and it is read HERE rather than left to whoever reads the log a day later.
    const where = await paneState(cx, textMatch);
    throw new Error(
      `no bubble matching ${textMatch} - ${why} - ${JSON.stringify(seen)} - pane ${JSON.stringify(where.scroll)}`
    );
  }
  return seen;
}

/** Hovers a bubble so its action row appears, and returns what became clickable. */
export async function hoverBubble(cx, textMatch) {
  const c = await bubbleCentre(cx, textMatch);
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 400));
  return c;
}

/**
 * Is a second client reachable, and is it really the SAME account as `refCx`?
 *
 * READ-2 and READ-9 were hardcoded `SKIPPED` with the reason "A1 is unreachable this session
 * (dropped off USB)" - a claim about the environment that was true when it was typed and asserted,
 * never checked, on every run afterwards. Two checks were then skipped for a condition that had
 * stopped holding, which is rule 7 pointing the other way: a precondition may not be ASSUMED
 * ABSENT any more than it may be assumed present.
 *
 * The account identity matters as much as the reachability. Any check about "a second device of the
 * SAME user" is vacuous against a phone logged into the other account, while still connecting
 * perfectly. The user id is read from the page's own send-ledger key on both sides and compared
 * here - never printed, never passed as an argument.
 *
 * It takes the port and the target match rather than reading them from `names.mjs`, so this module
 * stays free of the campaign's identities: `chat.mjs` spells no name and no device.
 *
 * @returns {{ok: true, cx}} or {{ok: false, why: string}} - `why` is the SKIP's reason, verbatim.
 */
export async function sameAccountAs(refCx, otherPort, otherMatch, opts = {}) {
  const UID = `(function () {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('mls_send_ledger_') === 0) return k.slice('mls_send_ledger_'.length);
    }
    return '';
  })()`;
  try {
    const cx = await client(otherPort, otherMatch, opts);
    const [mine, theirs] = [await evaluate(refCx, UID), await evaluate(cx, UID)];
    if (!mine || !theirs) {
      cx.close();
      return { ok: false, why: 'could not read a user id from one of the two clients' };
    }
    if (mine !== theirs) {
      cx.close();
      return {
        ok: false,
        why: 'the second client is logged into a DIFFERENT account, so it is not a second device of this user',
      };
    }
    return { ok: true, cx };
  } catch (e) {
    return { ok: false, why: `second client not reachable: ${String(e).slice(0, 120)}` };
  }
}

/**
 * The mobile action sheet's own stable hook - `MessageMobileActions.svelte`'s only element carrying
 * it, and nothing else in the app does (`app.css` styles it, that is all). Deliberately not a
 * localised label and not a Tailwind class: both have changed under this harness before.
 */
export const MOBILE_SHEET = '[data-keyboard-aware-actions]';

/** Whether the mobile action sheet is up ANYWHERE - it is a single overlay, never one per row. */
export const MOBILE_SHEET_OPEN = `!!document.querySelector('${'[data-keyboard-aware-actions]'}')`;

/**
 * Opens the MOBILE action sheet on a bubble, using the gesture that really opens it.
 *
 * THE PHONE HAS NO HOVER TOOLBAR, which is the whole reason MUT-18 sat SKIPPED: every control this
 * harness resolves goes through the desktop action row, and the phone raises `MessageMobileActions`
 * instead - a `fixed`, `md:hidden` overlay gated on the bubble's own `isMobile` prop. So this is
 * A1-only by construction; a browser will never show the sheet however long it is pressed.
 *
 * IT IS A REAL TOUCH, NOT A SYNTHETIC `contextmenu`. The bubble does handle `contextmenu` and
 * dispatching one would be three lines shorter - and would still pass with the long-press timer
 * deleted, which is the one thing this gesture exists to exercise. Same rule as `clickAtPoint`: a
 * dispatch is not an activation.
 *
 * The hold is 700 ms against `MessageBubble.svelte`'s 420 ms threshold. The margin covers the round
 * trip, not luck - the post-condition is what decides, and it names the threshold it missed.
 */
export async function longPressBubble(cx, textMatch, holdMs = 700) {
  const c = await bubbleCentre(cx, textMatch);
  await cx.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: c.x, y: c.y, id: 1 }],
  });
  await new Promise((r) => setTimeout(r, holdMs));
  // The finger must not MOVE: `handleSwipeReply` cancels the long press once the gesture turns
  // horizontal, so there is deliberately no touchMove between the two events here.
  await cx.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const opened = await until(cx, MOBILE_SHEET_OPEN, 3000, 100).catch(() => null);
  if (opened === null) {
    throw new Error(
      `the long press on ${textMatch} did not open the mobile action sheet - held ${holdMs}ms against a 420ms threshold`
    );
  }
  return c;
}

/**
 * Taps a control in the OPEN mobile action sheet, by its lucide icon class, and says what took it.
 *
 * The sheet is one overlay for the whole page, so - unlike every desktop helper here - there is no
 * row to scope to and none is needed: only one bubble can have raised it. Each item is gated
 * individually (`!isDeleted`, `isOwn`, `canModerate`...), so an absent control is a real answer and
 * is reported as one, with the icons that ARE offered.
 */
export async function tapSheetIcon(cx, iconClass) {
  const p = await stablePoint(
    cx,
    `JSON.stringify((function () {
      var sheet = document.querySelector('${'[data-keyboard-aware-actions]'}');
      if (!sheet) return { blocked: 'the mobile action sheet is not open' };
      var svg = sheet.querySelector('svg.${iconClass}');
      var btn = svg ? svg.closest('button') : null;
      if (!btn) {
        var offered = [].map.call(sheet.querySelectorAll('svg'), function (s) {
          return String(s.getAttribute('class') || '').split(' ').filter(function (c) {
            return c.indexOf('lucide-') === 0;
          })[0] || '?';
        });
        return { blocked: 'the sheet offers no .${iconClass} - it offers [' + offered.join(' ') + ']' };
      }
      var r = btn.getBoundingClientRect();
      if (r.width === 0) return { blocked: 'the .${iconClass} item has no box' };
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !btn.contains(hit)) {
        return { blocked: 'the .${iconClass} item is not on top at its own centre' + (hit ? ' (' + hit.tagName + ' is)' : ' (nothing is there)') };
      }
      return { x: x, y: y, moving: ${IS_MOVING_FN}(btn) };
    })())`
  );
  // THE SHEET SLIDES UP FROM THE BOTTOM, so this helper read the one geometry in the rig that is
  // guaranteed to be wrong when read early - and it read it exactly once, with no retry at all. Its
  // three "blocked" answers (sheet not open / item absent / item covered) are the same sheet at
  // three moments of that slide, so they are polled together and only the timeout is a failure.
  if (p.timedOut) {
    throw new Error(
      `no settled .${iconClass} item in the mobile action sheet within 4s - last read: ${JSON.stringify(p.last)}`
    );
  }
  const { received } = await clickAtPoint(cx, p.x, p.y);
  if (!received) {
    throw new Error(`the .${iconClass} tap at ${p.x},${p.y} was dispatched and nothing received it`);
  }
  return { ...p, received };
}

/**
 * Clicks an action (Répondre, Transférer, Supprimer...) ON A GIVEN MESSAGE.
 *
 * NEVER use a bare `text=Répondre` for this. Every message row carries the whole action row in the
 * DOM, hidden until hover, so a document-wide selector resolves to the FIRST one - it silently
 * replies to the oldest message in the history and the check still looks like it worked. Found
 * exactly that way on the first run of MSG-3. The button must be searched inside the bubble's own
 * row, and the row is the nearest ancestor that actually contains one.
 */
export async function clickBubbleAction(cx, textMatch, label, timeoutMs = 5000) {
  await hoverBubble(cx, textMatch);
  // THE ACTION ROW FADES IN, so reading it once races the hover and the read usually loses. Every
  // caller had compensated with `sleep(800)` of its own, which is the same guess repeated three
  // times and charged to every run whether or not it was needed. Retrying the lookup here fixes it
  // for all of them and returns on the first successful read - typically the first or second.
  const locate = () => evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = document.querySelector('${'.chat-composer-footer .chat-composer-editor'}').closest('section');
      var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
        return (e.textContent || '').indexOf(${JSON.stringify(textMatch)}) !== -1;
      });
      if (!hits.length) return null;
      var node = hits[hits.length - 1];
      for (var i = 0; i < 8 && node.parentElement; i++) {
        node = node.parentElement;
        var btn = [].filter.call(node.querySelectorAll('button'), function (b) {
          return (b.getAttribute('aria-label') || b.innerText || '').trim().indexOf(${JSON.stringify(label)}) === 0;
        })[0];
        if (btn) {
          var r = btn.getBoundingClientRect();
          if (r.width === 0) return { blocked: 'action button has no box - not hovered?' };
          // MEASURED AND HIT-TESTED IN THE SAME EVALUATION, so no window exists between the two.
          // Testing it from the driver instead leaves one round trip in which the row can
          // un-render - which is exactly the failure this defends against, so a check placed there
          // reports the miss it was supposed to prevent.
          var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          var hit = document.elementFromPoint(x, y);
          if (!hit || !btn.contains(hit)) return { blocked: 'the action row is not on top at its own centre' + (hit ? ' (' + hit.tagName + ' is)' : ' (nothing is there)') };
          if (${IS_MOVING_FN}(btn)) return { blocked: 'the action row is still animating in' };
          return { x: x, y: y, label: (btn.getAttribute('aria-label') || btn.innerText).trim() };
        }
      }
      return null;
    })())`,
  );

  // THE CLICK IS PART OF THE ATTEMPT, NOT SOMETHING THAT HAPPENS AFTER IT SUCCEEDS. Locating and
  // clicking used to be two phases: a retry loop that found the button, then a single dispatch. But
  // the row can un-render between the two - the pane scrolls a newly arrived message into view and
  // the hover is lost - so the dispatch went to whatever had slid underneath, silently, and the run
  // failed 15 s later on a dialog that never opened. Nothing could then say whether the HARNESS had
  // missed the button or the APP had failed to open it, and FWD lost passes to that ambiguity on
  // 2026-08-15 reading as an application bug each time.
  //
  // Folding the click into the loop is what removes it: a miss is one failed attempt among several,
  // like a rect that has not settled, and only an exhausted budget is an error. `stableCentreOf`
  // reached the same shape for `realClick` for the same reason.
  const t0 = Date.now();
  let why = `no "${label}" action on the row of ${textMatch}`;
  while (Date.now() - t0 < timeoutMs) {
    const point = await locate();
    const p = point && point !== 'null' ? JSON.parse(point) : null;

    if (p && !p.blocked) {
      const { received } = await clickAtPoint(cx, p.x, p.y);
      // `received.btn` NAMES THE CONTROL THAT TOOK THE EVENT, which is the only witness that the
      // click was delivered where it was aimed: the hit test above proves only where it was sent.
      if (received?.btn?.indexOf(label) === 0) return { ...p, received };
      // A click TAKEN BY SOMETHING ELSE is not retried. Whatever it hit has already run, and firing
      // a second one compounds the side effect instead of recovering from it - so it stops here and
      // says what it hit. Only a click that nothing received is safe to attempt again.
      if (received) {
        throw new Error(
          `the "${label}" click was taken by "${received.btn || received.tag}" - the row moved under it after ${Date.now() - t0}ms`
        );
      }
      why = 'the click was dispatched and nothing received it';
    } else {
      why = p ? p.blocked : `no "${label}" action on the row of ${textMatch}`;
    }

    await new Promise((r) => setTimeout(r, 100));
    // Re-hover as well: a row can lose the pointer when the pane scrolls a new message into view,
    // and then no amount of re-reading will ever find an action that is no longer rendered.
    await hoverBubble(cx, textMatch).catch(() => null);
  }
  throw new Error(`could not click "${label}" on the row of ${textMatch} after ${Date.now() - t0}ms: ${why}`);
}

/**
 * Stages a real file on the composer's hidden `<input type=file>`, over the DOM domain.
 *
 * The picker is an OS dialog no driver can answer, so the file is handed straight to the input -
 * which is also what the browser does after a pick, so the app's own code path is unchanged. The
 * input is `hidden` and `offsetParent === null`; that is irrelevant to `DOM.setFileInputFiles`,
 * and deliberately NOT worked around by clicking "Joindre un fichier" first, which would open the
 * dialog and hang the run.
 *
 * @param {string[]} files absolute paths
 */
export async function attachFiles(cx, files) {
  await cx.send('DOM.enable');
  const { root } = await cx.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cx.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  });
  if (!nodeId) throw new Error('no file input in the composer');
  await cx.send('DOM.setFileInputFiles', { nodeId, files });
  return files.length;
}

export { IS_MOVING_FN, activate, clickAtPoint, dragTo, evaluate, pressKey, realClick, stablePoint, until };

/**
 * One authenticated request, made from a client's OWN page, as that client's account.
 *
 * WHY IT CANNOT BE A PLAIN `fetch(..., { credentials: 'include' })`. Canari keeps the access token
 * in memory and NEVER in `localStorage`; the only thing a cookie carries is the HttpOnly refresh
 * token. So a bare credentialed fetch is unauthenticated and answers **401** - which is not an
 * answer to any question a check is asking. A check that reads 401 as "you may not read this" would
 * report a perfect access rule for an endpoint that had never looked at the account, and would go on
 * reporting it after the rule was deleted.
 *
 * So this does exactly what the app does: `POST /api/auth/refresh` with the cookie to mint an access
 * token, then the real request with `Authorization: Bearer`. The refresh ROTATES the cookie, which
 * is harmless here because it rotates inside the very browser context the app is running in - the
 * app's next refresh picks up the new value like any other.
 *
 * @param method the verb; a body is sent as JSON and omitted entirely when there is none
 * @returns `{ status, body }` - `status` null ONLY on a transport failure, which is not an answer
 *   either and is reported as itself rather than folded into a status.
 */
async function apiCall(cx, method, path, body) {
  const base = await origin(cx);
  const raw = await evaluate(
    cx,
    `(async function () {
       try {
         var r = await fetch(${JSON.stringify(`${base}/api/auth/refresh`)}, { method: 'POST', credentials: 'include' });
         if (!r.ok) return JSON.stringify({ status: null, threw: 'refresh answered ' + r.status });
         var token = (await r.json()).access_token;
         var init = { method: ${JSON.stringify(method)}, headers: { Authorization: 'Bearer ' + token } };
         var payload = ${JSON.stringify(body === undefined ? null : JSON.stringify(body))};
         if (payload !== null) {
           init.headers['Content-Type'] = 'application/json';
           init.body = payload;
         }
         var g = await fetch(${JSON.stringify(base)} + ${JSON.stringify(path)}, init);
         var text = await g.text();
         return JSON.stringify({ status: g.status, body: text.slice(0, 400) });
       } catch (e) {
         return JSON.stringify({ status: null, threw: String(e) });
       }
     })()`,
    { awaitPromise: true }
  );
  return JSON.parse(raw);
}

/** One authenticated GET - see {@link apiCall}. */
export async function apiGet(cx, path) {
  return apiCall(cx, 'GET', path);
}

/**
 * One authenticated POST - see {@link apiCall}.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT. A check uses this to ask the SERVER a question the screen
 * cannot answer: whether a refusal is really the server's. It is not a way to make the product do
 * something without the product - a state a check reaches by POSTing is a state no user can reach,
 * and everything measured after it describes a system nobody runs.
 */
export async function apiPost(cx, path, body) {
  return apiCall(cx, 'POST', path, body ?? {});
}

/**
 * Answers the "Connexion rapide" offer with PLUS TARD, on a client that has just enrolled.
 *
 * WHY THE RIG MUST DECLINE IT, AND WHY THAT IS NOT A PREFERENCE. The modal's own words are
 * "Deverrouillez Canari avec la biometrie au lieu de saisir votre code. Votre PIN sera efface de cet
 * appareil." Accepting it removes the ONE credential this harness can present: `pin.mjs` types
 * digits over CDP, and nothing here can offer a fingerprint. So "Activer" would end every `+A1` row
 * permanently, and the modal appears on EVERY fresh enrolment - which the HEAL rung performs
 * repeatedly, by design.
 *
 * NOT LEFT TO `clearOverlays`. That function is safe here - it presses Escape, then only an
 * icon-only button, so it can never reach a captioned control - but "safe" is not "correct": Escape
 * on a dismissible offer is an unanswered question, and an unanswered question comes back. "Plus
 * tard" is the answer, so this is explicit and the screen stays clear afterwards.
 *
 * MATCHED BY CAPTION, and that is a known limitation, not an oversight. The dialog carries no
 * structural hook, and its label is a Paraglide string - so this reads French, like `login.mjs`'s
 * `text=Se connecter` and `pin.mjs`'s "Saisie manuelle" before it. Every campaign client is `fr`.
 *
 * Idempotent: a client not being offered anything costs one round trip and reports `none`.
 *
 * @param {object} cx an attached CDP client
 * @returns {Promise<'declined' | 'none' | 'no button'>}
 */
export async function declineBiometricOffer(cx) {
  const OFFERED = `[].some.call(document.querySelectorAll('[role=dialog][aria-modal=true]'), function (e) {
    return (e.getAttribute('aria-label') || '').indexOf('Connexion rapide') !== -1;
  })`;
  if (!(await evaluate(cx, OFFERED))) return 'none';
  // Through realClick, like every other click on this app: it proves the control is on screen and
  // settled, where a bare `.click()` would report success against a button mid-transition.
  await realClick(cx, 'text=Plus tard');
  return (await evaluate(cx, OFFERED)) ? 'still up' : 'declined';
}
