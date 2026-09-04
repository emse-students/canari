/**
 * TAB-3b - five cold starts, and what each one spent its time on.
 *
 * TAB-3 kills the browser once and asserts the two messages come back. This row exists because of a
 * number: the board records one cold start at 77.7 s, unreproduced in four further runs. **That
 * number has no row behind it** - `results.ndjson` holds nothing for any TAB check, so the single
 * cell asserting it is the whole record, and it names no build. Settling it is this runner's job.
 *
 * WHY FIVE RUNS OF TAB-3 WOULD NOT HAVE SETTLED IT. A cold start is not one duration, it is four
 * laid end to end - the process starting, the app rendering, the PIN being accepted, and the queue
 * being fetched and decrypted - and TAB-3 reports one total for the last of them. An outlier in a
 * single total is unattributable by construction, which is exactly why the 77.7 s is "unexplained".
 * So each phase is timed separately here, and an outlier names the phase it lived in.
 *
 * WHAT IS ASSERTED, on every one of the five, and none of it is a clock:
 *   1. the browser really went down          - `killBrowser` proves the port stopped answering
 *   2. the profile kept its SESSION          - the PIN gate is not a login form, and only one of the
 *                                              two means the cold start lost something
 *   3. the message sent while it was down arrives, exactly once
 *   4. the relaunch leaves exactly ONE app tab - a second tab is a second MLS client on the profile
 *
 * WHAT IS REPORTED AND NOT ASSERTED: every duration. A latency ceiling this rig cannot defend from a
 * measured population would be a number invented to be met, and asserting a wall clock is forbidden
 * anyway. The population is what this row produces; a ceiling can be derived from it afterwards, and
 * `slowest` is printed so a human reading the run sees the outlier without opening the record.
 *
 * The one timing FAILURE is a catch-up that never completes inside a deliberately generous window -
 * that is not slowness, it is a message that did not arrive.
 *
 *   bun tab3b.mjs            - five runs
 *   bun tab3b.mjs --runs 2   - fewer, while working on it
 */
import { APP_TAB, awaitAppReady, awaitMessage, client, countMessage, ensureChat, evaluate, LOGIN_SHOWING, openConversation, send } from '../chat.mjs';
import { listTargets } from '../cdp.mjs';
import { killBrowser, startBrowser } from '../launch.mjs';
import { unlockClient } from './pingate.mjs';
import { mark, recordObserved } from '../results.mjs';
import { watch } from '../watch.mjs';
import { ACCOUNT_OF, PORTS, SITE, peerNameFor } from '../names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argRuns = process.argv.indexOf('--runs');
const RUNS = argRuns > -1 ? Number(process.argv[argRuns + 1]) : 5;
/** Generous on purpose: this is the point past which the message is missing, not merely late. */
const CATCHUP_MS = 180_000;

/** How many tabs of the app that browser is showing - one is the only right answer. */
const appTabs = async (port) => (await listTargets(port)).filter((t) => String(t.url).includes(SITE)).length;

const w2 = await client(PORTS.W2, SITE);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));
const o2 = await watch(w2, 'TAB3B-W2');

