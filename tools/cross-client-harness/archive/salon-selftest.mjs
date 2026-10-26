/**
 * THE SALON ROWS' OWN JUDGEMENTS, PINNED (`salonrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/salon-selftest.mjs
 */
import { NAMED, SALON_ROWS, accessRaceOwn, intendedLists, kickRaceCycleOwn, kickRaceNarration, kickRaceRefusals, removalBoundOwn, revokeRaceOwn, salonEntitlement, salonNarration, salonRaceRefusal, salonRaceReread, salonRaceRefusals, statusesIn } from '../salonrows.mjs';

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
ok('RM-4 races two admins, each granting a member NOT yet on the list', SALON_ROWS['RM-4'].gesture === 'grant' && Object.keys(SALON_ROWS['RM-4'].race).length === 2 && Object.values(SALON_ROWS['RM-4'].race).every((d) => !SALON_ROWS['RM-4'].allow.includes(d)));
ok('RM-4b races two admins, each revoking a member ON the list', SALON_ROWS['RM-4b'].gesture === 'revoke' && Object.keys(SALON_ROWS['RM-4b'].race).length === 2 && Object.values(SALON_ROWS['RM-4b'].race).every((d) => SALON_ROWS['RM-4b'].allow.includes(d)));
ok('RM-4 and RM-4b each target DIFFERENT members', ['RM-4', 'RM-4b'].every((r) => new Set(Object.values(SALON_ROWS[r].race)).size === 2));
ok('every racing seat is a row device', ['RM-4', 'RM-4b'].every((r) => [...Object.keys(SALON_ROWS[r].race), ...Object.values(SALON_ROWS[r].race)].every((d) => SALON_ROWS[r].devices.includes(d))));
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
const targetOf = { W1: U4, W2: U5 };
const granted = intendedLists([U1, U2], targetOf, 'grant');
ok('intendedLists(grant) adds each admin its own target', granted.W1.length === 3 && granted.W1.includes(U4) && !granted.W1.includes(U5) && granted.W2.includes(U5));
const revoked = intendedLists([U1, U2, U4, U5], targetOf, 'revoke');
ok('intendedLists(revoke) drops each admin its own target', revoked.W1.length === 3 && !revoked.W1.includes(U4) && revoked.W2.includes(U4) && !revoked.W2.includes(U5));
let threw = false;
try {
  intendedLists([U1], targetOf, 'swap');
} catch {
  threw = true;
}
ok('intendedLists refuses a gesture it does not know', threw);
const race = {
  held: { W1: true, W2: true },
  status: { W1: 200, W2: 409 },
  named: { W1: false, W2: true },
  intended: granted,
  targetOf,
  allowed: [U1, U2, U4],
  seated: { [U4]: true, [U5]: false },
};
ok('RM-4: one grant won whole, the other refused and told, its grantee kept out passes', allOk(accessRaceOwn(race)));
ok('RM-4: the mirror outcome passes too', allOk(accessRaceOwn({ ...race, status: { W1: 409, W2: 200 }, named: { W1: true, W2: false }, allowed: [U1, U2, U5], seated: { [U4]: false, [U5]: true } })));
ok('RM-4: a request never held fails - the race did not happen', failing(accessRaceOwn({ ...race, held: { W1: true, W2: false } })) === 1);
ok('RM-4: both answered 200 fails - nothing refused the stale rewrite', failing(accessRaceOwn({ ...race, status: { W1: 200, W2: 200 } })) === 1);
ok('RM-4: two 200s that dropped a grantee NAME the lost update', accessRaceOwn({ ...race, status: { W1: 200, W2: 200 }, allowed: [U1, U2, U5] }).some((a) => !a.ok && a.what.includes("W1's grantee DROPPED")));
ok('RM-4: two 200s that kept both grantees name no lost update', !accessRaceOwn({ ...race, status: { W1: 200, W2: 200 }, allowed: [U1, U2, U4, U5] }).some((a) => a.what.includes('DROPPED')));
ok('RM-4: both refused fails', failing(accessRaceOwn({ ...race, status: { W1: 409, W2: 409 } })) === 1);
ok("RM-4: the loser's panel silent fails", failing(accessRaceOwn({ ...race, named: { W1: false, W2: false } })) === 1);
ok("RM-4: the loser's grantee let in anyway fails - the list is not the winner's and the grantee is on it", failing(accessRaceOwn({ ...race, allowed: [U1, U2, U4, U5] })) === 2);
ok("RM-4: the loser's grantee seated fails", failing(accessRaceOwn({ ...race, seated: { [U4]: true, [U5]: true } })) === 1);
ok("RM-4: the winner's grantee never seated fails", failing(accessRaceOwn({ ...race, seated: { [U4]: false, [U5]: false } })) === 1);

