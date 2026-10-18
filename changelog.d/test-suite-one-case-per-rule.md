### Changed - the two source-scan guards are one case per rule, and name every offender

`serverProse` and `markupSources` ran one test per file (3,378 cases) and now run one per rule (3 cases), failing with the full offender list; same rules, same allowlist checks ([test-suite-reform](docs/wiki/test-suite-reform.md)).
