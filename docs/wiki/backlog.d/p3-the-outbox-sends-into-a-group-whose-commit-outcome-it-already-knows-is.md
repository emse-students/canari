## P3 - The outbox sends into a group whose commit outcome it already knows is unknown (DUP-5, 2026-10-25)

target: 1.9.0

When an Add's commit is answered `503`, the client knows the outcome is unknown: it logs `the Add got
no answer - kept with its invitation, settled at the next connection` (`CommitOutcomeUnknownError`).
A message queued for the same group is still attempted. The outbox then logs `transient failure
(attempt 1..3): CommitOutcomeUnknownError …` and backs off between tries, until the reconnection
settles the commit (`duplicate`, merged) and the send goes. Read on `1.4.1-alpha.4`, DUP-5: three
failed attempts in about eight seconds. Nothing is lost, and the order holds. But the outbox learns by
failing what a fact on the same client could have told it. The fix is to carry the group's
unknown-outcome state to where the outbox decides to attempt a send, so that it waits for the
settlement instead of trying and failing.

Re-read 2026-11-11 (batch 12): still real - the outbox does not consult `CommitOutcomeUnknownError` before a send. Re-read again 2026-12-11.
