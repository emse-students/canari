#!/usr/bin/env node
/**
 * Points git at the repository-root `.husky/` directory after an install.
 *
 * Run from `frontend`, but the hooks belong to the WHOLE monorepo: the root
 * `.husky/pre-commit` decides per-area what to gate. This script therefore walks up to the git
 * root and installs there, never into `frontend/`.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

const cwd = process.cwd();
const binDir = join(cwd, 'node_modules', '.bin');

// WINDOWS DOES NOT PUT A BARE `husky` IN `.bin`, AND THIS ONLY EVER LOOKED FOR THAT ONE NAME.
// bun and npm write `husky.exe` / `husky.cmd` / `husky.bunx` there instead, so on every Windows
// install the check below was false, the warning fired, the script exited 0 - and the repository
// was left with NO git hooks while `bun install` reported success. Measured on this workstation,
// 2026-09-07: `.bin` held `husky.exe` and `husky.bunx`, while this file looked for a name that
// is never written there and reported it missing. The hooks happened to be armed from an earlier
// install, which is exactly why nobody noticed: a fresh clone gets none, and is told so in one
// line that scrolls past an install.
const binPath = ['husky', 'husky.exe', 'husky.cmd', 'husky.bunx']
  .map((name) => join(binDir, name))
  .find((candidate) => existsSync(candidate));

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

const target = join(gitRoot, '.husky');

// Not an error worth failing an install over: `bun install --production` legitimately leaves the
// binary out. But it MUST say so - a hook silently not installed is a gate silently not running,
// and this branch used to be an empty catch that left no trace at all.
if (!binPath) {
  console.warn(
    `[install-husky] no husky binary in ${binDir} - git hooks were NOT installed. ` +
      `Run 'bun install' with dev dependencies from 'frontend' to arm them.`
  );
  process.exit(0);
}

try {
  execSync(`"${binPath}" "${target}"`, { stdio: 'inherit', shell: true, cwd: gitRoot });
} catch (error) {
  console.warn(
    `[install-husky] husky failed to install hooks into ${target} - git hooks are NOT armed: ${error.message}`
  );
  process.exit(0);
}

// THE POST-CONDITION, ASSERTED. `husky` can exit 0 having done nothing useful, and what this script
// is actually for is one git setting - so it reads that setting back rather than trusting the exit
// code. A hook that is not armed is a gate that is not running, and it says nothing on its own.
try {
  const hooksPath = execSync('git config core.hooksPath', {
    cwd: gitRoot,
    encoding: 'utf8',
  }).trim();
  if (!hooksPath) throw new Error('core.hooksPath is empty');
  console.log(`[install-husky] git hooks armed - core.hooksPath = ${hooksPath}`);
} catch {
  console.warn(
    `[install-husky] husky exited 0 but core.hooksPath is not set in ${gitRoot} - the hooks are ` +
      `NOT armed, and nothing will run on commit.`
  );
}
