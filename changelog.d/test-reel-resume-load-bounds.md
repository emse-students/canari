### Fixed - The reel-resume and message-page tests no longer fail on a loaded machine

`outbox.reelResume` waited for events inside `vi.waitFor`'s 1 s default and read the take record once, a write before it says `sent`; both now wait for the event itself, under a shared failure ceiling that is never asserted ([test-suite-reform](docs/wiki/test-suite-reform.md#8-intermittent-local-failures-under-load-read-2026-10-30)).
