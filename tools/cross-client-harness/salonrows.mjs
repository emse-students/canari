/**
 * THE SALON ROWS OF THE 1.4.1 CAMPAIGN - RM-4..6, the removal bound (#2284) - their table and judges.
 *
 * Pure, so `archive/salon-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/salon.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is the plan. Every row
 * plays in a community of its OWN (minted by W1, joined by link, deleted at the end), so a role it
 * grants, a salon it makes private and a member it kicks are the campaign's and nobody else's.
 */

/** The refusals the panel must NAME, by the message key the app draws them from. */
export const NAMED = {
  CHANNEL_ACCESS_CHANGED: 'chat_channel_access_changed_error',
  DEPARTURE_SUPERSEDED: 'chat_community_departure_retry_error',
  REMOVAL_EXCEEDS_ACTOR: 'chat_community_removal_exceeds_actor_error',
};

/** The rows `archive/salon.mjs` plays. */
export const SALON_ROWS = {
  // RM-4 IS A GRANT RACE, AND IT WAS A REVOKE RACE UNTIL 2026-10-25. The panel's revoke is NOT an
  // access-list rewrite: its trash button calls `removeMemberFromChannel`, a `DELETE
  // /api/channels/:id/members/:userId` that strips one user under the lock, so the row held a PATCH
  // that was never sent and both revokes landed. The only panel gestures that rewrite the list - the
  // PATCH whose locked re-read refuses `409 CHANNEL_ACCESS_CHANGED` - are a grant, the visibility
  // toggle and the write policy, and EVERY such PATCH reaches that re-read, not only one that drops
  // someone (`updateChannelAccess`: the save is inside `departDistributionGroups`'s roster write,
  // cuts or none). The revoke race is a row of its own, RM-4b, on the path the panel really sends.
  'RM-4': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    admins: ['W2'],
    salon: 'private',
    allow: ['W2'],
    gesture: 'grant',
    race: { W1: 'W4', W2: 'W5' },
    what: "W1 and W2, both admins, each grant a different member into one private salon, both access PATCHes held and released together",
  },
  'RM-4b': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    admins: ['W2'],
    salon: 'private',
    allow: ['W2', 'W4', 'W5'],
    gesture: 'revoke',
    race: { W1: 'W4', W2: 'W5' },
    what: "W1 and W2, both admins, each revoke a different member of one private salon through the panel's per-member DELETE, both held and released together",
  },
  'RM-5': {
    devices: ['W1', 'W2', 'W4'],
    admins: ['W2'],
    salon: 'private',
    allow: ['W2'],
    subject: 'W4',
    kicker: 'W1',
    granter: 'W2',
    cycles: 5,
    what: "W1 kicks W4 from the community while W2 grants W4 into a private salon, both held and released together, five times",
  },
  'RM-6': {
    devices: ['W1', 'W2'],
    manager: 'W2',
    salon: 'public',
    what: "W2, holding only `channel.manage`, makes a public salon private - which leaves W1 (an admin) off it",
  },
};

const low = (s) => String(s ?? '').toLowerCase();
const sameSet = (a, b) => {
  const A = new Set((a ?? []).map(low));
  const B = new Set((b ?? []).map(low));
  return A.size === B.size && [...A].every((x) => B.has(x));
};
const ok2xx = (s) => typeof s === 'number' && s >= 200 && s < 300;
const show = (ids) => (ids ?? []).map((u) => low(u).slice(0, 8)).join(',') || 'none';

/**
 * The statuses a page received for `pathPart`, in order, from its CDP Network events - restricted to
 * one HTTP method by the request each answer belongs to. The answer to a held request arrives after
 * its release, so this is read once the race is over.
 *
 * @param {{method: string, params: object}[]} events `cx.consumed` + `cx.events`
 * @param {string} pathPart a substring of the url
 * @param {string} [method] `PATCH`, `DELETE`...
 * @returns {number[]}
 */
export function statusesIn(events, pathPart, method = null) {
  const methodOf = new Map();
  for (const e of events ?? []) if (e.method === 'Network.requestWillBeSent') methodOf.set(e.params?.requestId, e.params?.request?.method);
  return (events ?? [])
    .filter((e) => e.method === 'Network.responseReceived' && String(e.params?.response?.url ?? '').includes(pathPart) && (!method || methodOf.get(e.params?.requestId) === method))
    .map((e) => e.params.response.status);
}

