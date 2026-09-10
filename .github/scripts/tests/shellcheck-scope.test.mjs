#!/usr/bin/env bun
/**
 * EVERY TRACKED SHELL SCRIPT IS LINTED, AND THE TWO PLACES THAT SAY SO AGREE.
 *
 * WHY THIS EXISTS, and it is two failures rather than one.
 *
 * AN ALLOWLIST'S FAILURE MODE IS AN ABSENCE, AND AN ABSENCE IS INVISIBLE TO EVERY REVIEW. The
 * shellcheck step globs directories by name. `scripts/` was outside it - noticed 2026-09-03 and
 * recorded as one directory - and when the fix was finally written on 2026-09-10 the derivation
 * below found FOUR: `scripts/`, `infrastructure/local/`, `infrastructure/backup/`,
 * `infrastructure/lib/` and `infrastructure/egress-probe/`. Eight scripts more than anyone had
 * counted, including the one that restores a database into the local estate. Nobody excluded
 * them; they were simply added after the list was written, which is what a name-based allowlist
 * always eventually is.
 *
 * AND THE MAKEFILE CLAIMED TO MATCH `ci.yml` WITHOUT ANYTHING CHECKING. Its comment reads *"the
 * same file set as ci.yml"*, which was true when written and drifted the moment either was
 * edited - both had to be changed by hand in the same commit as this file, which is the evidence.
 * A local run that lints less than CI is a green run that means nothing.
 *
 * SO THE ASSERTION IS DERIVED FROM `git ls-files`, never from a list here.
 *
 * Usage: bun .github/scripts/tests/shellcheck-scope.test.mjs   (no arguments, no network)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failures = 0;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failures += 1;
};
const pass = (message) => console.log(`  ok    ${message}`);

// ── the population: every shell script this repository tracks ────────────────────────────────
const tracked = execFileSync('git', ['ls-files', '*.sh'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

if (tracked.length === 0) {
  fail('git ls-files found no shell scripts at all - this test is reading the wrong tree');
  process.exit(1);
}
pass(`${tracked.length} tracked shell script(s) in ${new Set(tracked.map((f) => dirname(f))).size} directories`);

/** The `<dir>/*.sh` globs a shellcheck invocation lists, in whatever whitespace it uses. */
function globsIn(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  // From the invocation to the end of its (possibly continued) command.
  const window = source.slice(at, at + 1200);
  return [...window.matchAll(/([\w./-]+)\/\*\.sh/g)].map((m) => m[1]);
}

const ci = read('.github/workflows/ci.yml');
const makefile = read('Makefile');

const ciGlobs = globsIn(ci, 'shellcheck" -x');
const makeGlobs = globsIn(makefile, 'shellcheck -x');

if (!ciGlobs || ciGlobs.length === 0) {
  fail('no shellcheck globs found in ci.yml - the parse above is broken, not the workflow');
} else {
  pass(`ci.yml lints ${ciGlobs.length} directories`);
}
if (!makeGlobs || makeGlobs.length === 0) {
  fail('no shellcheck globs found in the Makefile');
} else {
  pass(`the Makefile lints ${makeGlobs.length} directories`);
}

// ── 1. the two agree ─────────────────────────────────────────────────────────────────────────
const sorted = (a) => [...new Set(a)].sort().join(' ');
if (ciGlobs && makeGlobs) {
  if (sorted(ciGlobs) === sorted(makeGlobs)) {
    pass('the Makefile lints exactly what ci.yml lints');
  } else {
    const only = (a, b) => [...new Set(a)].filter((d) => !b.includes(d));
    fail(
      'the Makefile and ci.yml lint DIFFERENT file sets, so a clean local run says nothing.\n' +
        `     only in ci.yml   : ${only(ciGlobs, makeGlobs).join(' ') || '(none)'}\n` +
        `     only in Makefile : ${only(makeGlobs, ciGlobs).join(' ') || '(none)'}`
    );
  }
}

// ── 2. nothing tracked is outside the set ────────────────────────────────────────────────────
if (ciGlobs) {
  const covered = new Set(ciGlobs);
  const orphans = [...new Set(tracked.map((f) => dirname(f).replace(/\\/g, '/')))]
    .filter((d) => !covered.has(d))
    .sort();
  if (orphans.length === 0) {
    pass('every directory holding a tracked shell script is linted');
  } else {
    fail(
      `these directories hold tracked shell scripts that NOTHING shellchecks: ${orphans.join(', ')}.\n` +
        '     Add them to the glob in ci.yml AND the Makefile. A directory added after the list\n' +
        '     was written is how the last five got missed - the failure mode is an absence, and\n' +
        '     an absence is what no review notices.'
    );
  }
}

// ── 3. the version is named where a human looks, and CI reads it from there ──────────────────
let declared = '';
try {
  declared = read('.shellcheck-version').trim();
} catch {
  fail('.shellcheck-version is missing - "what CI runs" must not be a line inside a workflow');
}
if (declared) {
  if (/^v\d+\.\d+\.\d+$/.test(declared)) {
    pass(`.shellcheck-version names ${declared}`);
  } else {
    fail(`.shellcheck-version reads "${declared}", which is not a vX.Y.Z tag`);
  }
  if (ci.includes('.shellcheck-version')) {
    pass('ci.yml takes the version from that file rather than restating it');
  } else {
    fail('ci.yml does not read .shellcheck-version, so the two can disagree silently');
  }
  if (/SHELLCHECK_VERSION:\s*v\d/.test(ci)) {
    fail('ci.yml still hardcodes a SHELLCHECK_VERSION - delete it, the file is the declaration');
  } else {
    pass('ci.yml hardcodes no version of its own');
  }
  if (makefile.includes('.shellcheck-version')) {
    pass('the Makefile points a human at the same file when shellcheck is absent');
  } else {
    fail('the Makefile does not name .shellcheck-version, so "install shellcheck" says which one nowhere');
  }
}

console.log('');
if (failures > 0) {
  console.error(`shellcheck-scope: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('OK: every tracked shell script is linted, by both callers, at one declared version.');
