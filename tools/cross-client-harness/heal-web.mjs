#!/usr/bin/env node
/**
 * HEAL on the BROWSER: a group broken by a deliberate ratchet rewind - does it repair itself, and
 * WHICH mechanism repairs it?
 *
 * Everything WP-PENDING-2 and WP-DRAIN-1 established was established on the phone. The fixes are
 * shared TypeScript, but "the same code" is an argument, not a measurement.
 *
 * The break is the one the whole campaign has been chasing, done on purpose: restore an older copy
 * of W1's MLS state, so W1 re-sends at generations W2 has already consumed (WP-LOSS-1's shape).
 * W1 must be RELOADED afterwards or the in-memory client simply writes the current state back over
 * the restored one - and that reload is also what empties `recentSends`, which is itself part of
 * what this measures.
 *
 * The verdict must distinguish the TWO repairs, because both leave a message on screen and only one
 * is WP-HIST-3 (see cross-client-testing 9.1):
 *   - narrow  : `[MLS] ... retransmitting N payload(s)` on the SENDER, driven by `decrypt_failed`
 *   - the diff: `[MLS] Retransmission has not repaired ... - escalating`, then `[HISTORY_REQ]`
 * A check that does not name which one fired has not exercised the difference.
 */
import { client, openConversation, send, evaluate, markers } from './chat.mjs';
import { watch } from './watch.mjs';
import { mark } from './results.mjs';
import { execFileSync } from 'node:child_process';
import { peerNameFor } from './names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REWIND_SENDS = Number(process.env.REWIND_SENDS || 12);
const BREAK_SENDS = Number(process.env.BREAK_SENDS || 14);
const BREAK_SPACING_MS = Number(process.env.BREAK_SPACING_MS || 11_000);

/** Console lines that decide this verdict, in the order they were emitted. */
const REPAIR = /\[HISTORY_REQ\]|\[HISTORY_DIGEST\]|\[HISTORY_PULL\]|\[HISTORY_BUNDLE\]|LOST frame|retransmitting|escalating|SecretReuse|out of bounds|silent ACK|cannot be recovered|Desync|Asked .* to retransmit|forget|re-?add|welcome/i;

/**
 * Reads the markers with the list scrolled to the BOTTOM.
 *
 * The message list is virtualised, so `markers()` only ever sees the rendered rows - and a history
 * bundle re-renders the thread and moves the viewport. Measured 2026-08-10: the timeline had W2
 * holding 12/14 and the final read returned 0, forty-five seconds later, with the messages still
 * there; the run had just ingested 448 messages twice. The markers of a heal check are always the
 * NEWEST rows, so pinning the scroller to the bottom is the whole correction.
 */
const bottomMarkers = async (cx, prefix) => {
  await evaluate(
    cx,
    `(function () {
      var pane = document.querySelector('.chat-composer-footer .chat-composer-editor').closest('section');
      var sc = [].filter.call(pane.querySelectorAll('*'), function (e) {
        return e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200;
      })[0];
      if (sc) sc.scrollTop = sc.scrollHeight;
      return !!sc;
    })()`
  );
  await sleep(2500);
  return (await markers(cx, prefix)).length;
};

/**
 * Polls `bottomMarkers` and keeps the HIGHEST count seen.
 *
 * Delivery is monotone - a marker that has rendered has been delivered and decrypted, and cannot
 * un-deliver - while the READING is not: the virtualiser wanders after a history ingest, and the
 * same batch measured 12, 12, 12, then 0, 0, 0 across six polls thirty seconds apart. So the max
 * is the estimator, a single low read is never evidence, and the poll has to be long enough for a
 * conversation this size (a batch took over a minute to converge, where 36 s showed 7 of 12).
 */
const settledCount = async (cx, prefix, target, budgetMs) => {
  let best = 0;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && best < target) {
    best = Math.max(best, await bottomMarkers(cx, prefix));
  }
  return best;
};

/**
 * `send` with a bounded retry.
 *
 * `send` asserts its own post-condition - the composer must hold the text before it clicks - which
 * is why this is a retry and not a hope: the failure it catches is a composer that is mounted but
 * not yet taking input, seconds after a reload. Re-clicking it is the whole remedy. Three attempts,
 * then let it throw: a composer that will not take text after ten seconds is a finding, not noise.
 */
const sendRetry = async (cx, text, label) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send(cx, text);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`[heal] ${label} send retry ${attempt} (${String(e).slice(0, 80)})`);
      await sleep(3000);
    }
  }
};

