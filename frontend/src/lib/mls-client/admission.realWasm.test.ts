// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE ADMISSION RULE THROUGH THE REAL WASM, not a mock: the build CI ships (`build-mls-wasm` runs
 * before vitest). A mock proves the TypeScript calls a method; only the compiled `mls-core` proves
 * the method exists, classifies, persists across a save, and - the whole point - refuses an external
 * commit that brings a user in on their own into a closed group, with the error TEXT the shared
 * classifier reads.
 */
const WASM = readFileSync(join(import.meta.dirname, '../wasm/mls_wasm_bg.wasm'));

describe('the admission rule through the real WASM client', () => {
  let bindings: typeof import('$lib/wasm/mls_wasm.js');

  beforeAll(async () => {
    bindings = await import('$lib/wasm/mls_wasm.js');
    bindings.initSync({ module: WASM });
  });

  const client = (user: string, device: string) =>
    new bindings.WasmMlsClient(user, device, undefined, undefined, false);

  it('classifies a group, reads it back, and says unclassified for one nobody classified', () => {
    const alice = client('alice', 'web-a');
    expect(alice.admission_policy('g-nobody')).toBe('unclassified');
    alice.set_admission_policy('g-conv', 'closed');
    alice.set_admission_policy('g-key', 'open');
    expect(alice.admission_policy('g-conv')).toBe('closed');
    expect(alice.admission_policy('g-key')).toBe('open');
    alice.free();
  });

  it('rejects a name it does not know, rather than classifying the group as something', () => {
    const alice = client('alice', 'web-a');
    expect(() => alice.set_admission_policy('g1', 'unclassified')).toThrow(
      /unknown admission policy/
    );
    expect(() => alice.set_admission_policy('g1', 'ajar')).toThrow(/unknown admission policy/);
    expect(alice.admission_policy('g1')).toBe('unclassified');
    alice.free();
  });

  it('keeps the classification across a save and a reload', () => {
    const alice = client('alice', 'web-a');
    alice.create_group('g-persist');
    alice.set_admission_policy('g-persist', 'closed');
    const saved = alice.save_state(undefined) as Uint8Array;
    alice.free();

    const reloaded = new bindings.WasmMlsClient('alice', 'web-a', saved, undefined, false);
    expect(reloaded.admission_policy('g-persist')).toBe('closed');
    reloaded.free();
  });

  /**
   * THE WHOLE POINT, ON THE COMPILED CRATE: a closed group refuses an external commit that brings a
   * user in on their own, the group is left as it was, and the error carries the marker and the
   * identity the shared classifier reads - the three things every layer above depends on.
   */
  it('refuses an external commit by a user the group does not hold, and leaves the group as it was', async () => {
    const { admissionRefusedEntrant, classifyIncomingDecryptError } =
      await import('./mlsDecryptError');
    const alice = client('alice', 'web-a');
    alice.create_group('g-closed');
    alice.set_admission_policy('g-closed', 'closed');
    const epochBefore = alice.get_epoch('g-closed');

    const mallory = client('mallory', 'web-m');
    const [, commit] = mallory.join_by_external_commit(
      alice.export_group_info('g-closed')
    ) as unknown as [string, Uint8Array];

    let thrown: unknown;
    try {
      alice.process_incoming_message_with_sender('g-closed', commit);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(classifyIncomingDecryptError(thrown)).toBe('admission-refused');
    expect(admissionRefusedEntrant(thrown)).toBe('mallory:web-m');
    expect(alice.get_epoch('g-closed')).toBe(epochBefore);
    expect(Array.from(alice.get_member_identities('g-closed') as string[])).toEqual([
      'alice:web-a',
    ]);
    alice.free();
    mallory.free();
  });

  it('merges the same commit once the group is classified open - a key group is entered this way', () => {
    const alice = client('alice', 'web-a');
    alice.create_group('g-open');
    alice.set_admission_policy('g-open', 'open');

    const carol = client('carol', 'web-c');
    const [, commit] = carol.join_by_external_commit(
      alice.export_group_info('g-open')
    ) as unknown as [string, Uint8Array];

    expect(() => alice.process_incoming_message_with_sender('g-open', commit)).not.toThrow();
    expect(Array.from(alice.get_member_identities('g-open') as string[])).toContain('carol:web-c');
    alice.free();
    carol.free();
  });
});
