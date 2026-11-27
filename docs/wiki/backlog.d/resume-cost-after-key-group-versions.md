## P2 - a resume still re-registers the device and reloads mls.bin, whatever changed (2026-11-22)

target: 1.8.7

The owner's Android log (1.7.1, 2026-11-19..22, 131 resumes) named three costs per resume; the first,
the key-group passes of unchanged communities, is closed by the key-group versions
([offline-and-weak-network](../frontend/offline-and-weak-network.md#a-return-re-reads-the-key-group-only-of-a-community-that-changed-2026-11-22)).
The two left were investigated on 2026-11-22 and are NOT a log line or a timer to add:

### The key-package round on every socket open is a real `register-device`

`KeyPackage published` (126 resumes, with `generateKeyPackage native batch path needed=0`) is true.
`syncConnectionAfterWsOpen` (`mls-client/initializeConnection.ts`) runs `generateKeyPackage(..,
{ fresh: true })` on every socket open: `GET .../prekeys/count`, the native mint (which since #458
writes nothing when `needed=0` and the last-resort is still valid), then ALWAYS
`publishKeyPackage(fallback)` = `POST /api/mls/register-device` with the SAME last-resort bytes, then
`reconcilePublishedKeyPackages`. Gating the POST on `needed > 0` would be wrong: the route does more
than store the package (`devices.controller.ts` `registerDevice`):

- it resets the row's `createdAt`, which the device list's 30-day cutoff reads - a device that stops
  re-registering drops out of the list peers invite;
- it writes a pending seat in every group the user is in (`writePendingSeats`, idempotent);
- it answers `push.registered`, on which the client re-drives a missing push token
  (`reconcilePushRegistration`).

**What a gate on a fact needs:** the count route (already read each round) to also say whether the
row holds exactly this package (a digest of `keyPackage`) and whether a re-registration would change
anything a reader of the row uses - the cutoff's `createdAt` being the hard part, since "registered
recently" is a clock unless the cutoff itself is re-expressed as durable state (for example the
device list counting a device live while its socket is open or it holds a session). The push
answer can move to the count route. Old servers: the fields absent, the POST as today.

### The `mls.bin` reload on every resume is a full read, decrypt and install

`recharger_mls_au_resume` (`src-tauri/src/commands/storage.rs`) reads, decrypts (Argon2 + AES) and
grades `mls.bin` against the live manager on every resume, under the checkpoint ordering lock and the
manager lock - 400-2000 ms on the Mi 9T (median preparation 666 ms, p90 1 747 ms, max 2 989 ms),
even for back-to-back resumes. It exists to pick up a background engine's write (an FCM decrypt,
a Welcome) while the app was hidden. **The fact that would let it skip:** whether any engine
OTHER than the live one wrote the file since the live manager last loaded or wrote it. Every write
goes through `write_mls_state_blob` under `mls_bin_write_lock`; a writer generation (a counter in a
sidecar written in the same critical section, or the SHA-256 of the sealed bytes the live manager
last loaded or wrote, compared with the file's) answers it without the decrypt. The care it needs:
the background engine runs in the same process on Android (JNI) and must be told apart from the
foreground's own writes, and the `live-ahead` grading (a live ratchet the file does not hold) must
keep its persist. Native, under three locks, and on the MLS state: an opus-reviewed change with a
Rust test of the skip and of a background write between two resumes - not folded into the PR that
shipped the key-group versions.

**Reading that closes it:** on the Mi 9T, 10 back-to-back resumes with no push received in between
show no `register-device` and no `mls.bin reloaded on resume` beyond the first, and a resume after a
push decrypted in the background still reloads.
