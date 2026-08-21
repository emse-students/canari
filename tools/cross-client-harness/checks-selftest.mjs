#!/usr/bin/env node
/**
 * Asserts that every phase DECLARES the devices its scripts actually drive.
 *
 * WHY THIS FILE EXISTS. MUT-18 opens a conversation on the phone. `checks.mjs` said MUT needs
 * `W1 W2`. So the preflight never armed A1, `sameAccountAs` found nothing on port 9333, and the
 * check recorded `SKIPPED - second client not reachable` on every run it was ever asked for - a
 * reason that is true, useless, and points at the cable instead of at the declaration one file away.
 * It had therefore never produced a verdict, and nobody could tell, because a skip reads as a check
 * that was not applicable rather than as one that was misconfigured.
 *
 * A declaration is also what makes a phase carry `CANARI_A1_BUILD`. An undeclared phone means rows
 * landing with no `a1Build` beside `build` - the campaign's own rule for believing a mobile verdict,
 * broken silently by an omission in a list.
 *
 * WHAT IT CANNOT SEE, stated because the gap is the interesting part. This reads the SOURCE for the
 * ways a runner reaches the phone (`PORTS.A1`, `sameAccountAs`, `a1SameAccountAs`,
 * `tauri.localhost`). A runner that reached it some other way would pass here and fail on the rig,
 * so a new door into the phone belongs in `A1_DOORS` below the day it is opened. It also works at
 * FILE granularity: the twenty-one MUT checks are all `mut.mjs`, so "does this phase touch the
 * phone" is answerable and "which of its checks do" is not - `PHONE_SCRIPTS` is where a phase says
 * that, and it can only say it about phases whose checks live in separate files.
 *
 * Run: `node tools/cross-client-harness/checks-selftest.mjs`
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, PHONE_SCRIPTS } from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every spelling by which a runner reaches A1.
 *
 * `PORTS.A1` is the port itself, `sameAccountAs`/`a1SameAccountAs` are the helpers that attach to
 * the phone as a second device of an account, and `tauri.localhost` is the origin only the phone
 * serves. Add a door here when one is opened; a runner using an unlisted one is invisible to this.
 */
const A1_DOORS = /PORTS\.A1|sameAccountAs|a1SameAccountAs|tauri\.localhost/;

/** Whether a runner file contains any door to the phone. Throws if the file is unreadable. */
function drivesPhone(file) {
  return A1_DOORS.test(readFileSync(join(HERE, file), 'utf8'));
}

const problems = [];

for (const [name, phase] of Object.entries(PHASES)) {
  // A phase with no script yet declares nothing and drives nothing - the ladder writes those as it
  // reaches them, and an empty phase is a state the campaign tracks rather than a fault.
  if (!phase.scripts.length) continue;

  const files = [...new Set(phase.scripts.map((s) => s.split(' ')[0]))];
  let phoneFiles;
  try {
    phoneFiles = files.filter(drivesPhone);
  } catch (e) {
    problems.push(`${name}: a declared script is unreadable - ${e.message}`);
    continue;
  }
  const declared = phase.needs.includes('A1');

  if (phoneFiles.length && !declared) {
    problems.push(
      `${name} drives the phone (${phoneFiles.join(', ')}) but declares needs=[${phase.needs.join(' ')}]. ` +
        `The preflight will not arm A1, so those checks will SKIP as "not reachable" and any row they ` +
        `do land will carry no a1Build.`
    );
  }

  if (!phoneFiles.length && declared) {
    problems.push(
      `${name} declares A1 but no script of its own reaches it (${files.join(', ')}). ` +
        `Arming the phone for a phase that never touches it costs a preflight and stamps every row ` +
        `with an a1Build that describes nothing.`
    );
  }

  // `PHONE_SCRIPTS` narrows a phase's phone requirement to named scripts, which only means anything
  // if the phase declares the phone at all - and only if those scripts are really the ones using it.
  const narrowed = PHONE_SCRIPTS[name];
  if (narrowed) {
    if (!declared) {
      problems.push(`${name} lists PHONE_SCRIPTS but does not declare A1 in needs - the narrowing has nothing to narrow.`);
    }
    for (const s of narrowed) {
      if (!files.includes(s)) {
        problems.push(`${name} PHONE_SCRIPTS names ${s}, which is not one of its scripts.`);
      } else if (!phoneFiles.includes(s)) {
        problems.push(`${name} PHONE_SCRIPTS names ${s}, which contains no door to the phone.`);
      }
    }
    for (const s of phoneFiles) {
      if (!narrowed.includes(s)) {
        problems.push(
          `${name} drives the phone from ${s}, which PHONE_SCRIPTS omits - so a --file run of it ` +
            `would be preflighted WITHOUT A1.`
        );
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\n${problems.length} phase declaration(s) disagree with their scripts`);
  process.exit(1);
}

const armed = Object.entries(PHASES).filter(([, p]) => p.scripts.length && p.needs.includes('A1'));
console.log(
  `ok   ${Object.values(PHASES).filter((p) => p.scripts.length).length} phase(s) with scripts; ` +
    `${armed.length} declare A1 (${armed.map(([n]) => n).join(' ')})`
);
console.log('all good');
