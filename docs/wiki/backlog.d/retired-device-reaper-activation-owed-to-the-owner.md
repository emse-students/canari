## P2 - the retired-device reaper is built OFF; its activation is owed to the owner (2026-11-01)

Decided by the owner on 2026-11-01 ("Oui, la construire"), after the fourth hand pass revoked 285
devices with no session and no push token that kept filling the queue (of an allowlist of 286: one
came back that day, before its turn). Built in
`chat-delivery-service`, daily, behind `RETIRED_DEVICE_REAPER`, `off` on both estates and set per
estate in `infrastructure/deploy/render-env.sh`. The mechanism, what its predicate proves and what it
does not, are on the [service page](../services/chat-delivery.md#the-retired-device-reaper-built-off-2026-11-01).

- **Owed to the owner, in order**:
  1. Read the rule, then run the two read-only statements of the
     [audit page](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#the-dry-run-read-only-as-the-owner-runs-it)
     on production.
  2. Commit `RETIRED_DEVICE_REAPER_PROD=dry-run`, with `deploy-env.test.sh`'s expectation changed in
     the same commit, and read the `[RETIRED_REAPER]` lines of the next run.
  3. Make the same commit with `on`.
- **Decisions open for the owner**:
  - **The floor.** At 90 days the reaper mostly overlaps the stale-device GC, and the population the
    hand passes revoked had connected within those 90 days, so as built it would not have reached
    them. The second statement measures the candidates' silence. A shorter floor follows a gap in
    that measurement, or nothing.
  - **A true enrolment date.** Clause 5 reads `device_signature_key.firstSeenAt`, which is exact
    only for devices enrolled after migration 027. The smallest additive fix is a migration adding
    `key_package."enrolledAt"`, written on INSERT only and NULL for existing rows. It needs the
    owner's yes.
- **Closed when**: the switch is `on` in production, and a re-measure a week later finds no device
  the predicate names beyond one day's budget.
