// @vitest-environment happy-dom
// Stub Tauri internals before any import so the CJS module picks them up (same harness as
// PushNotificationService.test.ts: vi.mock cannot reach @tauri-apps/api/core).
const tauriInvokeStub = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === 'complete_owed_push_token_deletion') return Promise.resolve(true);
  if (cmd === 'get_fcm_token') return Promise.resolve('tok-123');
  return Promise.resolve(undefined);
});

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: { invoke: tauriInvokeStub, transformCallback: vi.fn() },
  writable: true,
  configurable: true,
});

vi.mock('@tauri-apps/plugin-os', () => ({ platform: vi.fn(() => 'ios') }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

import { startPushService } from './PushNotificationService';
import { flushMacrotask } from '../../test/flush';

/**
 * Production 2026-10-12: login starts the push service twice (`sessionAuth` and the root layout),
 * and both registered - two `[PUSH_REGISTER]` a second apart, each minting a secret that
 * invalidates the other. Which one the server kept and which one the device stored were decided
 * by two unrelated orders.
 */
describe('startPushService - one registration at a time', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('two overlapping starts send ONE registration and store the secret it returned', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    globalThis.fetch = vi.fn(async () => {
      await answered;
      return { ok: true, json: async () => ({ pushSecret: 'the-one' }), text: async () => '' };
    }) as unknown as typeof fetch;

    const first = startPushService('https://api', 'jwt', 'dev-ios');
    const second = startPushService('https://api', 'jwt', 'dev-ios');
    // Let both reach the network before the server answers - the window production hit.
    await flushMacrotask();
    answer();
    await Promise.all([first, second]);

    const registers = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/api/mls/push/register'));
    expect(registers).toHaveLength(1);
    const stores = tauriInvokeStub.mock.calls.filter(([cmd]) => cmd === 'store_push_secret');
    expect(stores).toHaveLength(1);
    expect(stores[0][1]).toEqual({ secret: 'the-one' });
  });
});
