#!/usr/bin/env node
/**
 * One-shot: banner transitions DURING the openChannel sequence, beside the console.
 *
 * At rest the banner never appears (synwatch: 481 samples, 0 transitions). So it is the opening
 * itself that syncs - the question is whether that sync is legitimate, how long it holds, and
 * whether the layout shift it causes overlaps the moment a click is dispatched at a channel row.
 */
import { client, evaluate } from '../chat.mjs';
import { realClick, until, RESOLVE } from '../cdp.mjs';
import { consoleLines, watch } from '../watch.mjs';
import { PORTS, VENUE } from '../names.mjs';

// `VENUE`, never a literal: on a prod-copy estate the old string named a REAL community belonging to
// two production users, and this probe would have opened theirs (measured 2026-09-04).
const COMMUNITY = VENUE.community;
const cx = await client(PORTS.W1);
const marks = [];
let stop = false;
const t0 = Date.now();

const PROBE = String.raw`(function () {
  var b = null, all = document.querySelectorAll('div');
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].innerText || '').trim();
    if (!/^(Synchronisation|En attente)/.test(t)) continue;
    var r = all[i].getBoundingClientRect();
    if (r.height > 0 && r.height < 60 && r.top < 120) { b = t.replace(/\s+/g, ' ').slice(0, 32); break; }
  }
  var m = document.querySelector('main');
  return (b ? 'ON ' + b : 'OFF') + ' mainTop=' + (m ? Math.round(m.getBoundingClientRect().top) : '?');
})()`;

const sampler = (async () => {
  let prev = null;
  while (!stop) {
    const s = await evaluate(cx, PROBE).catch(() => null);
    if (s && s !== prev) { marks.push(`${String(Date.now() - t0).padStart(6)}  ${s}`); prev = s; }
    await new Promise((r) => setTimeout(r, 25));
  }
})();

const step = (n) => marks.push(`${String(Date.now() - t0).padStart(6)}  --- ${n} ---`);
const w = await watch(cx, 'open');
await evaluate(cx, `location.href = '/communities'`);
await until(cx, `location.pathname === '/communities'`, 15000);
step('loaded /communities');
await until(cx, `!!${RESOLVE}('text=${COMMUNITY}')`, 20000);
step('community resolvable');
await realClick(cx, `text=${COMMUNITY}`);
step('community CLICKED');
await until(cx, `!!${RESOLVE}('text=general')`, 15000);
step('general resolvable');
const p = await realClick(cx, `text=general`);
step(`general CLICKED at ${p.x},${p.y} received="${p.received?.text}"`);
const comp = await until(cx, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 15000).catch(() => null);
step(`composer ${comp}ms`);
await new Promise((r) => setTimeout(r, 3000));
stop = true;
await sampler;

console.log('TIMELINE (ms):');
for (const m of marks) console.log('  ' + m);
console.log('\nCONSOLE:');
for (const l of consoleLines(cx)) console.log('  ' + l);
cx.close();
