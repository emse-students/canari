// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import type { DeviceEvent } from '$lib/mls-client/deviceTrust';
import type { Conversation } from '$lib/types';
import {
  resetReportedUninvitedEntries,
  setUninvitedEntryReporter,
} from '$lib/mls-client/uninvitedEntry';
import {
  dropAlertsOfRevokedDevices,
  keyAgeOf,
  ownEnrolledAtOf,
  unregisterDeviceNotices,
  registerDeviceNotices,
} from './deviceNoticeWiring';
import { SvelteMap } from 'svelte/reactivity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { pendingDeviceNotices } from './deviceNotices.svelte';

// Writing a line resolves display names, which would ask the server.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: async () => (id: string) => id,
}));

/** The key [1, 2, 3] and its fingerprint (`mls-core/tests/fixtures/key_fingerprints.json`). */
const KEY = new Uint8Array([1, 2, 3]);
const FP = '039058c6f2c0cb49';

function mlsAnswering(answer: DeviceSignatureKeys) {
  return {
    fetchDeviceSignatureKeys: vi.fn(async () => answer),
  } as unknown as IMlsService;
}

describe('keyAgeOf - the server first sight of the key an event names', () => {
  it('is dated when the history recorded that key', async () => {
    const mls = mlsAnswering({
      kind: 'keys',
      keys: [KEY],
      firstSeen: [{ key: KEY, firstSeenAt: 42 }],
    });
    await expect(keyAgeOf(mls, 'bob', 'web-2', FP)).resolves.toEqual({ kind: 'dated', at: 42 });
  });

  it('is before-history when the server LISTS the key with no date for it', async () => {
    const mls = mlsAnswering({ kind: 'keys', keys: [KEY], firstSeen: [] });
    await expect(keyAgeOf(mls, 'bob', 'web-2', FP)).resolves.toEqual({
      kind: 'before-history',
    });
  });

  it('is unknown - read as new - when the server leaves the key out, or sends no ages at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      keyAgeOf(mlsAnswering({ kind: 'keys', keys: [], firstSeen: [] }), 'bob', 'web-2', FP)
    ).resolves.toEqual({ kind: 'unknown' });
    await expect(
      keyAgeOf(mlsAnswering({ kind: 'keys', keys: [KEY] }), 'bob', 'web-2', FP)
    ).resolves.toEqual({ kind: 'unknown' });
    warn.mockRestore();
  });

  it('is unanswered when the server could not be asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      keyAgeOf(mlsAnswering({ kind: 'unanswered', detail: 'HTTP 502' }), 'bob', 'web-2', FP)
    ).resolves.toEqual({ kind: 'unanswered' });
    warn.mockRestore();
  });
});

describe('ownEnrolledAtOf - when this device enrolled, as the server saw it', () => {
  it('is the first sight of its oldest dated key', async () => {
    const mls = mlsAnswering({
      kind: 'keys',
      keys: [KEY],
      firstSeen: [
        { key: KEY, firstSeenAt: 50 },
        { key: new Uint8Array([9]), firstSeenAt: 70 },
      ],
    });
    await expect(ownEnrolledAtOf(mls, 'alice', 'phone-a')).resolves.toBe(50);
  });

  it('is null with no dated key, and unanswered when the server was not reached', async () => {
    await expect(
      ownEnrolledAtOf(mlsAnswering({ kind: 'keys', keys: [KEY], firstSeen: [] }), 'a', 'd')
    ).resolves.toBeNull();
    await expect(
      ownEnrolledAtOf(mlsAnswering({ kind: 'unanswered', detail: 'x' }), 'a', 'd')
    ).resolves.toBe('unanswered');
  });
});

describe('unregisterDeviceNotices - sign-out', () => {
  it('stops consuming device events, so they stay in the MLS state for the next account', () => {
    const setDeviceEventConsumer = vi.fn();
    const mls = {
      setDeviceEventConsumer,
      listUserDevices: vi.fn(async () => []),
      fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
    } as unknown as IMlsService;
    registerDeviceNotices(mls, {
      getUserId: () => 'alice',
      getMyDeviceId: () => 'phone-a',
      conversations: new SvelteMap(),
      storedConversation: vi.fn(async () => null),
      addMessageToChat: vi.fn(),
    });
    expect(setDeviceEventConsumer).toHaveBeenLastCalledWith(expect.any(Function));
    unregisterDeviceNotices();
    expect(setDeviceEventConsumer).toHaveBeenLastCalledWith(null);
  });
});

