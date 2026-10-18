#!/usr/bin/env bun
/**
 * WORKING-TREE LINE ENDINGS HONOUR `.gitattributes`.
 *
 * `.gitattributes` mandates `* text=auto eol=lf` - LF in the repository AND at checkout, on every
 * platform. Git normalises on commit, so a CRLF file can never reach a commit. What git does NOT
 * catch is a tool that rewrites a file in place with CRLF: the content normalises to the same blob,
 * so `git status` stays clean and `git diff` shows nothing, and the tree is silently out of spec.
 * The price was measured on 2026-08-26: about twenty-five tests that slice source by regex anchored
 * on a newline failed with errors naming the wrong file. So the forbidden state fails here, by its
 * own name, off `git ls-files --eol` (git's resolved attributes beside what each file holds).
 *
 * It lives in `test-ci-scripts` and not the frontend suite (WP-T2, docs/wiki/test-suite-reform.md):
 * it reads the whole repository, and the frontend job is skipped on a change that touches none of
 * `frontend/`. The CI checkout is LF by construction, so it guards a developer's working tree and
 * the files a scripted edit rewrites.
 *
 * Usage: bun .github/scripts/tests/line-endings.test.mjs [repoRoot]
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

// Columns: `i/<index-eol> w/<worktree-eol> attr/<resolved attributes> \t <path>`.
// `w/-text` is a file git detected as binary, `w/none` one with no line endings at all.
const report = execFileSync('git', ['-C', ROOT, 'ls-files', '--eol'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

let scanned = 0;
const offenders = [];
for (const line of report.split('\n')) {
  if (!line) continue;
  const [columns, path] = line.split('\t');
  if (!path) continue;
  scanned += 1;
  const worktree = columns.split(/\s+/)[1];
  if (worktree !== 'w/crlf' && worktree !== 'w/mixed') continue;
  // A file git itself declares CRLF is the one legitimate case - Windows batch scripts.
  if (/eol=crlf/.test(columns)) continue;
  offenders.push(`${path} (${worktree})`);
}

if (scanned < 500) {
  console.log(`FAIL read only ${scanned} tracked file(s) - the listing is wrong, not the tree`);
  process.exit(1);
}
if (offenders.length > 0) {
  console.log('FAIL CRLF in the working tree. Git will not show these as modified - the content');
  console.log('normalises to the same blob - but tests that slice source by regex fail on them with');
  console.log('errors naming the wrong file. Rewrite them with LF; never write a repository file in');
  console.log('text mode on Windows.');
  for (const o of offenders) console.log(`  ${o}`);
  process.exit(1);
}
console.log(`ok   ${scanned} tracked file(s), none holds CRLF outside the eol=crlf declarations`);
