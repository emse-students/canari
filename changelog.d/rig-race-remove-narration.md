### Fixed - a CC racer that Removes is forgiven its own Remove narration

CC-2 on alpha.4 passed its assertions and read dirty on W1's own Remove lines; a racer whose gesture is a Remove is now forgiven `[REMOVE_MEMBER] ... removed from the group` when it ended `committed` or `already-out`, and its `[NOTICE] memberRemoved` line at `debug` only (`REMOVE_NARRATION` in `tools/cross-client-harness/watch.mjs`).
