/**
 * THE SALON ROWS' OWN JUDGEMENTS, PINNED (`salonrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/salon-selftest.mjs
 */
import { NAMED, SALON_ROWS, accessRaceOwn, intendedLists, kickRaceCycleOwn, removalBoundOwn, salonEntitlement, statusesIn } from '../salonrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const U1 = '11111111-0000-0000-0000-000000000001';
const U2 = '22222222-0000-0000-0000-000000000002';
const U4 = '44444444-0000-0000-0000-000000000004';
const U5 = '55555555-0000-0000-0000-000000000005';

// ── the table ───────────────────────────────────────────────────────────────────────────────────
ok('every row acts from W1', Object.values(SALON_ROWS).every((r) => r.devices.includes('W1')));
ok('RM-4 races two admins, each dropping a member of the row', Object.keys(SALON_ROWS['RM-4'].race).length === 2 && Object.values(SALON_ROWS['RM-4'].race).every((d) => SALON_ROWS['RM-4'].allow.includes(d)));
ok('RM-4 has the two admins drop DIFFERENT members', new Set(Object.values(SALON_ROWS['RM-4'].race)).size === 2);
ok('RM-5 runs five cycles on a member it may kick', SALON_ROWS['RM-5'].cycles === 5 && SALON_ROWS['RM-5'].devices.includes(SALON_ROWS['RM-5'].subject));
ok('RM-6 starts from a public salon', SALON_ROWS['RM-6'].salon === 'public');
ok('every named refusal has a message key', Object.values(NAMED).every((k) => k.startsWith('chat_')));

// ── statusesIn ──────────────────────────────────────────────────────────────────────────────────
const events = [
  { method: 'Network.requestWillBeSent', params: { requestId: 'a', request: { method: 'GET' } } },
  { method: 'Network.responseReceived', params: { requestId: 'a', response: { url: 'https://h/api/channels/c/access', status: 200 } } },
  { method: 'Network.requestWillBeSent', params: { requestId: 'b', request: { method: 'PATCH' } } },
  { method: 'Network.responseReceived', params: { requestId: 'b', response: { url: 'https://h/api/channels/c/access', status: 409 } } },
  { method: 'Network.responseReceived', params: { requestId: 'z', response: { url: 'https://h/api/other', status: 500 } } },
];
ok('statusesIn keeps the url and the method asked for', JSON.stringify(statusesIn(events, '/channels/c/access', 'PATCH')) === '[409]');
ok('statusesIn with no method keeps every answer to the url', JSON.stringify(statusesIn(events, '/channels/c/access')) === '[200,409]');
ok('statusesIn of nothing is nothing', statusesIn(undefined, '/x').length === 0);

// ── RM-4 ────────────────────────────────────────────────────────────────────────────────────────
const before = [U1, U2, U4, U5];
const droppedBy = { W1: U4, W2: U5 };
const intended = intendedLists(before, droppedBy);
ok('intendedLists drops each admin its own target', intended.W1.length === 3 && !intended.W1.includes(U4) && intended.W2.includes(U4) && !intended.W2.includes(U5));
const race = {
  held: { W1: true, W2: true },
  status: { W1: 200, W2: 409 },
  named: { W1: false, W2: true },
  intended,
  droppedBy,
  allowed: [U1, U2, U5],
  seated: { [U4]: false, [U5]: true },
  departed: { [U4]: 1, [U5]: 0 },
};
ok('RM-4: one won whole, the other refused and told, its target spared passes', allOk(accessRaceOwn(race)));
ok('RM-4: the mirror outcome passes too', allOk(accessRaceOwn({ ...race, status: { W1: 409, W2: 200 }, named: { W1: true, W2: false }, allowed: [U1, U2, U4], seated: { [U4]: true, [U5]: false }, departed: { [U4]: 0, [U5]: 1 } })));
ok('RM-4: a request never held fails - the race did not happen', failing(accessRaceOwn({ ...race, held: { W1: true, W2: false } })) === 1);
ok('RM-4: both answered 200 fails - nothing refused the stale rewrite', failing(accessRaceOwn({ ...race, status: { W1: 200, W2: 200 } })) === 1);
ok('RM-4: both refused fails', failing(accessRaceOwn({ ...race, status: { W1: 409, W2: 409 } })) === 1);
ok("RM-4: the loser's panel silent fails", failing(accessRaceOwn({ ...race, named: { W1: false, W2: false } })) === 1);
ok('RM-4: a merged allowlist fails - neither edit stood whole', failing(accessRaceOwn({ ...race, allowed: [U1, U2] })) === 2);
ok("RM-4: the loser's target cut off anyway fails", failing(accessRaceOwn({ ...race, seated: { [U4]: false, [U5]: false } })) === 1);
ok("RM-4: a departure recorded for the loser's target fails", failing(accessRaceOwn({ ...race, departed: { [U4]: 1, [U5]: 1 } })) === 1);
ok("RM-4: the winner's target still seated fails", failing(accessRaceOwn({ ...race, seated: { [U4]: true, [U5]: true } })) === 1);

