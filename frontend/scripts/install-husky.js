#!/usr/bin/env node
/**
 * Points git at the repository-root `.husky/` directory, the tracked hooks, after an install.
 *
 * Run from `frontend`, but the hooks belong to the WHOLE monorepo: the root
 * `.husky/pre-commit` decides per-area what to gate. This script therefore walks up to the git
 * root and installs there, never into `frontend/`.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { HOOKS_PATH, hooksPathProblem } from './hooks-path.js';

const cwd = process.cwd();

function findGitRoot(startDir) {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

const gitRoot = findGitRoot(cwd);

if (!gitRoot || process.env.CI === 'true') {
  process.exit(0);
}

// A CHECK THAT INSTALLS NEVER WRITES THE SHARED CONFIG (2026-11-16). The push tier runs
// `bun install` (`checks.sh frontend-prepare`), and every worktree shares `core.hooksPath`: the
// value belongs to the checkout a HUMAN installed in, so the push tier sets this and nothing is
// written - rather than writing and restoring, which leaves a window where every other checkout
// reads the push's value.
if (process.env.CANARI_KEEP_HOOKS_PATH === '1') {
  console.log(
    '[install-husky] CANARI_KEEP_HOOKS_PATH=1 (a check is installing): core.hooksPath left as it is'
  );
  process.exit(0);
}

// NO HUSKY BINARY IS RUN ANY MORE (2026-11-15). The hooks are the TRACKED files in `.husky/`,
// and git is pointed at them directly: husky's generated `.husky/_` wrappers existed only after an
// install, so a fresh worktree had none and git skipped every hook in silence. What husky did
// beyond that one setting - a PATH entry for a root `node_modules` this repository does not have,
// and the `HUSKY=0` switch that turned every hook off - is not wanted.
// THE SETTING IS THIS SCRIPT'S JOB, NOT A SIDE EFFECT OF THE ARGUMENT HUSKY WAS HANDED.
// husky writes whatever path it is given, and `findGitRoot` reaches a WORKTREE root - a worktree's
// `.git` is a FILE, and `existsSync` is true for a file - so husky was handed that worktree's
// absolute path. Since `core.hooksPath` lives in the shared git directory, one `bun install` inside
// a worktree then disarmed the main checkout and every other worktree. Measured four times on this
// workstation, most recently 2026-09-24, each time found by accident. The value is therefore
// written here, where the reason for it is, rather than inferred from husky's argument.
try {
  execSync(`git config core.hooksPath ${HOOKS_PATH}`, { cwd: gitRoot, stdio: 'pipe' });
} catch (error) {
  console.warn(`[install-husky] could not set core.hooksPath in ${gitRoot}: ${error.message}`);
}

// THE POST-CONDITION, ASSERTED. `husky` can exit 0 having done nothing useful, and what this script
// is actually for is one git setting - so it reads that setting back rather than trusting the exit
// code. A hook that is not armed is a gate that is not running, and it says nothing on its own.
//
// AND "NON-EMPTY" IS NOT THE POST-CONDITION. It was, and an absolute path satisfies it while
// disarming every other checkout - which is how this went unnoticed four times. `hooksPathProblem`
// carries what actually has to hold.
try {
  const hooksPath = execSync('git config core.hooksPath', {
    cwd: gitRoot,
    encoding: 'utf8',
  }).trim();
  const problem = hooksPathProblem(hooksPath);
  if (problem) throw new Error(problem);
  console.log(`[install-husky] git hooks armed - core.hooksPath = ${hooksPath}`);
} catch (error) {
  console.warn(
    `[install-husky] hooks are NOT reliably armed in ${gitRoot}: ${error.message}. Nothing will ` +
      `run on commit, and git reports that as silence.`
  );
}
