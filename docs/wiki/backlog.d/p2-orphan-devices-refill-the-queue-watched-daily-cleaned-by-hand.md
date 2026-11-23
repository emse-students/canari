## P2 - about six devices a day become orphans, nearly all of them browsers

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

A device with queued rows, no session row, no push token, no ban and no life in 7 days drains
nothing and keeps collecting fan-out while it holds seats. Four hand passes revoked 43, 118, 109 and
285 of them, and every re-measure found the population again
([audit](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#fourth-pass---2026-11-01-and-the-procedure-to-run-it-again)).

**Owner's decision, 2026-11-01: no reaper.** #2880 (a scheduled one) was closed unmerged: at the
GC's 90 days the hourly stale-device GC collects the same devices first, and inside them no durable
fact proves a device was replaced rather than closed (`deviceName` is set only by a manual rename;
`device_signature_key.firstSeenAt` has no backfill before migration 027). The 90-day GC stays the
only automatic collector; the orphans it cannot reach are counted daily by `reportOrphanDevices`
(`[ORPHAN_DEVICES]`) and cleaned by the re-runnable hand procedure on the owner's go, both from ONE
predicate ([chat-delivery](../services/chat-delivery.md#orphan-devices-the-gcs-blind-spot-counted-daily-cleaned-by-hand)).

**The line has no threshold, on purpose.** A threshold of 43 (the smallest population a pass was run
on) was proposed and dropped in review: it was tied to a looser predicate than the count's, and no
regrowth rate exists to derive one from. A WARN printed every day while above a threshold would be a
line people learn to skip.

**Owed:** the regrowth rate, read from the first two weeks of `[ORPHAN_DEVICES]` lines in production
once this ships (`devices` and `insideGcWindow` per day; the population right after the fourth pass
was not measured, so the first line is the baseline). Then a threshold derived from that rate, with a
WARN only on the day the count CROSSES it - which needs the previous day's count kept somewhere
durable, not in one replica's memory. If the count climbs within weeks, the cause that keeps minting
orphans (a sign-out or an uninstall that leaves its seats) is the next item, not another pass.

**First line read, 2026-11-14:** production's `[ORPHAN_DEVICES]` at the `v1.6.11` deploy
(2026-11-13 17:02 UTC) read `devices=86 rows=8122 insideGcWindow=86`, twelve days after the fourth
pass revoked 285 (dev: `devices=5 rows=804`). Only that one line is readable today: the live log
starts at the deploy, and the deploy archives that hold the earlier days belong to the runner
account, which the operator's account cannot read ([logging](../infrastructure/logging.md#reading-an-archive)).
The two weeks of lines are read from that account, or day by day from now on.

**Second line read, 2026-11-14 (after the stable `1.6.12` deploy, 09:12 UTC, read-only; owner's
authorization of the same day):** `devices=84 rows=8249 insideGcWindow=84`, 16 hours after
`devices=86 rows=8122`. The device count did not grow (two left, the GC window or a returning
device); the queued rows grew by 127, about 190 a day. So the regrowth is rows piling on the SAME
orphans, not new orphans, over this one interval. The live log restarts at every deploy and the
earlier days are in the runner account's archives, so the two weeks still need that account or
day-by-day lines; a threshold is not derivable from two points. No cleanup was run.

**The regrowth rate, READ 2026-11-14 from durable state instead of two weeks of lines** (read-only, production): the count's own predicate, each orphan dated by its last sign of life (its newest KeyPackage, commit or sent message). The fourth pass left none on 2026-11-01; 13 days later there are 84 - 16 whose last life falls in the week of 2026-10-26, 53 in the week of 2026-11-02 and 14 in the week of 2026-11-09 (censored: a device needs 7 silent days to count). **About six devices a day become orphans.** 79 of the 84 are WEB devices (by the platform their KeyPackage declares: 35 iOS browsers, 12 Android browsers, 32 desktops), on 66 accounts; 5 are native. So the count climbs within weeks, and per the paragraph above the next item is the cause that keeps minting them: a browser session that ends (signed out, storage cleared, a profile never reopened) without releasing its seats. A threshold for the daily line is not the fix while the population grows at a steady rate.
