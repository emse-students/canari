### Changed - ten byte-identical spec copies deleted from the NestJS services (WP-TEST-TOOLING-REFORM)

A module pinned byte-identical across services now has ONE spec; the copies beside the other services asserted nothing more (-10 files, -81 jest cases, no class lost). `http-error-log.spec.ts` keeps both copies because each builds its input with its own service's `axios` ([test-suite-reform](docs/wiki/test-suite-reform.md#72-the-declared-copies-deleted-2026-10-21)).
