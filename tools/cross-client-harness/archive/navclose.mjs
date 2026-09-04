#!/usr/bin/env node
/**
 * Does a navigation produce EXACTLY one socket close, and is the document replacement observable?
 *
 * `wsidle.mjs` measured 0 closes on W1 AND W2 over 8 idle minutes, which kills the idle-timeout
 * reading of the 1006 outright: nothing on the path drops an untouched socket. What remains is that
 * READ-1, READ-2 and READ-4 each perform a SECOND navigation inside their own observation window -
 * `openDM` is `goto` is `Page.navigate` - and `chat.mjs` has said all along that "a navigation is a
 * disconnection". `gotoWatched` fixed the FIRST navigation and the dirt stayed, because the one
 * producing it is the second.
 *
 * Before anything is forgiven on that basis it has to be MEASURED, and measured as a count rather
 * than a story: the previous attribution was believed on one requestId and was wrong.
 *
 * THE INVARIANT THIS TESTS. A navigation replaces the top-level document, and a socket cannot
 * outlive the document that opened it. So over a window containing N deliberate navigations, closes
 * attributable to them are at most N - and a close BEYOND that count is a live socket dying, which
 * is WP-RECONNECT-2's shape and must never be forgiven. Both halves are counted here:
 *
 *   - `Page.frameNavigated` on the MAIN frame (no `parentId`) - the document replacement itself;
 *   - `Runtime.executionContextsCleared` - the same event seen from the JS side, kept as a control
 *     so the choice between them is made on evidence rather than on which one I remembered.
 *
 * Nothing is sent and no message is written anywhere: this navigates and counts.
 *
 *   bun navclose.mjs [--device W1] [--navigations 3]
 */
import { client, goto } from '../chat.mjs';
import { PORTS } from '../names.mjs';

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : process.argv[i + 1];
};
const device = arg('--device', 'W1');
const N = Number(arg('--navigations', 3));

const cx = await client(PORTS[device]);
await cx.send('Runtime.enable');
await cx.send('Log.enable');
await cx.send('Network.enable');
await cx.send('Page.enable');

// Settle on a loaded page FIRST, so the counts below start from a document this probe navigated to
// and not from whatever the session was left on.
await goto(cx, '/chat');
await new Promise((r) => setTimeout(r, 3000));
cx.events.length = 0;

for (let i = 1; i <= N; i++) {
  await goto(cx, '/chat');
  await new Promise((r) => setTimeout(r, 2000));
}

const count = (m, f = () => true) => cx.events.filter((e) => e.method === m && f(e)).length;
const mainFrameNavs = count('Page.frameNavigated', (e) => !e.params.frame.parentId);

console.log(
  JSON.stringify(
    {
      device,
      navigationsPerformed: N,
      mainFrameNavigated: mainFrameNavs,
      executionContextsCleared: count('Runtime.executionContextsCleared'),
      webSocketCreated: count('Network.webSocketCreated'),
      webSocketClosed: count('Network.webSocketClosed'),
      webSocketFrameError: count('Network.webSocketFrameError'),
    },
    null,
    1
  )
);

// The close is only ATTRIBUTABLE if the app also says it saw one, with the code that says nobody
// sent a close frame - which is what a torn-down document looks like from inside the tab.
const disconnects = cx.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
  .map((e) =>
    e.method === 'Log.entryAdded'
      ? e.params.entry.text
      : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
  )
  .filter((t) => /\[WS\] Disconnected/.test(t));
console.log('disconnect lines:', disconnects);

cx.close();
