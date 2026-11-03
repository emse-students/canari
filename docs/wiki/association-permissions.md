# Association permissions

> What each of the twelve `AssociationPermissionFlag` bits actually gates, measured from its call
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
| Cross-association super-admin | `MANAGE_ASSO` in the BDE of a space THIS association reaches; administers the associations its spaces reach, no others (WP6c step 2), and never an institution (owner, 2026-11-02) | `isAssociationSuperAdminOf(user, association)` -> `holdsBdeFlagOver` -> `spaces/bde.ts` `holdsBdeFlagOverSql` |
| The association's own member | Judged on their `permissions` bitmask alone | `callerHasFlag` |

The middle tier does not inherit everything. `SUPER_ADMIN_EXCLUDED_FLAGS` -
`MANAGE_PAYOUT_ACCOUNT | POST_AS_ASSO` - is written **once**, on the entity, with the reasoning:
pointing an association's payouts at a bank account and speaking in its name are not
administration. The platform administrator keeps both.

The client mirrors it with `mayActOnAssociation(flag, { isGlobalAdmin, isSuperAdmin,
memberPermissions })` in `frontend/src/lib/associations/api.ts`, reading the same exclusion set, so
a hidden control and a refused request cannot disagree. `isSuperAdmin` there is THIS association's
tier: the page reads it from `GET /api/associations/me/bde-reach` (`getMyBdeReach`), the server's
own list of the associations each scoped BDE power reaches - never from "is a BDE somewhere".

### WP6c step 2: a BDE governs the associations its spaces reach (2026-10-04)

**THE ONE PREDICATE IS `holdsBdeFlagOverSql(user, association, flag)` in `spaces/bde.ts`**: the user
holds `flag` in the BDE of a space that one of the association's `association_audiences` rules
reaches. An association reaching SEVERAL spaces is governed by the BDE of ANY of them; one reaching
NO space (no rule) by no BDE - a global admin only. A BDE always reaches what it governs (the
spaces page holds that), so it governs its own association. It is read for:

| Power | Scoped through | Where |
| --- | --- | --- |
| `VALIDATE_EVENTS`: validate, reject, edit, delete, poster | `mayValidateEvent(user, eventId)` - the EVENT's own association, read from the row, never the URL's | `assertMayDecideEvent`, `assertMayWriteEvent` |
| `VALIDATE_EVENTS`: deposit on another association, declare a `break` | `mayValidateEventsOf(user, target)` - the `targetAssocId`; a deposit on one the caller does not govern is a 403, never filed on `:id` | `createCalendarEvent` (controller) |
| `VALIDATE_EVENTS`: who is told of a proposal | `BDE_FLAG_HOLDERS_OVER_SQL` - the same predicate, so the people told are the people who may act | `notifyEventValidatorsOfProposal` |
| `VALIDATE_EVENTS`: the pending queue | rows of the associations they govern plus their own; each row carries `canValidate` | `listPendingCalendarEvents` |
| `VALIDATE_EVENTS`: the last-admin bypass on member edits | `mayValidateEventsOf(caller, :id)` | `updateMemberRole`, `removeMember` |
| `MANAGE_ASSO`: the super-admin tier of `mayAct` / `mayActOnAny`, the membership-only guard path, `DELETE :id` | `isAssociationSuperAdminOf(user, association)` | `mayAct`, `GlobalAdminOrAssociationRoleGuard`, `remove` |

**STILL UNSCOPED, ON PURPOSE - a route that names no association has nothing to scope to**:
`isAssociationSuperAdmin(user)` ("MANAGE_ASSO in the BDE of at least one space") still opens
`POST /associations` (creating one), the categories, the carte, the document-reviewer grants and the
reviewer document listing (`GlobalAdminOrBdeSuperAdminGuard`, `ReviewerAccessGuard`), and the
client's admin navigation. `isUserBdeAdmin` ("a validator somewhere") opens the pending queue and
the greyed pending events on the agenda. `MODERATE` stays global (D23). Whether a BDE should keep
those cross-space routes is WP7's question (a BDE grants within its space; cross-space capabilities
stay with global admins) - it is not decided here.

Proof: `spaces/bde.integration.spec.ts` runs the predicate against PostgreSQL with migrations 071 and
072 (two BDEs, one governing two spaces; clubs reaching one space, a whole campus, two spaces, every
space, a space with no BDE, and none) and asserts who validates, who is told, each user's reach and
the list filter; a control with the space test removed fails 10 of its 13 cases.

