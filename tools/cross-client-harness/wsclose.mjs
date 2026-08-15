#!/usr/bin/env node
/**
 * SUPERSEDED 2026-08-15 - ITS ANSWER WAS TRUE AND THE CONCLUSION DRAWN FROM IT WAS WRONG.
 *
 * This probe reports which sockets closed without having been created inside its window, and that
 * measurement is correct. What it CANNOT say is whether the close READ-1/2/4 reported was the same
 * one - and it was read as though it could. `gotoWatched` was built on that reading, delayed each
 * window until the new page's handshake, and the runs came back identically dirty: the close being
 * reported came from the check's SECOND navigation (`openDM` is `goto` is `Page.navigate`), which
 * this probe never performs and therefore never saw.
 *
 * A probe answers the question it was written to answer, and this one was asked a different one.
 * The question that settled it is `navclose.mjs` (does one navigation produce exactly one close?
 * yes - 3/3/3/3) on top of `wsidle.mjs` (does an untouched client close at all? no - 0 over 8 min
 * on both browsers). The forgiveness now lives in `watch.mjs`'s `ignoringNavigation`, bounded by a
 * counted document replacement.
 *
 * Kept runnable because the requestId question is a real one and will come back. Do not use it to
 * attribute a close observed by a DIFFERENT script.
 *
 * ---
 *
 * Whose socket is the `Network.webSocketClosed` that READ-1, READ-2 and READ-4 report?
 *
 * Those three opened their observation window immediately after `goto(w1, '/chat')` and each came
 * back `PASS-DIRTY` on one close, seconds into the window. Two explanations produce that identical
 * line and demand opposite actions: the application dropped a live socket (a defect, and precisely
 * the class WP-RECONNECT-2 was), or the NAVIGATION the check itself performed tore down the previous
 * page's socket and the event was delivered after `watch()` cleared the buffer (an instrument
 * artifact, the same shape as the reload READ-7 already excludes).
 *
 * The discriminator is the requestId: a socket CREATED before the navigation and CLOSED after it is
 * the old page's; a socket created after it and closed later is the live one. So this records
 * `webSocketCreated` and `webSocketClosed` across a navigation and prints both sides, rather than
 * asking whether a close happened at all.
 *
 *   node wsclose.mjs [--device W1]
 */
import { client, goto } from './chat.mjs';
import { PORTS } from './names.mjs';

const i = process.argv.indexOf('--device');
const device = i === -1 ? 'W1' : process.argv[i + 1];

const cx = await client(PORTS[device]);
await cx.send('Network.enable');

const socketsOf = () =>
  cx.events
    .filter((e) => e.method.startsWith('Network.webSocket'))
    .map((e) => ({
      at: e.params.timestamp,
      what: e.method.replace('Network.webSocket', ''),
      id: e.params.requestId,
      url: (e.params.url || '').slice(0, 60),
    }));

// Settle on a known page first, so the sockets seen below belong to a load this probe can name.
await goto(cx, '/chat');
await new Promise((r) => setTimeout(r, 4000));
cx.events.length = 0;

const before = Date.now();
await goto(cx, '/chat');
await new Promise((r) => setTimeout(r, 8000));

const seen = socketsOf();
const created = new Set(seen.filter((s) => s.what === 'Created').map((s) => s.id));
const closed = seen.filter((s) => s.what === 'Closed');
console.log(JSON.stringify({ device, navigatedAt: before, seen }, null, 1));
console.log(
  '\nclosed sockets that were NEVER created inside this window (i.e. predate the navigation):',
  closed.filter((c) => !created.has(c.id)).map((c) => c.id)
);
cx.close();
