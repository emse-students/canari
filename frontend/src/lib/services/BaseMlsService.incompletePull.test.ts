/**
 * A PULL THAT ENDS INCOMPLETE SETTLES THE DRAIN WAITS IT WAS OWED, TYPED - THE FAILED PULL IS THE PROOF.
 *
 * `pullPendingMessagesJson` throws `PendingPullIncompleteError` on a non-2xx page and
 * `PendingPageNeverArrivedError` when the page-halving ladder runs out at one row. The mailbox is then
 * NOT known empty, so nothing may read it as drained - and nothing may be left waiting for whatever
 * pull happens to come next either: on a quiet account whose history service answers 502 while the
 * gateway stays up, none may come for hours. So the failed pull settles every `whenGroupDrained`
 * waiter and the initial drain with `MailboxListingIncompleteError`, and each caller decides what an
 * unknown mailbox means for it. A wait registered after that is settled by the NEXT pull's end; a
 * live frame on the open link is one more trigger for that pull. No clock anywhere: the sequence is
 * decided by the test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import {
  PendingPageNeverArrivedError,
  PendingPullIncompleteError,
} from '$lib/mls-client/mlsDeliveryApi';
import { MailboxListingIncompleteError } from '$lib/mls-client/IMlsService';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { TransportFailureError } from '$lib/utils/transportFailure';
import type { MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    fetchPendingMessages(): Promise<void>;
    enqueueMessage(msg: MlsQueuedMessage, channel: 'live'): void;
    mailboxEmptiedByAPull: boolean;
    pullIncompleteOwed: boolean;
  };

const liveFrame = (): MlsQueuedMessage => ({
  senderId: 'bob',
  ciphertext: new Uint8Array([1]),
  groupId: 'g-1',
  isWelcome: false,
  isCommit: false,
  queuedMessageId: 'q-1',
});

/** What a wait came to, read without awaiting it. */
type Outcome = { state: 'pending' } | { state: 'resolved' } | { state: 'rejected'; error: unknown };

function watch(p: Promise<unknown>): { now: () => Outcome } {
  let outcome: Outcome = { state: 'pending' };
  p.then(
    () => (outcome = { state: 'resolved' }),
    (error: unknown) => (outcome = { state: 'rejected', error })
  );
  return { now: () => outcome };
}

