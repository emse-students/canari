### Fixed - a one-row run judges its server window as that row

`run.mjs` read every pass's server window with no row, so DUP-1 run alone counted its own `DUPLICATE` commit answer as out of row and exited 1 under a PASS verdict (alpha.4); a pass that recorded exactly one row is now judged as that row, and a multi-row pass stays strict (`windowRow` in `tools/cross-client-harness/srvlog.mjs`).
