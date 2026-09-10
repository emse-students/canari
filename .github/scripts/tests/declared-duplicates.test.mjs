#!/usr/bin/env bun
/**
 * THE COPIES THIS REPOSITORY KEEPS ON PURPOSE ARE STILL COPIES.
 *
 * Some duplication here is a DECISION, argued in the files themselves, and this test does not
 * re-open it. `cors-origins.ts` says why: there is no shared TypeScript package, `libs/shared-ts`
 * existed, was imported by nothing and was deleted on 2026-08-27, and creating one for thirty
 * lines would add a build stage and the `--install-links` trap to four production images.
 *
 * WHAT THE DECISION LEAVES OPEN IS THE ONLY THING THIS ASSERTS, and that same docblock names it
 * exactly: *"the state this repo calls the worst a convention can be in is the one where three of
 * the four agree."* Nothing checked that. Four copies of an origin allowlist, four copies of a
 * framework assertion, and 636 lines of a Minesweeper engine whose two halves decide whether a
 * ranked score is a cheat - all held together by a comment reading `KEEP IN SYNC`.
 *
 * **A CLAIM THAT TWO THINGS AGREE MUST NAME THE MECHANISM THAT KEEPS THEM AGREEING.** `KEEP IN
 * SYNC` is an intention. This is the mechanism. Measured 2026-09-10, every group below was in
 * sync at the moment it was written - so this starts as a green gate over a true claim, which is
 * the only honest place to start one.
 *
 * TO ADD A GROUP: name the files and say WHY they are duplicated rather than shared. To REMOVE
 * one: delete the entry in the same change that deletes the duplication.
 *
 * Usage: bun .github/scripts/tests/declared-duplicates.test.mjs   (no arguments, no network)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * `exact` - byte for byte, comments included. For a file copied wholesale between packages.
 * `code`  - identical once comments and blank lines are dropped. For two files that legitimately
 *           introduce themselves differently but must BEHAVE identically.
 */
const GROUPS = [
  {
    what: 'the CORS origin allowlist every service applies',
    compare: 'exact',
    why: 'no shared TS package; one would add a build stage and the --install-links trap to four production images (see the docblock in any copy)',
    files: [
      'apps/chat-delivery-service/src/cors-origins.ts',
      'apps/core-service/src/cors-origins.ts',
      'apps/media-service/src/cors-origins.ts',
      'apps/social-service/src/cors-origins.ts',
    ],
  },
  {
    what: 'the CORS allowlist test that guards it',
    compare: 'exact',
    why: 'a copied module needs a copied test beside it, or three services assert the behaviour and the fourth only inherits the file',
    files: [
      'apps/chat-delivery-service/src/cors-origins.spec.ts',
      'apps/core-service/src/cors-origins.spec.ts',
      'apps/media-service/src/cors-origins.spec.ts',
      'apps/social-service/src/cors-origins.spec.ts',
    ],
  },
  {
    what: 'the NestJS framework-boot assertion',
    compare: 'exact',
    why: 'each app must assert its OWN resolved tree, so the test has to live in each app; only the assertion is shared',
    files: [
      'apps/chat-delivery-service/src/framework-boot.spec.ts',
      'apps/core-service/src/framework-boot.spec.ts',
      'apps/media-service/src/framework-boot.spec.ts',
      'apps/social-service/src/framework-boot.spec.ts',
    ],
  },
  {
    what: 'the Minesweeper engine, client and server',
    compare: 'code',
    why: 'the server replays a ranked game to decide whether a score is a cheat, so it must reach the SAME verdict as the client that produced it - a divergence rejects honest players or accepts dishonest ones',
    files: [
      'frontend/src/lib/minesweeper/game.ts',
      'apps/social-service/src/minesweeper/engine/game.ts',
    ],
  },
];

/** Comments and blank lines gone: what is left is what the file DOES. */
function codeOnly(source) {
  return source
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

let failures = 0;

for (const group of GROUPS) {
  const [base, ...rest] = group.files;
  let baseText;
  try {
    baseText = readFileSync(resolve(repoRoot, base), 'utf8');
  } catch {
    console.error(`FAIL ${group.what}: ${base} does not exist.`);
    console.error('     If the duplication is gone, delete this group in the same change.\n');
    failures++;
    continue;
  }
  const normalise = group.compare === 'exact' ? (s) => s.replace(/\r\n/g, '\n') : codeOnly;
  const want = normalise(baseText);

  const drifted = [];
  for (const other of rest) {
    let text;
    try {
      text = readFileSync(resolve(repoRoot, other), 'utf8');
    } catch {
      drifted.push(`${other} (missing)`);
      continue;
    }
    const got = normalise(text);
    if (got === want) continue;
    const a = want.split('\n');
    const b = got.split('\n');
    let firstDiff = 0;
    while (firstDiff < a.length && firstDiff < b.length && a[firstDiff] === b[firstDiff]) firstDiff++;
    drifted.push(
      `${other}\n       first difference at line ${firstDiff + 1} of the compared text:\n` +
        `         ${base.split('/').pop()}: ${(a[firstDiff] ?? '<end of file>').trim().slice(0, 90)}\n` +
        `         this copy:  ${(b[firstDiff] ?? '<end of file>').trim().slice(0, 90)}`
    );
  }

  if (drifted.length > 0) {
    console.error(`FAIL ${group.what} - ${drifted.length} of ${rest.length} cop(y|ies) drifted`);
    console.error(`     duplicated on purpose because: ${group.why}`);
    console.error(`     comparison: ${group.compare}\n`);
    for (const d of drifted) console.error(`     ${d}`);
    console.error('');
    failures++;
  } else {
    console.log(`ok   ${group.what} - ${group.files.length} copies agree (${group.compare})`);
  }
}

if (failures > 0) {
  console.error(
    `${failures} declared-duplicate group(s) have drifted.\n\n` +
      'Apply the change to EVERY copy. Three of four agreeing is the failure this exists to\n' +
      'name - the copies are duplicated deliberately, and that is only safe while they match.'
  );
  process.exit(1);
}

console.log(`\nOK: ${GROUPS.length} declared-duplicate group(s), every copy in sync.`);
