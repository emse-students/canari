// Attach, run an action, and report console + failed network requests. §9 of the campaign wants
// evidence captured BEFORE deciding, and this is the web half of it.
import { connect, evaluate, listTargets, realClick } from './cdp.mjs';
const port = Number(process.argv[2]);
const selector = process.argv[3];
const [t] = await listTargets(port);
const cx = connect(t.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');
await cx.send('Log.enable');
await cx.send('Network.enable');
if (selector) {
  await realClick(cx, selector);
  await new Promise((r) => setTimeout(r, 4000));
}
for (const e of cx.events) {
  if (e.method === 'Runtime.consoleAPICalled') {
    console.log(`[console.${e.params.type}]`, e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220));
  } else if (e.method === 'Log.entryAdded') {
    console.log(`[log.${e.params.entry.level}]`, e.params.entry.text.slice(0, 220));
  } else if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
    console.log(`[net ${e.params.response.status}]`, e.params.response.url.slice(0, 160));
  } else if (e.method === 'Network.loadingFailed') {
    console.log('[net FAILED]', e.params.errorText);
  }
}
console.log('url:', await evaluate(cx, 'location.href'));
cx.close();
