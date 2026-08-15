/**
 * MSG-3: W1 -> W2, reply to a message. Expect the quoted parent to render on BOTH sides.
 *
 * REPAIRED 2026-08-14. It carried four copies of things that live in one place, and no observation:
 *
 *   - the two display names, as REAL first-name literals. `names.mjs` is the only source for those,
 *     and a renamed account would have made this open nothing and then report on whatever screen it
 *     happened to be looking at. It is also the campaign's standing rule about what may appear in a
 *     file, applied to the one script that had escaped it;
 *   - the two ports, as literals - the same stale-literal fault that took MSG-2 out entirely when
 *     A1's moved;
 *   - `sleep(2000)` after the reply, guessing at when the quote would be rendered. The quote either
 *     renders or it does not, and that is a fact worth polling for rather than a duration worth
 *     charging to every run;
 *   - no `watch` at all, so the verdict could not see a decrypt failure, a 4xx or a socket dying
 *     underneath it. It was one of eight checks in that state.
 *
 * KNOWN AND DELIBERATELY NOT FIXED HERE: `Repondre` is a French Paraglide caption, so this check
 * only works against an `fr` client. Every script driving a bubble action shares that dependency, so
 * it is one fix in `chat.mjs` rather than eight here.
 */
import {
  awaitMessage,
  clickBubbleAction,
  client,
  countMessage,
  openDM,
  pollFact,
  send,
} from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);
await openDM(w1, PEER_NAME);
await openDM(w2, OWNER_NAME);

// Attached AFTER both conversations are open, so two clients' boot chatter does not bury the handful
// of lines this check is about.
const wA = await watch(w1, 'W1');
const wB = await watch(w2, 'W2');

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

const quoted = (v) => v !== null && !String(v).startsWith('NO QUOTE');

// POLLED TO THE FACT, not slept to a guess. The quote appearing IS the thing under test, so waiting
// for it costs nothing when it renders at once and fails honestly when it never does - which the
// fixed 2 s it replaces could do neither of. The deadline is generous because a miss here is the
// check's own answer, not an instrument timeout.
let onSender = null;
let onReceiver = null;
const quoteSettled = await pollFact(
  async () => {
    onSender = await quotedOn(w1);
    onReceiver = await quotedOn(w2);
    return quoted(onSender) && quoted(onReceiver);
  },
  { timeoutMs: 15000, everyMs: 500 },
);

const ok = ms !== null && (await countMessage(w2, reply)) === 1 && quoted(onSender) && quoted(onReceiver);
const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(wA), W2: await report(wB) });

record('MSG-3', gated.verdict, {
  ...gated.detail,
  parent,
  reply,
  latencyMs: ms,
  action,
  composerQuote,
  onSender,
  onReceiver,
  quoteRenderedMs: quoteSettled.ok ? quoteSettled.elapsedMs : null,
});
w1.close();
w2.close();
