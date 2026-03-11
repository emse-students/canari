#!/usr/bin/env node
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

function tryExec(cmd, options = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', shell: true, ...options });
  } catch (e) {
    // swallow errors to keep prepare script non-failing
  }
}

const gitRoot = findGitRoot(cwd);

if (!gitRoot || process.env.CI === 'true') {
  process.exit(0);
}

const target = join(gitRoot, '.husky');

if (existsSync(binPath)) {
  tryExec(`"${binPath}" "${target}"`, { cwd: gitRoot });
} else {
  tryExec(`npx husky "${target}"`, { cwd: gitRoot });
}
