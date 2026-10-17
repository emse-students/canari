### Fixed - social-service's PostgreSQL integration specs now run in CI

They were gated on a database URL that no workflow set, so every one was skipped on every pull request. The new `test-social-integration` job runs them against production's PostgreSQL, fails if any is skipped, and gates `CI passed` ([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
