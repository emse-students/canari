/**
 * NO TEST SLEEPS FOR A DURATION (test-suite-reform WP-T6).
 *
 * A `setTimeout(r, 50)` in a test measures the machine: on a loaded runner the thing it waits for
 * has not happened yet, on an idle one the test paid for time it did not need. What a test waits
 * for is an EVENT (`vi.waitFor` on the thing itself), a QUEUE position (`flushMacrotask`), a
 * QUIET (`settleUntilStable`) or a CLOCK (fake timers) - all in `src/test/flush.ts` or vitest.
 *
 * The rule: a test file that names a positive literal delay to `setTimeout` must be a file that
 * fakes timers, where the delay is a simulated latency and not a wait. One case, every offender
 * listed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
const POSITIVE_DELAY = /setTimeout\([^;\n]*,\s*[1-9][\d_]*\s*\)/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('real sleeps in tests', () => {
  it('no file sleeps for a positive literal duration without faking timers', () => {
    const files = testFiles(SRC);
    // The scan is reading the tree it thinks it is.
    expect(files.length).toBeGreaterThan(500);

    const offenders = files
      .filter((file) => file !== import.meta.filename)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return POSITIVE_DELAY.test(source) && !source.includes('useFakeTimers');
      })
      .map((file) => relative(SRC, file).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });
});
