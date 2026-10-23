### Changed - Dependabot watches the Android Gradle builds and the identity provider's compose file

Two Gradle directories and `infrastructure/authentik` join `.github/dependabot.yml`; the dependency ceiling refuses Gradle updates to the Android app, which no pull-request job builds, and judges the identity provider's PostgreSQL against its own major ([cicd](docs/wiki/cicd.md#native-and-identity-provider-manifests-2026-10-23)).
