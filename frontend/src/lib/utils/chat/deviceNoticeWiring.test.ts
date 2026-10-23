// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import {
  keyAgeOf,
  ownEnrolledAtOf,
  unregisterDeviceNotices,
  registerDeviceNotices,
} from './deviceNoticeWiring';
import { SvelteMap } from 'svelte/reactivity';

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

  it('is undated when the history has no date for it - the key predates the history', async () => {
    const mls = mlsAnswering({ kind: 'keys', keys: [KEY], firstSeen: [] });
    await expect(keyAgeOf(mls, 'bob', 'web-2', FP)).resolves.toEqual({ kind: 'undated' });
  });

  it('is unanswered when the server could not be asked, or sent no ages at all', async () => {
    await expect(
      keyAgeOf(mlsAnswering({ kind: 'unanswered', detail: 'HTTP 502' }), 'bob', 'web-2', FP)
    ).resolves.toEqual({ kind: 'unanswered' });
    await expect(
      keyAgeOf(mlsAnswering({ kind: 'keys', keys: [KEY] }), 'bob', 'web-2', FP)
    ).resolves.toEqual({ kind: 'unanswered' });
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
      fetchUserDevices: vi.fn(async () => []),
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
