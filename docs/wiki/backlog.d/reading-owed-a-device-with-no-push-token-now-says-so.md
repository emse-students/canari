## Reading owed - a native device with no push token row now says why, and registers again (production, after the `1.7.0` stable)

target: 1.7.0

**What is built.** A device that ends a registration without a token reports it (`[PUSH_UNAVAILABLE]`);
`register-device` answers whether the server holds the device's `push_token` row and the phone
registers again on `false` (#3649); every `register-device` states the last outcome, QUALIFIED since
2026-11-17 - `unauthorized:<cause>`, `in-progress:<stage>`, `started:<stage>` - and the daily
`[PUSH_COVERAGE]` WARN per `(os, build)` carries the tally of those outcomes (`last:`), so the branch
is read from the report without log access. Mechanism and every measurement:
[chat-delivery](../services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15).

**What it replaces.** The P1 "a third of the `1.6.12` native devices hold no push token row" (filed
2026-11-15, its build work done, file deleted 2026-11-17) and this entry's earlier "fifth cause"
readings (2026-11-14, two tokenless devices among 194). Production re-read 2026-11-17, read-only,
still on `1.6.12`: older builds 0 of 117 tokenless, `1.6.12` 15 of 75 Android and 12 of 59 iOS; none
of them sent a registration request or a report, most launched once. The cause is NOT established:
every branch that ends without a request is client-side, and only the qualified `last=` of a `1.7.0`
phone can name it.

**The reading that closes it**, on production, the day after the `1.7.0` stable reaches both stores,
read-only:

1. The `[PUSH_COVERAGE]` daily line on chat-delivery: no WARN for any `1.7.0` build, or every one
   carrying a `last:` tally that names the branch.
2. The query of the chat-delivery wiki section (`utils/push-coverage.ts`, `PUSH_COVERAGE_SQL`) grouped
   by `"pushOutcome"`: the `1.7.0` phones that ran and hold no row beyond the ten-minute grace read 0.
3. If not 0: the tally names the fix - `unauthorized:<cause>` points at the session's token source,
   `in-progress:<stage>` / `started:<stage>` at the await the ladder never left - and that fix is
   filed as its own P1 for `1.7.1` with the tally as its evidence.

On dev the count is not comparable (a reset truncates `push_token`, `infrastructure/lib/copy-strips.sh`);
dev read 2026-11-17: both `1.7.0-alpha.7` phones hold their row (`registered`), one `alpha.6` Android
that ran once states `in-progress` with no row - a process that ended inside its ladder, the case the
new `started:<stage>` names.

Charter: principle 1 (your messages are yours - a message that cannot ring is lost to the phone).
