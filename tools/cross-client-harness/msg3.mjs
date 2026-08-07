/** MSG-3: W1 -> W2, reply to a message. Expect the quoted parent to render on BOTH sides. */
import { awaitMessage, client, clickBubbleAction, countMessage, openDM, send } from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { mark, record } from './results.mjs';

const w1 = await client(9224);
const w2 = await client(9223);
await openDM(w1, 'the peer');
await openDM(w2, 'the owner');

// A parent of our own, so the check never depends on what happens to be last in a real history.
const parent = mark('MSG3P');
await send(w1, `parent ${parent}`);
await awaitMessage(w2, parent, 15000);

const action = await clickBubbleAction(w1, parent, 'Répondre');
// The composer shows the quoted parent while replying - that preview is part of the check.
const composerQuote = await evaluate(
  w1,
  `(function () { var c = document.querySelector('.chat-composer-editor').closest('footer'); return c ? c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : null; })()`,
);

const reply = mark('MSG3R');
await send(w1, `reply ${reply}`);

let ms = null;
try {
  ms = await awaitMessage(w2, reply, 20000);
} catch {
  /* miss is the result */
}
await new Promise((r) => setTimeout(r, 2000));

/** Does the reply bubble's own row carry the parent's text? That is what "quoted" means here. */
const quotedOn = async (cx) =>
  evaluate(
    cx,
    `(function () {
      var pane = document.querySelector('.chat-composer-editor').closest('section');
      var hits = [].filter.call(pane.querySelectorAll('p'), function (e) { return (e.textContent || '').indexOf(${JSON.stringify(reply)}) !== -1; });
      if (!hits.length) return null;
      var row = hits[hits.length - 1];
      for (var i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if (row.innerText.indexOf(${JSON.stringify(parent)}) !== -1) return row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160); }
      return 'NO QUOTE: ' + row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120);
    })()`,
  );

const onSender = await quotedOn(w1);
const onReceiver = await quotedOn(w2);
const ok = ms !== null && (await countMessage(w2, reply)) === 1 && !String(onSender).startsWith('NO QUOTE') && !String(onReceiver).startsWith('NO QUOTE');

record('MSG-3', ok ? 'PASS' : 'FAIL', { parent, reply, latencyMs: ms, action, composerQuote, onSender, onReceiver });
w1.close();
w2.close();
