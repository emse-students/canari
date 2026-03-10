#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const cwd = process.cwd();
const binPath = join(cwd, 'node_modules', '.bin', 'husky');
const target = join(cwd, '.husky');

function tryExec(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
  } catch (e) {
    // swallow errors to keep prepare script non-failing
  }
}

if (existsSync(binPath)) {
  tryExec(`"${binPath}" install "${target}"`);
} else {
  tryExec(`npx husky install "${target}"`);
}
