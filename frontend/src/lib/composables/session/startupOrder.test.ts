/**
 * THE SOCKET OPENS BEFORE THE RESTORE, AND THAT ORDER IS THE WHOLE FIX.
 *
 * Measured on production 2026-09-15 from the user's own console: the app announced
 * `Initialised in WEB mode` at 22:24:17 and `[TAB] Leadership acquired (Web Locks)` at 22:24:39.
 * For those twenty-two seconds - the entire archive replay - the client had no socket, and
 * `settleBarrier` may only trust a completed pull while `mailboxEmptiedByAPull && isWsOpen()`. That
 * second half is correct and not the bug: with no socket the server can have queued a row since the
 * pull and nothing would have pushed it. The bug was that there was no socket. Twenty conversations
 * therefore meant twenty HTTP round trips, each answering `[PENDING] No pending MLS messages`.
 *
 * WHY THIS IS A SOURCE TEST, WHICH IS NOT A SHAPE ANYBODY SHOULD COPY. The property is an ORDER
 * between two statements inside `startSession`, a function that takes a live MLS client, a storage
 * backend, a device key and a gateway; there is no seam to observe it through that does not amount
 * to running a whole session. The order is the fix, it is one line's distance from being silently
 * undone by a later edit, and the two phase markers it reads are not decoration - they are the
 * benchmark's own names for these spans, already relied on by `catchupBenchmark`. So a crude test
 * that CAN fail is worth more here than an elegant one that does not exist.
 *
 * The runtime evidence, for a session anybody actually runs, is the benchmark's phase list: the
 * span named `open_gateway` must be closed before `load_conversations` opens.
 */
import { readFileSync } from 'node:fs';

// Repo-relative, like `appIcons.test.ts`: vitest runs from the frontend root.
const source = readFileSync('src/lib/composables/session/sessionAuth.ts', 'utf8');

/** The one occurrence of a phase marker, so a second copy is a failure rather than a coin toss. */
function markerIndex(phase: string): number {
  const needle = `beginStartupCatchupPhase('${phase}')`;
  const first = source.indexOf(needle);
  expect(first, `no beginStartupCatchupPhase('${phase}') in sessionAuth.ts`).toBeGreaterThan(-1);
  expect(
    source.indexOf(needle, first + 1),
    `beginStartupCatchupPhase('${phase}') appears more than once - this test can no longer say which one runs`
  ).toBe(-1);
  return first;
}

describe('the login sequence', () => {
  it('opens the gateway before restoring the conversations', () => {
    expect(markerIndex('open_gateway')).toBeLessThan(markerIndex('load_conversations'));
  });

  it('reconciles the groups AFTER the restore, because that half reads the conversations', () => {
    // `syncConnectionAfterWsOpen` publishes KeyPackages, sweeps the server's group list and
    // reconciles history - all of it against the conversations this device holds. Only the socket
    // moved up; moving this with it would have it reason about an empty map.
    expect(markerIndex('load_conversations')).toBeLessThan(markerIndex('initialize_connection'));
  });

  it('takes tab leadership before it tries to open anything', () => {
    // Only the leader tab holds a socket, and `openGatewayConnection` asks `getIsTabLeader()` -
    // which answers `false` until `initTabLeadershipAsync` has resolved.
    const leadership = source.indexOf('await initTabLeadershipAsync(');
    expect(leadership).toBeGreaterThan(-1);
    expect(leadership).toBeLessThan(source.indexOf('await openGatewayConnection('));
  });
});
