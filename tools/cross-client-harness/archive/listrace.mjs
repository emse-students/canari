/**
 * LIST-RACE-1: a salon heard of live while its community's listing is held - listed after the release?
 *
 *   bun archive/listrace.mjs --row LIST-RACE-1-W|LIST-RACE-1-W-CTL|LIST-RACE-1-A1|LIST-RACE-1-A1-CTL
 *
 * The table, the 20 s rule and the judge are `listracerows.mjs`; the backlog P2 is "A salon heard of
 * live while its community's listing is in flight is deleted by that listing's clean-up". Each row
 * mints its own community and deletes it once its verdict is on disk. Every wait is counted in
 * ROUNDS of a fact, never a clock: the listing's end, the live `Joined channel`, the salon drawn.
 */
import { evaluate, realClick, until } from '../cdp.mjs';
import { clearOverlays, reachCommunities } from '../chat.mjs';
import { createChannel, createCommunity, deleteCommunity, inviteLink, openCommunity, openInviteLink } from '../comm.mjs';
import { armFault } from '../fault.mjs';
import { channelIdOf, workspaceIdOf } from '../grainedb.mjs';
import { LISTED_ROUNDS, LIST_RACE_ROWS, ROUND_MS, WAIT_ROUNDS, listRaceOwn } from '../listracerows.mjs';
import { caption } from '../messages.mjs';
import { closeSeats, observersOf, openSeats, userOf } from '../mlsrow.mjs';
import { errorDetail, finishObserved, keepConsoles, record } from '../results.mjs';
import { rowGroupName } from '../rowkit.mjs';
import { bigRowNarration, consoleDump, consoleLines } from '../watch.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!LIST_RACE_ROWS[id]) {
  console.error(`usage: bun archive/listrace.mjs --row ${Object.keys(LIST_RACE_ROWS).join('|')}`);
  process.exit(2);
}
const spec = LIST_RACE_ROWS[id];
const since = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seats = null;
let fault = null;
let community = null;
const cx = (d) => seats.seat[d].cx;
const S = spec.subject;
const linesOf = () => consoleLines(cx(S));

/** The round (1-based) on which `pred()` first held, or null after `max` rounds. */
async function rounds(pred, max = WAIT_ROUNDS) {
  for (let r = 1; r <= max; r++) {
    if (await pred()) return r;
    await sleep(ROUND_MS);
  }
  return null;
}

/** The subject's lines since `from` that contain `needle`. */
const saidSince = (from, needle) => linesOf().slice(from).some((l) => l.includes(needle));

async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const sibling = spec.joiner ?? 'W1';
  if (user[sibling] !== user[S] || (spec.joiner && user[spec.joiner] === user.W1))
    return { premise: [`${S} must share ${sibling}'s account${spec.joiner ? ", and not W1's" : ''}`] };
  community = rowGroupName('LIST-1');
  const salon = `${community}-salon`;
  await createCommunity(cx('W1'), community);
  let link = null;
  if (spec.joiner) link = await inviteLink(cx('W1'));
  await clearOverlays(cx('W1'));
  const ws = workspaceIdOf(community, { memberUserId: user.W1 });
  if (!ws) return { premise: [`${community} is not on the server after its creation`] };
  if (spec.joiner && !(await openInviteLink(cx(spec.joiner), link)).valid) return { premise: [`${spec.joiner}: the link was refused`] };

  // THE HOLD IS ARMED ON THIS COMMUNITY'S LISTING ONLY, before the gesture that starts it.
  const before = linesOf().length;
  if (spec.hold) fault = await armFault(cx(S), [{ match: `/api/channels/workspace/${ws}/user/me`, method: 'GET', fault: 'hold-answer once' }]);
  if (spec.joiner) {
    await realClick(cx(spec.joiner), `text=${caption('community_join_btn')}`);
    await until(cx(spec.joiner), `location.pathname.indexOf('/c/join/') < 0`, 30000);
  } else {
    await openCommunity(cx('W1'), community);
    await createChannel(cx('W1'), `${community}-first`, { visibility: 'public' });
  }
  const joinedInSession = await rounds(() => saidSince(before, 'community joined in-session'));
  const heldRound = spec.hold ? await rounds(() => fault.held().length > 0) : null;
  if (!spec.hold) await rounds(() => saidSince(before, 'communities/channels loaded'));

  await openCommunity(cx('W1'), community);
  await createChannel(cx('W1'), salon, { visibility: 'public' });
  const channelId = channelIdOf(ws, salon);
  if (!channelId) return { premise: [`${salon} is not on the server after its creation`] };
  // RELEASED AS SOON AS THE SALON IS HEARD: the hold must end under the client's own 20 s stall.
  const heard = await rounds(() => saidSince(before, `Joined channel ${channelId.slice(0, 8)}`));
  const heldStill = spec.hold ? fault.held().length : null;
  const pausedAt = spec.hold ? fault.records[0]?.pausedAt : null;
  const heldForMs = pausedAt ? Date.now() - Date.parse(pausedAt) : null;
  const stalled = linesOf()
    .slice(before)
    .some((l) => l.includes(`workspace/${ws.slice(0, 8)}`) && l.includes('had no response after'));
  const releasedAt = linesOf().length;
  if (spec.hold) await fault.release();
  const loaded = spec.hold ? await rounds(() => saidSince(releasedAt, 'communities/channels loaded')) : null;

  await reachCommunities(cx(S));
  await openCommunity(cx(S), community);
  const listedRound = await rounds(async () => String(await evaluate(cx(S), 'document.body.innerText')).includes(salon), LISTED_ROUNDS);
  const measured = { hold: spec.hold, joinedInSession, heard, heldStill, heldForMs, stalled, listedRound };
  const subjectLines = linesOf()
    .slice(before)
    .filter((l) => /WORKSPACE-LOAD|Joined channel|salon row/.test(l));
  return {
    own: listRaceOwn(measured),
    detail: { community, workspaceId: ws, channelId, joiner: spec.joiner, subject: S, rounds: { joinedInSession, heldRound, heard, loaded, listedRound }, heldStill, heldForMs, stalled, subjectLines },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = out.premise ? { verdict: 'INVALID', failures: out.premise } : out.own;
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const faultReport = fault ? await fault.disarm() : null;
  fault = null;
  const observers = await observersOf(seats, { logs: Object.fromEntries(spec.devices.map((d) => [d, bigRowNarration(d)])) });
  await finishObserved(id, verdict, { ...out.detail, failures, fault: faultReport, serverWindowSince: since }, observers, async () => {
    if (community) {
      // THE ROW'S COMMUNITY GOES WITH IT, once the verdict is on disk; a failure here is logged, never the row.
      await openCommunity(cx('W1'), community)
        .then(() => deleteCommunity(cx('W1'), community))
        .catch((e) => console.log(`[${id}] the row's community ${community} was NOT deleted: ${String(e?.message ?? e)}`));
    }
    closeSeats(seats);
  });
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  if (fault) await fault.disarm().catch((d) => console.error(`[${id}] disarm failed: ${String(d?.message ?? d)}`));
  let consoles = null;
  try {
    consoles = seats ? keepConsoles(id, consoleDump(Object.fromEntries(Object.entries(seats.seat ?? {}).map(([d, s]) => [d, { cx: s?.cx }])))) : null;
  } catch (k) {
    console.error(`[${id}] the seats' consoles could not be kept: ${String(k?.message ?? k)}`);
  }
  record(id, 'ERROR', { ...errorDetail(e), ...(consoles ? { consoles } : {}) });
  closeSeats(seats);
  process.exit(1);
}
