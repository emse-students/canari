### Changed - the app's URL scheme is derived from its identifier, spelled once

Every deep link, the OIDC return URI and the Play URL now come from `MOBILE_APP_PACKAGE`, and a test fails on any other literal. This is the first step towards a side-by-side dev build ([dev-environment](docs/wiki/infrastructure/dev-environment.md#9-a-pre-release-cannot-measure-production-state---the-second-package-id-decided-2026-09-15)).
