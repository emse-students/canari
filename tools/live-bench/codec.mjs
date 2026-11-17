#!/usr/bin/env bun
/**
 * Drives `codec-bench.js` in one inspectable page over CDP (the Mi 9T app WebView through
 * `adb forward`, iPhone Safari through `pymobiledevice3 webinspector cdp`, a Chrome tab).
 *
 *   bun codec.mjs <target> matrix                      the codec support matrix (JSON)
 *   bun codec.mjs <target> mr <w> <h> <bps> [durS] [src]                 one MediaRecorder run, waits, prints the result
 *   bun codec.mjs <target> wc <codec> <w> <h> <bps> [durS] [mode] [hw] [src]   one VideoEncoder run
 *   (src: `camera`, the default, or `synthetic`, a seeded busy scene panned at 2 px a frame)
 *   bun codec.mjs <target> show <i> [atS]               decode result i and show its frame full screen
 *   bun codec.mjs <target> preview [w] [h] | clear | state
 *
 * <target> is a ws:// url or `<port>:<url substring>`. Each run result is printed as one JSON line;
 * append them to a file to keep a sitting. The page is (re)loaded with codec-bench.js on every call
 * (a no-op when already there), so a reloaded page needs nothing else.
 */
import { readFileSync } from 'node:fs';

const [where, cmd, ...args] = process.argv.slice(2);
let ws = where;
if (!where.startsWith('ws://')) {
  const port = where.slice(0, where.indexOf(':'));
  const match = where.slice(where.indexOf(':') + 1);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes(match));
  if (!t) throw new Error(`no page on ${port} matching ${match}`);
  ws = t.webSocketDebuggerUrl;
}
const sock = new WebSocket(ws);
await new Promise((r, j) => {
  sock.onopen = r;
  sock.onerror = j;
});
let id = 0;
const send = (method, params) =>
  new Promise((res) => {
    const my = ++id;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === my) {
        sock.removeEventListener('message', h);
        res(m);
      }
    };
    sock.addEventListener('message', h);
    sock.send(JSON.stringify({ id: my, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(JSON.stringify(ex).slice(0, 600));
  return r.result?.result?.value;
};
const src = readFileSync(new URL('./codec-bench.js', import.meta.url), 'utf8');
await evaluate(`window.__CB_SRC = ${JSON.stringify(String(Bun.hash(src)))};
${src}`);

/**
 * Runs an async page expression and polls its settled value: the WebKit bridge answers an awaited
 * promise with `{}`, so the value is parked on the page and read back synchronously.
 */
async function settle(expression) {
  await evaluate(
    `(__CB.out = null, Promise.resolve().then(() => ${expression}).then((v) => (__CB.out = { v }), (e) => (__CB.out = { e: String((e && e.stack) || e) })), 0)`
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const o = await evaluate('__CB.out');
    if (o) {
      if ('e' in o) throw new Error(o.e);
      return o.v;
    }
  }
}
const num = (x, d) => (x === undefined ? d : Number(x));
async function runAndWait(kind, opts) {
  const before = (await evaluate('__CB.state()')).results.length;
  const s = await evaluate(`__CB.start(${JSON.stringify(kind)}, ${JSON.stringify(opts)})`);
  if (s !== 'started') throw new Error(`bench ${s}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await evaluate('__CB.state()');
    if (!st.busy && st.results.length > before) return st.results[st.results.length - 1];
  }
}

let out;
if (cmd === 'matrix') out = await settle('__CB.matrix()');
else if (cmd === 'mr')
  out = await runAndWait('mr', {
    w: num(args[0]),
    h: num(args[1]),
    bps: num(args[2]),
    durS: num(args[3], 60),
    src: args[4] || 'camera',
  });
else if (cmd === 'wc')
  out = await runAndWait('wc', {
    codec: args[0],
    w: num(args[1]),
    h: num(args[2]),
    bps: num(args[3]),
    durS: num(args[4], 60),
    mode: args[5] || 'constant',
    hw: args[6] || 'prefer-hardware',
    src: args[7] || 'camera',
  });
else if (cmd === 'show') out = await settle(`__CB.show(${num(args[0])}, ${num(args[1], 30)})`);
else if (cmd === 'preview') out = await settle(`__CB.preview(${num(args[0], 1280)}, ${num(args[1], 720)})`);
else if (cmd === 'clear') out = await evaluate('__CB.clear()');
else if (cmd === 'state') out = await evaluate('__CB.state()');
else throw new Error(`unknown command ${cmd}`);
console.log(JSON.stringify(out));
sock.close();
process.exit(0);
