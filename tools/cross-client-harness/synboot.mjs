#!/usr/bin/env node
/**
 * WP-BANNER-1's positive check: does the synchronisation banner rise AT STARTUP?
 *
 * `synwatch.mjs` samples an idle page and `synopen.mjs` samples a channel open. Neither covers the
 * window the fix was actually about. The deleted banner fired on `isMessagingInitializing`, which is
 * true on EVERY startup with no messages at all - so the claim owed is about the boot sequence, and
 * a check that never enters that window cannot refute or confirm it (testing-methodology rule 7).
 *
 * The window here is the whole of it: reload -> PIN modal -> unlock -> app ready -> messaging init
 * -> settle. The PIN is entered by spawning `pin.mjs`, so no secret is read, printed, or passed as
 * an argument here.
 *
 * WHAT IS MEASURED IS A TRANSITION, NOT A SAMPLE. A histogram of samples cannot tell one 0.7 s
 * appearance from a flicker; before the fix this window held ON at 480 ms, OFF at 2 286 ms and 29 px
 * of layout shift, which is what delivered a click aimed at a channel row to the button below it.
 * `mainTop` is recorded beside the banner because the displacement is the harm, not the pixels.
 *
 * PASS = zero ON transitions AND `mainTop` never moves after the app is ready.
 *
 *   node synboot.mjs [--device W1] [--settle 8000]
 */
import { spawn } from 'node:child_process';
import { client, evaluate } from './chat.mjs';
import { until } from './cdp.mjs';
import { consoleLines, watch } from './watch.mjs';
import { ACCOUNT_OF, PORTS } from './names.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.indexOf(`--${n}`) === -1 ? d : argv[argv.indexOf(`--${n}`) + 1]);
const device = opt('device', 'W1');
if (!PORTS[device]) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);
const port = PORTS[device];
const settleMs = Number(opt('settle', 8000));

/**
 * Banner presence, its text, and `main`'s top edge, in ONE read.
 *
 * Two reads could straddle the appearance and report a banner with the offset from before it, which
 * is the exact pair the fix is about. The filter is the same one `synwatch` uses - a strip under
 * 60 px high sitting in the first 120 px of the page - so the two instruments cannot disagree about
 * what counts as the banner.
 */
const PROBE = `(function () {
  var b = null, all = document.querySelectorAll('div');
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].innerText || '').trim();
    if (!/^(Synchronisation|En attente)/.test(t)) continue;
    var r = all[i].getBoundingClientRect();
    if (r.height > 0 && r.height < 60 && r.top < 120) { b = t.replace(/\\s+/g, ' ').slice(0, 40) + '|h=' + Math.round(r.height); break; }
  }
  var m = document.querySelector('main');
  return (b ? 'ON ' + b : 'OFF') + ' mainTop=' + (m ? Math.round(m.getBoundingClientRect().top) : '?');
})()`;

const cx = await client(port);
const w = await watch(cx, 'boot');
const t0 = Date.now();
const marks = [];
let stop = false;
let readyAt = null;

const at = () => String(Date.now() - t0).padStart(6);
const step = (n) => marks.push(`${at()}  --- ${n} ---`);

/**
 * The sampler must survive the navigation it is watching. A reload destroys the execution context,
 * so `evaluate` throws for as long as the new document takes to exist - and a sampler that dies
 * there reports "no banner" for the one window that matters. A failed read is recorded as a gap and
 * the loop continues.
 */
