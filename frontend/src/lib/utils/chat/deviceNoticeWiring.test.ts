// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import {
  dropAlertsOfRevokedDevices,
  keyAgeOf,
  ownEnrolledAtOf,
  rosterSeatOf,
  unregisterDeviceNotices,
  registerDeviceNotices,
} from './deviceNoticeWiring';
import { SvelteMap } from 'svelte/reactivity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { pendingDeviceNotices } from './deviceNotices.svelte';

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
});

describe('rosterSeatOf - whether the server seats an entrant as an admitted member', () => {
  const answering = (batch: {
    rosters?: [string, string[]][];
    refused?: string[];
    awaiting?: [string, string[]][];
  }) => {
    const getGroupRosters = vi.fn(async () => ({
      rosters: new Map(batch.rosters ?? []),
      refused: new Set(batch.refused ?? []),
      revoked: new Map<string, string[]>(),
      awaiting: new Map(batch.awaiting ?? []),
    }));
    return { mls: { getGroupRosters } as unknown as IMlsService, getGroupRosters };
  };

  it('is admitted when the roster names the person, whatever the case, in ONE read of that group', async () => {
    const { mls, getGroupRosters } = answering({ rosters: [['g1', ['Alice', 'bob']]] });
    await expect(rosterSeatOf(mls, 'g1', 'alice')).resolves.toBe('admitted');
    expect(getGroupRosters).toHaveBeenCalledTimes(1);
    expect(getGroupRosters).toHaveBeenCalledWith(['g1']);
  });

  it('is not admitted when the person is absent, or still awaits a member', async () => {
    const absent = answering({ rosters: [['g1', ['bob']]] });
    await expect(rosterSeatOf(absent.mls, 'g1', 'alice')).resolves.toBe('not-admitted');
    const waiting = answering({
      rosters: [['g1', ['alice', 'bob']]],
      awaiting: [['g1', ['alice']]],
    });
    await expect(rosterSeatOf(waiting.mls, 'g1', 'alice')).resolves.toBe('not-admitted');
  });

  it('throws when the group was not answered, or refused - never guessed', async () => {
    await expect(rosterSeatOf(answering({}).mls, 'g1', 'alice')).rejects.toThrow('not answered');
    await expect(rosterSeatOf(answering({ refused: ['g1'] }).mls, 'g1', 'alice')).rejects.toThrow(
      'refused'
    );
  });
});