const runs = [];
for (let i = 1; i <= RUNS; i++) {
  const marker = mark(`TAB3B${i}`);

  // 1. down, PROVEN down - `killBrowser` throws rather than returning if the port still answers.
  const downInMs = await killBrowser('w1');

  // 2. the message that has to survive the outage. Sent while W1 is provably gone, so it can only
  //    reach it through the queue on the way back up - which is the whole subject.
  await send(w2, `${marker} sent while W1 was down (run ${i}/${RUNS})`);
  await sleep(3_000);

  // 3. THE CLOCK STARTS AT THE LAUNCH, because that is where a user's does.
  const t0 = Date.now();
  const upInMs = await startBrowser('w1');

  // `client()` resolves a target by URL, and for a few hundred ms after the port answers there is no
  // page yet. Retry rather than treat a not-yet-existing tab as a failure.
  let w1 = null;
  for (let a = 0; a < 40 && !w1; a++) {
    w1 = await client(PORTS.W1, SITE).catch(() => null);
    if (!w1) await sleep(500);
  }
  if (!w1) throw new Error(`run ${i}: the relaunched browser never presented a page on ${SITE}`);

  const readyMs = await awaitAppReady(w1, 60_000)
    .then(() => Date.now() - t0)
    .catch(() => null);

  // 4. session or login? Read BEFORE unlocking: once the PIN is entered the distinction is gone.
  const loginShowing = await evaluate(w1, LOGIN_SHOWING);

  // 5. the PIN, and a PROVEN verdict rather than "the CLI said something".
  const tUnlock = Date.now();
  const pin = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
  const unlockMs = Date.now() - tUnlock;

  // 6. the queue. `openConversation` is what puts the messages on screen; the wait is for the one
  //    that was sent into the outage.
  const o1 = await watch(w1, `TAB3B-W1-${i}`);
  await ensureChat(w1);
  await openConversation(w1, peerNameFor('W1'));
  const catchupMs = await awaitMessage(w1, marker, CATCHUP_MS).then(
    () => Date.now() - t0,
    () => null
  );
  await sleep(2_000);
  const copies = await countMessage(w1, marker);
  const tabs = await appTabs(PORTS.W1);

  const run = {
    run: i,
    marker,
    downInMs,
    upInMs,
    readyMs,
    unlockMs,
    pin: pin.verdict,
    pinSaid: pin.said,
    reLoginRequired: loginShowing,
    catchupMs,
    copies,
    appTabs: tabs,
    // The phase that dominated this cold start, which is the question the 77.7 s could not answer.
    dominantPhase:
      catchupMs === null
        ? 'never caught up'
        : Object.entries({
            launch: upInMs,
            render: readyMs === null ? 0 : readyMs - upInMs,
            unlock: unlockMs,
            queue: catchupMs - (readyMs === null ? upInMs : readyMs) - unlockMs,
          }).sort((a, b) => b[1] - a[1])[0][0],
    observed: o1,
  };
  runs.push(run);
  console.log(
    `[tab3b] run ${i}/${RUNS} - down ${downInMs}ms, up ${upInMs}ms, ready ${readyMs}ms, unlock ${unlockMs}ms (${pin.verdict}), caught up ${catchupMs}ms, copies ${copies}, tabs ${tabs}, dominated by ${run.dominantPhase}`
  );
}

const fail = [];
for (const r of runs) {
  if (r.reLoginRequired) fail.push(`run ${r.run}: the cold start lost the SESSION - a login form, not the PIN gate`);
  if (r.pin === 'LOCKED') fail.push(`run ${r.run}: still locked after the PIN (${r.pinSaid})`);
  if (r.catchupMs === null)
    fail.push(`run ${r.run}: the message sent during the outage never arrived within ${CATCHUP_MS / 1000} s`);
  else if (r.copies !== 1) fail.push(`run ${r.run}: ${r.copies} copies of the message after the cold start`);
  if (r.appTabs !== 1) fail.push(`run ${r.run}: the relaunch left ${r.appTabs} app tab(s) - each is another MLS client`);
}

const vacuous = [];
if (runs.length !== RUNS) vacuous.push(`only ${runs.length} of ${RUNS} runs completed`);
if (runs.some((r) => r.pin === 'UNDECIDED'))
  vacuous.push('at least one run could prove neither locked nor unlocked, so its timings are not about a usable client');

const timings = runs.filter((r) => r.catchupMs !== null).map((r) => r.catchupMs);
const spread = timings.length
  ? {
      runs: timings.length,
      fastestMs: Math.min(...timings),
      slowestMs: Math.max(...timings),
      medianMs: [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)],
    }
  : null;

const verdict = vacuous.length ? 'VACUOUS' : fail.length ? 'FAIL' : 'PASS';
const observers = { W2: o2 };
for (const r of runs) observers[`W1r${r.run}`] = r.observed;

const row = await recordObserved(
  'TAB-3b',
  verdict,
  {
    requestedRuns: RUNS,
    catchupWindowMs: CATCHUP_MS,
    coldStarts: runs.map(({ observed, ...rest }) => rest),
    spread,
    // The claim this row was written to settle, answered against a named build by the record itself.
    boardClaimedOutlierMs: 77_700,
    reproducedTheOutlier: spread ? spread.slowestMs >= 70_000 : null,
    vacuousBecause: vacuous,
    failures: fail,
  },
  observers
);
console.log(
  `[tab3b] VERDICT ${row.verdict}${spread ? ` - catch-up ${spread.fastestMs}/${spread.medianMs}/${spread.slowestMs} ms (fastest/median/slowest over ${spread.runs})` : ''}${
    vacuous.length ? ' - ' + vacuous.join('; ') : fail.length ? ' - ' + fail.join('; ') : ''
  }`
);
process.exit(row.verdict === 'PASS' ? 0 : 1);
