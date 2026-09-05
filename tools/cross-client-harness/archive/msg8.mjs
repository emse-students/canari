/**
 * MSG-8 - A1 sends while W2's tab is BACKGROUNDED.
 *
 * Hard assertions: W2 really goes hidden; the message is present exactly once after the tab comes
 * back; both observation logs are clean. Everything about the unread signal (tab title, sidebar
 * badge) is REPORTED rather than asserted - the app's intent there is not written down anywhere,
 * so this run is what establishes it.
 */
import { APP_TAB, client, countMessage, ensureConversation, evaluate, send } from '../chat.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { background } from './tabs.mjs';
import { finish, mark } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

const SIDEBAR = `(function () {
  const nav = document.querySelector('[data-conversation-list], aside, nav');
  return nav ? nav.innerText.replace(/\\n+/g, ' | ').slice(0, 400) : null;
})()`;

const a1 = await client(PORTS.A1);
const w2 = await client(PORTS.W2, APP_TAB);

// PROVEN, not assumed. This used to open the DM only when no composer was on screen - and a
// composer says a conversation is open, never WHICH. A1 was left in the campaign CHANNEL by an
// earlier check, the guard was satisfied, and three MSG-8 markers went there while W2 watched the
// DM: a delivery loss reported that had never happened. See `ensureConversation`.
await ensureConversation(a1, PEER_NAME);
await ensureConversation(w2, OWNER_NAME);

const before = {
  title: await evaluate(w2, 'document.title'),
  sidebar: await evaluate(w2, SIDEBAR),
};

const wA = await watch(a1, 'a1-sender');
const wB = await watch(w2, 'w2-receiver');
const since = Date.now();

const restore = await background(w2);

// THE SIBLING IS CLOSED ON EVERY EXIT PATH. Everything below can throw - the send goes to the PHONE,
// and the poll evaluates in a hidden page - and a throw between here and `restore()` leaves an extra
// tab on the profile, which is a second MLS client, which is the fault rule 5 exists for. A teardown
// that only runs on the happy path is not a teardown.
const m = mark('MSG8');
const t0 = Date.now();
let arrivedHidden = null;
let during;
try {
  await send(a1, `${m} sent to a backgrounded tab`);

  // While hidden: does the frame even arrive, and does anything signal it to the user?
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await evaluate(w2, `document.body.innerText.includes(${JSON.stringify(m)})`)) {
      arrivedHidden = Date.now() - t0;
      break;
    }
  }
  during = {
    title: await evaluate(w2, 'document.title'),
    sidebar: await evaluate(w2, SIDEBAR),
    visibility: await evaluate(w2, 'document.visibilityState'),
  };
} finally {
  // Never let the restore's own failure replace the error that got us here.
  await restore().catch((e) => console.error('[MSG-8] restore failed:', e.message));
}
await new Promise((r) => setTimeout(r, 2500));
const after = {
  title: await evaluate(w2, 'document.title'),
  visibility: await evaluate(w2, 'document.visibilityState'),
  count: await countMessage(w2, m),
};

const obs = { a1: await report(wA), w2: await report(wB) };
// CLASSIFIED AND IN THE GATE, where it used to be a keyword grep printed under the verdict. `wA`
// above is the phone's WEBVIEW over CDP; this is the phone's NATIVE half, and on a check about a
// hidden/backgrounded window it is the half doing the work.
const native = logcatReport(await logcatSince(since), 'A1-native');

// CLEANLINESS IS NOT PART OF THE ASSERTION, it is a gate over it. Folding it in made a dirty run
// report `FAIL`, which says the message did not arrive exactly once - a claim this check would then
// be making without evidence, and the opposite of what happened. The assertion is the copy count;
// `gate` decides whether that PASS is qualified.
const arrivedOnce = after.count === 1;
const gated = gate(arrivedOnce ? 'PASS' : 'FAIL', { A1: obs.a1, W2: obs.w2, 'A1-native': native });

// The dump stays on stdout; the verdict goes to the record. This check exited on `pass` and never
// recorded, so a run of twelve scripts showed nine verdicts and the three silent ones read as passes.
console.log(JSON.stringify({ check: 'MSG-8', marker: m, before, during, obs, native }, null, 1));

finish('MSG-8', gated.verdict, {
  ...gated.detail,
  marker: m,
  arrivedWhileHiddenMs: arrivedHidden,
  copies: after.count,
  titleChanged: before.title !== during.title,
});
