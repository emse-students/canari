## P1 - media-service holds the retention durations after the deploy that adds the relay (the boot notice carries them)

target: 1.7.0

_2026-11-17, scope cut: KEPT in `1.7.0` - a regression of `1.7.0`: the relay it holds the durations for is new, and production's deploy of that stable is exactly the ordering ([decisions](owner-decisions-of-2026-11-17.md))._

Found on dev at the `1.7.0-alpha.1` rolling deploy (2026-11-15) and raised from P3 to P1: it blocks the
`1.7.0` stable, whose production deploy is exactly that ordering (production `1.6.12` has no retention
holder: no `[RETENTION]` line in its media-service's last 48 h). The read that answered a social-service
boot notice went through the mesh, which still routed to the retiring replica without the route (404),
so media-service held nothing and refused conversation uploads.

**What is built:** the notice carries the two durations social-service read, and an empty media-service
holds them with no read; held values change only by a read
([retention-settings](../retention-settings.md), the deploy window). Tests reproduce the ordering
(`retention-settings.rolling-deploy.spec.ts`).

**What is left:** the fix merged and shipped in `1.7.0`. Dev already runs the relay on both sides, so
the ordering can only be met again at the PRODUCTION `1.7.0` deploy: there media-service must log
`held as handed by the notice (no read)` and `readable again (handed)` after its boot read's ERROR,
and a conversation file sent right after the deploy must be accepted. Delete this file when `1.7.0`
ships, with that log read.
