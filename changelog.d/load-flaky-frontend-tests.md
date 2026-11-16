### Fixed - five frontend tests no longer fail when the whole suite runs under load

Five tests spent their 5 s timeout (or a 1 s `waitFor`) on a cold dynamic import; each is now warmed or imported statically. The chat scroll-anchor file (CPU contention, no cold import) is NOT fixed here and stays open in its backlog entry. Test-only change; the causes are in [testing-methodology](docs/wiki/testing-methodology.md#four-tests-that-passed-alone-and-failed-under-load-2026-11-16).
