/**
 * THE REMOVAL ROWS' JUDGE, PINNED (`removalrows.mjs`): a clean measurement passes, each fact broken
 * alone fails with one failure, and a row whose subject never reached a key group is VACUOUS. Pure.
 *
 *   bun archive/removals-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, devicesFor } from '../checks.mjs';
import { COMMIT_ROUNDS, REMOVAL_ROWS, removalNarration, removalOwn } from '../removalrows.mjs';
import { ignoringExpectedLog } from '../watch.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const ACTOR = 'web-actor-1';
const SUBJECT = 'web-subject-1';
const OTHER = 'web-other-1';
const group = (scope, over = {}) => ({ groupId: `${scope}-0000-group`, scope, before: 6, after: 7, movedAtRound: 3, routedBefore: true, routedAfter: false, commits: [{ senderDeviceId: ACTOR, baseEpoch: 6 }], ...over });
const clean = (row) => ({ groups: REMOVAL_ROWS[row].groups.map((s) => group(s)), actorDevices: [ACTOR], subjectDevices: [SUBJECT], reloaded: false });
const one = (row, m, why) => {
  const r = removalOwn(row, m);
  ok(`${row}: ${why}`, r.verdict === 'FAIL' && r.failures.length === 1);
};

console.log('the table');
ok('three rows, each naming its key groups and who may commit', Object.values(REMOVAL_ROWS).every((r) => r.groups.length && ['actor', 'remaining'].includes(r.committer)));
ok('the kick and the salon revoke are the actor\'s to commit', REMOVAL_ROWS['KICK-COMMIT'].committer === 'actor' && REMOVAL_ROWS['SALON-REVOKE-COMMIT'].committer === 'actor');
ok('the device revoke is driven from a seat that is not W1, which stays loaded', REMOVAL_ROWS['DEVREVOKE-KEYGROUP'].actor !== 'W1');
ok('every row names the seats it drives, its actor and subject among them', Object.values(REMOVAL_ROWS).every((r) => r.devices.includes(r.actor) && r.devices.includes(r.subject)));
ok('the REMOVALS phase plays every row', Object.keys(REMOVAL_ROWS).every((r) => PHASES.REMOVALS.scripts.includes(`removals.mjs --row ${r}`)));
ok('run.mjs --file removals.mjs --row DEVREVOKE-KEYGROUP preflights W1, W6 and W3', ["W1", "W6", "W3"].every((d) => devicesFor("removals.mjs", ["--row", "DEVREVOKE-KEYGROUP"]).devices.includes(d)));
ok('a bounded number of rounds', COMMIT_ROUNDS > 0 && COMMIT_ROUNDS <= 60);

console.log('the judge');
for (const row of Object.keys(REMOVAL_ROWS)) ok(`${row}: a clean measurement passes`, removalOwn(row, clean(row)).verdict === 'PASS');
for (const row of ['KICK-COMMIT', 'SALON-REVOKE-COMMIT']) {
  one(row, { ...clean(row), groups: clean(row).groups.map((g, i) => (i === 0 ? { ...g, movedAtRound: null } : g)) }, 'an epoch that never moved fails');
  one(row, { ...clean(row), groups: clean(row).groups.map((g, i) => (i === 0 ? { ...g, commits: [{ senderDeviceId: OTHER, baseEpoch: 6 }] } : g)) }, 'a commit by another device than the actor\'s fails');
  one(row, { ...clean(row), groups: clean(row).groups.map((g, i) => (i === 0 ? { ...g, commits: [{ senderDeviceId: ACTOR, baseEpoch: 5 }] } : g)) }, 'a commit from before the gesture does not count');
  one(row, { ...clean(row), reloaded: true }, 'a reloaded actor fails, even with the epoch moved');
  one(row, { ...clean(row), groups: clean(row).groups.map((g, i) => (i === 0 ? { ...g, routedAfter: true } : g)) }, 'a subject still routed fails');
  ok(`${row}: a subject routed on no group is VACUOUS`, removalOwn(row, { ...clean(row), groups: clean(row).groups.map((g) => ({ ...g, routedBefore: false })) }).verdict === 'VACUOUS');
}
const dev = 'DEVREVOKE-KEYGROUP';
ok(`${dev}: a remaining device other than the actor's may commit`, removalOwn(dev, { ...clean(dev), groups: clean(dev).groups.map((g) => ({ ...g, commits: [{ senderDeviceId: OTHER, baseEpoch: 6 }] })) }).verdict === 'PASS');
one(dev, { ...clean(dev), groups: clean(dev).groups.map((g, i) => (i === 0 ? { ...g, commits: [{ senderDeviceId: SUBJECT, baseEpoch: 6 }] } : g)) }, 'a commit by the revoked device itself does not count');
ok(`${dev}: the seat that drove the panel reloading is not a failure`, removalOwn(dev, { ...clean(dev), reloaded: true }).verdict === 'PASS');
ok(`${dev}: a device that reached only the community is VACUOUS`, removalOwn(dev, { ...clean(dev), groups: [group('community')] }).verdict === 'VACUOUS');
ok(`${dev}: every group it held is judged, not only the row's two`, removalOwn(dev, { ...clean(dev), groups: [...clean(dev).groups, group('community', { groupId: 'other-community', movedAtRound: null })] }).verdict === 'FAIL');

for (const row of Object.keys(REMOVAL_ROWS)) {
  const unread = { ...clean(row), groups: clean(row).groups.map((g, i) => (i === 0 ? { ...g, before: null } : g)) };
  ok(`${row}: a group with no epoch read before the gesture FAILS - epoch > null is true, never a baseline`, removalOwn(row, unread).verdict === "FAIL" && removalOwn(row, unread).failures.some((f) => /no epoch was read before/.test(f)));
}

// ── the narration ────────────────────────────────────────────────────────────────────────────────
// Shapes read on the alpha.6 runs (2026-10-29), every id replaced by an invented one.
console.log('the narration');
const OWNER = 'aaaa1111'.padEnd(64, '0');
const SUBJ = 'bbbb2222'.padEnd(64, '0');
const IDS = {
  workspaceId: '11111111-0000-4000-8000-000000000001',
  channelIds: ['22222222-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003'],
  keyGroupIds: ['44444444-0000-4000-8000-000000000004', '55555555-0000-4000-8000-000000000005'],
  ownerUserId: OWNER,
  subjectUserId: SUBJ,
};
const rep = (lines) => ({ errors: [], warnings: [], unexplained: lines, badHttp: [], exceptions: [], severe: [], wsEvents: [] });
const forgiven = (row, seat, line, ids = IDS) => ignoringExpectedLog(rep([line]), removalNarration(row, seat, ids)).unexplained.length === 0;
const K = 'KICK-COMMIT';
const S = 'SALON-REVOKE-COMMIT';
const DV = 'DEVREVOKE-KEYGROUP';
const devIds = { ...IDS, subjectUserId: null };

// THE COMMUNITY EVERY ROW BUILDS, and the owner's other devices entering its key groups.
const SELF_ENTRY = 'debug: [01:10:37.379] [DEVICE_NOTICE] self-admitted entry in 44444444... - not a conversation, nothing to say';
const SORT = (undecided) => `debug: [01:10:37.379] [DEVICE_NOTICE] 1 device event(s) to sort (+${undecided} undecided)`;
const NOT_NEW = 'log: [01:10:38.556] [DEVICE_NOTICE] 1 device(s) seen for the first time here are not new';
const JOINED = 'log: [01:10:36.827] Joined channel 22222222…';
ok('a self-entry into one of the row\'s key groups is forgiven on W1 and W2', forgiven(K, 'W1', SELF_ENTRY) && forgiven(S, 'W2', SELF_ENTRY));
ok('... NOT into a key group of another community', !forgiven(K, 'W1', SELF_ENTRY.replace('44444444', '99999999')));
ok('the sort with nothing undecided is forgiven, one left undecided is NOT', forgiven(K, 'W1', SORT(0)) && !forgiven(K, 'W1', SORT(1)));
ok('"seen for the first time here are not new" is forgiven; at warn it is NOT', forgiven(K, 'W1', NOT_NEW) && !forgiven(K, 'W1', NOT_NEW.replace('log:', 'warn:')));
ok("joining the row's own channel is forgiven, another channel is NOT", forgiven(K, 'W2', JOINED) && !forgiven(K, 'W2', JOINED.replace('22222222', '99999999')));

// THE ONE SALON MESSAGE W1 SENDS, and the owner's other devices asking for its seed.
const REPEAT = (n) => `log: [01:10:57.752] [SALON-REPEAT] the server echoed client id a677dd1a...: a repeated send is answered with its row - ${n} waiting repeat(s) released`;
const ANSWERED = (u) => `info: [01:10:58.468] [GRAINE] answered ${u.slice(0, 8)}…:tauri-${u.slice(0, 8)}…-mvn33w3u-4b2d with 1 seed(s) in 1 page(s)`;
ok('the send echo, its settling and the unsent ledger cleared are forgiven on W1', ['log: [SALON-ECHO] a677dd1a… sending', 'log: [SALON-ECHO] a677dd1a… settled as 858b036a…', 'debug: [SALON-UNSENT] 1 entr(y/ies) forgotten: the server holds them'].every((l) => forgiven(K, 'W1', l)));
ok('... NOT on W2, which sent nothing', !forgiven(K, 'W2', 'log: [SALON-ECHO] a677dd1a… sending'));
ok('the repeat proof with nothing waiting is forgiven; a waiting repeat (a send that went twice) is NOT', forgiven(K, 'W1', REPEAT(0)) && !forgiven(K, 'W1', REPEAT(1)));
ok("answering the owner's other device is forgiven; another account's device is NOT", forgiven(K, 'W1', ANSWERED(OWNER)) && !forgiven(K, 'W1', ANSWERED(SUBJ)));
ok('an answer with zero seeds is NOT (that is "I hold nothing" said as an answer)', !forgiven(K, 'W1', ANSWERED(OWNER).replace('with 1 seed(s)', 'with 0 seed(s)')));

// THE GESTURES, as the actor's session says them - the very commits the row judges.
const REMOVE_COMMUNITY = 'log: [GRAINE] REMOVE community 11111111: bbbb2222 kicked from the community - committing it from this device';
const DEPARTURE = 'log: [GRAINE] DEPARTURE bbbb2222 from salon 33333333 of 11111111: the actor\'s device aaaa1111 holds a leaf - left to it; decided again only if it releases it';
ok("the kick's removes and departures are forgiven on W1 in KICK-COMMIT", [REMOVE_COMMUNITY, 'log: [GRAINE] REMOVE bbbb2222: 1 private salon(s) of 11111111 registered here - each committed in turn', 'log: [GRAINE] REMOVE salon 33333333 of 11111111: bbbb2222 kicked from the community - committing it from this device', DEPARTURE, DEPARTURE.replace('salon 33333333 of 11111111', 'community 11111111')].every((l) => forgiven(K, 'W1', l)));
ok('... a REMOVE is NOT forgiven in a salon revoke, where nobody is kicked', !forgiven(S, 'W1', REMOVE_COMMUNITY));
ok('... nor naming another user, nor on the subject W2', !forgiven(K, 'W1', REMOVE_COMMUNITY.replace('bbbb2222', 'cccc3333')) && !forgiven(K, 'W2', REMOVE_COMMUNITY));
ok("the salon revoke's departure and the panel closing are forgiven on W1", forgiven(S, 'W1', DEPARTURE) && forgiven(S, 'W1', 'debug: [historyOverlay] a navigation closes 1 open overlay(s)'));
ok('a needle is anchored at both ends: the same sentence with a tail is NOT forgiven', !forgiven(K, 'W1', `${DEPARTURE} - and 1 more`) && !forgiven(K, 'W1', `${NOT_NEW}, 1 is`));
ok('a REMOVE of nobody (0 private salons) is NOT forgiven', !forgiven(K, 'W1', 'log: [GRAINE] REMOVE bbbb2222: 0 private salon(s) of 11111111 registered here - each committed in turn'));

// THE SUBJECT, admitted to the salon by the actor.
const SEED = 'debug: [GRAINE] seed vFb83nPpDVrTLNhGngjKtAbd from aaaa1111… for channel 33333333 - v2 endorsement verified from the tree';
ok("the subject's seed verified from the tree, the drain's re-read and the salon opened are forgiven on W2", [SEED, 'debug: [GRAINE] drain over - re-reading 1 salon(s) once for the seeds it brought', 'debug: [notificationPreferences.fetchChannelLevel(33333333…)]', 'debug: [CHAT_VIEW] channel_ messages 1 (hasNewMessage=true, response=repin-entry)'].every((l) => forgiven(S, 'W2', l)));
ok("... a seed verified only from the server's keys is NOT", !forgiven(S, 'W2', SEED.replace('from the tree', "from the server's published keys (minter has left the tree)")));
ok('... a seed for another channel is NOT', !forgiven(S, 'W2', SEED.replace('channel 33333333', 'channel 99999999')));

// THE MINTED OWNER DEVICE OF DEVREVOKE-KEYGROUP, as W1 meets it.
const WELCOME_REQ = (u) => `log: [WELCOME_REQ] ${u.slice(0, 8)}…:web-${u.slice(0, 8)}... is a device this one never saw, of a member of a1c4da59... - not added automatically, a member's approval of key 21ff15a1… is asked`;
const JOIN_REQ = (u) => `log: [JOIN_REQUEST] an unseen device web-${u.slice(0, 8)}... of ${u.slice(0, 8)}… asks to join a1c4da59... under key 21ff15a1… - a member's answer is awaited`;
const WITHHOLD = 'info: [GRAINE] withholding 1 seed(s) from aaaa1111… on community 11111111: 1 of a salon riding another key group, 0 not listed on this device';
const NOT_ANSWERING = 'info: [GRAINE] not answering aaaa1111…\'s history ask in community 11111111: 1 seed(s) withheld for their salon\'s roster - not "I hold nothing"';
const FIRST_SIGHT = 'log: [DEVICE_NOTICE] a new device was added to this account (first-sight)';
ok('the minted device: first sight, the approvals asked, the history withheld - forgiven on W1 in DEVREVOKE-KEYGROUP', [FIRST_SIGHT, WELCOME_REQ(OWNER), JOIN_REQ(OWNER), WITHHOLD, NOT_ANSWERING].every((l) => forgiven(DV, 'W1', l, devIds)));
ok('... NOT in a kick or a salon revoke, where nothing is minted', [FIRST_SIGHT, WELCOME_REQ(OWNER), JOIN_REQ(OWNER)].every((l) => !forgiven(K, 'W1', l) && !forgiven(S, 'W1', l)));
ok("... NOT for another account's device", !forgiven(DV, 'W1', WELCOME_REQ(SUBJ), devIds) && !forgiven(DV, 'W1', JOIN_REQ(SUBJ), devIds));
ok('... a user-level join ask (no device) is NOT', !forgiven(DV, 'W1', JOIN_REQ(OWNER).replace('an unseen device web-aaaa1111... of ', ''), devIds));
ok('... a withholding in another community is NOT', !forgiven(DV, 'W1', WITHHOLD.replace('community 11111111', 'community 99999999'), devIds));
ok('... seeds that do not open with this key (the warn branch) are NOT', !forgiven(DV, 'W1', 'warn: [GRAINE] not answering aaaa1111…\'s history ask in community 11111111: 2 seed row(s) held and 1 do not open with this device\'s key - not "I hold nothing"', devIds));

// WHAT IS FIXED AT THE PRODUCT, NEVER FORGIVEN HERE.
ok('"holds nothing" and "absorbed 0/0" stay dirt on every seat (said once per READ)', ['info: [GRAINE] aaaa1111…:web-aaaa1111…-mvqwynse-s2ai holds nothing of community 11111111 - recorded; 2 device(s) of aaaa1111… still to answer', 'debug: [GRAINE] absorbed 0/0 seed(s) (0 already held) from bbbb2222… in community 11111111 - salon(s) none'].every((l) => !forgiven(K, 'W1', l) && !forgiven(K, 'W2', l)));
ok('the boot narration is NOT in the row narration (added only for a window that replaced its document)', !forgiven(K, 'W2', 'log: [RESTORE] 10 conversation row(s) seeded - history follows'));
ok('no seat outside the row is given anything, nor a row with no ids', removalNarration(K, 'W6', IDS).length === 0 && removalNarration(DV, 'W2', devIds).length === 0 && removalNarration(K, 'W1', null).length === 0);

// EVERY SENTENCE ABOVE, AGAINST THE APP SOURCE: a reworded log breaks here, not in a run.
const APP = (p) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../frontend/src/lib', p), 'utf8');
for (const [file, text] of [
  ['utils/graine/commitRemoval.ts', '- committing it from this device`'],
  ['utils/graine/commitRemoval.ts', 'registered here - each committed in turn`'],
  ['utils/graine/departureCommitter.ts', "holds a leaf - left to it; decided again only if it releases it`"],
  ['utils/chat/deviceNotices.svelte.ts', 'device(s) seen for the first time here are not new`'],
  ['utils/chat/deviceNotices.svelte.ts', '... - not a conversation, nothing to say`'],
  ['utils/chat/deviceNotices.svelte.ts', '[DEVICE_NOTICE] a new device was added to this account (${event.trust})'],
  ['utils/chat/salonRepeatProof.ts', 'a repeated send is answered with its row - ${waiters.size} waiting repeat(s) released`'],
  ['utils/chat/salonUnsent.ts', 'entr(y/ies) forgotten: the server holds them`'],
  ['utils/chat/actions.ts', "- not added automatically, a member's approval of key ${key.fingerprint} is asked`"],
  ['utils/chat/joinRequests.svelte.ts', "under key ${ask.keyFingerprint ?? '(none)'}${known ? ' (its key changed since the last ask)' : ''} - a member's answer is awaited`"],
  ['utils/graine/frameHandler.ts', 'of a salon riding another key group, ${notListed} not listed on this device`'],
  ['utils/graine/frameHandler.ts', "' - v2 endorsement verified from the tree'"],
  ['utils/graine/runtime.ts', 'salon(s) once for the seeds it brought`'],
  ['utils/historyOverlayStack.ts', 'a navigation closes ${stack.length} open overlay(s)`'],
]) ok(`${file} still writes ...${text.slice(0, 50)}`, APP(file).includes(text));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
