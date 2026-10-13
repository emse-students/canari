/**
 * Freezes ONE framed v2 MLS state blob, sealed by the web writer itself, for `mls-core` to read.
 *
 *   bun scripts/freeze-v2-state-blob-fixture.ts        (from frontend/)
 *
 * WHY A FIXTURE AND NOT A RUST ROUND TRIP. The v2 writer is TypeScript (WebCrypto) and the reader
 * is Rust (`mls-core/src/state_blob.rs`): a test that sealed in Rust and opened in Rust would prove
 * the reader agrees with ITSELF. These bytes are what `src/lib/mls-client/mlsStateSeal.ts` actually
 * wrote, so `mls-core/tests/state_blob_v2.rs` opening them proves the two implementations agree -
 * the derivation, the header-as-AAD, the IV and tag placement - and keeps proving it when either
 * side's crypto dependency moves.
 *
 * THE PLAINTEXT IS THE v0.14.14 PEER STATE, the throwaway `bob:dev1` identity the cross-version
 * fixtures already commit (see `mls-core/tests/cross_version_state.rs` on why that is safe in a
 * public repository); the key is `params::DEVICE_KEY`, `[7; 32]`. It REFUSES TO OVERWRITE: a
 * regenerated fixture is a round trip, which is the thing this file exists not to be.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sealMlsStateBlobV2 } from '../src/lib/mls-client/mlsStateSeal';

const fixtures = join(import.meta.dir, '..', 'mls-core', 'tests', 'fixtures');
const out = join(fixtures, 'webcrypto-v2-peer-state.bin');
const plain = new Uint8Array(readFileSync(join(fixtures, 'v0.14.14-peer-state.bin')));
const deviceKeyB64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const sealed = await sealMlsStateBlobV2(plain, deviceKeyB64);
try {
  // 'wx' fails if the file exists, so the check and the write are one atomic step.
  writeFileSync(out, sealed, { flag: 'wx' });
} catch (err) {
  console.error(`[freeze] ${out} exists or is not writable - restore it from git rather than regenerating it: ${err}`);
  process.exit(1);
}
console.log(`[freeze] wrote ${out}: ${plain.length} B plain -> ${sealed.length} B sealed`);
