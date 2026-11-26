### Fixed - the daily drift report no longer goes red on MiConnect's in-app browser gate, which is put in by hand later by design

`gate` (#4103) is pinned in MiConnect's compose file but stands only once every sibling site gates itself; the report now takes a dated `absent` row for a service deliberately not running yet, and turns red again at its date ([authentik](docs/wiki/infrastructure/authentik.md#the-daily-report-does-the-host-run-what-was-released-and-was-miconnect-edited-by-hand)).
