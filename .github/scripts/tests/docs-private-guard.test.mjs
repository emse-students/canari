#!/usr/bin/env node
/**
 * THE REPOSITORY IS PUBLIC, SO A TRACKED MARKDOWN FILE MUST NOT CARRY A PRIVATE ADDRESS OR AN SSH
 * ALIAS (decided 2026-10-17: what helps an attacker lives in the private notes, outside the repo).
 *
 * It reads every tracked `*.md` and fails on a private-range address (10.x.x.x), a school-range
 * public address (193.49.x.x) or an `ssh <alias>` / bare alias naming one of the project's boxes.
 * The patterns are proved first against positive and negative samples, so a silently broken regex
 * cannot turn this into a gate that passes on everything.
 *
 * `PENDING_CLEANUP` lists the files another documentation pass has not cleaned yet. It is a
 * work list and NOT a licence: a file leaves it in the pull request that cleans it, and a new file
 * never joins it. An entry whose file no longer exists fails, so the list cannot rot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

export const PATTERNS = [
  ['private address', /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['school public address', /\b193\.49\.\d{1,3}(?:\.\d{1,3})?\b/],
  ['ssh alias', /\bssh\s+(?:canari|mitv|cercle|miconnect|portail-etu-direct)\b/],
  ['ssh alias', /\bportail-etu-direct\b/],
];

/** Returns the label of every pattern that matches `text`. */
export function violations(text) {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

const PENDING_CLEANUP = new Set([
  'docs/PROD-TEST-CERCLE.md',
  'docs/user-guide/workflow-developpement.md',
  'docs/wiki/backlog.md',
  'docs/wiki/cotisations.md',
  'docs/wiki/device-verification.md',
  'docs/wiki/durable-rules.md',
  'docs/wiki/ecosystem-convergence.md',
  'docs/wiki/frontend/offline-and-weak-network.md',
  'docs/wiki/profiles-and-access.md',
  'docs/wiki/testing-methodology.md',
  'docs/wiki/workflow-migration.md',
]);

let failed = 0;
const fail = (msg) => {
  failed += 1;
  console.error(`FAIL ${msg}`);
};

for (const sample of ['host 10.0.0.4', 'at 193.49.12.7', 'run ssh canari now', 'ssh portail-etu-direct']) {
  if (violations(sample).length === 0) fail(`pattern missed a violation: ${sample}`);
}
for (const sample of ['version 1.10.0.4x', 'ssh-keygen', 'the canari host', 'port 3010', 'ssh keys']) {
  if (violations(sample).length > 0) fail(`pattern flagged a clean sample: ${sample}`);
}

const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
for (const entry of PENDING_CLEANUP) {
  if (!existsSync(join(ROOT, entry))) fail(`PENDING_CLEANUP names a missing file: ${entry}`);
}
for (const file of files) {
  if (PENDING_CLEANUP.has(file)) continue;
  const found = violations(readFileSync(join(ROOT, file), 'utf8'));
  if (found.length > 0) fail(`${file}: ${[...new Set(found)].join(', ')} (move it to the private notes)`);
}

if (failed > 0) process.exit(1);
console.log(`docs-private-guard: ${files.length} tracked markdown files, ${PENDING_CLEANUP.size} pending cleanup`);