// ── RM-4b ───────────────────────────────────────────────────────────────────────────────────────
const revokes = {
  held: { W1: true, W2: true },
  status: { W1: 200, W2: 200 },
  expected: [U1, U2],
  targetOf,
  allowed: [U1, U2],
  seated: { [U4]: false, [U5]: false },
  departed: { [U4]: 1, [U5]: 1 },
};
ok('RM-4b: both revokes stood, both cut, both departed passes', allOk(revokeRaceOwn(revokes)));
ok('RM-4b: a DELETE never held fails', failing(revokeRaceOwn({ ...revokes, held: { W1: false, W2: true } })) === 1);
ok('RM-4b: a 409 fails - no revoke of a different member may refuse another', failing(revokeRaceOwn({ ...revokes, status: { W1: 200, W2: 409 } })) === 1);
ok("RM-4b: a target still on the list fails", failing(revokeRaceOwn({ ...revokes, allowed: [U1, U2, U5] })) === 1);
ok('RM-4b: a target still seated fails', failing(revokeRaceOwn({ ...revokes, seated: { [U4]: false, [U5]: true } })) === 1);
ok('RM-4b: a target with no departure recorded fails', failing(revokeRaceOwn({ ...revokes, departed: { [U4]: 1, [U5]: 0 } })) === 1);

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

