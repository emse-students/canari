#!/usr/bin/env bun
/**
 * Evaluates the bench in one inspectable page over CDP (a Chrome tab, an Android WebView through
 * `adb forward`, or the iPhone through `pymobiledevice3 webinspector cdp`).
 *
 *   bun inject.mjs <ws-url> start '<cfg json>'   set window.__LB_CFG and run bench.js
 *   bun inject.mjs <ws-url> eval '<expression>'  evaluate and print the JSON value
 */
import { readFileSync } from 'node:fs';

// The target is a ws url, or `<port>:<url substring>` resolved now (a WebKit bridge renumbers).
const [where, cmd, arg] = process.argv.slice(2);
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
const expression =
  cmd === 'start'
    ? `window.__LB_CFG = ${arg};\n${readFileSync(new URL('./bench.js', import.meta.url), 'utf8')}`
    : arg;
const r = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
});
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
sock.close();
process.exit(0);
