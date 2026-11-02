### Fixed - The reel-resume "parked as failed" case no longer hangs on a backoff timer that was not armed yet

The case advanced the faked backoff timer in a loop of at most 50 looks, but the upload view reads `waiting` a queue read before the outbox arms that timer, so under load the loop could end first and the third attempt never started (`expected 2 to be greater than or equal to 3`). It now waits for a timer to exist, then advances exactly one ([test-suite-reform](docs/wiki/test-suite-reform.md#8-intermittent-local-failures-under-load-read-2026-10-30)).
