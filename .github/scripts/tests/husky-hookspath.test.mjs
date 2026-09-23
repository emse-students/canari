#!/usr/bin/env bun
/**
 * CAN `core.hooksPath` STILL BE SET TO A VALUE THAT DISARMS EVERY OTHER CHECKOUT?
 *
 * `core.hooksPath` lives in the COMMON git directory, so every `git worktree` shares one value.
 * `frontend/scripts/install-husky.js` used to hand husky an ABSOLUTE path - `findGitRoot` stops at
 * a worktree, because a worktree's `.git` is a FILE - and husky wrote that path. One `bun install`
 * inside a worktree therefore re-pointed the hooks of the main checkout and of every other
 * worktree at that worktree. When it was later removed, git ran NO hook anywhere and said nothing:
 * the only symptom is that commits stop re-staging anything.
 *
 * It happened FOUR times on one workstation (2026-09-03, 2026-09-21, 2026-09-23, 2026-09-24) and
 * every time it was found by accident, because the old post-condition asked only whether the value
 * was non-empty - which an absolute path satisfies. This pins the predicate that replaced it.
 *
 * Usage: bun .github/scripts/tests/husky-hookspath.test.mjs   (no arguments, no network)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { HOOKS_PATH, hooksPathProblem } = await import(
  resolve(repoRoot, 'frontend/scripts/hooks-path.js')
);

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  ok    ${m}`);
};
const no = (m) => {
  fail += 1;
  console.log(`  FAIL  ${m}`);
};

// The separator is built rather than written, because the fixtures below are Windows paths and a
// literal backslash in this file would be one shell quoting accident away from silently becoming
// a different string - which is exactly the class of bug this test exists to catch.
const BS = String.fromCharCode(92);

// The value the repository actually wants, and the only one that survives a worktree.
hooksPathProblem(HOOKS_PATH) === null
  ? ok(`the declared value ${HOOKS_PATH} is accepted`)
  : no(`the declared value ${HOOKS_PATH} is rejected: ${hooksPathProblem(HOOKS_PATH)}`);
HOOKS_PATH === '.husky/_'
  ? ok('the declared value is relative and names the directory husky generates')
  : no(`HOOKS_PATH is ${HOOKS_PATH}, which is not the path husky generates`);

// The four values actually observed in `.git/config` on this project, plus the POSIX and UNC
// spellings the same mistake takes elsewhere.
const observed = [
  `D:${BS}Documents${BS}Programmation${BS}EMSE${BS}Canari${BS}.husky/_`,
  `F:${BS}Programmation${BS}wt-scroll${BS}.husky/_`,
  `F:${BS}Programmation${BS}EMSE${BS}Canari${BS}.claude${BS}worktrees${BS}fix-photo-preview${BS}.husky/_`,
  `F:${BS}Programmation${BS}wt-devtools${BS}.husky/_`,
  '/home/runner/work/canari/canari/.husky/_',
  `${BS}${BS}server${BS}share${BS}.husky/_`,
];
for (const bad of observed) {
  hooksPathProblem(bad)
    ? ok(`refused: ${bad}`)
    : no(`ACCEPTED an absolute path, which disarms every other worktree: ${bad}`);
}

// An unset value is the other way a gate stops running while reporting nothing.
hooksPathProblem('') ? ok('refused: an empty value') : no('accepted an empty core.hooksPath');

// THE INSTALLER MUST WRITE THE VALUE ITSELF. Reading it back is not enough: husky's argument used
// to decide it, and that argument is built from a path this repository cannot constrain.
const installer = readFileSync(resolve(repoRoot, 'frontend/scripts/install-husky.js'), 'utf8');
installer.includes('git config core.hooksPath ${HOOKS_PATH}')
  ? ok('install-husky.js sets core.hooksPath from the declared value')
  : no('install-husky.js no longer sets core.hooksPath itself - husky decides again');
installer.includes('hooksPathProblem(hooksPath)')
  ? ok('install-husky.js asserts the value it read back')
  : no('install-husky.js no longer asserts the value it read back');

console.log(`\n${pass + fail} assertions, ${fail} failed`);
process.exit(fail ? 1 : 0);