const sampler = (async () => {
  let prev = null;
  while (!stop) {
    const s = await evaluate(cx, PROBE).catch(() => null);
    if (s && s !== prev) {
      marks.push(`${at()}  ${s}`);
      prev = s;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
})();

step(`reloading ${device} (account ${ACCOUNT_OF[device]})`);
await cx.send('Page.reload', { ignoreCache: true });

// A RELOAD LANDS IN ONE OF TWO STATES AND THE CHECK MAY NOT ASSUME WHICH. With "Rester connecte"
// ticked the vault device key path restores the client with no modal at all; without it the PIN
// modal comes up. Waiting only for the modal burns the whole deadline on the vault path and then
// reports "ready in 2 ms" - a boot that had in fact finished 29 s earlier, i.e. a duration measured
// from the instrument's own wait. Race the two and let the answer say which happened.
const landed = await until(
  cx,
  `!!document.querySelector('#encryption-pin') || document.querySelectorAll('aside button, nav button').length > 0`,
  30000
).catch(() => null);
const pinUp = landed === null ? null : await evaluate(cx, `!!document.querySelector('#encryption-pin')`).then((v) => (v ? landed : null));
step(landed === null ? 'NEITHER PIN MODAL NOR APP within 30 s' : pinUp !== null ? `PIN modal up (${landed}ms)` : `restored with no PIN - vault path (${landed}ms)`);

if (pinUp !== null) {
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['pin.mjs', '--device', device], {
      cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: 'ignore',
    });
    p.on('close', resolve);
  });
  step(`pin.mjs exited ${code}`);
}

const ready = await until(cx, `!document.querySelector('#encryption-pin') && document.querySelectorAll('aside button, nav button').length > 0`, 30000).catch(() => null);
readyAt = ready === null ? null : Date.now() - t0;
step(ready === null ? 'APP NEVER READY within 30 s' : `app ready (${ready}ms)`);

await new Promise((r) => setTimeout(r, settleMs));
step('settle over');
stop = true;
await sampler;

console.log(`\nBOOT TIMELINE on ${device} (ms from start):`);
for (const m of marks) console.log('  ' + m);

// A transition INTO the banner is the defect; the offsets are how much it would have moved.
const on = marks.filter((m) => / ON /.test(m));
const tops = marks
  .filter((m) => /mainTop=/.test(m))
  .map((m) => ({ at: Number(m.trim().split(/\s+/)[0]), top: Number(m.match(/mainTop=(-?\d+)/)?.[1]) }))
  .filter((t) => Number.isFinite(t.top));
// A MARK IS A CHANGE, NOT A SAMPLE - so an offset that never moves emits NOTHING after the app is
// ready, and counting marks in that window as evidence scores the good case as the bad one. What is
// forbidden is a CHANGE after ready; before it, `main` legitimately goes from absent to mounted.
//
// AND THE MARK IS A CHANGE IN THE WHOLE PROBE, NOT IN THE OFFSET. A mark fires when the banner text
// changes too, so a banner rising over a layout that does not move emits two marks both reading the
// same `mainTop` - which counted as two movements on A1 and turned "the strip does not displace
// anything on mobile" into a fault. Compare the VALUES and drop consecutive equals.
const afterReady = readyAt === null ? [] : tops.filter((t) => t.at >= readyAt);
const lastBefore = readyAt === null ? null : [...tops].reverse().find((t) => t.at < readyAt)?.top ?? null;
const movedAfterReady = afterReady.filter((t, i) => t.top !== (i === 0 ? lastBefore : afterReady[i - 1].top));
const settledTop = tops.length ? tops[tops.length - 1].top : null;

console.log(`\nBANNER APPEARANCES: ${on.length}`);
for (const m of on) console.log('  ' + m);
console.log(`mainTop settled at ${settledTop}px; ${movedAfterReady.length} change(s) after ready`);
for (const t of movedAfterReady) console.log(`  moved to ${t.top} at ${t.at}ms`);

const lines = consoleLines(cx);
console.log(`\nCONSOLE, ${lines.length} line(s) across the whole boot:`);
for (const l of lines) console.log('  ' + l);

const pass = on.length === 0 && movedAfterReady.length === 0 && ready !== null && settledTop !== null;
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} - banner rose ${on.length} time(s), layout moved ${movedAfterReady.length} time(s) after ready`);
cx.close();
process.exit(pass ? 0 : 1);
