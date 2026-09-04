#!/usr/bin/env node
/**
 * WHAT closes W1's WebSocket in the middle of READ-1, and what does the page say while it happens?
 *
 * `gotoWatched` was written on the hypothesis that the close belonged to the page the navigation
 * replaced. It did not fix it: the close still lands ~15 s into a check whose navigation completed
 * in the first two, i.e. AFTER the new socket's handshake, so a live socket is dying. That is either
 * the application dropping a connection it should hold (the WP-RECONNECT-2 class) or something this
 * rig does to it - and the two are separated by what surrounds the event, not by the event itself.
 *
 * So this replays READ-1's exact sequence and prints ONE interleaved timeline: every
 * `Network.webSocket*` and every console line, each with the same clock, so the close can be read
 * against what the app was doing at that instant.
 *
 *   bun ws1.mjs
 */
import { client, evaluate, goto, openDM, send, until } from '../chat.mjs';
import { consoleLines } from '../watch.mjs';
import { mark } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);
await w1.send('Network.enable');
await w1.send('Runtime.enable');
await w1.send('Log.enable');

const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(6)}ms`;

await goto(w1, '/chat');
console.log(at(), 'navigated');
await openDM(w2, OWNER_NAME);
console.log(at(), 'W2 has the DM open');

// Snapshot the buffer BEFORE the marker, so the timeline can be split into "setup" and "measured".
const setupEvents = w1.events.length;

const m = mark('WS1');
await send(w2, `${m} socket-close probe`);
console.log(at(), 'sent');
await until(w1, `document.body.innerText.indexOf(${JSON.stringify(m)}) !== -1 || true`, 1000).catch(() => null);
await openDM(w1, PEER_NAME);
console.log(at(), 'W1 opened the DM');

// Hold well past the point the close was observed at, so it lands inside this capture.
await new Promise((r) => setTimeout(r, 25000));
console.log(at(), 'held');

// ONE timeline. `Network.webSocket*` carries a monotonic `timestamp`, console lines carry none, so
// they are interleaved by ARRIVAL ORDER in the buffer - which is the order CDP delivered them and
// therefore the order the page produced them.
let i = 0;
for (const e of w1.events) {
  i++;
  const phase = i <= setupEvents ? 'setup ' : 'MEASURED';
  if (e.method.startsWith('Network.webSocket') && !/Frame(Sent|Received)$/.test(e.method)) {
    console.log(
      `${phase} #${i} ${e.method.replace('Network.webSocket', 'WS.')} ${e.params.requestId} ${(e.params.url || '').slice(0, 55)}`
    );
  } else if (e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded') {
    const t =
      e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log(`${phase} #${i} | ${t.slice(0, 150)}`);
  }
}

[w1, w2].forEach((c) => c.close());