// ── RM-5 ────────────────────────────────────────────────────────────────────────────────────────
const kicked = { held: true, kick: 200, grant: 409, member: false, allowed: false, seated: false, supersededNamed: false };
const stayed = { held: true, kick: 200, grant: 200, member: true, allowed: true, seated: true, supersededNamed: false };
ok('RM-5: kicked with nothing left passes', allOk(kickRaceCycleOwn(1, kicked)));
ok('RM-5: a member allowed and seated passes the wholeness check', failing(kickRaceCycleOwn(1, stayed)) === 0);
ok('RM-5: kicked but still on the allowlist fails - half', failing(kickRaceCycleOwn(1, { ...kicked, allowed: true })) === 1);
ok('RM-5: kicked but still seated fails - half', failing(kickRaceCycleOwn(1, { ...kicked, seated: true })) === 1);
ok('RM-5: a member allowed but never seated fails - half', failing(kickRaceCycleOwn(1, { ...stayed, seated: false })) === 1);
ok('RM-5: a 409 kick fails - one race cannot outlast three retries', failing(kickRaceCycleOwn(1, { ...kicked, kick: 409, member: true, allowed: true, seated: true, supersededNamed: true })) === 1);
ok('RM-5: a 409 kick not named fails twice', failing(kickRaceCycleOwn(1, { ...kicked, kick: 409, member: true, allowed: true, seated: true })) === 2);
ok('RM-5: not held fails', failing(kickRaceCycleOwn(1, { ...kicked, held: false })) === 1);
ok('RM-5: the cycle is named in every assertion', kickRaceCycleOwn(3, kicked).every((a) => a.what.startsWith('cycle 3')));

// ── RM-6 ────────────────────────────────────────────────────────────────────────────────────────
const bound = { managerPermissions: ['channel.manage'], status: 403, named: true, dist: { isPrivate: false, groupId: null, linkedGroupId: null } };
ok('RM-6: refused 403, named, still public, no group passes', allOk(removalBoundOwn(bound)));
ok('RM-6: a manager with more than channel.manage fails the premise', failing(removalBoundOwn({ ...bound, managerPermissions: ['channel.manage', 'member.kick'] })) === 1);
ok('RM-6: accepted fails', failing(removalBoundOwn({ ...bound, status: 200 })) === 1);
ok('RM-6: not named fails', failing(removalBoundOwn({ ...bound, named: false })) === 1);
ok('RM-6: made private anyway fails', failing(removalBoundOwn({ ...bound, dist: { ...bound.dist, isPrivate: true } })) === 1);
ok('RM-6: a group minted before the refusal fails', failing(removalBoundOwn({ ...bound, dist: { ...bound.dist, groupId: 'g' } })) === 1);
ok('RM-6: an unread salon fails', failing(removalBoundOwn({ ...bound, dist: null })) === 2);

// ── the salon invariant ─────────────────────────────────────────────────────────────────────────
const dist = { isPrivate: true, allowedUsers: [U1, U2], devices: [{ userId: U1, status: 'active' }, { userId: U2, status: 'active' }] };
ok('entitlement: the allowed members seated, nobody else, holds', salonEntitlement({ pass: 'p', dist, members: [U1, U2, U4], users: [U1, U2, U4] }).ok);
ok('entitlement: an allowed member without a seat breaks it', !salonEntitlement({ pass: 'p', dist: { ...dist, devices: [dist.devices[0]] }, members: [U1, U2], users: [U1, U2] }).ok);
ok('entitlement: a seat for someone not allowed breaks it', !salonEntitlement({ pass: 'p', dist: { ...dist, devices: [...dist.devices, { userId: U4, status: 'active' }] }, members: [U1, U2, U4], users: [U1, U2, U4] }).ok);
ok('entitlement: an allowed user who left the community, still seated, breaks it', !salonEntitlement({ pass: 'p', dist, members: [U1], users: [U1, U2] }).ok);
ok('entitlement: a public salon has nothing to check', salonEntitlement({ pass: 'p', dist: { isPrivate: false, allowedUsers: [], devices: [] }, members: [U1], users: [U1] }).ok);
ok('entitlement: an unread salon breaks it', !salonEntitlement({ pass: 'p', dist: null, members: [], users: [] }).ok);
ok('entitlement: says it replaced the message probe', salonEntitlement({ pass: 'p', dist, members: [U1, U2], users: [U1, U2] }).passes[0].approximations.length === 1);

if (failures) {
  console.error(`\n${failures} salon assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
