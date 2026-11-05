## Decided - the owner's answers of 2026-11-04

Decisions, not open questions; this entry is deleted when the last one is carried out.

- **Client floor**: `minClientVersion` is `1.6.2` on both estates, read back from each estate's
  `GET /api/version` ([legacy-compatibility](../legacy-compatibility.md#entries-162-unblocks-both-estates-read-it-2026-11-04)).
- **Every stable** (extended from `1.6.4` to all stables, owner, 2026-11-05): it ships only once
  EVERY reading of its pre-release passes. A minor non-regression failure still blocks it, and the
  answer is another alpha.
- **No `1.6.4` stable; production goes from `1.6.3` to `1.6.5`** (owner, 2026-11-05). Every
  `1.6.4-alpha.4` reading passed, the owner's two iPhone gestures included (the silent switch, the
  pinch zoom around the composer). But that tag's tree still carried the `1.6.3` store notes, and the
  1.6.5 work had already merged on `main`. `1.6.5-alpha.1` carries both, and its readings re-run
  the `1.6.4` rows too.
- **Blind salon banners ("Quelqu'un")**: the fix ships in `1.6.5`.
- **Shim removals the floor unblocked**: they start after the `1.6.5` stable.
- **First old draft resumed after `1.6.5`**: #2832.
- **iPhone logs on the workstation** (owner, 2026-11-05): `pymobiledevice3` may be installed on the
  bench workstation only (never on the shared host), to read the bench iPhone's log stream live.
- **Pull-request iOS compile filter**: it covers `Cargo.toml`, `build.rs` and `tauri.conf.json`, not
  `Cargo.lock`.
- **Content-free push**: no request to Apple for the entitlement, only `groupId` dropped from
  `call_ring_end`, and the full path retired once few devices use it - already recorded in
  [content-free-push](../protocols/content-free-push.md) (N1, N2).
