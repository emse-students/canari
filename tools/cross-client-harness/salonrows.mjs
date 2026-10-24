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
  'RM-4': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    admins: ['W2'],
    salon: 'private',
    allow: ['W2', 'W4', 'W5'],
    // EACH ADMIN DROPS SOMEONE: a drop is what reaches the locked re-read (`updateChannelAccess`).
    race: { W1: 'W4', W2: 'W5' },
    what: "W1 and W2, both admins, each revoke a different member from one private salon's access list, both PATCHes held and released together",
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
 * The allowlist each admin INTENDED: the list both read, minus the member it revoked.
 *
 * @param {string[]} before the allowlist both panels showed (user ids)
 * @param {Record<string, string>} droppedBy admin seat -> the user id it revoked
 */
export function intendedLists(before, droppedBy) {
  return Object.fromEntries(Object.entries(droppedBy).map(([admin, gone]) => [admin, (before ?? []).filter((u) => low(u) !== low(gone))]));
}

/**
 * RM-4: one admin's rewrite stood whole, the other was refused `409 CHANNEL_ACCESS_CHANGED` and told
 * so, and the loser's target was cut off by nobody.
 *
 * @param {object} p
 * @param {Record<string, boolean>} p.held per admin, whether its PATCH was held (the race happened)
 * @param {Record<string, number|null>} p.status per admin, the PATCH's answer
 * @param {Record<string, boolean>} p.named per admin, whether its panel drew the refusal
 * @param {Record<string, string[]>} p.intended per admin, the allowlist it meant
 * @param {Record<string, string>} p.droppedBy per admin, the user it revoked
 * @param {string[]} p.allowed the salon's allowlist afterwards (server)
 * @param {Record<string, boolean>} p.seated per user id, whether it holds an active seat in the salon's group
 * @param {Record<string, number>} p.departed per user id, the `departed` rows recorded for it
 */
export function accessRaceOwn({ held, status, named, intended, droppedBy, allowed, seated, departed }) {
  const admins = Object.keys(held);
  const out = admins.map((a) => ({ what: `${a}'s PATCH was held and released with the other (${held[a] ? 'held' : 'NOT held'})`, ok: held[a] }));
  const winners = admins.filter((a) => ok2xx(status[a]));
  const losers = admins.filter((a) => status[a] === 409);
  out.push({ what: `one rewrite won and the other was refused 409 (${admins.map((a) => `${a} ${status[a] ?? 'no answer'}`).join(', ')})`, ok: winners.length === 1 && losers.length === 1 });
  if (winners.length !== 1 || losers.length !== 1) return out;
  const [win] = winners;
  const [lose] = losers;
  out.push({ what: `${lose}'s panel names the refusal (CHANNEL_ACCESS_CHANGED)`, ok: named[lose] === true });
  out.push({ what: `the allowlist is ${win}'s whole edit (${show(allowed)} vs ${show(intended[win])})`, ok: sameSet(allowed, intended[win]) });
  const spared = droppedBy[lose];
  out.push({ what: `${lose}'s target is still allowed - the refused rewrite cut nobody off`, ok: (allowed ?? []).map(low).includes(low(spared)) });
  out.push({ what: `${lose}'s target keeps its seat in the salon's group (${seated[low(spared)] ? 'seated' : 'NO seat'})`, ok: seated[low(spared)] === true });
  out.push({ what: `no departure was recorded for ${lose}'s target (${departed[low(spared)] ?? 0})`, ok: (departed[low(spared)] ?? 0) === 0 });
  const cut = droppedBy[win];
  out.push({ what: `${win}'s target lost its seat in the salon's group (${seated[low(cut)] ? 'STILL seated' : 'gone'})`, ok: seated[low(cut)] === false });
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
