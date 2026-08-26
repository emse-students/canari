import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Working-tree line-ending guardrail.
 *
 * `.gitattributes` mandates `* text=auto eol=lf` - LF in the repository AND at checkout, on every
 * platform, deliberately overriding `core.autocrlf=true` on Windows. Git enforces that on checkout
 * and normalises on commit, so a CRLF file can never reach a commit. What git does NOT catch is a
 * tool that rewrites a file in place with CRLF: the content still normalises to the same blob, so
 * `git status` stays clean and `git diff` shows nothing. The tree is silently out of spec.
 *
 * That silence has a price, measured on 2026-08-26. Roughly twenty-five tests in this suite pin
 * cross-language contracts by reading source files and slicing them with regexes anchored on
 * `\n`; the payload-contract test is the one that broke, with `function end not found:
 * /\n {2}\/\*\*\n {3}\* Records that/` - an anchor that plainly exists in the file it is searching.
 * Nothing in the failure names line endings, and the file it accuses is not the file at fault.
 *
 * Hardening those twenty-five readers would be defending against a state the repository forbids -
 * a fallback path for a primary that is broken elsewhere. So the forbidden state is what fails
 * here instead, by its own name, in one cheap check: `git ls-files --eol` reports git's own
 * resolved attributes alongside what each file actually holds, with no file read at all.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `git ls-files --eol` has to stat and sniff every tracked file - 1966 of them here - so its cost
 * is I/O, not computation: about 290 ms on an idle tree, but it runs inside a 225-file suite that
 * saturates the disk, and there it overran vitest's 5 s default and failed as a TIMEOUT. A guardrail
 * that goes red under load teaches its reader to skip it, and the next real CRLF hides behind that
 * habit. The bound is explicit and roughly 200x the idle cost; it is a limit on a whole-repo git
 * walk, not patience for a slow assertion.
 */
const GIT_LS_FILES_TIMEOUT_MS = 60_000;

describe('working-tree line endings honour .gitattributes', () => {
  it(
    'holds no CRLF outside the files declared eol=crlf',
    () => {
      // Columns: `i/<index-eol> w/<worktree-eol> attr/<resolved attributes> \t <path>`.
      // `w/-text` is a file git detected as binary, `w/none` one with no line endings at all.
      const report = execFileSync('git', ['ls-files', '--eol'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });

      const offenders: string[] = [];
      for (const line of report.split('\n')) {
        if (!line) continue;
        const [columns, path] = line.split('\t');
        if (!path) continue;
        const worktree = columns.split(/\s+/)[1];
        if (worktree !== 'w/crlf' && worktree !== 'w/mixed') continue;
        // A file git itself declares CRLF is the one legitimate case - Windows batch scripts.
        if (/eol=crlf/.test(columns)) continue;
        offenders.push(`${path} (${worktree})`);
      }

      expect(
        offenders,
        'CRLF in the working tree. Git will not show these as modified - the content normalises to ' +
          'the same blob - but tests that slice source by regex fail on them with errors naming the ' +
          'wrong file. Rewrite them with LF; never write a repository file in text mode on Windows.'
      ).toEqual([]);
    },
    GIT_LS_FILES_TIMEOUT_MS
  );
});
