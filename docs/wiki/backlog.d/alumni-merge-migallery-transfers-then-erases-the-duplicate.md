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

The tests that prove it: the face link and its rows move and nothing is journalled to Immich for it;
both with a face link -> the target's kept, the duplicate's erased and journalled; grants re-pointed
on both sides; a replay is `absent`; the last-admin guard cannot be reached (a duplicate is never an
admin target, asserted); the schema walk over every table naming `id_user`/`user_id`; the token's
refusals.
