import type { StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import { decodeAppMessage } from '$lib/proto/codec';
import {
  noteMissingSeed,
  noteSeedUnavailable,
  requestCommunityHistory,
  resetGraineRepairState,
  resolveAnswerer,
  forgetAskedSession,
} from './repair';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';

/**
 * Asking for a seed this device does not hold (WP-33).
 *
 * The rules worth a test are the ones whose failure is silent: asking one named answerer rather
 * than the whole community, asking once per session rather than once per unreadable row, and every
 * device picking the SAME stand-in when the sender has left - without talking to each other.
 */

const listMembers = vi.fn();
const listWorkspaceMembers = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    listMembers(...args: unknown[]) {
      return listMembers(...args);
    }
    listWorkspaceMembers(...args: unknown[]) {
      return listWorkspaceMembers(...args);
    }
  },
}));

let sendMessage: ReturnType<typeof vi.fn>;
/** What the fake store answers for the community - empty means "this device has no history". */
let heldSessions: StoredGraineSession[];

beforeEach(() => {
  resetGraineRepairState();
  const roster = [{ userId: 'Bob' }, { userId: 'alice' }, { userId: 'carol' }];
  listMembers.mockResolvedValue(roster);
  listWorkspaceMembers.mockResolvedValue(roster);
  heldSessions = [];
  sendMessage = vi.fn().mockResolvedValue(undefined);
  setGraineRuntime({
    storage: {
      getGraineSessionsForWorkspace: async () => heldSessions,
    } as never,
    deviceKeyB64: 'device-key',
    userId: 'alice',
    mlsService: {
      sendMessage,
      distributionGroupFor: () => 'dist-group',
    } as never,
  });
  registerChannelWorkspace('chan-1', 'ws-1', false);
});

afterEach(() => {
  setGraineRuntime(null);
  resetGraineRepairState();
});

