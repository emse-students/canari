/**
 * FLOOR-1..3 OF THE 1.4.1 CAMPAIGN - the floor re-proved on dev, before any other MLS row.
 *
 *   bun archive/floor.mjs --row 1            # DM both ways, then a reload           (W1 W2, U)
 *   bun archive/floor.mjs --row 2            # a fresh group, ONE bulk Add of three   (W1 W2 W4 W5, U)
 *   bun archive/floor.mjs --row 3            # FLOOR-2's group, seen from A1 and I1   (+A1 +I1, B)
 *   bun archive/floor.mjs --row 3 --group <uuid>   # name the group instead of FLOOR-2's last one
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2. Each run is ONE draw of a row; the plan's
 * cost column counts five, and the board reads the set. The row's own judgement is
 * `floorrows.mjs`, the invariant of section 4.0 is `invariant.mjs` (R8), the composition is
 * `rowkit.mjs`, and `recordObserved` folds in every seat's window, the deploy exclusion (R4) and the
 * server window judged by the row id (R6).
 *
 * FLOOR-2 MINTS ITS OWN GROUP, AND THAT IS NOT A WEAKENING OF THE ROW. The plan's text said "create
 * `campaign-g4`", but `campaign-fixtures.mjs` builds `campaign-g4` at step 2, BEFORE FLOOR, and is
 * idempotent: a FLOOR-2 pointed at it observes a creation that already happened, and every re-run
 * after a product fix (each new pre-release re-runs FLOOR) observes nothing at all. So the row creates
 * `FLOOR2-<mark>` (swept by `debris.mjs`, owned in the ledger) and adds peer, third and fourth in ONE
 * submission - the bulk Add the row asks about - while `campaign-g4` stays the fixture the other rows
 * stand on, itself built by the same bulk gesture (`addMembers`).
 *
 * R5: every conversation the row writes in is campaign-owned - the fixture DM, or the group it minted
 * (`assertRowOwns`). R1: `site.mjs` refuses production at import, `mlsrow.mjs` and `invariant.mjs`
 * re-assert local or dev.
 *
 * FLOOR-3 drives phones and is CLASS B: it is run directly, not through `checks.mjs` (whose phase
 * table cannot see a phone door this runner opens through `openSeats`), so `record()` warns that the
 * row carries no `a1Build` unless `A1_BUILD` is set. Set it from `a1apk.mjs` before the run.
 */
