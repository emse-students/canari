### Fixed - the test rig refuses a `--file` no phase declares

`run.mjs --file` now refuses a path (`archive/floor.mjs`) and a script in no phase, where it used to print a note and preflight W1 and W2 alone. A chain run of fourteen 1.4.1 rows went that way and FLOOR-2 recorded VACUOUS on an unpreflighted seat (`fileRefusal` in `tools/cross-client-harness/checks.mjs`).
