## P3 - a publisher whose live was cut by a reload or a crash cannot go live again for a minute

target: 1.9.0

Measured 2026-11-15 on dev (rig W5, the fourth account): the page was reloaded mid-live, and the next
"Demarrer le live" got `409 LIVE_ALREADY_OPEN` (`[LIVE-BROADCAST] start refused (already-open)`) until the
server's 60 s sweep without a segment ended the dead live
([lives](../services/lives.md): "the live is ended by the sweep after 60 s without a segment"). A phone
that crashes or loses its page mid-live is locked out for a minute, and what ends the wait is a clock.

Direction: the same publisher's new start closes or resumes its OWN open live, decided from durable
state (the open row of that user, the segment index it reached), not from the sweep. Resuming needs the
live key and the next segment index the server already holds; closing is the simpler first step.
