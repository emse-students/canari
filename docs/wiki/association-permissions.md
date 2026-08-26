# Association permissions

> What each of the eleven `AssociationPermissionFlag` bits actually gates, measured from its call
> sites on 2026-08-26 - not from its comment. A flag with no call site is either dead or missing its
> check, and the enum cannot tell you which.
>
> User-facing version, in French: [docs/user-guide/permissions-association.md](../user-guide/permissions-association.md).

## The one predicate

Every association-scoped decision asks the same question - *may this user exercise this flag on this
association?* - and it is answered in exactly one place:

```ts
AssociationsService.mayAct(userId, associationId, flag, { isGlobalAdmin })
```

Three tiers, widest first:

| Tier | Who | How it is known |
| --- | --- | --- |
| Platform administrator | Holds **every** association right, member or not | `X-Global-Admin: true`, set by nginx from the `auth_request` `$global_admin` variable |
| Cross-association super-admin | A member of a **BDE** association holding `MANAGE_ASSO`; administers any association | `isAssociationSuperAdmin` -> `callerHasAnyBdeFlag(MANAGE_ASSO)` |
| The association's own member | Judged on their `permissions` bitmask alone | `callerHasFlag` |

The middle tier does not inherit everything. `SUPER_ADMIN_EXCLUDED_FLAGS` -
`MANAGE_STRIPE_CONNECT | POST_AS_ASSO` - is written **once**, on the entity, with the reasoning:
pointing an association's payouts at a bank account and speaking in its name are not
administration. The platform administrator keeps both.

The client mirrors it with `mayActOnAssociation(flag, { isGlobalAdmin, isSuperAdmin,
memberPermissions })` in `frontend/src/lib/associations/api.ts`, reading the same exclusion set, so
a hidden control and a refused request cannot disagree.

### Why it exists

The same question had **four** different answers before this audit, and they disagreed:

- the route guard granted the super-admin every flag;
- `canPostAs` and `canManageStripeConnect` forgot the super-admin entirely;
- the calendar edit/delete pair escalated through `VALIDATE_EVENTS` instead;
- `GET :id/cotisation-options` answered `mayGrant: false` to a BDE super-admin whom the
  `POST :id/cotisants` guard - the endpoint that control calls - would have accepted. The UI hid a
  button the API allowed.

A right spelled out per call site drifts per call site. `mayAct` is the whole policy; a new check
calls it and adds **no second axis of its own**.

## What each flag gates, measured

54 routes declare a flag through `@SetMetadata(PERM_FLAG_KEY, ...)` +
`GlobalAdminOrAssociationRoleGuard`. **Five of the eleven flags declare none** - they are enforced
elsewhere, which is exactly why the audit had to read call sites rather than count decorators.

| Flag | Bit | Guard-declared routes | What it actually gates |
| --- | --- | --- | --- |
| `POST_AS_ASSO` | 0 | 0 | `canPostAs` - publishing a post in the association's name (`posts.controller.ts`), and seeing rejected events on its calendar |
| `PROPOSE_EVENT` | 1 | 2 | `POST :id/events`, `GET :id/link-candidates`; also `PATCH`/`DELETE :id/events/:eventId` inline, and it is the audience of every event-action notification |
| `MANAGE_MEMBERS` | 2 | 14 | members (add / rename / remove / reorder), the logo, `PATCH :id` itself, tags, cotisants and cotisation tiers, plus the exports. Also whether `listMembers` returns bitmasks at all, and whether a form may grant a cotisation tag |
| `MANAGE_DOCUMENTS` | 3 | 8 | the private document vault (including `GET :id/vault-key`) and the association notes |
| `MANAGE_FORMS` | 4 | 1 | `GET :id/forms`, plus `assertFormManager` on every form write and every submission read |
| `VALIDATE_EVENTS` | 5 | 0 | BDE only. `isUserBdeAdmin` - validating, editing and deleting **any** association's events, and depositing a pre-validated one |
| `MANAGE_ASSO` | 6 | 0 | BDE only. Creating an association, and **being the super-admin tier above** - so it grants nearly every other flag everywhere |
| `MODERATE` | 7 | 0 | BDE only. `assertModerator` in `moderation.controller.ts` - reports, deletions, mutes |
| `MANAGE_PRODUCTS` | 8 | 21 | the boutique, purchases and their exports, webhook failures, the whole payment-delegation tree, and the cotisation settings on `PATCH :id` |
| `MANAGE_STRIPE_CONNECT` | 9 | 0 | `GET :id/manage-permission`, which core-service asks before opening Connect onboarding |
| `MANAGE_PARTNERSHIPS` | 10 | 8 | partnership cards, their icons, their codes and their claims |

