import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards on how `ChatBackgroundService` restarts a community listing that gave up.
 *
 * WHAT BROKE (Mi 9T, `v1.2.7-alpha.1`, 2026-10-14): after an offline start the `online` event's
 * listing failed and gave up, and no second `online` ever came - the phone stayed online - so the
 * community rail stayed empty until the next foreground. The trigger must be the RECONNECT
 * (`connectivity.onReconnect`: `online`, or the server answering again after a transport failure),
 * and the decision - retry, owe it, or decline it past the one retry a give-up earns - belongs to
 * `retryFailedListing`, which `useChannelWorkspaces.svelte.test.ts` drives.
 *
 * A SOURCE GUARD, like `sessionExpiredRelease.test.ts`: the wiring sits in an `onMount` of a
 * component whose harness would fake the store, the session and the DOM, and assert its own mocks.
 */
// From `process.cwd()`, for the reason `sessionExpiredRelease.test.ts` gives.
const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

describe('ChatBackgroundService - the reconnect restarts a listing that gave up', () => {
  it('subscribes to connectivity.onReconnect and hands it to retryFailedListing as a reconnect', () => {
    expect(source).toMatch(/connectivity\.onReconnect\(\(\) => handleReconnect\('reconnect'\)\)/);
    expect(source).toMatch(/globalChannels\.retryFailedListing\(channelsCtx\(\), trigger\)/);
  });

  it('hands the foreground to it as a foreground, the trigger that is never budgeted', () => {
    expect(source).toMatch(/handleReconnect\('foreground'\)/);
  });

  it('unsubscribes on teardown', () => {
    expect(source).toMatch(/const stopReconnect = connectivity\.onReconnect\(/);
    expect(source).toMatch(/\n\s+stopReconnect\(\);/);
  });

  it("no longer restarts the listing from the browser's `online` event alone", () => {
    expect(source).not.toMatch(/online event - retrying community load/);
  });
});
