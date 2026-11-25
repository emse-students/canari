## P3 - Nothing on screen says a community's keys are pending on this device (review of #4086, 2026-11-25)

target: 1.9.0

A key-group frame whose handler keeps failing is kept in the MLS state and holds every later frame
of its group in server order ([mls-desync-prevention section 11](../protocols/mls-desync-prevention.md#11-client---a-key-group-frame-is-kept-until-its-handler-succeeds-2026-11-25)).
The device then reads that community's new messages late, or not at all, until the handler
succeeds, and the only trace is the log: the `handler refused a frame` line (error from the third
failed run) and the `keeps unhandled` fragment of the seed-request lines. Nothing tells the member.
Owed: a quiet per-community signal ("des cles sont en attente sur cet appareil"), through
Paraglide, read from `describeKeptFrames` / `keptFramesOfGroup` - an event when a kept frame is
noted or forgotten, never a poll. Not trivial: it needs a reactive surface from the MLS layer to the
community header, which nothing provides today.