/**
 * The allowlist each admin INTENDED: the list both read, plus the member it granted (`grant`) or
 * minus the member it revoked (`revoke`).
 *
 * @param {string[]} before the allowlist both panels showed (user ids)
 * @param {Record<string, string>} targetOf admin seat -> the user id it granted or revoked
 * @param {'grant'|'revoke'} gesture
 */
export function intendedLists(before, targetOf, gesture) {
  if (gesture !== 'grant' && gesture !== 'revoke') throw new Error(`intendedLists: unknown gesture '${gesture}'`);
  return Object.fromEntries(
    Object.entries(targetOf).map(([admin, u]) => [admin, gesture === 'grant' ? [...(before ?? []), u] : (before ?? []).filter((x) => low(x) !== low(u))])
  );
}

/**
 * RM-4, the grant race: one admin's rewrite stood whole, the other was refused `409
 * CHANNEL_ACCESS_CHANGED` and told so, and only the winner's grantee got in.
 *
 * TWO 2xx IS NAMED FOR WHAT IT IS. The PATCH carries no base the client read, so the server's 409
 * fires only when both requests fall between its own read and its lock; a rewrite that reads after
 * the other's save carries the panel's stale list and DROPS the first grantee, answered 200. The
 * judge says which of the two it saw, so the verdict carries the evidence.
 *
 * @param {object} p
 * @param {Record<string, boolean>} p.held per admin, whether its PATCH was held (the race happened)
 * @param {Record<string, number|null>} p.status per admin, the PATCH's answer
 * @param {Record<string, boolean>} p.named per admin, whether its panel drew the refusal
 * @param {Record<string, string[]>} p.intended per admin, the allowlist it meant
 * @param {Record<string, string>} p.targetOf per admin, the user it granted
 * @param {string[]} p.allowed the salon's allowlist afterwards (server)
 * @param {Record<string, boolean>} p.seated per user id, whether it holds an active seat in the salon's group
 */
export function accessRaceOwn({ held, status, named, intended, targetOf, allowed, seated }) {
  const admins = Object.keys(held);
  const out = admins.map((a) => ({ what: `${a}'s PATCH was held and released with the other (${held[a] ? 'held' : 'NOT held'})`, ok: held[a] }));
  const winners = admins.filter((a) => ok2xx(status[a]));
  const losers = admins.filter((a) => status[a] === 409);
  const lost = winners.length === 2 ? admins.filter((a) => !(allowed ?? []).map(low).includes(low(targetOf[a]))) : [];
  const why = lost.length ? `; ${lost.map((a) => `${a}'s grantee`).join(', ')} DROPPED by the other's stale list - a lost update` : '';
  out.push({ what: `one rewrite won and the other was refused 409 (${admins.map((a) => `${a} ${status[a] ?? 'no answer'}`).join(', ')}${why})`, ok: winners.length === 1 && losers.length === 1 });
  if (winners.length !== 1 || losers.length !== 1) return out;
  const [win] = winners;
  const [lose] = losers;
  out.push({ what: `${lose}'s panel names the refusal (CHANNEL_ACCESS_CHANGED)`, ok: named[lose] === true });
  out.push({ what: `the allowlist is ${win}'s whole edit (${show(allowed)} vs ${show(intended[win])})`, ok: sameSet(allowed, intended[win]) });
  const refused = targetOf[lose];
  out.push({ what: `${lose}'s grantee is not allowed - the refused rewrite let nobody in`, ok: !(allowed ?? []).map(low).includes(low(refused)) });
  out.push({ what: `${lose}'s grantee holds no seat in the salon's group (${seated[low(refused)] ? 'SEATED' : 'none'})`, ok: seated[low(refused)] === false });
  const admitted = targetOf[win];
  out.push({ what: `${win}'s grantee holds a seat in the salon's group (${seated[low(admitted)] ? 'seated' : 'NO seat'})`, ok: seated[low(admitted)] === true });
  return out;
}

/**
 * RM-4b, the revoke race on the path the panel sends: two per-member DELETEs, each stripping its own
 * user under the lock - so BOTH stand, nothing is refused, and both targets are cut.
 *
 * @param {object} p
 * @param {Record<string, boolean>} p.held per admin, whether its DELETE was held
 * @param {Record<string, number|null>} p.status per admin, the DELETE's answer
 * @param {string[]} p.expected the allowlist both revokes leave (the list both read, minus both targets)
 * @param {Record<string, string>} p.targetOf per admin, the user it revoked
 * @param {string[]} p.allowed the salon's allowlist afterwards (server)
 * @param {Record<string, boolean>} p.seated per user id, whether it holds an active seat in the salon's group
 * @param {Record<string, number>} p.departed per user id, the `departed` rows recorded for it
 */
