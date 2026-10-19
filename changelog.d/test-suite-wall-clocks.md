### Changed - no test sleeps for a duration

The suite's real sleeps are gone: a queue yield (`flushMacrotask`), an awaited condition (`vi.waitFor`), a quiet (`settleUntilStable`) or fake timers, and `noRealSleeps.test.ts` refuses any non-zero `setTimeout` delay (literal, variable or field, any number of lines) in a file that does not really call `vi.useFakeTimers(` ([test-suite-reform](docs/wiki/test-suite-reform.md), WP-T6).

`outbox.test.ts` now disposes every controller it creates after each case: the ones left alive still flushed after the file ended, and vitest failed the run with an `EnvironmentTeardownError`, intermittently, on `main` too.
