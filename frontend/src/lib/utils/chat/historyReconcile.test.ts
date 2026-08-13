/**
 * The triggers, and what stops a device asking twice for the same thing.
 *
 * Read against the module it replaces: the awaiting-history registry answered "is this conversation
 * missing history?" from durable state, and could not withdraw the answer. Everything here answers
 * a question about a MOMENT instead - did a probe just go out, did the last election find anybody -
 * so every case below is about the lifetime of a fact, not about a conversation.
 */
import type { Mock } from 'vitest';
import {
  reconcileGroup,
  reconcileAllGroups,
  reconcileGroupsAwaitingResponder,
  groupsAwaitingResponder,
  forgetGroupReconciliation,
  resetHistoryReconciliation,
  setHistoryProbeSender,
  type HistoryProbeSender,
} from './historyReconcile';

const GROUP = 'g1';
const OTHER = 'g2';

/** An MLS service whose election answers `outcome`, or throws when it is an Error. */
function service(outcome: { noPeerOnline?: boolean } | Error = {}) {
  return {
    sendHistoryRequest: vi.fn().mockImplementation(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  } as unknown as Parameters<typeof reconcileGroup>[0] & {
    sendHistoryRequest: ReturnType<typeof vi.fn>;
  };
}

let probe: Mock<HistoryProbeSender>;
const log = vi.fn();

beforeEach(() => {
  resetHistoryReconciliation();
  log.mockClear();
  probe = vi.fn().mockResolvedValue(true);
  setHistoryProbeSender(probe);
});

afterEach(() => setHistoryProbeSender(null));

describe('reconcileGroup', () => {
  it('elects a responder FIRST, then sends the probe', async () => {
    // Order, not just presence: a state key sent before the election is an MLS frame every member
    // of the group decrypts, for an exchange that may never have started.
    const order: string[] = [];
    const mls = service();
    mls.sendHistoryRequest.mockImplementation(async () => {
      order.push('elect');
      return {};
    });
    probe.mockImplementation(async () => {
      order.push('probe');
      return true;
    });

    expect(await reconcileGroup(mls, GROUP, log)).toBe(true);
    expect(order).toEqual(['elect', 'probe']);
    expect(probe).toHaveBeenCalledWith(GROUP);
  });

  it('sends NO probe when the server elected nobody, and remembers only that', async () => {
    const mls = service({ noPeerOnline: true });

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(groupsAwaitingResponder()).toEqual([GROUP]);
  });

  it('records NOTHING when the election never left the device', async () => {
    // Offline, DNS, TLS, a 502 from the proxy. None of them is an answer about anybody else, so
    // none of them may be stored as one - the old marker was written on exactly this path and then
    // outlived the outage by 30 days.
    const mls = service(new Error('Failed to fetch'));

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(groupsAwaitingResponder()).toEqual([]);
    // And nothing is coalesced either: the next edge must be free to ask.
    expect(await reconcileGroup(service(), GROUP, log)).toBe(true);
  });

  it('clears the awaiting-responder note as soon as an ask actually goes out', async () => {
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    expect(groupsAwaitingResponder()).toEqual([GROUP]);

    await reconcileGroup(service(), GROUP, log, Date.now() + 60_000);
    expect(groupsAwaitingResponder()).toEqual([]);
  });

  it('does nothing at all when no probe sender is registered, and SAYS so', async () => {
    // A session that forgot to register one reconciles nothing, silently, and looks exactly like a
    // fleet with no peers online.
    setHistoryProbeSender(null);
    const mls = service();

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no probe sender'));
  });

  describe('coalescing', () => {
    it('collapses a burst of triggers on one group into a single ask', async () => {
      // The case that produced it: a replay failing to decrypt forty frames of one conversation
      // raises forty edges for one difference.
      const mls = service();
      const now = Date.now();
      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(true);
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(false);
      expect(await reconcileGroup(mls, GROUP, log, now + 29_000)).toBe(false);

      expect(probe).toHaveBeenCalledTimes(1);
      // The second and third never even reached the server.
      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    });

    it('coalesces PER GROUP - a burst on one says nothing about another', async () => {
      const mls = service();
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await reconcileGroup(mls, OTHER, log, now + 1)).toBe(true);
    });

    it('lets the window lapse rather than scheduling anything', async () => {
      // Nothing here fires on its own: the window only decides whether the NEXT edge is a duplicate.
      const mls = service();
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await reconcileGroup(mls, GROUP, log, now + 30_001)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('re-opens the window when the election went out but the probe did not', async () => {
      // The responder is now waiting for a state key that will never arrive. Leaving the group
      // coalesced would make the next edge decline to ask for another 30 s.
      probe.mockResolvedValueOnce(false);
      const mls = service();
      const now = Date.now();

      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(false);
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(true);
    });

    it('treats a THROWN probe the same way, and logs it', async () => {
      probe.mockRejectedValueOnce(new Error('mls encrypt failed'));
      const mls = service();
      const now = Date.now();

      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(true);
    });
  });
});

describe('reconcileAllGroups', () => {
  it('asks every local group - unconditionally, with no stored evidence to justify it', async () => {
    const mls = service();
    await reconcileAllGroups(mls, [GROUP, OTHER, 'g3'], log);

    expect(probe.mock.calls.map(([g]) => g)).toEqual([GROUP, OTHER, 'g3']);
  });

  it('carries on past a group whose election fails', async () => {
    const mls = service();
    mls.sendHistoryRequest.mockRejectedValueOnce(new Error('boom'));

    await reconcileAllGroups(mls, [GROUP, OTHER], log);
    expect(probe).toHaveBeenCalledWith(OTHER);
  });

  it('reports how many asks went out', async () => {
    // A correct mechanism with no report is found by hand, a day late.
    const mls = service();
    mls.sendHistoryRequest.mockResolvedValueOnce({ noPeerOnline: true });

    await reconcileAllGroups(mls, [GROUP, OTHER], log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1/2 group(s) asked'));
  });

  it('runs the elections concurrently rather than one round trip after another', async () => {
    // THE POINT OF THE PASS BEING CONCURRENT AT ALL. Nine sequential elections were measured at
    // 4.35 s on a device - ~480 ms of HTTP round trip each, taking no lock and serialised for no
    // reason - and the inbound drain that overlapped them inherited the whole duration. What is
    // asserted is the property, not a duration: several elections are in flight at the same time.
    const mls = service();
    let inFlight = 0;
    let peak = 0;
    mls.sendHistoryRequest.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {};
    });

    await reconcileAllGroups(mls, ['a', 'b', 'c', 'd'], log);
    expect(peak).toBeGreaterThan(1);
  });

  it('never opens more elections at once than the bound allows', async () => {
    // The bound is the half that keeps this safe on a phone: a device in fifty conversations must
    // not open fifty requests on the radio the instant it reconnects.
    const mls = service();
    let inFlight = 0;
    let peak = 0;
    mls.sendHistoryRequest.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return {};
    });

    await reconcileAllGroups(
      mls,
      Array.from({ length: 40 }, (_, i) => `g${i}`),
      log
    );
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('says so even when there is nothing to ask', async () => {
    await reconcileAllGroups(service(), [], log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0/0 group(s) asked'));
  });
});

describe('reconcileGroupsAwaitingResponder', () => {
  it('retries ONLY the groups that found nobody, never the ones already compared', async () => {
    // A presence edge is frequent. Re-asking every group on each one would put this mechanism back
    // where the sweep it replaces was: traffic on a trigger that means nothing about the groups.
    const mls = service();
    await reconcileGroup(mls, OTHER, log); // asked, and answered
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log); // nobody online
    probe.mockClear();

    await reconcileGroupsAwaitingResponder(service(), [GROUP, OTHER], log);

    expect(probe.mock.calls.map(([g]) => g)).toEqual([GROUP]);
  });

  it('does nothing when no group is waiting', async () => {
    const mls = service();
    await reconcileGroupsAwaitingResponder(mls, [GROUP, OTHER], log);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('drops a waiting group this device no longer holds', async () => {
    // Left in the group, or the conversation purged, while the peers were offline. There is nothing
    // to reconcile it against, and re-electing would ask the server about a group we are not in.
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    const mls = service();

    await reconcileGroupsAwaitingResponder(mls, [OTHER], log);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(groupsAwaitingResponder()).toEqual([]);
  });
});

describe('forgetting', () => {
  it('forgetGroupReconciliation drops both notes for one conversation, and only that one', async () => {
    // State describing a conversation may not outlive one - three separate pieces of it once did,
    // one of them user-visible.
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    await reconcileGroup(service({ noPeerOnline: true }), OTHER, log);

    forgetGroupReconciliation(GROUP);

    expect(groupsAwaitingResponder()).toEqual([OTHER]);
    // The coalescing note is gone too, so a group re-created under the same id may ask at once.
    const now = Date.now();
    await reconcileGroup(service(), GROUP, log, now);
    forgetGroupReconciliation(GROUP);
    expect(await reconcileGroup(service(), GROUP, log, now + 1)).toBe(true);
  });

  it('resetHistoryReconciliation drops everything, for logout', async () => {
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    const now = Date.now();
    await reconcileGroup(service(), OTHER, log, now);

    resetHistoryReconciliation();

    expect(groupsAwaitingResponder()).toEqual([]);
    expect(await reconcileGroup(service(), OTHER, log, now + 1)).toBe(true);
  });
});
