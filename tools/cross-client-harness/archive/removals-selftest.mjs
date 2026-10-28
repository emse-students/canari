/**
 * THE REMOVAL ROWS' JUDGE, PINNED (`removalrows.mjs`): a clean measurement passes, each fact broken
 * alone fails with one failure, and a row whose subject never reached a key group is VACUOUS. Pure.
 *
 *   bun archive/removals-selftest.mjs
 */
import { PHASES, devicesFor } from '../checks.mjs';
import { COMMIT_ROUNDS, REMOVAL_ROWS, removalOwn } from '../removalrows.mjs';

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

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
