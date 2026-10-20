### Changed - call video goes up to 720p/30 and drops on its own when the link or the CPU cannot follow

The camera sender moves on a five-rung ladder (720p30 at 2.5 Mb/s down to 180p15 at 200 kb/s), decided by
counts of `getStats()` evidence. Dev builds only, like calls
([calls](docs/wiki/frontend/modules/calls.md#the-quality-ladder-2026-10-21---720p-and-an-automatic-drop)).
