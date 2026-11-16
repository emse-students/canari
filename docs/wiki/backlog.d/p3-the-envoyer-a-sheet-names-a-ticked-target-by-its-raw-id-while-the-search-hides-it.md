## P3 - the "Envoyer a..." sheet names a ticked target by its raw id while the search hides it

target: 1.7.0

**What was seen (iPhone 12, `1.7.0-alpha.6`, 2026-11-16, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-eighth-sitting-170-alpha6-the-envoyer-a-rows-2-to-8-10-11-and-13)):** with a target ticked and then a search typed that filters it out of the list, the chip of the ticked target reads its hex id ("43319a65...") instead of its name. Clearing the search restores the name ("Canari Test Delta"). The id is a raw identifier shown to a member.

**Owed:** the chip names a ticked target from the full list, never from the filtered one, with a test over a selection hidden by the search; a read on a pre-release.
