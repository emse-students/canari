import { format } from 'node:util';
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
 * Three entry points are recorded: an instance (`new Logger(X).warn`), the STATIC one
 * (`Logger.error`, Nest's staticInstanceRef) and the console a service may write to directly.
 *
 * WHAT IT DOES NOT SEE: module load, `beforeAll` (unless wrapped in {@link whileRecording}),
 * `afterAll`, the gaps between tests, and async work that outlives its test (a line logged after
 * `afterEach` ran is recorded by nobody). Those paths keep printing to the real logger.
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
/** True between {@link startRecording} and {@link stopRecording}. */
let recording = false;

/** True for the specs the guard watches (the file names CI's integration job selects). */
function guarded(testPath: string): boolean {
  // Normalised: a Windows path carries backslashes, and the guard must hold on a developer's box too.
  const path = testPath.split(String.fromCharCode(92)).join('/');
  return path.endsWith('.integration.spec.ts') || path.endsWith('/lives/live-seats.spec.ts');
}

/** True when `text` is what `matcher` names: a string is the WHOLE message, a pattern anchors itself. */
function matchesLine(matcher: string | RegExp, text: string): boolean {
  return typeof matcher === 'string' ? text === matcher : matcher.test(text);
}

/**
 * Asserts that EXACTLY `count` not-yet-taken lines of `level` match `matcher` (a string is the
 * WHOLE message, a pattern anchors itself with `^` and `$`), and marks them taken. The line is the
 * behaviour under test: a missing or extra one fails.
 */
export function takeLogged(
  level: Level,
  matcher: string | RegExp,
  count: number | { readonly min: number; readonly max: number } = 1
): void {
  const found = lines.filter(
    (line) => !line.taken && line.level === level && matchesLine(matcher, line.text)
  );
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

type Writer = (...args: unknown[]) => void;

/** One patched logging entry point: where it lives, and what it held before recording. */
interface Target {
  readonly owner: Record<string, unknown>;
  readonly level: Level;
  /** How the arguments of this entry point become the one line recorded. */
  readonly render: (args: unknown[]) => string;
  before?: Writer;
}

/** One part of a Nest log call as text: an Error is its `name: message`, a stack only its first line. */
function partText(part: unknown): string {
  try {
    if (part instanceof Error) return `${part.name}: ${part.message}`;
    const text = String(part);
    // A stack handed as `trace` prints its frames, which are paths: its FIRST line is the fact.
    return text.includes('\n    at ') ? text.split('\n')[0] : text;
  } catch {
    return Object.prototype.toString.call(part);
  }
}

/** A Nest call is `(message, ...context)`: the message stays WHOLE (a multi-line one included). */
const renderNest = (args: unknown[]): string => args.map(partText).join(' ');

/** A `console.warn/error` call, formatted the way the console would print it. */
const renderConsole = (args: unknown[]): string => format(...args);

const targets: Target[] = [];
for (const level of LEVELS) {
  targets.push({ owner: Logger.prototype as never, level, render: renderNest });
  targets.push({ owner: Logger as never, level, render: renderNest });
  targets.push({ owner: console as never, level, render: renderConsole });
}

/** Starts recording: lines are kept, and handed on ONLY to a spec's own spy, never to the real logger. */
function startRecording(): void {
  // A nested start would save the RECORDER as `before`, and the real logger would never come back.
  if (recording)
    throw new Error('integration-log-guard: already recording (a nested whileRecording?)');
  recording = true;
  lines = [];
  for (const target of targets) {
    const before = target.owner[target.level] as Writer;
    target.before = before;
    // Recorded here; handed on ONLY to a spec's own spy (so its `mock.calls` keep counting), never
    // to the real logger, which would print what the spec is about to assert.
    target.owner[target.level] = function (this: unknown, ...args: unknown[]) {
      lines.push({ level: target.level, text: target.render(args), taken: false });
      if (jest.isMockFunction(before)) before.apply(this, args);
    };
  }
}

/** Stops recording, and FAILS on every line nobody took: it is printed, never silenced. */
function stopRecording(): void {
  recording = false;
  for (const target of targets) target.owner[target.level] = target.before;
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
 * so this names what may be said, never silences what may not. NEVER use it in a deterministic
 * test: there the count is a fact, and {@link takeLogged} asserts it.
 */
export function takeEvery(level: Level, matcher: string | RegExp): void {
  for (const line of lines) {
    if (!line.taken && line.level === level && matchesLine(matcher, line.text)) line.taken = true;
  }
}