### Creating an entity: two routes, two tiers

A BDE holding `MANAGE_ASSO` still creates through `POST /associations` (unscoped: there is no
association yet). That route keeps its own rules. The entity reaches the creator's campus by default,
the BDE must govern that campus (`AUDIENCE_OUTSIDE_BDE_CAMPUS`), and an institution is a global admin's
alone.

**The admin create form on `/admin/spaces` (`POST /associations/admin`, owner 2026-11-02) is
PLATFORM-ADMIN ONLY.** It is the one route that places an entity in spaces the creator does not hold
and hands it a first admin, both cross-space acts that D24 keeps with global admins. An institution's
first admin never holds `MANAGE_MEMBERS`: an institution's members are managed by the platform admin
only (owner, 2026-11-02; `ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY`, the one rule of
[the grant ceiling](#the-grant-ceiling-who-may-write-which-bits-2026-11-02), judged in the one member
writer).
`GlobalAdminGuard` reads `X-Global-Admin` alone, so no BDE flag opens it. The service refuses a
placement from anyone else as well (`ADMIN_ASSOCIATION_PLATFORM_ADMIN_ONLY`), because a guard on the
route is not a check in the function.

Both routes call the same `AssociationsService.create`. An entity created there may have **no member
at all**, which was already the case for every `POST /associations` create (the creator is never
added). The zero-member audit of 2026-11-02 found nothing that breaks:
- the last-admin guards run only when a member holding `MANAGE_MEMBERS` is changed;
- every flag-holder notification with nobody to tell is a no-op;
- the platform admin passes `mayAct` on every management tab.

The one stop is Lydia onboarding: its Responsable and its cashiers must be members
(`LYDIA_RESPONSABLE_NOT_A_MEMBER`, `LYDIA_CASHIER_NOT_A_MEMBER`), so that step waits for a first member.
[admin](frontend/modules/admin.md#the-catalogue-and-the-create-form-adminspaces-owner-2026-11-02)

### Why it exists

The same question had **four** different answers before this audit, and they disagreed:

- the route guard granted the super-admin every flag;
- `canPostAs` and `canManagePayoutAccount` forgot the super-admin entirely;
- the calendar edit/delete pair escalated through `VALIDATE_EVENTS` instead;
- `GET :id/cotisation-options` answered `mayGrant: false` to a BDE super-admin whom the
  `POST :id/cotisants` guard - the endpoint that control calls - would have accepted. The UI hid a
  button the API allowed.

A right spelled out per call site drifts per call site. `mayAct` is the whole policy; a new check
calls it and adds **no second axis of its own**.

## What each flag gates, measured

54 routes declare a flag through `@SetMetadata(PERM_FLAG_KEY, ...)` +
`GlobalAdminOrAssociationRoleGuard`. **Six of the twelve flags declare none** - they are enforced
elsewhere, which is exactly why the audit had to read call sites rather than count decorators.

| Flag | Bit | Guard-declared routes | What it actually gates |
| --- | --- | --- | --- |
| `POST_AS_ASSO` | 0 | 0 | `canPostAs` - publishing a post in the association's name (`posts.controller.ts`); **editing and deleting** those posts (`PostsService.assertMayManage`, and the `canManage` field it is served through); and seeing rejected events on its calendar |
| `PROPOSE_EVENT` | 1 | 2 | `POST :id/events`, `GET :id/link-candidates`; also `PATCH`/`DELETE :id/events/:eventId` inline, and it is the audience of every event-action notification |
| `MANAGE_MEMBERS` | 2 | 14 | members (add / rename / remove / reorder), the logo, `PATCH :id` itself, tags, cotisants and cotisation tiers, plus the exports. Also whether `listMembers` returns bitmasks at all, and whether a form may grant a cotisation tag |
| `MANAGE_DOCUMENTS` | 3 | 8 | the private document vault (including `GET :id/vault-key`) and the association notes |
| `MANAGE_FORMS` | 4 | 1 | `GET :id/forms`, plus `assertFormManager` on every form write and every submission read |
| `VALIDATE_EVENTS` | 5 | 0 | BDE only, **scoped to the associations its spaces reach** (WP6c step 2, above). `mayValidateEvent` / `mayValidateEventsOf` - validating, rejecting, editing and deleting those associations' events, and depositing one on their calendars. **It never validates by typing**: a deposit is a proposal like any other (2026-09-14) |
| `MANAGE_ASSO` | 6 | 0 | BDE only. Creating an association through `POST /associations` (unscoped: there is none yet; never the platform admin's `POST /associations/admin`, [below](#creating-an-entity-two-routes-two-tiers)), **deleting one** it governs (`DELETE :id`, widened from global-admin-only 2026-09-10, scoped 2026-10-04), and **being the super-admin tier above** on the associations its spaces reach |
| `MODERATE` | 7 | 0 | BDE only. `isContentModerator` - reports, mutes and comment deletion (`moderation.controller.ts`), plus editing and deleting any post (`assertMayManage` and the `canManage` field). **Pinning stops being moderation once WP-PIN ships (owner, 2026-11-03)**: it becomes a per-space promotion right ([section 11](spaces-and-audiences-reform.md#11-wp-pin---a-pin-is-a-promotion-per-space-not-a-global-flag-decided-2026-11-03)); until then `pinPost`/`unpinPost` and `canPin` still ride `MODERATE` |
| `MANAGE_PRODUCTS` | 8 | 21 | the boutique, purchases and their exports, webhook failures, the whole payment-delegation tree, and the cotisation settings on `PATCH :id` |
| `MANAGE_PAYOUT_ACCOUNT` | 9 | 0 | `GET :id/manage-permission`, which core-service asks before opening Connect onboarding; `GET :id/payout-account`, the Lydia panel's read of the vendor token and dashboard URL |
| `MANAGE_PARTNERSHIPS` | 10 | 8 | partnership cards, their icons, their codes and their claims |
| `MANAGE_BOOKINGS` | 11 | 0 | nothing yet: the right of the planned bookings module (the bookings chantier, WP-B0). In the admin preset, inherited by a BDE super-admin, backfilled to every `MANAGE_FORMS` holder by migration 083 |

**Deploy order and old clients for `MANAGE_BOOKINGS` (bit 11).** The admin preset is now 3871. An OLD server
validates `permissions` against its own `ALL_PERMISSION_FLAGS` (at most 2047) and answers 400 to a mask above it,
so a new client talking to a server not yet deployed fails to add an admin - the same shape as
`MANAGE_PARTNERSHIPS`: deploy the server first. Conversely an admin added from an OLD app keeps the old preset
(1823, no bit 2048) and lacks the right; that is not fixed by a second backfill but by WP-B1 of the bookings
chantier, which is where the right first has an effect.

Nothing is dead: every flag has at least one call site. Re-measure the table rather than trusting it
- one pass over the `@SetMetadata` decorators and one over `AssociationPermissionFlag.` references
in `apps/social-service/src` reproduces it in seconds.

**THE CHECKBOX A MEMBER SEES IS NOT THE COLUMN ABOVE, AND TWO OF THEM NAMED THE WRONG THING.**
`AssociationMemberRow` renders one `asso_flag_*` label per flag. `MANAGE_PRODUCTS` read "Gerer les
paiements (boutique)" and `MANAGE_PAYOUT_ACCOUNT` read "Gerer les paiements en ligne" - two nearly
identical checkboxes, and neither is about taking a payment: the first is the catalogue AND the
cotisation settings (see its row above), the second is the bank account the payouts land in. They
now read "Gerer la boutique et les cotisations" and "Gerer le compte bancaire", and the key follows
the flag (`asso_flag_manage_payout_account`).

**A message that tells a reader to go and ask someone holding a permission must quote a label that
EXISTS.** The cotisation screen named "Gerer les produits", which the editor has never offered, so
the instruction sent readers hunting for a checkbox that is not there. `paraglideMessages.test.ts`
now holds every `l'acces « X »` in the French file to the set of real labels, and requires the
English sentence for the same key to name that flag's English label - the drift a reword in one
locale causes in the other.

## A right the client cannot compute: the capabilities served on a post

A post published in an association's name has its `authorId` **deleted from every response** - the
whole point being that the association speaks, not a person. The feed card nevertheless drew its
edit and delete controls from `authorId === currentUserId`, a comparison against a field that is
never present on exactly those posts. The result was invisible rather than noisy: no request was
made, so no refusal was logged, and an officer editing their own announcement simply had no button.
Making them a platform administrator "fixed" it, which is what the report looked like from outside.

Two things follow, and they are the shape of the repair:

1. **The capabilities are served, per reader.** `PostsService` stamps every post it returns with
   `canManage`, `canPin` and `canReport`, resolved once per request: `viewerContext` asks
   `mayActOnAny` for the associations on the page and `isContentModerator` for the reader, two
   queries for a whole feed whatever its length, and `viewerCapabilities` decides each row. The
   client renders each control from its field and derives nothing.
2. **The write guards are the same predicates.** `assertMayManage` gates `PATCH`/`DELETE`,
   `assertContentModerator` gates `pin`/`unpin`, so a visible control and an accepted write cannot
   disagree.

**One field per control, because the controls do not share a rule.** A moderator edits, deletes and
pins a post it did not publish and is still entitled to report it; an association's officer edits and
deletes its own, pins nothing, and has nobody to report itself to. Folding the three into one boolean
is what made the report button appear on a post the reader had published and the pin button follow
`isGlobalAdmin` alone.

### The three tiers that reach a post

| Tier | How it is known | Edit / delete | Pin | Report |
| --- | --- | --- | --- | --- |
| Platform administrator | `X-Global-Admin: true` | yes | yes | yes |
| Content moderator | `isContentModerator` - `MODERATE` in a BDE | yes, on any post | today yes, globally; WP-PIN: only in the spaces its BDE governs, institution posts included (G9 does not remove it) | yes |
| The post's publisher | its author, or `POST_AS_ASSO` on the association it speaks for | yes, on its own | no | no - it would be reporting itself |
| Any other logged-in reader | - | no | no | yes |

`isContentModerator` is not `mayAct`: it asks "does the BDE curate the whole feed", which is not
association-scoped - and stays GLOBAL after WP6c step 2 scoped the calendar and MANAGE_ASSO (D23). It lives on `AssociationsService` because
two surfaces ask it - the moderation endpoints and the post controls - and the second used to say
`isGlobalAdmin` alone, which is how a BDE holding `MODERATE` could delete a reported COMMENT and not
touch the post around it.

**An association post answers to `POST_AS_ASSO` alone** - its author holds no separate claim. Whoever
may speak in the association's name may correct what was said; whoever lost that right may not. This
takes nothing from anyone: `canPostAs` is the same flag, so every publisher held it at the time. A
BDE super-admin is still excluded by `SUPER_ADMIN_EXCLUDED_FLAGS`, unchanged and for the same reason
- administering an association is not speaking for it.

`mayActOnAny` is `mayAct` batched over many associations, in the same file and built from the same
three tiers, because a feed page decides a dozen rows per render and a per-row `mayAct` is a dozen
round trips. `associations.service.may-act.spec.ts` asserts the two agree id by id.

## The grant ceiling: who may write which bits (2026-11-02)

`MANAGE_MEMBERS` answers WHO may write a member's bitmask; until 2026-11-02 nothing answered WHICH
bits, so a granter could grant flags it did not hold. `apps/social-service/src/associations/member-flag-ceiling.ts`
is the second half, judged in the service at the write (`addMember`, `updateMemberRole`,
`removeMember`), so no route reaches a bitmask without it. Those three are the only writers of
`association_members` outside migrations and the dev seed: there is no invitation, accept,
transfer or bulk-import path (the unused `AddMembersBatchDto` was deleted).

| Granter | Ceiling (`grantCeiling`) |
| --- | --- |
| Platform administrator | every flag |
| BDE super-admin of this association | every flag (owner, 2026-11-02) - see below |
| Ordinary member holding `MANAGE_MEMBERS` | its own row's flags |

- **Granting and revoking are one rule.** The bits a write CHANGES (`before XOR after`) must sit
  under the ceiling, so a member can neither add nor remove a flag it does not hold - otherwise it
  could strip every right above its own (the treasurer's payout right). A role rename sends the
  bitmask unchanged and passes. Bits the server strips by kind (`writablePermissions`) are compared
  through the same filter, so they never count as the granter's change.
- **Removing a member is a revocation of everything it holds** (`before` = its flags, `after` = 0):
  otherwise a member holding only `MANAGE_MEMBERS` could remove the treasurer and re-add them with
  nothing. Removing a target above the remover's ceiling takes a super-admin or the platform admin;
  leaving is the "Quitter" button (below); the last-admin guard is unchanged. The delete is
  conditioned on the bitmask judged, like the update (`MEMBER_CHANGED_MEANWHILE` otherwise).
- **The "Quitter" button** (owner, 2026-11-03): every member leaves an association from its page
  without asking anyone, except the last holder of `MANAGE_MEMBERS`, refused
  `400 ASSOCIATION_LAST_MEMBER_MANAGER` (the sentence asks them to hand the right on first). The
  route is `DELETE /api/associations/:id/members/me`: `NginxAuthGuard` only, no role guard, and the
  row it removes is the caller's own, named by the vouched `x-user-id` and never by a parameter
  (`AssociationsService.leaveAssociation`). Neither the ceiling nor the institution rule judges it,
  an institution's member included; the BDE bypass of the last-manager guard does not apply to a
  leaver. Tests: `member-flag-ceiling.spec.ts` (an ordinary member leaves, the last manager is
  refused typed, a non-member touches nobody) and `associations.controller.leave.spec.ts` (the
  guards, the path declared before `:id/members/:userId`, no target parameter).
- **Peer deposition and the passation** (owner, 2026-11-03, verbatim): *"Tout ce qui concerne une
  passation doit pouvoir se faire sans admin plateforme. Si le secrétaire veut ajouter et mettre les
  permissions au nouveau secrétaire (respectivement président, trésorier...) puis se retirer, il
  faut que ce soit faisable."* So a member holding `MANAGE_MEMBERS` may remove that right - or any
  right within its own ceiling - from the president, as long as the president is not its last
  holder. This is the existing rule (the ceiling plus the last-admin guard), not a new one; no code
  changed. `member-flag-ceiling.spec.ts` pins it: the secretary adds the new secretary with its own
  flags, then leaves through the "Quitter" route, and a member manager takes `MANAGE_MEMBERS` from a
  president who is not its last holder; a president's whole mask (`POST_AS_ASSO`,
  `MANAGE_PAYOUT_ACCOUNT`, `MANAGE_PRODUCTS`) handed to a newcomer or to a member promoted through
  the roster editor; `member-last-manager.integration.spec.ts` runs the same flows on PostgreSQL.
  **The inherent limit**: a flag can only be handed on by someone who holds it, so a flag whose LAST
  holder has already left can be granted again only by a BDE super-admin of the association, or by
  the platform admin when no BDE governs it. A passation therefore hands the rights over BEFORE the
  outgoing member leaves, which is the order the owner described.
- **The last-manager guard is serialised** (2026-11-03): the count of `MANAGE_MEMBERS` holders and
  the delete or update it protects run in ONE transaction that first takes the association
  `FOR UPDATE` (`underMemberLock`, the lock order `remove` uses), on the remove, leave and demote
  paths alike. Before, two managers leaving or demoting each other at once both counted two and left
  none; `member-last-manager.integration.spec.ts` proves exactly one succeeds, deterministically (a
  third connection holds the lock until both writes are seen waiting on it; with the lock removed
  the spec fails on every run). Neither a leaver nor a member demoting ITSELF ever takes the
  BDE/platform bypass of that guard, through `members/me`, `members/<own id>` or a `PATCH` of its
  own row.
- **The account erasure meets the same lock, and is never refused by it** (2026-11-03). Its first
  statement (`ERASURE_ASSOCIATION_LOCK_SQL`) locks every association the account touches - its
  memberships included - in id order, `FOR NO KEY UPDATE`, before its `association_members` delete.
  That strength conflicts with the guard's `FOR UPDATE`, so an erasure and a leave or demotion on one
  association run one after the other, and each takes exactly one association lock before any
  member row, so no cycle exists. It stays `NO KEY UPDATE` (not `FOR UPDATE`) so a proposal
  decision's `KEY SHARE` is not serialised behind an erasure. The erasure does not ask the guard: an
  account must be erasable, so erasing the LAST manager leaves the association with none - expected,
  and recovered by a BDE super-admin of it, or by the platform admin when no BDE governs it.
  `member-last-manager.integration.spec.ts` runs an erasure of one manager against a leave of the
  other: the leave waits, then is refused.
- **The super-admin tier cannot be acquired through the audience.** A BDE becomes an association's
  super-admin by governing a space its rules reach, and a BDE may write audiences - so the audience
  bound must have the same granularity as governance. It was per CAMPUS while governance is per
  SPACE, and one campus holds two BDEs: a BDE could rewrite another BDE's association into its own
  space, then seat itself there. Since 2026-11-02 the bound is per space
  (`audience-policy.ts` `ruleInsideGovernedSpaces`, fed by `BDE_SPACE_STANDINGS_SQL`): a BDE writes
  the audience only of an association whose current rules all sit in spaces it governs, every rule
  it writes must too, and a whole-campus rule counts as inside only when it governs EVERY opened
  space of that campus. This closes the two-granularity gap until the governance reform lands
  (WP-R1 of `docs/wiki/spaces-and-audiences-reform.md`, on draft PR #2948). Proven against real
  SQL in `spaces/audience-takeover.integration.spec.ts`.
- **The super-admin is uncapped on purpose.** `SUPER_ADMIN_EXCLUDED_FLAGS` is about INHERITANCE:
  the tier never EXERCISES `POST_AS_ASSO` or `MANAGE_PAYOUT_ACCOUNT` through `mayAct`. It may still
  WRITE them into a row, its own included - a BDE officer is often another association's president.
  Only an explicit row carries them, and every super-admin write that grants one is logged at info
  (`[MEMBER-CEILING] ... a BDE super-admin granted <FLAGS> on association <id>`, no user id), after
  the write lands. **`MANAGE_PRODUCTS` is audited the same way** (`SUPER_ADMIN_AUDITED_GRANTS`,
  from the review of #2967): the tier inherits it, but an explicit row of it makes its holder one of
  the association's OWN managers, the standing that accepts a list's payment delegation - so a
  super-admin seating itself with it is a visible act. Auditing changes nothing about who may grant
  it.
- **No BDE MANAGES an institution, but the agenda is the BDE's** (owner, 2026-11-02, corrected
  2026-11-03: *"Aucun BDE n'a les droits de gestion sur une institution, mais c'est le BDE qui a tous
  les droits sur l'agenda des formations dont il est le BDE"*). Two predicates in `spaces/bde.ts`,
  one space rule:
  - **management** - `holdsBdeFlagOverSql` never holds over an association of type `institution`,
    so the super-admin tier (`mayAct`, `mayActOnAny`, `DELETE :id`, the archive and profile at
    `MANAGE_MEMBERS`, members, audience) reaches none, whatever spaces its audience reaches; the
    last-admin bypass of the member routes reads this one too. `editRights` drops the tier for an
    institution on the client.
  - **agenda** - `holdsBdeAgendaRightOverSql` (`VALIDATE_EVENTS`, fixed in the predicate) follows
    the spaces an event TARGETS, whoever organises it: the BDE of those spaces validates, rejects,
    edits, deposits on and declares a break for an institution's event like any other. Until
    per-event targeting (WP-E) an event targets its organiser's audience rules, so an institution's
    event is validated by a BDE governing the spaces it targets, or by the platform admin.
    `mayValidateEventsOf`, the pending queue, the proposal notification and `me/bde-reach`
    (`validateEvents`) read it.
  - **a BDE is managed by nobody but itself** (owner, 2026-11-03: *"Un BDE n'est géré par
    personne"*): the management predicate also excludes a target that is the BDE of any space,
    unless the holder's membership is in that same BDE. One saint-etienne BDE's whole-campus rule
    reaches the other's spaces, and the space rule alone made each the uncapped super-admin of the
    other.
  - **the audience: "Lire tout, modifier dans ses espaces"** (owner, 2026-11-03): a star reads every
    audience of its campus, writes only an entity it governs, and adds or removes rules inside its
    own spaces only; a wider rule already in force stays as it is (`AUDIENCE_RULE_BEYOND_BDE_SPACES`),
    the platform admin's to change. A non-admin creator's entity starts inside its spaces
    (`creatorDefaultRules`). [profiles-and-access](profiles-and-access.md#audiences-policy-as-built-wp-a-2026-10-08)
    has the mechanism.
  - **an institution's proposal** is told to the BDE validators of the spaces it targets AND to the
    platform admins when a targeted space has no BDE, or it targets none
    (`TARGETS_AN_UNGOVERNED_SPACE_SQL`); the WARN is left for the case nobody at all is told.
  - **leaving is the "Quitter" button** (owner, 2026-11-03): an institution's member leaves like
    any other, judged by neither the institution rule nor the ceiling; only the last holder of
    `MANAGE_MEMBERS` is refused (see the bullet on the button above).
  - **no BDE moderates an institution's content; only the platform admin does** (owner,
    2026-11-03). Recorded, not yet enforced: `isContentModerator` is platform-wide and takes no
    post ([backlog](backlog.d/p1-no-bde-moderates-an-institutions-content.md)).
  Proven against real SQL in `bde.integration.spec.ts` (the agenda matrix with two institutions)
  and through the real route guard in `audience-takeover.integration.spec.ts` (a BDE validates an
  institution's event targeting its space, not one targeting only another BDE's, and still cannot
  touch the institution's members or profile).
- **Institutions are the platform admin's alone** (D20), ONE rule with ONE code,
  `ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY` (`assertInstitutionMemberWrite`): add,
  update and remove answer 403 to anyone else, and a write that HANDS an institution's member
  `MANAGE_MEMBERS` is a 400, the platform admin's included (revoking it from an older row stays
  free). Reordering stays `MANAGE_MEMBERS` (it writes no right).
- **One writer inserts a member row**: `insertMembership`, used by `addMember` AND by the admin
  create's first admin. It takes the granter and judges it - the institution rule, the ceiling, the
  audit line - so no door skips them; the create passes its platform admin, so the first admin is
  held to the institution rule like any other add (`admin-create.integration.spec.ts`).
- **Refusals are typed**: 403 `MEMBER_FLAGS_BEYOND_GRANTER`, logged at WARN with the association
  and the flag names, never a user (the editor never offers such a bit; an older installed client
  still can).
- **The client mirrors it** with `grantableFlags(ctx)` in `frontend/src/lib/associations/api.ts`:
  the row editor disables a box outside it, the add presets are cut to it, and the members section
  of an institution is drawn for the platform admin only (`editRights(...).memberRoster`).
- **Known bound**: the ceiling reads the granter's row in the same request as the write, exactly as
  the route guard reads `MANAGE_MEMBERS`; a concurrent demotion of the granter is not serialised
  against it, as it is not against any guarded route.
- **Rows written before** are not rewritten. The read-only count of rows whose flags exceed what
  their path now allows is in the pull request that introduced the ceiling; any correction waits for
  the owner.

## What is deliberately NOT `mayAct`

Three shapes look like the same question and are not. Folding them in would have been wrong:

1. **The event validator grant (`VALIDATE_EVENTS` in a BDE).** A genuinely different right - "the
   BDE curates the calendar of the associations its spaces reach" - not a member flag on THIS
   association, so `mayAct` (which reads the association's own bitmask) cannot express it. Since
   WP6c step 2 it IS scoped to an association, through `mayValidateEventsOf`; `isUserBdeAdmin`
   survives only as "a validator somewhere", which opens the queue.
2. **The listing queries** - `associationsWhereUserHasFlag`, `canViewPendingCalendarEvents`,
   `callerHasAnyBdeFlag`. They answer "which associations" or "any at all", not "may they here".
   `forms.service.list()` needs the first shape and correctly keeps it.
3. **Existence.** `mayAct` answers rights, never existence: acting on an association that does not
   exist is a 404 from whoever loads it. `canPostAs` and `canManagePayoutAccount` each keep their own
   `findOne`, and each says why - a post must not name a deleted association, and core-service must
   not open a Connect account against a ghost id.

### The one panel that holds two tiers, and the rule it produced

The association Danger panel offers **archive** and **delete**, and they are not the same right:

| control | route | admitted by | reversible |
| --- | --- | --- | --- |
| Archive | `PATCH :id { archived }` | `GlobalAdminOrAssociationRoleGuard` at `MANAGE_MEMBERS` - so the association's own admin, and the super-admin tier | yes |
| Delete | `DELETE :id` | `GlobalAdminOrBdeSuperAdminGuard` - global admin, or a BDE `MANAGE_ASSO` holder | **no** |

Until 2026-09-09 the client gated the whole panel on the stricter of the two, so a BDE administrator
was shown NEITHER - a control the API accepts, hidden from the person allowed to use it, which is
D3 again in a new place. The panel now opens on the right to ARCHIVE and the delete card carries its
own tier, defaulting to `false` so it is offered on an explicit grant rather than by omission.

`DELETE :id` itself was widened on 2026-09-10 by the user. The argument is symmetry: `MANAGE_ASSO`
already CREATES associations through `POST /`, and administering them without being able to end one
leaves every mistake permanent. **The delete tier is NOT `mayActOnAssociation`** - it is not a flag
on THIS association at all, so an association's own admin never holds it however many flags they
have, and a BDE super-admin holds it everywhere.

`AssociationsService.remove` had no log line, which was survivable only while one person could reach
it. It now counts the members and events it is about to destroy, before destroying them, and names
the caller.

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