/**
 * TEARDOWN - leave W1 able to deliver, whatever this run did to it. Harness fault #30.
 *
 * The break is a deliberate rewind, and until now nothing undid it: every run restored an OLDER
 * snapshot of W1 and never put the current one back, so W1 finished each run on a FORK of the
 * ratchet. When the run completes the fork happens to overtake W2's high-water mark (12 rewound plus
 * 14 sent), which is why this went unnoticed - but any run that aborts, or whose sends throw, leaves
 * W1 permanently behind, and the next run rewinds THAT by another twelve. Four consecutive runs died
 * at the setup gate with "the link was already lossy before the break", which was true and was the
 * harness's own doing.
 *
 * Restoring a saved state cannot fix it either, and the reason is the interesting part: the peer has
 * CONSUMED generations off the fork, so there is no snapshot of W1 that is simultaneously legitimate
 * and ahead of W2's high-water mark. The state is not the invariant. The invariant is **W1 can
 * deliver to W2**, so that is what the teardown restores, by burning generations until a fresh
 * message lands - each probe advances the ratchet by exactly one, so the overlap is bounded by the
 * rewind depth and this terminates by construction.
 *
 * It runs on EVERY exit, including the setup gate: if a previous run left the rig rewound, this is
 * also what repairs it.
 */
const ensureDeliverable = async (maxProbes) => {
  const td = mark('HEALTD');
  for (let i = 1; i <= maxProbes; i++) {
    await sendRetry(w1, `${td}-${i}`, 'W1-teardown').catch((e) =>
      console.log(`[heal] teardown probe ${i} threw ${String(e).slice(0, 80)}`)
    );
    if ((await settledCount(w2, td, 1, 20_000)) > 0) {
      console.log(`[heal] teardown: W1 delivers again after ${i} probe(s) - the rig is clean`);
      return true;
    }
  }
  console.log(
    `[heal] teardown: W1 STILL cannot deliver after ${maxProbes} probes - do not trust the next run.\n` +
      `       The overlap is deeper than this check created, so something else rewound it too.`
  );
  return false;
};

const consoleLines = (cx) =>
  cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    .map((e) => ({
      t: e.params.timestamp,
      text: (e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      ).slice(0, 240),
    }));

const stamp = (l) => `${new Date(l.t).toISOString().slice(11, 23)} ${l.text}`;

/**
 * EVERY line since `sinceT` - this is what the verdict is computed over.
 *
 * Harness fault #31: `REPAIR` was applied here, and the verdict matchers then ran over the FILTERED
 * text, so a line a matcher accepts but the filter drops is invisible. That is exactly what happened
 * to `soliciting a history diff` on the 2026-08-10 run: `escalated=false` on a run whose diff had
 * demonstrably run. **A capture filter is a presentation concern; a verdict must never be computed
 * over a projection of the evidence.**
 */
const allLines = (cx, sinceT) => consoleLines(cx).filter((l) => l.t >= sinceT).map(stamp);

/** The human-readable excerpt only. Narrowing here is safe; narrowing the verdict's input is not. */
const repairLines = (cx, sinceT) =>
  consoleLines(cx)
    .filter((l) => l.t >= sinceT && REPAIR.test(l.text))
    .map(stamp);

// --------------------------------------------------------------------------- clients
const w1 = await client(9224, 'canari-emse.fr', { focus: false });
const w2 = await client(9223, 'canari-emse.fr', { focus: false });
// BOTH are reloaded, and W2's reload is not optional. A history bundle inserts hundreds of OLDER
// messages into a virtualised list, and the mounted window then stays anchored in the past: after
// one run, W2's pane ended on messages from 12:40 with the scroller already at its maximum, so
// every later message was invisible to `markers()` and three runs in a row declared the link lossy
// while both stores held all twelve. A fresh mount opens at the newest message; nothing else does.
for (const cx of [w1, w2]) await cx.send('Page.reload', { ignoreCache: false });
await sleep(15000);
await watch(w1, 'W1');
await watch(w2, 'W2');
console.log('[heal] W1:', await openConversation(w1, peerNameFor('W1')));
console.log('[heal] W2:', await openConversation(w2, peerNameFor('W2')));
await sleep(8000);

// --------------------------------------------------------------------------- 1. baseline + rewind
console.log('[heal] snapshot:', JSON.parse(execFileSync('node', ['mlsdb.mjs', '--port', '9224', 'snapshot'], { encoding: 'utf8' })).report.map((r) => `${r.store} ${r.rows} rows`).join(', '));

const pre = mark('HEALPRE');
for (let i = 1; i <= REWIND_SENDS; i++) {
  await sendRetry(w1, `${pre}-${i}`, 'W1');
  await sleep(700);
}
// A fixed 6 s wait and an unpinned read declared the link lossy twice with the messages simply not
// yet delivered (10/12, then all 12 present a minute later). Poll to the bottom instead, and only
// call it a setup failure once the count has stopped moving.
const preOnW2 = await settledCount(w2, pre, REWIND_SENDS, 150_000);
console.log(`[heal] baseline: ${REWIND_SENDS} sent from W1, ${preOnW2} rendered on W2`);
/** Bounded by the deepest overlap this check can create, plus room for a run that aborted earlier. */
const TEARDOWN_PROBES = REWIND_SENDS + BREAK_SENDS + 4;

