### Changed - no test sleeps for a duration

The suite's real sleeps are gone: a queue yield (`flushMacrotask`), an awaited condition (`vi.waitFor`), a quiet (`settleUntilStable`) or fake timers, and `noRealSleeps.test.ts` refuses a positive literal `setTimeout` in a file that does not fake timers ([test-suite-reform](docs/wiki/test-suite-reform.md), WP-T6).
