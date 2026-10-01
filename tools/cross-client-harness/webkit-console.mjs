/**
 * THE iPHONE'S CONSOLE IN THE SHAPE THE CLASSIFIER READS - WebKit's `Console.messageAdded` as CDP's
 * `Log.entryAdded`.
 *
 * A row is `PASS` only if its window is CLEAN on every client, and `watch.mjs` reads a client's
 * console from `Runtime.consoleAPICalled` and `Log.entryAdded`. The iPhone's WebView answers the
 * WebKit inspector protocol (through `pymobiledevice3 webinspector cdp`), which has neither: every
 * console line, uncaught error and failed load arrives as ONE event, `Console.messageAdded`. Without
 * this the iPhone's window is empty by construction - every row on it would read clean whatever the
 * app said, which is a gate that cannot fail.
 *
 * ONE TRANSLATION, AT THE READ, and nothing else in the classifier changes: every rule, every
 * expected-line needle and the network join (`networkRequestId`) apply to the iPhone's lines exactly
 * as to Chrome's. `watch()` asks the PAGE whether it is WebKit (its user agent) and enables `Console`
 * instead of `Log`, which the WebKit protocol does not have.
 *
 * The WebKit field names are the protocol's (`source`, `level`, `text`, `url`, `line`,
 * `networkRequestId`, `timestamp` in seconds); the first live window on the iPhone confirms them
 * (docs/wiki/cross-client-ios.md).
 */

/** WebKit console levels onto CDP Log levels. */
const LEVEL = { log: 'info', info: 'info', debug: 'verbose', warning: 'warning', error: 'error' };

/** WebKit sources onto CDP Log sources; `network` is the one the request join depends on. */
const SOURCE = { 'console-api': 'javascript', javascript: 'javascript', network: 'network', security: 'security', storage: 'storage', rendering: 'rendering', other: 'other' };

/**
 * `e` unchanged unless it is a WebKit `Console.messageAdded`, which comes back as a `Log.entryAdded`.
 * @param {{ method: string, params?: object }} e one inspector event
 */
export function fromWebKit(e) {
  if (e?.method !== 'Console.messageAdded') return e;
  const m = e.params?.message ?? {};
  const ts = typeof m.timestamp === 'number' ? (m.timestamp > 1e11 ? m.timestamp : m.timestamp * 1000) : undefined;
  return {
    method: 'Log.entryAdded',
    webkit: true,
    params: {
      entry: {
        source: SOURCE[m.source] ?? 'other',
        level: LEVEL[m.level] ?? m.level ?? 'info',
        text: String(m.text ?? ''),
        url: m.url,
        lineNumber: typeof m.line === 'number' ? m.line - 1 : undefined,
        networkRequestId: m.networkRequestId,
        timestamp: ts,
      },
    },
  };
}

/** Whether a user agent is WebKit's WebView rather than a Chromium one (which also says "AppleWebKit"). */
export const isWebKitAgent = (ua) => /AppleWebKit/.test(ua ?? '') && !/Chrome|Chromium|CriOS/.test(ua ?? '');
