/**
 * MSG-8b - the unread SIGNAL, which MSG-8a could not see.
 *
 * MSG-8a backgrounded a tab that had the conversation open, so there was nothing to be unread
 * about. Here W2 sits on another page entirely, goes hidden, and A1 sends: the question is whether
 * anything tells the user - tab title, favicon, a badge in the nav or on the conversation row.
 *
 * Nothing here is asserted except that the message is intact on return; the signal is REPORTED,
 * because what the app intends to do is not written down and this run is what establishes it.
 */
import { APP_TAB, client, countMessage, ensureConversation, evaluate, goto, send } from '../chat.mjs';
import { gate, report, watch } from '../watch.mjs';
import { background } from './tabs.mjs';
import { finish, mark } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

/** Everything that could carry an unread count, captured in one shot for a before/after diff. */
const SIGNAL = `(function () {
  const badges = [...document.querySelectorAll('[class*="badge"], [aria-label*="non lu"], [aria-label*="unread"]')]
    .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim())
    .filter(Boolean);
  const link = document.querySelector('link[rel~="icon"]');
  return {
    title: document.title,
    favicon: link ? String(link.href).slice(0, 80) : null,
    badges: badges.slice(0, 12),
    navText: (document.querySelector('nav')?.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200),
  };
})()`;

const a1 = await client(PORTS.A1);
const w2 = await client(9223, APP_TAB);

// PROVEN, not assumed - a composer says a conversation is open, never which. See `ensureConversation`.
await ensureConversation(a1, PEER_NAME);

// Leave the chat entirely so the DM is genuinely unread, then background.
await goto(w2, '/communities');
await new Promise((r) => setTimeout(r, 2500));
const before = await evaluate(w2, SIGNAL);

const wA = await watch(a1, 'a1-sender');
const wB = await watch(w2, 'w2-receiver');
const restore = await background(w2);

// THE SIBLING IS CLOSED ON EVERY EXIT PATH, and this check is what proved it has to be. The send
// below goes to the PHONE, so anything wrong with the phone's composer throws here - and on
// 2026-08-16 it did, leaving W2 backgrounded with an extra tab that the next job's preflight had to
// clean up. A leaked tab is not litter: it is a second MLS client on that profile, which is the very
// fault rule 5 exists for. A teardown that only runs on the happy path is not a teardown.
const m = mark('MSG8B');
let during;
try {
  await send(a1, `${m} unread signal probe`);
  await new Promise((r) => setTimeout(r, 12000));
  during = await evaluate(w2, SIGNAL);
} finally {
  // Never let the restore's own failure replace the error that got us here.
  await restore().catch((e) => console.error('[MSG-8b] restore failed:', e.message));
}
await new Promise((r) => setTimeout(r, 2000));
const afterFocus = await evaluate(w2, SIGNAL);

await ensureConversation(w2, OWNER_NAME);
await new Promise((r) => setTimeout(r, 2500));
const count = await countMessage(w2, m);
const afterOpen = await evaluate(w2, SIGNAL);

const obs = { a1: await report(wA), w2: await report(wB) };
const signalled =
  JSON.stringify(during.badges) !== JSON.stringify(before.badges) ||
  during.title !== before.title ||
  during.favicon !== before.favicon;

// The assertion is the copy count alone. Folding cleanliness into it made a dirty run report `FAIL`,
// which asserts the message did not survive - a claim this check would be making against its own
// evidence. `gate` qualifies the PASS instead.
const gated = gate(count === 1 ? 'PASS' : 'FAIL', { A1: obs.a1, W2: obs.w2 });
console.log(
  JSON.stringify(
    {
      check: 'MSG-8b',
      marker: m,
      unreadSignalled: signalled,
      before,
      during,
      afterFocus,
      afterOpen,
      count,
      obs,
    },
    null,
    1
  )
);
// REPORTED, not asserted: the app's intent for the unread signal is not written down anywhere, so
// this field is what establishes it. The verdict is only about the message surviving intact.
finish('MSG-8b', gated.verdict, {
  ...gated.detail,
  marker: m,
  copies: count,
  unreadSignalled: signalled,
});
