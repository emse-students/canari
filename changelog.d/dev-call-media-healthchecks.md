### Fixed - dev's call-service and media-service are proven healthy at deploy, like production's

The dev deploy read both as `none` (started, never proven to answer) on the estate where calls and lives are tested; they now carry production's healthcheck. The phone procedure for a dev call is [check CALL-L1](docs/wiki/device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both).
