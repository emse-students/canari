/**
 * Asks a BENCH iPhone build about its own native stores - the `bench_native_store` command, invoked in
 * the app's WebView over the WebKit inspector bridge, one answer as one JSON line on stdout.
 *
 * WHY THE APP IS ASKED. The MLS state, the Graine mirror and the refresh credential live in the app's
 * data container and in the App Group `group.fr.emse.canari`, which no lockdown service vends, so the
 * rig has no `run-as` to read them with. The command exists only in a `local_url` build
 * (`bench-observables`, asserted absent from every store archive); on any other build the answer is
 * Tauri's own refusal, carried verbatim as `{ error }` (docs/wiki/cross-client-ios.md, O5/O15).
 *
 * SPAWNED, NOT IMPORTED: `phone-ios.mjs`'s native readers are SYNCHRONOUS, as `phone.mjs`'s are, and
 * a WebSocket round trip is not - so they run this as a child, the way `pinspawn.mjs` runs `pin.mjs`.
 *
 * NO `awaitPromise`. The command is a promise, and whether the bridge forwards CDP's `awaitPromise`
 * to WebKit (whose `Runtime.evaluate` has no such parameter) is not something to find out by
 * reading `{}`. So the call is STARTED by one evaluate, which parks its outcome on `window`, and
 * COLLECTED by polling a second one - two synchronous expressions both engines answer the same way.
 *
 *   bun iosbench.mjs --port 9444 --op list
 *   bun iosbench.mjs --port 9444 --op graine --channel <uuid>
 *   bun iosbench.mjs --port 9444 --op damage --mode flip
 *
 * The answer is `{ ok: <value> }` or `{ error }`; this process exits 0 either way, because an error
 * is the instrument's answer and the caller (`phone-ios.mjs nativeStore`) reports it as one.
 */
import { connect, listTargets } from './cdp.mjs';

/** The iPhone WebView's origin - `phone-ios.mjs`'s `WEBVIEW_MATCH`, repeated so this imports nothing that reads names.mjs. */
const ORIGIN = 'tauri://localhost';
/** The `window` property the outcomes are parked under, by call id. */
const SLOT = '__canariBench';

/**
 * The expression that STARTS the call and returns at once. Its outcome lands in
 * `window.__canariBench[id]` as `{ ok }` or `{ error }`; a page with no Tauri runtime answers that
 * synchronously, so the poll never waits on a call that could not be made.
 *
 * @param {string} id a slot no other call uses
 * @param {Record<string, unknown>} args the command's arguments (`op`, `channelId`, `mode`)
 */
export function kickoffExpression(id, args) {
  const slot = JSON.stringify(id);
  return `(function () {
  var w = window;
  var parked = (w.${SLOT} = w.${SLOT} || {});
  var I = w.__TAURI_INTERNALS__;
  if (!I || typeof I.invoke !== 'function') {
    parked[${slot}] = { error: 'no Tauri runtime on this page' };
    return 'started';
  }
  parked[${slot}] = null;
  I.invoke('bench_native_store', ${JSON.stringify(args)}).then(
    function (r) { parked[${slot}] = { ok: r }; },
    function (e) { parked[${slot}] = { error: String((e && e.message) || e) }; }
  );
  return 'started';
})()`;
}

/** The expression that COLLECTS: the outcome as JSON once it is there (and forgets it), else null. */
export function pollExpression(id) {
  const slot = JSON.stringify(id);
  return `(function () {
  var parked = window.${SLOT};
  var v = parked && parked[${slot}];
  if (v == null) return null;
  delete parked[${slot}];
  return JSON.stringify(v);
})()`;
}

/** The command's arguments from the CLI's, dropping what was not given. */
export function commandArgs({ op, channel, mode }) {
  const args = { op };
  if (channel) args.channelId = channel;
  if (mode) args.mode = mode;
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const port = Number(opt('port'));
  const op = opt('op');
  const timeoutMs = Number(opt('timeout') ?? 60_000);
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (!port || !op) {
    say({ error: 'usage: bun iosbench.mjs --port <PORTS.I1> --op <op> [--channel <id>] [--mode truncate|flip]' });
    return;
  }

  let targets;
  try {
    targets = await listTargets(port);
  } catch (e) {
    say({ error: `the inspector bridge on ${port} does not answer (${String(e?.message ?? e).slice(0, 120)}) - run pymobiledevice3 webinspector cdp --port ${port}` });
    return;
  }
  const page = targets.find((t) => String(t.url ?? '').startsWith(ORIGIN));
  if (!page) {
    say({ error: `no ${ORIGIN} page on the bridge at ${port} - the app must be running and in front, on a BENCH build (ios.yml local_url)` });
    return;
  }

  const cx = connect(page.webSocketDebuggerUrl);
  try {
    await cx.ready;
    const evaluate = async (expression) => {
      const r = await cx.send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails || r.wasThrown) throw new Error(`page exception: ${JSON.stringify(r.result ?? r.exceptionDetails).slice(0, 200)}`);
      return r.result?.value;
    };
    const id = `b${process.pid}-${Date.now()}`;
    await evaluate(kickoffExpression(id, commandArgs({ op, channel: opt('channel'), mode: opt('mode') })));
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const got = await evaluate(pollExpression(id));
      if (typeof got === 'string') {
        say(JSON.parse(got));
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    say({ error: `bench_native_store ${op} did not answer within ${timeoutMs}ms` });
  } catch (e) {
    say({ error: `the WebView could not be asked: ${String(e?.message ?? e).slice(0, 200)}` });
  } finally {
    cx.close();
  }
}

if (import.meta.main) await main();
