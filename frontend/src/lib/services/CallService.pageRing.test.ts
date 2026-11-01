// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client';

/**
 * The page tells the native side which call it rings - the one its `CallService` is `incoming` on -
 * because the iPhone's handover ends an UNANSWERED CallKit ring only when the page rings THAT call.
 * "The page holds a socket" did not say it: a call rung at the PIN gate had its invite skipped, and
 * the socket the unlock opened rang nothing (review of #2785; calls.md, "The handover ends an
 * unanswered ring only when the page rings that call").
 */

const report = vi.fn();
let tauri = true;
let holders = 0;

vi.mock('./pageGatewaySocket', () => ({
  reportPageRingingCall: (holder: string, callId: string | null) => report(holder, callId),
  reportPageGatewaySocket: vi.fn(),
  nextPageRingHolder: (kind: string) => `${kind}-${++holders}`,
}));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => tauri }));
vi.mock('$lib/features', () => ({ CALLS_ENABLED: true, CALLS_VIDEO_ENABLED: true }));
vi.mock('../workers/encryption.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn(async () => {}) }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => 'token' }));

const { CallService } = await import('./CallService');
const fakeMls = { getDeviceId: () => 'device-1' } as unknown as IMlsService;

/** Moves the service as its own code does: the call id is set before `incoming`, cleared after. */
function ring(service: InstanceType<typeof CallService>, callId: string) {
  service.currentCallId = callId;
  service.callState.set('incoming');
}

describe('the call the page rings, told to the native side', () => {
  afterEach(() => {
    report.mockClear();
    tauri = true;
  });

  it('names the call on entering `incoming` and withdraws it on leaving, never on a repeat', () => {
    const service = new CallService(fakeMls);
    expect(report).not.toHaveBeenCalled();

    ring(service, 'call-1');
    service.callState.set('incoming');
    service.callState.set('incall');
    service.callState.set('ended');
    service.callState.set('idle');

    const holder = report.mock.calls[0][0];
    expect(holder).toMatch(/^call-service-/);
    expect(report.mock.calls).toEqual([
      [holder, 'call-1'],
      [holder, null],
    ]);
  });

  it('a declined ring (incoming -> idle) withdraws it too', () => {
    const service = new CallService(fakeMls);
    ring(service, 'call-2');
    service.callState.set('idle');
    service.currentCallId = null;
    expect(report.mock.calls.map((c) => c[1])).toEqual(['call-2', null]);
  });

  it('an outgoing call is not a ring of this page', () => {
    const service = new CallService(fakeMls);
    service.currentCallId = 'call-3';
    service.callState.set('calling');
    service.callState.set('incall');
    expect(report).not.toHaveBeenCalled();
  });

  it('two services are two holders, so one leaving `incoming` never withdraws the other', () => {
    const one = new CallService(fakeMls);
    const two = new CallService(fakeMls);
    ring(one, 'call-4');
    ring(two, 'call-4');
    one.callState.set('idle');
    const [a, b] = [report.mock.calls[0][0], report.mock.calls[1][0]];
    expect(a).not.toBe(b);
    expect(report.mock.calls).toEqual([
      [a, 'call-4'],
      [b, 'call-4'],
      [a, null],
    ]);
  });

  it('follows the call id too, whichever of the id and the state is written last', () => {
    const service = new CallService(fakeMls);
    service.callState.set('incoming');
    expect(report).not.toHaveBeenCalled();
    service.currentCallId = 'call-6';
    service.currentCallId = 'call-7';
    service.currentCallId = null;
    expect(report.mock.calls.map((c) => c[1])).toEqual(['call-6', 'call-7', null]);
  });

  it('a replaced service withdraws the call it rang and says nothing more', () => {
    const service = new CallService(fakeMls);
    ring(service, 'call-8');
    service.retireFromPageRing();
    service.retireFromPageRing();
    service.callState.set('idle');
    ring(service, 'call-9');
    const holder = report.mock.calls[0][0];
    expect(report.mock.calls).toEqual([
      [holder, 'call-8'],
      [holder, null],
    ]);
  });

  it('a retired service that rang nothing withdraws nothing', () => {
    const service = new CallService(fakeMls);
    service.retireFromPageRing();
    expect(report).not.toHaveBeenCalled();
  });

  it('a browser page states nothing: there is no native ring to tell', () => {
    tauri = false;
    const service = new CallService(fakeMls);
    ring(service, 'call-5');
    expect(report).not.toHaveBeenCalled();
  });
});
