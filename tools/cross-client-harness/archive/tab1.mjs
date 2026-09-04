/**
 * TAB-1 - the OS notification for a message, and the silence that must precede it.
 *
 * THE ROW'S OLD SUBJECT WAS HALF ABSENT FROM THE PRODUCT, and that was measured before this runner
 * was written rather than discovered by it. "Backgrounded tab receives" is already PASS twice over
 * (MSG-8, MSG-8b). "Title/badge updates" is the half nothing owned, so it was chased down: MSG-8b's
 * own recorded evidence shows `document.title` and the favicon NEVER move for an unread message
 * ('Communautes - Canari' before, during and after), and the only thing that changes is an IN-PAGE
 * badge ('1 non lus') - a signal a user whose tab is backgrounded cannot see by construction.
 *
 * So the real out-of-page signal is elsewhere, and it is a web `Notification`: `useMessaging`
 * fires one when `visibilityState !== 'visible' || !document.hasFocus()`. MSG-8b's probe reads the
 * DOM, and an OS notification is not in the DOM - which is exactly why four green MSG-8b runs left
 * this untested. THAT is TAB-1.
 *
 * ONE VARIABLE, TWO PHASES. The conversation is open on W2 throughout and the same peer sends both
 * times; the only thing that changes is whether the tab is in front:
 *   1. visible AND focused -> the message arrives and NOTHING is posted. Without this half, "one
 *      notification while hidden" is also what a mechanism that notifies unconditionally produces.
 *   2. hidden              -> EXACTLY ONE notification, whose body carries the marker and whose tag
 *      names the conversation.
 *
 * The tag matters beyond existence: the app builds `canari-${conversationId ?? 'message'}`, so the
 * literal `canari-message` is the shape of a notification whose click-through has no conversation to
 * navigate to. A row that only checked for "a notification" would call that a pass.
 *
 * WHAT IS RECORDED IS DELIBERATELY NOT THE TITLE. The title is a DISPLAY NAME, which may not land in
 * a file this public repo can reach; the comparison happens here and only its boolean is kept.
 *
 * PRECONDITIONS, each VACUOUS rather than FAIL, because none of them is a statement about the app:
 * permission really granted (ungranted, the app returns early and posts nothing - which would read
 * as a defect), the recorder still installed at the end (a reload would have wiped both it and its
 * evidence), and each phase's message actually arriving (a count of zero notifications proves
 * nothing if nothing was delivered).
 *
 *   bun tab1.mjs
 */
import { awaitMessage, client, ensureConversation, evaluate, send } from '../chat.mjs';
import { background } from './tabs.mjs';
import { mark, recordObserved } from '../results.mjs';
import { watch } from '../watch.mjs';
import { ORIGIN, PORTS, SITE, peerNameFor } from '../names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for a notification that is going to be posted to have been posted. */
const SETTLE_MS = 6000;

const w1 = await client(PORTS.W1, SITE);
const w2 = await client(PORTS.W2, SITE);

const quiet = mark('TAB1VIS');
const loud = mark('TAB1HID');

await ensureConversation(w1, peerNameFor('W1'));
await ensureConversation(w2, peerNameFor('W2'));

// --- 0. permission, then the recorder, then the beacon -----------------------------------------
//
// Granted over CDP rather than clicked: the prompt is browser chrome, so there is nothing in the
// page for a synthetic click to reach. The grant is then CHECKED from inside the page, because a
// command that returned without error is not the same fact as `permission === 'granted'`.
const grantError = await w2
  .send('Browser.grantPermissions', {
    origin: ORIGIN.W2,
    permissions: ['notifications'],
  })
  .then(() => null)
  .catch((e) => e.message);
const permission = await evaluate(w2, `'Notification' in window ? Notification.permission : 'ABSENT'`);
console.log(`[tab1] W2 notification permission=${permission}${grantError ? ` (grant said: ${grantError})` : ''}`);

// THE RECORDER DELEGATES, it does not replace. Swallowing the construction would leave the real path
// unexercised and the row would be about a stub; the notification is really posted, and observed on
// its way through. The beacon shares the object's life, so one read at the end answers both "did the
// tab reload" and "was anything recorded".
const BEACON = `${loud}-beacon`;
const installed = await evaluate(
  w2,
  `(function () {
    if (!('Notification' in window)) return 'ABSENT';
    var Real = window.Notification;
    var store = { beacon: ${JSON.stringify(BEACON)}, calls: [], threw: [] };
    function Rec(title, opts) {
      var o = opts || {};
      store.calls.push({
        title: String(title == null ? '' : title),
        body: String(o.body == null ? '' : o.body),
        tag: String(o.tag == null ? '' : o.tag),
        hidden: document.visibilityState !== 'visible',
        focused: document.hasFocus(),
      });
      try {
        return new Real(title, opts);
      } catch (e) {
        store.threw.push(String(e && e.message));
        throw e;
      }
    }
    Object.defineProperty(Rec, 'permission', { get: function () { return Real.permission; } });
    Rec.requestPermission = function () { return Real.requestPermission.apply(Real, arguments); };
    window.Notification = Rec;
    window.__tab1 = store;
    return 'INSTALLED';
  })()`
);
console.log(`[tab1] recorder ${installed}`);

const READ = `(function () { var s = window.__tab1; return s ? JSON.stringify(s) : 'GONE'; })()`;
const readStore = async () => {
  const raw = await evaluate(w2, READ);
  return raw === 'GONE' ? null : JSON.parse(raw);
};

