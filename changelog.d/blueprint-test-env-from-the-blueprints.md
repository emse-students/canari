### Fixed - the MiConnect blueprint upgrade test gives the worker every variable main's blueprints read

Every PR cut before `55-handoff-reader.yaml` failed CI: its test applied main's blueprints over a worker with no `MICONNECT_READER_TOKEN`. The test now derives its throwaway variables from the blueprints it applies, and the applier names an unset `!Env` before anything applies ([authentik](docs/wiki/infrastructure/authentik.md)).
