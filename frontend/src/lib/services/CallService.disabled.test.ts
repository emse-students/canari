import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService } from './CallService';

/**
 * CALLS_ENABLED holds the whole calling surface off (frontend/src/lib/features.ts). The buttons are
 * simply not rendered, so what needs proving here is the half no UI can cover: an invite sent by a
 * peer still running an older build arrives as an ordinary MLS frame, and must not raise a ring.
 *
 * Its pair is CallService.callsEnabled.test.ts, which runs the SAME invite with the switch on. That
 * pairing is the point: "nothing happened" passes just as well when handleCallSignal is broken for
 * an unrelated reason, and only the other file rules that out. The switch is mocked rather than
 * read so the pair keeps its meaning after the constant is flipped back for real.
 */

vi.mock('$lib/features', () => ({ CALLS_ENABLED: false }));
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

/** An invite exactly as a peer on an older build still sends it. */
const INVITE = { callId: 'call-1', hasVideo: true, offerSdp: 'START', deviceId: 'device-2' };

describe('CallService with calls held off', () => {
  it('ignores an invite from a legacy peer and never leaves idle', () => {
    const service = new CallService(fakeMls);

    service.handleCallSignal('peer@example.org', 'group-1', INVITE, 'me@example.org', 'device-1');

    expect(get(service.callState)).toBe('idle');
    expect(service.currentCallId).toBeNull();
    expect(service.incomingCallerId).toBeNull();
  });

  it('refuses to start an outgoing call without touching the network', async () => {
    const service = new CallService(fakeMls);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await service.startCall('group-1', false);

    expect(get(service.callState)).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