const o1 = await watch(w1, 'TAB1-W1');
const o2 = await watch(w2, 'TAB1-W2');

// --- 1. THE NEGATIVE: in front, and it must stay silent ----------------------------------------
const front = await evaluate(
  w2,
  `JSON.stringify({ visibility: document.visibilityState, focused: document.hasFocus() })`
).then(JSON.parse);
await send(w1, `${quiet} the tab is in front`);
const quietArrived = await awaitMessage(w2, quiet, 45000).then(
  () => true,
  () => false
);
await sleep(SETTLE_MS);
const afterVisible = (await readStore())?.calls.length ?? -1;
console.log(
  `[tab1] visible phase - arrived=${quietArrived} visibility=${front.visibility} focused=${front.focused} notifications=${afterVisible}`
);

// --- 2. THE POSITIVE: hidden, and exactly one ---------------------------------------------------
//
// `background` throws rather than reporting a false negative if the page did not really hide, so the
// hidden-ness of this phase needs no assertion of its own - but each recorded call carries the state
// it was posted under anyway, which is what tells a stray notification from the one being counted.
const restore = await background(w2);
let hiddenArrived = false;
let store = null;
try {
  await send(w1, `${loud} the tab is behind another`);
  hiddenArrived = await awaitMessage(w2, loud, 45000).then(
    () => true,
    () => false
  );
  await sleep(SETTLE_MS);
  store = await readStore();
} finally {
  // Never let the restore's own failure replace the error that got us here, and never leave a
  // sibling tab behind: it is a second MLS client on this profile (methodology rule 5).
  await restore().catch((e) => console.error('[tab1] restore failed:', e.message));
}

const calls = store?.calls ?? [];
const posted = calls.slice(afterVisible < 0 ? 0 : afterVisible);
const forLoud = posted.filter((c) => c.body.includes(loud));
console.log(`[tab1] hidden phase - arrived=${hiddenArrived} notifications=${posted.length} matching=${forLoud.length}`);

const fail = [];
if (afterVisible > 0)
  fail.push(
    `${afterVisible} notification(s) posted while the tab was VISIBLE and focused - the gate on visibility is not holding`
  );
if (forLoud.length !== 1)
  fail.push(
    `a hidden tab produced ${forLoud.length} notification(s) carrying the message (${posted.length} in total during that phase)`
  );
if (forLoud.length === 1) {
  const n = forLoud[0];
  // The display name is compared HERE and only the verdict is kept - see the header.
  if (n.title !== peerNameFor('W2'))
    fail.push('the notification does not carry the sender as its title');
  if (!/^canari-.+$/.test(n.tag)) fail.push(`the notification tag is ${JSON.stringify(n.tag)}`);
  if (n.tag === 'canari-message')
    fail.push('the tag is the conversation-less fallback `canari-message`, so a tap has nowhere to go');
}
if (store?.threw?.length) fail.push(`the Notification constructor threw: ${store.threw.join('; ')}`);

const vacuous = [];
if (installed !== 'INSTALLED') vacuous.push(`no recorder: window.Notification is ${installed}`);
if (permission !== 'granted')
  vacuous.push(`permission is ${JSON.stringify(permission)}, so the app returns before posting anything`);
if (store === null) vacuous.push('the recorder is gone - the tab reloaded and took the evidence with it');
else if (store.beacon !== BEACON) vacuous.push('the recorder was replaced mid-run, so its counts are not ours');
if (!quietArrived) vacuous.push('the visible-phase message never arrived, so its silence proves nothing');
if (!hiddenArrived) vacuous.push('the hidden-phase message never arrived, so no notification was owed');
if (front.visibility !== 'visible' || !front.focused)
  vacuous.push(`the first phase was not in front (visibility=${front.visibility}, focused=${front.focused})`);

const verdict = vacuous.length ? 'VACUOUS' : fail.length ? 'FAIL' : 'PASS';

// `recordObserved` reads the observers, gates on cleanliness AND on a mid-run redeploy, and records
// the dirt of whichever client was dirty - so none of that is spelt out again here.
const row = await recordObserved('TAB-1', verdict, {
  visibleMarker: quiet,
  hiddenMarker: loud,
  permission,
  grantError,
  recorder: installed,
  frontPhase: front,
  visiblePhaseArrived: quietArrived,
  notificationsWhileVisible: afterVisible,
  hiddenPhaseArrived: hiddenArrived,
  notificationsWhileHidden: posted.length,
  matchingTheMessage: forLoud.length,
  // Shape only, never the title: the tag and the body's marker are ours, the title is a person's name.
  shape: forLoud.map((c) => ({
    tag: c.tag,
    bodyCarriesMarker: c.body.includes(loud),
    titleIsSender: c.title === peerNameFor('W2'),
    postedWhileHidden: c.hidden,
  })),
  // The measured answer to this row's original wording, so the board never has to ask again.
  titleOrFaviconUnreadSignal: false,
  vacuousBecause: vacuous,
  failures: fail,
}, { W1: o1, W2: o2 });
console.log(
  `[tab1] VERDICT ${row.verdict}${vacuous.length ? ' - ' + vacuous.join('; ') : fail.length ? ' - ' + fail.join('; ') : ''}`
);
process.exit(row.verdict === 'PASS' ? 0 : 1);