export function revokeRaceOwn({ held, status, expected, targetOf, allowed, seated, departed }) {
  const admins = Object.keys(held);
  const out = admins.map((a) => ({ what: `${a}'s DELETE was held and released with the other (${held[a] ? 'held' : 'NOT held'})`, ok: held[a] }));
  out.push({ what: `both revokes stood, none refused (${admins.map((a) => `${a} ${status[a] ?? 'no answer'}`).join(', ')})`, ok: admins.every((a) => ok2xx(status[a])) });
  out.push({ what: `the allowlist lost both targets and nobody else (${show(allowed)} vs ${show(expected)})`, ok: sameSet(allowed, expected) });
  for (const a of admins) {
    const u = targetOf[a];
    out.push({ what: `${a}'s target holds no seat in the salon's group (${seated[low(u)] ? 'STILL seated' : 'gone'})`, ok: seated[low(u)] === false });
    out.push({ what: `a departure was recorded for ${a}'s target (${departed[low(u)] ?? 0})`, ok: (departed[low(u)] ?? 0) >= 1 });
  }
  return out;
}

/**
 * RM-5's CLOSING UNCONTESTED GRANT - the stale-leaf question (#2552). After the race cycles, with at
 * least one where the grant landed first (a refused Welcome can leave the subject's leaf behind),
 * the subject is let back in and granted with no kick beside it. Three things must then hold: the
 * subject's devices are `active` in the salon's group, one row each; a salon message reaches the
 * subject's seat; and the tree the subject joined holds exactly one leaf per active device - a stale
 * leaf left by a refused Welcome is gone or reused, never a second leaf beside the new one.
 *
 * @param {object} c
 * @param {number} c.grantFirstCycles cycles whose grant was accepted (2xx)
 * @param {{deviceId: string, status: string}[]} c.subjectRows the subject's delivery rows after the grant
 * @param {boolean} c.readable the closing marker reached the subject's seat
 * @param {number|null} c.leaves the leaf count the subject's own roster check reported, null if none
 * @param {number} c.activeDevices active delivery rows on the salon's group
 * @param {string} [c.error] a gesture that threw
 */
export function kickRaceClosingOwn({ grantFirstCycles, subjectRows, readable, leaves, activeDevices, error }) {
  const rows = subjectRows ?? [];
  const ids = rows.map((r) => r.deviceId);
  const out = [
    { what: `closing: at least one cycle had the grant land first (${grantFirstCycles})`, ok: grantFirstCycles > 0 },
    {
      what: `closing: the subject is seated, one active row per device (${rows.map((r) => r.status).join(', ') || 'no row'})`,
      ok: rows.length > 0 && rows.every((r) => r.status === 'active') && new Set(ids).size === ids.length,
    },
    { what: `closing: a salon message reached the subject (${readable ? 'read' : 'NOT read'})`, ok: readable === true },
    {
      what: `closing: no stale leaf - ${leaves ?? 'no'} leaf/leaves for ${activeDevices} active device(s)`,
      ok: typeof leaves === 'number' && leaves === activeDevices,
    },
  ];
  if (error) out.push({ what: `closing: a gesture threw - ${error}`, ok: false });
  return out;
}

/**
 * RM-5, one cycle: the kick stood (retried inline), and the subject ended WHOLE - a member, allowed
 * and seated, or none of the three.
 *
 * @param {number} i the cycle, from 1
 * @param {object} c
 * @param {boolean} c.held both requests were held and released together
 * @param {number|null} c.kick the kick's answer
 * @param {number|null} c.grant the grant's answer
 * @param {boolean} c.member still a community member
 * @param {boolean} c.allowed on the salon's allowlist
 * @param {boolean} c.seated an active seat in the salon's group
 * @param {boolean} c.supersededNamed the kicker's panel named DEPARTURE_SUPERSEDED (only after a 409)
 */
