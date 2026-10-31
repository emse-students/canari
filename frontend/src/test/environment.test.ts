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
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './sourceTree';

const TOKEN = '@vitest' + '-environment';
const PRAGMA = `// ${TOKEN} happy-dom`;
const ANY_TOKEN = new RegExp('@(vitest|jest)' + '-environment');

/**
 * Every test file under `src/`, from the run's shared snapshot: walking and reading ~1,200 files
 * inside the test timed out at 5 s under load (2026-10-30), the cost `sourceTreeSetup.ts` pays
 * once per run for every other scan.
 */
const testFiles = () => sourceFiles({ under: 'src', extensions: ['ts'], tests: 'only' });

describe('the default test environment', () => {
  it('builds no window, so a DOM call in a file without the pragma throws', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(() => document.createElement('div')).toThrow(/document is not defined/);
  });

  it('is left only by the exact pragma on line 1', () => {
    const files = testFiles();
    // Reading the tree it thinks it is: the suite has hundreds of test files, and some declare.
    expect(files.length).toBeGreaterThan(500);
    const declaring = files.filter((file) => file.text.startsWith(PRAGMA));
    expect(declaring.length).toBeGreaterThan(100);
    const misplaced = files.filter((file) => {
      const lines = file.text.split('\n');
      return lines.some((line, index) =>
        index === 0 ? ANY_TOKEN.test(line) && line.trimEnd() !== PRAGMA : ANY_TOKEN.test(line)
      );
    });
    expect(misplaced.map((file) => file.path)).toEqual([]);
  });
});
