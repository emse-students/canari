/**
 * MSG-1b: a message that arrives DURING a history load must survive it.
 *
 * WHY THIS EXISTS AS ITS OWN CHECK. MSG-1 passed on the deployed build minutes after the fix landed
 * (1073 ms, one copy, never lost) and that PASS proved nothing about the fix: its pane sat flat at
 * 2 844 characters for the whole trace, because the store was warm, the `limit=1` probe found
 * nothing new and the replay was skipped entirely. The bug lives in the window between a history
 * load starting and the page it re-reads being applied; a check that never opens that window cannot
 * see it, in either direction.
 *
 * So the window is FORCED, deterministically and without a single sleep-and-hope:
 *
 *   1. W2 leaves the conversation, so opening it later is a cold open.
 *   2. W1 sends message A. The server now holds a row W2 has not seen, which is exactly what makes
 *      the fast path's `limit=1` probe return non-empty and take the full replay instead of the
 *      cheap local render.
 *   3. W2 opens the conversation. The replay starts.
 *   4. W1 fires message B, pre-armed, so only one CDP round trip stands between the load starting
 *      and the message being submitted - `armComposer` exists for precisely this.
 *   5. B is traced continuously until the load has demonstrably finished.
 *
 * THE PASS CARRIES ITS OWN EVIDENCE. If the window never opened, the verdict is INCONCLUSIVE, never
 * PASS: a check that cannot tell "the bug is fixed" from "the bug was not exercised" is worth
 * nothing, and this one failed that way once already.
 *
 * WHAT CHANGED ON 2026-08-13, AND WHY THE OLD FORM COULD NO LONGER CONCLUDE. The window used to be
 * detected by the PANE GROWING by more than 3 000 characters, and the message used to be fired once
 * `openConversation` had returned - which waits for the composer. Both were inferences about timing,
 * and the run of that date came back `windowOpened: false` with `paneFirst: 2940, paneMax: 2997`:
 * the load now finishes DURING the wait for the composer, so the send always landed after it. The
 * pane heuristic could not tell that apart from a build with no replay at all.
 *
 * So both halves are now facts rather than inferences:
 *
 * - The moment the load STARTS is `GET /api/mls/history/<groupId>` leaving the page, observed on the
 *   Network domain. The conversation is opened without waiting for the composer, and the send is
 *   fired the instant that request is seen.
 * - The window was OPEN if that request had not yet finished when the send was fired. That is the
 *   thing the check needs to be true, asked directly, and it holds for a conversation of any size -
 *   which a threshold on rendered characters never could.
 *
 * A small latency is emulated on W2 for the duration, so the window is wide enough to enter
 * reliably. It is not what makes the check honest - the in-flight proof is - it only stops a fast
 * local network from making the run INCONCLUSIVE half the time.
 *
 * WHICH history request. The route serves two different things and only one of them is the window:
 * `useConversations` first asks for `limit=1` to find out whether anything is new at all, and the
 * REPLAY that follows asks for `limit=1000` (or `limit=200` past a cursor). Firing on the probe
 * would fire before the replay had even been decided on, so the predicate names the replay
 * explicitly. `/api/mls/history/batch` is excluded for the same reason: it belongs to the list
 * bootstrap, not to this conversation.
 *
 * AND THIS IS THE SERVER ARCHIVE, NOT PEER RECONCILIATION. `GET /api/mls/history/<groupId>` is this
 * device reading its OWN mailbox; `history_request` is it asking ANOTHER DEVICE to resend what it
 * lacks, which nothing in a delivery check should ever provoke. `watch` reports the second as
 * NOTABLE, so if this cold open ever triggers one, the record says so instead of hiding it inside
 * "a history load".
 */
import {
  armComposer,
  awaitRequest,
  awaitRequestsQuiet,
  classifyDisappearance,
  client,
  countMessage,
  ensureChat,
  fireComposer,
  goto,
  openConversation,
  requestSettled,
  requestsSince,
  send,
  traceArrival,
} from './chat.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { finish, mark } from './results.mjs';
import { gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);
// W1 never navigates in this check, so its whole run is one observation window. W2's opens LATER,
// after the two `goto`s that set the scene: a navigation tears the gateway socket down and CDP
// reports that as a `Network.webSocketClosed`, which `report` counts as dirt - correctly, since a
// socket dying under a measurement invalidates it. Watching from before the setup would file the
// check's own reloads as a defect on every run, which is how a dirt signal stops being read.
const wA = await watch(w1, 'sender');

