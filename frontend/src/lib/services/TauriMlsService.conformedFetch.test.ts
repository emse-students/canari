vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { fetch as pluginFetch } from '@tauri-apps/plugin-http';
import { TauriMlsService } from './TauriMlsService';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';

/**
 * THE SECOND PLACE THE PLUGIN IS HANDED TO THE APP. `hooks.client.ts` conforms `window.fetch`
 * through `createRoutedFetch`; the delivery client of `TauriMlsService` takes the plugin's `fetch`
 * directly, so it must be conformed in the constructor too - or a send on Android/iOS rejects with
 * reqwest's bare string again, which no consumer reads as a network failure (Mi 9T, 2026-10-14).
 */
describe('TauriMlsService - the delivery client fetch', () => {
  it("rejects the plugin's bare-string failure as a TransportFailureError", async () => {
    const raw = 'error sending request for url (https://canari.emse.fr/api/mls/send)';
    vi.mocked(pluginFetch).mockRejectedValue(raw);
    const svc = new TauriMlsService() as unknown as { delivery: { f: typeof fetch } };

    const failure = await svc.delivery
      .f('https://canari.emse.fr/api/mls/send')
      .catch((e: unknown) => e);

    expect(pluginFetch).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(TransportFailureError);
    expect((failure as TransportFailureError).cause).toBe(raw);
    expect(isTransportFailure(failure)).toBe(true);
  });
});
