/**
 * NO TEST SLEEPS FOR A DURATION (test-suite-reform WP-T6).
 *
 * A `setTimeout(r, 50)` in a test measures the machine: on a loaded runner the thing it waits for
 * has not happened yet, on an idle one the test paid for time it did not need. What a test waits
 * for is an EVENT (`vi.waitFor` on the thing itself), a QUEUE position (`flushMacrotask`), a
 * QUIET (`settleUntilStable`) or a CLOCK (fake timers) - all in `src/test/flush.ts` or vitest.
 *
 * The rule: a test file whose `setTimeout` is given a delay other than a literal `0` - a number,
 * a variable, an object field, an expression, on one line or several - must be a file that REALLY
 * calls `vi.useFakeTimers(`, where the delay is a simulated latency and not a wait. A comment that
 * names `useFakeTimers` exempts nothing. One case, every offender listed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
const FAKE_TIMERS_CALL = /\bvi\.useFakeTimers\(/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The source with every comment blanked (length and newlines kept). String literals are skipped
 * whole so a `//` inside a URL is not read as a comment; a regex literal containing a quote is
 * the one shape this does not model.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The text of the last top-level argument of every `setTimeout(` call (null when it has one). */
export function setTimeoutDelays(code: string): (string | null)[] {
  const delays: (string | null)[] = [];
  for (const match of code.matchAll(/\bsetTimeout\s*\(/g)) {
    let depth = 1;
    let lastComma = -1;
    let i = match.index + match[0].length;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') {
        i++;
        while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      } else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 1) lastComma = i;
    }
    const tail = lastComma === -1 ? null : code.slice(lastComma + 1, i - 1).trim();
    delays.push(tail === '' ? null : tail);
  }
  return delays;
}

/** A delay that is not the literal 0 (or absent) is a duration somebody waits for. */
export function sleepsForADuration(source: string): boolean {
  return setTimeoutDelays(stripComments(source)).some((d) => d !== null && !/^0+$/.test(d));
}

describe('real sleeps in tests', () => {
  it('no file gives setTimeout a non-zero delay without really faking timers', () => {
    const files = testFiles(SRC);
    // The scan is reading the tree it thinks it is.
    expect(files.length).toBeGreaterThan(500);

    const offenders = files
      .filter((file) => file !== import.meta.filename)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return sleepsForADuration(source) && !FAKE_TIMERS_CALL.test(stripComments(source));
      })
      .map((file) => relative(SRC, file).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });

  it('sees the delay shapes a one-line literal regex missed', () => {
    expect(sleepsForADuration('setTimeout(answer, p.delayMs ?? 0);')).toBe(true);
    expect(sleepsForADuration('setTimeout(r, ms)')).toBe(true);
    expect(sleepsForADuration('setTimeout(() => {\n  go();\n}, 250)')).toBe(true);
    expect(sleepsForADuration('setTimeout(r, 50)')).toBe(true);
    expect(sleepsForADuration('setTimeout(r, 0)')).toBe(false);
    expect(sleepsForADuration('setTimeout(r)')).toBe(false);
    expect(sleepsForADuration('setTimeout(() => f(1, 2), 0)')).toBe(false);
    expect(sleepsForADuration('// setTimeout(r, 50)\nconst u = "a//b"; setTimeout(r, 0)')).toBe(
      false
    );
  });

  it('is not exempted by a comment naming fake timers', () => {
    const commented = '// vi.useFakeTimers() is not used here\nsetTimeout(r, 50)';
    expect(FAKE_TIMERS_CALL.test(stripComments(commented))).toBe(false);
    expect(FAKE_TIMERS_CALL.test(stripComments('vi.useFakeTimers();'))).toBe(true);
  });
});
