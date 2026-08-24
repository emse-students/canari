#!/usr/bin/env node
/**
 * Asserts that the allowlist deciding what may be DESTROYED matches every name a runner mints, and
 * nothing a person could type.
 *
 * WHY THIS FILE EXISTS. `isGroupDebris` is the most dangerous pure function in the rig: `cleanup.mjs`
 * deletes the groups it names on the server, and `dismiss.mjs` purges the conversations it names on
 * every client. It had no test. It was also already WRONG, twice over, and both faults were found by
 * measuring a store rather than by reading the list - which is not a method that scales to the next
 * one. GRP-5 renames its group to `<name>-R` (grp.mjs:702), so 22 rows sat in W2's store on
 * 2026-08-24 invisible to BOTH sweeps, and the server-side sweep would equally have spared a LIVE
 * `GRP5-*-R` left by a run that died between the rename and its teardown.
 *
 * SO THE TEST BUILDS ITS NAMES THE WAY THE RUNNERS DO, from `mark` and from the same expressions
 * their sources use, rather than from a shape someone believed. A test asserting a pattern I typed
 * would agree with the allowlist for the same wrong reason - the two would be one belief written
 * twice. `mark` is imported; the literal expressions are quoted from the line that mints them, and
 * the line is named so a drift is one grep away.
 *
 * WHAT IT CANNOT SEE. It knows the call sites that existed when it was written - the enumeration is
 * `grep -rn 'createGroup(' --include=*.mjs`, seven sites across four runners. A NEW runner minting a
 * new shape passes here and leaves debris on the rig, exactly as GRP-5's rename did. That is the
 * residual risk, and it is why the allowlist's own header says it is widened by ENUMERATING what the
 * runners mint, never by relaxing a shape.
 */
import { isGroupDebris } from './debris.mjs';
import { mark } from './results.mjs';

const problems = [];
const swept = (name, why) => {
  if (!isGroupDebris(name)) problems.push(`NOT swept but must be: ${name} - ${why}`);
};
const spared = (name, why) => {
  if (isGroupDebris(name)) problems.push(`SWEPT but must not be: ${name} - ${why}`);
};

// ---------------------------------------------------------------- what the runners actually mint

// grp.mjs:185 `mark(`GRP${n}`)` for every check of the phase, 1..10.
for (let n = 1; n <= 10; n++) swept(mark(`GRP${n}`), `grp.mjs withGroup(${n})`);
// grp.mjs:702 renames GRP-5's group to prove a rename is a broadcast. The tombstone keeps the new
// name, so this is the shape that actually lands in a member's store.
swept(`${mark('GRP5')}-R`, 'grp.mjs:702 renameGroup');
// del1.mjs:45 `const run = mark('DEL1'); const NAME = run;`
swept(mark('DEL1'), 'del1.mjs:45');
// read.mjs:735 `READ10-${Date.now().toString(36)}`
swept(`READ10-${Date.now().toString(36)}`, 'read.mjs:735');
// newgroup.mjs:24 default `HEALW2-${Date.now().toString(36)}`
swept(`HEALW2-${Date.now().toString(36)}`, 'newgroup.mjs:24 default');
// heal-w2.mjs:38 `HGRP${Math.random().toString(36).slice(2, 7)}`. FIVE characters almost always -
// and `Math.random()` returning a value whose base-36 form is short gives FEWER, down to one:
// `(0.5).toString(36)` is `0.i`, so the name is `HGRPi`. A band that starts at 4 misses it. The
// value is not reachable on demand, which is exactly why it is asserted here rather than trusted.
for (const tail of ['i', 'ab', 'k7p', 'ktp5w', '0zzzz1'])
  swept(`HGRP${tail}`, `heal-w2.mjs:38 with a ${tail.length}-char random tail`);

// ---------------------------------------------------------------- what must survive a sweep

spared('Projet Canari', 'a group a person made');
spared('Famille', 'a group a person made');
spared('canari', 'a lowercase word, not a stamp');
spared('GRP', 'the bare prefix names no run');
spared('DEL1', 'a stamp is a prefix AND a mark; the prefix alone is not one');
spared('HGRP', 'same - the random tail is what makes it a run');
spared('READ10', 'same');
// THE ONE THAT WOULD HAVE BEEN DELETED BY A CARELESS WIDENING. `GRPBEF-<mark>` is a MESSAGE marker
// (grp.mjs:550), not a group name - it appears as a sidebar PREVIEW, which is how it was first seen.
// Relaxing `GRP\d+` to `GRP\w+` to "catch more debris" would make this eligible, and the row it
// would then delete is the CONVERSATION whose last message happens to be that marker.
spared(`GRPBEF-${Date.now().toString(36)}`, 'a message marker, never a group name');
spared(`GRPAFT-${Date.now().toString(36)}`, 'idem, grp.mjs:562');
spared(`GRPCHURN-${Date.now().toString(36)}`, 'idem, grp.mjs:903');
// Case matters: a stamp is upper-case by construction, so a lower-case near-miss is a person's.
spared(`grp5-${Date.now().toString(36)}`, 'lower case is not a stamp');
// A trailing segment the runners never mint. `-R` is enumerated; anything else is not ours to touch.
spared(`${mark('GRP5')}-X`, 'no runner mints -X');
spared(`${mark('GRP5')}-R-R`, 'nor a doubled rename');
// `newgroup.mjs --name <anything>` lets an operator create a group by hand, deliberately outside
// every pattern here. A name given on a command line is a person's name for it.
spared('HEAL manual check', 'an operator-supplied --name');

if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\n${problems.length} allowlist disagreement(s) - a destructive predicate is wrong`);
  process.exit(1);
}

console.log('ok   every minted shape is swept; every human and marker shape is spared');
console.log('all good');
