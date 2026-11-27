// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService } from './CallService';
import { isBlockedWith } from '$lib/users/blocks';
import { leafRefreshHold } from '$lib/mls-client/leafRefresh';

/**
 * The other half of CallService.disabled.test.ts: the same invite, with CALLS_ENABLED on. It proves
 * the sibling file measures the guard rather than a broken signal handler, and it is what will
 * still be green on the day the constant is flipped back for real (rung 15 CALL / CALL-13).
 */

vi.mock('$lib/features', () => ({ CALLS_ENABLED: true, CALLS_VIDEO_ENABLED: true }));
/**
 * What the server's kill switch says, and whether `/api/version` has answered yet; mutable so a test
 * can close calls or hold the answer back (`refresh` is what an invite awaits).
 */
const server = vi.hoisted(() => ({
  mode: 'audio' as 'off' | 'audio' | 'audio_video',
  answered: true,
  refresh: async (): Promise<void> => {},
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => server.mode,
  getAppVersionCheck: () => (server.answered ? {} : null),
  refreshAppVersionCheck: () => server.refresh(),
}));
vi.mock('$lib/users/blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/users/blocks')>()),
  isBlockedWith: vi.fn(async () => false),
}));
vi.mock('../workers/encryption.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn(async () => {}) }));
vi.mock('$lib/utils/chat/callSystemMessages', () => ({
  getCallSystemMessageContext: () => null,
  recordCallMissed: vi.fn(),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => 'token' }));

const fakeMls = { getDeviceId: () => 'device-1' } as unknown as IMlsService;

/** An invite as a lot-1 caller sends it: with the server's ring window (`ring_timeout_ms`). */
const INVITE = {
  callId: 'call-1',
  hasVideo: true,
  offerSdp: 'START',
  deviceId: 'device-2',
  ringTimeoutMs: 60_000,
};

describe('CallService with calls enabled', () => {
  afterEach(() => {
    server.mode = 'audio';
    server.answered = true;
    server.refresh = async () => {};
  });

  /** Holds `/api/version` back: the invite arrives first, the answer is `mode` once released. */
  function versionPending(mode: 'off' | 'audio') {
    server.mode = 'off';
    server.answered = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.refresh = async () => {
      await gate;
      server.mode = mode;
      server.answered = true;
    };
    return release;
  }

  it('rings once the pending version check answers audio (the invite beat it)', async () => {
    const release = versionPending('audio');
    const service = new CallService(fakeMls);
    const handled = service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );
    await Promise.resolve();
    expect(get(service.callState)).toBe('idle');
    release();
    await handled;
    expect(get(service.callState)).toBe('incoming');
  });

  it('does not ring once the pending version check answers off', async () => {
    const release = versionPending('off');
    const service = new CallService(fakeMls);
    const handled = service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );
    release();
    await handled;
    expect(get(service.callState)).toBe('idle');
    expect(service.currentCallId).toBeNull();
  });

  it('does not ring while the server kill switch reads off', async () => {
    server.mode = 'off';
    const service = new CallService(fakeMls);

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('idle');
    expect(service.currentCallId).toBeNull();
  });

  it('rings on an invite the held-off build ignores', async () => {
    const service = new CallService(fakeMls);

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('incoming');
    expect(service.currentCallId).toBe('call-1');
    expect(service.incomingCallerId).toBe('peer@example.org');
  });

  it('does not ring on an invite from a sender a block stands between', async () => {
    // A client that skips `initiate` and `ring` (both refused across a block) can still send the
    // MLS invite itself; the in-app ring is stopped here.
    vi.mocked(isBlockedWith).mockResolvedValueOnce(true);
    const service = new CallService(fakeMls);

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );

    expect(isBlockedWith).toHaveBeenCalledWith('peer@example.org');
    expect(get(service.callState)).toBe('idle');
    expect(service.currentCallId).toBeNull();
  });

  it('does not ring when it cannot ask whether a block stands', async () => {
    // A failure to ask is not an answer: no ring, said at error level.
    vi.mocked(isBlockedWith).mockRejectedValueOnce(new Error('blocks 503: unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CallService(fakeMls);

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('idle');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('holds the group leaf refresh from the ring until the call is over', async () => {
    // Each end derives the call keys from the group's CURRENT epoch, one after the other: a leaf
    // refresh between the two (a read receipt sent while it rings) gives them different keys.
    // A group of its own: the holds are process-wide, and the cases above leave calls ringing.
    const service = new CallService(fakeMls);
    expect(leafRefreshHold('group-held')).toBeNull();

    await service.handleCallSignal(
      'peer@example.org',
      'group-held',
      INVITE,
      'me@example.org',
      'device-1'
    );
    expect(get(service.callState)).toBe('incoming');
    expect(leafRefreshHold('group-held')).toBe('call');
    expect(leafRefreshHold('group-other')).toBeNull();

    service.endCall(false);
    expect(get(service.callState)).toBe('idle');
    expect(leafRefreshHold('group-held')).toBeNull();
  });

  it('does not ring on an invite from a build before the ring window', async () => {
    // Such an invite would ring until someone touched it: nothing on this side could end it.
    const service = new CallService(fakeMls);
    const { ringTimeoutMs: _, ...older } = INVITE;

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      older,
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('idle');
  });
});
