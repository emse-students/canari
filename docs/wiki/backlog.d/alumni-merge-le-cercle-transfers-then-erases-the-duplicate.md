## P2 - Le Cercle: an Alumni duplicate's account is transferred to the real account, then erased

target: 1.8.3

Code in the Le Cercle repository; the entry lives here by the ecosystem convention. The design is
D52-D54 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).
Measured 2026-11-26: neither duplicate of the day signed in; both persons exist only as unclaimed
legacy accounts with a balance, which the FIRST account of that name and promo to sign in claims -
so a duplicate that signs in first takes it, and this transfer is what gives it back.

What it builds: `POST /api/internal/alumni-merge`, the `canari-merge+jwt` verified by the vendored
verifier (audience `cercle`), then ONE transaction: no row -> `absent`; the target has no row -> the
duplicate's row renamed to the target's subject (as `migrateFromLegacyUser` does; `till_requests`
updated by hand), sessions deleted -> `transferred`. **Both rows exist -> a pair of `transfer` ledger
lines** (the owner's decision of 2026-11-26, [item 7](../decisions/owner-decisions-of-2026-11-26-alumni.md)):
one out of the duplicate and one into the target, each naming the other, carrying the balance; the
membership moves with them; then `deleteOwnAccount` closes the duplicate, whose balance is already
zero, so no `cashout` is written -> `merged`. `transfer` is a new ledger type, so a schema migration
here (the `ledger.type` CHECK rebuilt, a column naming the paired line). **Until that migration
ships**, and only until then, the both-rows case answers `409 ALUMNI_MERGE_BOTH_ACCOUNTS_HOLD` and
changes nothing.

The tests that prove it: the rename carries the ledger, sessions and bartender rows and
`till_requests`; the both-rows case writes exactly two `transfer` lines naming each other, the two
balance columns and the ledger agree afterwards, the membership is on the target, the duplicate is
closed with no `cashout`; the migration upgrades a database holding every existing line type
unchanged; before the migration the both-rows case answers 409 and writes nothing; a replay is
`absent`; the token's refusals.