export function kickRaceCycleOwn(i, { held, kick, grant, member, allowed, seated, supersededNamed }) {
  const whole = (member && allowed && seated) || (!member && !allowed && !seated);
  const out = [
    { what: `cycle ${i}: the kick and the grant were held and released together (${held ? 'held' : 'NOT held'})`, ok: held },
    {
      what: `cycle ${i}: the kick stood, retried inline (${kick ?? 'no answer'})`,
      ok: ok2xx(kick),
    },
    {
      what: `cycle ${i}: the subject ended whole, never half (member ${member}, allowed ${allowed}, seated ${seated}; grant ${grant ?? 'no answer'})`,
      ok: whole,
    },
  ];
  if (kick === 409) out.push({ what: `cycle ${i}: the 409 is named as a departure to retry`, ok: supersededNamed === true });
  return out;
}

/**
 * RM-6: refused `403 REMOVAL_EXCEEDS_ACTOR`, named, and nothing begun - still public, no group.
 *
 * @param {object} p
 * @param {string[]} p.managerPermissions the manager's role permissions on the server (premise)
 * @param {number|null} p.status the PATCH's answer
 * @param {boolean} p.named the panel drew the refusal
 * @param {{isPrivate: boolean, groupId: string|null, linkedGroupId: string|null}|null} p.dist the salon afterwards
 */
export function removalBoundOwn({ managerPermissions, status, named, dist }) {
  return [
    { what: `the manager's role holds channel.manage and nothing else (${(managerPermissions ?? []).join(',') || 'none'})`, ok: sameSet(managerPermissions, ['channel.manage']) },
    { what: `the save was refused 403 (${status ?? 'no answer'})`, ok: status === 403 },
    { what: 'the panel names the refusal (REMOVAL_EXCEEDS_ACTOR)', ok: named === true },
    { what: `the salon is still public (${dist ? (dist.isPrivate ? 'PRIVATE' : 'public') : 'unread'})`, ok: !!dist && dist.isPrivate === false },
    { what: `no group was minted for it (${dist?.groupId ?? dist?.linkedGroupId ?? 'none'})`, ok: !!dist && !dist.groupId && !dist.linkedGroupId },
  ];
}

/**
 * The salon's own invariant, the one a salon has instead of a sidebar conversation's: every user
 * the server ENTITLES (a community member on the allowlist) holds an active seat in the salon's
 * group, and every user it does not holds none. Shaped like `checkInvariant`'s result so
 * `composeVerdict` and `invariantDetail` take it unchanged.
 *
 * @param {object} p
 * @param {string} p.pass when it was read
 * @param {{isPrivate: boolean, allowedUsers: string[], devices: {userId: string, status: string}[]}|null} p.dist
 * @param {string[]} p.members the community's member ids
 * @param {string[]} p.users the users this row put in play
 */
export function salonEntitlement({ pass, dist, members, users }) {
  const failures = [];
  if (!dist) failures.push({ invariant: 'S', what: 'the salon is not on the server' });
  else if (dist.isPrivate) {
    const memberSet = new Set((members ?? []).map(low));
    const allowSet = new Set((dist.allowedUsers ?? []).map(low));
    for (const u of users) {
      const entitled = memberSet.has(low(u)) && allowSet.has(low(u));
      const seated = (dist.devices ?? []).some((d) => low(d.userId) === low(u) && d.status === 'active');
      if (entitled !== seated) failures.push({ invariant: 'S', what: `${low(u).slice(0, 8)} is ${entitled ? 'entitled' : 'not entitled'} but ${seated ? 'holds' : 'holds no'} active seat in the salon's group` });
    }
  }
  return { ok: failures.length === 0, passes: [{ pass, ok: failures.length === 0, failures, approximations: [{ invariant: 'S', what: "a salon is not a sidebar conversation: section 4.0's message probe is replaced by the entitlement check" }] }] };
}

const short = (id) => String(id).slice(0, 8);
const anyOf = (ids) => `(?:${ids.map(short).join('|') || '(?!)'})`;

/**
 * WHAT A SALON ROW'S COMMUNITY SAYS ABOUT ITSELF, ONE LINE PER EVENT, scoped to the row's own ids.
 *
 * Every salon row mints a community, joins three people to it by link, makes a private salon and
 * grants or revokes in it - and each of those says so once: the join landing in a channel, the link
 * carrying no admission proof (a plain invite, so no past), the creator endorsing the link, the key
 * group's Welcome installed as a seed carrier, the admitter's grant, a joiner waiting for the
 * admitter's Welcome rather than joining by external commit, a role landing, the panel's
 * function-entry logs and a route's first preload. First met on RM-4's first alpha.4 run
 * (2026-10-25), which was the first time the row reached judging.
 *
 * `page … decoded after its salon entry was decided` joined on `1.4.1-alpha.6` (2026-10-26): its
 * source now says it ONCE per salon per session (`useConversations.svelte.ts`), the decision and not
 * a read, so it is narration here for the row's own salons.
 *
 * NOT HERE, ON PURPOSE: the lines said once per READ rather than per decision - Graine's `sending 0
 * of 0` / `holds nothing` answers and absorbs, `stored page empty` - which are fixed at the source
 * and stay dirt until then; and `redelivered Welcome ignored`, a duplicate delivery the backlog
 * already carries.
 *
 * @param {{workspaceId: string, channelIds: string[], keyGroupIds: string[]}} p
 */
