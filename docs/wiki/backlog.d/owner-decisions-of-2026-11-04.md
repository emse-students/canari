## Decided - the owner's answers of 2026-11-04

Decisions, not open questions; this entry is deleted when the last one is carried out.

- **Client floor**: `minClientVersion` is `1.6.2` on both estates, read back from each estate's
  `GET /api/version` ([legacy-compatibility](../legacy-compatibility.md#entries-162-unblocks-both-estates-read-it-2026-11-04)).
- **Stable `1.6.4`**: it ships only once EVERY reading of its pre-release passes. A minor
  non-regression failure still blocks it, and the answer is another alpha.
- **Blind salon banners ("Quelqu'un")**: the fix goes into `1.6.5`; the `1.6.4` stable does not wait
  for it.
- **Shim removals the floor unblocked**: they start after the `1.6.4` stable.
- **First old draft resumed after `1.6.4`**: #2832.
- **Pull-request iOS compile filter**: it covers `Cargo.toml`, `build.rs` and `tauri.conf.json`, not
  `Cargo.lock`.
- **Content-free push**: no request to Apple for the entitlement, only `groupId` dropped from
  `call_ring_end`, and the full path retired once few devices use it - already recorded in
  [content-free-push](../protocols/content-free-push.md) (N1, N2).
