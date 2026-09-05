/**
 * TAB-5 - reload fired within ~100 ms of submitting a message.
 *
 * "Never lost, never doubled" is the whole assertion, and it has two sides that must BOTH be
 * checked, because the campaign has already produced one bug on each: the receiver can lose it
 * (WP-LOSS-1, a rewound ratchet) and the SENDER can lose its own echo across a load (WP-ECHO-1,
 * open). So each round counts the marker on the receiver AND on the sender after the reload.
 *
 * `send()` cannot be reused: it waits for the composer to empty and for delivery, which is exactly
 * the window being cut. The submit here is fire-and-forget - click, then reload as fast as the
 * driver allows - and the elapsed time between the two is REPORTED, because a check that claims to
 * reload "within 100 ms" and actually took 400 is testing something else.
 *
 * REWRITTEN 2026-08-14 for the same reason as `tab4.mjs`: it printed its rounds and exited, so TAB-5
 * had never appeared in `results.ndjson`. It also held the peer's real display name inline, which is
 * the shape that put that name into the public repository once already.
 */
import { APP_TAB, awaitAppReady, awaitMessage, client, COMPOSER, ensureConversation, evaluate, SEND_ENABLED, settledCount } from '../chat.mjs';
import { activate, realClick, until } from '../cdp.mjs';
import { dirtOf, gate, ignoringExpectedLog, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

const ROUNDS = Number(process.argv[2] || 3);

const w1 = await client(PORTS.W1, APP_TAB);
const w2 = await client(PORTS.W2, APP_TAB);

/** Back into the conversation after the reload, waiting on the app rather than on a number. */
async function reopenW1() {
  await awaitAppReady(w1);
  await ensureConversation(w1, peerNameFor('W1'));
}

const rows = [];
/** Every round's two reports, keyed - so the gate can name WHICH round was dirty, not just that one was. */
const reports = {};
for (let i = 0; i < ROUNDS; i++) {
  const m = mark(`TAB5X${i}`);
  const o1 = await watch(w1, `TAB5-${i}-W1`);
  const o2 = await watch(w2, `TAB5-${i}-W2`);

  await realClick(w1, COMPOSER);
  await evaluate(w1, `document.querySelector('${COMPOSER}').focus()`);
  await w1.send('Input.insertText', { text: `${m} reload right after submit` });
  await until(w1, SEND_ENABLED, 5000, 50);

  const at = Date.now();
  await activate(w1, 'text=Envoyer le message');
  // No wait: the point is to tear the document down inside the send's own async tail.
  await w1.send('Page.reload').catch(() => null);
  const gap = Date.now() - at;

  await reopenW1();
  await awaitMessage(w2, m, 20000).catch(() => null);

  // Both sides settle before either is read. A single sample taken a fixed delay after arrival
  // cannot tell "exactly one copy" from "the second copy had not landed yet", and that difference
  // is the entire assertion this check makes.
  const receiver = await settledCount(w2, m);
  const sender = await settledCount(w1, m);
  const [r1, r2] = [await report(o1), await report(o2)];
  reports[`W1#${i}`] = r1;
  reports[`W2#${i}`] = r2;

  rows.push({
    round: i,
    marker: m,
    msFromSubmitToReload: gap,
    onReceiver: receiver.count,
    onSender: sender.count,
    countsSettled: receiver.settled && sender.settled,
    delivered: receiver.count === 1 && sender.count === 1,
    senderClean: r1.clean,
    receiverClean: r2.clean,
    senderDirt: dirtOf(r1),
    receiverDirt: dirtOf(r2),
  });
  console.log(`[tab5] round ${i + 1}/${ROUNDS} gap=${gap}ms receiver=${receiver.count} sender=${sender.count}`);
}

/**
 * ONE verdict for the check, with every round in its detail.
 *
 * Recording one row per round would put N rows called TAB-5 in the record and leave the dashboard to
 * decide what the check did, which is exactly the reduction the check itself should be making.
 */
const failed = rows.filter((r) => !r.delivered);
const unsettled = rows.filter((r) => !r.countsSettled);
const dirty = rows.filter((r) => !r.senderClean || !r.receiverClean);
// `gate` rather than the third hand-written copy of it - see the same change in `tab4.mjs`. This one
// spelt the outcome right and still produced no `clean` key, which is what `record` reads to tell an
// observed verdict from an unobserved one.
/**
 * THE ONE LINE THIS ROW MANUFACTURES, on the sender and on no one else.
 *
 * Tearing the document down 15 ms after the click is how an acknowledgement ends up in flight when
 * the next pull is answered: the server still holds the row it was told about, lists it again, and
 * the client recognises its own ack rather than decrypting twice. The log says all of that and
 * states that repeats are counted rather than printed, so it is expected AND necessary - it is the
 * only evidence that the second delivery was recognised instead of processed.
 *
 * Named per row, on the sender's reports only. A needle list applied to the receiver would excuse
 * the same sentence on a client that has no reason to produce it.
 */
const ACK_RACE = 'arrived twice - the pull listed a row this device had already acknowledged';
const dispositioned = Object.fromEntries(
  Object.entries(reports).map(([label, rep]) => [
    label,
    label.startsWith('W1') ? ignoringExpectedLog(rep, [ACK_RACE]) : rep,
  ]),
);
const gated = gate(failed.length ? 'FAIL' : unsettled.length ? 'INCONCLUSIVE' : 'PASS', dispositioned);
record(
  'TAB-5',
  gated.verdict,
  {
    ...gated.detail,
    rounds: ROUNDS,
    // The gap is the check's own claim about itself and belongs in the record: a round that reloaded
    // 400 ms after submit did not test the window TAB-5 is named for.
    gapsMs: rows.map((r) => r.msFromSubmitToReload),
    failedRounds: failed.map((r) => ({ round: r.round, onReceiver: r.onReceiver, onSender: r.onSender })),
    unsettledRounds: unsettled.map((r) => r.round),
    dirt: dirty.map((r) => ({ round: r.round, sender: r.senderDirt, receiver: r.receiverDirt })),
    rows,
  },
);

// THIS SCRIPT CANNOT REACH `beforeExit`: it holds CDP sockets and nothing closes them, so the loop
// never idles and the hook that derives the exit code never fires. It ran off its end instead and
// sat there with its verdict already on disk, blocking whatever was queued behind it.
// `exitOnRecorded` is that same derivation called rather than waited for - never `process.exit(0)`,
// which would report a pass over the FAIL just recorded.
exitOnRecorded();
