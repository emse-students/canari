### Added - main's CI builds the production frontend once and asserts what it carries

A build-only defect (a bundle naming no commit, two build ids) now fails `main` instead of surfacing at a release tag ([cicd](docs/wiki/cicd.md)).
