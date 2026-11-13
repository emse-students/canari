## Decided - the owner's answers of 2026-11-03 (evening)

target: 1.7.0

Decisions, not open questions; this entry is deleted when the last one is carried out.

**Carried out and pruned (batch 21, 2026-11-12), each checked:** the wry wake pipe aborts on end of
file (#2974, first stable `v1.6.3`); reform D1 is built and its migrations 129-131 carry their
approval lines in `infrastructure/migration-approvals.txt`; space pins were built after #2953
(#2975 the design, #2984 the build, first stable `v1.6.7`); `1.6.3-alpha.3` and the stable `1.6.3`
were cut; the CanaReels writer switch rides the pre-release builds (its production flip is queue
item 9); Sky `v1.1.11` shipped #160. The retention answer (90 days kept everywhere) was
superseded by the owner on 2026-11-11: 5 years on a phone or desktop app, 90 days in a browser
([history-reconciliation](../protocols/history-reconciliation.md)). What stays is standing: the
Play rule and the held-migration delegation.

- **Play**: no stable is cut while the previous stable is in Play review, because a new stable
  replaces the one in review. Pre-releases (internal track) are fine.
- **Held migrations ("Oui, après revue et dev")**: the lead may itself merge a pull request carrying a migration held for the owner (`-- canari:hold-for-owner`) with its approval line drafted in `infrastructure/migration-approvals.txt`, on three conditions: an adversarial Opus review has passed; the migration has run on dev through a pre-release, which takes a backup right before it; each such merge is reported on the owner's private tracking page. Already given case by case for #2964 and #2984. `arm-auto-merge.yml` still never arms such a PR; the lead merges it by hand with `gh pr merge --match-head-commit` ([cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
