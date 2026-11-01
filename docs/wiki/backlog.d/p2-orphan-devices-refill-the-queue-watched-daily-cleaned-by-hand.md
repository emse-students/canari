## P2 - orphan devices refill the queue: the daily count is the watch, the hand procedure the cleanup

A device with queued rows, no session row, no push token and no ban drains nothing and keeps
collecting fan-out while it holds seats. Four hand passes revoked 43, 118, 109 and 285 of them, and
every re-measure found the population again
([audit](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#fourth-pass---2026-11-01-and-the-procedure-to-run-it-again)).

**Owner's decision, 2026-11-01: no reaper.** #2880 (a scheduled one) was closed unmerged: at the
GC's 90 days the hourly stale-device GC collects the same devices first, and inside them no durable
fact proves a device was replaced rather than closed (`deviceName` is set only by a manual rename;
`device_signature_key.firstSeenAt` has no backfill before migration 027). The 90-day GC stays the
only automatic collector; the orphans it cannot reach are counted daily by `reportOrphanDevices`
(`[ORPHAN_DEVICES]`, WARN above 43) and cleaned by the re-runnable hand procedure on the owner's go
([chat-delivery](../services/chat-delivery.md#orphan-devices-the-gcs-blind-spot-counted-daily-cleaned-by-hand)).

**Owed:** the regrowth rate, read from the first two weeks of `[ORPHAN_DEVICES]` lines in production
once this ships (`devices` and `insideGcWindow` per day, from 1 on 2026-11-01). If it climbs back past
43 within weeks, the cause that keeps minting orphans (a sign-out or an uninstall that leaves its seats)
is the next item, not another pass.
