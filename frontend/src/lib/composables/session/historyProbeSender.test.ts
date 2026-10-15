/**
 * THE PROBE THE SESSION REGISTERS IS `sendHistoryProbe`, NOT `sendHistoryStateKey`.
 *
 * `sendHistoryProbe` opens with the digest when this device holds nothing for the group, which is
 * every group right after a sign-in: one round trip per rejoin instead of two, and one drain and
 * checkpoint fewer (Mi 9T, 2026-10-13: ~4 checkpoints per rejoined group, 247 in 432 s). Its own
 * behaviour is pinned in `groupActions.historyProbe.test.ts`; this pins that the session USES it.
 * Wiring `sendHistoryStateKey` back in would compile, pass every other test and silently restore
 * the extra leg.
 *
 * A SOURCE TEST, for the reason `startupOrder.test.ts` gives: the registration sits inside
 * `loginImpl`, which needs a live MLS client, a store and a gateway to run, and the property is
 * which of two same-typed functions one line names.
 */
import { readFileSync } from 'node:fs';

// Repo-relative, like `startupOrder.test.ts`: vitest runs from the frontend root.
const source = readFileSync('src/lib/composables/session/sessionAuth.ts', 'utf8');

/** The body of the one non-null `setHistoryProbeSender(...)` registration. */
function registration(): string {
  const start = source.indexOf('setHistoryProbeSender(async');
  expect(
    start,
    'no setHistoryProbeSender(async ...) registration in sessionAuth.ts'
  ).toBeGreaterThan(-1);
  expect(
    source.indexOf('setHistoryProbeSender(async', start + 1),
    'more than one registration - this test can no longer say which one runs'
  ).toBe(-1);
  const end = source.indexOf('});', start);
  return source.slice(start, end);
}

describe('the history probe the session registers', () => {
  it('is sendHistoryProbe, which sends the digest first from an empty store', () => {
    expect(registration()).toContain('sendHistoryProbe(');
  });

  it('never names sendHistoryStateKey, which would restore the extra round trip', () => {
    expect(registration()).not.toContain('sendHistoryStateKey');
    expect(source).not.toMatch(/\bsendHistoryStateKey\b/);
  });
});
