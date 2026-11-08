### Changed - CI caches the pinned Trivy and ShellCheck archives instead of downloading them on every run

A GitHub release-download outage failed every pull request on 2026-11-08; the digest is still checked on each run ([cicd](docs/wiki/cicd.md)).
