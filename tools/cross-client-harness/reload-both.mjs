// Reload W1 and W2 onto the freshly deployed bundle. A long-lived tab keeps its old bundle,
// so every post-deploy measurement made in one measures the OLD build - that alone failed a
// TAB-4 re-run once already.
import { listTargets, connect, evaluate } from './cdp.mjs';

for (const [name, port] of [['W1', 9224], ['W2', 9223]]) {
  const targets = await listTargets(port);
  const t = targets.find((x) => String(x.url).includes('canari-emse.fr')) || targets[0];
  if (!t) { console.log(`${name} (${port}): NO TARGET`); continue; }
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  const before = await evaluate(cx, `location.href`);
  await cx.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 10000));
  const after = await evaluate(cx, `JSON.stringify({href: location.href, ready: document.readyState, title: document.title, pinModal: !!document.querySelector('[data-testid=pin-modal], .pin-modal') })`);
  console.log(`${name} (${port}) ${before}\n   -> ${after}`);
  cx.close();
}
