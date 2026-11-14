## The MLS audit items that are still real, with their verified counts (swept 2026-09-12)

target: 1.8.0

**Work to the swept numbers, never the audit's** (eight came back LARGER than claimed). The duplicate
half is gone ([triage](../protocols/mls-graine-state-machine.md#8-several-paths-to-one-thing---the-duplicates),
[durable-rules](../durable-rules.md#an-open-item-whose-substance-has-never-been-in-the-repository-is-not-an-open-item));
what follows is the whole of what is left. `D8` and `R-D8` are REFUTED and not to be re-opened
([triage](../protocols/mls-graine-state-machine.md#10-triage---what-is-worth-a-pull-request)). **A few
conversations rest on ONE holder** (the counts are in the private operations notes): the hourly report
says so and repairs nothing.

**Availability dead ends - every one needs an exit that EXISTS** (user, 2026-09-12: *"on ne peut pas
demander a un utilisateur de sortir de l'impasse lui-meme. La sortie de l'impasse doit exister pour
garantir la disponibilite"*, scoped to availability rather than deliberate refusals):

| Item | The state | Population |
| --- | --- | --- |
| an outbox entry with no terminal state | the two permanent dispositions are `group-deleted` and `evicted`; a group nobody can repair is **neither**, so a held entry stays pending for the life of the install | the counter it needs exists (2026-09-14); what is missing is the PROOF a terminal disposition may be taken on, and a clock is not one |
| `R-E9`, `R-E11` | peer-unresolved; `readWelcomeOwed() === null` | retried for ever, no counter |
| `DE7` | a saved state that will not open | the ALTERED half rotates with no PIN since step 2 (PK1, #2001, `v1.3.0`); a LEGACY blob still offers only the old PIN or the reset until its first rewrite |
| `G-E10` | `forgetCommunityGraine` with no runtime | warns, returns 0; seeds and joined groups stay |
