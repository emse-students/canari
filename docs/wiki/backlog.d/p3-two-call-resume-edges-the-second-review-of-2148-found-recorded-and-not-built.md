## P3 - Two call-resume edges the second review of #2148 found, recorded and not built (2026-10-20)

target: 1.7.0

- **F6 - the POLITE side's own pending offer, lost with a dead socket, is never rolled back.** Only the initiator rolls back an unanswered offer on a resume (`restartIfMediaDidNotSurvive` checks `have-local-offer` on the initiator alone). A polite side that had renegotiated (a track added) and lost that offer stays in `have-local-offer`; the initiator's next restart offer then collides and the polite side wins by an implicit rollback - so it heals, but by the collision path, not by design. That condition no longer holds: 1:1 video ships since `1.5.2` (#2711), so turning a camera on mid-call is a polite-side renegotiation, and F6 can now be reached (re-read 2026-11-11). Fix it with a test before relying on the collision path.
- **F7 - a resume whose `Joined` and `PeerReady { resumed }` straddle an ICE `failed` charges TWO restart units.** ICE `failed` between the two frames restarts on the OLD pairing (offer charged, then lost when `PeerReady` opens a new pairing), and the resume restarts again. Bounded (the budget still ends it) and refunded on packet evidence once audio flows; the cost is one unit of three. Fix: defer an ICE-triggered restart while a resume is joined but not yet paired.

Mechanism of both: [calls](../frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix). Delete each with its fix.
