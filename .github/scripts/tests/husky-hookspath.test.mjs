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
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
HOOKS_PATH === '.husky'
  ? ok('the declared value is relative and names the TRACKED hooks directory')
  : no(
      `HOOKS_PATH is ${HOOKS_PATH}, not the tracked .husky - a generated directory is absent ` +
        `from a fresh worktree, and git then runs no hook in silence`
    );

// A FRESH WORKTREE MUST HAVE ITS HOOKS (2026-11-15, PR #3611 was committed with none): every hook
// git calls is a tracked file, executable in the index, so it exists - and runs on Linux - in a
// checkout that never ran an install. The three `post-*` hooks write the gitignored plan page
// (2026-11-16, docs/wiki/cicd.md, "The plan page is generated where it is read"): one missing or
// not executable, and a checkout reads a page that silently stopped following its entries.
const indexModes = execFileSync('git', ['ls-files', '-s', '--', HOOKS_PATH], {
  cwd: repoRoot,
  encoding: 'utf8',
});
for (const hook of ['pre-commit', 'pre-push', 'post-checkout', 'post-merge', 'post-rewrite']) {
  // `git ls-files -s` prints `<mode> <sha> <stage>\t<path>`.
  const line = indexModes.split(/\r?\n/).find((l) => l.endsWith(`\t${HOOKS_PATH}/${hook}`));
  if (!line) no(`${HOOKS_PATH}/${hook} is not tracked, so a fresh checkout runs no ${hook} hook`);
  else if (!line.startsWith('100755 '))
    no(`${HOOKS_PATH}/${hook} is tracked without the executable bit: git on Linux would skip it`);
  else ok(`${HOOKS_PATH}/${hook} is tracked and executable`);
}

// The four SHAPES actually observed in `.git/config` on this project - a checkout, a sibling
// worktree, a nested agent worktree, on two drive letters - plus the POSIX and UNC spellings the
// same mistake takes elsewhere. Generic names: the shape is what the check reads, not the machine.
const observed = [
  `D:${BS}work${BS}Canari${BS}.husky/_`,
  `F:${BS}work${BS}wt-feature${BS}.husky/_`,
  `F:${BS}work${BS}Canari${BS}.claude${BS}worktrees${BS}some-branch${BS}.husky/_`,
  `F:${BS}work${BS}wt-other${BS}.husky/_`,
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
// Built by concatenation: it is the installer's literal template text, not a template here.
const hooksPathTemplate = 'git config core.hooksPath $' + '{HOOKS_PATH}';
installer.includes(hooksPathTemplate)
  ? ok('install-husky.js sets core.hooksPath from the declared value')
  : no('install-husky.js no longer sets core.hooksPath itself - husky decides again');
installer.includes('hooksPathProblem(hooksPath)')
  ? ok('install-husky.js asserts the value it read back')
  : no('install-husky.js no longer asserts the value it read back');

// A CHECK THAT INSTALLS LEAVES THE SHARED VALUE ALONE (2026-11-16): the push tier's `bun install`
// sets CANARI_KEEP_HOOKS_PATH=1, and the installer then writes nothing. Run for real in a scratch
// repository, both ways, so the flag is proved to stop the write and its absence to allow it.
const scratch = mkdtempSync(join(tmpdir(), 'canari-hookspath-'));
// No GIT_* from a calling hook: GIT_DIR would point every command below at the REAL repository.
const scratchEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
try {
  const git = (...args) =>
    execFileSync('git', args, { cwd: scratch, env: scratchEnv, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.hooksPath', 'kept-by-a-human');
  const install = (env) =>
    execFileSync(process.execPath, [resolve(repoRoot, 'frontend/scripts/install-husky.js')], {
      cwd: scratch,
      env: { ...scratchEnv, CI: '', ...env },
      encoding: 'utf8',
    });
  install({ CANARI_KEEP_HOOKS_PATH: '1' });
  git('config', 'core.hooksPath') === 'kept-by-a-human'
    ? ok('with CANARI_KEEP_HOOKS_PATH=1 the installer leaves core.hooksPath as it was')
    : no(`with CANARI_KEEP_HOOKS_PATH=1 the installer wrote ${git('config', 'core.hooksPath')}`);
  install({ CANARI_KEEP_HOOKS_PATH: '' });
  git('config', 'core.hooksPath') === HOOKS_PATH
    ? ok(`without it the installer writes ${HOOKS_PATH}`)
    : no(`without the flag the installer left ${git('config', 'core.hooksPath')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const localCi = readFileSync(resolve(repoRoot, '.github/scripts/local-ci.sh'), 'utf8');
localCi.includes('CANARI_KEEP_HOOKS_PATH=1 bash .github/scripts/checks.sh frontend-prepare')
  ? ok("the push tier's install sets CANARI_KEEP_HOOKS_PATH=1")
  : no(
      "the push tier's install no longer sets CANARI_KEEP_HOOKS_PATH=1 - it rewrites the shared config"
    );

console.log(`\n${pass + fail} assertions, ${fail} failed`);
process.exit(fail ? 1 : 0);