import { directConversation } from '../grainedb.mjs';
import { awaitMessage, ensureChat, openConversation, send } from '../chat.mjs';
import { openGroup } from '../groupnav.mjs';
import { addMembers } from './addmember.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import { FLOOR1_BOUND_MS, FLOOR_ROWS, floor1Own, floor2Own, floor3Premise } from '../floorrows.mjs';
import {
  assertRowOwns,
  awaitListed,
  awaitServer,
  closeSeats,
  deviceIdOf,
  displayNameOf,
  groupNameOf,
  lastGroupMintedBy,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { GROUP_CREATION_NARRATION } from '../watch.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const n = opt('row');
const id = `FLOOR-${n}`;
if (!FLOOR_ROWS[id]) {
  console.error(`usage: bun archive/floor.mjs --row 1|2|3 [--group <uuid>]  (no row ${id})`);
  process.exit(2);
}
const spec = FLOOR_ROWS[id];
const since = new Date().toISOString();
let seats = null;

/** FLOOR-1: one message each way in the fixture DM, timed from the send, then the invariant with its reload. */
async function floor1() {
  const owner = userOf(seats, 'W1');
  const peer = userOf(seats, 'W2');
  const dm = directConversation(owner, peer);
  if (!dm?.groupId) return { premise: ['no owner-peer DM on this estate - run campaign-fixtures.mjs --build (plan section 5 step 2)'] };
  assertRowOwns({ kind: 'dm', id: dm.groupId }, id);
  // EACH SIDE NAMES A DM BY THE OTHER PERSON, so the conversation is one name per device.
  const conversation = { W1: displayNameOf(peer), W2: displayNameOf(owner) };
  const cx = { W1: seats.seat.W1.cx, W2: seats.seat.W2.cx };
  for (const d of ['W1', 'W2']) {
    await ensureChat(cx[d]);
    await openConversation(cx[d], conversation[d]);
  }
  const fromEpoch = serverView(dm.groupId).activeEpoch;

  const legs = [];
  for (const [from, to, tag] of [
    ['W1', 'W2', 'A'],
    ['W2', 'W1', 'B'],
  ]) {
    const marker = rowMessageMark(id, tag);
    // THE RECEIVER IS ALREADY WAITING when the send starts, so the bound measures the product and not
    // the order this script happens to ask in. A miss is `null`, judged by `floor1Own`, never thrown.
    let t0 = 0;
    const arrived = awaitMessage(cx[to], marker, 20_000).then(
      () => Date.now() - t0,
      (e) => {
        console.log(`[${id}] ${to} never rendered ${marker}: ${String(e?.message ?? e).slice(0, 300)}`);
        return null;
      }
    );
    t0 = Date.now();
    await send(cx[from], `${id} ${from}->${to} [${marker}]`);
    const arrivalMs = await arrived;
    await awaitMessage(cx[from], marker, 20_000).catch((e) => console.log(`[${id}] ${from} never showed its own ${marker}: ${String(e?.message ?? e).slice(0, 200)}`));
    legs.push({ from, to, marker, arrivalMs, receiver: await receivedOn(cx[to], marker), sender: await receivedOn(cx[from], marker) });
    console.log(`[${id}] ${from}->${to} ${marker}: ${arrivalMs === null ? 'never' : `${arrivalMs} ms`} (bound ${FLOOR1_BOUND_MS} ms)`);
  }

  // THE INVARIANT RELOADS EVERY WEB CLIENT AND RE-OPENS THE DM, so the row's own markers are re-counted
  // on the reloaded pages right after it: one copy before a reload and two after is a duplicate the
  // store wrote and the memory did not show.
  const invariant = await checkInvariant({
    group: dm.groupId,
    targets: seats.targets,
    conversation,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  const afterReload = [];
  for (const d of ['W1', 'W2']) {
    for (const l of legs) {
      await awaitMessage(cx[d], l.marker, 20_000).catch(() => {});
      afterReload.push({ device: d, marker: l.marker, count: (await receivedOn(cx[d], l.marker)).count });
    }
  }
  return { own: floor1Own(legs, afterReload), invariant, detail: { group: dm.groupId, fromEpoch, legs, afterReload } };
}

/** FLOOR-2: a fresh group from W1, then ONE bulk Add of the three other users. */
async function floor2() {
  const users = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const w1 = seats.seat.W1.cx;
  const group = await mintRowGroup(w1, id, users.W1);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(w1, group.name, { navigate: false, label: id });
  // THE EPOCH BEFORE THE ADD, read once the creation has settled on the server.
  const fromEpoch = serverView(group.id).activeEpoch;
  const joiners = ['W2', 'W4', 'W5'];
  const picked = await addMembers(
    w1,
    joiners.map((d) => displayNameOf(users[d]))
  );
  console.log(`[${id}] one bulk Add of ${picked.join(', ')} submitted from W1 at epoch ${fromEpoch}`);

  const listed = {};
  for (const d of joiners) listed[d] = await awaitListed(seats.seat[d].cx, group.name, 60_000);
  const premise = joiners.filter((d) => listed[d] === null).map((d) => `${d} never listed ${group.name} within 60 s - its Welcome did not land`);
  const view = await awaitServer(group.id, (v) => v.activeEpoch > fromEpoch, 30_000);
  const inPlayDeviceIds = [];
  for (const d of spec.devices) {
    const dev = await deviceIdOf(seats.seat[d].cx, users[d]);
    if (dev) inPlayDeviceIds.push(dev);
    else premise.push(`${d} holds no device id for its account - not enrolled`);
  }
  // A JOINER THAT NEVER LISTED THE GROUP CANNOT BE SENT TO, so the invariant runs only over a premise
  // that holds; otherwise the row is INVALID with the server's view recorded beside it.
  if (premise.length) return { premise, detail: { group: group.id, name: group.name, fromEpoch, listed, view } };
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  const own = floor2Own({ fromEpoch, view: serverView(group.id), expectUsers: Object.values(users), inPlayDeviceIds });
  return {
    own,
    invariant,
    forgiveLogs: { W1: GROUP_CREATION_NARRATION },
    detail: { group: group.id, name: group.name, fromEpoch, listed, picked, settled: view.settled },
  };
}

/** FLOOR-3: FLOOR-2's group, judged with the two phones in play as members. */
async function floor3() {
  const named = opt('group');
  const last = named ? null : lastGroupMintedBy('FLOOR-2');
  const groupId = named ?? last?.id;
  if (!groupId) return { premise: ['no group named and none minted by FLOOR-2 in this estate\'s ledger - run FLOOR-2 first, or pass --group'] };
  assertRowOwns({ kind: 'group', id: groupId }, id);
  const name = last?.name ?? groupNameOf(groupId);
  if (!name) return { premise: [`no live group ${groupId.slice(0, 8)} on this estate`] };
  const premise = floor3Premise(spec.phones, spec.devices);
  for (const p of spec.phones) {
    if ((await awaitListed(seats.seat[p].cx, name, 60_000)) === null) premise.push(`${p} does not list ${name} - not a member device`);
  }
  if (premise.length) return { premise, detail: { group: groupId, name } };
  const fromEpoch = serverView(groupId).activeEpoch;
  const invariant = await checkInvariant({
    group: groupId,
    targets: seats.targets,
    conversation: name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  return { own: [], invariant, detail: { group: groupId, name, fromEpoch } };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await { 'FLOOR-1': floor1, 'FLOOR-2': floor2, 'FLOOR-3': floor3 }[id]();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const observers = await observersOf(seats, { logs: out.forgiveLogs ?? {} });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    () => closeSeats(seats)
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  record(id, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
