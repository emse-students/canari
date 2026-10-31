## P2 - Does `main` still have the "lock chain" hazard after #2284? An evaluation, not a fix (2026-10-24)

The unfinished idea: carry a "lock chain" down the inbound drain, so that a send issued from INSIDE
the drain never re-takes the non-reentrant MLS mutex the drain already holds. Its patch is kept
outside the repository and was not merged: the review of #2284 fixed the deadlock it met another way.
**Owed:** read `main` for every send reachable from the drain while it holds the mutex, and say
whether one still re-takes it; only a path that does earns the patch back. Nothing is changed before
that reading.
