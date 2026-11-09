## P3 - The device notices trust the server's word on a key's age (review of #2791, 2026-10-31)

Not built; two edges of one mechanism (`isNewToItsOwner`, `KeyFirstSight`,
[mls-protocol](../protocols/mls-protocol.md)).

- **A lying server suppresses the in-app notices.** A false old date, or the key listed undated,
  reads as old, so neither "X a ajouté un appareil" nor the in-app owner alert is written. Only the
  Android native owner alert holds. Narrowest hardening for the owner's alert on every platform:
  persist the own-account key fingerprints `preclaimOldOwnDevices` sees at this device's
  registration, and alert on any later own key outside that snapshot whatever its age - heals of old
  own devices stay quiet, since they are in it. Contact lines have no client-side proof: accepted.
- **An erased account's leftover leaf reads as `unknown`, hence new.** Erasure deletes the key
  history (`DeviceSignatureKey`, `internal.controller.ts`), so a fresh install meeting such a leaf
  before it is collected writes a false "X a ajouté un appareil" - `unknown` has no date, so the
  7-day window does not bound it either.
