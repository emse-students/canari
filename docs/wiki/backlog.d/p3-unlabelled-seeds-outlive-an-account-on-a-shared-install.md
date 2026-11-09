## P3 - seeds mirrored before the writer label outlive a wiped account on an install another account still uses

Since 2026-11-07 every entry of `graine_seeds.json` names the accounts that wrote it, and an
account's wipe drops what that account alone wrote ([auth](../frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07)).
An entry mirrored BEFORE the label carries no writer. When the wiped account is the only one on the
install (`otherAccountOnInstall` false, the test `revokedWipeScope` makes), the wipe drops those too.
When another account still lives on the install it cannot: deciding which of the two wrote them is
not possible, and dropping them could cost the remaining account a seed it reads.

So on a multi-account install the deleted or revoked account's pre-label seeds stay, sealed under
the install key, unreadable without it, and never read as anybody's in particular. The remaining
account's retention sweep and community leave reach only the sessions in its own store and the
communities it leaves, so a pre-label entry of a salon only the wiped account read is reached by
neither. It stays until one of three things happens: new writes in its channel push it past the
per-channel bound (20 sessions), the remaining account's own wipe runs while it is alone on the
install, or a factory wipe drops the file.

Owed: nothing to build unless a measurement shows a multi-account install still carrying unattributed
entries long after the label shipped; the count to read is `of unknown writer left` on the
`[GRAINE_MIRROR]` line of a wipe whose page line says `alone on the install: false`
([device-verification](../device-verification.md#the-seed-mirror-labelled-by-account---owed-2026-11-07)).
Close this entry when one such wipe on a phone that ran a pre-label build reads `0 of unknown writer
left`.
