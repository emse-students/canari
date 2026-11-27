## P2 - confirm in production that a Cercle top-up parked for a member who has never signed in is credited at their first sign-in

target: 1.8.3

Built: Le Cercle parks a top-up for an unknown Canari id (`202`, migration 08) and applies it in the sign-in transaction; Canari records `parked` and never retries it ([cotisations](../cotisations.md#outbound-canari---cercle-balance_topup-webhook)).

**What closes it (a measurement, not a defect):** once both are deployed (Le Cercle first, though either order is safe), pay a top-up for a member who has never opened Le Cercle, read the `webhook_deliveries` row as `parked` with no retry line in the `[CERCLE]` log, then sign that member in and read the credit on their balance within the sign-in, a single ledger line. Also read that a resend of the same delivery after the sign-in is answered `200` with `duplicate: true`.
