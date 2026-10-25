### Fixed - the rig's presence check asks about the signed-in account's device

`archive/presence.mjs` took the first `mls_device_id_*` entry in a profile, which can belong to another account once signed in there, and reported a connected seat `OFFLINE`; it now reads the entry of `canari_saved_user`. The preflight's missing-venue refusal names the estate and `campaign-fixtures.mjs --build` instead of production ([harness](tools/cross-client-harness/README.md#running-it)).

The R5 fixtures now seat the third and fourth accounts in the venue too (`venueMembers`), which the same preflight requires of every account a run drives.
