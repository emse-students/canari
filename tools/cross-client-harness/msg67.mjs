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
  client,
  ensureChat,
  openConversation,
  evaluate,
  send,
  awaitMessage,
  countMessage,
} from './chat.mjs';
import { watch, report } from './watch.mjs';
import { record, mark } from './results.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');

await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

// ---------------------------------------------------------------- MSG-6
const linkMark = mark('MSG6');
const ow1 = await watch(w1, 'MSG-6-W1');
const ow2 = await watch(w2, 'MSG-6-W2');
await send(w1, `${linkMark} https://fr.wikipedia.org/wiki/Signal_(application)`);
const linkArrived = await awaitMessage(w2, linkMark, 40000).then(() => true, () => false);
await sleep(6000);

const preview = JSON.parse(
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
const obs6w1 = await report(ow1);
const obs6w2 = await report(ow2);
const msg6 = {
  marker: linkMark,
  arrived: linkArrived,
  ...preview,
  senderClean: obs6w1.clean,
  receiverClean: obs6w2.clean,
  receiverNotable: obs6w2.notable,
};
const msg6Ok = linkArrived && preview.foreign.length === 0;
record('MSG-6', msg6Ok ? (obs6w2.clean ? 'PASS' : 'PASS-DIRTY') : 'FAIL', msg6);
console.log(`[msg6] arrived=${linkArrived} foreignImgs=${preview.foreign.length} preview=${preview.previewRendered}`);

// ---------------------------------------------------------------- MSG-7
await sleep(2000);
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
await sleep(4000);

const seenOrder = JSON.parse(
  await evaluate(
    w1,
    `JSON.stringify((function () {
      var pane = document.querySelector('.chat-composer-editor').closest('section');
      return ((pane.innerText || '').match(new RegExp(${JSON.stringify(burst)} + 'n[0-9]{2}', 'g')) || []);
    })())`
  )
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
  receiverNotable: o7a.notable,
  receiverErrors: o7a.errors,
  senderNotable: o7b.notable,
  senderErrors: o7b.errors,
};
const msg7Ok = missing.length === 0 && dupes.length === 0 && ordered;
record('MSG-7', msg7Ok ? (o7a.clean && o7b.clean ? 'PASS' : 'PASS-DIRTY') : 'FAIL', msg7);
console.log(`[msg7] ${uniqueSeen.length}/${N} ordered=${ordered} missing=${missing.length} dupes=${dupes.length}`);
console.log(JSON.stringify({ msg6, msg7 }, null, 1));
process.exit(0);
