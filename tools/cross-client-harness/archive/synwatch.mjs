#!/usr/bin/env node
/**
 * One-shot: does the "Synchronisation des messages..." banner appear when NOTHING is happening?
 *
 * `isBackgroundSyncing` is `isMessagingInitializing || isCatchupOverlayVisible`, and the banner sits
 * IN THE LAYOUT FLOW - so every appearance shoves the sidebar down by its own height, which is how a
 * click aimed at a channel row reached the "Ajouter un canal" button below it. A histogram of
 * samples cannot tell one 0.7 s appearance from a flicker, so record TRANSITIONS, and put the
 * console beside them: a sync outside startup, with nothing sent, has to be explained by a log line
 * or it is a defect.
 *
 * Touches nothing. The page is left exactly where it was.
 *
 *   bun synwatch.mjs [--port 9224] [--ms 30000]
 */
import { client, evaluate } from '../chat.mjs';
import { consoleLines, watch } from '../watch.mjs';
import { PORTS } from '../names.mjs';

const argv = process.argv.slice(2);
const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : PORTS.W1;
const ms = argv.includes('--ms') ? Number(argv[argv.indexOf('--ms') + 1]) : 30000;

const cx = await client(port);
const w = await watch(cx, 'banner');
const t0 = Date.now();

/** Presence and height of the banner, plus the sidebar's own top edge, in one read. */
const PROBE = `(function () {
  var banner = null;
  var all = document.querySelectorAll('div');
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].innerText || '').trim();
    if (!/^(Synchronisation|En attente)/.test(t)) continue;
    var r = all[i].getBoundingClientRect();
    if (r.height > 0 && r.height < 60 && r.top < 120) { banner = t.replace(/\\s+/g, ' ').slice(0, 40) + '|h=' + Math.round(r.height); break; }
  }
  var main = document.querySelector('main');
  return JSON.stringify({
    banner: banner,
    url: location.pathname,
    mainTop: main ? Math.round(main.getBoundingClientRect().top) : null
  });
})()`;

const marks = [];
let prev = null;
let samples = 0;
while (Date.now() - t0 < ms) {
  const s = JSON.parse(await evaluate(cx, PROBE));
  samples++;
  const now = s.banner ? `ON ${s.banner} mainTop=${s.mainTop}` : `OFF mainTop=${s.mainTop}`;
  if (prev === null || now.split(' ')[0] !== prev.split(' ')[0] || s.banner !== (prev.banner ?? null)) {
    marks.push({ at: Date.now() - t0, state: now });
  }
  prev = now;
  await new Promise((r) => setTimeout(r, 50));
}

console.log(`${samples} samples over ${ms} ms on ${port}, doing nothing.\n`);
console.log('BANNER TRANSITIONS (ms from start):');
if (marks.length <= 1) console.log(`  none after the initial ${marks[0]?.state ?? '(no read)'}`);
for (const m of marks) console.log(`  ${String(m.at).padStart(6)}  ${m.state}`);

const lines = consoleLines(cx);
console.log(`\nCONSOLE, ${lines.length} line(s) in the same window:`);
for (const l of lines) console.log(`  ${l}`);
cx.close();
