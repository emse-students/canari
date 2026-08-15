/**
 * MSG-6 (link preview through the proxy) and MSG-7 (30 rapid sends).
 *
 * MSG-6 is a PRIVACY check, not a rendering one. An `<img src>` pointing at a third party inside an
 * end-to-end conversation tells that host who read the message and when, which is exactly what the
 * preview proxy exists to prevent - so the assertion is that every image the preview renders is
 * same-origin, and the failure mode to catch is a preview that "works" by hotlinking.
 *
 * MSG-7 is the ordering and duplication check, and it is the one most likely to provoke the branch
 * behind WP-LOSS-1: rapid sends are what push the ratchet, and `SecretReuseError` is what the
 * receiver raises when it thinks a generation was already consumed. Order is asserted on the
 * RECEIVER's rendered sequence, and every marker is counted so a duplicate cannot hide.
 */
import {
  awaitMessage,
  awaitRequestsQuiet,
  client,
  ensureConversation,
  evaluate,
  pollFact,
  send,
} from './chat.mjs';
import { gate, report, watch } from './watch.mjs';
import { record, mark } from './results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';

// PORTS AND NAMES FROM `names.mjs`, NEVER AS LITERALS. This file carried both: the two ports as
// numbers and the two accounts as their real display names, in a harness whose whole point is that
// it can be mirrored into a PUBLIC repository. A1's port has already moved once, and a renamed
// account makes `openConversation` open NOTHING while the check reports on whatever was on screen.
// `ensureConversation` replaces `ensureChat` + `openConversation` for the reason it exists: a
// composer proves a conversation is open, never WHICH one.
const w1 = await client(PORTS.W1, 'canari-emse.fr');
const w2 = await client(PORTS.W2, 'canari-emse.fr');

await ensureConversation(w1, PEER_NAME);
await ensureConversation(w2, OWNER_NAME);

// ---------------------------------------------------------------- MSG-6
const linkMark = mark('MSG6');
const ow1 = await watch(w1, 'MSG-6-W1');
const ow2 = await watch(w2, 'MSG-6-W2');
await send(w1, `${linkMark} https://fr.wikipedia.org/wiki/Signal_(application)`);
const linkArrived = await awaitMessage(w2, linkMark, 40000).then(() => true, () => false);

/**
 * The preview card as the RECEIVER renders it, read fresh on every poll.
 *
 * Extracted from the inline read it used to be so `pollFact` can call it: the check needs the state
 * AFTER the card has rendered, and `sleep(6000)` was standing in for that - charging six seconds to
 * every run, and still reporting `previewRendered: false` about a card that arrived at 6 100 ms.
 */
const readPreview = async () =>
  JSON.parse(
    await evaluate(
      w2,
      `JSON.stringify((function () {
      var pane = document.querySelector('.chat-composer-editor').closest('section');
      var imgs = [].map.call(pane.querySelectorAll('img'), function (i) { return String(i.src); });
      // Anything not on this origin, not a blob and not a data: URI is a third party being told
      // that this conversation was opened - the exact leak the proxy exists to close.
      var foreign = imgs.filter(function (s) {
        return s && s.indexOf('blob:') !== 0 && s.indexOf('data:') !== 0 && s.indexOf(location.origin) !== 0;
      });
      var txt = pane.innerText || '';
      return {
        previewRendered: /wikipedia|Signal/i.test(txt.slice(-600)),
        imgCount: imgs.length,
        foreign: foreign.slice(0, 6)
      };
    })())`
    )
  );

// RETURNS THE MOMENT THE CARD IS THERE, and gives up honestly if it never is - `previewRendered:
// false` is then a fact about the app rather than about how long this script chose to wait.
const previewSettled = await pollFact(async () => (await readPreview()).previewRendered, {
  timeoutMs: 15000,
  everyMs: 500,
});
const preview = await readPreview();

// MSG-6'S TRAFFIC MUST NOT LAND IN MSG-7'S OBSERVATION, and this is the only place the wait can
// happen: `report` DRAINS `cx.events`, and `awaitRequestsQuiet` reads that same buffer to know what
// is in flight. Called after the reports below, it would see an empty buffer, conclude "quiet" from
// no evidence at all, and be a fixed 1.2 s sleep wearing the name of a fact.
const quietBeforeBurst = await awaitRequestsQuiet(w2, /./, { quietMs: 1200, timeoutMs: 10000 });

