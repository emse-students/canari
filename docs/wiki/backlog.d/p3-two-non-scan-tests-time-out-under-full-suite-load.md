## P3 - two tests that are not source scans still time out at 5 s under full-suite load

target: 1.8.0

`src/lib/db/messagesPage.test.ts` and `src/lib/workers/encryption.worker.test.ts` failed with
`Test timed out in 5000ms` in loaded full runs on 2026-11-14 and 2026-11-15, and pass alone. They are
NOT source scans, so the snapshot of #3594 does nothing for them (measured on `main`, 2026-11-15):

- `messagesPage`: its slowest test is 316 ms in a quiet full run, 312 ms alone; the file spends 55 % of
  its 6.3 s in transform and 22 % in import (IndexedDB + SQLite storages, real AES-GCM pages).
- `encryption.worker`: every test is at most 14 ms; the file spends 78 % of its 3.1 s building its test
  environment, then loads the worker module in a `beforeAll`.

So the time is not in the assertions, and under load it lands on whichever test runs first. Before any
change, the next step is to name where it goes in a LOADED run (a `--reporter=verbose` full suite with
per-hook timings), then remove that cost - never a raised timeout or a retry (`CLAUDE.md`, a fallback
is a signal). Planned for 1.8.0 rather than with the other P3s: a red test on CI blocks every pull request.
