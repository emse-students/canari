// @vitest-environment happy-dom
// Break the app-wide import cycle the way `TauriMlsService.pushReconcile.test.ts` does.
vi.mock('$lib/services/WebMlsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

import { TauriMlsService } from './TauriMlsService';
import { WebMlsService } from './WebMlsService';

/**
 * THE DEVICE ID'S PREFIX NAMES THE RUNTIME THAT MINTED IT, and the server reads it as such: the
 * delivery service's push coverage (`apps/chat-delivery-service/src/utils/push-coverage.ts`,
 * `INSTALLED_APP_DEVICE_PREFIX`) counts only `tauri-` ids as phones that owe a push registration, because
 * `deviceOs` is the user agent's word on the web and a phone browser states `android`/`ios`
 * (production, 2026-11-22: 43 phone browsers read as phones without push). Renaming a prefix here
 * silently moves devices in or out of that count - change both sides together.
 */
type Minting = { generateDeviceId(userId: string): string };

describe('the device id prefix push-coverage.ts depends on', () => {
  it('the native app mints `tauri-` ids (push-coverage.ts INSTALLED_APP_DEVICE_PREFIX)', () => {
    const id = (new TauriMlsService() as unknown as Minting).generateDeviceId('u1');
    expect(
      id.startsWith('tauri-u1-'),
      `push-coverage.ts counts tauri- ids as the native app; got ${id}`
    ).toBe(true);
  });

  it('a browser mints `web-` ids (push-coverage.ts BROWSER_DEVICE_PREFIX)', () => {
    const id = (new WebMlsService() as unknown as Minting).generateDeviceId('u1');
    expect(
      id.startsWith('web-u1-'),
      `push-coverage.ts counts web- ids as phone browsers; got ${id}`
    ).toBe(true);
  });
});
