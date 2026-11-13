## P2 - MLS checkpoint and queue stalls of 30-54 s on web, with a worker timeout and an add-device failure on `lock_budget_spent` (web log, 2026-11-08)

target: 1.10.0

One web log shows inbound-queue and checkpoint phases taking 30-54 s, a worker timeout, and an
add-device attempt failing with `lock_budget_spent` (`mls-client/CommitRefusedError.ts`).

Open question before any fix: is the stall real, or a frozen-tab artifact? The `[QUEUE] STUCK in
<phase> for Ns` line (`mls-client/mlsPerGroupScheduler.ts`, `guarded`, ~L233) measures
`Date.now() - startedAt` in a `setInterval`; a hidden tab whose timers and workers were throttled or
frozen and then resumed reports the whole frozen interval as a stall. The deadline is a wall clock
by design (it exists to report, not to cancel), so the line cannot tell the two apart. First step:
make the report carry the evidence that separates the causes (the page's visibility over the
interval, and a monotonic `performance.now()` delta beside the wall one), then re-read the log. Only
if the stall is real on a visible tab are the worker timeout and the lock budget a separate defect.
