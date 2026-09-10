#!/usr/bin/env bun
/**
 * DOES ANYTHING ACTUALLY RUN THE SELF-TESTS IN THIS DIRECTORY?
 *
 * `make test-ci-scripts` names them one by one, and that list is maintained by hand. A test file
 * added without a line in the recipe is DECORATIVE: it passes locally for whoever wrote it, never
 * runs in CI, and reports nothing for the rest of its life. That is the same failure the ceiling
 * table had - an absence, invisible - and the same answer applies: derive the expectation from the
 * tree rather than from a list somebody has to remember.
 *
 * It is deliberately the weakest possible claim. It does not check that a test is GOOD, only that
 * it is REACHED, because a test nothing runs cannot be anything else.
 *
 * Usage: bun .github/scripts/tests/recipe-covers-tests.test.mjs   (no arguments, no network)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const RECIPE = 'test-ci-scripts';

/** The recipe's body: every line from its target to the first line that is not a recipe line. */
function recipeBody(makefile) {
  const lines = makefile.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${RECIPE}:`));
  if (start === -1) throw new Error(`No '${RECIPE}:' target in the Makefile`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    // A recipe line is TAB-indented; the first that is not ends the recipe.
    if (!line.startsWith('\t')) break;
    body.push(line);
  }
  return body.join('\n');
}

const makefile = readFileSync(resolve(repoRoot, 'Makefile'), 'utf8');
const body = recipeBody(makefile);

const tests = readdirSync(here)
  .filter((f) => f.endsWith('.test.sh') || f.endsWith('.test.mjs'))
  .sort();

if (tests.length === 0) {
  console.error(`FAIL: no self-tests found in ${here} - the glob is wrong, not the tree.`);
  process.exit(1);
}

const unreached = tests.filter((f) => !body.includes(f));

if (unreached.length > 0) {
  console.error(`FAIL: ${unreached.length} self-test(s) that '${RECIPE}' never runs:\n`);
  for (const f of unreached) console.error(`  .github/scripts/tests/${f}`);
  console.error(
    `\nAdd a line to the '${RECIPE}' recipe in the Makefile. A test nothing runs is not a` +
      '\ngate - it is a file that will pass for ever without being asked anything.'
  );
  process.exit(1);
}

console.log(`ok   all ${tests.length} self-test(s) in this directory are run by '${RECIPE}'`);
