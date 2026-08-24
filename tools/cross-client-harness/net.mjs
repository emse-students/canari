/**
 * Cutting a client off the network, and proving it was really cut.
 *
 * `Network.emulateNetworkConditions` is the only lever that can be pulled from here: killing the
 * interface would take the CDP connection with it. What it actually does is fail every NEW request
 * and flip `navigator.onLine`; it does NOT touch a WebSocket that is already open - measured, see
 * `CUT_PATCH`. So there are two different cuts in this file and they are not interchangeable:
 *
 *   - `cut()`    - no new request leaves. Correct for a SENDER (a send is a new request), which is
 *                  MSG-10, and it is all that check has ever needed.
 *   - `cutHard()` - the above AND the live socket closed, so the gateway really has no connection.
 *                  Required for a RECEIVER, because delivery goes down the socket: MSG-9's whole
 *                  premise is a device the server cannot reach. Needs `armCut()` first.
 *
 * `throttleUpload()` is NOT a third cut and is kept apart from both on purpose: nothing fails, the
 * app enters no offline path, and the only thing it changes is how long a request this client is
 * SENDING stays in flight. A check that needs to act while something is still uploading needs that
 * and not an outage - see DEL-4.
 */
import { evaluate, until } from './cdp.mjs';
import { awaitGatewayConnected } from './chat.mjs';

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
 * Caps the client's UPLOAD rate, and returns the function that lifts the cap.
 *
 * A CHECK THAT NEEDS AN OPERATION STILL IN FLIGHT MUST NOT RACE IT. DEL-4 deletes a conversation
 * while its media is uploading, and on a real link a small file is finished before the next gesture
 * lands - so the honest way to hold the request open is to make it slow BY CONSTRUCTION, not to
 * attach a bigger file and hope the timing falls the right way. `uploadThroughput` does exactly
 * that, and the window it opens is arithmetic a check can state before it runs: bytes / rate.
 *
 * DOWNLOAD AND LATENCY ARE LEFT ALONE, deliberately. The subject is a request this client is still
 * SENDING; throttling delivery as well would slow the peer's reaction to the very deletion under
 * test, and the measurement would then be about the harness. For the same reason this is NOT a cut:
 * `navigator.onLine` stays true, no request fails, and nothing in the app's offline path is entered -
 * so a check using it is measuring the upload, not the reconnect logic.
 *
 * @param cx a connected client
 * @param bytesPerSecond the ceiling, in bytes per second
 */
export async function throttleUpload(cx, bytesPerSecond) {
  await cx.send('Network.enable');
  await cx.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: bytesPerSecond,
  });
  return {
    bytesPerSecond,
    restore: async () => {
      await cx.send('Network.emulateNetworkConditions', ONLINE);
    },
  };
}

/**
 * THE PATCH THAT MAKES A REAL DISCONNECTION POSSIBLE FROM A BROWSER.
 *
 * `emulateNetworkConditions` fails every NEW request and leaves an ESTABLISHED WebSocket completely
 * alone. That is not a nuance, it is the whole difficulty, and it was measured rather than assumed
 * on 2026-08-13: W2 cut, `fetch` severed in 13 ms, and the gateway's `user:online:` key refreshed
 * without a gap for SIXTY SECONDS (TTL cycling 12-20 s, which is the app's 8 s heartbeat still
 * landing). So a browser client that has been "taken offline" is, to the thing that does the
 * delivering, perfectly connected - and MSG-9 sent its message to a receiver that was never offline
 * at all, which is how it came back INVALID.
 *
 * There is no CDP command that closes a live socket, and no accessor for the app's. So the socket is
 * captured at CONSTRUCTION - which means the patch has to be in the document BEFORE the app boots,
 * hence `armCut` reloading. Nothing about the app's behaviour is changed by it: closing a socket is
 * what a network drop does, and the app then sees exactly what it would see in the field.
 */
const CUT_PATCH = `(function () {
  if (window.__wsCut) return;
  var live = new Set();
  var Native = window.WebSocket;
  function Patched(url, protocols) {
    var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    live.add(ws);
    ws.addEventListener('close', function () { live.delete(ws); });
    return ws;
  }
  Patched.prototype = Native.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) { Patched[k] = i; });
  window.WebSocket = Patched;
  /** Closes every socket the page currently holds; returns how many. */
  window.__wsCut = function () {
    var n = 0;
    live.forEach(function (ws) { try { ws.close(4000, 'harness cut'); n++; } catch (e) {} });
    return n;
  };
  window.__wsLive = function () { return live.size; };
})()`;

/**
 * Installs {@link CUT_PATCH} and reloads, so a later {@link cutHard} has sockets to close.
 *
 * Call at the START of a check, before anything is opened or measured: the reload it costs is a
 * navigation, and a navigation is a disconnection - `goto`'s rule applies here too, which is why the
 * gateway line is waited for rather than a delay.
 */
export async function armCut(cx) {
  await cx.send('Page.enable');
  await cx.send('Network.enable');
  await cx.send('Page.addScriptToEvaluateOnNewDocument', { source: CUT_PATCH });
  const before = cx.events.length;
  await cx.send('Page.reload');
  await until(cx, `document.readyState === 'complete'`, 20000);
  const ms = await awaitGatewayConnected(cx, before);
  const armed = await evaluate(cx, `typeof window.__wsCut === 'function'`);
  if (!armed) throw new Error('the socket patch is not in the page after the reload - cutHard cannot work');
  return { gatewayBackAfterMs: ms };
}

/**
 * Takes a client REALLY offline: no new request, and no surviving socket either.
 *
 * The order is load-bearing. Offline goes on FIRST, so that the reconnect the app fires the instant
 * its socket closes cannot succeed; closing first would leave a window in which the client quietly
 * comes back and the check measures nothing. `restore` only lifts the emulation - the app reconnects
 * by itself, which is the behaviour under test.
 *
 * The caller still has to prove the gateway agrees (`awaitOffline`). This closes the socket; only
 * the far end can say the connection is gone.
 */
export async function cutHard(cx) {
  await cx.send('Network.enable');
  await cx.send('Network.emulateNetworkConditions', OFFLINE);
  const closed = Number(await evaluate(cx, `window.__wsCut ? window.__wsCut() : -1`));
  if (closed < 0) throw new Error('cutHard without armCut - no socket was captured, nothing was closed');
  return {
    socketsClosed: closed,
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
