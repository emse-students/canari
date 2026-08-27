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
const binPath = join(cwd, 'node_modules', '.bin', 'husky');

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
if (!existsSync(binPath)) {
  console.warn(
    `[install-husky] husky is not in ${binPath} - git hooks were NOT installed. ` +
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
}
