### Fixed - main's social-service typecheck, broken by two forms pull requests merged an hour apart

The seat-hold spec (#1906) built `FormsService` with nine arguments; the file question (#1908) gave it a tenth. Each was green alone, and their merge failed `Typecheck (tests included)` on `main` ([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
