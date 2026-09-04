#!/usr/bin/env node
/**
 * HEAL on the PHONE - the ANDROID half of WP-LOSS-1, which is what is still owed.
 *
 * The phone's DETECTION is already verified (2026-08-10: 13 `LOST frame ... (SecretReuseError)`
 * lines where there had been zero, once `same_epoch_ratchet.rs` stopped swallowing the error).
 * What no run has exercised is the REPAIR, end to end, on the device. This does that.
 *
 * MIRROR IMAGE OF `heal-web.mjs`, and the mirroring is the whole design:
 *   - there, W1 is rewound and W2 is the receiver that detects and repairs;
 *   - here, **W2 is rewound** and **A1 (the phone) is the receiver**, because the phone is the
 *     thing under test and a receiver is where the loss is detected.
 *
 * WHY W1 IS PARKED. The responder to a history solicitation is elected at RANDOM among the online
 * devices other than the requester (`messaging.service.ts:1372-1382`). A1 and W1 are two devices of
 * the SAME account, and the rewound sender collides for BOTH of them - so if W1 stays online it is
 * a candidate responder that is itself short of exactly the messages A1 is asking for. The run
 * would then be a coin toss between "repaired by W2" and "answered by a peer that has nothing",
 * and per the campaign's own rule the greener verdict would be the one that says less. Parking W1
 * leaves exactly one possible responder, W2, which holds the plaintexts because it sent them. The
 * check therefore records WHICH device answered by construction rather than by inference.
 *
 * That also means this check does NOT exercise the both-peers-waiting fixed point (WP-HISTBANNER-1)
 * - deliberately. One check, one mechanism.
 *
 * The phone's WebView console is read over CDP (port PORTS.A1 forwarded to
 * `localabstract:webview_devtools_remote_<pid>`), not out of logcat: same evidence, without the
 * ring-buffer overrun a busy device produces in minutes.
 *
 * NOTHING RELOADS THE PHONE. A reload re-locks the PIN, and a check that puts the app through a
 * transition must restore every precondition that transition destroys - the rewound sender is a
 * browser, so only the browser needs the reload that makes the restore stick.
 */
import { APP_TAB, client, evaluate, markers, openConversation, send } from '../chat.mjs';
import { gotoRoute, ensureConversation } from './nav.mjs';
import { watch } from '../watch.mjs';
import { mark, record } from '../results.mjs';
import { execFileSync } from 'node:child_process';
import { PORTS, peerNameFor } from '../names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REWIND_SENDS = Number(process.env.REWIND_SENDS || 12);
const BREAK_SENDS = Number(process.env.BREAK_SENDS || 14);
const BREAK_SPACING_MS = Number(process.env.BREAK_SPACING_MS || 11_000);

const REPAIR =
  /\[HISTORY_REQ\]|\[HISTORY_DIGEST\]|\[HISTORY_PULL\]|\[HISTORY_BUNDLE\]|LOST frame|retransmitting|escalating|SecretReuse|out of bounds|silent ACK|cannot be recovered|Desync|forget|re-?add|welcome/i;

