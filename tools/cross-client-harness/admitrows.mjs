/**
 * THE ADMISSION ROWS OF THE 1.4.1 CAMPAIGN - ADM-1..10 - their table, the waiting seat's route table,
 * and their judges.
 *
 * Pure, so `archive/admit-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/admit.mjs`, the gestures `archive/grouplink.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md`
 * section 4.2 is the plan. The question: a new person who follows a GROUP link waits for a member -
 * the base is withheld, every member is asked, one member's Add or Decline settles it - and a seat
 * that waits can do nothing a member can.
 */

/** The tag an OLD client of the mixed-version rows is built from (plan Q8). */
export const OLD_REF = 'v1.4.0';

/** The rows `archive/admit.mjs` plays. */
export const ADMIT_ROWS = {
  'ADM-1': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    answer: { by: 'W1', choice: 'approve' },
    what: 'W4 follows the group link: it waits, the base answers 409, both members show the ask, W1 Adds, the ask leaves both screens',
  },
  'ADM-2': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    answer: { by: 'W2', choice: 'decline' },
    what: "W2 Declines: the ask withdrawn - W4's roster row and seats gone, no exclusion written, W4 never reads the conversation",
  },
  'ADM-3': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    race: { approve: 'W1', decline: 'W2' },
    what: 'W1 Adds and W2 Declines at once (both requests held, released together): one wins, and an admitted person is never stripped',
  },
  'ADM-4': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    probe: true,
    what: 'the waiting seat calls every member route from its own page: each answers 409 awaiting_admission, and nothing it does admits anyone',
    note: 'the presence and ring AUDIENCES are not asserted: a refused ring rings nobody, which is all this row can observe from a browser',
  },
  'ADM-5': {
    devices: ['A1', 'W2', 'W4'],
    owner: 'W2',
    setup: ['W4'],
    old: 'A1',
    joiner: 'A1',
    answer: { by: 'W2', choice: 'approve' },
    what: `A1 on the ${'v1.4.0'} APK follows a link made on new clients: it meets the withheld base, asks a member, is admitted by W2's Add; the base-withheld line is rate-limited`,
    note: "A1 signs in as the OWNER, so the group is W2's and W4's: with W1 in it the owner would not be a new person (the plan's W1 W2)",
  },
  'ADM-6': {
    devices: ['A1', 'W1', 'W4'],
    owner: 'W1',
    setup: [],
    ownerDevices: ['A1'],
    old: 'A1',
    joiner: 'W4',
    shimWaitMs: 60_000,
    answer: { by: 'W1', choice: 'approve' },
    what: `A1 on the ${'v1.4.0'} APK is a member when W4 follows the link: A1 may auto-Add (the shim); the admission lifts; no [ADMISSION] ERROR; which device added is recorded`,
    note: "A1 is the owner's second device, so W1's group seats it without an Add. A1 is given shimWaitMs to auto-Add W4; if it does not, W1 Adds - either way is a PASS, and the record says which",
  },
  'ADM-7': {
    devices: ['A1', 'W2', 'W4'],
    owner: 'W2',
    setup: ['W4'],
    old: 'A1',
    outsider: 'A1',
    what: `A1 on the ${'v1.4.0'} APK, never a member, asks the base an external join needs: refused, no [UNINVITED_ENTRY], no "entered without a member" notice`,
    note: "an external commit needs the base, so the refusal of the base IS the refusal of the join; the row asks it from the old client's own page. A1 signs in as the OWNER, so the group is W2's and W4's",
  },
  'ADM-8': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: [],
    joiner: 'W4',
    kinds: ['direct', 'key-group'],
    what: 'a link minted on a 1:1 or on a key group raises no ask: only a GROUP conversation takes one',
    note: "minted and accepted through the API (the panel offers no link there): the mint's refusal, or the accept's, is the answer, and no ask line nor awaiting row may follow",
  },
  'ADM-9': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    reinvite: { decline: 'W2', approve: 'W1' },
    what: 'W2 Declines W4; W1 then mints a NEW link, W4 follows it and waits again, W1 Adds: a Decline is not a ban, and an invitation built after it admits',
    note: 'asked by the coordinator 2026-10-26 with the ADM-3 fix (a Decline now holds against an earlier Add): the fix must not turn a Decline into a refusal of every later invitation',
  },
  'ADM-10': {
    devices: ['W1', 'W2', 'W4'],
    owner: 'W1',
    setup: ['W2'],
    joiner: 'W4',
    stale: { approve: 'W1', decline: 'W2' },
    what: "W1's Add commit is held, W2 Declines and the Decline settles, then the Add is released: the stale Add admits nobody - refused at the commit gate AND by the member-add route that follows it",
    note: 'ADM-3 releases both answers together and accepts either winner; this row ORDERS them, Decline first, which is the case 1.4.1-alpha.4 got wrong (the commit gate held, the member-add route re-enrolled)',
  },
};

