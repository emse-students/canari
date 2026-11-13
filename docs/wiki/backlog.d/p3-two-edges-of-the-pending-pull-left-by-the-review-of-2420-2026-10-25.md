## P3 - Two edges of the pending pull, left by the review of #2420 (2026-10-25)

target: 1.9.0

- **Any non-2xx page reads as a drained mailbox.** `pullPendingMessagesJson` stops on `!page.ok` and
  returns what it has, so a 5xx or a 403 ends the pull as if the queue were empty, and nothing says it
  did not drain. Predates #2420.
- **The resend after a 401 is not halved on a stall.** The pull applies the 401 rule outside its
  page-halving ladder (so a slow renewal never halves a page); the resend it then makes has its own
  stall timer, but a stall there is thrown rather than asked again smaller. Rare (a 401 followed by an
  oversized page); the next pull asks again ([sessions](../sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).

Re-read 2026-11-11 (batch 12): still real - a non-2xx page now logs `[PENDING] page answered ... the pull stops here` at warn, so the stop is no longer silent, but the caller still cannot tell a stopped pull from a drained one; the 401 resend is still not halved. Re-read again 2026-12-11.
