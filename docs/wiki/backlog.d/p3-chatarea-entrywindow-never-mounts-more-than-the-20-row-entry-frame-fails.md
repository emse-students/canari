## P3 - `ChatArea.entryWindow` "never mounts more than the 20-row entry frame" fails under the full sweep and passes alone (2026-10-27)

target: 1.9.0

Seen failing in a full `vitest run` on a loaded machine, and passing when the file runs alone.
Not diagnosed: the test asserts a mount count, so a mount that has not settled yet when the
assertion runs (a timing dependency) is the first suspect, not proven. Owed: run it under
`--repeat` with the full sweep's load, and name the condition before touching the test.

**Plan (batch 14, 2026-11-12).** Reproduce before touching the test: `bunx vitest run --repeat=20` with the whole suite's load (`--pool=forks` and the CI worker count), then name what the mount count waits on - a settle the assertion does not await is the first suspect. Shared with the other flaky test, `outbox.reelResume.test.ts`; both are piece (c) of the 1.4.1 campaign-noise entry. No agent needed.
