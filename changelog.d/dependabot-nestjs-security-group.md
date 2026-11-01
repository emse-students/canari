### Fixed - Dependabot security updates for `@nestjs/*` arrive as one pull request per service

The `nestjs` group only covered version updates, so a security advisory opened three single pull requests per service that conflicted with each other once the first merged. A `nestjs-security` group (`applies-to: security-updates`) now carries them together ([cicd](docs/wiki/cicd.md#security-updates-are-a-second-switch-and-neither-dependabotyml-nor-this-page-showed-it)).

### Fixed - `isGenericRole` formats the same under oxfmt 0.74 and 0.75

The chained call was laid out differently by the two versions, so the Dependabot group bump to 0.75 failed `format:check` on one file. Two short statements are stable under both.
