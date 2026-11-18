## P3 - `dm_group_members.role` promises group admins that do not exist (a held migration)

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 10): in an
encrypted group ALL MEMBERS ARE EQUAL - *"A quoi sert un role d'admin dans les groupes ? Les
communautes oui, les groupes, tout le monde est a egalite non ?"*. Removing a member stays open to
every member.

**Today.** `role: 'admin' | 'member'` (`apps/chat-delivery-service/src/entities/group-member.entity.ts`)
is written `member` by `utils/group-membership.ts` and read nowhere: `assertCallerMayMutateMembership`
(`controllers/members.controller.ts`) lets every admitted member add and remove. Its entity comment
promised the reverse until the comment-only fix of the moderation-grid pull request.

**The change.** Remove the field from the entity and its one writer, then drop the column (and its
enum type) in a chat-delivery migration. **A DROP is held** by `infrastructure/lib/migration-hold.sh`,
so it ships only with its approval line ([cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)):
merged after an adversarial review and a pass on dev, approved by the owner or by the lead under the
2026-11-03 delegation. Order: the code stops writing and reading the column in one release, the held
migration drops it in the next, so no running build names a missing column. Before writing it,
enumerate every reader of the table OUTSIDE the entity (raw SQL in chat-delivery, any other service or
script reading `dm_group_members`): the column must be read nowhere, not only in TypeORM.

**Proof.** `members.controller.grid.spec.ts` (every member adds and removes, the platform admin is
refused - the `[MLS]` rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md)),
the migration's pass on dev, and `migrations.lock-timeout.spec.ts`.