export function salonNarration({ workspaceId, channelIds, keyGroupIds }) {
  const ws = short(workspaceId);
  const ch = anyOf(channelIds);
  const kg = anyOf(keyGroupIds);
  const R = (s) => new RegExp(s);
  return [
    R(String.raw`^Joined channel ${ch}…$`),
    /^\[INVITE\] this link carries no admission proof - joining with no past$/,
    R(String.raw`^\[GRAINE\] invite link to community ${ws} endorsed by device web-[0-9a-f]{4}$`),
    R(String.raw`^\[WELCOME\] ${kg}\.\.\. is a KEY-DISTRIBUTION group \(server row\) - installing it as a seed carrier$`),
    R(String.raw`^\[QUEUE\] Welcome for key group ${kg}\.\.\. - not announced to the conversation layer$`),
    R(String.raw`^\[GRAINE\] ADMIT salon grantee [0-9a-f]{8} to ${ch} \(community ${ws}\)$`),
    R(String.raw`^\[GRAINE\] salon ${ch} of ${ws}: a Welcome is owed to this device \((?:welcome-queued|add-in-flight)\) - not joining by external commit, the admitter's Welcome is the door$`),
    R(String.raw`^\[WORKSPACE\] my role in ${ws} is now "[^"]+" \(canManage=(?:true|false) canManageChannels=(?:true|false) canModerate=(?:true|false)\)$`),
    R(String.raw`^\[channelSettings\.(?:loadChannelAccess|refreshAccess)\] channel_${ch}…$`),
    R(String.raw`^\[channelSettings\.(?:add|remove)AllowedUser\] \{"channelId":"channel_${ch}…","userId":"[0-9a-f]{8}…"\}$`),
    // A revoked member's own client leaving the salon, and the panel noticing that another write
    // landed after its own (RM-4b's race, both writes standing) - one line each per event.
    R(String.raw`^Removed from channel ${ch}…$`),
    R(String.raw`^\[channelSettings\.afterAccessWrite another write landed\] \{"channelId":"channel_${ch}…","base":\d+,"revision":\d+\}$`),
    /^\[RoutePreload\] \{"pathname":"\/[a-z]*","first":true\}$/,
    R(String.raw`^\[CHANNEL\] page of ${ch} decoded after its salon entry was decided$`),
  ];
}

/**
 * RM-5'S KICK RACE, AS EACH SIDE SAYS IT (read on `1.4.1-alpha.6`, 2026-10-26). W1 kicks the subject
 * while the granter gives them the private salon. The two outcomes the row plays are both designed:
 *
 * - THE GRANT LANDS, THEN THE KICK. The granter's Add put the subject's devices in the salon's
 *   distribution group, the gate did not record them (`not_entitled`), and the server refused the
 *   Welcome (`403`, "the roster does not name its owner"), so no Welcome is delivered.
 * - THE KICK LANDS FIRST. The grant is refused with `409 CHANNEL_GRANTEE_NOT_MEMBER`, and the panel
 *   reads the access again and reloads its picker.
 *
 * The kicked subject's next reads of the community's and the salon's distribution group are refused
 * (`403`) and said once each. Every needle is scoped to the row's salon, its community, its salon
 * group and the subject's user id. Another salon, another user, another code or another level stays
 * dirt.
 *
 * @param {{workspaceId: string, channelIds: string[], groupIds: string[], subject: string}} p
 * @returns {(RegExp | {levels: string[], re: RegExp})[]} the granter's narration; the subject's
 *   refusals are HTTP statuses only ({@link kickRaceRefusals})
 */
