/**
 * THE SALON ROWS OF THE 1.4.1 CAMPAIGN - the removal bound (#2284) on a salon's access list.
 *
 *   bun archive/salon.mjs --row RM-4|RM-4b|RM-5|RM-6
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table and every judge are `salonrows.mjs`.
 *
 * EACH ROW MINTS ITS OWN COMMUNITY (W1 creates it, the others join by its link) and deletes it once
 * the row is on disk: a role granted, a salon made private and a member kicked are then the
 * campaign's alone, and nothing is left for a later row to inherit. Every gesture is the product's
 * own panel (`comm.mjs`); a race holds the two requests (`fault.mjs`) and releases them together.
 *
 * A SALON IS NOT A SIDEBAR CONVERSATION, so section 4.0's message probe cannot run on it: the row's
 * invariant is the salon's own - every user the server entitles holds an active seat in the salon's
 * group, and nobody else does (`salonrows.mjs` `salonEntitlement`), read once the seats settled.
 */
import { clearOverlays as clearDialogs, evaluate, openChannel, until } from '../chat.mjs';
import { closeOverlays as closePanels } from '../groupnav.mjs';
import {
  PERMISSION_LABELS,
  caption,
  createChannel,
  createCommunity,
  cyclePermissionCell,
  communityTab,
  deleteCommunity,
  grantChannelAccess,
  inviteLink,
  openChannelAccess,
  openCommunity,
  openInviteLink,
  acceptInviteLink,
  PERMISSION_GRID_DRAWN,
  permissionGrid,
  removeCommunityMember,
  revokeChannelAccess,
  setChannelPrivate,
  setMemberRole,
} from '../comm.mjs';
import { psql } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { awaitUserRouting, channelIdOf, communityChannels, communityMemberIds, communityRoles, isCommunityMember, salonDistribution, workspaceIdOf } from '../grainedb.mjs';
import { closeSeats, displayNameOf, observersOf, openSeats, userOf } from '../mlsrow.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowGroupName } from '../rowkit.mjs';
import { NAMED, SALON_ROWS, accessRaceOwn, intendedLists, kickRaceCycleOwn, removalBoundOwn, revokeRaceOwn, salonEntitlement, salonNarration, salonRaceRefusal, salonRaceReread, salonRaceRefusals, statusesIn } from '../salonrows.mjs';
import { PRIVACY_REFUSED_EXCEEDS_ACTOR_NARRATION, atLevels } from '../watch.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!SALON_ROWS[id]) {
  console.error(`usage: bun archive/salon.mjs --row ${Object.keys(SALON_ROWS).join('|')}`);
  process.exit(2);
}
const spec = SALON_ROWS[id];
const since = new Date().toISOString();
let seats = null;
let community = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Clears the dialogs AND the side panel. `chat.mjs`'s `clearOverlays` closes dialogs only, so the
 * community settings panel this runner opens (the invitation link, a role, the permission grid)
 * stayed up: below the `xl` width its scrim covered the next salon row (RM-5, 2026-10-25: "no stable
 * element", the scrim on top).
 */
async function clearOverlays(cx) {
  await clearDialogs(cx);
  await closePanels(cx);
}
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every Network event a page has received, drained or not. */
const eventsOf = (cx) => (cx.consumed ?? []).concat(cx.events ?? []);
/** The last status `cx` received for `pathPart` by `method`, or null. */
const statusCount = (cx, pathPart, method) => statusesIn(eventsOf(cx), pathPart, method).length;

/**
 * THE ANSWER TO THE REQUEST MADE SINCE `before` statuses were seen - waited for, never assumed there.
 *
 * A gesture resolves when the UI is done, not when its request is answered: RM-5 cycle 1 (alpha.4)
 * read "no answer" for a kick the server had retried inline and answered, and a later cycle would
 * have read the PREVIOUS cycle's answer instead. So the count before the gesture is the baseline, and
 * only an answer past it is this request's. Null when none came within `ms`.
 */
async function statusAfter(cx, pathPart, method, before, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const all = statusesIn(eventsOf(cx), pathPart, method);
    if (all.length > before) return all.at(-1);
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

/** Whether `key`'s message is drawn on `cx` within `ms` - the panel NAMING a refusal. */
async function drawn(cx, key, ms = 10_000) {
  const text = caption(key);
  const end = Date.now() + ms;
  for (;;) {
    const shown = await evaluate(cx, `document.body.innerText.indexOf(${JSON.stringify(text)}) >= 0`);
    if (shown === true || shown === 'true') return true;
    if (Date.now() > end) return false;
    await sleep(500);
  }
}

/** A user id as the server spells it: 64 hex characters, never a uuid. */
const USER_ID = /^[0-9a-f]{64}$/i;

/**
 * The `departed` rows recorded for `userId` in the salon's group. INTERPOLATED, so both are proven
 * ids first - and an id that is not one THROWS: until 2026-10-25 a user id was checked against the
 * uuid pattern, every one failed it, and the count read 0 without a query (RM-4b's first run FAILED
 * on that alone, while the server logged both departures).
 */
function departedCount(groupId, userId) {
  if (!groupId || !UUID.test(groupId) || !USER_ID.test(userId)) throw new Error(`departedCount: not a group uuid and a user id (${String(groupId).slice(0, 8)}, ${String(userId).slice(0, 8)})`);
  return Number(psql(`SELECT count(*) FROM distribution_departures WHERE "groupId" = '${groupId}' AND lower("userId") = '${userId.toLowerCase()}' AND outcome = 'departed'`).trim() || 0);
}

/** Opens the salon on `device` and waits for its seat in the salon's group (a member commits its own Add). */
async function seatIn(c, device) {
  await openChannel(seats.seat[device].cx, c.community, c.salon);
  return awaitUserRouting(c.channelId, c.user[device], true, 60_000);
}

/** A seat that is not the community's yet joins it by the row's link. */
async function joinByLink(c, device) {
  const cx = seats.seat[device].cx;
  const seen = await openInviteLink(cx, c.link);
  if (!seen.valid) throw new Error(`${device}: the row's invite link was refused`);
  await acceptInviteLink(cx);
}

/**
 * Leaves the moderator role holding `channel.manage` and nothing else, through W1's grid. A cell
 * cycles, and only `allow` grants, so each pass re-reads the grid and clicks what is still wrong.
 */
async function moderatorOnlyManagesChannels(cx) {
  const isModerator = (r) =>
    String(r)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .startsWith('mod');
  await communityTab(cx, 'roles');
  // THE GRID IS WAITED FOR, never read on the click: `clearOverlays` closes the side panel, so the
  // tab opens it fresh and the table renders after the click returns - read at once, it answered no
  // roles at all (RM-6, 2026-10-25: "no moderator column in the grid ()").
  await until(cx, PERMISSION_GRID_DRAWN, 15_000);
  for (let pass = 0; pass < 4; pass++) {
    const grid = await permissionGrid(cx);
    const col = (grid.roles ?? []).findIndex(isModerator);
    if (col < 0) throw new Error(`no moderator column in the grid (${(grid.roles ?? []).join(', ')})`);
    let clicked = false;
    for (const [key, label] of Object.entries(PERMISSION_LABELS)) {
      const row = grid.permissions.indexOf(label);
      if (row < 0) continue;
      if ((grid.cells[row][col] === 'allow') !== (key === 'channel.manage')) {
        await cyclePermissionCell(cx, label, col + 1);
        clicked = true;
        await sleep(1_200);
      }
    }
    if (!clicked) break;
  }
  await clearOverlays(cx);
}

/**
 * THE TWO ADMINS' RACE, ONE SHAPE FOR RM-4 AND RM-4b: each opens the salon's access panel, arms a
 * hold on `rule`, plays `gesture` on its own target, and both requests are released together once
 * both are held. Returns what each seat was answered, whether each was held, and the fault records.
 */
async function heldRace(c, rule, gesture) {
  const admins = Object.keys(spec.race);
  const faults = {};
  for (const admin of admins) {
    const cx = seats.seat[admin].cx;
    await openChannel(cx, c.community, c.salon);
    await openChannelAccess(cx);
    faults[admin] = await armFault(cx, [{ ...rule, fault: 'hold once' }]);
  }
  const before = Object.fromEntries(admins.map((admin) => [admin, statusCount(seats.seat[admin].cx, rule.match, rule.method)]));
  const pending = Object.fromEntries(admins.map((admin) => [admin, outcome(gesture(seats.seat[admin].cx, c.name(spec.race[admin])))]));
  const held = {};
  for (const admin of admins) held[admin] = (await outcome(faults[admin].awaitHeld(1, 45_000))).ok;
  await Promise.all(Object.values(faults).map((f) => f.release()));
  const gestures = {};
  for (const admin of admins) gestures[admin] = await pending[admin];
  const status = {};
  const records = {};
  for (const admin of admins) {
    status[admin] = await statusAfter(seats.seat[admin].cx, rule.match, rule.method, before[admin]);
    records[admin] = (await faults[admin].disarm()).records;
  }
  return { held, status, records, gestures, named: {} };
}

/** Per user id (lower case), whether it holds an active seat in the salon's group. */
const seatedOf = (dist, users) =>
  Object.fromEntries(users.map((u) => [u.toLowerCase(), (dist?.devices ?? []).some((d) => d.userId.toLowerCase() === u.toLowerCase() && d.status === 'active')]));

const ACTIONS = {
  /** RM-4: W1 grants W4 and W2 grants W5, both access PATCHes held and released together. */
  async 'RM-4'(c) {
    const access = `/api/channels/${c.channelId}/access`;
    const before = salonDistribution(c.channelId).allowedUsers;
    const targetOf = Object.fromEntries(Object.entries(spec.race).map(([admin, target]) => [admin, c.user[target]]));
    const intended = intendedLists(before, targetOf, 'grant');
    const race = await heldRace(c, { match: access, method: 'PATCH' }, grantChannelAccess);
    for (const admin of Object.keys(spec.race)) {
      race.named[admin] = race.status[admin] === 409 ? await drawn(seats.seat[admin].cx, NAMED.CHANNEL_ACCESS_CHANGED) : false;
      await clearOverlays(seats.seat[admin].cx);
    }
    // EACH GRANTEE GIVEN ITS ANSWER BEFORE THE SEATS ARE READ: an allowed member commits its own Add
    // once it loads the salon, and one left off is given the bound to stay out.
    const allowedNow = salonDistribution(c.channelId).allowedUsers.map((u) => u.toLowerCase());
    for (const [admin, target] of Object.entries(spec.race)) {
      if (allowedNow.includes(targetOf[admin].toLowerCase())) await seatIn(c, target);
      else await awaitUserRouting(c.channelId, targetOf[admin], false, 60_000);
    }
    const dist = salonDistribution(c.channelId);
    const seated = seatedOf(dist, Object.values(targetOf));
    return {
      records: race.records,
      detail: { before: before.map((u) => u.slice(0, 8)), status: race.status, named: race.named, held: race.held, gestures: race.gestures, after: dist.allowedUsers.map((u) => u.slice(0, 8)) },
      judge: () => accessRaceOwn({ held: race.held, status: race.status, named: race.named, intended, targetOf, allowed: dist.allowedUsers, seated }),
    };
  },

  /** RM-4b: W1 revokes W4 and W2 revokes W5 through the panel's per-member DELETE, held and released together. */
  async 'RM-4b'(c) {
    const before = salonDistribution(c.channelId).allowedUsers;
    const targetOf = Object.fromEntries(Object.entries(spec.race).map(([admin, target]) => [admin, c.user[target]]));
    const expected = before.filter((u) => !Object.values(targetOf).some((t) => t.toLowerCase() === u.toLowerCase()));
    // `/api/channels/<salon>/members/` - the salon's own route, never the community kick's
    // (`/api/channels/workspaces/<id>/members/`), which RM-5 holds.
    const race = await heldRace(c, { match: `/api/channels/${c.channelId}/members/`, method: 'DELETE' }, revokeChannelAccess);
    for (const admin of Object.keys(spec.race)) await clearOverlays(seats.seat[admin].cx);
    for (const u of Object.values(targetOf)) await awaitUserRouting(c.channelId, u, false, 60_000);
    const dist = salonDistribution(c.channelId);
    const seated = seatedOf(dist, Object.values(targetOf));
    const departed = Object.fromEntries(Object.values(targetOf).map((u) => [u.toLowerCase(), departedCount(dist.groupId, u)]));
    return {
      records: race.records,
      detail: { before: before.map((u) => u.slice(0, 8)), status: race.status, held: race.held, gestures: race.gestures, departed, after: dist.allowedUsers.map((u) => u.slice(0, 8)) },
      judge: () => revokeRaceOwn({ held: race.held, status: race.status, expected, targetOf, allowed: dist.allowedUsers, seated, departed }),
    };
  },

  /** RM-5: W1 kicks W4 while W2 grants W4 into the private salon, held and released together, x5. */
  async 'RM-5'(c) {
    const S = spec.subject;
    const u = c.user[S];
    const kickPath = `/api/channels/workspaces/${c.workspaceId}/members/`;
    const access = `/api/channels/${c.channelId}/access`;
    const cycles = [];
    const records = { [spec.kicker]: [], [spec.granter]: [] };
    for (let i = 1; i <= spec.cycles; i++) {
      // THE CYCLE'S STARTING POINT: the subject a member, and not on the salon's list.
      if (!isCommunityMember(c.workspaceId, u)) await joinByLink(c, S);
      if (salonDistribution(c.channelId).allowedUsers.some((x) => x.toLowerCase() === u.toLowerCase())) {
        await openChannel(seats.seat.W1.cx, c.community, c.salon);
        await openChannelAccess(seats.seat.W1.cx);
        await revokeChannelAccess(seats.seat.W1.cx, c.name(S));
        await clearOverlays(seats.seat.W1.cx);
        await awaitUserRouting(c.channelId, u, false, 60_000);
      }
      const K = seats.seat[spec.kicker].cx;
      const G = seats.seat[spec.granter].cx;
      await openCommunity(K, c.community);
      await openChannel(G, c.community, c.salon);
      await openChannelAccess(G);
      const before = { kick: statusCount(K, kickPath, 'DELETE'), grant: statusCount(G, access, 'PATCH') };
      const fk = await armFault(K, [{ match: kickPath, method: 'DELETE', fault: 'hold once' }]);
      const fg = await armFault(G, [{ match: access, method: 'PATCH', fault: 'hold once' }]);
      const gk = outcome(removeCommunityMember(K, c.name(S)));
      const gg = outcome(grantChannelAccess(G, c.name(S)));
      const held = (await outcome(fk.awaitHeld(1, 45_000))).ok && (await outcome(fg.awaitHeld(1, 45_000))).ok;
      await Promise.all([fk.release(), fg.release()]);
      const gestures = { kick: await gk, grant: await gg };
      const kick = await statusAfter(K, kickPath, 'DELETE', before.kick);
      const grant = await statusAfter(G, access, 'PATCH', before.grant);
      const supersededNamed = kick === 409 ? await drawn(K, NAMED.DEPARTURE_SUPERSEDED) : false;
      records[spec.kicker].push(...(await fk.disarm()).records);
      records[spec.granter].push(...(await fg.disarm()).records);
      await clearOverlays(K);
      await clearOverlays(G);
      const member = isCommunityMember(c.workspaceId, u);
      const allowed = salonDistribution(c.channelId).allowedUsers.some((x) => x.toLowerCase() === u.toLowerCase());
      // WHOLE MEANS SEATED TOO: a member on the list commits its own Add once it loads the salon.
      const routed = member && allowed ? await seatIn(c, S) : await awaitUserRouting(c.channelId, u, false, 60_000);
      const seated = routed.dist.devices.some((d) => d.userId.toLowerCase() === u.toLowerCase() && d.status === 'active');
      cycles.push({ i, held, kick, grant, member, allowed, seated, supersededNamed, gestures });
    }
    return {
      records,
      detail: { cycles: cycles.map(({ gestures: _g, ...k }) => k) },
      judge: () => cycles.flatMap((k) => kickRaceCycleOwn(k.i, k)),
    };
  },

  /** RM-6: W2, a moderator holding only channel.manage, makes the public salon private. */
  async 'RM-6'(c) {
    const W1 = seats.seat.W1.cx;
    const M = seats.seat[spec.manager].cx;
    await setMemberRole(W1, c.name(spec.manager), 'moderator');
    await clearOverlays(W1);
    await moderatorOnlyManagesChannels(W1);
    const mod = communityRoles(c.workspaceId).find((r) => /^mod/i.test(r.name.normalize('NFD').replace(/[̀-ͯ]/g, '')));
    const access = `/api/channels/${c.channelId}/access`;
    await openChannel(M, c.community, c.salon);
    await openChannelAccess(M);
    // THE TOGGLE IS THE WRITE (#1171): no save follows it, and its answer is the row's subject.
    const before = statusCount(M, access, 'PATCH');
    const save = await outcome(setChannelPrivate(M, true));
    const status = await statusAfter(M, access, 'PATCH', before);
    const named = await drawn(M, NAMED.REMOVAL_EXCEEDS_ACTOR);
    await clearOverlays(M);
    const dist = salonDistribution(c.channelId);
    return {
      detail: { save, status, moderatorPermissions: mod?.permissions ?? null, isPrivate: dist?.isPrivate ?? null },
      judge: () => removalBoundOwn({ managerPermissions: mod?.permissions ?? [], status, named, dist }),
    };
  },
};

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const name = (d) => displayNameOf(user[d]);
  const W1 = seats.seat.W1.cx;
  community = rowGroupName(id);
  await createCommunity(W1, community);
  const link = await inviteLink(W1);
  await clearOverlays(W1);
  const workspaceId = workspaceIdOf(community, { memberUserId: user.W1 });
  if (!workspaceId) return { premise: [`${community} is not on the server after its creation`], detail: {} };
  // LOWER CASE, because a salon granted live is drawn lowercased on the grantee until it reloads (the
  // P3 in `docs/wiki/backlog.md`, RM-4 2026-10-25): with a mixed-case name the grantee's row never
  // matched and the premise failed on a defect that is not this row's subject.
  const c = { user, name, community, link, workspaceId, salon: `${community}-salon`.toLowerCase() };
  for (const d of spec.devices.filter((x) => x !== 'W1')) await joinByLink(c, d);
  const premise = spec.devices.filter((d) => !isCommunityMember(workspaceId, user[d])).map((d) => `${d} is not a member of ${community}`);
  if (premise.length) return { premise, detail: { workspaceId } };

  await openCommunity(W1, community);
  await createChannel(W1, c.salon, { visibility: spec.salon });
  c.channelId = channelIdOf(workspaceId, c.salon);
  if (!c.channelId) return { premise: [`${c.salon} is not on the server after its creation`], detail: { workspaceId } };
  for (const a of spec.admins ?? []) {
    await setMemberRole(W1, name(a), 'admin');
    await clearOverlays(W1);
  }
  if (spec.allow?.length) {
    await openChannel(W1, community, c.salon);
    await openChannelAccess(W1);
    for (const d of spec.allow) await grantChannelAccess(W1, name(d));
    await clearOverlays(W1);
    for (const d of ['W1', ...spec.allow]) if (!(await seatIn(c, d)).ok) premise.push(`${d} never took its seat in ${c.salon}'s group`);
    if (premise.length) return { premise, detail: { workspaceId, channelId: c.channelId } };
  }

  const act = await ACTIONS[id](c);
  // THE SEATS SETTLE BEFORE THE INVARIANT READS THEM: an entitled user loads the salon, the rest are given the bound.
  const members = communityMemberIds(workspaceId);
  const dist = salonDistribution(c.channelId);
  if (dist?.isPrivate) {
    for (const d of spec.devices) {
      const entitled = members.some((m) => m.toLowerCase() === user[d].toLowerCase()) && dist.allowedUsers.some((m) => m.toLowerCase() === user[d].toLowerCase());
      if (entitled) await seatIn(c, d);
      else await awaitUserRouting(c.channelId, user[d], false, 60_000);
    }
  }
  const invariant = salonEntitlement({ pass: 'after the action', dist: salonDistribution(c.channelId), members: communityMemberIds(workspaceId), users: Object.values(user) });
  return {
    own: act.judge(),
    invariant,
    records: act.records ?? {},
    detail: { community, workspaceId, channelId: c.channelId, ...act.detail },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  // THE ROW'S COMMUNITY NARRATES ITSELF on every seat, scoped to its own ids (`salonNarration`); the
  // access race's loser is RM-4's own subject, at `debug` only.
  const scope = out.detail?.workspaceId ? { workspaceId: out.detail.workspaceId, ...communityChannels(out.detail.workspaceId) } : null;
  const narration = scope ? [...salonNarration(scope), ...(id === 'RM-4' ? [atLevels(['debug'], salonRaceRefusal(scope.channelIds)), atLevels(['debug'], salonRaceReread(scope.channelIds))] : [])] : [];
  const logs = Object.fromEntries(spec.devices.map((d) => [d, narration]));
  // ... and the manager's panel narrates that same refusal, by its code and at `debug` only: any other
  // code, or the same words at `warn`, stays dirt (alpha.4 rerun, 2026-10-25).
  if (id === 'RM-6') {
    logs[spec.manager] = [...narration, ...PRIVACY_REFUSED_EXCEEDS_ACTOR_NARRATION];
  }
  // RM-6's 403 IS ITS SUBJECT: the manager's flip refused on the salon's own access path, nothing wider.
  const refusals = id === 'RM-6' && out.detail?.channelId ? { [spec.manager]: [{ path: new RegExp(`^/api/channels/${out.detail.channelId}/access$`), status: [403] }] } : {};
  // RM-4's 409 IS ITS SUBJECT TOO: the access race's loser, on either racing admin's seat - only one
  // loses, and `accessRaceOwn` asserts which (alpha.5, 2026-10-26).
  if (id === 'RM-4' && scope) for (const d of Object.keys(spec.race)) refusals[d] = salonRaceRefusals(scope.channelIds);
  const observers = await observersOf(seats, { provoked: out.records ?? {}, logs, refusals });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    async () => {
      // THE ROW'S COMMUNITY GOES WITH IT, once the verdict is on disk; a failure here is logged, never the row.
      await openCommunity(seats.seat.W1.cx, community)
        .then(() => deleteCommunity(seats.seat.W1.cx, community))
        .catch((e) => console.log(`[${id}] the row's community ${community} was NOT deleted: ${String(e?.message ?? e)}`));
      closeSeats(seats);
    }
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  record(id, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
