/** MSG-2: W2 -> A1, phone app in the foreground. DM. Expect in-app delivery, no push duplicate. */
import { awaitMessage, client, countMessage, goto, openConversation, send } from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { mark, record } from './results.mjs';

const w2 = await client(9223);
const a1 = await client(9222);

// Full load on the phone: the DM rows only carry real names after one (the defect fixed in
// ace0596a is not deployed yet, so the campaign still runs against a build that has it).
await goto(a1, '/chat');
await new Promise((r) => setTimeout(r, 3000));
const openedA1 = await openConversation(a1, 'the peer');
await openConversation(w2, 'the owner');

const marker = mark('MSG2');
const at = await send(w2, `MSG-2 phone foreground ${marker}`);

let ms = null;
try {
  ms = await awaitMessage(a1, marker, 20000);
} catch {
  /* a miss is the result */
}
await new Promise((r) => setTimeout(r, 3000));

const onA1 = await countMessage(a1, marker);
const vis = await evaluate(a1, 'document.visibilityState');
record('MSG-2', ms !== null && onA1 === 1 ? 'PASS' : 'FAIL', {
  marker,
  latencyMs: ms,
  copiesOnPhone: onA1,
  phoneVisibility: vis,
  openedA1,
  sentAt: at,
});
w2.close();
a1.close();
