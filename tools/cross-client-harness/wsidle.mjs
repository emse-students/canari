#!/usr/bin/env node
/**
 * How often does an IDLE client's chat socket die, and does it die the same way on both browsers?
 *
 * `ws1.mjs` established that the `webSocketClosed` dirtying READ-1, READ-2 and READ-4 is not the
 * navigation those checks perform: the page logs `[WS] Disconnected. Code: 1006, Reason: no reason`
 * and then reconnects on its own. 1006 is an ABNORMAL closure - no close frame was received - which
 * is what an intermediary dropping an idle connection looks like from inside the tab, and is not
 * what a server closing a session cleanly looks like.
 *
 * Two things have to be measured before that can be called anything:
 *
 *   1. THE INTERVAL. A close every ~2 min with an immediate reconnect is an idle timeout somewhere
 *      on the path (the Cloudflare tunnel is the obvious candidate) outrunning the app's own
 *      keepalive. A close at random is a different fault entirely.
 *   2. WHETHER IT IS ONE CLIENT OR BOTH. W1 is the browser every dirty check used. If W2 is quiet
 *      over the same window, the cause is local to that profile - an occluded window, a throttled
 *      renderer - and not the application at all. Same instrument, two subjects, one window: this
 *      is the control the campaign keeps forgetting to run.
 *
 * NOTHING IS DRIVEN HERE. Both clients are left alone for the whole window on purpose - the question
 * is what happens with no traffic, so any interaction would destroy the measurement.
 *
 *   node wsidle.mjs [--minutes 6]
 */
import { client } from './chat.mjs';
import { PORTS } from './names.mjs';

const i = process.argv.indexOf('--minutes');
const MINUTES = i === -1 ? 6 : Number(process.argv[i + 1]);

const subjects = [];
for (const label of ['W1', 'W2']) {
  const cx = await client(PORTS[label]);
  await cx.send('Network.enable');
  await cx.send('Runtime.enable');
  await cx.send('Log.enable');
  cx.events.length = 0;
  subjects.push({ label, cx, t0: Date.now() });
}

console.log(`idling ${MINUTES} min on W1 and W2, touching neither...`);
await new Promise((r) => setTimeout(r, MINUTES * 60000));

for (const { label, cx, t0 } of subjects) {
  const closes = [];
  const opens = [];
  for (const e of cx.events) {
    if (e.method === 'Network.webSocketClosed') closes.push(e.params.timestamp);
    if (e.method === 'Network.webSocketCreated') opens.push(e.params.timestamp);
  }
  // Console is read for the CODE: `Network.webSocketClosed` never carries one, and 1006 (no close
  // frame) and 1000 (a clean server close) mean opposite things about who hung up.
  const codes = cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    .map((e) =>
      e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    )
    .filter((t) => /\[WS\] Disconnected/.test(t));
  const gaps = closes.slice(1).map((t, k) => Math.round(t - closes[k]));
  console.log(
    JSON.stringify(
      {
        label,
        windowMin: MINUTES,
        closes: closes.length,
        reopens: opens.length,
        secondsBetweenCloses: gaps,
        disconnectLines: codes.slice(0, 8),
      },
      null,
      1
    )
  );
  cx.close();
}
