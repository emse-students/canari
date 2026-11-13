## Reading owed - the CORRUPT-2 rig row on a build since `v1.3.0`

target: 1.7.0

Typed errors, the honest message naming the reset, and the blob-header READER (step 1) shipped in
`v0.18.18` (#901). **Step 2 SHIPPED in `v1.3.0` (PK1, #2001)**:
`minClientVersion` is past the reader, so `encrypt_state_blob_with_key` frames every save
and a failed load is classified from the header - `STATE_KEY_MISMATCH` (`rotated`: the old PIN opens
it, and the gate now says so) or `STATE_ALTERED` (`altered`: the header names the key in hand, no PIN
ever opens it, so `init` rotates the device identity like a `mismatch` - DE7's route without the old
PIN). It is NOT a re-enrol fallback: only the fingerprint routes to the rotation, and a legacy blob
still pauses as `undecryptable` until its first rewrite. The init throws typed errors
(`SavedStateUnopenedError`), so `serverProse.test.ts`'s allowlist is empty. The mechanism is on
[mls-protocol](../protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later). **Owed:
the CORRUPT-2 rig row on a local estate running a build since `v1.3.0`** ([cross-client-testing](../cross-client-testing.md),
runner `tools/cross-client-harness/archive/corrupt2.mjs`) - its expected verdict is now a ROTATION
with no PIN asked, not the old-PIN gate. **Downgrade: no client may be rolled back past `v0.18.18`.**
