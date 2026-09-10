#!/usr/bin/env bun
/**
 * A FILE THIS REPOSITORY RUNS AS `./something` MUST BE RECORDED EXECUTABLE IN GIT.
 *
 * WHY THIS EXISTS. Windows has no executable bit. A script authored here is committed `100644`,
 * runs perfectly for its author because every local invocation goes through `bash x.sh`, and then
 * dies on a Linux runner the first time something calls it as `./x` - `Permission denied`, five
 * seconds in, with no relation to what the change was about. That is exactly how the Android
 * unit-test wrapper failed on 2026-09-10: `gradlew` went in at `100644` beside a `gen/android`
 * copy at `100755`, and the difference is invisible in every editor and in `git status`.
 *
 * WHY IT DERIVES THE LIST RATHER THAN KEEPING ONE. A hand-maintained list of "the executable
 * files" is the same absence the ceiling table and the self-test recipe both had: the entry
 * nobody remembers to add is the one that breaks. So this reads the tracked files that actually
 * SPELL COMMANDS - the Makefile, the workflows and the shell scripts - takes every `./x` standing
 * in command position, and demands that every tracked file named `x` be `100755`. A new script is
 * covered the moment something calls it, which is the moment it starts to matter.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. It says nothing about the 30-odd `.sh` files recorded
 * `100644`: those are invoked `bash x.sh`, where the bit is inert, and flipping them would be
 * churn with no failure behind it. The invariant is about HOW A FILE IS CALLED, not what it is.
 *
 * SO IT ONLY LOOKS AT COMMAND POSITION, and the first draft of this test proves why that matters:
 * matching `./x` anywhere accused nineteen files, and every one of them was an ARGUMENT - a
 * `docker build -f ./Dockerfile.frontend`, a compose volume `./garage/garage.toml:/etc/...`, a
 * `cat ./frontend/package.json`. Making those executable would be nonsense dressed as a fix. A
 * path is only an invocation when it is the first word of a command, so that is the only place
 * this looks: the start of a line, or just after `&&`, `||`, `|`, `;`, `(` or `$(`.
 *
 * Usage: bun .github/scripts/tests/executable-bit.test.mjs   (no arguments, no network)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** `git ls-files -s` gives mode and path for every tracked file, which is the only source here. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8' });
  const modes = new Map();
  for (const line of out.split('\n')) {
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/.exec(line);
    if (match) modes.set(match[2], match[1]);
  }
  return modes;
}

/**
 * Files worth scanning for `./` invocations: the places this repo actually spells commands.
 * Anything else (source, lockfiles, generated output) writes `./x` to mean an import path.
 */
const SCANNED = /(^|\/)(Makefile|[^/]+\.(sh|bash|yml|yaml))$/;

/** A `./path` that OPENS a command segment - see the note above about argument positions. */
const INVOCATION = /^\.\/([A-Za-z0-9_][A-Za-z0-9_./-]*)/;

/** The separators after which a new command begins, in both shell and a Makefile recipe. */
const SEGMENT = /\|\||&&|[|;]|\$\(|[()]|`/;

/**
 * Anything that may sit in front of the command word without changing that it IS the command.
 * `-` is a Makefile's "ignore the exit status" prefix and is glued to the verb (`-rm x`); the
 * lookahead is what keeps it from eating a YAML list item, where `- ./a/b.toml:/etc/b.toml` is a
 * volume mount and nothing is being run at all.
 */
const PREFIX = /^(?:[\t ]|@|-(?=\S)|sudo\s+|exec\s+|time\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Every command word on a line: the line split on separators, each piece stripped of the noise a
 * recipe or a shell puts before the verb. A piece that is a comment contributes nothing.
 */
function commandWords(line) {
  return line
    .split(SEGMENT)
    .map((piece) => piece.replace(PREFIX, ''))
    .filter((piece) => piece.length > 0 && !piece.startsWith('#'));
}

/**
 * Which tracked files a `./x` could mean: every one whose path IS `x` or ends in `/x`.
 *
 * IT DOES NOT TRY TO WORK OUT THE WORKING DIRECTORY, and the first version of this test failed
 * its own motivating case by trying. The Android runner calls `( cd "$ANDROID_DIR" && ./gradlew )`
 * - the directory is a variable, so resolving the call against the caller's own folder looked for
 * `.github/scripts/gradlew`, found nothing, and reported the tree clean while the real
 * `android-tests/gradlew` sat at 100644. Chasing the cwd through variables, `cd` and a matrix is a
 * shell interpreter, and a half-written one answers "clean" when it loses track.
 *
 * So the claim is deliberately stronger and needs no interpreter: if a name is ever run as a
 * command anywhere in this repository, EVERY tracked file with that name must be executable. The
 * two `gradlew` wrappers are both covered by the one `./gradlew` in the runner, which is the
 * behaviour that was wanted. A false positive here would be a data file sharing a name with
 * something the repo executes - it would be a real ambiguity worth renaming, not a wrong answer.
 */
function resolveByName(called, modes) {
  const suffix = `/${called}`;
  return [...modes.keys()].filter((p) => p === called || p.endsWith(suffix));
}

const modes = trackedFiles();
const offenders = new Map();
const checked = [];

for (const [path, mode] of modes) {
  if (!SCANNED.test(path)) continue;
  if (mode === '120000') continue; // a symlink's own mode says nothing about its target
  let text;
  try {
    text = readFileSync(resolve(repoRoot, path), 'utf8');
  } catch {
    continue; // deleted from the worktree but still in the index - not this test's business
  }
  const calls = text
    .split('\n')
    .flatMap(commandWords)
    .map((piece) => INVOCATION.exec(piece)?.[1])
    .filter((called) => called !== undefined);
  for (const called of calls) {
    for (const candidate of resolveByName(called, modes)) {
      const found = modes.get(candidate);
      checked.push(candidate);
      // Keyed by the FILE, not by the call: one wrapper invoked from three places is one defect
      // with one fix, and printing it three times only teaches the reader to skim the report.
      if (found !== '100755' && !offenders.has(candidate)) {
        offenders.set(candidate, { caller: path, mode: found });
      }
    }
  }
}

if (checked.length === 0) {
  console.error('FAIL: no `./` invocation matched a tracked file - the scan is wrong, not the tree.');
  process.exit(1);
}

if (offenders.size > 0) {
  console.error(`FAIL: ${offenders.size} file(s) called as ./x but not recorded executable:\n`);
  for (const [target, { caller, mode }] of offenders) {
    console.error(`  ${target} is ${mode}, called from ${caller}`);
  }
  console.error(
    '\nGit records the bit; Windows does not have one, so an editor cannot show you this.' +
      '\nFix with:  git update-index --chmod=+x <path>' +
      '\nOtherwise the first Linux runner to reach it fails with Permission denied.'
  );
  process.exit(1);
}

const distinct = new Set(checked);
console.log(`OK: ${distinct.size} file(s) invoked as ./x are all recorded executable.`);
