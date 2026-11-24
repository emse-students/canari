## P2 - PIN salt between two devices: the audit's "ping-pong" is not in the code, two adjacent races remain (2026-11-20)

target: 1.9.0

The PIN-gate audit of 2026-11-20 (row 19) reported two devices rotating the account's PIN salt back
and forth. Read in the code on 2026-11-20, that loop does not exist: the salt changes ONLY when
`POST pin-reset` deletes the `PinVerifier` row and the next `GET pin-salt` mints one (and once, for a
legacy row with no salt), and no client path asks for a reset by itself - the unsettled-reset settle
(`pinReset.ts`) READS the salt, it never resets. A client meeting `stale-salt` asks the salt again and
checks once more; a second `stale-salt` is refused by name (`pin_salt_rotated`), so it cannot loop
either. No fix was guessed. What the reading found instead, each owed a decision and a test:

1. **Two first `GET pin-salt` at once** for an account with no row: both read nothing, both insert,
   and `@Unique(['userId'])` refuses the second - a 500 the client shows as "unreachable". An
   idempotent mint (`INSERT ... ON CONFLICT (userId) DO NOTHING`, then read the row back) answers both
   with the same salt, from durable state.
2. **A settle that reads "another salt" commits as if its own reset had landed**: device A's reset
   unanswered, device B resetting meanwhile, and A's settle discards A's local state for a reset that
   was B's. Telling the two apart needs the server to say which reset minted the salt (a reset id
   returned by `pin-reset` and kept beside the salt).

Two further hazards the same reading found were fixed in #3909: two first `pin-check` at once were a
silent lost update (now one conditional write pinned to the row read, the loser compared, a
write that lost to a reset answered `stale-salt`), and `pin-status` read the
placeholder row as a PIN (now a non-empty verifier only).

If the audit's observation came from a measurement, the run that showed it decides which of these it
was ([auth](../frontend/modules/auth.md#pin-and-device-key)).
