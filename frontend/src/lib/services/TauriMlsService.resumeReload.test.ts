// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { TauriMlsService } from './TauriMlsService';

/**
 * The resume reload must not put a ratchet BACK, and the refusal is decided natively.
 *
 * `recharger_mls_au_resume` answers with a typed outcome. `reload_is_monotonic` grades EPOCHS, and a
 * send or a decrypted frame moves a GENERATION inside one: the native command asks the live manager
 * (`has_unsaved_ratchet_advance`) under the manager lock, so a receive is covered as well as a send
 * and nothing can land between the check and the swap. What THIS side owes is the consequence: on
 * `live-ahead` it persists the live state, and on every other outcome it does not.
 */
interface ServiceInternals {
  _deviceKeyB64: string;
  reloadStateFromDisk(): Promise<void>;
}

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc._deviceKeyB64 = 'a'.repeat(44);
  return svc;
}

const commands = (): string[] => invoke.mock.calls.map((c) => c[0] as string);

describe('TauriMlsService.reloadStateFromDisk - the resume that must not rewind a ratchet', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('refreshes the group cache AND each epoch when mls.bin was installed', async () => {
    const svc = makeService();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'recharger_mls_au_resume' ? 'reloaded' : cmd === 'obtenir_epoch' ? 3 : ['g1']
    );
    await svc.reloadStateFromDisk();
    expect(commands()).toEqual(['recharger_mls_au_resume', 'lister_groupes', 'obtenir_epoch']);
  });

  it('PERSISTS the live state when the native side reports it is ahead of the file', async () => {
    const svc = makeService();
    // A RECEIVE the file does not hold: no send was counted, which is what the old WebView-side
    // watermark could not see and why this had to move into Rust.
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'recharger_mls_au_resume' ? 'live-ahead' : 8
    );
    await svc.reloadStateFromDisk();
    // Leaving the divergence on disk would only move the same rewind to the next resume, and would
    // hand a background engine a starting state that is already behind.
    expect(commands()).toContain('sauvegarder_mls_et_persister');
    expect(commands()).not.toContain('lister_groupes');
  });

  it.each(['nothing-on-disk', 'epoch-regression'])(
    'does nothing more on %s: no persist, no cache refresh',
    async (outcome) => {
      const svc = makeService();
      invoke.mockResolvedValue(outcome);
      await svc.reloadStateFromDisk();
      expect(commands()).toEqual(['recharger_mls_au_resume']);
    }
  );

  it('survives a failed persist after live-ahead without aborting the resume', async () => {
    const svc = makeService();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'recharger_mls_au_resume') return 'live-ahead';
      throw new Error('disk full');
    });
    await expect(svc.reloadStateFromDisk()).resolves.toBeUndefined();
  });

  it('skips without touching native state when the session holds no device key', async () => {
    const svc = makeService();
    svc._deviceKeyB64 = '';
    await svc.reloadStateFromDisk();
    expect(invoke).not.toHaveBeenCalled();
  });
});
