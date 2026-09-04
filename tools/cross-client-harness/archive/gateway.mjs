#!/usr/bin/env node
/**
 * Proves that each client's GATEWAY SOCKET is up - the pre-flight gate the campaign was missing.
 *
 *   bun gateway.mjs [--ports 9224,9223,9333] [--seconds 12]
 *
 * WHY THIS EXISTS. `unlock.mjs` proves a client is unlocked and `state.mjs` proves it is rendering,
 * and neither says one word about its transport. MSG-2 failed on 2026-08-13 with `copiesOnPhone: 0`
 * after 25 s and the message arriving on the phone's NEXT reconnect - a delivery check run against a
 * client whose socket was down measures the socket, not the delivery, and the run could not be
 * attributed. An unlocked client with no transport is the exact costume of a delivery loss.
 *
 * WHAT IT READS, AND WHY IT IS NOT AN INTERNAL. `WebMlsService` keeps its socket private and exposes
 * `isWsOpen()` on no global, so there is nothing to ask the page for. The frames themselves are
 * observable from OUTSIDE the app, through the CDP Network domain, which is better: it is a fact
 * about the wire rather than a field the app maintains about itself.
 *
 * THE VERDICT NEEDS BOTH DIRECTIONS, and that is the point.
 *
 * - A frame SENT proves the socket is `OPEN`: the app guards every send on `readyState === OPEN`.
 * - A frame RECEIVED proves the far end is still answering.
 *
 * Sent without received is a ZOMBIE - a socket the client believes in and the server has forgotten,
 * which the app itself only discovers after three missed heartbeats (24 s). Reporting that as `UP`
 * would hand a delivery check the same false floor MSG-2 stood on. The heartbeat is 8 s
 * (`WebMlsService.startHeartbeat`), so the default 12 s window contains at least one ping, and the
 * window is a SAMPLE SIZE rather than a deadline: nothing here decides on a clock, it decides on
 * frames observed or not observed.
 *
 * WHAT IT REFUSES TO ANSWER, and why that refusal is the feature. **A Tauri client's socket is not
 * in the WebView.** `TauriMlsService` uses `@tauri-apps/plugin-websocket`, so the frames are opened
 * and carried by RUST; the Network domain of the WebView sees nothing at all, and the first version
 * of this script duly reported the phone `DOWN` while it was perfectly connected. That is the
 * `recon.mjs` `WRONG STORE` mistake in a new costume - reading the wrong place and reporting the
 * emptiness as a verdict - so the phone is answered `NOT VISIBLE HERE`, never `DOWN`, and the
 * question it defers to is the presence key the GATEWAY holds (`user:online:{user}:{device}`,
 * TTL 20 s, refreshed on every frame), which is the same fact measured at the far end.
 *
 * Exits non-zero unless every client asked about is `UP`.
 */
import { listTargets, connect } from '../cdp.mjs';
import { PORTS } from '../names.mjs';

const flag = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const wanted = flag('ports', null)
  ?.split(',')
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const seconds = Number(flag('seconds', 12));

/** The gateway socket, as opposed to any other WebSocket the page may open (calls, dev tooling). */
const IS_GATEWAY = (url) => /\/api\/ws/.test(url || '');

let bad = 0;

for (const [label, port] of Object.entries(PORTS)) {
  if (wanted && !wanted.includes(port)) continue;

  let cx;
  try {
    const targets = await listTargets(port);
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target');
    cx = connect(page.webSocketDebuggerUrl);
    await cx.ready;
    const runtime = await cx.send('Runtime.evaluate', {
      expression: `!!window.__TAURI_INTERNALS__ || location.hostname === 'tauri.localhost'`,
      returnByValue: true,
    });
    if (runtime?.result?.value === true) {
      console.log(
        `${label} (${port}): NOT VISIBLE HERE - native socket, ask the gateway's presence key instead`
      );
      cx.close();
      continue;
    }
    await cx.send('Network.enable');
  } catch (e) {
    bad += 1;
    console.log(`${label} (${port}): UNREACHABLE - ${e.message}`);
    cx?.close();
    continue;
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));

  // requestId -> url, so a frame can be attributed to the socket that carries it. A socket opened
  // BEFORE the attach has no `webSocketCreated` event and therefore no url; its frames are still
  // counted, because "I attached late" is not "the transport is down".
  const urlOf = new Map();
  let sent = 0;
  let received = 0;
  let closed = 0;
  for (const ev of cx.events) {
    const { method, params } = ev;
    if (method === 'Network.webSocketCreated') urlOf.set(params.requestId, params.url);
    const url = urlOf.get(params?.requestId);
    const mine = url === undefined || IS_GATEWAY(url);
    if (!mine) continue;
    if (method === 'Network.webSocketFrameSent') sent += 1;
    else if (method === 'Network.webSocketFrameReceived') received += 1;
    else if (method === 'Network.webSocketClosed') closed += 1;
  }
  cx.close();

  const verdict =
    sent > 0 && received > 0 ? 'UP' : sent > 0 ? 'ZOMBIE (sending, nothing comes back)' : 'DOWN';
  if (verdict !== 'UP') bad += 1;
  console.log(
    `${label} (${port}): ${verdict} - ${sent} sent / ${received} received / ${closed} closed in ${seconds}s`
  );
}

if (bad > 0) process.exitCode = 4;
