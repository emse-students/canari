/**
 * TAB-7 - offline, then act, then online, with the tab NEVER reloaded.
 *
 * Every other offline check in this rig reloads somewhere: `armCut` reloads to install its patch,
 * the preflight reloads a stale client, and most runners open a conversation by navigating. That is
 * convenient and it hides the state this row is about. A reload rebuilds the app from storage and
 * the server, so it cannot fail to recover: anything the live page was holding - a queued send, a
 * subscription, a socket the app must notice is dead - is thrown away and re-derived. What TAB-7
 * asserts is that the SAME DOCUMENT survives the round trip, which is what a real user's tab does.
 *
 * SO "NEVER RELOADED" IS ITSELF ASSERTED, not assumed. A beacon is planted on `window` after the
 * arming reload and read again at the end; a reload wipes it. If it is gone the run is VACUOUS, not
 * FAIL - the check did not test what its name says, and calling that an application defect would be
 * a lie in the more expensive direction.
 *
 * WHAT IT ASSERTS, once the link is back:
 *   1. the beacon is intact                     - the precondition, and the reason to believe 2-4
 *   2. what W2 sent while offline reaches W1 exactly once
 *   3. that same message sits on W2 exactly once - a sender must not double its own echo on flush
 *   4. what W1 sent while W2 was away arrives on W2 exactly once
 *
 * 2 IS THE ONE WITH TWO HONEST OUTCOMES, and the record separates them: the app may queue the send
 * and flush it on reconnect, or it may refuse it outright. Only the second is a loss, and a count of
 * zero on W1 cannot tell them apart on its own - so the composer's state and W2's own view are read
 * BEFORE the link is restored, and both are in the row.
 *
 * The cut is `cutHard` (offline emulation AND the sockets closed) and it is PROVEN by `awaitSevered`,
 * because a socket that survived would make every count below meaningless in the passing direction.
 *
 *   bun tab7.mjs
 */
import { APP_TAB, armComposer, awaitGatewayConnected, awaitMessage, client, ensureConversation, evaluate, send, settledCount } from '../chat.mjs';
import { activate } from '../cdp.mjs';
import { armCut, awaitSevered, cutHard, link } from './net.mjs';
import { mark, recordObserved } from '../results.mjs';
import { ignoringOfflineCut, report } from '../watch.mjs';
import { watch } from '../watch.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFLINE_HOLD_MS = 8000;

const w1 = await client(PORTS.W1, APP_TAB, { focus: false });
const w2 = await client(PORTS.W2, APP_TAB, { focus: false });

const fromW2 = mark('TAB7OFF');
const fromW1 = mark('TAB7IN');

// --- 0. the arming reload happens FIRST, so the window it opens contains no reload at all --------
const armed = await armCut(w2);
console.log(`[tab7] W2 armed - gateway back after ${armed.gatewayBackAfterMs} ms`);

await ensureConversation(w1, peerNameFor('W1'));
await ensureConversation(w2, peerNameFor('W2'));

// THE BEACON. Planted after the arming reload and after the conversation is open, so that anything
// which would rebuild the document from here on is visible at the end as its absence. `window` is
// the right home precisely because it does NOT survive a navigation - a value in `sessionStorage`
// would, and would prove nothing.
const BEACON = `${fromW2}-beacon`;
await evaluate(w2, `window.__tab7 = ${JSON.stringify(BEACON)}; true`);

const o1 = await watch(w1, 'TAB7-W1');
const o2 = await watch(w2, 'TAB7-W2');

// --- 1. W2 goes offline for real, and the cut is proven before anything is asked of it ----------
const cut = await cutHard(w2);
const severed = await awaitSevered(w2, 15000);
console.log(
  `[tab7] W2 offline - ${cut.socketsClosed} socket(s) closed, severed=${severed.severed} after ${severed.msToSever} ms`
);
const linkWhileOut = await link(w2);

// --- 2. both sides act while the link is down --------------------------------------------------
//
// `send` is unusable on W2 here: it waits for the composer to empty and for delivery, which is the
// very thing being cut. So the submit is fire-and-forget, and what the app did with it is READ
// rather than assumed.
await armComposer(w2, fromW2);
await activate(w2, 'text=Envoyer le message');
await sleep(2500);
const composerAfterSubmit = await evaluate(
  w2,
  `(function () { var c = document.querySelector('.chat-composer-footer .chat-composer-editor'); return c ? c.innerText.trim().slice(0, 60) : 'NO COMPOSER'; })()`
);
const onSenderWhileOffline = Number(
  await evaluate(
    w2,
    `(function () { return (document.body.innerText.match(new RegExp(${JSON.stringify(fromW2)}, 'g')) || []).length; })()`
  )
);
console.log(
  `[tab7] W2 submitted offline - composer=${JSON.stringify(composerAfterSubmit)} own view=${onSenderWhileOffline}`
);

