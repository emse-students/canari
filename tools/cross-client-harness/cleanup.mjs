// Remove the test channel created in the real MiTV association before settling on a dedicated
// community. Leaving it there would put campaign traffic in front of four real admins.
import { activate, connect, evaluate, listTargets } from './cdp.mjs';
const [t] = await listTargets(9224);
const cx = connect(t.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await activate(cx, "button[title='MiTV']");
await sleep(1200);
const opened = await evaluate(cx, `(function () {
  var b = [].filter.call(document.querySelectorAll('button'), function (x) { return x.innerText.trim() === 'test-campagne'; })[0];
  if (!b) return 'absent';
  b.click();
  return 'opened';
})()`);
console.log('channel:', opened);
if (opened === 'absent') process.exit(0);
await sleep(1200);

await activate(cx, "[aria-label='Paramètres du canal']");
await sleep(900);
console.log('delete:', await activate(cx, 'text=Supprimer le canal'));
await sleep(900);
console.log(await evaluate(cx, 'document.body.innerText.replace(/\s+/g," ").slice(-260)'));
cx.close();
