// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { TauriMlsService } from './TauriMlsService';
import { StagedCommitPendingError } from '$lib/mls-client/commitSubmission';
import type { AuthoredFrame } from '$lib/mls-client/mlsDeliveryApi';

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
  unresolvedGroups: Set<string> | null;
  reloadStateFromDisk(): Promise<void>;
  settleUnresolvedCommits(): Promise<void>;
}

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc._deviceKeyB64 = 'a'.repeat(44);
  // The settle a reload starts is its own test below; here it crosses into nothing.
  vi.spyOn(svc, 'settleUnresolvedCommits').mockResolvedValue(undefined);
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

  it('settles what the installed state holds staged, after dropping the index the old state built', async () => {
    // A background Welcome staged its Add in mls.bin and never read the answer: the state this
    // reload installed holds a commit this session has never seen, and a send must not pass it.
    const svc = makeService();
    svc.unresolvedGroups = new Set();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'recharger_mls_au_resume' ? 'reloaded' : cmd === 'obtenir_epoch' ? 3 : ['g1']
    );
    await svc.reloadStateFromDisk();
    expect(svc.unresolvedGroups).toBeNull();
    expect(svc.settleUnresolvedCommits).toHaveBeenCalledTimes(1);
  });

  it('drops the index BEFORE the swap, so a send racing it re-reads the state', async () => {
    const svc = makeService();
    svc.unresolvedGroups = new Set();
    let atSwap: Set<string> | null | undefined;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'recharger_mls_au_resume') {
        atSwap = svc.unresolvedGroups;
        return 'nothing-on-disk';
      }
      return 8;
    });
    await svc.reloadStateFromDisk();
    expect(atSwap).toBeNull();
  });

  it.each(['live-ahead', 'nothing-on-disk', 'epoch-regression'])(
    'settles nothing on %s - the live state, which this session already indexed, is kept',
    async (outcome) => {
      const svc = makeService();
      invoke.mockImplementation(async (cmd: string) =>
        cmd === 'recharger_mls_au_resume' ? outcome : 8
      );
      await svc.reloadStateFromDisk();
      expect(svc.settleUnresolvedCommits).not.toHaveBeenCalled();
    }
  );

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

describe('TauriMlsService.encryptForSend - the state refuses a send its staged commit forbids', () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  const encrypt = (svc: ServiceInternals) =>
    (
      svc as unknown as { encryptForSend(g: string, b: Uint8Array): Promise<AuthoredFrame> }
    ).encryptForSend('g-1', new Uint8Array([9]));

  it('returns the sealed frame and its author proof', async () => {
    invoke.mockResolvedValue({ status: 'sealed', ciphertext: [1, 2], authorProof: [3] });
    await expect(encrypt(makeService())).resolves.toEqual({
      sealed: new Uint8Array([1, 2]),
      authorProof: new Uint8Array([3]),
    });
  });

  it('throws the TYPED refusal the send path settles, when a commit is staged', async () => {
    invoke.mockResolvedValue({ status: 'commitPending' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(encrypt(makeService())).rejects.toBeInstanceOf(StagedCommitPendingError);
    warn.mockRestore();
  });
});
