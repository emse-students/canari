## P3 - the id-less visible system notice shim is removed once the archive is past 2026-12-15

target: 1.8.4

A dated commitment that had no entry until the replanning of 2026-11-27: on or after 2026-12-15 the
archive no longer holds a visible system notice written without a `message_id` (trimmed at the 90-day
retention), so `messageId` becomes required on `SystemEventContext` and the replay's `|| undefined`
goes. The live half is retired by `minClientVersion`, not by the date: check it names a version that
mints the id before removing. Everything else is in
[legacy-compatibility](../legacy-compatibility.md#2026-12-15---a-visible-system-notice-with-no-message_id).
`1.8.4` ships after the date only if it slips; if it ships before 2026-12-15, this moves to `1.8.5`.
