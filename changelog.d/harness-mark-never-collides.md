### Fixed - two harness markers minted in one process can no longer collide

The marker's random suffix collided on a same-millisecond pair about once in 46656 and failed the harness self-test gate of an unrelated pull request; the suffix is now a per-process counter from a random start, so uniqueness within a process is guaranteed rather than probable ([marker](tools/cross-client-harness/marker.mjs)).
