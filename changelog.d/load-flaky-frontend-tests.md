### Fixed - four frontend tests no longer fail when the whole suite runs under load

Three tests spent their 5 s timeout (or a 1 s `waitFor`) on a cold dynamic import, and the chat scroll-anchor file on real render work; each is now warmed or budgeted at its cause. Test-only change; the causes are in [testing-methodology](docs/wiki/testing-methodology.md#four-tests-that-passed-alone-and-failed-under-load-2026-11-16).