// THE COMMUNITY'S ONE-PER-EVENT NARRATION, scoped to the row's ids (RM-4's first alpha.4 run, 2026-10-25).
const scope = { workspaceId: 'bbd34b31-412b-4e70-abb9-72b2fbe621f7', channelIds: ['0c6421b1-0000-4000-8000-000000000001', '0fb4ddf1-aece-4b50-b309-88503be81573'], keyGroupIds: ['3b8eb81a-7ab7-4d77-8096-cca66925f563'] };
const said = (line) => salonNarration(scope).some((r) => r.test(line));
for (const line of [
  'Joined channel 0fb4ddf1…',
  '[INVITE] this link carries no admission proof - joining with no past',
  '[GRAINE] invite link to community bbd34b31 endorsed by device web-f7a9',
  '[WELCOME] 3b8eb81a... is a KEY-DISTRIBUTION group (server row) - installing it as a seed carrier',
  '[QUEUE] Welcome for key group 3b8eb81a... - not announced to the conversation layer',
  '[GRAINE] ADMIT salon grantee 223bc34e to 0fb4ddf1 (community bbd34b31)',
  "[GRAINE] salon 0fb4ddf1 of bbd34b31: a Welcome is owed to this device (welcome-queued) - not joining by external commit, the admitter's Welcome is the door",
  "[GRAINE] salon 0fb4ddf1 of bbd34b31: a Welcome is owed to this device (add-in-flight) - not joining by external commit, the admitter's Welcome is the door",
  '[WORKSPACE] my role in bbd34b31 is now "Administrateur" (canManage=true canManageChannels=true canModerate=true)',
  '[channelSettings.loadChannelAccess] channel_0fb4ddf1…',
  '[channelSettings.addAllowedUser] {"channelId":"channel_0fb4ddf1…","userId":"223bc34e…"}',
  '[RoutePreload] {"pathname":"/posts","first":true}',
  'Removed from channel 0fb4ddf1…',
  '[channelSettings.afterAccessWrite another write landed] {"channelId":"channel_0fb4ddf1…","base":3,"revision":5}',
]) ok(`narration: ${line.slice(0, 60)}`, said(line));
ok('control: another community\'s join is not the row\'s', !said('Joined channel 99999999…'));
ok('control: another key group\'s Welcome is not the row\'s', !said('[WELCOME] 99999999... is a KEY-DISTRIBUTION group (server row) - installing it as a seed carrier'));
ok('control: a per-read Graine answer stays dirt (fixed at the source)', !said('[GRAINE] sending 0 of 0 seed(s) this key group may read as history to c71e1a5b…'));
ok('control: a redelivered Welcome stays dirt', !said('[WELCOME] key group 3b8eb81a... already held - redelivered Welcome ignored (idempotent)'));
const refusal = salonRaceRefusal(scope.channelIds);
ok('the race loser\'s 409 on the row\'s salon is RM-4\'s', refusal.test('[channelSettings.addAllowedUser failed] ChannelApiError: {"code":"CHANNEL_ACCESS_CHANGED","message":"The salon access changed meanwhile, retry.","current":{"channelId":"0fb4ddf1…","isPrivate":true'));
ok('control: another code is not the race', !refusal.test('[channelSettings.addAllowedUser failed] ChannelApiError: {"code":"FORBIDDEN","current":{"channelId":"0fb4ddf1…"'));
ok('control: an owed reading that is not a Welcome owed stays dirt', !said("[GRAINE] salon 0fb4ddf1 of bbd34b31: a Welcome is owed to this device (unhonoured-seat) - not joining by external commit, the admitter's Welcome is the door"));
// Verbatim from W2 on alpha.5's RM-4 (2026-10-26), its ISO stamp stripped as `stripStamp` does.
const reread = salonRaceReread(scope.channelIds);
ok("the loser's panel reading the access again is RM-4's", reread.test('[channelSettings.accessWriteRefused reading the access again] {"channelId":"channel_0fb4ddf1…","code":"CHANNEL_ACCESS_CHANGED"}'));
ok('control: a grantee who left is not the race', !reread.test('[channelSettings.accessWriteRefused reading the access again] {"channelId":"channel_0fb4ddf1…","code":"CHANNEL_GRANTEE_NOT_MEMBER"}'));
ok("control: another salon's re-read is not the row's", !reread.test('[channelSettings.accessWriteRefused reading the access again] {"channelId":"channel_99999999…","code":"CHANNEL_ACCESS_CHANGED"}'));
const [raceRefusal] = salonRaceRefusals(['0fb4ddf1-1111-2222-3333-444444444444']);
ok("the loser's 409 is declared on the row's access path, 409 only", raceRefusal.path.test('/api/channels/0fb4ddf1-1111-2222-3333-444444444444/access') && raceRefusal.status.join() === '409');
ok("control: another salon's access path is not declared", !raceRefusal.path.test('/api/channels/99999999-1111-2222-3333-444444444444/access'));
ok('control: the salon\'s other paths are not declared', !raceRefusal.path.test('/api/channels/0fb4ddf1-1111-2222-3333-444444444444/distribution-group'));

