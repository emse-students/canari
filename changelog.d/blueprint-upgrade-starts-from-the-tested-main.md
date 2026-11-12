### Fixed - the MiConnect blueprint upgrade test starts from the main its commit sits on

A re-run fetched a newer `main` than the tree under test and failed every open pull request once main gained a blueprint with a new `!Env`; the applier now names an unset `!Env` before anything applies, instead of a bare serializer error ([authentik](docs/wiki/infrastructure/authentik.md)).
