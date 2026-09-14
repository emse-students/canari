import { connect, evaluate, listTargets } from './cdp.mjs';
import { PORTS } from './names.mjs';

const targets = await listTargets(PORTS.A1);
const cx = connect(targets[0].webSocketDebuggerUrl);
await cx.ready;

const js = `(() => {
  const R = (el) => { const b = el.getBoundingClientRect();
    return Math.round(b.left) + '-' + Math.round(b.right) + ' @' + Math.round(b.top); };
  const link = document.querySelector('svg.lucide-link');
  const out = [];
  let n = link;
  for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
    out.push({ tag: n.tagName.toLowerCase(), cls: (n.getAttribute('class') || '-').slice(0, 90), box: R(n) });
  }
  const name = Array.from(document.querySelectorAll('a')).find((a) => (a.textContent || '').trim() === 'BDE - Bureau des Élèves');
  const nameChain = [];
  let p = name;
  for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
    nameChain.push({ tag: p.tagName.toLowerCase(), cls: (p.getAttribute('class') || '-').slice(0, 90), box: R(p) });
  }
  return JSON.stringify({ fromLinkIcon: out, fromName: nameChain }, null, 1);
})()`;

console.log(await evaluate(cx, js));
cx.close?.();
process.exit(0);
