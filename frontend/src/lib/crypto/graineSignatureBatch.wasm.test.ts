/**
 * F7: the TS packer against the BUILT engine, not only against a hex vector both sides copy.
 *
 * `packGraineSignatureChecks` (TS) and `unpack_graine_signature_checks` (Rust) are held together by
 * a shared vector in `graineV2.test.ts` and `graine_signature.rs`; this runs the real WASM export on
 * what the real packer builds, so a drift in either - a field order, an endianness, a count - fails
 * here. The WASM is a build artefact: `bun run generate` locally, `build-mls-wasm` in CI before the
 * frontend tests. It is required, never skipped: a missing module fails this file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packGraineSignatureChecks, type GraineSignatureCheck } from '$lib/crypto/graineV2';
import * as wasm from '$lib/wasm/mls_wasm.js';

beforeAll(() => {
  const bytes = readFileSync(fileURLToPath(new URL('../wasm/mls_wasm_bg.wasm', import.meta.url)));
  wasm.initSync({ module: bytes });
});

function sessionPair(): { secret: Uint8Array; publicKey: Uint8Array } {
  const pair = wasm.graine_session_keypair() as { secret: Uint8Array; public: Uint8Array };
  return { secret: pair.secret, publicKey: pair.public };
}

describe('graine_verify_signatures, the built WASM, on the TS packer', () => {
  it('answers each packed check exactly what the single export answers it', () => {
    const a = sessionPair();
    const b = sessionPair();
    const message = (i: number) => new TextEncoder().encode(`row-${i}`);
    const sig = (i: number) => wasm.graine_sign_with_session_key(a.secret, message(i));
    const checks: GraineSignatureCheck[] = [
      { publicKey: a.publicKey, message: message(0), signature: sig(0) },
      { publicKey: b.publicKey, message: message(1), signature: sig(1) },
      { publicKey: a.publicKey, message: message(9), signature: sig(2) },
      { publicKey: a.publicKey.slice(0, 31), message: message(3), signature: sig(3) },
      { publicKey: a.publicKey, message: message(4), signature: sig(4).slice(0, 63) },
      { publicKey: a.publicKey, message: new Uint8Array(0), signature: new Uint8Array(0) },
      { publicKey: a.publicKey, message: message(6), signature: sig(6) },
    ];

    const batch = wasm.graine_verify_signatures(packGraineSignatureChecks(checks));
    const single = checks.map((c) =>
      wasm.graine_verify_signature(c.publicKey, c.message, c.signature)
    );

    expect(batch).toEqual(single);
    expect(batch).toEqual([
      'valid',
      'invalid',
      'invalid',
      'malformed-public-key',
      'malformed-signature',
      'malformed-signature',
      'valid',
    ]);
  });

  it('answers an empty batch with no verdict', () => {
    expect(wasm.graine_verify_signatures(packGraineSignatureChecks([]))).toEqual([]);
  });

  it('rejects a packing that does not parse, as a call failure and never as a verdict', () => {
    const packed = packGraineSignatureChecks([
      { publicKey: new Uint8Array(32), message: new Uint8Array(2), signature: new Uint8Array(64) },
    ]);
    expect(() => wasm.graine_verify_signatures(packed.slice(0, -1))).toThrow(/truncated/);
  });
});