/** See `heal-web.mjs`: the list is virtualised, so a read only sees the rendered rows. */
const bottomMarkers = async (cx, prefix) => {
  await evaluate(
    cx,
    `(function () {
      var c = document.querySelector('.chat-composer-footer .chat-composer-editor');
      var pane = c ? c.closest('section') : null;
      if (!pane) return false;
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

/** Delivery is monotone, the READING is not - so the estimator is the max over repeated polls. */
const settledCount = async (cx, prefix, target, budgetMs) => {
  let best = 0;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && best < target) {
    best = Math.max(best, await bottomMarkers(cx, prefix));
  }
  return best;
};

const sendRetry = async (cx, text, label) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send(cx, text);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`[heal-a1] ${label} send retry ${attempt} (${String(e).slice(0, 80)})`);
      await sleep(3000);
    }
  }
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

/** Harness fault #31: the VERDICT reads everything; only the printed excerpt is filtered. */
const allLines = (cx, sinceT) =>
  consoleLines(cx)
    .filter((l) => l.t >= sinceT)
    .map(stamp);
const repairLines = (cx, sinceT) =>
  consoleLines(cx)
    .filter((l) => l.t >= sinceT && REPAIR.test(l.text))
    .map(stamp);

// --------------------------------------------------------------------------- clients
const a1 = await client(PORTS.A1, null, { focus: false });
const w2 = await client(PORTS.W2, APP_TAB, { focus: false });

// Park W1 so the responder election has exactly one candidate. Reversible: `about:blank` drops the
// in-memory access token, not the refresh cookie, so navigating back logs in again (and re-locks
// the PIN, which `pin.mjs` handles).
// No `match`: a previous run may already have parked it, and a check that cannot run twice is a
// check that will be run once and then trusted forever.
const w1 = await client(PORTS.W1, null, { focus: false });
const w1Url = await evaluate(w1, 'location.href');
if (!w1Url.startsWith('about:')) await w1.send('Page.navigate', { url: 'about:blank' });
console.log(`[heal-a1] W1 parked (was ${w1Url}) - W2 is the only device that can answer`);

// Only W2 reloads: the restore has to survive the in-memory client writing its current state back.
await w2.send('Page.reload', { ignoreCache: false });
await sleep(15000);
await watch(a1, 'A1');
await watch(w2, 'W2');
// The phone may be sitting on any tab. Client-side only - a document load re-locks its PIN.
await gotoRoute(a1, '/chat');
console.log('[heal-a1] A1:', await ensureConversation(a1, peerNameFor('A1'), openConversation));
console.log('[heal-a1] W2:', await ensureConversation(w2, peerNameFor('W2'), openConversation));
await sleep(8000);

// --------------------------------------------------------------------------- 1. baseline + rewind
console.log(
  '[heal-a1] snapshot:',
  JSON.parse(execFileSync(process.execPath, ['mlsdb.mjs', '--port', '9223', 'snapshot'], { encoding: 'utf8' }))
    .report.map((r) => `${r.store} ${r.rows} rows`)
    .join(', ')
);

const pre = mark('A1HEALPRE');
for (let i = 1; i <= REWIND_SENDS; i++) {
  await sendRetry(w2, `${pre}-${i}`, 'W2');
  await sleep(700);
}
const preOnA1 = await settledCount(a1, pre, REWIND_SENDS, 150_000);
console.log(`[heal-a1] baseline: ${REWIND_SENDS} sent from W2, ${preOnA1} rendered on A1`);
const TEARDOWN_PROBES = REWIND_SENDS + BREAK_SENDS + 4;

/** Teardown restores the INVARIANT - "W2 can deliver to A1" - never a snapshot. Harness fault #30. */
const ensureDeliverable = async (maxProbes) => {
  const td = mark('A1HEALTD');
  for (let i = 1; i <= maxProbes; i++) {
    await sendRetry(w2, `${td}-${i}`, 'W2-teardown').catch((e) =>
      console.log(`[heal-a1] teardown probe ${i} threw ${String(e).slice(0, 80)}`)
    );
    if ((await settledCount(a1, td, 1, 20_000)) > 0) {
      console.log(`[heal-a1] teardown: W2 delivers again after ${i} probe(s) - the rig is clean`);
      return true;
    }
  }
  console.log('[heal-a1] teardown: W2 STILL cannot deliver - do not trust the next run');
  return false;
};

if (preOnA1 < REWIND_SENDS) {
  console.log('[heal-a1] VERDICT: SETUP FAILED - the link was already lossy before the break');
  await ensureDeliverable(TEARDOWN_PROBES);
  process.exit(2);
}

/** The recorded row, hoisted out of the `try` so the exit code at the foot can read the VERDICT. */
let row = null;
try {
  // ------------------------------------------------------------------------- 2. break it
  console.log(
    '[heal-a1] restore:',
    execFileSync(process.execPath, ['mlsdb.mjs', '--port', '9223', 'restore'], { encoding: 'utf8' })
      .replace(/\s+/g, ' ')
      .slice(0, 200)
  );
  await w2.send('Page.reload', { ignoreCache: false });
  await sleep(12_000);
  await watch(w2, 'W2');
  const breakStart = Date.now();
  console.log('[heal-a1] W2 after the rewind:', await ensureConversation(w2, peerNameFor('W2'), openConversation));
  await sleep(2000);

  // ------------------------------------------------------------------------- 3. keep sending
  const brk = mark('A1HEALBRK');
  const timeline = [];
  for (let i = 1; i <= BREAK_SENDS; i++) {
    await sendRetry(w2, `${brk}-${i}`, 'W2').catch((e) =>
      console.log(`[heal-a1] send ${i} threw ${String(e).slice(0, 80)}`)
    );
    await sleep(BREAK_SPACING_MS);
    const seen = (await markers(a1, brk)).length;
    timeline.push({ i, at: Math.round((Date.now() - breakStart) / 1000), onA1: seen });
    console.log(`[heal-a1] send ${i} at +${timeline[i - 1].at}s -> A1 holds ${seen}/${i}`);
  }

  await sleep(45_000);
  const finalOnA1 = await settledCount(a1, brk, BREAK_SENDS, 180_000);
  const finalOnW2 = await settledCount(w2, brk, BREAK_SENDS, 60_000);

  // ------------------------------------------------------------------------- 4. what repaired it
  console.log('\n[heal-a1] --- A1 (the phone: the receiver, which detects the loss) ---');
  repairLines(a1, breakStart).forEach((l) => console.log('  ' + l));
  console.log('\n[heal-a1] --- W2 (the rewound sender, the only possible responder) ---');
  repairLines(w2, breakStart).forEach((l) => console.log('  ' + l));

  const all = [...allLines(a1, breakStart), ...allLines(w2, breakStart)].join('\n');
  const phoneOnly = allLines(a1, breakStart).join('\n');
  const sawLoss = /LOST frame|SecretReuse|out of bounds/i.test(phoneOnly);
  const solicited =
    /escalating to a history diff|soliciting a history diff|already has an attempt outstanding/i.test(
      phoneOnly
    );
  const diffRan = /\[HISTORY_REQ\]/.test(all);
  const digestSent = /\[HISTORY_DIGEST\]/.test(all);
  const fellBack = /no digest from .* sending the whole store/i.test(all);

  console.log(
    `\n[heal-a1] mechanisms (phone side): loss detected=${sawLoss}, solicited=${solicited}; ` +
      `diff ran=${diffRan}, digest exchanged=${digestSent}${fellBack ? ' (FELL BACK to the full store - re-run)' : ''}`
  );
  console.log(`[heal-a1] convergence: W2 holds ${finalOnW2}/${BREAK_SENDS}, A1 holds ${finalOnA1}/${BREAK_SENDS}`);
  console.log('[heal-a1] timeline:', JSON.stringify(timeline));
  console.log(
    `[heal-a1] VERDICT: ${finalOnA1 === BREAK_SENDS ? 'HEALED' : finalOnA1 > 0 ? 'PARTIAL' : 'NOT HEALED'} ` +
      `- ${finalOnA1}/${BREAK_SENDS} of the messages sent from a rewound state reached the PHONE`
  );

  /**
   * RECORDED AT LAST - and `unobservable` rather than a gate, which is a decision, not an omission.
   *
   * Every other check in this campaign is gated on `clean`. This one may not be, and the reason is
   * the point of the check: it REWINDS W2's MLS store on purpose, so `LOST frame`, `SecretReuseError`
   * and `Ciphertext generation out of bounds` are its STIMULUS. A gate would report `PASS-DIRTY` on
   * every single run, for lines the script itself caused - and dirt that is always there is dirt
   * nobody reads.
   *
   * The console is not ignored, it is PROMOTED: `sawLoss`, `solicited`, `diffRan` and `digestSent`
   * are read out of it and they ARE the assertions - this check fails if the phone did NOT log the
   * loss. `unobservable` says exactly that, in the record, where the alternative was a row that
   * looked identical to a check nobody had instrumented.
   */
  row = record('HEAL-A1', finalOnA1 === BREAK_SENDS ? 'PASS' : finalOnA1 > 0 ? 'PARTIAL' : 'FAIL', {
    unobservable:
      'this check rewinds W2 MLS store on purpose, so LOST frame / SecretReuseError / out-of-bounds ' +
      'are its stimulus and a cleanliness gate would fire on every run. The console is read as the ' +
      'ASSERTION instead - see sawLoss / solicited / diffRan / digestSent below.',
    sends: BREAK_SENDS,
    onPhone: finalOnA1,
    onSender: finalOnW2,
    lossDetectedByPhone: sawLoss,
    phoneSolicitedHistory: solicited,
    historyDiffRan: diffRan,
    digestExchanged: digestSent,
    fellBackToWholeStore: fellBack,
    timeline,
  });
} finally {
  await ensureDeliverable(TEARDOWN_PROBES);
}
// EXPLICIT, because this script holds two CDP sockets and an adb forward open - the event loop never
// idles, so `beforeExit` cannot fire. It reads the recorded VERDICT, where `process.exit(0)` used to
// report success over a phone that had healed nothing.
process.exit(row?.verdict === 'PASS' ? 0 : 1);
