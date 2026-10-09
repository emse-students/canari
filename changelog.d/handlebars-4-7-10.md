### Fixed - the dependency audit is green again: handlebars 4.7.10 in the four NestJS lockfiles

Three Handlebars advisories (two critical) failed `Dependency audit` on every pull request from 2026-10-09. `handlebars` reaches the four services only through the dev dependency `ts-jest` (`^4.7.9`), so the fix is a lockfile bump to the fixed 4.7.10 within that range: no override and no ignore. See [cicd](docs/wiki/cicd.md).
