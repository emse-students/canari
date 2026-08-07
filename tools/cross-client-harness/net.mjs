/**
 * Cutting a client off the network, and proving it was really cut.
 *
 * `Network.emulateNetworkConditions` is the only lever that works here: killing the interface
 * would take the CDP connection with it. It severs fetch/XHR/WebSocket at the network stack, which
 * is what the app's reconnect logic reacts to - `navigator.onLine` is emulated alongside it.
 */
import { evaluate } from './cdp.mjs';

const OFFLINE = {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
};

const ONLINE = {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
};

/**
 * Takes the client offline; returns a function restoring it.
 *
 * PROVE THE CUT, do not assume it. `navigator.onLine` flips instantly while an ALREADY OPEN
 * WebSocket can keep delivering - MSG-9 first "failed" because the message arrived at a receiver
 * the check believed was disconnected. So the caller gets a `severed` promise that only resolves
 * once a same-origin request actually fails, which is the state the app's reconnect logic is in.
 */
export async function cut(cx, timeoutMs = 15000) {
  await cx.send('Network.enable');
  await cx.send('Network.emulateNetworkConditions', OFFLINE);

  const t0 = Date.now();
  let severed = false;
  while (Date.now() - t0 < timeoutMs) {
    const reachable = await evaluate(
      cx,
      `fetch('/api/version', { cache: 'no-store' }).then(function () { return true; }, function () { return false; })`
    );
    if (!reachable) {
      severed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    severed,
    msToSever: Date.now() - t0,
    restore: async () => {
      await cx.send('Network.emulateNetworkConditions', ONLINE);
    },
  };
}

/**
 * Whether the page's own chat socket is open, read from the socket rather than from a flag.
 *
 * There is no app-side accessor for it, so this counts live WebSockets the page holds by patching
 * the constructor - which only sees sockets opened AFTER the patch. Call it before the cut and it
 * reports the reconnects; it can never prove the original socket died, which is why the fetch
 * probe above is what decides.
 */
export async function trackSockets(cx) {
  await evaluate(
    cx,
    `(function () {
      if (window.__wsTrack) return true;
      window.__wsTrack = { opened: 0, closed: 0 };
      const Native = window.WebSocket;
      window.WebSocket = function (...args) {
        const ws = new Native(...args);
        window.__wsTrack.opened++;
        ws.addEventListener('close', () => window.__wsTrack.closed++);
        return ws;
      };
      window.WebSocket.prototype = Native.prototype;
      return true;
    })()`
  );
  return () => evaluate(cx, 'window.__wsTrack');
}

/**
 * What the page believes about its own connectivity.
 *
 * `navigator.onLine` alone is never proof - a captive portal reports `true` - so the WebSocket's
 * state is read next to it, which is what actually carries messages.
 */
export function link(cx) {
  return evaluate(
    cx,
    `(function () {
      return { onLine: navigator.onLine, visibility: document.visibilityState };
    })()`
  );
}
