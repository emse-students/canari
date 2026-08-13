/**
 * MSG-8 - A1 sends while W2's tab is BACKGROUNDED.
 *
 * Hard assertions: W2 really goes hidden; the message is present exactly once after the tab comes
 * back; both observation logs are clean. Everything about the unread signal (tab title, sidebar
 * badge) is REPORTED rather than asserted - the app's intent there is not written down anywhere,
 * so this run is what establishes it.
 */
import { client, ensureConversation, send, countMessage, evaluate } from './chat.mjs';
import { watch, report, logcatSince, logcatNotable, dirtOf } from './watch.mjs';
import { background } from './tabs.mjs';
import { finish, mark } from './results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';

const SIDEBAR = `(function () {
  const nav = document.querySelector('[data-conversation-list], aside, nav');
  return nav ? nav.innerText.replace(/\\n+/g, ' | ').slice(0, 400) : null;
})()`;

const a1 = await client(PORTS.A1);
const w2 = await client(9223, 'canari-emse.fr');

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

const m = mark('MSG8');
const t0 = Date.now();
await send(a1, `${m} sent to a backgrounded tab`);

// While hidden: does the frame even arrive, and does anything signal it to the user?
let arrivedHidden = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await evaluate(w2, `document.body.innerText.includes(${JSON.stringify(m)})`)) {
    arrivedHidden = Date.now() - t0;
    break;
  }
}
const during = {
  title: await evaluate(w2, 'document.title'),
  sidebar: await evaluate(w2, SIDEBAR),
  visibility: await evaluate(w2, 'document.visibilityState'),
};

await restore();
await new Promise((r) => setTimeout(r, 2500));
const after = {
  title: await evaluate(w2, 'document.title'),
  visibility: await evaluate(w2, 'document.visibilityState'),
  count: await countMessage(w2, m),
};

const obs = { a1: await report(wA), w2: await report(wB) };
const native = { logcat: await logcatNotable(await logcatSince(since)) };

const pass = after.count === 1 && obs.a1.clean && obs.w2.clean;

// The dump stays on stdout; the verdict goes to the record. This check exited on `pass` and never
// recorded, so a run of twelve scripts showed nine verdicts and the three silent ones read as passes.
console.log(JSON.stringify({ check: 'MSG-8', marker: m, before, during, obs, native }, null, 1));

finish('MSG-8', pass ? 'PASS' : 'FAIL', {
  marker: m,
  arrivedWhileHiddenMs: arrivedHidden,
  copies: after.count,
  titleChanged: before.title !== during.title,
  senderClean: obs.a1.clean,
  receiverClean: obs.w2.clean,
  senderDirt: dirtOf(obs.a1),
  receiverDirt: dirtOf(obs.w2),
});
