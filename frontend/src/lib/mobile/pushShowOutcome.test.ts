import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EVERY END OF THE SHOW DECISION SAYS WHICH ONE IT WAS, IN THE IN-APP LOG (2026-11-20).
 *
 * `showMessageNotification` can take a message and draw nothing, by design or because the OS drops
 * what it posts; each case was a logcat `Log.d`, so a member's exported log could not tell them
 * apart. Each return now records ONE `[PUSH_SHOW]` line (`PushShowOutcome.kt`, the JVM test
 * `PushShowOutcomeTest` pins its wording and level). This pins the wiring: a new early return that
 * forgets the line - the silence this closed - fails here. See `docs/wiki/frontend/mobile.md`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const service = readFileSync(resolve(ANDROID, 'CanariFirebaseMessagingService.kt'), 'utf8');
const nativeLog = readFileSync(resolve(ANDROID, 'NativePushLog.kt'), 'utf8');

/** The body of the function whose declaration is `header`, braces matched from its first `{`. */
function bodyOf(source: string, header: string): string {
  const at = source.indexOf(header);
  expect(at, `${header} not found`).toBeGreaterThanOrEqual(0);
  // The body opens at the `{` ending the signature (`): Long {`), not at a default value's braces.
  const open = source.indexOf(': Long {', at) + ': Long '.length;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${header}: unbalanced braces`);
}

const body = bodyOf(service, 'internal fun Context.showMessageNotification(');
const lines = body.split('\n').map((l) => l.trim());

describe('showMessageNotification records exactly one outcome per decision', () => {
  it('has the returns this pin was written against', () => {
    // A plain `return` of the function itself; a labelled `return@` would leave a lambda only.
    const returns = lines.filter((l) => /^return\b(?!@)/.test(l));
    expect(returns).toEqual(['return 0L', 'return 0L', 'return 0L', 'return stamp']);
  });

  it('every return is preceded by its own record, and nothing else records', () => {
    const records = lines.filter((l) => l.startsWith('recordShowOutcome('));
    expect(records).toHaveLength(4);
    lines.forEach((l, i) => {
      if (!/^return\b(?!@)/.test(l)) return;
      // The statement just before the return, comments aside, is the record: on one line, or
      // opened by `recordShowOutcome(` and closed by a lone `)` with no block in between.
      const before = lines.slice(0, i).filter((p) => p !== '' && !p.startsWith('//'));
      const last = before[before.length - 1];
      if (last.startsWith('recordShowOutcome(')) return;
      expect(last, `no record before "${l}"`).toBe(')');
      const recordAt = before.findLastIndex((p) => p.startsWith('recordShowOutcome('));
      expect(recordAt, `no record before "${l}"`).toBeGreaterThanOrEqual(0);
      expect(before.slice(recordAt + 1, -1).some((p) => /[{}]/.test(p))).toBe(false);
    });
  });

  it('each early return records its own suppression, the post records the derived outcome', () => {
    for (const outcome of [
      'SUPPRESSED_FOREGROUND',
      'SUPPRESSED_SHADE_MARK',
      'SUPPRESSED_ALREADY_ALERTED',
    ]) {
      expect(body).toContain(
        `recordShowOutcome(PushShowOutcome.Outcome.${outcome}, groupId, channel)`
      );
    }
    expect(body).toMatch(
      /recordShowOutcome\(\s*PushShowOutcome\.posted\(alreadyPosted, supersedes != 0L, callHolds\)/
    );
    // After the post, not before it: a builder that threw must not have recorded a post.
    expect(body.indexOf('PushShowOutcome.posted(')).toBeGreaterThan(
      body.indexOf('manager.notify(notifId, notif)')
    );
  });

  it('the line is a recorded INFO by design and a WARN when the OS drops a post - never a plain Log.i', () => {
    expect(service).toContain(
      "if (PushShowOutcome.level(outcome, os) == 'W') Log.w(TAG, line) else Log.iRecorded(TAG, line) // log-safe:"
    );
    // The deliberate path passes the level gate on purpose, and only it does.
    expect(nativeLog).toMatch(
      /fun iRecorded\(tag: String, msg: String\): Int \{\s*NativePushLog\.recordInfo\(tag, msg\)/
    );
    expect(nativeLog).toMatch(/fun i\(tag: String, msg: String\): Int = Log\.i\(tag, msg\)/);
  });
});
