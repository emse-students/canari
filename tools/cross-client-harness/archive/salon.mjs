/**
 * THE SALON ROWS OF THE 1.4.1 CAMPAIGN - the removal bound (#2284) on a salon's access list.
 *
 *   bun archive/salon.mjs --row RM-4|RM-5|RM-6
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
import { clearOverlays as clearDialogs, evaluate, openChannel } from '../chat.mjs';
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
  permissionGrid,
  removeCommunityMember,
  revokeChannelAccess,
  saveChannelAccess,
  setChannelPrivate,
  setMemberRole,
} from '../comm.mjs';
import { psql } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { awaitUserRouting, channelIdOf, communityMemberIds, communityRoles, isCommunityMember, salonDistribution, workspaceIdOf } from '../grainedb.mjs';
import { closeSeats, displayNameOf, observersOf, openSeats, userOf } from '../mlsrow.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowGroupName } from '../rowkit.mjs';
import { NAMED, SALON_ROWS, accessRaceOwn, intendedLists, kickRaceCycleOwn, removalBoundOwn, salonEntitlement, statusesIn } from '../salonrows.mjs';

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
const lastStatus = (cx, pathPart, method) => statusesIn(eventsOf(cx), pathPart, method).at(-1) ?? null;

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

/** The `departed` rows recorded for `userId` in the salon's group. INTERPOLATED, so both are proven uuids. */
function departedCount(groupId, userId) {
  if (!groupId || !UUID.test(groupId) || !UUID.test(userId)) return 0;
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

const ACTIONS = {
  /** RM-4: W1 revokes W4 and W2 revokes W5, both PATCHes held and released together. */
  async 'RM-4'(c) {
    const access = `/api/channels/${c.channelId}/access`;
    const before = salonDistribution(c.channelId).allowedUsers;
    const droppedBy = Object.fromEntries(Object.entries(spec.race).map(([admin, target]) => [admin, c.user[target]]));
    const intended = intendedLists(before, droppedBy);
    const faults = {};
    for (const admin of Object.keys(spec.race)) {
      const cx = seats.seat[admin].cx;
      await openChannel(cx, c.community, c.salon);
      await openChannelAccess(cx);
      faults[admin] = await armFault(cx, [{ match: access, method: 'PATCH', fault: 'hold once' }]);
    }
    const gestures = Object.fromEntries(Object.entries(spec.race).map(([admin, target]) => [admin, outcome(revokeChannelAccess(seats.seat[admin].cx, c.name(target)))]));
    const held = {};
    for (const admin of Object.keys(spec.race)) held[admin] = (await outcome(faults[admin].awaitHeld(1, 45_000))).ok;
    await Promise.all(Object.values(faults).map((f) => f.release()));
    const done = {};
    for (const [admin, g] of Object.entries(gestures)) done[admin] = await g;
    const status = {};
    const named = {};
    const records = {};
    for (const admin of Object.keys(spec.race)) {
      const cx = seats.seat[admin].cx;
      status[admin] = lastStatus(cx, access, 'PATCH');
      named[admin] = status[admin] === 409 ? await drawn(cx, NAMED.CHANNEL_ACCESS_CHANGED) : false;
      records[admin] = (await faults[admin].disarm()).records;
      await clearOverlays(cx);
    }
    // THE WINNER'S TARGET IS CUT BY THE SERVER'S DEPARTURE: given its bound before the seats are read.
    const winner = Object.keys(status).find((a) => status[a] >= 200 && status[a] < 300);
    if (winner) await awaitUserRouting(c.channelId, droppedBy[winner], false, 60_000);
    const dist = salonDistribution(c.channelId);
    const seated = {};
    const departed = {};
    for (const u of Object.values(droppedBy)) {
      seated[u.toLowerCase()] = dist.devices.some((d) => d.userId.toLowerCase() === u.toLowerCase() && d.status === 'active');
      departed[u.toLowerCase()] = departedCount(dist.groupId, u);
    }
    return {
      records,
      detail: { before: before.map((u) => u.slice(0, 8)), status, named, held, gestures: done, after: dist.allowedUsers.map((u) => u.slice(0, 8)) },
      judge: () => accessRaceOwn({ held, status, named, intended, droppedBy, allowed: dist.allowedUsers, seated, departed }),
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
      const fk = await armFault(K, [{ match: kickPath, method: 'DELETE', fault: 'hold once' }]);
      const fg = await armFault(G, [{ match: access, method: 'PATCH', fault: 'hold once' }]);
      const gk = outcome(removeCommunityMember(K, c.name(S)));
      const gg = outcome(grantChannelAccess(G, c.name(S)));
      const held = (await outcome(fk.awaitHeld(1, 45_000))).ok && (await outcome(fg.awaitHeld(1, 45_000))).ok;
      await Promise.all([fk.release(), fg.release()]);
      const gestures = { kick: await gk, grant: await gg };
      const kick = lastStatus(K, kickPath, 'DELETE');
      const grant = lastStatus(G, access, 'PATCH');
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
    await setChannelPrivate(M, true);
    const save = await outcome(saveChannelAccess(M));
    const status = lastStatus(M, access, 'PATCH');
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
  const c = { user, name, community, link, workspaceId, salon: `${community}-salon` };
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
  const observers = await observersOf(seats, { provoked: out.records ?? {} });
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
