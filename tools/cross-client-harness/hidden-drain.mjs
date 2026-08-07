/**
 * Is the real bug "two tabs", or "a HIDDEN tab"?
 *
 * `runSaveEncrypted` opens with `await yieldToMainThread()`, and that helper resolves from
 * `requestAnimationFrame`, which Chrome never fires for a hidden document. It runs inside
 * `onDrainEnd`, whose await sits in front of `isDraining = false` - so in a hidden tab the drain
 * loop never finishes, and `enqueueMessage` stops starting new drains without logging a thing.
 *
 * The prediction is exact, so this either confirms or kills it:
 *   1. message #1 arrives while the tab is hidden -> it RENDERS (the UI update happens inside the
 *      drain, before onDrainEnd) and the drain then hangs;
 *   2. message #2 arrives while still hidden -> it does NOT render, and nothing is logged;
 *   3. the tab comes back to the foreground -> rAF fires, the flush completes, the drain finishes,
 *      the restart at the end of processQueue picks #2 up and it appears.
 *
 * A single tab, so nothing here depends on leader election. If step 2 renders, the hypothesis is
 * wrong and the two-tab result needs another explanation.
 */
import { client, ensureChat, openConversation, send, evaluate } from './chat.mjs';
import { background } from './tabs.mjs';
import { watch } from './watch.mjs';
import { mark } from './results.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PANE = `(function () { var c = document.querySelector('.chat-composer-editor'); var p = c ? c.closest('section') : null; return p ? p.innerText : ''; })()`;

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');
await sleep(1500);

// W2 is the receiver under test. Fresh page, so no earlier drain can already be stuck.
await w2.send('Page.reload');
await sleep(9000);
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');
await sleep(2000);

const o = await watch(w2, 'hidden-w2');
const restore = await background(w2);
console.log(`W2 visibility: ${await evaluate(w2, 'document.visibilityState')}`);

const m1 = mark('HID1');
await send(w1, `${m1} first message, receiver hidden`);
await sleep(12000);
const seen1 = (await evaluate(w2, PANE)).includes(m1);

const m2 = mark('HID2');
await send(w1, `${m2} second message, receiver still hidden`);
await sleep(15000);
const seen2 = (await evaluate(w2, PANE)).includes(m2);

console.log(JSON.stringify({ hidden: true, first: seen1, second: seen2 }));

await restore();
console.log(`W2 visibility restored: ${await evaluate(w2, 'document.visibilityState')}`);
await sleep(8000);
const pane = await evaluate(w2, PANE);
console.log(JSON.stringify({ afterRestore: { first: pane.includes(m1), second: pane.includes(m2) } }));

const lines = o.cx.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 150))
  .filter((t) => /QUEUE|MLS|WS RCV|ADD_MSG/.test(t));
o.cx.events.length = 0;
console.log('\n===== receiver console =====\n' + lines.join('\n'));
process.exit(0);
