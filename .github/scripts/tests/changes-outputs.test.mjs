#!/usr/bin/env bun
/**
 * DOES "RUN EVERYTHING" ACTUALLY RUN EVERYTHING?
 *
 * `ci.yml`'s `changes` job decides which jobs run, and it has one escape hatch: when the CI
 * definition itself changed, `run_all` is called and every downstream job is meant to fire. It is
 * the most important path in the file, because it is the one taken by the pull requests that can
 * BREAK the file - and it is written as a hand-maintained list of `echo name=value` lines beside a
 * hand-maintained `outputs:` block. Two lists, no compiler.
 *
 * THEY DRIFTED, and the cost was exactly what the comment beside them warns about. On 2026-09-15
 * `run_all` wrote five of the job's seven outputs: `android` and `mls_compat` were absent, so a
 * pull request changing `ci.yml` skipped the Android suite and the MLS cross-version gate and
 * reported `CI passed` - green for the reason that the jobs had not run. #521 had already paid for
 * this once with a repaired `boot-nest-apps` job that merged while skipped.
 *
 * So this derives the expectation from the tree: every output the job DECLARES must be written by
 * `run_all`. Adding an output to `changes` without teaching `run_all` about it now fails here
 * rather than in the silence of a skipped job. It is deliberately the weakest possible claim - it
 * says nothing about whether the value is RIGHT, only that the path writes it at all.
 *
 * Usage: bun .github/scripts/tests/changes-outputs.test.mjs   (no arguments, no network)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};

/**
 * The `outputs:` block of the `changes` job, as a list of the step-output KEYS it forwards.
 *
 * The job-level name (`run-mls-compat`) and the step-output name (`mls_compat`) differ by
 * convention, and it is the STEP name that `run_all` writes - so that is what is read here.
 */
function declaredStepOutputs() {
  const job = ci.slice(ci.indexOf('\n  changes:'));
  const block = job.slice(job.indexOf('    outputs:'), job.indexOf('    steps:'));
  return [...block.matchAll(/steps\.matrix\.outputs\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** Every name `run_all` writes into `$GITHUB_OUTPUT`. */
function writtenByRunAll() {
  const start = ci.indexOf('run_all() {');
  if (start === -1) throw new Error('no `run_all() {` in ci.yml - this test is measuring nothing');
  const body = ci.slice(start, ci.indexOf('}', start));
  return [...body.matchAll(/echo "([A-Za-z0-9_-]+)=/g)].map((m) => m[1]);
}

const declared = declaredStepOutputs();
const written = writtenByRunAll();

console.log('the escape hatch writes every output the job promises:');

if (declared.length === 0) {
  bad('read no outputs off the `changes` job - the parser is wrong, not the workflow');
} else {
  ok(`${declared.length} output(s) declared by \`changes\``);
}
if (written.length === 0) {
  bad('read no assignments out of `run_all` - the parser is wrong, not the workflow');
}

for (const name of declared) {
  if (written.includes(name)) {
    ok(`run_all writes \`${name}\``);
  } else {
    bad(
      `run_all never writes \`${name}\`, so a pull request that changes ci.yml SKIPS the job ` +
        `behind it - and reports success for the reason that it did not run`,
    );
  }
}

// The other direction is a typo detector rather than a correctness claim: a name written but never
// forwarded reaches nothing, and is almost always a misspelling of one that matters.
for (const name of written) {
  if (!declared.includes(name)) {
    bad(`run_all writes \`${name}\`, which the job forwards to nobody - dead, or a typo`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('OK: every output the `changes` job declares is written by `run_all`.');
