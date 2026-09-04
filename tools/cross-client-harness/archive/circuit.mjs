#!/usr/bin/env node
/**
 * WP-RECONNECT-1 - is this client's reconnect circuit OPEN, and can anything still close it?
 *
 *   bun circuit.mjs [--devices W1,W2] [--window 135000]
 *   bun circuit.mjs --devices W1 --kick online      # dispatch the event and watch what follows
 *
 * WHAT THIS MEASURES, AND WHY IT IS AN ABSENCE.
 *
 * `reconnectCircuitOpen` is a `let` inside `useChatSession.svelte.ts` - no global, no attribute, no
 * DOM. Nothing can read it. But the code leaves a signature that is just as decisive, and it is a
 * PAIR of lines rather than one:
 *
 *   - `startConnectionWatchdogImpl` logs `[WS] Watchdog: socket inactive, reconnecting...` every
 *     RECOVERY_TIMEOUT_MS (60 s) whenever the socket is down, THEN calls `scheduleReconnect`.
 *   - `scheduleReconnectImpl` logs `Connection lost. Retrying in Ns... (attempt k/20)` on every
 *     attempt it schedules - unless the circuit is open, where line 62 returns before any log.
 *
 * So a watchdog line with NO retry line after it is the circuit refusing, observed rather than
 * inferred. A watchdog line FOLLOWED by a retry line is a client that is merely failing to connect,
 * which is an entirely different fault. The two cases are indistinguishable from the badge, from
 * `navigator.onLine`, and from the gateway - which is why this probe exists and why it has to
 * listen for at least two watchdog periods.
 *
 * THE PRECONDITIONS ARE THE OTHER HALF OF THE FINDING. The circuit's own message promises recovery
 * "until the app returns to the foreground or the network changes". This probe records
 * `visibilityState`, `navigator.onLine` and the page's age, because a visible tab on an unchanged
 * network can emit NEITHER event, ever - and that is the whole defect. A capture that only proved
 * "no retries" would leave open the reading "it will recover on its own in a moment".
 *
 * `--kick <online|visible>` dispatches the event the app listens for and watches the same signature
 * for 20 s afterwards. It is the experiment that turns the attribution into a proof: if a synthetic
 * `online` reconnects a client that had been silent for hours, nothing was wrong with the network,
 * the transport or the server - only with the flag.
 *
 * Nothing here reloads anything. A reload destroys the state being measured.
 */
import { client, evaluate } from '../chat.mjs';
import { PORTS } from '../names.mjs';

const flag = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const devices = (flag('devices', 'W1,W2') || '').split(',').map((d) => d.trim()).filter(Boolean);
const WINDOW_MS = Number(flag('window', 135000));
const kick = flag('kick', null);

/** Everything that decides whether either recovery trigger is even POSSIBLE for this client. */
const STATE = `(function () {
  var pill = Array.prototype.slice.call(document.querySelectorAll('span, div, button'))
    .map(function (e) { return (e.innerText || '').trim(); })
    .filter(function (t) { return /^(Hors-ligne|Connecte|Connecté)$/i.test(t); })[0] || null;
  return {
    online: navigator.onLine,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    path: location.pathname,
    pill: pill,
    pageAgeMs: Math.round(performance.now()),
    gated: !!document.querySelector('#encryption-pin')
  };
})()`;

/** The two lines the diagnosis turns on, plus anything else the session says about the socket. */
const WATCHDOG = /Watchdog: socket inactive/i;
const RETRY = /Connection lost\. Retrying in/i;
const RECONNECTING = /^\[?[\d:apm\s]*\]?\s*Reconnecting\.\.\./i;
const OPENED = /Leadership acquired|WS connected|syncConnectionAfterWsOpen|\[WS\] Connected/i;

/** Console text of one `Runtime.consoleAPICalled`, flattened the way `watch.mjs` does. */
const textOf = (e) =>
  (e.params.args || [])
    .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
    .join(' ');

async function observe(label, cx, ms) {
  const from = cx.events.length;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  const lines = [];
  let socketsCreated = 0;
  for (const e of cx.events.slice(from)) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const t = textOf(e);
      if (WATCHDOG.test(t) || RETRY.test(t) || RECONNECTING.test(t) || OPENED.test(t))
        lines.push({ at: Math.round((Date.now() - t0) / 1000), text: t.slice(0, 140) });
    }
    if (e.method === 'Network.webSocketCreated') socketsCreated += 1;
  }
  return {
    label,
    windowMs: ms,
    watchdogTicks: lines.filter((l) => WATCHDOG.test(l.text)).length,
    retriesScheduled: lines.filter((l) => RETRY.test(l.text)).length,
    socketsCreated,
    lines,
  };
}

const results = [];
for (const d of devices) {
  const cx = await client(PORTS[d], null, { focus: false });
  await cx.send('Network.enable').catch(() => null);
  const before = await evaluate(cx, STATE);
  results.push({ d, cx, before });
  console.log(`${d}: ${JSON.stringify(before)}`);
}

// Every device is watched over the SAME wall-clock window, so one slow client cannot shorten
// another's - and the two answers stay comparable.
const observed = await Promise.all(results.map((r) => observe(r.d, r.cx, WINDOW_MS)));

for (const o of observed) {
  const verdict =
    o.watchdogTicks === 0
      ? 'NO WATCHDOG TICK - either the socket is up, or the watchdog itself is stopped'
      : o.retriesScheduled === 0
        ? 'CIRCUIT OPEN - the watchdog fired and scheduleReconnect refused, silently'
        : 'RETRYING - the circuit is closed and the client is failing to connect for another reason';
  console.log(
    `\n${o.label}: ${verdict}\n  watchdogTicks=${o.watchdogTicks} retriesScheduled=${o.retriesScheduled} socketsCreated=${o.socketsCreated}`,
  );
  for (const l of o.lines) console.log(`   +${l.at}s ${l.text}`);
}

if (kick) {
  for (const r of results) {
    const expr =
      kick === 'online'
        ? `(function () { window.dispatchEvent(new Event('online')); return true; })()`
        : `(function () { document.dispatchEvent(new Event('visibilitychange')); return true; })()`;
    await evaluate(r.cx, expr);
    console.log(`\n${r.d}: dispatched '${kick}' - watching 20s`);
  }
  const after = await Promise.all(results.map((r) => observe(`${r.d} after ${kick}`, r.cx, 20000)));
  for (const o of after) {
    console.log(`\n${o.label}: sockets=${o.socketsCreated} retries=${o.retriesScheduled}`);
    for (const l of o.lines) console.log(`   +${l.at}s ${l.text}`);
  }
  for (const r of results) console.log(`${r.d}: ${JSON.stringify(await evaluate(r.cx, STATE))}`);
}

for (const r of results) r.cx.close();
