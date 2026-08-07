import { connect, evaluate, listTargets } from './cdp.mjs';
const port = Number(process.argv[2]);
const match = process.argv[3] || null;
const targets = await listTargets(port);
const t = match ? targets.find((x) => x.url.includes(match)) : targets[0];
if (!t) { console.log(JSON.stringify(targets.map((x) => x.url))); throw new Error('no target'); }
const cx = connect(t.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');
const out = await evaluate(cx, `JSON.stringify({
  url: location.href,
  title: document.title,
  locked: document.body.innerText.indexOf('PIN de chiffrement') !== -1,
  text: document.body.innerText.replace(/\s+/g,' ').slice(0, 600)
})`);
console.log(`[${port}] ${t.url}`);
console.log(out);
cx.close();
