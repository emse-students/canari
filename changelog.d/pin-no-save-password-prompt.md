### Fixed - Chrome no longer offers to save the PIN, and the waiting-device notice says what to do

The PIN forms dropped their hidden account-id username field and declare `one-time-code`, so no
"Save password?" prompt names an id; the "waiting to be added" notice now tells the owner to open the
conversation on another device or ask a member, compare the key, and tap Add
([mls-protocol](docs/wiki/protocols/mls-protocol.md#an-unseen-device-of-a-member-2026-10-27-interim)).