/** Whether an `apiCall` answer is the waiting seat's refusal. */
export const isAwaitingRefusal = (r) => r?.status === 409 && /awaiting_admission/.test(String(r?.body ?? ''));

/**
 * Every member route ADM-4 calls from the waiting seat's page (plan: roster, members, enrol someone,
 * mint a link, vouch, history, exclusions, call initiate/ring - and the base, which ADM-1 also reads).
 *
 * @param {string} g the group
 * @param {{enrolUser: string, vouchUser: string, vouchDevice: string}} others someone the seat may try to admit
 */
export function memberRoutes(g, { enrolUser, vouchUser, vouchDevice }) {
  return [
    { what: 'roster', method: 'GET', path: `/api/mls/groups/${g}/user-members` },
    { what: 'members', method: 'GET', path: `/api/mls/groups/${g}/members` },
    { what: 'enrol someone', method: 'POST', path: `/api/mls/groups/${g}/members`, body: { userId: enrolUser } },
    { what: 'mint a link', method: 'POST', path: `/api/mls/groups/${g}/invites`, body: {} },
    { what: 'vouch', method: 'POST', path: '/api/mls/invitations/status', body: { groupId: g, userId: vouchUser, deviceId: vouchDevice, status: 'active' } },
    { what: 'history', method: 'GET', path: `/api/mls/history/${g}` },
    { what: 'exclusions', method: 'GET', path: `/api/mls/groups/${g}/exclusions` },
    { what: 'the base', method: 'GET', path: `/api/mls/group-info/${g}` },
    { what: 'call initiate', method: 'POST', path: '/api/calls/initiate', body: { groupId: g } },
    { what: 'call ring', method: 'POST', path: '/api/calls/ring', body: { groupId: g, callId: 'adm4-probe' } },
  ];
}

/** The `repeat=N` of every `[GROUP_INFO] ... base withheld` line about `groupId`. */
export function baseWithheldRepeats(lines, groupId) {
  return lines
    .filter((l) => l.includes('[GROUP_INFO]') && l.includes(`group=${groupId}`) && l.includes('base withheld'))
    .map((l) => Number(/repeat=(\d+)/.exec(l)?.[1] ?? NaN));
}

/** 1, 10, 100, ... - the only repeats a rate-limited line may carry. */
export const isPowerOfTen = (n) => Number.isInteger(n) && n >= 1 && /^10*$/.test(String(n));

const ms = (v) => (v === null || v === undefined ? 'never' : `${v} ms`);

/** The joiner's seat in the server's view: on the roster and waiting, admitted, or absent. */
export function seatState(view, user) {
  const lower = String(user).toLowerCase();
  const row = (view.roster ?? []).find((r) => String(r.userId).toLowerCase() === lower);
  const active = (view.seats ?? []).filter((s) => String(s.userId).toLowerCase() === lower && s.status === 'active' && !s.kicked).length;
  if (!row) return { state: 'absent', active };
  return { state: row.awaitingAdmission ? 'waiting' : 'admitted', active };
}

/** ADM-1 (and ADM-5's admission half): waiting, refused the base, asked everywhere, admitted, the ask gone. */
export function admittedOwn({ waitingText, base, waitingSeat, asks, admitted, listed, gone }) {
  return [
    { what: `the joiner reads the waiting text (${waitingText ? 'shown' : 'NOT shown'})`, ok: waitingText === true },
    { what: `the base answers 409 awaiting_admission to the waiting seat (${base?.status ?? 'no answer'})`, ok: isAwaitingRefusal(base) },
    { what: `the server holds the seat as waiting (${waitingSeat})`, ok: waitingSeat === 'waiting' },
    ...Object.entries(asks).map(([d, v]) => ({ what: `${d} shows the ask (${ms(v)})`, ok: v !== null })),
    { what: `one member's Add admitted the joiner (${admitted.state}, ${admitted.active} active seat(s))`, ok: admitted.state === 'admitted' && admitted.active > 0 },
    { what: `the joiner lists the conversation (${listed ? 'listed' : 'NOT listed'})`, ok: listed },
    ...Object.entries(gone).map(([d, v]) => ({ what: `the ask left ${d}'s screen (${ms(v)})`, ok: v !== null })),
  ];
}

