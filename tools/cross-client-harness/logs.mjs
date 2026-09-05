#!/usr/bin/env bun
/**
 * READS THE LOGS OF ONE SUBJECT - a web client, the phone, or the estate - and classifies them.
 *
 * The rig has had three observers for months and no command over any of them: `watch()` + `report()`
 * for a browser console, `logcatSince()` + `logcatReport()` for the phone, and `srvReport()` for the
 * services. Only the third had a CLI. So "show me what that client just said" meant writing a
 * throwaway script, which is the duplication this tidy exists to end - I wrote one myself earlier
 * today and then could not reproduce the line it caught.
 *
 * Usage:
 *   bun logs.mjs --device W1                  the client's console, watched for 10 s
 *   bun logs.mjs --device W1 --for 30000      ... for 30 s
 *   bun logs.mjs --android --logcat           the phone's logcat, the last 60 s
 *   bun logs.mjs --device A1 --logcat --since 300000
 *   bun logs.mjs --server                     every service, the last 10 minutes
 *   bun logs.mjs --server --since 45m
 *   bun logs.mjs --device W1 --grep ROSTER    only lines matching, in any of the three
 *   bun logs.mjs --device W1 --raw            every line, unclassified
 *
 * **THE ASYMMETRY IS THE ONE THING TO KNOW, AND IT COSTS A MEASUREMENT WHEN IT IS FORGOTTEN.** The
 * phone and the estate are read BACKWARD - logcat keeps a ring buffer and `docker logs` keeps the
 * lot, so `--since` reaches into the past. A WEB CLIENT KEEPS NO BUFFER AT ALL: `appendLog` in
 * `globalChatSingleton.svelte.ts` writes straight to `console.log` and stores nothing, so a line is
 * only observable by an observer that was ALREADY ATTACHED when it was printed. This command
 * therefore attaches and waits for `--for` milliseconds; it cannot show you the past of a browser,
 * and no flag will make it.
 *
 * Measured, 2026-09-04: a `[ROSTER]` line proving a repair had fired scrolled past during a reload
 * captured with `tail -60`, and recovering it needed the whole condition to be reproduced from
 * scratch - because there was nowhere in the page to read it back from. Reproduce, or attach first.
 *
 * IT CLASSIFIES BY DEFAULT AND THE BUCKETS ARE THE SAME THREE WAYS. `report()` and `logcatReport()`
 * already return the six buckets `dirtOf` reads, and `srvReport()` returns its own per service, so a
 * reader learns one vocabulary: `severe`, `errors`, `exceptions`, `badHttp`, `wsEvents`,
 * `unexplained`, plus `notable` which never breaks clean. `--raw` is the escape hatch for when the
 * classifier is the thing under suspicion - a verdict must never be computed over a projection of
 * its own evidence, which is why `consoleLines()` exists beside `report()`.
 *
 * EXIT CODE IS THE VERDICT: 0 clean, 1 not. So this is usable in a preflight, not only by hand.
 */
import { client } from './chat.mjs';
import { armIfPhone, resolveDevice, tabMatchFor } from './device.mjs';
import { consoleLines, dirtOf, logcatReport, logcatSince, report, watch } from './watch.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const wantServer = argv.includes('--server');
const wantLogcat = argv.includes('--logcat');
const raw = argv.includes('--raw');
const grep = opt('grep', null);
const needle = grep ? new RegExp(grep, 'i') : null;

/**
 * Prints one bucketed report, and answers whether its SUBJECT was clean.
 *
 * **THE VERDICT IS READ, NEVER RECOMPUTED, AND GETTING THAT WRONG IS WHY THIS DOCBLOCK EXISTS.**
 * The first version derived cleanliness from `dirtOf(rep)` being empty, which is a different
 * question than the one `dirtOf` answers: it collects WHAT SHOULD TRAVEL WITH A RECORDED ROW, and
 * that deliberately includes `notable` - the bucket whose whole definition is that it never breaks
 * clean, because it holds the lines that EXPLAIN a finding. So `media-service`, carrying one
 * routine `Purged 1 expired media object(s)`, was rendered as a finding while its own report said
 * `clean`. Measured against `srvlog.mjs` on 2026-09-04, which disagreed and was right.
 *
 * It also printed `notable` twice - once because `dirtOf` had put it there, once from a block of
 * its own - and iterated `notableCount`, a NUMBER, as though it were a list of lines. That did not
 * throw only because `(5).length` is `undefined` and the loop skipped it, which is luck rather than
 * correctness and would have hidden a real bucket the day one was named similarly.
 *
 * Every report this command handles - `report()`, `logcatReport()` and each service of
 * `srvReport()` - already carries its own `clean`. Ask it.
 */
