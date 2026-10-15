// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { TauriMlsService } from './TauriMlsService';

/**
 * A STATE OPENED BY THE RECOVERY IS LISTED LIKE ONE OPENED AT START-UP. `openLocalStateWithKey`
 * marks the client initialised, so the login after a PIN recovery skips `_initImpl` and its group
 * listing: the restore then read "0/1 ... missing" for a group the native manager held, and the
 * re-add's external join failed with "already present locally" (iPhone 12, 2026-10-15).
 */
describe('TauriMlsService.openLocalStateWithKey - the group caches', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'lister_groupes') return ['group-held'];
      return undefined;
    });
  });

  it('lists the groups the opened state holds, so the restore check sees them', async () => {
    const svc = new TauriMlsService();
    (svc as unknown as { deviceId: string }).deviceId = 'device-1';

    const result = await svc.openLocalStateWithKey('user-1', 'k'.repeat(44), new Uint8Array([1]));

    expect(result.opened).toBe(true);
    expect(svc.getLocalGroups()).toEqual(['group-held']);
  });
});
