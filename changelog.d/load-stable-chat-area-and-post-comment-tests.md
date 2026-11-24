### Fixed - two frontend tests no longer fail when the machine is loaded

`ChatArea.scrollAnchor` timed out at 5 s (CPU-bound under faked timers) and `PostCard.commentSync` read its page after a guessed four macrotask turns; the first takes the load bounds, the second waits for the rows to land ([test-suite-reform](docs/wiki/test-suite-reform.md#8-intermittent-local-failures-under-load-read-2026-10-30)).