// W1 is online throughout: this is the message W2 must be handed on its return.
await send(w1, fromW1);
console.log(`[tab7] W1 sent ${fromW1} while W2 was away`);

await sleep(OFFLINE_HOLD_MS);

// --- 3. back online, same document -------------------------------------------------------------
const at = w2.events.length;
await cut.restore();
const gatewayBackMs = await awaitGatewayConnected(w2, at, 60000);
console.log(`[tab7] W2 reconnected after ${gatewayBackMs} ms`);

await awaitMessage(w2, fromW1, 45000).catch(() => null);
await awaitMessage(w1, fromW2, 45000).catch(() => null);

// Both sides settle before either is read: one sample taken a fixed delay after arrival cannot tell
// "exactly one copy" from "the second had not landed yet", and that is the whole assertion.
const onPeer = await settledCount(w1, fromW2);
const onSender = await settledCount(w2, fromW2);
const inbound = await settledCount(w2, fromW1);
const beacon = await evaluate(w2, `String(window.__tab7)`);
const reloaded = beacon !== BEACON;

const fail = [];
if (onPeer.count !== 1)
  fail.push(
    `W1 holds ${onPeer.count} copies of the message W2 sent offline (composer left ${JSON.stringify(composerAfterSubmit)}, W2's own view showed ${onSenderWhileOffline} while out)`
  );
if (onSender.count !== 1) fail.push(`W2 shows its own offline message ${onSender.count} times`);
if (inbound.count !== 1) fail.push(`W2 holds ${inbound.count} copies of what arrived while it was away`);

// THE PRECONDITIONS, EACH OF WHICH MAKES THE ASSERTIONS ABOVE MEAN NOTHING IF IT DID NOT HOLD.
// A tab that reloaded, a cut that never took, or a link that never came back: none of the three is a
// verdict about the application, and all three used to be assumptions.
const vacuous = [];
if (reloaded) vacuous.push(`the tab RELOADED - beacon is ${JSON.stringify(beacon)}, so nothing here is about a live document`);
if (!cut.socketsClosed) vacuous.push('no socket was closed, so W2 was never really offline');
if (!severed.severed) vacuous.push('requests still succeeded after the cut - the link was never severed');
if (gatewayBackMs === null) vacuous.push('the gateway never came back, so no flush could have happened');

const settled = onPeer.settled && onSender.settled && inbound.settled;
const verdict = vacuous.length ? 'VACUOUS' : !settled ? 'INCONCLUSIVE' : fail.length ? 'FAIL' : 'PASS';

// `recordObserved` gates on cleanliness and on a mid-run redeploy, and records the dirt itself.
//
// W2 IS THE CLIENT THIS CHECK TAKES OFFLINE, so its report is read through `ignoringOfflineCut` -
// the disposition written for exactly this and, until 2026-09-05, applied by every check that cuts
// a link except this one. Without it TAB-7 cannot be clean on any run: severing the transport is
// the whole method, and the `ERR_INTERNET_DISCONNECTED`s, the closed socket and the
// "Gateway inaccessible" line are lines this script caused on purpose. W1 stays unfiltered, because
// nothing was done to W1 and a disconnection there would be a finding.
const row = await recordObserved('TAB-7', verdict, {
  offlineMarker: fromW2,
  inboundMarker: fromW1,
  socketsClosed: cut.socketsClosed,
  severed: severed.severed,
  msToSever: severed.msToSever,
  linkWhileOut,
  offlineHoldMs: OFFLINE_HOLD_MS,
  gatewayBackMs,
  neverReloaded: !reloaded,
  composerAfterSubmit,
  onSenderWhileOffline,
  onPeer: onPeer.count,
  onSender: onSender.count,
  inbound: inbound.count,
  countsSettled: settled,
  vacuousBecause: vacuous,
  failures: fail,
}, { W1: o1, W2: ignoringOfflineCut(await report(o2)) });
console.log(
  `[tab7] VERDICT ${row.verdict}${vacuous.length ? ' - ' + vacuous.join('; ') : fail.length ? ' - ' + fail.join('; ') : ''}`
);
process.exit(row.verdict === 'PASS' ? 0 : 1);