/**
 * The REPLAY page of this conversation's history, told apart from its two siblings on the same path.
 *
 * `limit=1` is the existence probe `useConversations` runs before deciding to replay at all, and
 * `/batch` is the conversation list's bootstrap. Neither is the window.
 */
const isReplayPage = (url) =>
  /\/api\/mls\/history\/(?!batch)/.test(url) && !/[?&]limit=1(&|$)/.test(url);

/** Emulated latency, and its removal. Both go through the same call so neither can be half-applied. */
const shape = (latency) =>
  w2.send('Network.emulateNetworkConditions', {
    offline: false,
    latency,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

// 1. W2 on the conversation list with NOTHING selected, and its bootstrap FINISHED.
//
//    Measured on this build: a fresh load of `/chat` selects no conversation at all, so the click in
//    step 4 always changes the selection and always triggers a load - that half was never the
//    problem. The bootstrap was. `/chat` replays the first page of every conversation it finds
//    behind, and that replay ADVANCES THE CURSOR; a primer sent while it is still running is
//    swallowed by it, the deliberate cold open then finds nothing new, and the check reports
//    INCONCLUSIVE for a reason that belongs entirely to its own ordering. That is what made the run
//    of 2026-08-13 20:29 differ from the one at 20:31 with no change in between.
//
//    So the primer is minted only once the history route has gone QUIET. After that the only thing
//    that can consume it is the click, which is the whole point.
await goto(w2, '/posts');
await new Promise((r) => setTimeout(r, 1500));
await goto(w2, '/chat');
const wB = await watch(w2, 'receiver-cold-open');
const quietAfterMs = await awaitRequestsQuiet(w2, /\/api\/mls\/history/, { quietMs: 3000 });

// NEVER ASSUME WHERE THE PREVIOUS CHECK LEFT THE SENDER. This used to call `openConversation`
// straight away, which searches the DISCUSSIONS sidebar - so with W1 parked on `/communities` (where
// the preflight is perfectly happy to leave it, the PIN gate mounting there too) it waited 20 s for
// a conversation row that page does not have and the script died before recording anything.
// `ensureChat` is the in-app click, so it costs no reload and no gateway socket.
await ensureChat(w1);
await openConversation(w1, PEER_NAME);

// 2. The row that forces the replay path. W2 takes it LIVE - it is connected, sitting on the list -
//    and a live frame is marked as consumed WITHOUT the archive cursor moving (that is the shape of
//    the WP-FALSELOSS-1 fix: the cursor only ever advances by walking, inside a replay). So the
//    server now holds a row past W2's cursor, which is exactly what makes the fast path's `limit=1`
//    probe answer non-empty and take the full replay instead of the cheap local render.
//    Waited for on the SENDER, which is enough: what matters is that the server has it before W2
//    opens, and the sender only renders it once accepted.
const primer = mark('MSG1B-A');
await send(w1, `MSG-1b primer ${primer}`);
await new Promise((r) => setTimeout(r, 2000));

// 3 (armed before 4). The text is in the box and the send control is live; nothing remains but the
//    click, so the submit lands inside the load window rather than after it.
const marker = mark('MSG1B');
await armComposer(w1, `MSG-1b during-load ${marker}`);

// The latency is applied only now, so the two navigations and the gateway reconnect above ran at
// normal speed and only the load under test is widened.
await shape(600);

let opened = null;
let before = 0;
let requestId = null;
let windowOpened = false;
let settledAfterMs = null;
let at = null;
let trace = null;

try {
  // The open is NOT awaited. Awaiting it waits for the composer, which the app renders after the
  // replay has finished - so every send fired from there landed outside the window by construction,
  // which is exactly how the 2026-08-13 run came back INCONCLUSIVE without saying so.
  before = w2.events.length;
  const opening = openConversation(w2, OWNER_NAME).then(
    (hit) => (opened = hit),
    (e) => (opened = `FAILED: ${e.message}`)
  );

  requestId = await awaitRequest(w2, isReplayPage, before, 25000);

  // 5. Fire the instant the load is known to be in flight. The proof is taken here, one CDP round
  //    trip before the submit, and it is a fact about an observed request rather than a threshold
  //    on rendered characters - so it holds for a conversation of any size.
  if (requestId !== null) {
    windowOpened = !requestSettled(w2, requestId);
    at = await fireComposer(w1);
    const firedAt = Date.now();
    // Kept as evidence, not as an assertion: how much of the load was still ahead of the message
    // tells a later reader whether the window was entered by a hair or by a mile.
    while (!requestSettled(w2, requestId) && Date.now() - firedAt < 30000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    settledAfterMs = requestSettled(w2, requestId) ? Date.now() - firedAt : null;
  }

  await opening;

  // `settleMs` is long on purpose: the overwrite that this check exists for happened at +3.4 s, well
  // after the message had rendered and after a shorter trace would have declared success and stopped.
  if (requestId !== null) trace = await traceArrival(w2, marker, { timeoutMs: 25000, settleMs: 9000 });
} finally {
  await shape(0).catch(() => null);
}

if (requestId === null) {
  // No replay page ever left the client, so the window this check exists for was never opened and
  // there is nothing to trace. Recorded as INCONCLUSIVE with the reason, never as a PASS.
  // WHAT THE CLIENT DID ASK FOR, which is what separates the two causes of this absence:
  // a `limit=1` and nothing else means the fast path ran and the probe found nothing new (the store
  // was already caught up); NO history request at all means the open never triggered a load, which
  // is a different fault entirely - the conversation was already the selected one.
  const asked = requestsSince(w2, /\/api\/mls\/history\//, before).map((u) =>
    u.replace(/^https:\/\/[^/]+/, '').replace(/history\/[0-9a-f]{8}[0-9a-f]*/, 'history/<group>')
  );
  finish('MSG-1b', 'INCONCLUSIVE', {
    marker,
    primer,
    reason: 'no history replay page was requested on the cold open - the window never opened',
    historyRequests: asked,
    quietAfterMs,
    openedOnW2: opened,
    windowOpened: false,
    observation: { sender: await report(wA), receiver: await report(wB) },
  });
}

const panes = trace.samples.map((s) => s.paneChars);
const firstPane = panes[0] ?? 0;
const maxPane = panes.length ? Math.max(...panes) : 0;
const grewBy = maxPane - firstPane;

let disappearance = null;
if (!trace.last || trace.last.count === 0) {
  disappearance = await classifyDisappearance(w2, marker, async () => {
    await goto(w2, '/chat');
    await openConversation(w2, OWNER_NAME);
  });
}

const onW2 = trace.last ? trace.last.count : 0;
const onW1 = await countMessage(w1, marker);
const primerOnW2 = await countMessage(w2, primer);

const obs = { sender: await report(wA), receiver: await report(wB) };
const delivered =
  trace.firstSeen !== null && trace.lost === null && onW2 === 1 && onW1 === 1;
// INCONCLUSIVE stays INCONCLUSIVE even over a dirty run: the window this check needs never opened,
// so there is no measurement for the noise to qualify. `gate` leaves any non-PASS verdict alone.
const gated = gate(!windowOpened ? 'INCONCLUSIVE' : delivered ? 'PASS' : 'FAIL', {
  sender: obs.sender,
  receiver: obs.receiver,
});

// The full observation dump on stdout, where a reader needs it when the verdict is bad; the verdict
// itself to the record `run.mjs` builds its table from.
console.log(JSON.stringify({ check: 'MSG-1b', marker, obs }, null, 1));

finish('MSG-1b', gated.verdict, {
  ...gated.detail,
  marker,
  primer,
  latencyMs: trace.firstSeen,
  lostAgainMs: trace.lost,
  regainedMs: trace.regained,
  sentAt: at,
  copiesOnReceiver: onW2,
  copiesOnSender: onW1,
  primerOnReceiver: primerOnW2,
  openedOnW2: opened,
  // THE WINDOW, AS A FACT: the replay page was still in flight when the send was fired, and it took
  // this many more milliseconds to finish afterwards. `null` there means it never finished at all.
  windowOpened,
  replayStillOpenForMs: settledAfterMs,
  quietAfterMs,
  paneFirst: firstPane,
  paneMax: maxPane,
  paneGrewBy: grewBy,
  samples: trace.samples.length,
  endState: trace.last,
  disappearance,
});