describe('dropAlertsOfRevokedDevices - asked of the signed-in account', () => {
  it("asks the server about each alerted device of THIS account, and drops the revoked one's alert", async () => {
    localStorage.setItem(
      ACCOUNT_KEY.deviceNotices('alice'),
      JSON.stringify({
        pending: [
          { key: 'alice:laptop-9|cc', deviceId: 'laptop-9', at: 1 },
          { key: 'alice:tablet-3|dd', deviceId: 'tablet-3', at: 2 },
        ],
      })
    );
    const isDeviceRevoked = vi.fn(async (_u: string, d: string) => d === 'laptop-9');
    const mls = {
      setDeviceEventConsumer: vi.fn(),
      listUserDevices: vi.fn(async () => []),
      fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
      isDeviceRevoked,
    } as unknown as IMlsService;
    registerDeviceNotices(mls, {
      getUserId: () => 'alice',
      getMyDeviceId: () => 'phone-a',
      conversations: new SvelteMap(),
      storedConversation: vi.fn(async () => null),
      addMessageToChat: vi.fn(),
    });

    await dropAlertsOfRevokedDevices();

    expect(isDeviceRevoked.mock.calls.map((c) => c[0])).toEqual(['alice', 'alice']);
    expect(pendingDeviceNotices().map((n) => n.deviceId)).toEqual(['tablet-3']);
    unregisterDeviceNotices();
    localStorage.clear();
  });

  it('a check asked BEFORE the account registers is owed and runs at registration', async () => {
    unregisterDeviceNotices();
    localStorage.setItem(
      ACCOUNT_KEY.deviceNotices('alice'),
      JSON.stringify({ pending: [{ key: 'alice:laptop-9|cc', deviceId: 'laptop-9', at: 1 }] })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dropAlertsOfRevokedDevices();
    // The expected path on a cold start: said as a decision, never as a warning.
    expect(log.mock.calls.some((c) => String(c[0]).includes('deferred'))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();

    const isDeviceRevoked = vi.fn(async () => true);
    const mls = {
      setDeviceEventConsumer: vi.fn(),
      listUserDevices: vi.fn(async () => []),
      fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
      isDeviceRevoked,
    } as unknown as IMlsService;
    registerDeviceNotices(mls, {
      getUserId: () => 'alice',
      getMyDeviceId: () => 'phone-a',
      conversations: new SvelteMap(),
      storedConversation: vi.fn(async () => null),
      addMessageToChat: vi.fn(),
    });
    await vi.waitFor(() => expect(pendingDeviceNotices()).toEqual([]));
    expect(isDeviceRevoked).toHaveBeenCalledTimes(1);
    unregisterDeviceNotices();
    localStorage.clear();
  });

  it('an owed check does not leak across an account switch', async () => {
    unregisterDeviceNotices();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await dropAlertsOfRevokedDevices();
    unregisterDeviceNotices();
    localStorage.setItem(
      ACCOUNT_KEY.deviceNotices('bob'),
      JSON.stringify({ pending: [{ key: 'bob:laptop-9|cc', deviceId: 'laptop-9', at: 1 }] })
    );
    const isDeviceRevoked = vi.fn(async () => true);
    registerDeviceNotices(
      {
        setDeviceEventConsumer: vi.fn(),
        listUserDevices: vi.fn(async () => []),
        fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
        isDeviceRevoked,
      } as unknown as IMlsService,
      {
        getUserId: () => 'bob',
        getMyDeviceId: () => 'phone-b',
        conversations: new SvelteMap(),
        storedConversation: vi.fn(async () => null),
        addMessageToChat: vi.fn(),
      }
    );
    await Promise.resolve();
    expect(isDeviceRevoked).not.toHaveBeenCalled();
    expect(pendingDeviceNotices().map((n) => n.deviceId)).toEqual(['laptop-9']);
    unregisterDeviceNotices();
    vi.restoreAllMocks();
    localStorage.clear();
  });
});

// THE OWNER'S RULE (2026-11-14): the DEVICE decides whether an entrant is a member coming back. A
// delivery service that seats the entrant on the roster it serves - as a server that let an outsider
// in would - changes nothing: the roster is never read, and with no sighting on this device the entry
// is a NOT PROVEN `new-person`, written and reported.
describe('registerDeviceNotices - an uninvited entry is decided on the device, never by the roster', () => {
  it('the roster seats the entrant, the device holds no evidence: `new-person`, roster never read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = vi.fn(async () => {});
    resetReportedUninvitedEntries();
    setUninvitedEntryReporter(reporter);
    let consume: ((events: DeviceEvent[]) => Promise<unknown>) | null = null;
    const getGroupRosters = vi.fn(async () => ({
      rosters: new Map([['group-1', ['alice', 'mallory']]]),
      refused: new Set<string>(),
      revoked: new Map<string, string[]>(),
      awaiting: new Map<string, string[]>(),
    }));
    const membershipEvidence = vi.fn(async () => ({ firstSeenEpoch: null, watchedFromEpoch: 3 }));
    const mls = {
      setDeviceEventConsumer: vi.fn((c: typeof consume) => {
        consume = c;
      }),
      listUserDevices: vi.fn(async () => []),
      fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
      isDistributionGroup: () => false,
      getLocalGroups: () => ['group-1'],
      heldGroupsKnown: () => true,
      getGroupMemberIdentities: vi.fn(async () => ['alice:phone-a', 'mallory:dev1']),
      commitAcceptedAt: vi.fn(async () => ({ kind: 'at', at: 1_000 })),
      getGroupRosters,
      membershipEvidence,
    } as unknown as IMlsService;
    const addMessageToChat = vi.fn();
    registerDeviceNotices(mls, {
      getUserId: () => 'alice',
      getMyDeviceId: () => 'phone-a',
      conversations: new SvelteMap([
        ['group-1', { conversationType: 'group', messages: [] } as unknown as Conversation],
      ]),
      storedConversation: vi.fn(async () => null),
      addMessageToChat,
    });

    await consume!([
      {
        groupId: 'group-1',
        epoch: 5,
        identity: 'mallory:dev1',
        keyFingerprint: '00ff',
        trust: 'first-sight',
        addedBy: 'mallory:dev1',
        memberAlreadyPresent: false,
      },
    ]);

    expect(membershipEvidence).toHaveBeenCalledWith('group-1', 'mallory');
    expect(getGroupRosters).not.toHaveBeenCalled();
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'new-person', watchedFromEpoch: 3 })
    );
    expect(addMessageToChat).toHaveBeenCalled();
    unregisterDeviceNotices();
    setUninvitedEntryReporter(null);
    localStorage.clear();
    error.mockRestore();
    warn.mockRestore();
  });
});
