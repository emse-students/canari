## P2 - MiGallery: an Alumni duplicate's account is transferred to the real account, then erased

target: 1.8.3

Code in the MiGallery repository; the entry lives here by the ecosystem convention. The design is
D52-D54 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).
**Measured 2026-11-26: both duplicates of the day signed in to MiGallery** - one left an empty account,
orphaned since its merge; the other holds a face enrolment while the real account has no MiGallery
account (counts only; the rest is in the private operations notes).

What it builds: `POST /api/internal/alumni-merge`, the `canari-merge+jwt` verified by the vendored
verifier (audience `migallery`), then ONE `inTransaction`: no row -> `absent`; else the target's row
created if missing, favourites, photo-access grants (both sides, no self-grant), per-user album
grants, `locale`, and the face link with every face table when the target has none (the consent row
kept as it is); then `deleteUserAccount(dup)`; `finishLocalErasure` after the commit as for any
deletion. `role` never carried (logged). Answers `{ outcome }`.

The tests that prove it: the face enrolment and its consent move TOGETHER (the owner's decision of
2026-11-26, [item 9](../decisions/owner-decisions-of-2026-11-26-alumni.md)) - after the transfer the
target holds the face link, every face row AND the consent row with its original date, terms version
and `source`, the duplicate holds none of them, and no face row exists without its consent; nothing
is journalled to Immich for the moved link;
both with a face link -> the target's kept, the duplicate's erased and journalled; grants re-pointed
on both sides; a replay is `absent`; the last-admin guard cannot be reached (a duplicate is never an
admin target, asserted); the schema walk over every table naming `id_user`/`user_id`; the token's
refusals.

**The admin list tells homonyms apart too** (D56, one rule across the ecosystem). MiGallery's
"Utilisateurs & rôles" showed the real account and the orphan as two identical rows: same name,
promo and formation, and `users` has no creation or last-login column. The list applies the same
rule as Canari's pickers: a row whose folded name another shown row shares carries a distinguishing
detail - the promo, then the formation, then the first 8 characters of `id_user` (an admin page may
show an opaque id; a picker may not). Test: two rows identical in name, promo and formation render
with different details.

**The `erase` op** (the review of 2026-11-27, [the target erased before its sites answered](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183)):
a token whose `op` is `erase` names no `target` - the merge's target was erased in Canari before this
site answered. The site then erases the duplicate's account under `dup` as any account deletion does,
in one transaction, and answers `{ outcome: 'erased' }`, or `absent` when it holds none; it never
transfers. A token whose `op` is `transfer` and carries no `target`, or an unknown `op`, is a 400.
Once the path is served it never answers `404` - Canari reads a `404` as "not shipped yet" and asks
again only daily. The tests: an `erase` erases and answers `erased`, a replay `absent`; the two
malformed tokens refused.