/** ADM-2: withdrawn, and nothing more than withdrawn. */
export function declinedOwn({ asks, after, excluded, listed, shown }) {
  return [
    ...Object.entries(asks).map(([d, v]) => ({ what: `${d} shows the ask (${ms(v)})`, ok: v !== null })),
    { what: `the roster row is gone (${after.state})`, ok: after.state === 'absent' },
    { what: `no device seat is left (${after.active})`, ok: after.active === 0 },
    { what: `no exclusion was written for the joiner (${excluded ? 'EXCLUDED' : 'none'})`, ok: !excluded },
    { what: `the joiner never lists the conversation (${listed ? 'LISTED' : 'not listed'})`, ok: !listed },
    { what: `the joiner never reads a message sent after the Decline (${shown})`, ok: shown === 0 },
  ];
}

/**
 * ADM-3: one answer won and the two sides agree; an admitted person is never stripped. `listedTrail`
 * is the joiner's "lists the conversation" sampled across the settling window: true then false is a
 * person admitted and then taken away.
 */
export function raceOwn({ outcomes, after, listedTrail }) {
  const stripped = listedTrail.some((v, i) => v && listedTrail.slice(i + 1).some((w) => !w));
  const listedAtEnd = listedTrail.at(-1) === true;
  const consistent = after.state === 'admitted' ? after.active > 0 && listedAtEnd : after.state === 'absent' ? after.active === 0 && !listedAtEnd : false;
  return [
    { what: `both answers were given (${Object.entries(outcomes).map(([d, o]) => `${d} ${o.ok ? 'ok' : o.error}`).join('; ')})`, ok: Object.keys(outcomes).length === 2 },
    { what: `one side won and the server and the joiner agree (${after.state}, ${after.active} seat(s), ${listedAtEnd ? 'listed' : 'not listed'})`, ok: consistent },
    { what: `an admitted person was never stripped (${listedTrail.map((v) => (v ? 'L' : '-')).join('')})`, ok: !stripped },
  ];
}

/**
 * ADM-9: declined, then invited again by a NEW link, waiting again, admitted. A Decline that also
 * refused the second invitation would be a ban nobody decided.
 */
export function reinviteOwn({ declined, rewaiting, asks, admitted, listed }) {
  return [
    { what: `the first ask was declined (${declined.state}, ${declined.active} seat(s))`, ok: declined.state === 'absent' && declined.active === 0 },
    { what: `the new link left the joiner waiting again (${rewaiting})`, ok: rewaiting === 'waiting' },
    ...Object.entries(asks).map(([d, v]) => ({ what: `${d} shows the second ask (${ms(v)})`, ok: v !== null })),
    { what: `the Add built after the Decline admitted the joiner (${admitted.state}, ${admitted.active} active seat(s))`, ok: admitted.state === 'admitted' && admitted.active > 0 },
    { what: `the joiner lists the conversation (${listed ? 'listed' : 'NOT listed'})`, ok: listed },
  ];
}

/**
 * ADM-10: an Add built before a Decline and landing after it. `trail` is the joiner's server state
 * sampled from the release on; one `admitted` sample is a person let in against a settled Decline.
 * `gateRefused` counts the commit gate's `NOT_ENROLLED` lines about the joiner in this group, and
 * `routeEnrolled` the member-add route's `DONE` lines about the joiner after the Decline - the two
 * doors the alpha.4 run proved distinct.
 */
