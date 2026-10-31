// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import {
  keyAgeOf,
  ownEnrolledAtOf,
  unregisterDeviceNotices,
  registerDeviceNotices,
} from './deviceNoticeWiring';
import { SvelteMap } from 'svelte/reactivity';
import { freezeForAdmissionRefusal, resetAdmissionFreezes } from './admissionFreeze';
import { showToast } from '$lib/stores/toast.svelte';

vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
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

// A GROUP FROZEN BY A REFUSED ADMISSION IS TOLD TO ITS MEMBER, from wherever the refusal surfaced.
// The freeze is what protects; the line and the toast only explain why the group stopped following
// the server, and a failure of either must never un-freeze anything.
describe('registerDeviceNotices - a frozen group is announced', () => {
  const mls = () =>
    ({
      setDeviceEventConsumer: vi.fn(),
      fetchUserDevices: vi.fn(async () => []),
      fetchDeviceSignatureKeys: vi.fn(async () => ({ kind: 'unanswered', detail: 'x' })),
    }) as unknown as IMlsService;
  const session = (conversations: SvelteMap<string, any>, addMessageToChat = vi.fn()) => ({
    getUserId: () => 'alice',
    getMyDeviceId: () => 'phone-a',
    conversations,
    storedConversation: vi.fn(async () => null),
    addMessageToChat,
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  beforeEach(() => {
    localStorage.clear();
    resetAdmissionFreezes();
    unregisterDeviceNotices();
    vi.mocked(showToast).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    unregisterDeviceNotices();
    vi.restoreAllMocks();
  });

  it('writes one line in the conversation and a toast when a group becomes frozen', async () => {
    const conversations = new SvelteMap<string, any>([['g1', { messages: [] }]]);
    const addMessageToChat = vi.fn(async () => {});
    registerDeviceNotices(mls(), session(conversations, addMessageToChat));

    freezeForAdmissionRefusal('g1', 'mallory:dev1');
    await flush();

    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    expect(addMessageToChat).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('mallory'),
      'g1',
      expect.objectContaining({ isSystem: true, messageId: 'admission-refused:g1' })
    );
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('writes the line once however often it is announced', async () => {
    const conversations = new SvelteMap<string, any>([
      ['g1', { messages: [{ id: 'admission-refused:g1' }] }],
    ]);
    const addMessageToChat = vi.fn(async () => {});
    registerDeviceNotices(mls(), session(conversations, addMessageToChat));

    freezeForAdmissionRefusal('g1', 'mallory:dev1');
    await flush();

    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it('announces a freeze made before the session registered', async () => {
    freezeForAdmissionRefusal('g1', 'mallory:dev1');
    const conversations = new SvelteMap<string, any>([['g1', { messages: [] }]]);
    const addMessageToChat = vi.fn(async () => {});

    registerDeviceNotices(mls(), session(conversations, addMessageToChat));
    await flush();

    expect(addMessageToChat).toHaveBeenCalledTimes(1);
  });

  it('still toasts when the conversation row is not loaded, and writes no line', async () => {
    const addMessageToChat = vi.fn(async () => {});
    registerDeviceNotices(mls(), session(new SvelteMap(), addMessageToChat));

    freezeForAdmissionRefusal('g1', 'mallory:dev1');
    await flush();

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('stops announcing at sign-out', async () => {
    const conversations = new SvelteMap<string, any>([['g1', { messages: [] }]]);
    const addMessageToChat = vi.fn(async () => {});
    registerDeviceNotices(mls(), session(conversations, addMessageToChat));
    unregisterDeviceNotices();

    freezeForAdmissionRefusal('g1', 'mallory:dev1');
    await flush();

    expect(addMessageToChat).not.toHaveBeenCalled();
  });
});
