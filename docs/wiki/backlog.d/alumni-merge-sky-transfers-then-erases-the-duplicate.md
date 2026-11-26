## P2 - Sky: an Alumni duplicate's account is transferred to the real account, then erased

target: 1.8.3

Code in the Sky repository; the entry lives here by the ecosystem convention. The design is D52-D54
in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).
Measured 2026-11-26: neither duplicate of the day signed in to Sky.

What it builds: `POST /api/internal/alumni-merge`, the `canari-merge+jwt` verified by the vendored
verifier (audience `sky`), then ONE `database.transaction`: no record under `dup` -> `absent`; the
target has no record -> `auth_sub := target`, the duplicate's sessions deleted -> `transferred`; the
target has one -> `mergePeople(dup, target, undefined, 'alumni-merge')` -> `merged`. `mergePeople`
is fixed to MOVE the source's `associations` rows (today they cascade away). `pending_links` and
`handoff_redemptions` naming `dup` are deleted. A dropped `admin` role is logged. Answers
`{ outcome }`; a bad token 401, an unknown audience 401, never a 5xx for a state.

The tests that prove it (`tests/`): the three outcomes; a replay answers `absent` and changes nothing;
`mergePeople` keeps the associations; the role is never carried; every table naming a person is in
the transfer list or the untouched list (a schema walk fails on a new one); the token refused when
expired, of another audience or another `typ`.