function renderBuckets(label, rep) {
  const dirt = dirtOf(rep);
  const clean = rep.clean !== false;
  for (const [bucket, lines] of Object.entries(dirt)) {
    // `dirtOf` mixes counts in beside the lists (`notableCount`), and `notable` is rendered below
    // with the caveat it needs, so neither belongs in this loop.
    if (!Array.isArray(lines) || bucket === 'notable') continue;
    const shown = needle ? lines.filter((l) => needle.test(String(l))) : lines;
    if (!shown.length) continue;
    console.log(`\n== ${label} - ${bucket} (${shown.length})`);
    for (const l of shown) console.log(`  ${String(l).slice(0, 240)}`);
  }
  // `notable` never breaks clean, but it is usually where the line explaining a severe one is - so
  // it is shown for a DIRTY subject and suppressed for a clean one, where it is only volume.
  if (!clean && rep.notable?.length) {
    const shown = needle ? rep.notable.filter((l) => needle.test(String(l))) : rep.notable;
    if (shown.length) {
      console.log(`\n== ${label} - notable (${shown.length}, does not break clean)`);
      for (const l of shown.slice(-20)) console.log(`  ${String(l).slice(0, 240)}`);
    }
  }
  if (clean) console.log(`[${label}] clean - every line is one we have read and named`);
  return clean;
}

if (wantServer) {
  // LAZY, because reaching the estate needs the out-of-tree `names.mjs` and the client half does
  // not. A top-level import would make `--device W1` fail on a checkout with no estate configured,
  // for a reason that has nothing to do with the client being asked about.
  const { srvReport, srvSummary } = await import('./srvlog.mjs');
  const since = String(opt('since', '10m'));
  console.log(`[logs] estate, last ${since}`);
  const rep = srvReport(since, { raw });
  console.log(srvSummary(rep).join('\n'));
  if (!rep.clean) {
    for (const [service, v] of Object.entries(rep)) {
      if (!v || typeof v !== 'object') continue;
      renderBuckets(service, v);
    }
  }
  console.log(rep.clean ? '\nSERVER CLEAN' : '\nSERVER NOT CLEAN');
  process.exit(rep.clean ? 0 : 1);
}

const target = resolveDevice(argv);
const label = `logs:${target.device ?? target.port}`;

if (wantLogcat) {
  if (!target.isPhone) {
    // A MISUSE IS NOT A CRASH. A stack trace here says "the tool broke" about a tool that is working
    // perfectly and being pointed at the wrong subject; the reader needs the sentence, not the frame.
    console.error(
      `[${label}] --logcat reads an ANDROID log, and ${target.device ?? 'this target'} is a browser.` +
        ` Drop --logcat for its console, or pass --android / --device A1.`,
    );
    process.exit(2);
  }
  // The binding must happen BEFORE the read: `logcatSince` resolves the serial per call now, and
  // `useDevice` is what tells it which phone this run is about. Without it a two-phone bench reads
  // the wrong device's log and says nothing - see `serial.mjs`.
  await armIfPhone(target, label);
  const sinceMs = Number(opt('since', 60_000));
  console.log(`[${label}] logcat, last ${sinceMs}ms`);
  const lines = await logcatSince(Date.now() - sinceMs);
  if (raw) {
    for (const l of needle ? lines.filter((x) => needle.test(x)) : lines) console.log(l);
    process.exit(0);
  }
  const rep = logcatReport(lines, target.device ?? 'A1');
  console.log(`[${label}] ${lines.length} line(s) captured`);
  process.exit(renderBuckets(label, rep) ? 0 : 1);
}

// The client console: attach, wait, classify. There is no past to read.
await armIfPhone(target, label);
const forMs = Number(opt('for', 10_000));
const cx = await client(target.port, tabMatchFor(target));
const w = await watch(cx, label);
console.log(`[${label}] attached - watching for ${forMs}ms (a browser keeps no buffer, so this is`);
console.log(`[${label}] the only window there is; reproduce what you want to see now)`);
await new Promise((r) => setTimeout(r, forMs));

if (raw) {
  const lines = consoleLines(cx).map((l) => l.text ?? l);
  for (const l of needle ? lines.filter((x) => needle.test(x)) : lines) console.log(l);
  cx.close();
  process.exit(0);
}

const rep = await report(w);
const clean = renderBuckets(label, rep);
cx.close();
process.exit(clean ? 0 : 1);
