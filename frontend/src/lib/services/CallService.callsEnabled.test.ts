import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService } from './CallService';

/**
 * The other half of CallService.disabled.test.ts: the same invite, with CALLS_ENABLED on. It proves
 * the sibling file measures the guard rather than a broken signal handler, and it is what will
 * still be green on the day the constant is flipped back for real (rung 15 CALL / CALL-13).
 */

vi.mock('$lib/features', () => ({ CALLS_ENABLED: true }));
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

describe('CallService with calls enabled', () => {
  it('rings on an invite the held-off build ignores', () => {
    const service = new CallService(fakeMls);

    service.handleCallSignal('peer@example.org', 'group-1', INVITE, 'me@example.org', 'device-1');

    expect(get(service.callState)).toBe('incoming');
    expect(service.currentCallId).toBe('call-1');
    expect(service.incomingCallerId).toBe('peer@example.org');
  });
});
