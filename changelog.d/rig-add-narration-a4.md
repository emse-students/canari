### Fixed - the test rig reads two Add narration lines as narration

The server's `ENROLLED by commit` line (#2419) is notable, and the adder's own `[NOTICE] memberAdded` debug line (#2412) is forgiven where a row created the group; both had made FLOOR-2's first alpha.4 PASS read dirty (`srvlog.mjs`, `watch.mjs` `GROUP_CREATION_NARRATION`).
