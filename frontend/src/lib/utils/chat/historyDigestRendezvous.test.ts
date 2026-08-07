import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  awaitDigest,
  digestIdentity,
  forgetGroupDigests,
  noteDigestReceived,
  resetHistoryDigestRendezvousForTests,
} from './historyDigestRendezvous';
import type { HistoryDigest } from './historyManifest';

const GROUP = 'group-1';
const PEER = digestIdentity('USER-A', 'device-a');
const digest: HistoryDigest = { mode: 'ids', ids: ['m1'] };
const other: HistoryDigest = { mode: 'ids', ids: ['m2'] };

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('historyDigestRendezvous', () => {
  it('resolves a request whose digest arrived FIRST', async () => {
    // The MLS broadcast beat the elected responder's WebSocket notification.
    noteDigestReceived(GROUP, PEER, digest);
    await expect(awaitDigest(GROUP, PEER, 2000)).resolves.toEqual(digest);
  });

  it('resolves a request whose digest arrives AFTER it, without waiting out the deadline', async () => {
    // The other order, which is just as legal: nothing sequences a WebSocket push against an MLS
    // frame, so deciding on arrival would answer half the solicitations with a full store.
    const pending = awaitDigest(GROUP, PEER, 2000);
    noteDigestReceived(GROUP, PEER, digest);
    await expect(pending).resolves.toEqual(digest);
  });

  it('resolves null when no digest comes, so the caller can fall back to the whole store', async () => {
    // This is the compatibility path, not an error path: a client too old to send a digest must
    // still get its history.
    const pending = awaitDigest(GROUP, PEER, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();
  });

  it('matches on the DEVICE, not just the user', async () => {
    // A user with several devices must be able to solicit from one of them without the others
    // being answered in its place.
    noteDigestReceived(GROUP, digestIdentity('user-a', 'device-b'), digest);
    const pending = awaitDigest(GROUP, digestIdentity('user-a', 'device-a'), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('matches identity case-insensitively, since a user id is normalised on the wire', async () => {
    noteDigestReceived(GROUP, 'USER-A:device-a', digest);
    await expect(awaitDigest(GROUP, 'user-a:device-a', 1000)).resolves.toEqual(digest);
  });

  it('does not answer a request for a different group', async () => {
    noteDigestReceived('other-group', PEER, digest);
    const pending = awaitDigest(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('CONSUMES a digest, so a later request cannot be answered from a stale snapshot', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    await expect(awaitDigest(GROUP, PEER, 1000)).resolves.toEqual(digest);

    const second = awaitDigest(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBeNull();
  });

  it('expires a digest nobody claimed rather than diffing against a store that has moved', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = awaitDigest(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('gives a late digest to every request still waiting for that peer', async () => {
    const first = awaitDigest(GROUP, PEER, 5000);
    const second = awaitDigest(GROUP, PEER, 5000);
    noteDigestReceived(GROUP, PEER, digest);
    await expect(first).resolves.toEqual(digest);
    await expect(second).resolves.toEqual(digest);
  });

  it('lets a second waiter survive the first one timing out', async () => {
    // The timeout must drop its OWN waiter and not the whole list, or a short-deadline request
    // would silently cancel a longer one already in flight.
    const short = awaitDigest(GROUP, PEER, 1000);
    const long = awaitDigest(GROUP, PEER, 5000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(short).resolves.toBeNull();

    noteDigestReceived(GROUP, PEER, other);
    await expect(long).resolves.toEqual(other);
  });

  it('forgets a group without touching another', async () => {
    noteDigestReceived(GROUP, PEER, digest);
    noteDigestReceived('keep-me', PEER, other);
    forgetGroupDigests(GROUP);

    const gone = awaitDigest(GROUP, PEER, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(gone).resolves.toBeNull();
    await expect(awaitDigest('keep-me', PEER, 1000)).resolves.toEqual(other);
  });
});
