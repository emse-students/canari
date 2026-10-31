// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService } from './CallService';
import { setPendingCallAccept, takePendingCallAccept } from '$lib/stores/pendingCallAccept';

/**
 * An answer given on the ring (the Android CallStyle notification, iOS CallKit) joins the call from
 * the facts the ring carried, with NO MLS `call_invite`: the server delivers that transport frame
 * only to a device online when it is sent (`TRANSPORT_SKIPPED_OFFLINE`), and a phone rung while
 * closed was not. Before this, the answer waited for that invite, which never came, and the call
 * rang out into "missed" on both sides (1.5.2-alpha.1). calls.md, "An answer from the ring joins on
 * the ring's facts".
 */

vi.mock('$lib/features', () => ({ CALLS_ENABLED: true, CALLS_VIDEO_ENABLED: true }));
vi.mock('$lib/stores/appVersionCheck.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => 'audio',
  getAppVersionCheck: () => ({}),
  refreshAppVersionCheck: async () => {},
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

const INVITE = {
  callId: 'call-1',
  hasVideo: false,
  offerSdp: 'START',
  deviceId: 'device-2',
  ringTimeoutMs: 60_000,
};

/** The answer as the ring hands it over: the facts of the ring push, and when it was tapped. */
function answerOnTheRing(overrides: Partial<Parameters<typeof setPendingCallAccept>[0]> = {}) {
  setPendingCallAccept({
    groupId: 'group-1',
    callId: 'call-1',
    hasVideo: false,
    callerId: 'Peer@Example.org',
    acceptedAt: Date.now(),
    ...overrides,
  });
}

/** A service whose join is observed rather than run (no SFU, no media in a unit test). */
function serviceObservingTheJoin() {
  const service = new CallService(fakeMls);
  const accept = vi.spyOn(service, 'acceptCall').mockResolvedValue();
  return { service, accept };
}

describe('an answer given on the ring', () => {
  afterEach(() => {
    takePendingCallAccept();
  });

  it('joins the call with no invite ever delivered to this device', () => {
    const { service, accept } = serviceObservingTheJoin();
    answerOnTheRing();

    service.answerFromSystemSurface('the socket connected');

    expect(accept).toHaveBeenCalledWith('group-1', 'call-1');
    expect(service.currentCallId).toBe('call-1');
    expect(service.currentGroupId).toBe('group-1');
    expect(service.incomingCallerId).toBe('peer@example.org');
    expect(service.incomingHasVideo).toBe(false);
    expect(get(service.callState)).toBe('incoming');
    // Taken once: a second socket connection does not join it again.
    service.answerFromSystemSurface('the socket connected again');
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('keeps video when the ring said video', () => {
    const { service } = serviceObservingTheJoin();
    answerOnTheRing({ hasVideo: true });
    service.answerFromSystemSurface('test');
    expect(service.incomingHasVideo).toBe(true);
  });

  it('answers the same call when its invite did reach this device first', async () => {
    const { service, accept } = serviceObservingTheJoin();
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );
    expect(get(service.callState)).toBe('incoming');
    answerOnTheRing();

    service.answerFromSystemSurface('the answer was recorded');

    expect(accept).toHaveBeenCalledWith('group-1', 'call-1');
  });

  it('is not rung again by an invite of the same call arriving after the join began', async () => {
    const { service } = serviceObservingTheJoin();
    answerOnTheRing();
    service.answerFromSystemSurface('test');
    // The join moved on (acceptCall sets `incall`); the late invite is that call's redelivery.
    service.callState.set('incall');

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      INVITE,
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('incall');
    expect(service.currentCallId).toBe('call-1');
  });

  it('drops an answer recorded too long ago', () => {
    const { service, accept } = serviceObservingTheJoin();
    answerOnTheRing({ acceptedAt: Date.now() - 10 * 60_000 });

    service.answerFromSystemSurface('test');

    expect(accept).not.toHaveBeenCalled();
    expect(get(service.callState)).toBe('idle');
  });

  it('does not drop a call this device is already in', async () => {
    const { service, accept } = serviceObservingTheJoin();
    await service.handleCallSignal(
      'peer@example.org',
      'group-2',
      { ...INVITE, callId: 'call-other' },
      'me@example.org',
      'device-1'
    );
    service.callState.set('incall');
    answerOnTheRing();

    service.answerFromSystemSurface('test');

    expect(accept).not.toHaveBeenCalled();
    expect(service.currentCallId).toBe('call-other');
    expect(get(service.callState)).toBe('incall');
  });

  it('does nothing when no answer is pending', () => {
    const { service, accept } = serviceObservingTheJoin();
    service.answerFromSystemSurface('the socket connected');
    expect(accept).not.toHaveBeenCalled();
    expect(get(service.callState)).toBe('idle');
  });
});
