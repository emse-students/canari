/** MSG-1: W1 -> W2, both foreground, DM, plain text. Expect < 2 s, one copy, correct author. */
import { awaitMessage, client, countMessage, evaluate, goto, openConversation, send } from './chat.mjs';
import { mark, record } from './results.mjs';

const w1 = await client(9224);
const w2 = await client(9223);

await goto(w2, '/chat');
const opened = await openConversation(w2, 'the owner');
await openConversation(w1, 'PEER DISPLAY NAME');

const marker = mark('MSG1');
const before2 = await countMessage(w2, marker);
const at = await send(w1, `MSG-1 baseline ${marker}`);

let ms = null;
let verdict = 'FAIL';
try {
  ms = await awaitMessage(w2, marker, 20000);
  verdict = ms < 2000 ? 'PASS' : 'SLOW';
} catch (e) {
  verdict = 'FAIL';
}

// Give any duplicate a chance to land before counting - a second copy that arrives 500 ms later is
// exactly the failure this check exists to catch, and asserting immediately would miss it.
await new Promise((r) => setTimeout(r, 2500));

const onW2 = await countMessage(w2, marker);
const onW1 = await countMessage(w1, marker);
const author = await evaluate(
  w2,
  `(function () {
    var needle = ${JSON.stringify(marker)};
    var leaf = [].filter.call(document.querySelectorAll('main *, [role=main] *, body *'), function (e) {
      return e.children.length === 0 && (e.textContent || '').indexOf(needle) !== -1;
    })[0];
    if (!leaf) return null;
    var row = leaf;
    for (var i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if (row.innerText.length > 120) break; }
    return row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 250);
  })()`,
);

record('MSG-1', verdict === 'PASS' && onW2 === 1 && onW1 === 1 ? 'PASS' : verdict === 'PASS' ? 'FAIL' : verdict, {
  marker,
  latencyMs: ms,
  sentAt: at,
  copiesOnReceiver: onW2,
  copiesOnSender: onW1,
  before2,
  openedOnW2: opened,
  authorContext: author,
});
w1.close();
w2.close();
