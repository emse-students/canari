## P3 - "server already unreachable" is logged once per request instead of once per transition (1.6.11 logs, 2026-11-14)

target: 1.7.0

`connectivity.svelte.ts` warns `[CONNECTIVITY] <error> (server already unreachable)` for EVERY request
deadline that fires after the verdict "unreachable" already holds, so a burst of stalled requests prints
a burst of identical lines. The verdict is one transition; the line says nothing the first one did not,
and a line its reader learns to skip hides the next defect (noise rule, `CLAUDE.md`).

Fix: say it once per transition (unreachable entered, unreachable left), with the number of requests
that stalled in between on the line that closes it - a latch on the existing `serverReachable` state
(`utils/changeLatch.ts` is the helper), never a timer. The test in `connectivity.test.ts`: three
deadlines while unreachable print one line, and the next unreachable spell prints one again.
