import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFingerprintOf, keyPackageFingerprintOf, keyPackageSignatureKey } from './deviceTrust';

/**
 * The KeyPackage parser against the REAL WASM build: the signature key it reads from a published
 * package must be the very key the device signs its leaf with - what `member_signature_key` reads
 * from a tree. A member's approval of an unseen device is bound to that key
 * (`memberDeviceAnswers.ts`), so a parser that read the wrong field would bind nothing.
 */
const WASM = readFileSync(join(import.meta.dirname, '../wasm/mls_wasm_bg.wasm'));

describe('keyPackageSignatureKey - read from the bytes the real WASM publishes', () => {
  let bindings: typeof import('$lib/wasm/mls_wasm.js');

  beforeAll(async () => {
    bindings = await import('$lib/wasm/mls_wasm.js');
    bindings.initSync({ module: WASM });
  });

  it("names the key the device's own leaf carries", async () => {
    const client = new bindings.WasmMlsClient('bob', 'phone-bob', undefined, undefined, false);
    client.create_group('group-kp-parse');
    const leafKey = client.member_signature_key('group-kp-parse', 'bob:phone-bob');
    const [dated] = client.generate_key_packages(1);
    const published = dated.public;
    expect(leafKey).toBeDefined();
    expect(Array.from(keyPackageSignatureKey(published))).toEqual(Array.from(leafKey!));
    expect(await keyPackageFingerprintOf(published)).toBe(await keyFingerprintOf(leafKey!));
    dated.free();
    client.free();
  });

  it('the key a waiting device shows its owner is the key a member is asked to approve', async () => {
    // The owner compares the two fingerprints by eye: the one their waiting device shows
    // (`own_signature_key`) and the one the member's ask shows (read from the published package).
    const client = new bindings.WasmMlsClient('bob', 'phone-bob', undefined, undefined, false);
    const own = client.own_signature_key();
    const [dated] = client.generate_key_packages(1);
    expect(await keyFingerprintOf(own)).toBe(await keyPackageFingerprintOf(dated.public));
    dated.free();
    client.free();
  });

  it('tells two devices apart by their packages', async () => {
    const one = new bindings.WasmMlsClient('bob', 'phone-1', undefined, undefined, false);
    const two = new bindings.WasmMlsClient('bob', 'phone-2', undefined, undefined, false);
    const [a] = one.generate_key_packages(1);
    const [b] = two.generate_key_packages(1);
    expect(await keyPackageFingerprintOf(a.public)).not.toBe(
      await keyPackageFingerprintOf(b.public)
    );
    a.free();
    b.free();
    one.free();
    two.free();
  });

  it('refuses bytes that are not a KeyPackage', () => {
    expect(() => keyPackageSignatureKey(new Uint8Array([0, 1, 0, 1, 0x40]))).toThrow(/truncated/);
  });
});