/** The flush is started off a microtask, so a test has to let it run before it asserts. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('noteMissingSeed', () => {
  it('asks the session sender, once, on the distribution group', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'Bob');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [groupId, payload] = sendMessage.mock.calls[0];
    expect(groupId).toBe('dist-group');
    const request = decodeAppMessage(payload)?.graineRequest;
    expect(request?.answererUserId).toBe('bob');
    expect(request?.sessionIds).toEqual(['sess-1']);
    expect(request?.kind).toBe(canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS);
  });

  it('never asks for the same session twice', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();

    // A page of fifty unreadable rows names a handful of sessions between them: without this it
    // would be fifty requests, and the answerer would send the same seed fifty times.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('asks again once the session is explicitly forgotten', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();
    forgetAskedSession('sess-1');
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('coalesces sessions of one sender into a single request', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    noteMissingSeed('chan-1', 'sess-2', 'bob');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.sessionIds).toEqual(['sess-1', 'sess-2']);
  });

  it('sends one request PER answerer, never one broadcast', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    noteMissingSeed('chan-1', 'sess-2', 'carol');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const answerers = sendMessage.mock.calls
      .map((c) => decodeAppMessage(c[1])?.graineRequest?.answererUserId)
      .sort();
    expect(answerers).toEqual(['bob', 'carol']);
  });

  it('says out loud that it could not ask, rather than leaving a blank salon unexplained', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-unknown', 'sess-1', 'bob');
    await settle();

    // The only other symptom is older messages staying unreadable with nothing naming the reason.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves the session askable again when the request could not be sent', async () => {
    listMembers.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();

    // A failed ask that marked the session as asked would be permanent: nothing else ever revisits
    // a session id, so the salon would stay unreadable for the whole app session.
    noteMissingSeed('chan-1', 'sess-1', 'bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('requestCommunityHistory (WP-34)', () => {
  it('asks the lowest other member, once, when this device holds nothing', async () => {
    await requestCommunityHistory('ws-1');
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.kind).toBe(canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY);
    // 'alice' is us, so the lowest OTHER member is 'bob'.
    expect(request?.answererUserId).toBe('bob');
    expect(request?.sessionIds ?? []).toHaveLength(0);
  });

  it('asks nothing when this device already holds a seed for the community', async () => {
    heldSessions = [{ sessionId: 's-1' } as never];

    await requestCommunityHistory('ws-1');

    // Derived from the store, not from a "done" flag: it survives a reload, and a device that has
    // history has nothing to catch up on.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("says so rather than asking when we are the community's only member", async () => {
    listMembers.mockResolvedValue([{ userId: 'alice' }]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });
});

describe('resolveAnswerer', () => {
  it('addresses the sender whenever they are still in the community', () => {
    expect(resolveAnswerer('Bob', new Set(['alice', 'bob', 'carol']), 'alice')).toBe('bob');
  });

  it('falls back to the lowest user id, which every device computes identically', () => {
    // No clock, no election, nothing for a race to decide: a total order every device already has.
    expect(resolveAnswerer('dave', new Set(['carol', 'alice', 'bob']), 'zoe')).toBe('alice');
  });

  it('never addresses ourselves, even when the session was minted by our own other device', () => {
    // A request reaches only the member it names. Naming ourselves costs a round trip and answers
    // nothing: we are asking precisely because this device does not hold the seed.
    expect(resolveAnswerer('alice', new Set(['alice', 'bob']), 'alice')).toBe('bob');
    expect(resolveAnswerer('dave', new Set(['alice', 'bob']), 'alice')).toBe('bob');
  });

  it('answers null when nobody is left who could hold the seed', () => {
    expect(resolveAnswerer('dave', new Set(), 'alice')).toBeNull();
    expect(resolveAnswerer('dave', new Set(['alice']), 'alice')).toBeNull();
  });

  it('walks past everyone who has already declined, sender included', () => {
    const roster = new Set(['alice', 'bob', 'carol']);
    // Determinism is what makes the election safe and is also what would make it a dead end: the
    // same member would be chosen on every retry. `tried` is what turns one election into a walk.
    expect(resolveAnswerer('bob', roster, 'alice', new Set(['bob']))).toBe('carol');
    expect(resolveAnswerer('dave', roster, 'alice', new Set(['bob']))).toBe('carol');
    // Exhausted: null is the PROOF that ends the walk, not a step in it.
    expect(resolveAnswerer('bob', roster, 'alice', new Set(['bob', 'carol']))).toBeNull();
  });
});

describe('noteSeedUnavailable', () => {
  /** Reads the user id a request frame was addressed to. */
  function answererOf(call: unknown[]): string {
    return String(decodeAppMessage(call[1] as Uint8Array)?.graineRequest?.answererUserId ?? '');
  }

  it('elects the next member when the chosen answerer does not hold the seed', async () => {
    // Sender 'dave' has left, so the roster decides: bob is the lowest id that is not us.
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(answererOf(sendMessage.mock.calls[0])).toBe('bob');

    // Without this the session was unreadable for the WHOLE app session: bob is elected by every
    // device alike, so a silent "I don't have it" stranded it for good.
    noteSeedUnavailable('sess-1', 'bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');
  });

  it('stops on the roster being exhausted, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();

    noteSeedUnavailable('sess-1', 'bob');
    await settle();
    noteSeedUnavailable('sess-1', 'carol');
    await settle();

    // Two members, two asks, then nothing: the walk ends on a PROOF that nobody holds it - not on a
    // counter and not on a clock - and the give-up is logged rather than left as a blank salon.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('no reachable holder');
    warn.mockRestore();
  });

  it('asks nobody on behalf of a session that is no longer wanted', async () => {
    // The seed landed by the durable log between the ask and this answer. Re-electing here would
    // spend a round trip on a session this device already holds.
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();
    forgetAskedSession('sess-1');

    noteSeedUnavailable('sess-1', 'bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('lets a later miss ask again once the seed has been forgotten', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();
    // Still armed: a second unreadable row naming the same session must not become a second ask.
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    forgetAskedSession('sess-1');
    noteMissingSeed('chan-1', 'sess-1', 'dave');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
