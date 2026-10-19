import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService } from './CallService';
import { isBlockedWith } from '$lib/users/blocks';

/**
 * The other half of CallService.disabled.test.ts: the same invite, with CALLS_ENABLED on. It proves
 * the sibling file measures the guard rather than a broken signal handler, and it is what will
 * still be green on the day the constant is flipped back for real (rung 15 CALL / CALL-13).
 */

vi.mock('$lib/features', () => ({ CALLS_ENABLED: true }));
vi.mock('$lib/users/blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/users/blocks')>()),
  isBlockedWith: vi.fn(async () => false),
}));
vi.mock('../workers/encryption.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn() }));
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
