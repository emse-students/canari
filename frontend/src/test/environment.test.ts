/**
 * A TEST THAT NEEDS A DOM AND DOES NOT ASK FOR ONE FAILS - IT NEVER PASSES ON A DOM IT WAS GIVEN BY
 * ACCIDENT (WP-T4, docs/wiki/test-suite-reform.md).
 *
 * The suite's default environment is `node`. A file that needs a window says so on its FIRST line
 * with vitest's environment pragma (`PRAGMA` below), and nothing else in the configuration names it.
 * This file carries no pragma, so it runs exactly where a newly written DOM test that forgot the line
 * would run - and it pins that such a test goes red with `document is not defined`. Its twin,
 * `environment.dom.test.ts`, pins the other half: the pragma is honoured.
 *
 * Why a source scan as well: vitest takes the FIRST match of the pragma ANYWHERE in a file's text
 * (`detectCodeBlock`), comments and strings included - so a file that merely MENTIONS it would be
 * moved onto happy-dom without a word, which is why this file spells the token in two halves. The
 * scan holds every mention to the one shape that is meant, line 1 exactly, and keeps the pragma the
 * countable record of which files pay for a DOM (`grep -l` gives the next measurement its population).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOKEN = '@vitest' + '-environment';
const PRAGMA = `// ${TOKEN} happy-dom`;
const ANY_TOKEN = new RegExp('@(vitest|jest)' + '-environment');
const SRC = join(import.meta.dirname, '..');

/** Every test file under `src/`, as a `/`-separated path relative to it. */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(test|spec)\.ts$/.test(entry.name) ? [relative(SRC, path).replaceAll('\\', '/')] : [];
  });
}

describe('the default test environment', () => {
  it('builds no window, so a DOM call in a file without the pragma throws', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(() => document.createElement('div')).toThrow(/document is not defined/);
  });

  it('is left only by the exact pragma on line 1', () => {
    const files = testFiles(SRC);
    // Reading the tree it thinks it is: the suite has hundreds of test files, and some declare.
    expect(files.length).toBeGreaterThan(500);
    // Each file read ONCE: two passes over a thousand files outran the budget under a loaded suite.
    const sources = new Map(files.map((file) => [file, readFileSync(join(SRC, file), 'utf8')]));
    const declaring = files.filter((file) => sources.get(file)!.startsWith(PRAGMA));
    expect(declaring.length).toBeGreaterThan(100);
    const misplaced = files.filter((file) => {
      const lines = sources.get(file)!.split('\n');
      return lines.some((line, index) =>
        index === 0 ? ANY_TOKEN.test(line) && line.trimEnd() !== PRAGMA : ANY_TOKEN.test(line)
      );
    });
    expect(misplaced).toEqual([]);
  });
});
