/**
 * After the generation-gap escalation: does the conversation HEAL, i.e. does the NEXT message
 * arrive? The frame that triggered the escalation is unrecoverable by construction; the only
 * question a verification can ask is whether the group works again afterwards.
 */
import { APP_TAB, awaitMessage, client, countMessage, ensureChat, openConversation, send } from '../chat.mjs';
import { finishObserved, mark } from '../results.mjs';
import { logcatReport, logcatSince, watch } from '../watch.mjs';
import * as phone from '../phone.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

phone.wake();
phone.launch();
await new Promise((r) => setTimeout(r, 5000));
phone.forwardDevtools(PORTS.A1);
const a1 = await client(PORTS.A1, 'tauri.localhost');
// A SWALLOWED SETUP FAILURE MAKES THE RUN MEAN SOMETHING ELSE WITHOUT SAYING SO. `openConversation`
// refuses precisely and says why - on 2026-09-08 it was "2 of 5 conversation tiles match the
// requested name [...] so the row is AMBIGUOUS and none was opened", a deleted group still listed
// under the peer's name - and `.catch(() => null)` threw that sentence away, costing three NOTIF-1b
// verdicts before anyone read it. Everything below assumes the phone is sitting in the DM, so a
// refusal is ANNOUNCED. Not fatal here: this file has no verdict record to assert it into, and a
// loud line a reader can attribute beats a run that quietly measures a different screen.
await ensureChat(a1).catch((e) => console.error(`[setup] A1 ensureChat FAILED - ${e?.message || e}`));
await openConversation(a1, peerNameFor('A1')).catch((e) =>
  console.error(`[setup] A1 openConversation FAILED - ${e?.message || e}`)
);

const w2 = await client(PORTS.W2, APP_TAB);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

/**
 * THIS ONE IS GATED FOR REAL, unlike its siblings.
 *
 * `heal-a1` and `heal-web` rewind an MLS store on purpose, so their loss markers are the stimulus and
 * they declare `unobservable`. This script breaks NOTHING: it runs after an escalation has already
 * happened and asks only whether the group works again. So a `SecretReuseError` here is not the
 * experiment, it is the answer being no - and the whole point of the check is to catch exactly that.
 *
 * The phone's native half is included, because a message that never arrives leaves its only trace
 * there: the decrypt that failed is Rust, and `awaitMessage` timing out says nothing about why.
 */
phone.clearLogcat();
const phoneWindowFrom = Date.now();
const oA1 = await watch(a1, 'A1');
const oW2 = await watch(w2, 'W2');

const rounds = [];
for (let round = 1; round <= 3; round++) {
  const m = mark('HEAL');
  const t0 = await send(w2, `${m} round ${round}`);
  const arrived = await awaitMessage(a1, m, 90_000).then(() => Date.now() - t0, () => null);
  const count = await countMessage(a1, m);
  rounds.push({ round, marker: m, arrivedInMs: arrived, count });
  console.log(JSON.stringify(rounds[rounds.length - 1]));
  await new Promise((r) => setTimeout(r, 4000));
}

// Exactly one copy of every round, or the group has not healed - `process.exit(0)` reported success
// over three rounds of `arrivedInMs: null` and nothing in `results.ndjson` said otherwise.
const lost = rounds.filter((r) => r.arrivedInMs === null || r.count !== 1);
await finishObserved(
  'HEAL-NEXT',
  lost.length ? 'FAIL' : 'PASS',
  { rounds, lostRounds: lost.map((r) => r.round) },
  { A1: oA1, W2: oW2, 'A1-native': logcatReport(await logcatSince(phoneWindowFrom), 'A1') },
);