const obs6w1 = await report(ow1);
const obs6w2 = await report(ow2);
const msg6 = {
  marker: linkMark,
  arrived: linkArrived,
  ...preview,
  previewRenderedMs: previewSettled.ok ? previewSettled.elapsedMs : null,
  quietBeforeBurstMs: quietBeforeBurst,
  receiverNotable: obs6w2.notable,
};
const msg6Ok = linkArrived && preview.foreign.length === 0;
// BOTH CLIENTS, not the receiver alone. The verdict consulted `obs6w2` while the exit code at the
// bottom of this file consulted both - so a dirty SENDER produced a recorded `PASS` next to a
// non-zero exit status, one run disagreeing with itself in two places.
const gated6 = gate(msg6Ok ? 'PASS' : 'FAIL', { W1: obs6w1, W2: obs6w2 });
record('MSG-6', gated6.verdict, { ...gated6.detail, ...msg6 });
console.log(`[msg6] arrived=${linkArrived} foreignImgs=${preview.foreign.length} preview=${preview.previewRendered}`);

// ---------------------------------------------------------------- MSG-7
// No wait here: the separation between the two checks is `quietBeforeBurst` above, taken while the
// evidence for it still existed.
const N = 30;
const burst = mark('MSG7');
const o7w1 = await watch(w1, 'MSG-7-W1');
const o7w2 = await watch(w2, 'MSG-7-W2');

const sent = [];
for (let i = 0; i < N; i++) {
  const m = `${burst}n${String(i).padStart(2, '0')}`;
  await send(w2, m); // W2 -> W1, per the plan
  sent.push(m);
}
const at = Date.now();
await awaitMessage(w1, sent[N - 1], 60000).catch(() => null);

/** The receiver's rendered sequence of burst markers, in the order they appear in the pane. */
const readOrder = async () =>
  JSON.parse(
    await evaluate(
      w1,
      `JSON.stringify((function () {
      var pane = document.querySelector('.chat-composer-editor').closest('section');
      return ((pane.innerText || '').match(new RegExp(${JSON.stringify(burst)} + 'n[0-9]{2}', 'g')) || []);
    })())`
    )
  );

// THE SEQUENCE HAS TO HAVE STOPPED MOVING, which is not the same as "four seconds have passed".
// The last marker arriving does not mean the other twenty-nine have settled - a duplicate or a
// re-order landing at 4 100 ms was invisible to the sleep this replaces, and a run where everything
// settled at 300 ms paid the full four seconds anyway. Both are answered by the same poll: hold the
// rendered sequence still for `quietMs` and return.
//
// It is deliberately NOT `settledCount`: that watches ONE marker, and what MSG-7 asserts is a
// property of all thirty AND of their order, which no per-marker count can see.
let seenOrder = await readOrder();
let stableSince = Date.now();
const orderSettled = await pollFact(
  async () => {
    const now = await readOrder();
    if (JSON.stringify(now) !== JSON.stringify(seenOrder)) {
      seenOrder = now;
      stableSince = Date.now();
      return false;
    }
    return Date.now() - stableSince >= 1500;
  },
  { timeoutMs: 20000, everyMs: 400 }
);
const uniqueSeen = [...new Set(seenOrder)];
const missing = sent.filter((m) => !uniqueSeen.includes(m));
const dupes = uniqueSeen.filter((m) => seenOrder.filter((x) => x === m).length > 1);
// Order is judged on the receiver's rendered sequence, restricted to what arrived.
const expectedOrder = sent.filter((m) => uniqueSeen.includes(m));
const ordered = JSON.stringify(uniqueSeen) === JSON.stringify(expectedOrder);

const o7a = await report(o7w1);
const o7b = await report(o7w2);
const msg7 = {
  sent: N,
  received: uniqueSeen.length,
  missing,
  dupes,
  ordered,
  elapsedMs: Date.now() - at,
  // `false` means the pane was STILL changing at the deadline, so `missing`, `dupes` and `ordered`
  // are readings of a moving value and prove nothing. Recorded rather than silently ignored.
  orderSettled: orderSettled.ok,
  receiverNotable: o7a.notable,
  senderNotable: o7b.notable,
};
const msg7Ok = missing.length === 0 && dupes.length === 0 && ordered;
const gated7 = gate(msg7Ok ? 'PASS' : 'FAIL', { W1: o7a, W2: o7b });
record('MSG-7', gated7.verdict, { ...gated7.detail, ...msg7 });
console.log(`[msg7] ${uniqueSeen.length}/${N} ordered=${ordered} missing=${missing.length} dupes=${dupes.length}`);
console.log(JSON.stringify({ msg6, msg7 }, null, 1));
// EXIT ON THE VERDICTS, not on having reached the end. This exited 0 unconditionally, so a run in
// which MSG-6 recorded FAIL still printed `msg67.mjs  done` beside it - the two halves of one run
// contradicting each other in the same table, which is the fault `results.finish` was written for.
// `finish` cannot be used here because this script carries TWO checks, so the rule is applied by
// hand: anything but a clean pass on either is work still owed.
// READ OFF THE RECORDED VERDICTS, so the exit status and the two rows can no longer disagree: they
// are now the same two values rather than the same rule re-derived from the reports a second time.
process.exit(gated6.verdict === 'PASS' && gated7.verdict === 'PASS' ? 0 : 1);