export function staleAddOwn({ held, declined, trail, after, listed, gateRefused, routeEnrolled }) {
  return [
    { what: `the Add's commit was held before the Decline (${held.ok ? 'held' : held.error})`, ok: held.ok === true },
    { what: `the Decline settled first (${declined.state})`, ok: declined.state === 'absent' },
    { what: `the commit gate refused the stale Add (${gateRefused} NOT_ENROLLED line(s))`, ok: gateRefused > 0 },
    { what: `the member-add route enrolled nobody after the Decline (${routeEnrolled} DONE line(s))`, ok: routeEnrolled === 0 },
    { what: `the joiner was never admitted after the release (${trail.map((s) => s[0]).join('')})`, ok: !trail.includes('admitted') },
    { what: `the joiner ends with no roster row and no seat (${after.state}, ${after.active} seat(s))`, ok: after.state === 'absent' && after.active === 0 },
    { what: `the joiner never lists the conversation (${listed ? 'LISTED' : 'not listed'})`, ok: !listed },
  ];
}

/** ADM-4: every member route refused the waiting seat; nothing it did admitted anyone. */
export function probeOwn({ answers, after, enrolled }) {
  return [
    ...answers.map((a) => ({ what: `${a.what}: ${a.method} answered ${a.status ?? a.threw ?? 'nothing'}`, ok: isAwaitingRefusal(a) })),
    { what: `the seat still waits (${after.state})`, ok: after.state === 'waiting' },
    { what: `the person it tried to enrol is not on the roster (${enrolled})`, ok: enrolled === 'absent' },
  ];
}

/** The old-client premise: the seat runs the build of `OLD_REF`. */
export function oldBuildOwn({ device, build, oldCommit }) {
  const ok = !!build?.commit && !!oldCommit && oldCommit.startsWith(build.commit);
  return [{ what: `${device} runs the ${OLD_REF} build (${build?.commit ?? 'unreadable'} vs ${oldCommit ? oldCommit.slice(0, 12) : 'no tag'})`, ok }];
}

/** ADM-5's server half: the base-withheld line was said at 1, 10, 100... and never per retry. */
export function rateLimitedOwn(repeats) {
  return [
    { what: `the old joiner met the withheld base (${repeats.length} line(s))`, ok: repeats.length > 0 },
    { what: `every base-withheld line is rate-limited (repeats ${repeats.join(',') || 'none'})`, ok: repeats.every(isPowerOfTen) },
  ];
}

/** ADM-6: admitted, by whichever device, and no [ADMISSION] ERROR. */
export function oldMemberOwn({ admitted, listed, admissionErrors, addedBy }) {
  return [
    { what: `the joiner was admitted (${admitted.state}, ${admitted.active} seat(s)) by ${addedBy}`, ok: admitted.state === 'admitted' && admitted.active > 0 },
    { what: `the joiner lists the conversation (${listed ? 'listed' : 'NOT listed'})`, ok: listed },
    { what: `no [ADMISSION] ERROR on the server (${admissionErrors})`, ok: admissionErrors === 0 },
  ];
}

/** ADM-7: the outsider's base refused, and nothing reported as an entry nobody made. */
export function outsiderOwn({ base, uninvited, notices, after }) {
  return [
    { what: `the base is refused to a non-member (${base?.status ?? base?.threw ?? 'no answer'})`, ok: [403, 404, 409].includes(base?.status) },
    { what: `no [UNINVITED_ENTRY] line (${uninvited})`, ok: uninvited === 0 },
    { what: `no "joined without a member" notice on any member (${notices})`, ok: notices === 0 },
    { what: `the outsider is not on the roster (${after.state})`, ok: after.state === 'absent' },
  ];
}

/** ADM-8: per kind, no link was usable, or using it raised no ask and no waiting seat. */
export function noAskOwn(kinds) {
  const out = [];
  for (const k of kinds) {
    if (k.missing) {
      out.push({ what: `${k.kind}: ${k.missing}`, ok: false });
      continue;
    }
    const refusedAt = k.mint?.status >= 400 ? 'the mint' : k.accept?.status >= 400 ? 'the accept' : null;
    out.push({ what: `${k.kind}: the link is refused at ${refusedAt ?? 'NEITHER'} (mint ${k.mint?.status ?? '-'}, accept ${k.accept?.status ?? '-'})`, ok: refusedAt !== null });
    out.push({ what: `${k.kind}: no ask was raised (${k.askLines} line(s))`, ok: k.askLines === 0 });
    out.push({ what: `${k.kind}: no waiting seat was written (${k.after.state})`, ok: k.after.state !== 'waiting' });
  }
  return out;
}
