## P3 - the social unit run ends with "A worker process has failed to exit gracefully"

Some test leaves a handle open (a timer, a pool). **Found 2026-11-01:** `bun run test --
--detectOpenHandles` forces in-band execution of all ~258 suites and did not finish in 500 s on the
Windows box, so it names nothing from a single run. Bisect instead: run the suites by directory
(`src/forms`, `src/associations`, `src/users`, `src/posts`, ...) with `--detectOpenHandles`, then the
suite alone, and tear down what it names in an `afterAll`.
