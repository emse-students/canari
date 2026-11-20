## P2 - PIN salt between two devices: the audit's "ping-pong" is not in the code, three adjacent races are (2026-11-20)

target: 1.8.0

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
2. **The first `pin-check` on a placeholder row REGISTERS whoever comes first**: two devices of an
   account with no PIN yet each choose one, and the slower one is told `mismatch` for a PIN it just
   chose. The confirmation at creation (row 15 of the same audit) does not change this.
3. **A settle that reads "another salt" commits as if its own reset had landed**: device A's reset
   unanswered, device B resetting meanwhile, and A's settle discards A's local state for a reset that
   was B's. Telling the two apart needs the server to say which reset minted the salt (a reset id
   returned by `pin-reset` and kept beside the salt).

If the audit's observation came from a measurement, the run that showed it decides which of these it
was ([auth](../frontend/modules/auth.md#pin-and-device-key)).
