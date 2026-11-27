## P2 - Le Cercle: an Alumni duplicate's account is transferred to the real account, then erased

target: 1.8.3

Code in the Le Cercle repository; the entry lives here by the ecosystem convention. The design is
D52-D54 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).
Measured 2026-11-26: neither duplicate of the day signed in; both persons exist only as unclaimed
legacy accounts with a balance, which the FIRST account of that name and promo to sign in claims -
so a duplicate that signs in first takes it, and this transfer is what gives it back.

What it builds: `POST /api/internal/alumni-merge`, the `canari-merge+jwt` verified by the vendored
verifier (audience `le-cercle`, the `ECOSYSTEM_SITES` id), then ONE transaction: no row -> `absent`; the target has no row -> the
duplicate's row renamed to the target's subject (as `migrateFromLegacyUser` does; `till_requests`
updated by hand), sessions deleted -> `transferred`. **Both rows exist -> a pair of `transfer` ledger
lines** (the owner's decision of 2026-11-26, [item 7](../decisions/owner-decisions-of-2026-11-26-alumni.md)):
one out of the duplicate and one into the target, each naming the other, carrying the balance; the
membership moves with them; then `deleteOwnAccount` closes the duplicate, whose balance is already
zero, so no `cashout` is written -> `merged`. `transfer` is a new ledger type, so a schema migration
here (the `ledger.type` CHECK rebuilt, a column naming the paired line), which ships WITH the
endpoint, so the both-rows case has no interim refusal. A target who closed their own account here
answers `409 { code: 'ALUMNI_MERGE_TARGET_CLOSED' }` and changes nothing: Canari blocks the job,
logs it at ERROR and names it with its code in every daily report.

The tests that prove it: the rename carries the ledger, sessions and bartender rows and
`till_requests`; the both-rows case writes exactly two `transfer` lines naming each other, the two
balance columns and the ledger agree afterwards, the membership is on the target, the duplicate is
closed with no `cashout`; the migration upgrades a database holding every existing line type
unchanged; a closed target answers 409 `ALUMNI_MERGE_TARGET_CLOSED` and writes nothing; a replay is
`absent`; the token's refusals.

**The `erase` mode and the shared verifier** (the review of 2026-11-27, [the target erased before its sites answered](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183)):
the token is verified by Canari's `libs/handoff/alumni-merge-verify.ts`, copied byte-identically
beside the site's `handoff-verify.ts` (a site-local verifier is replaced by it). Its `mode` claim is
`transfer` (`target` REQUIRED; `mode` itself is REQUIRED, a token without it is refused `invalid`) or `erase` - the merge's target was erased in
Canari before this site answered, so `target` is ABSENT and a token carrying one is refused. On an
`erase` the site erases the duplicate's account under `dup` as any account deletion does, in one
transaction, and answers `{ outcome: 'erased' }`, or `absent` when it holds none; it never transfers.
The answers Canari classifies, on the status and a typed body field: a refused token
`401 { outcome: <class> }`; untrusted configuration `503 { outcome: 'not_configured' }` (asked again
daily); Canari's keys unreachable `503 { outcome: 'keys_unavailable' }`; never a `404` once the path is
served. The tests: an `erase` erases and answers `erased`, a replay `absent`; an erase naming a target
and a transfer without one refused.
