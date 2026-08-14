// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { TauriMlsService } from './TauriMlsService';

/**
 * The native half of `installUnlessOvertaken`, which the web service has had at every off-thread
 * swap and the native resume path never had.
 *
 * `recharger_mls_au_resume` guards the reload with `reload_is_monotonic`, which refuses a candidate
 * that would move a live group to a LOWER EPOCH. That is evidence for "is this snapshot from an
 * older epoch" and for nothing else. What a send moves is a GENERATION INSIDE one epoch: the epoch
 * guard sees nothing, the reload is accepted, the live ratchet goes back to wherever `mls.bin` was
 * left, and the next frame re-issues a spent generation. The peer refuses it with
 * `SecretReuseError` and reports, correctly, that the sender's ratchet rewound.
 *
 * The watermark below is the missing half: how many send-ratchet advances the file does NOT hold.
 */
/**
 * The service with its private members opened up.
 *
 * An intersection with the class collapses to `never` (the same names are private there), so the
 * view is declared standalone and reached through `unknown` - the usual shape for asserting on
 * internals that are private by design and load-bearing by accident.
 */
interface ServiceInternals {
  liveMutations: number;
  _deviceKeyB64: string;
  _mutationsAtLastPersist: number;
  reloadStateFromDisk(): Promise<void>;
  saveState(deviceKeyB64: string): Promise<Uint8Array>;
}

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc._deviceKeyB64 = 'a'.repeat(44);
  return svc;
}

describe('TauriMlsService.reloadStateFromDisk - the resume that must not rewind a ratchet', () => {
  beforeEach(() => invoke.mockReset());

  it('reloads when mls.bin holds every send this device has made', async () => {
    const svc = makeService();
    invoke.mockResolvedValue(true);
    await svc.reloadStateFromDisk();
    expect(invoke).toHaveBeenCalledWith('recharger_mls_au_resume', expect.anything());
  });

  it('REFUSES the reload while a send has not reached mls.bin', async () => {
    const svc = makeService();
    // One send since the last persist: the file is a generation behind the live client.
    svc.liveMutations = 1;
    svc._mutationsAtLastPersist = 0;
    invoke.mockResolvedValue(Array.from({ length: 8 }, () => 0));

    await svc.reloadStateFromDisk();

    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain('recharger_mls_au_resume');
  });

  it('persists the live state instead, so the NEXT resume is safe', async () => {
    const svc = makeService();
    svc.liveMutations = 3;
    svc._mutationsAtLastPersist = 1;
    invoke.mockResolvedValue(Array.from({ length: 8 }, () => 0));

    await svc.reloadStateFromDisk();

    // Leaving the divergence on disk would only move the same rewind to the next resume, and would
    // also hand a background engine a starting state that is already behind.
    expect(invoke.mock.calls.map((c) => c[0])).toContain('sauvegarder_mls_et_persister');
    expect(svc._mutationsAtLastPersist).toBe(3);
  });

  it('skips without touching native state when the session holds no device key', async () => {
    const svc = makeService();
    svc._deviceKeyB64 = '';
    await svc.reloadStateFromDisk();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('counts a send that lands DURING a persist as still unpersisted', async () => {
    const svc = makeService();
    invoke.mockImplementation(async (cmd: string) => {
      // A send racing the save: the snapshot the native side serialized cannot contain it.
      if (cmd === 'sauvegarder_mls_et_persister') svc.liveMutations++;
      return Array.from({ length: 8 }, () => 0);
    });

    svc.liveMutations = 1;
    await svc.saveState('a'.repeat(44));

    // Erring this way costs one refused reload; erring the other way costs a rewound ratchet.
    expect(svc._mutationsAtLastPersist).toBe(1);
    expect(svc.liveMutations).toBe(2);
  });
});
