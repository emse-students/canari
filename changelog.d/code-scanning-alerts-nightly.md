### Added - the nightly reads the standing code scanning alerts

A standing CodeQL alert failed nothing, because the pull-request check refuses only new ones; the nightly `alerts` job now reads the code scanning list with the same reader as the Dependabot one, now `github-alerts-report.sh` ([cicd](docs/wiki/cicd.md#and-the-audit-is-not-the-whole-question-because-github-knows-things-it-does-not)).
