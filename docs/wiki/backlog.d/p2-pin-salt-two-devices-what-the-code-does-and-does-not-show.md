## P2 - PIN salt between two devices: the audit's "ping-pong" is not in the code, four adjacent hazards are (2026-11-20)

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
2. **Two first `pin-check` at once on a placeholder row are a silent lost update.** The check reads
   the row, sees the empty verifier, and saves its own unconditionally
   (`security.controller.ts`, `checkPinVerifier`): two devices of an account with no PIN yet each
   choose one, BOTH are answered `registered`, and the row keeps whichever save landed last - the
   other device's PIN is refused at its next unlock, for a PIN the server told it was registered. The
   fix is a conditional update, `UPDATE pin_verifier SET verifier = :v WHERE userId = :u AND verifier
   = ''`, with the affected-row count deciding the answer: 1 is `registered`, 0 re-reads the row and
   compares (`ok` / `mismatch`).
3. **A settle that reads "another salt" commits as if its own reset had landed**: device A's reset
   unanswered, device B resetting meanwhile, and A's settle discards A's local state for a reset that
   was B's. Telling the two apart needs the server to say which reset minted the salt (a reset id
   returned by `pin-reset` and kept beside the salt).

4. **`pin-status` reads the placeholder as a PIN.** It answers `registered: !!doc`, and `GET
   pin-salt` writes a row with an EMPTY verifier for an account without one - so after any salt
   request (an abandoned first setup, a prefetch) the account reads "registered" while no PIN was
   ever chosen, and the gate draws an unlock keypad whose first PIN `pin-check` registers. Registered
   must mean a NON-EMPTY verifier.

If the audit's observation came from a measurement, the run that showed it decides which of these it
was ([auth](../frontend/modules/auth.md#pin-and-device-key)).
