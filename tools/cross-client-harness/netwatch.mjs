/**
 * Runs a page action while recording every request/response and console message.
 *
 * The evidence rule of the campaign (section 9): decide from a capture, never from a screenshot or
 * a guess. `node netwatch.mjs <port> "<js action>" [settleMs]`.
 */
import { connect, evaluate, listTargets } from './cdp.mjs';

const port = Number(process.argv[2]);
const action = process.argv[3];
const settle = Number(process.argv[4] || 2500);
const match = process.argv[5] || null;

const targets = await listTargets(port);
const t = match ? targets.find((x) => x.url.includes(match)) : targets[0];
const cx = connect(t.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');
await cx.send('Network.enable');
await cx.send('Log.enable');

const reqs = new Map();
const lines = [];
const raw = cx.events;
const drain = () => {
  while (raw.length) {
    const e = raw.shift();
    if (e.method === 'Network.requestWillBeSent') reqs.set(e.params.requestId, { url: e.params.request.url, method: e.params.request.method });
    else if (e.method === 'Network.responseReceived') {
      const r = reqs.get(e.params.requestId);
      if (r) r.status = e.params.response.status;
    } else if (e.method === 'Network.loadingFailed') {
      const r = reqs.get(e.params.requestId);
      if (r) r.failed = e.params.errorText;
    } else if (e.method === 'Runtime.consoleAPICalled') {
      lines.push(`console.${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)}`);
    } else if (e.method === 'Log.entryAdded') {
      lines.push(`log.${e.params.entry.level}: ${e.params.entry.text.slice(0, 300)}`);
    }
  }
};

const before = Date.now();
const result = action ? await evaluate(cx, action) : null;
await new Promise((r) => setTimeout(r, settle));
drain();

const interesting = [...reqs.values()].filter((r) => !/\.(js|css|woff2?|png|svg|jpg|ico)(\?|$)/.test(r.url));
console.log(JSON.stringify({ action: result, ms: Date.now() - before, requests: interesting, console: lines }, null, 1));
cx.close();
