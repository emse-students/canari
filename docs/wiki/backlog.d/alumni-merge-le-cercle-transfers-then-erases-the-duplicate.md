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
updated by hand), sessions deleted -> `transferred`. **Both rows exist -> `409
ALUMNI_MERGE_BOTH_ACCOUNTS_HOLD`, nothing changed, until the owner decides how a balance and a
membership move between two accounts** (recommended: a `transfer` ledger line pair, a schema
migration here, rather than a `cashout` + `topup` that books money nobody paid); when the duplicate
holds no balance, no membership and no role, it is closed by `deleteOwnAccount` -> `merged`.

The tests that prove it: the rename carries the ledger, sessions and bartender rows and
`till_requests`; the balance column and the ledger still agree after it; the both-rows case answers
409 and writes nothing; the empty-duplicate case closes it; a replay is `absent`; the token's refusals.