export function kickRaceNarration({ workspaceId, channelIds, groupIds, subject }) {
  const ws = short(workspaceId);
  const ch = anyOf(channelIds);
  const g = anyOf(groupIds);
  const u = short(subject);
  const R = (s) => new RegExp(s);
  const at = (levels, s) => ({ levels, re: R(s), toString: () => `${levels.join('|')}: ${s}` });
  return [
    at(['debug'], String.raw`^\[COMMIT\] ${g}\.\.\. the gate did not record the admit of ${u}:web-${u}…-[0-9a-z]+-[0-9a-z]+ \(not_entitled\) - its Welcome is sent and answered as before$`),
    // At `error` by the client's own choice; a plain needle, so it is forgiven in that bucket and
    // only for this group and this subject.
    R(String.raw`^\[WELCOME\] ${g}\.\.\. Welcome REFUSED for ${u}\.\.\.: the roster does not name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray sweep collects it$`),
    at(['log', 'info'], String.raw`^\[GRAINE\] ADMIT ${u} into salon ${ch} of ${ws}: the Welcome to web-${u}…-[0-9a-z]+-[0-9a-z]+ was NOT delivered \(WelcomeTargetNotMemberError: the Welcome of ${g}\.\.\. to ${u}…:web-${u}…-[0-9a-z]+-[0-9a-z]+ was refused - the roster does not name its target\)`),
    at(['debug'], String.raw`^\[channelSettings\.addAllowedUser failed\] ChannelApiError: \{"code":"CHANNEL_GRANTEE_NOT_MEMBER",.*"channelId":"${ch}…"`),
    at(['debug'], String.raw`^\[channelSettings\.accessWriteRefused reading the access again\] \{"channelId":"channel_${ch}…","code":"CHANNEL_GRANTEE_NOT_MEMBER"\}$`),
    at(['debug'], String.raw`^\[channelSettings\.accessWriteRefused grantee not a member, reloading the picker\] channel_${ch}…$`),
  ];
}

/**
 * RM-5's refusals, by seat: the granter's `409` on the salon's access path and `403` on the Welcome
 * route, and the kicked subject's `403` on the salon's and the community's distribution group. Any
 * other status, or the same one on another path, stays dirt.
 *
 * @param {{workspaceId: string, channelIds: string[]}} p
 */
export function kickRaceRefusals({ workspaceId, channelIds }) {
  const ids = channelIds.map((c) => String(c).replace(/^channel_/, '')).join('|') || '(?!)';
  return {
    granter: [
      { path: new RegExp(`^/api/channels/(?:${ids})/access$`), status: [409] },
      { path: /^\/api\/mls\/welcome$/, status: [403] },
    ],
    subject: [
      { path: new RegExp(`^/api/channels/(?:${ids})/distribution-group$`), status: [403] },
      { path: new RegExp(`^/api/channels/workspaces/${workspaceId}/distribution-group$`), status: [403] },
    ],
  };
}

/**
 * The access race's LOSER: the panel's `409 CHANNEL_ACCESS_CHANGED` on one of the row's channels -
 * RM-4's subject, so forgiven to that row at `debug` only (`salon.mjs`). Any other code stays dirt.
 */
export function salonRaceRefusal(channelIds) {
  return new RegExp(String.raw`^\[channelSettings\.(?:add|remove)AllowedUser failed\] ChannelApiError: \{"code":"CHANNEL_ACCESS_CHANGED",.*"channelId":"${anyOf(channelIds)}…"`);
}

/**
 * ... and the loser's panel reading the access again before it names the refusal
 * (`ChannelSettingsPanel.svelte` `accessWriteRefused`), at `debug`, for that one code. Read on
 * alpha.5's RM-4 (2026-10-26). `CHANNEL_GRANTEE_NOT_MEMBER` takes the same branch and is NOT this
 * row's race, so it stays dirt.
 */
export function salonRaceReread(channelIds) {
  return new RegExp(String.raw`^\[channelSettings\.accessWriteRefused reading the access again\] \{"channelId":"channel_${anyOf(channelIds)}…","code":"CHANNEL_ACCESS_CHANGED"\}$`);
}

/**
 * The race loser's `409` on the salon's access path, as a refusal `observersOf` forgives on either
 * racing seat - only one of them loses, and the row asserts which (`accessRaceOwn`). Any other status,
 * or the same status on another path, stays dirt.
 *
 * @param {string[]} channelIds the row's channels, whole
 */
export function salonRaceRefusals(channelIds) {
  const ids = channelIds.map((c) => String(c).replace(/^channel_/, '')).join('|') || '(?!)';
  return [{ path: new RegExp(`^/api/channels/(?:${ids})/access$`), status: [409] }];
}
