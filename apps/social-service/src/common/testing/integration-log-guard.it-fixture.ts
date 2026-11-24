import { Logger } from '@nestjs/common';

/**
 * THE LOG GUARD OF AN INTEGRATION SPEC: every WARN and ERROR a test provokes is CAPTURED, and the
 * test FAILS unless it asserted each one with {@link takeLogged}.
 *
 * Noise is never acceptable (CLAUDE.md): a line the CI output carries is either the behaviour a spec
 * is about - then the spec says so, exactly - or the visible end of something upstream. Capturing
 * alone would hide the second kind, so an unasserted line is a FAILURE that prints it, never a
 * silence. A spec that spies on the logger itself keeps doing so: its own spy replaces this one for
 * the lines it takes.
 *
 * Wired through `setupFilesAfterEnv` and selected by file name, like the time budget
 * (`jest-integration-budget.cjs`): the integration specs and `lives/live-seats.spec.ts`, the same
 * set CI's `test-social-integration` job runs.
 */
type Level = 'warn' | 'error';
interface Line {
  readonly level: Level;
  readonly text: string;
  taken: boolean;
}

const LEVELS: readonly Level[] = ['warn', 'error'];
let lines: Line[] = [];

/** True for the specs the guard watches (the file names CI's integration job selects). */
function guarded(testPath: string): boolean {
  // Normalised: a Windows path carries backslashes, and the guard must hold on a developer's box too.
  const path = testPath.split(String.fromCharCode(92)).join('/');
  return path.endsWith('.integration.spec.ts') || path.endsWith('/lives/live-seats.spec.ts');
}

/**
 * Asserts that EXACTLY `count` not-yet-taken lines of `level` match `matcher` (a substring or a
 * pattern), and marks them taken. The line is the behaviour under test: a missing or extra one fails.
 */
export function takeLogged(
  level: Level,
  matcher: string | RegExp,
  count: number | { readonly min: number; readonly max: number } = 1
): void {
  const matches = (text: string): boolean =>
    typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text);
  const found = lines.filter((line) => !line.taken && line.level === level && matches(line.text));
  const { min, max } = typeof count === 'number' ? { min: count, max: count } : count;
  // A RACE decides how many of its contenders lose, so its spec names the bounds instead.
  const wanted = min === max ? min : `${min}..${max}`;
  const within = found.length >= min && found.length <= max;
  if (!within) {
    const open = lines.filter((line) => !line.taken && line.level === level);
    throw new Error(
      `takeLogged: expected ${wanted} ${level} line(s) matching ${String(matcher)}, found ${found.length}.\n` +
        `Untaken ${level} lines:\n${open.map((line) => `  ${JSON.stringify(line.text)}`).join('\n') || '  (none)'}`
    );
  }
  for (const line of found) line.taken = true;
}

/** What each level held before recording: the real method, or a spy the spec installed itself. */
const previous = new Map<Level, (...args: unknown[]) => void>();

/** Starts recording: lines are kept, and handed on ONLY to a spec's own spy, never to the real logger. */
function startRecording(): void {
  lines = [];
  for (const level of LEVELS) {
    const before = Logger.prototype[level] as unknown as (...args: unknown[]) => void;
    previous.set(level, before);
    // Recorded here; handed on ONLY to a spec's own spy (so its `mock.calls` keep counting), never
    // to the real logger, which would print what the spec is about to assert.
    Logger.prototype[level] = function (this: Logger, message: unknown, ...rest: unknown[]) {
      // An Error handed as a context prints its stack: its FIRST line is the fact, the frames are paths.
      const text = [message, ...rest]
        .map((part) => String(part).split(String.fromCharCode(10))[0])
        .join(' ');
      lines.push({ level, text, taken: false });
      if (jest.isMockFunction(before)) before.call(this, message, ...rest);
    } as typeof Logger.prototype.warn;
  }
}

/** Stops recording, and FAILS on every line nobody took: it is printed, never silenced. */
function stopRecording(): void {
  for (const level of LEVELS) {
    Logger.prototype[level] = previous.get(level) as typeof Logger.prototype.warn;
  }
  const left = lines.filter((line) => !line.taken);
  lines = [];
  if (left.length > 0) {
    throw new Error(
      `${left.length} WARN/ERROR line(s) provoked and never asserted - take each with takeLogged():\n` +
        left.map((line) => `  [${line.level}] ${line.text}`).join('\n')
    );
  }
}

/**
 * Runs a `beforeAll` body under the same guard as a test: the per-test hooks do not cover it, so a
 * warning its fixture provokes would print unasserted. `fn` takes its lines with {@link takeLogged}.
 */
export async function whileRecording<T>(fn: () => Promise<T>): Promise<T> {
  startRecording();
  try {
    return await fn();
  } finally {
    stopRecording();
  }
}

if (guarded(expect.getState().testPath ?? '')) {
  beforeEach(startRecording);
  afterEach(stopRecording);
}

/**
 * Takes EVERY untaken `level` line that matches `matcher`, however many a RACE produced (none
 * included): for a spec whose contenders decide which of several known refusals each one meets, so
 * no count is a fact of the code. A line that matches nothing the spec names still fails the test,
 * so this names what may be said, never silences what may not.
 */
export function takeEvery(level: Level, matcher: string | RegExp): void {
  const matches = (text: string): boolean =>
    typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text);
  for (const line of lines) {
    if (!line.taken && line.level === level && matches(line.text)) line.taken = true;
  }
}
