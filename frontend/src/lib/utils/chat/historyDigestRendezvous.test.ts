import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  awaitProbe,
  digestIdentity,
  forgetGroupDigests,
  noteProbeReceived,
  resetHistoryDigestRendezvousForTests,
} from './historyDigestRendezvous';
import type { HistoryDigest } from './historyManifest';

const GROUP = 'group-1';
const PEER = digestIdentity('USER-A', 'device-a');
const digest: HistoryDigest = { mode: 'ids', ids: ['m1'] };
const other: HistoryDigest = { mode: 'ids', ids: ['m2'] };

/** What a resolved wait looks like: the peer's digest and the window it asked over, together. */
const solicited = (d: HistoryDigest, since = 0) => ({ kind: 'digest' as const, digest: d, since });

/** Records a digest probe, which is the shape every case below used before probes had kinds. */
function noteDigestReceived(
  groupId: string,
  from: string,
  d: HistoryDigest,
  since = 0,
  now?: number
): void {
  noteProbeReceived(groupId, from, { kind: 'digest', digest: d, since }, now);
}

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('historyDigestRendezvous', () => {
  it('resolves a request whose digest arrived FIRST', async () => {
    // The MLS broadcast beat the elected responder's WebSocket notification.
    noteDigestReceived(GROUP, PEER, digest);
    await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(solicited(digest));
  });

  it('resolves a request whose digest arrives AFTER it, without waiting out the deadline', async () => {
    // The other order, which is just as legal: nothing sequences a WebSocket push against an MLS
    // frame, so deciding on arrival would answer half the solicitations with a full store.
    const pending = awaitProbe(GROUP, PEER, 2000);
    noteDigestReceived(GROUP, PEER, digest);
    await expect(pending).resolves.toEqual(solicited(digest));
  });

  it('resolves null when no digest comes, so the caller can fall back to the whole store', async () => {
    // This is the compatibility path, not an error path: a client too old to send a digest must
    // still get its history.
    const pending = awaitProbe(GROUP, PEER, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();
  });

  it('matches on the DEVICE, not just the user', async () => {
    // A user with several devices must be able to solicit from one of them without the others
    // being answered in its place.
    noteDigestReceived(GROUP, digestIdentity('user-a', 'device-b'), digest);
    const pending = awaitProbe(GROUP, digestIdentity('user-a', 'device-a'), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('matches identity case-insensitively, since a user id is normalised on the wire', async () => {
    noteDigestReceived(GROUP, 'USER-A:device-a', digest);
    await expect(awaitProbe(GROUP, 'user-a:device-a', 1000)).resolves.toEqual(solicited(digest));
  });

  it('does not answer a request for a different group', async () => {
    noteDigestReceived('other-group', PEER, digest);
    const pending = awaitProbe(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('CONSUMES a digest, so a later request cannot be answered from a stale snapshot', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    await expect(awaitProbe(GROUP, PEER, 1000)).resolves.toEqual(solicited(digest));

    const second = awaitProbe(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBeNull();
  });

  it('expires a digest nobody claimed rather than diffing against a store that has moved', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = awaitProbe(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('gives a late digest to every request still waiting for that peer', async () => {
    const first = awaitProbe(GROUP, PEER, 5000);
    const second = awaitProbe(GROUP, PEER, 5000);
    noteDigestReceived(GROUP, PEER, digest);
    await expect(first).resolves.toEqual(solicited(digest));
    await expect(second).resolves.toEqual(solicited(digest));
  });

  it('lets a second waiter survive the first one timing out', async () => {
    // The timeout must drop its OWN waiter and not the whole list, or a short-deadline request
    // would silently cancel a longer one already in flight.
    const short = awaitProbe(GROUP, PEER, 1000);
    const long = awaitProbe(GROUP, PEER, 5000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(short).resolves.toBeNull();

    noteDigestReceived(GROUP, PEER, other);
    await expect(long).resolves.toEqual(solicited(other));
  });

  it('forgets a group without touching another', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    noteDigestReceived('keep-me', PEER, other);
    forgetGroupDigests(GROUP);

    const gone = awaitProbe(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(gone).resolves.toBeNull();
    await expect(awaitProbe('keep-me', PEER, 1000)).resolves.toEqual(solicited(other));
  });

  describe('the window the asker stated', () => {
    // `since` and the digest are ONE ask and must not be separable: an answerer holding the digest
    // without the window can only answer in full, which is the behaviour the window exists to end.

    it("carries the asker's window to a request that was already waiting", async () => {
      const pending = awaitProbe(GROUP, PEER, 2000);
      noteDigestReceived(GROUP, PEER, digest, 1_700_000_000_000);
      await expect(pending).resolves.toEqual(solicited(digest, 1_700_000_000_000));
    });

    it('carries it just the same when the digest arrived first', async () => {
      noteDigestReceived(GROUP, PEER, digest, 1_700_000_000_000);
      await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(
        solicited(digest, 1_700_000_000_000)
      );
    });

    it('defaults to 0 - answer in full - for a peer too old to state one', async () => {
      // The compatibility reading, and the reason no call site needs a branch for it: 0 is below
      // every message, so clipping to it is a no-op rather than a special case.
      noteDigestReceived(GROUP, PEER, digest);
      await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(solicited(digest, 0));
    });

    it('gives every waiter the SAME window, not just the first', async () => {
      const first = awaitProbe(GROUP, PEER, 5000);
      const second = awaitProbe(GROUP, PEER, 5000);
      noteDigestReceived(GROUP, PEER, digest, 42_000);
      await expect(first).resolves.toEqual(solicited(digest, 42_000));
      await expect(second).resolves.toEqual(solicited(digest, 42_000));
    });
  });

  describe('the three kinds of probe', () => {
    // One rendezvous carries all three because they are all the SAME ask arriving out of order
    // against the same election - and because a state key that turns out to differ is answered by
    // asking the peer for a digest, which lands here as a second probe on the same exchange.

    const stateProbe = { kind: 'state' as const, key: 'abcdef0123456789', since: 1000 };
    const rangeProbe = { kind: 'range' as const, before: 9000, limit: 50, since: 1000 };

    it('carries a state key through, waiting or not', async () => {
      noteProbeReceived(GROUP, PEER, stateProbe);
      await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(stateProbe);

      const pending = awaitProbe(GROUP, PEER, 2000);
      noteProbeReceived(GROUP, PEER, stateProbe);
      await expect(pending).resolves.toEqual(stateProbe);
    });

    it('carries a scrollback range through', async () => {
      noteProbeReceived(GROUP, PEER, rangeProbe);
      await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(rangeProbe);
    });

    it('lets one exchange await a state key and then the digest it asked for', async () => {
      // The two legs of a reconciliation that found a difference. The second `awaitProbe` must not
      // be answered by the first probe, which is what CONSUMING guarantees.
      noteProbeReceived(GROUP, PEER, stateProbe);
      await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(stateProbe);

      const second = awaitProbe(GROUP, PEER, 2000);
      noteDigestReceived(GROUP, PEER, digest, 1000);
      await expect(second).resolves.toEqual(solicited(digest, 1000));
    });
  });
});