// RM-5'S KICK RACE (alpha.6, 2026-10-26): verbatim from W2, ISO stamps stripped as `stripStamp` does.
const SUBJ = '223bc34e' + 'a'.repeat(56);
const kick = { workspaceId: 'c2886ebf-cbef-47dc-b813-5fff78e2c0ea', channelIds: ['114d3327-aa4e-4b60-b988-1530586d95e2'], groupIds: ['357b4af8-829b-4bb5-b441-fb7f92d90b4e'], subject: SUBJ };
const kickNeedles = kickRaceNarration(kick);
const kickSays = (level, line) => kickNeedles.some((n) => (n instanceof RegExp ? n.test(line) : n.levels.includes(level) && n.re.test(line)));
for (const [level, line] of [
  ['debug', '[COMMIT] 357b4af8... the gate did not record the admit of 223bc34e:web-223bc34e…-mvn2msl6-7do6 (not_entitled) - its Welcome is sent and answered as before'],
  ['error', '[WELCOME] 357b4af8... Welcome REFUSED for 223bc34e...: the roster does not name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray sweep collects it'],
  ['log', '[GRAINE] ADMIT 223bc34e into salon 114d3327 of c2886ebf: the Welcome to web-223bc34e…-mvn2msl6-7do6 was NOT delivered (WelcomeTargetNotMemberError: the Welcome of 357b4af8... to 223bc34e…:web-223bc34e…-mvn2msl6-7do6 was refused - the roster does not name its target) - that device holds a leaf'],
  ['debug', '[channelSettings.addAllowedUser failed] ChannelApiError: {"code":"CHANNEL_GRANTEE_NOT_MEMBER","message":"Someone this list grants is not a member of the community.","current":{"channelId":"114d3327…","isPrivate":true}}'],
  ['debug', '[channelSettings.accessWriteRefused reading the access again] {"channelId":"channel_114d3327…","code":"CHANNEL_GRANTEE_NOT_MEMBER"}'],
  ['debug', '[channelSettings.accessWriteRefused grantee not a member, reloading the picker] channel_114d3327…'],
]) ok(`kick race: ${line.slice(0, 60)}`, kickSays(level, line));
ok('control: the gate refusing another user is not the race', !kickSays('debug', '[COMMIT] 357b4af8... the gate did not record the admit of 99999999:web-99999999…-mvn2msl6-7do6 (not_entitled) - its Welcome is sent and answered as before'));
ok('control: another gate reason is not the race', !kickSays('debug', '[COMMIT] 357b4af8... the gate did not record the admit of 223bc34e:web-223bc34e…-mvn2msl6-7do6 (blocked) - its Welcome is sent and answered as before'));
ok("control: another group's refused Welcome is not the race", !kickSays('error', '[WELCOME] 99999999... Welcome REFUSED for 223bc34e...: the roster does not name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray sweep collects it'));
ok('control: the gate line at warn stays dirt', !kickSays('warning', '[COMMIT] 357b4af8... the gate did not record the admit of 223bc34e:web-223bc34e…-mvn2msl6-7do6 (not_entitled) - its Welcome is sent and answered as before'));
ok("control: another salon's grantee refusal is not the race", !kickSays('debug', '[channelSettings.accessWriteRefused grantee not a member, reloading the picker] channel_99999999…'));
ok('control: a leaf already held is not narrated (filed as a P3)', !kickSays('log', '[GRAINE] ADMIT 223bc34e into salon 114d3327 of c2886ebf: all 2 device(s) already hold a leaf - no commit'));
const kr = kickRaceRefusals(kick);
ok("the granter's 409 on the salon's access path", kr.granter.some((r) => r.path.test('/api/channels/114d3327-aa4e-4b60-b988-1530586d95e2/access') && r.status.join() === '409'));
ok("the granter's 403 on the Welcome route", kr.granter.some((r) => r.path.test('/api/mls/welcome') && r.status.join() === '403'));
ok("the subject's 403 on the salon's and the community's distribution group", ['/api/channels/114d3327-aa4e-4b60-b988-1530586d95e2/distribution-group', '/api/channels/workspaces/c2886ebf-cbef-47dc-b813-5fff78e2c0ea/distribution-group'].every((p) => kr.subject.some((r) => r.path.test(p) && r.status.join() === '403')));
ok("control: another community's distribution group is not declared", !kr.subject.some((r) => r.path.test('/api/channels/workspaces/99999999-cbef-47dc-b813-5fff78e2c0ea/distribution-group')));
ok("control: the granter's Welcome route is not the subject's", !kr.subject.some((r) => r.path.test('/api/mls/welcome')));
ok("narration: the salon's page decoded after its entry was decided", said('[CHANNEL] page of 0fb4ddf1 decoded after its salon entry was decided'));
ok("control: another salon's page is not the row's", !said('[CHANNEL] page of 99999999 decoded after its salon entry was decided'));

if (failures) {
  console.error(`\n${failures} salon assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
