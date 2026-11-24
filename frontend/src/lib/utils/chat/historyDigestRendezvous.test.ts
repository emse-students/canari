import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  awaitProbe,
  digestIdentity,
  forgetGroupDigests,
  MAX_STORED_PROBES_PER_ASKER,
  noteDigestSolicited,
  noteProbeReceived,
  resetHistoryDigestRendezvousForTests,
  takeDigestSolicitation,
} from './historyDigestRendezvous';
import type { HistoryDigest } from './historyManifest';

const GROUP = 'group-1';
const PEER = digestIdentity('USER-A', 'device-a');
const digest: HistoryDigest = { mode: 'ids', ids: ['m1'] };
const other: HistoryDigest = { mode: 'ids', ids: ['m2'] };

/** A well-formed `answerKey` (32 bytes, base64): every ask carries one since option B. */
const ANSWER_KEY = 'a'.repeat(43) + '=';

/** What a resolved wait looks like: the peer's digest and the window it asked over, together. */
const solicited = (d: HistoryDigest, since = 0) => ({
  kind: 'digest' as const,
  digest: d,
  since,
  requestId: 'ask-00000001',
  answerKey: ANSWER_KEY,
});

/** Records a digest probe, which is the shape every case below used before probes had kinds. */
function noteDigestReceived(
  groupId: string,
  from: string,
  d: HistoryDigest,
  since = 0,
  now?: number
): void {
  noteProbeReceived(groupId, from, solicited(d, since), now);
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

  it('gives one probe to ONE waiter, the oldest - one ask is answered once', async () => {
    // Reproduces 2026-11-24: an answerer elected twice for one asker held two waiters, and the one
    // probe woke both - so it answered the same requestId twice, and the asker refused the second
    // answer at error. The second election's own probe is what wakes the second waiter.
    const first = awaitProbe(GROUP, PEER, 5000);
    const second = awaitProbe(GROUP, PEER, 5000);
    let secondSettled = false;
    void second.then(() => (secondSettled = true));
    expect(noteProbeReceived(GROUP, PEER, solicited(digest))).toBe('waiter');
    await expect(first).resolves.toEqual(solicited(digest));
    await vi.advanceTimersByTimeAsync(0);
    expect(secondSettled).toBe(false);

    const again = { ...solicited(other), requestId: 'ask-00000002' };
    expect(noteProbeReceived(GROUP, PEER, again)).toBe('waiter');
    await expect(second).resolves.toEqual(again);
  });

  it('claims a late digest for the solicitation and never stores it for a later election', async () => {
    // The sibling of the double answer: a digest that nobody waits for but that WE solicited is
    // answered by the late path. Stored as well, a later election of this device for the same asker
    // consumed it again from `awaitProbe` and answered the same requestId a second time.
    noteDigestSolicited(GROUP, PEER, 1_000);
    expect(noteProbeReceived(GROUP, PEER, solicited(digest), 2_000)).toBe('solicitation');
    expect(takeDigestSolicitation(GROUP, PEER, 2_000)).toBe(false);

    const later = awaitProbe(GROUP, PEER, 5000, 0);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(later).resolves.toBeNull();
  });

  it('a digest a waiter took also answers the solicitation, so a stale one cannot make us a second answerer', async () => {
    noteDigestSolicited(GROUP, PEER, 1_000);
    const waiting = awaitProbe(GROUP, PEER, 5000, 0);
    expect(noteProbeReceived(GROUP, PEER, solicited(digest), 2_000)).toBe('waiter');
    await expect(waiting).resolves.toEqual(solicited(digest));
    // The asker's next digest - an exchange with another member - is stored, never answered late.
    expect(noteProbeReceived(GROUP, PEER, solicited(other), 3_000)).toBe('stored');
  });

  it(`keeps at most ${MAX_STORED_PROBES_PER_ASKER} stored probes per asker, dropping the oldest at warn`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nth = (i: number) => ({
      ...solicited(digest),
      requestId: `ask-${String(i).padStart(8, '0')}`,
    });
    for (let i = 0; i <= MAX_STORED_PROBES_PER_ASKER; i++) noteProbeReceived(GROUP, PEER, nth(i));
    expect(warn.mock.calls.map(([l]) => String(l))).toEqual([
      expect.stringContaining('[HISTORY_PROBE]'),
    ]);
    // The oldest (ask 0) went; the next one out is ask 1.
    await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(nth(1));
    warn.mockRestore();
  });

  it('stores an unsolicited digest nobody waits for', () => {
    expect(noteProbeReceived(GROUP, PEER, solicited(digest))).toBe('stored');
  });

  it('keeps every probe that lands before its election, oldest first', async () => {
    // Two asks whose probes both beat their elections: one slot per key kept only the second, and
    // the first election took the second ask's probe while the second found nothing.
    const first = solicited(digest);
    const second = { ...solicited(other), requestId: 'ask-00000002' };
    expect(noteProbeReceived(GROUP, PEER, first)).toBe('stored');
    expect(noteProbeReceived(GROUP, PEER, second)).toBe('stored');
    await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(first);
    await expect(awaitProbe(GROUP, PEER, 2000)).resolves.toEqual(second);
  });

  it('takes the oldest stored probe that postdates the election, leaving the older one', async () => {
    const stale = solicited(digest);
    const fresh = { ...solicited(other), requestId: 'ask-00000002' };
    noteProbeReceived(GROUP, PEER, stale, Date.now());
    vi.advanceTimersByTime(10);
    const electedAt = Date.now();
    noteProbeReceived(GROUP, PEER, fresh, electedAt);
    await expect(awaitProbe(GROUP, PEER, 2000, electedAt)).resolves.toEqual(fresh);
  });

  it('ends a waiter whose probe never comes on its deadline, after another took the one probe', async () => {
    const first = awaitProbe(GROUP, PEER, 5000);
    const second = awaitProbe(GROUP, PEER, 5000);
    noteDigestReceived(GROUP, PEER, digest);
    await expect(first).resolves.toEqual(solicited(digest));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(second).resolves.toBeNull();
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

  describe('a probe that predates the ask (three online devices upward)', () => {
    // Every member stores every probe - the frame is a group broadcast and knows nothing about the
    // election - and probes outlive the asker's coalescing window (60 s vs 30 s). So a member
    // elected for the SECOND ask can be holding the FIRST ask's probe.

    it('prefers the probe that arrived AFTER the election over the one already held', async () => {
      noteDigestReceived(GROUP, PEER, digest); // the first ask's probe
      await vi.advanceTimersByTimeAsync(35_000); // past PROBE_COALESCE_MS, inside DIGEST_TTL_MS

      const electedAt = Date.now();
      const pending = awaitProbe(GROUP, PEER, 20_000, electedAt);
      noteDigestReceived(GROUP, PEER, other); // the second ask's probe, on its way

      await expect(pending).resolves.toEqual(solicited(other));
    });

    it('falls back to the older probe when nothing fresher arrives', async () => {
      // The safety of the whole thing: `notBefore` rests on an ordering between two independent
      // transports, so being wrong about it must cost a stale comparison - what happened before -
      // and never a silent responder.
      noteDigestReceived(GROUP, PEER, digest);
      await vi.advanceTimersByTimeAsync(35_000);

      const pending = awaitProbe(GROUP, PEER, 5000, Date.now());
      await vi.advanceTimersByTimeAsync(5000);

      await expect(pending).resolves.toEqual(solicited(digest));
    });

    it('never falls back to a probe that expired during the wait', async () => {
      noteDigestReceived(GROUP, PEER, digest);
      await vi.advanceTimersByTimeAsync(30_000);

      const pending = awaitProbe(GROUP, PEER, 40_000, Date.now());
      await vi.advanceTimersByTimeAsync(40_000); // total age 70 s > DIGEST_TTL_MS

      await expect(pending).resolves.toBeNull();
    });

    it('takes a probe that postdates the election immediately, without waiting', async () => {
      const electedAt = Date.now();
      await vi.advanceTimersByTimeAsync(10);
      noteDigestReceived(GROUP, PEER, digest);

      await expect(awaitProbe(GROUP, PEER, 20_000, electedAt)).resolves.toEqual(solicited(digest));
    });

    it('is off by default, so every other caller keeps the old behaviour', async () => {
      noteDigestReceived(GROUP, PEER, digest);
      await vi.advanceTimersByTimeAsync(35_000);

      await expect(awaitProbe(GROUP, PEER, 1000)).resolves.toEqual(solicited(digest));
    });
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

    it('gives each waiter the window of the probe it took', async () => {
      const first = awaitProbe(GROUP, PEER, 5000);
      const second = awaitProbe(GROUP, PEER, 5000);
      noteDigestReceived(GROUP, PEER, digest, 42_000);
      noteDigestReceived(GROUP, PEER, digest, 43_000);
      await expect(first).resolves.toEqual(solicited(digest, 42_000));
      await expect(second).resolves.toEqual(solicited(digest, 43_000));
    });
  });

  describe('the three kinds of probe', () => {
    // One rendezvous carries all three because they are all the SAME ask arriving out of order
    // against the same election - and because a state key that turns out to differ is answered by
    // asking the peer for a digest, which lands here as a second probe on the same exchange.

    const stateProbe = { kind: 'state' as const, key: 'abcdef0123456789', since: 1000 };
    const rangeProbe = {
      kind: 'range' as const,
      before: 9000,
      limit: 50,
      since: 1000,
      requestId: 'ask-00000001',
      answerKey: ANSWER_KEY,
    };

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