describe('a pull that ends incomplete', () => {
  let svc: BaseMlsService;
  let pull: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  function wire(firstEnd: Error): void {
    pull = vi.fn().mockRejectedValueOnce(firstEnd).mockResolvedValue([]);
    Object.assign(svc, {
      userId: 'user-a',
      deviceId: 'dev-a',
      isWsOpen: () => true,
      processQueue: vi.fn(),
      getEpoch: () => 5,
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: pull,
      },
      messageScheduler: {
        enqueue: vi.fn(),
        draining: false,
        hasQueuedFrom: () => false,
        isGroupIdle: () => true,
        waitUntilIdle: async () => undefined,
      },
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    svc = makeService();
  });

  it('on a refused page, settles every drain waiter and the initial drain as incomplete, typed', async () => {
    const refused = new PendingPullIncompleteError(502, 'gateway');
    wire(refused);
    const initial = watch(svc.whenInitialDrainSettled());
    const group = watch(svc.whenGroupDrained('g-1'));

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(group.now().state).toBe('rejected'));
    await vi.waitFor(() => expect(initial.now().state).toBe('rejected'));

    const groupEnd = group.now() as { error: unknown };
    expect(groupEnd.error).toBeInstanceOf(MailboxListingIncompleteError);
    expect((groupEnd.error as MailboxListingIncompleteError).groupId).toBe('g-1');
    expect((groupEnd.error as MailboxListingIncompleteError).endedBy).toBe(refused);
    const initialEnd = initial.now() as { error: unknown };
    expect(initialEnd.error).toBeInstanceOf(MailboxListingIncompleteError);
    expect((initialEnd.error as MailboxListingIncompleteError).groupId).toBeNull();

    // Never read as a drained mailbox, and the retry on the next live frame is armed.
    expect(inner(svc).mailboxEmptiedByAPull).toBe(false);
    expect(inner(svc).pullIncompleteOwed).toBe(true);
    // Said once, as a failure the device did not cause, and the settlement said with it.
    expect(warn.mock.calls.flat().join(' ')).toContain('Pending fetch stopped by a 502');
    expect(warn.mock.calls.flat().join(' ')).toContain('1 drain waiter(s) and the initial drain');
  });

  it('on a ladder run out at one row, settles them the same way - and accuses', async () => {
    wire(new PendingPageNeverArrivedError(new Error('no response head')));
    const initial = watch(svc.whenInitialDrainSettled());
    const group = watch(svc.whenGroupDrained('g-1'));

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(group.now().state).toBe('rejected'));
    await vi.waitFor(() => expect(initial.now().state).toBe('rejected'));

    expect((group.now() as { error: unknown }).error).toBeInstanceOf(MailboxListingIncompleteError);
    expect((initial.now() as { error: unknown }).error).toBeInstanceOf(
      MailboxListingIncompleteError
    );
    expect(inner(svc).mailboxEmptiedByAPull).toBe(false);
    expect(inner(svc).pullIncompleteOwed).toBe(true);
    expect(error.mock.calls.flat().join(' ')).toContain('a page of ONE row never arrived');
  });

  // EVERY ENDING THAT DID NOT EMPTY THE MAILBOX settles the waits - not only the two typed by the
  // delivery API. Each of these used to leave them pending while the socket stayed up.
  it.each([
    [
      'a deadline (a token renewal past its own)',
      () => new RequestDeadlineError('read', 15_000, 'POST', '/api/auth/refresh', 0),
      'warn',
    ],
    [
      'a transport failure while the gateway socket stays open',
      () => new TransportFailureError(new TypeError('Failed to fetch')),
      'warn',
    ],
    ['an unclassified throw', () => new Error('something nobody typed'), 'error'],
  ] as const)(
    'on %s, settles the drain waiters and the initial drain as incomplete',
    async (_label, ending, level) => {
      const endedBy = ending();
      wire(endedBy);
      const initial = watch(svc.whenInitialDrainSettled());
      const group = watch(svc.whenGroupDrained('g-1'));

      await inner(svc).fetchPendingMessages();
      await vi.waitFor(() => expect(group.now().state).toBe('rejected'));
      await vi.waitFor(() => expect(initial.now().state).toBe('rejected'));

      const groupEnd = (group.now() as { error: unknown }).error;
      expect(groupEnd).toBeInstanceOf(MailboxListingIncompleteError);
      expect((groupEnd as MailboxListingIncompleteError).endedBy).toBe(endedBy);
      expect((initial.now() as { error: unknown }).error).toBeInstanceOf(
        MailboxListingIncompleteError
      );
      expect(inner(svc).mailboxEmptiedByAPull).toBe(false);
      expect(inner(svc).pullIncompleteOwed).toBe(true);
      // The failure keeps its own level: an unclassified throw accuses.
      const spy = level === 'error' ? error : warn;
      expect(spy.mock.calls.flat().join(' ')).toContain('Pending fetch');

      // And the next complete pull releases what waits again.
      const again = watch(svc.whenGroupDrained('g-1'));
      await inner(svc).fetchPendingMessages();
      await vi.waitFor(() => expect(again.now().state).toBe('resolved'));
    }
  );

  it('a revoked device settles nothing: its backlog is deleted and the service wiped next', async () => {
    const { SessionEndedByDeviceRevocationError } = await import('$lib/stores/auth');
    wire(new SessionEndedByDeviceRevocationError({ userId: 'user-a', deviceId: 'dev-a' }));
    const group = watch(svc.whenGroupDrained('g-1'));

    await inner(svc).fetchPendingMessages();
    await Promise.resolve();

    expect(group.now().state).toBe('pending');
    expect(inner(svc).pullIncompleteOwed).toBe(false);
  });

  it('a wait registered again after the settlement is released by the next COMPLETE pull', async () => {
    wire(new PendingPullIncompleteError(503, 'edge'));
    const firstGroup = watch(svc.whenGroupDrained('g-1'));
    const firstInitial = watch(svc.whenInitialDrainSettled());
    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(firstGroup.now().state).toBe('rejected'));
    await vi.waitFor(() => expect(firstInitial.now().state).toBe('rejected'));

    // Registered again from the settlement: no pull has run since, so they wait - for an event.
    const againGroup = watch(svc.whenGroupDrained('g-1'));
    const againInitial = watch(svc.whenInitialDrainSettled());
    await Promise.resolve();
    expect(againGroup.now().state).toBe('pending');
    expect(againInitial.now().state).toBe('pending');

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(againGroup.now().state).toBe('resolved'));
    await vi.waitFor(() => expect(againInitial.now().state).toBe('resolved'));
    expect(inner(svc).mailboxEmptiedByAPull).toBe(true);
    expect(inner(svc).pullIncompleteOwed).toBe(false);
  });

  it('a waiter re-registered from its own rejection handler is not caught by the same pull', async () => {
    wire(new PendingPullIncompleteError(502, 'gateway'));
    let reRegistered: { now: () => Outcome } | null = null;
    svc.whenGroupDrained('g-1').catch(() => {
      reRegistered = watch(svc.whenGroupDrained('g-1'));
    });

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(reRegistered).not.toBeNull());
    await Promise.resolve();
    expect(reRegistered!.now().state).toBe('pending');

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(reRegistered!.now().state).toBe('resolved'));
  });

  it('the initial drain, once resolved by a complete pull, is never unsettled by a later incomplete one', async () => {
    wire(new Error('unused'));
    pull = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new PendingPullIncompleteError(502, 'gateway'));
    Object.assign(svc, {
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: pull,
      },
    });
    await inner(svc).fetchPendingMessages();
    await expect(svc.whenInitialDrainSettled()).resolves.toBeUndefined();

    await inner(svc).fetchPendingMessages();
    await expect(svc.whenInitialDrainSettled()).resolves.toBeUndefined();
  });

  it('an epoch check DEFERS past an incomplete pull and answers after the next complete one', async () => {
    wire(new PendingPullIncompleteError(502, 'gateway'));
    const check = watch(svc.verifyDistributionEpoch('g-1', 5));

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() =>
      expect(info.mock.calls.flat().join(' ')).toContain(
        'epoch check of key group g-1... deferred to the next complete pull'
      )
    );
    expect(check.now().state).toBe('pending');

    await inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(check.now().state).toBe('resolved'));
    await expect(svc.verifyDistributionEpoch('g-1', 5)).resolves.toBe('current');
  });

  it('pulls again on the next live frame, once, and that pull releases what waits', async () => {
    wire(new PendingPullIncompleteError(503, 'gateway'));
    await inner(svc).fetchPendingMessages();
    expect(inner(svc).pullIncompleteOwed).toBe(true);
    const group = watch(svc.whenGroupDrained('g-1'));

    // The named event: a live frame on the open link. A second frame asks for no second pull.
    inner(svc).enqueueMessage(liveFrame(), 'live');
    inner(svc).enqueueMessage({ ...liveFrame(), queuedMessageId: 'q-2' }, 'live');
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(group.now().state).toBe('resolved'));
    expect(pull).toHaveBeenCalledTimes(2);
    expect(inner(svc).pullIncompleteOwed).toBe(false);
  });
});