Nothing is dead: every flag has at least one call site. Re-measure the table rather than trusting it
- one pass over the `@SetMetadata` decorators and one over `AssociationPermissionFlag.` references
in `apps/social-service/src` reproduces it in seconds.

## What is deliberately NOT `mayAct`

Three shapes look like the same question and are not. Folding them in would have been wrong:

1. **`isUserBdeAdmin` (`VALIDATE_EVENTS` in any BDE).** A genuinely different right - "the BDE
   curates the whole calendar" - not "may act on THIS association". It is not association-scoped, so
   `mayAct` cannot express it.
2. **The listing queries** - `associationsWhereUserHasFlag`, `canViewPendingCalendarEvents`,
   `callerHasAnyBdeFlag`. They answer "which associations" or "any at all", not "may they here".
   `forms.service.list()` needs the first shape and correctly keeps it.
3. **Existence.** `mayAct` answers rights, never existence: acting on an association that does not
   exist is a 404 from whoever loads it. `canPostAs` and `canManageStripeConnect` each keep their own
   `findOne`, and each says why - a post must not name a deleted association, and core-service must
   not open a Connect account against a ghost id.

**Channel permissions are a different system.** `CHANNEL_PERMISSIONS` is a string-based model with
its own roles (Membre / Moderateur / Administrateur) and no platform-administrator concept. It shares
nothing with these bits beyond the word "permission", and the two must not be described together.

## What the audit found and fixed

| # | Finding | Disposition |
| --- | --- | --- |
| D1 | `MANAGE_PARTNERSHIPS` was absent from the members editor's label list - the only screen that grants or revokes a flag. A right gating 8 endpoints, handed out by the admin preset on creation, could never afterwards be seen or taken away | Fixed; the list now covers every flag, and a test asserts the preset covers every non-BDE flag |
| D2 | `AssociationMemberRow` invented `member.isAdmin ? ALL_CORE_FLAGS : 0` when the server withheld a bitmask, and `toggleFlag` **wrote the guess back** - so with D3, one click granted all seven core flags | Fixed: no fallback. The editor stays closed and logs when a manageable row arrives without its bitmask |
| D3 | Two inline checks omitted the super-admin tier, so the UI hid controls the API accepts | Fixed by `mayAct` |
| D4 | `AssociationRoleGuard` was dead code, and the only guard with no administrator path | Deleted |
| D5 | The BDE-only flag set and the "holds a flag in a BDE association" query were each written out by hand in several places | Factorised: `BDE_ONLY_FLAGS`, `holdsBdeFlag`, `findBdeAssociationWithFlag` |
| D6 | The French user guide's roles table described the **channel** model as if it were this one | Replaced by [permissions-association.md](../user-guide/permissions-association.md) |
| D7 | `forms.service.ts` still documented a "co-owner" tier deleted long ago | Fixed |

## Where to look

- `apps/social-service/src/associations/entities/association-member.entity.ts` - the enum,
  `ALL_PERMISSION_FLAGS`, `SUPER_ADMIN_EXCLUDED_FLAGS`, `ALL_CORE_FLAGS`
- `apps/social-service/src/associations/associations.service.ts` - `mayAct`, `callerHasFlag`,
  `isAssociationSuperAdmin`, `callerHasAnyBdeFlag`
- `apps/social-service/src/associations/guards/global-admin-or-association-role.guard.ts` - the only
  association guard; holds no policy of its own
- `apps/social-service/src/associations/associations.service.may-act.spec.ts` - the three tiers and
  the exclusion set, against the real implementation
- `frontend/src/lib/associations/api.ts` + `permissions.test.ts` - the client mirror
- `frontend/src/lib/components/associations/AssociationMemberRow.svelte` - the only screen that
  grants or revokes a flag