if (preOnW2 < REWIND_SENDS) {
  console.log('[heal] VERDICT: SETUP FAILED - the link was already lossy before the break');
  // Not a formality: a lossy baseline is most often a PREVIOUS run's rewind, so the teardown is
  // exactly the repair. A second failure here means the cause is not the harness.
  await ensureDeliverable(TEARDOWN_PROBES);
  process.exit(2);
}

try {
// --------------------------------------------------------------------------- 2. break it
console.log('[heal] restore:', execFileSync('node', ['mlsdb.mjs', '--port', '9224', 'restore'], { encoding: 'utf8' }).replace(/\s+/g, ' ').slice(0, 200));
await w1.send('Page.reload', { ignoreCache: false });
await sleep(12_000);
await watch(w1, 'W1');
const breakStart = Date.now();
console.log('[heal] W1 after the rewind:', await openConversation(w1, peerNameFor('W1')));
await sleep(2000);

// --------------------------------------------------------------------------- 3. keep sending
const brk = mark('HEALBRK');
const timeline = [];
for (let i = 1; i <= BREAK_SENDS; i++) {
  const marker = `${brk}-${i}`;
  await sendRetry(w1, marker, 'W1').catch((e) => console.log(`[heal] send ${i} threw ${String(e).slice(0, 80)}`));
  await sleep(BREAK_SPACING_MS);
  const seen = (await markers(w2, brk)).length;
  timeline.push({ i, at: Math.round((Date.now() - breakStart) / 1000), onW2: seen });
  console.log(`[heal] send ${i} at +${timeline[i - 1].at}s -> W2 holds ${seen}/${i}`);
}

// The escalation needs three signals 30 s apart, so give the diff room to run after the last send.
await sleep(45_000);
const finalOnW2 = await settledCount(w2, brk, BREAK_SENDS, 150_000);
const finalOnW1 = await settledCount(w1, brk, BREAK_SENDS, 60_000);

// --------------------------------------------------------------------------- 4. what repaired it
const w2Repair = repairLines(w2, breakStart);
const w1Repair = repairLines(w1, breakStart);
console.log('\n[heal] --- W2 (the receiver, which detects the loss) ---');
w2Repair.forEach((l) => console.log('  ' + l));
console.log('\n[heal] --- W1 (the rewound sender, which answers) ---');
w1Repair.forEach((l) => console.log('  ' + l));

// Over EVERY line, not over the excerpt above - see `allLines`.
const all = [...allLines(w1, breakStart), ...allLines(w2, breakStart)].join('\n');
const sawLoss = /LOST frame|SecretReuse|out of bounds/i.test(all);
const narrow = /retransmitting \d+ payload/i.test(all);
// Since the escalation fix the diff is solicited at the FIRST detection, so the old "escalating to
// a history diff" line is no longer the signal - matching only it reported `escalated=false` on a
// run whose diff demonstrably ran. `already has an attempt outstanding` counts too: it is the
// trigger firing and correctly finding one in flight, which is the mechanism working, not skipping.
const escalated =
  /escalating to a history diff|soliciting a history diff|already has an attempt outstanding/i.test(all);
const diffRan = /\[HISTORY_REQ\]/.test(all);
const fellBack = /no digest from .* sending the whole store/i.test(all);

console.log(
  `\n[heal] mechanisms: loss detected=${sawLoss}, narrow retransmission=${narrow}, ` +
    `escalated=${escalated}, history diff ran=${diffRan}${fellBack ? ' (FELL BACK to the full store - re-run)' : ''}`
);
console.log(`[heal] convergence: W1 holds ${finalOnW1}/${BREAK_SENDS}, W2 holds ${finalOnW2}/${BREAK_SENDS}`);
console.log('[heal] timeline:', JSON.stringify(timeline));
console.log(
  `[heal] VERDICT: ${finalOnW2 === BREAK_SENDS ? 'HEALED' : finalOnW2 > 0 ? 'PARTIAL' : 'NOT HEALED'} ` +
    `- ${finalOnW2}/${BREAK_SENDS} of the messages sent from a rewound state reached the peer`
);
} finally {
  // Runs on the happy path AND on any throw: a check that puts the app through a transition must
  // restore every precondition that transition destroys, and this one destroys the rig's own.
  await ensureDeliverable(TEARDOWN_PROBES);
}
process.exit(0);
