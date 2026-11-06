### Fixed - source-scan and stored-page tests no longer lose to a loaded machine

`audioSession.captureSites` reads the run's shared source snapshot instead of walking the disk, and the salon stored-page tests wait for their events rather than a 1 s `vi.waitFor` ([test-suite-reform](docs/wiki/test-suite-reform.md#8-intermittent-local-failures-under-load-read-2026-10-30)). The sqlite and pending-mutation victims have no code cause (third reading there).
