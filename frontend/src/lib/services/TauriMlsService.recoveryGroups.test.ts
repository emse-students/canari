// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import 'fake-indexeddb/auto';
import { TauriMlsService } from './TauriMlsService';
import { LocalStateNotReadyError } from '$lib/mls-client';
import { noteFrameEmitted } from '$lib/mls-client/sendRatchetLedger';

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
      if (cmd === 'obtenir_epoch') return 3;
      if (cmd === 'lire_ledgers_mls') return {};
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

  it('refuses the open with a typed error when the listing fails, never running on an empty cache', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'lister_groupes') throw new Error('native manager busy');
      return undefined;
    });
    const svc = new TauriMlsService();
    (svc as unknown as { deviceId: string }).deviceId = 'device-1';

    await expect(
      svc.openLocalStateWithKey('user-1', 'k'.repeat(44), new Uint8Array([1]))
    ).rejects.toBeInstanceOf(LocalStateNotReadyError);
    // Not marked initialised: the login's `init` must not reuse a state it could not describe.
    expect((svc as unknown as { initPromise: unknown }).initPromise).toBeNull();
  });

  it('burns the generations this device sent but never checkpointed, as init does', async () => {
    await noteFrameEmitted('user-1', 'group-held', 3);
    await noteFrameEmitted('user-1', 'group-held', 3);
    const svc = new TauriMlsService();
    (svc as unknown as { deviceId: string }).deviceId = 'device-1';

    await svc.openLocalStateWithKey('user-1', 'k'.repeat(44), new Uint8Array([1]));

    expect(invoke).toHaveBeenCalledWith('skip_send_generations', {
      groupId: 'group-held',
      count: 2,
    });
  });

  it('hands a concurrent init the open in progress instead of a second native initialisation', async () => {
    let releaseListing: (groups: string[]) => void = () => {};
    let listingAsked: () => void = () => {};
    const asked = new Promise<void>((r) => (listingAsked = r));
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'lister_groupes') {
        listingAsked();
        return new Promise<string[]>((r) => (releaseListing = r));
      }
      if (cmd === 'lire_ledgers_mls') return {};
      return undefined;
    });
    const svc = new TauriMlsService();
    (svc as unknown as { deviceId: string }).deviceId = 'device-1';

    const open = svc.openLocalStateWithKey('user-1', 'k'.repeat(44), new Uint8Array([1]));
    await asked;
    const initCallsBefore = invoke.mock.calls.filter((c) => c[0] === 'initialiser_mls').length;
    const concurrent = svc.init('user-1', 'k'.repeat(44), new Uint8Array([1]));
    releaseListing(['group-held']);
    await Promise.all([open, concurrent]);

    expect(invoke.mock.calls.filter((c) => c[0] === 'initialiser_mls').length).toBe(
      initCallsBefore
    );
  });
});

/**
 * A DELETION GATED ON KNOWING. `hydrateDistributionGroups` deletes every key-group row whose group
 * `getLocalGroups()` does not name; read from a cache nobody filled, that was every row (iPhone 12,
 * 2026-10-15: "0 group(s), 1 row(s) for groups no longer held deleted").
 */
describe('TauriMlsService.hydrateDistributionGroups - a cache never listed', () => {
  it('deletes no row when the held groups were never listed', async () => {
    invoke.mockReset();
    const store = {
      getDistributionGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'group-held', workspaceId: 'ws-1', channelId: null }]),
      deleteDistributionGroup: vi.fn().mockResolvedValue(undefined),
      putDistributionGroup: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new TauriMlsService();
    svc.setDistributionGroupStore(store as never);

    await svc.hydrateDistributionGroups();

    expect(store.deleteDistributionGroup).not.toHaveBeenCalled();
  });
});
