# Spaces, audiences and dependencies - a reform proposal (2026-11-02)

**Status: DECIDED (section 0), and being built work package by work package: WP-D1 is BUILT, its
migrations held for the owner (2.8).** Written for the owner to decide. It extends
[profiles-and-access](profiles-and-access.md) (D16-D41, the audiences chantier, WP-C read grants,
WP-F5/F6) and does not restate it. Every `file:line` is from `main` at the time of writing
(`apps/social-service/src/` unless said otherwise).

**The model in one paragraph.** Two independent axes, each with its own panel on `/admin/spaces`.
**Audience** says who SEES an entity (today's grid). **Dependencies** say who GOVERNS it, on two
levels at most: an association or a list may depend on ONE BDE; a BDE and an institution depend on
nothing; whatever depends on nothing is the platform admin's. Separately, every SPACE has at most one
governor - a BDE or an institution - which validates the events shown in it. The axes are
correlated by defaults and shown side by side, never coupled.

## 0. What prompted it, and what is already decided

The owner, asked on 2026-11-02 who validates content that crosses spaces, chose **"the BDE of
origin alone"** and added: *"Il faut effectivement peut-etre reflechir a des rattachements. Et
peut-etre reformer un peu les espaces/audiences, je ne sais pas si on peut ameliorer les choses..."*

| # | Decision (owner, 2026-11-02) | What the code does today |
| --- | --- | --- |
| G1 | Content crossing spaces is validated by the BDE of origin ALONE - **amended for events by B6** | ANY BDE whose space the association reaches (1.3) |
| G2 | `MODERATE` is scoped to what the BDE governs | global (D23) |
| G3 | Nobody edits another person's post | the moderator tier may edit any post (`posts/posts.service.ts:592-608`, `canManage`) |
| G4 | Republication stays THE inter-campus mechanism | it is (D38, D38b), beside co-organisation (D39) |
| G5 | Public data matches only what Portail-etu shows | out of scope here |
| G6 | An institution's members are managed by the platform admin only | its own `MANAGE_MEMBERS` holders and any reaching BDE manage them (section 6, row 5) |
| G7 | A BDE secretary may place themselves in any association they govern | already true through the super-admin tier (`mayAct`, `associations/associations.service.ts:2018-2035`) |

| Round | # | Answer | Effect |
| --- | --- | --- | --- |
| 1 | A1 | **The campus is NOT the unit**: *"il peut exister plusieurs formations pour un campus, et un BDE par formation"* (one campus: one BDE for four formations, another for the fifth) | governance attaches to an entity, never to a campus |
| 1 | A2 | *"Non, sauf l'existant"*: an association or a list addresses only its governor's reach; existing wider audiences stay until edited | 2.5 |
| 1 | A3 | A BDE is designated per formation x campus, as today | every bound is per space (2.6) |
| 1 | A4 | Only the platform admin changes a dependency, and every change is logged | 2.7 |
| 2 | B1 | *"On va faire la migration a la main [...] un reglage a la main [...] accessible des admins uniquement. Et par defaut evidemment le BDE qui la cree. (idem pour les listes)"* | 2.7 |
| 2 | B2 | *"on peut avoir une asso/liste/institution sans rattachement"* | no parent = platform admin |
| 2 | B3 | Another BDE sees the association and proposes a republication or a co-organisation; it validates and manages nothing | 2.4 |
| 2 | B4 | ~~an institution is governed by what the admin attaches it to~~ - **superseded by D2** | - |
| 2 | B5 | A personal post is moderated by the BDE governing the author's space; under two, either | 2.4 |
| 2 | B6 | *"Chaque BDE pourrait valider ou non pour la formation dont il est le BDE ?"* | section 4 |
| 3 | C1 | Narrowing a post's or an event's audience is for INSTITUTIONS ONLY | section 3 |
| 3 | C2 | *"deux grands panneaux de gestion : l'un pour l'audience, l'autre pour les 'dependances'"* | section 2 |
| 4 | D1 | "Oui pour le parent": a parent writing a child's audience stays inside its own spaces; the platform admin may write anything, a mismatch is shown, never refused | 2.5 |
| 4 | D2 | **"Enfants directs. Et il ne peut y avoir que deux niveaux maximum. Un BDE n'est gere par personne. Les associations/listes peuvent etre gerees par un BDE. Les institutions ne peuvent pas etre gerees, ce sont des entites differentes."** | 2.2: the dependency axis is a two-level forest, enforced by the database |
| 4 | D3 | "Admin ou institution": a formation with no BDE is validated by the platform admin, or by an institution the admin places it under | 2.3 |
| 4 | D4 | "Selon le changement": a date move re-opens every slice, an audience change only the slices whose spaces changed, text none | 4.2 |
| 4 | D5 | *"Et si plusieurs associations/listes/institutions sont partenaires d'un evenement, comment on gere tout ca ? Est-ce qu'on interdit des partenariats ?"* | section 5 |
| 4 | D6 | *"On peut faire le point sur toutes les differences/similarites entre associations/listes/institutions si tu veux"* | section 6 |
| 5 | E1 | **Partnerships are KEPT** | section 5.3 |
| 5 | E2 | **A partner edits the text and the poster, and may withdraw; only the organiser changes the date, the audience or the partner list, and only the organiser deletes** | closes P14 (5.2, WP-Q1) |
| 5 | E3 | **A BDE MAY delete an association or list that depends on it**, as today; the `MANAGE_ASSO` comment that says otherwise is wrong and is corrected (WP-R5) | section 6, row 8 |
| 5 | E4 | ~~Lists lose Lydia payments, the shop and the document vault~~ - **CORRECTED by the owner the same day**: *"en fait je ne veux pas retirer la boutique aux listes, ni les formulaires ou autres payants. Par contre, une liste ne peut pas avoir de compte Lydia, donc elle est obligee de deleguer."* Lists KEEP the shop (cotisation included), paid forms and every paid feature; a list may NOT hold its own Lydia account, so its payments go through payment delegation (`paymentParentAssociationId`). The vault was not decided by the correction; it is kept (F1) | WP-L (section 8.1, superseded by F2) |
| 5 | E6 | **Republication for EVERY type, without exception**: lists and institutions may ask a person to republish their post, so an institution may carry a student's personal post with the student's consent (this lifts the D34-D36 point); list posts become member-repostable | its own pull request; section 6, rows 11-13 |
| 5 | E7 | **A new "edit profile" permission, separate from `MANAGE_MEMBERS`**, granted by migration to every current `MANAGE_MEMBERS` holder | its own pull request; section 6, row 9 |
| 5 | E5 | **No BDE ever governs an institution** (decided in another thread; fixed at the predicate level by #2949 - archive, members, profile, audience, and every path that asks the same predicate) | WP-R0's institution half is #2949 |
| 6 | F1 | **Lists keep the document vault**, as today | section 6, row 16; section 9 question 1 closed |
| 6 | F2 | **Lists collect through delegation.** On `main` a list sells nothing (10, `selling-kinds.ts:13`); the widening is built in its own pull request, `feat/lists-collect-through-delegation`, which supersedes WP-L as written in 8.1 | 8.1, 10.2 |
| 6 | F3 | **Institutions sell nothing, as today** (no shop, no paid form, no cotisation, no Lydia account) | section 6, rows 16-18; 10.6 question 1 closed |
| 6 | F4 | **Only the RECEIVER's own managers (`MANAGE_PRODUCTS` on the receiving entity) and the platform admin may accept a delegation; never a governing BDE.** Every acceptance is recorded (who, when, for which child) | 8.1; 10.6 question 2 closed |
| 6 | F5 | **When the receiver revokes the delegation or loses its Lydia account, the list's paid items are paused automatically and the list's managers are notified; everything resumes when a new delegation is accepted** | 8.1, gap G7; 10.6 question 3 closed |
| 6 | F6 | **The receiver may be any association that accepts**; it need not be the list's BDE | 8.1; 10.6 question 4 closed |
| 6 | F7 | **When an event returns to pending, the organiser and the partners are notified with the reason, and so are the validators concerned** | 4.2, WP-Q2, WP-E |
| 6 | F8 | **Build: once this proposal merges, EVERY work package is built.** Every migration stays held for the owner's hand-merge ([held](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)) | section 8 |
| 7 | G1 | Parents for WP-D1: **Claude proposes an entity to parent-BDE list, the owner validates it on his private tracking page, and only then is it applied by a reviewed migration** | WP-D1, 2.7 |
| 7 | G2 | Saint-etienne has **TWO distinct BDEs**: the main one (Autre, ICM, ISMIN, PDIS) and an FSSS BDE (FSSS only); not a duplicate. The second is renamed so the two are told apart; the exact name goes through the validated list (G1) | WP-D1 |
| 7 | G3 | A list whose current parent is the BDS or the BDA (which govern no space): **the governing parent becomes the main BDE**; the link to the BDS or BDA stays as a display-only label ("liste pour le BDS") carrying no right, in a field distinct from the governing parent | 2.2, WP-D1 |
| 7 | G4 | Gardanne: **MINITEL governs all five Gardanne spaces**. Owner: *"En fait, il n'y a en pratique pas d'ICM, FSSS, PDIS a Gardanne."* | WP-D1 (parents list) |
| 7 | G5 | **A new admin interface to manage the existing campuses and each campus's formations**, including a formation spanning two campuses (*"peu utile mais on sait jamais"*) | WP-D1b (section 8) |
| 7 | G6 | The 30 associations whose audience is the whole of saint-etienne take **the main BDE as parent** (it governs 4 of their 5 spaces) | WP-D1 (parents list) |
| 7 | G7 | *"Aucun BDE n'a les droits de gestion sur une institution, mais c'est le BDE qui a tous les droits sur l'agenda des formations dont il est le BDE."* An institution's event is validated by the BDE of each space it targets (per slice under WP-E; the whole event until then), or by the platform admin where no BDE governs a targeted space | 2.3, section 4, WP-E |
| 7 | G8 | Audience writes by a BDE: *"Lire tout, modifier dans ses espaces"*. A BDE always reads the audience of an association on its campus; it adds or removes rules inside its own governed spaces; a rule exceeding them (e.g. the whole campus) stays untouched by it; widening beyond is the platform admin's | 2.5, WP-D2 |
| 7 | G9 | **No BDE moderates an institution's content; only the platform admin does** | 2.4, WP-R4 |
| 7 | G10 | *"Un BDE n'est gere par personne"*, including by another BDE whose audience overlaps it | 2.2 |

Round 7 ids are the owner's own labels; they are distinct from the G1-G7 of the first table.

## 1. The current model

### 1.1 Spaces

- A **space** is one `formation x campus` pair (D16): `spaces/space.entity.ts:18-34`, five
  formations x two campuses = **10 rows**, all present since D17 was relaxed. `openedAt` and the
  "OPEN spaces" wording are vestiges.
- A **reader's spaces**: campus is theirs, formation one of their cursus formations
  (`isReaderSpaceSql`, `spaces/reader-spaces.ts:88-90`; twin `readerSpaces`, 52-63). Staff get their
  campus's agenda by `campusWideReaderCampus` (71-76).
- A space carries ONE optional BDE, `spaces."bdeAssociationId"` (`space.entity.ts:32-33`), of type
  `association` only (`spaces.service.ts:167`). **`setBde` also inserts an audience rule**, and
  `setAudiences` re-adds a BDE's governed spaces (`spaces.service.ts:240-246`): governance and
  audience are coupled both ways.

### 1.2 Audiences

- `association_audiences` rows `(formation | NULL, campus | NULL)`, NULL = "any", matched by
  `ruleReachesSpaceSql` (`spaces/rule-sql.ts:8-12`) at read time.
- Policy (`spaces/audience-policy.ts`): `everyone` refused outside institutions (42-51); default =
  the creator's campus (58-68); a BDE "star" reads and writes inside the CAMPUSES it governs (77-123);
  a non-admin creates on a governed campus (131-141).
- Visibility: a member (D21), OR its rules reach one of the reader's spaces, OR (read paths) a read
  grant (`associationVisibleToUserSql`, `reader-spaces.ts:168-177`). A post or an event has no rules
  of its own (`postVisibleToUserSql`, 411-436; `eventVisibleToUserSql`, 637-641); per-post rules
  (D33) were dropped by D38 (migration `073_republications.sql`).

### 1.3 Governance

- `holdsBdeFlagOverSql` (`spaces/bde.ts:35-41`): U holds F in the BDE of ANY space A's audience
  reaches. Read by `VALIDATE_EVENTS` (`mayValidateEventsOf`, `associations.service.ts:1832`) and
  `MANAGE_ASSO` (`isAssociationSuperAdminOf`, 1980, hence `mayAct`, 2018-2035, and the association
  delete route, `associations.controller.ts:743-757`).
- Audience bounds per CAMPUS (`BDE_GOVERNED_CAMPUSES_SQL`, `spaces/bde.ts:47-49`).
- `MODERATE` unscoped (`isContentModerator`, `associations.service.ts:1994-1998`); 16 call sites ask
  an unscoped BDE question.
- **Two parent-like columns already exist, neither of them governance** (`associations/entities/
  association.entity.ts`): `parentAssociationId` (187-189), "lists only: optional parent association
  (e.g. the owning BDE)", read only to DISPLAY a parent name (`associations.service.ts:644-699`); and
  `paymentParentAssociationId` (113-121), the payment-delegation parent, "purely financial routing +
  accounting access".

### 1.4 Events

- ONE status, `pending | validated | rejected` (`association-calendar-event.entity.ts:3-7`).
- Reach = organiser's audience union each ACCEPTED co-organiser's (`eventVisibleToUserSql`;
  D39); signed-in agenda `restrictToViewerSpaces` (`associations.service.ts:1678-1688`); anonymous
  selection `eventReachesSpaceMatchingSql` (`reader-spaces.ts:204-212`). Readers see `validated`;
  proposers `pending` too (1617-1622).
- Always created `pending` (user, 2026-09-14; `createCalendarEvent`, 2453-2503).
- Decided as a whole (`validateCalendarEvent` 2697-2712, `rejectCalendarEvent` 2715-2741) by
  `mayValidateEvent`: the admin or `VALIDATE_EVENTS` in ANY BDE the ORGANISER reaches (1832-1866;
  controller `assertMayDecideEvent`, `associations.controller.ts:1009-1022`).
- A DATE move demotes a validated event; text, poster, form do not (2545-2627).
- Write and delete: `assertMayWriteEvent` (1870-1900) then `findCalendarEventForAssociation`
  (1382-1401), which matches the organiser OR an accepted co-organiser (section 5.1).

### 1.5 Pain points, measured from the code

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| P1 | **Reach decides governance** | `bde.ts:35-41` | an association reaching two BDEs' spaces is governed by EITHER |
| P2 | **Governance and audience move each other** | `spaces.service.ts:224-258` | neither change is visible as what it is |
| P3 | **Two granularities** (space vs campus), live on the split campus | `bde.ts:35-41` vs `47-49` | each of the two BDEs of one campus may rewrite the other's audiences |
| P4 | **Default audience crosses BDE borders** | `audience-policy.ts:58-68` | every new association on the split campus is governed by both BDEs |
| P5 | **Decision 3 half-enforced** | `audience-policy.ts:42-51` | two-campus audiences still creatable by the admin |
| P6 | **`MODERATE` is global** | `associations.service.ts:1994-1998` | any BDE moderates, pins, unmasks everywhere (`posts.service.ts:606-608`) |
| P7 | **Moderators edit others' posts** | `posts.service.ts:605` | contradicts G3 |
| P8 | **Institutions under BDEs**: no type check in the super-admin tier | `mayAct` 2018-2035; delete route 743-757 | a reaching BDE manages an institution's members, and may DELETE it |
| P9 | **No rule = no governor**, by accident | `bde.ts:28-29` | an institution's events reach no validator |
| P10 | **Only an association can govern a space** | `spaces.service.ts:167` | a formation with no BDE has no validator but the admin |
| P11 | **One validation for many audiences** | entity 3-7; 1832; 637-641 | an event validated by one BDE appears in another BDE's spaces |
| P12 | **An institution cannot narrow an item** | 411-436, 637-641 | the School reaches everyone or nobody |
| P13 | **Accepting a co-organisation widens a VALIDATED event with no validation** | `coorganisation/coorganisation.service.ts:281-300` (`apply` inserts the row, the status is untouched) | the event appears in the partner's spaces on the strength of a validation given for the organiser's |
| P14 | **A co-organiser may delete the organiser's event** | `deleteCalendarEvent`'s member branch, `associations.service.ts:2770-2777`, matches co-owners via 1382-1401 | documented in D39 as built ("edit, poster, delete"); **decided otherwise by E2** - closed by WP-Q1 |

## 2. Two axes: audience and dependencies (C2)

### 2.1 The axes and their panels

| Axis | Question | Stored in | Panel on `/admin/spaces` | Who writes it |
| --- | --- | --- | --- | --- |
| **Audience** | who SEES the entity | `association_audiences` (unchanged) | **"Audience"**: today's grid | the platform admin; a parent BDE inside its own spaces (2.5) |
| **Dependencies** | who GOVERNS the entity: manages, moderates | `associations."parentAssociationId"` (2.2) | **"Dépendances"**: each BDE with the associations and lists under it; BDEs, institutions and unattached entities apart | the platform admin only, journaled |
| **Space governors** | who VALIDATES the events shown in a space, moderates its students' personal content | `spaces."bdeAssociationId"` (a BDE or an institution, 2.3) | same panel, each space under its governor | the platform admin only, journaled |

### 2.2 Two levels, enforced by the database (D2)

- **The parent column is the one that already exists**: `parentAssociationId`, today a display-only
  "owning BDE" of a list. It is generalised to associations and becomes THE governance parent; no
  third parent-like column is added. `paymentParentAssociationId` stays a separate, purely financial
  relation (payment delegation is not governance, and a delegation parent is often not a BDE).
- **The shape (D2):**

| Entity | May have a parent? | May be a parent? |
| --- | --- | --- |
| association that is a BDE (governs at least one space) | **never** - "un BDE n'est gere par personne" | yes, of associations and lists |
| association that is not a BDE | optional: one BDE | no |
| list | optional: one BDE | no |
| institution | **never** - "ce sont des entites differentes" | no |

- **Enforced by constraints, not convention.** A `CHECK` cannot read another row, so the rule is a
  pair of triggers (one migration, replay-safe like the rest):
  - on `associations` (INSERT, UPDATE of `parentAssociationId` or `type`): when the parent is set,
    the row is of type `association` or `list`, is NOT a space governor, and the parent is of type
    `association` AND governs at least one space - otherwise `RAISE` with a stable code
    (`DEPENDENCY_PARENT_NOT_A_BDE`, `DEPENDENCY_CHILD_IS_A_BDE`, `DEPENDENCY_INSTITUTION`);
  - on `spaces` (UPDATE of `bdeAssociationId`): designating as governor an association that HAS a
    parent is refused (`DEPENDENCY_CHILD_IS_A_BDE`). Removing a BDE's last space while it has
    children is NOT refused (a redesignation must stay possible): its children then depend on an
    association that governs nothing, which the predicate treats as no parent (2.4) and the panel
    lists as a mismatch, with a warn log.
  - Two levels follow: a parent is a BDE, a BDE has no parent, so no chain can be longer than one.
  - **A BDE is governed by nobody, another BDE with an overlapping audience included (G10).**
  - **A display-only label is a separate field (G3).** A list made "for the BDS" or "for the BDA"
    (bodies that govern no space) takes the main BDE of its campus as governing parent; the link to
    the BDS or BDA lives in its own column, is shown as a label ("liste pour le BDS") and grants no
    right. `parentAssociationId` therefore never names a body that governs nothing. The column is
    added by WP-D1.
  - The service checks the same rules first, so a refusal reaches the client as a typed 4xx; the
    trigger is what makes a hand-written `UPDATE` unable to break it.

### 2.3 Space governors - an institution included (D3)

The space axis is NOT the parent axis, and D2 does not touch it: **a space's governor may be a BDE or
an institution** (`setBde`'s type check, `spaces.service.ts:167`, widened to `association |
institution`; closes P10). So the admin may place a formation with no BDE under the School, whose
`VALIDATE_EVENTS` holders then answer for it; a space with no governor is the platform admin's. An
institution governing a space is still not a BDE for D2: it never becomes a parent, and nothing
depends on it.

**Institution events (G7, G9).** No BDE governs an institution, but a BDE holds every right over the agenda of the formations it governs: an institution's event is validated by the BDE of each space it targets (per slice under WP-E, the whole event until then), or by the platform admin where no BDE governs a targeted space. No BDE moderates an institution's content; only the platform admin does.

### 2.4 Who governs what, and how the predicates change

| Power | Over an association or list WITH a parent BDE | Over a BDE, an institution, or an entity with no parent |
| --- | --- | --- |
| `MANAGE_ASSO` (administer: members, documents, forms, products; minus `SUPER_ADMIN_EXCLUDED_FLAGS`) | the parent BDE's holders, and the platform admin | the platform admin (and the entity's own officers, as today, for its own data); **never a BDE over an institution (E5, #2949)** |
| institution members | - | **the platform admin ONLY** (G6) |
| `MODERATE` its posts, comments, lives | the parent BDE's holders | the platform admin |
| `VALIDATE_EVENTS` | per SPACE, never per entity: the governor of each space the event reaches (section 4) | same |
| `MODERATE` a personal post | the governor of the author's space; under two, either (B5) | - |

Every other BDE **sees** an entity like any reader, **proposes** a republication or a co-organisation,
and decides nothing of it - except an event's slice in its own spaces (B3, B6). `canManage` loses the
moderator tier (G3): hide and delete, never edit.

**`holdsBdeFlagOverSql(user, association, flag)`** (`spaces/bde.ts:35-41`) keeps its name and loses
its audience join:

```sql
EXISTS (SELECT 1 FROM associations gov_child
  JOIN association_members gov_m ON gov_m."associationId" = gov_child."parentAssociationId"
  WHERE gov_child.id = ${association}
    AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0
    AND EXISTS (SELECT 1 FROM spaces gov_s WHERE gov_s."bdeAssociationId" = gov_child."parentAssociationId"))
```

No recursion (two levels), one join on a key. The last clause makes a parent that governs nothing
govern nobody. Its callers keep their names; `mayValidateEventsOf` moves to the per-space predicate:

```sql
-- U holds F in the governor of space S
EXISTS (SELECT 1 FROM spaces gov_s
  JOIN association_members gov_m ON gov_m."associationId" = gov_s."bdeAssociationId"
  WHERE gov_s.id = ${space} AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0)
```

`isBdeAssociationSql` keeps its meaning ("governs at least one space") for the routes that name no
association; `BDE_GOVERNED_CAMPUSES_SQL` becomes `GOVERNED_SPACES_SQL` (2.6).

**WP-D2 and WP-R4, as built (2026-11-07, after the owner confirmed the parents of migration 130).**
`holdsBdeFlagOverSql` keeps its name, its arguments and every caller, and reads the parent:

```sql
EXISTS (SELECT 1 FROM associations gov_child
  JOIN associations gov_bde ON gov_bde.id IN (gov_child."parentAssociationId", gov_child.id)
      AND gov_bde.type = 'association' AND gov_child.type <> 'institution'
      AND EXISTS (SELECT 1 FROM spaces bde_space WHERE bde_space."bdeAssociationId" = gov_bde.id)
      AND (gov_bde.id = gov_child.id
        OR NOT EXISTS (SELECT 1 FROM spaces bde_space WHERE bde_space."bdeAssociationId" = gov_child.id))
  JOIN association_members gov_m ON gov_m."associationId" = gov_bde.id
  WHERE gov_child.id = ${association}
    AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0)
```

- **One difference from the sketch above, on purpose:** the entity ITSELF is a candidate governor
  when it is a BDE, so a BDE's own officers keep governing the BDE (its super-admin tier, its own
  content's moderation), as they did. A BDE has no parent, and the last clause refuses the parent
  path for a child that governs a space, so no other BDE ever joins (G10) even through a
  hand-written row.
- **The `type` tests do not trust the triggers of migration 131**: a hand-written parent on an
  institution, or an institution named as a parent, governs nothing (E5, G9) - pinned in
  `bde.integration.spec.ts` and `bde-moderation.integration.spec.ts`.
- **What follows from the predicate alone, every consumer unchanged**: `MANAGE_ASSO`'s super-admin
  tier (`isAssociationSuperAdminOf` -> `mayAct`, `mayActOnAny`, `GlobalAdminOrAssociationRoleGuard`,
  `GET me/bde-reach`'s `manageAsso`, the payment-delegation audit line), the delete route (**E3**: the
  parent's `MANAGE_ASSO` holders delete a child; an institution is still refused
  `INSTITUTION_DELETE_ADMIN_ONLY`, and an entity with children or spaces `DEPENDENCY_DELETE_ADMIN_ONLY`),
  the last-admin bypass of the member routes (`VALIDATE_EVENTS` in the parent), and **WP-R4**: every
  MODERATE reading of content published in an association's name (`bdeModeratesPublisherSql` -> posts,
  comments, lives, live chat lines, reports, the comment bin's publisher set). Personal content stays
  per space (B5), pins stay per space (`posts/space-pins.ts` never read this predicate: a pin is a
  promotion, not moderation), and the AGENDA stays per space (`holdsBdeAgendaRightOverSql`, until WP-E).
- **Audience writes (G8, D1)**: `SpacesService.starBounds` reads three facts at `MANAGE_ASSO` - the
  READ bound (`BDE_SPACE_STANDINGS_SQL`, every BDE the star holds the flag in: its campus), whether it
  governs the entity (the predicate), and the WRITE bound (`ENTITY_GOVERNOR_SPACE_STANDINGS_SQL`: the
  spaces of the entity's own parent). A star writes only its child, and only inside its parent's
  spaces - never inside another BDE it also manages. A parent reads its child wherever it reaches;
  `editable` is false for every rule of an entity the reader does not govern.
- **A refused moderation act on an entity with no governing parent** is classified
  `MODERATION_RESERVED_TO_PLATFORM_ADMIN` (`reservedPublisherSql`), since nobody else may act on it.
- **`setParent` is a privilege change now**: moving a child names at WARN the child's member rows
  held by the FORMER parent's `MANAGE_ASSO` holders (`FORMER_PARENT_SEATS_SQL`) - rows they may
  have written for themselves while governing it, which the move does not revoke (neither did the
  reach rule). Revoking is the platform admin's decision, never a side effect.
- **No migration.** `EXPLAIN (ANALYZE)` on a production-shaped fixture (97 entities, 74 parented,
  ~3000 member rows): one child 0.25 ms, every association a user governs 0.8 ms, 20 publishers
  0.6 ms - nested loops over a primary key and `association_members ("associationId")`, the spaces
  table hashed once; the plans are in the pull request.
- **Production at merge (read-only, coordinator, 2026-11-07)**: 74 children (30 associations, 44
  lists), every parent an association governing a space; 19 associations without a parent - the BDEs
  among them keep governing themselves, the others are the platform admin's alone from this release.


### 2.5 Correlated, never coupled (D1)

- **Defaults derive from the parent.** At creation the parent is the creating BDE (B1); a creator
  holding `MANAGE_ASSO` in two BDEs picks one; a platform admin creating picks one or none; an
  institution has none. The default audience is the spaces the parent governs (`smallestRules`);
  with no parent, the creator's own spaces. Closes P4.
- **No silent change.** Changing a parent never writes an audience and vice versa: `setBde` stops
  inserting a rule, `setAudiences` stops re-adding governed spaces (`spaces.service.ts`).
- **Mismatches are information**, shown on both panels, never refused: an entity reaching a space
  its parent does not govern; a parent governing none of its child's audience; a parent that governs
  nothing.
- **D1, "Oui pour le parent"**: a parent BDE writing a child's audience stays inside its own spaces;
  the platform admin may write any audience. Existing wider audiences stay (A2).

### 2.6 Audience bounds per space (A3, closes P3)

`GOVERNED_SPACES_SQL`: the spaces whose governor U holds F in. A rule is inside them when every space
it reaches is; a whole-campus rule is inside only for a governor of every formation of that campus
(the editor writes pair rules for the four-formation BDE). A non-admin reads and writes an entity's
audience only when they hold `MANAGE_ASSO` in its PARENT, inside the parent's governed spaces; before
WP-D2, inside the caller's governed spaces (WP-R1). Presets for a parent: "all of our spaces" / "some
formations among them"; the grid stays the admin's.

### 2.7 Setting the dependencies by hand (B1, A4)

Only the platform admin changes a parent or a space governor; each change writes an append-only
`dependency_journal` line (`subject_kind` entity|space, `subject_id`, `from_id`, `to_id`, `actor`,
`at`) in the same transaction (the shape of `read_grant_journal`, migration 078). The existing
parents are set from a list (G1): Claude proposes an entity to parent-BDE list, the owner validates
it on his private tracking page, and only then is it applied by a reviewed migration (held for his
hand-merge); WP-D2 ships when he says they are applied. The list follows the owner's decisions of
2026-11-03: saint-etienne has two distinct BDEs, the main one (Autre, ICM, ISMIN, PDIS) and an FSSS
BDE (FSSS only), the second renamed so they are told apart (G2); lists attached to the BDS or the
BDA move under the main BDE, the old link kept as a label (G3); MINITEL governs all five Gardanne
spaces (G4); the associations whose audience is the whole of saint-etienne take the main BDE (G6). **Read-only counts for him**
(aggregates; no agent runs them against production):

```sql
-- Entities by type and number of distinct space governors their audience reaches.
SELECT type, n_gov, count(*) FROM (
  SELECT a.id, a.type, count(DISTINCT s."bdeAssociationId") AS n_gov
  FROM associations a
  LEFT JOIN association_audiences r ON r."associationId" = a.id
  LEFT JOIN spaces s ON (r.formation IS NULL OR r.formation = s.formation)
                    AND (r.campus IS NULL OR r.campus = s.campus)
  GROUP BY a.id, a.type) x
GROUP BY type, n_gov ORDER BY 1, 2;

-- The parents that already exist (lists' display-only owning BDE), and how many would pass D2.
SELECT a.type, count(*) AS with_parent,
       count(*) FILTER (WHERE p.type = 'association'
         AND EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = p.id)) AS parent_is_a_bde
FROM associations a JOIN associations p ON p.id = a."parentAssociationId"
GROUP BY a.type;

-- Spaces with no governor.
SELECT count(*) FROM spaces WHERE "bdeAssociationId" IS NULL;

-- Associations and lists without a parent, by type.
SELECT type, count(*) FROM associations
WHERE type IN ('association', 'list') AND "parentAssociationId" IS NULL GROUP BY type;
```

The trigger of 2.2 would refuse an existing list whose display parent is not a BDE: the second count
says how many, and **the migration that adds the trigger must not run while that count is above zero**
(those rows are corrected through the validated parents list of G1; the BDS and BDA links move to the display-only label of G3).

### 2.8 WP-D1 as built (2026-11-03) - built, its three migrations held for the owner

**Built**, in its own pull requests (server and migrations; then the Dependencies panel). ADDITIVE:
nothing reads the governing parent for governance until WP-D2.

- **Migration 129** (held): `associations."displayParentAssociationId"`, the G3 display-only label,
  and `dependency_journal` (`subject_kind` - `entity` for a governing parent, `space` for a governor,
  `label` for a list's G3 label - `subject_id`, `from_id`, `to_id`, `actor`, `source`, `at`; the
  actor is anonymised by the account erasure).
- **Migration 130** (held): the parents list below, applied by SLUG, all or nothing - every slug must
  exist once, each row's type must be the validated one and its current parent the validated "from"
  (or already `bde`, a re-run), `bde` must govern a space; otherwise it RAISES naming the slug and
  writes nothing. On an estate with NONE of the slugs (the dev seed, a scratch database) it writes
  nothing and says so in a NOTICE. Each changed parent is journaled (`source = 'migration-130'`) and
  reported by NOTICE; a re-run writes nothing. It also renames the FSSS BDE (G2) and makes MINITEL
  the governor of the five gardanne spaces (G4) - a gardanne space governed by anybody else stops it.
- **Migration 131** (held): ONE SQL judgement, `canari_dependency_refusal(child, type, parent)`, and
  two triggers (`associations` on insert or an update of the parent or the type; `spaces` on an
  update of the governor). Each refusal is SQLSTATE 23514 with its code in the CONSTRAINT field
  (`DEPENDENCY_INSTITUTION`, `DEPENDENCY_CHILD_IS_A_BDE`, `DEPENDENCY_PARENT_NOT_A_BDE`), read by the
  service through `dependencyRefusalOf`, never from a message. Retyping a parent that has children is
  refused too. Both triggers take one transaction-scoped advisory lock, so a parent write and a
  governor designation cannot each pass on a snapshot missing the other (an integration test parks
  the second on the lock and watches it refused).
- **The 2.7 count, encoded - and stricter.** Migration 131 locks `associations` and `spaces` (SHARE
  ROW EXCLUSIVE, right after BEGIN), runs the SAME judgement as its triggers over every existing row,
  and RAISES with the count when it is above zero - so the triggers are "refused while the count is
  above zero" mechanically, and no write slips between the count and the triggers. The guard is
  stricter than the second 2.7 query: it also counts a dangling parent, an institution or a space
  governor with a parent, and a child with children. **What 130 guarantees** is only that none of
  the 74 rows it names breaks the rule; that the guard then reads zero is true of production by
  MEASUREMENT, not by construction:
- **Production, measured read-only on 2026-11-03** (the coordinator): 0 dangling parents; 0
  institutions or space governors with a parent; 0 children with children; the rows whose parent
  governs nothing are exactly the 26 BDS/BDA lists 130 moves. So after 130, 131's guard reads zero
  on production. Gardanne: only ISMIN is governed (by MINITEL); Autre, FSSS, ICM and PDIS have no
  governor, and no audience rule of an entity that is neither an institution nor a BDE reaches those
  four spaces - so G4 (MINITEL governs all five) changes nobody's rights today.
- **Service** (`spaces/dependency-rules.ts`, `SpacesService`): `PUT associations/spaces/dependencies/:id`
  and `GET associations/spaces/dependencies` (platform admin), every refusal a typed 409; a platform
  admin's `PATCH :id` with a parent goes through the same `setParent`, journaled; `setBde` takes an
  association or an institution (`SPACE_GOVERNOR_TYPE` for a list), refuses a parented one, journals,
  and no longer writes an audience rule; `setAudiences` no longer adds a governor's spaces back (2.5,
  closes P2). An institution governing a space answers for its agenda and its students' personal
  content, and MANAGES nothing (`governorIsAnAssociationSql` in the management predicate, the
  standings and the MANAGE_ASSO door). `setParent` returns before judging anything when neither the
  parent nor the label changes, and judges only what changes - an older client resending the parent
  it read, or a label-only edit, is never refused for a state it did not create. Every writer of the
  axis (the panel, a governor, the profile form, CREATION) maps a trigger refusal to the same typed
  409 through ONE helper, `withDependencyRefusals`. A deleted association releases its children, its
  spaces and the labels naming it, each journaled; deleting one that governs a space or has children
  is the platform admin's alone (A4), anyone else gets the typed 403 `DEPENDENCY_DELETE_ADMIN_ONLY`. Creation (2.5, closes P4): the parent is the creating BDE (picked
  among several, `DEPENDENCY_PARENT_CHOICE_REQUIRED`; held to the creator's own,
  `DEPENDENCY_PARENT_NOT_YOURS`), a named body governing nothing becomes the label (G3, which keeps
  an older client's "for the BDS" list working), and the default audience is the parent's spaces.
- `parentName` (the line above a list) prints the label, else the governing parent, for LISTS only -
  an association gains a parent too and must not start showing "BDE" above every club.
- **The screens** (second pull request). `/admin/spaces` gains the Dependencies panel (each BDE with
  its children, the orphaned, the unattached and the institutions apart, every mismatch shown, a
  parent and a list label changed in place) and lets an institution take the governor star; a
  governor's reach box is no longer locked ([admin](frontend/modules/admin.md#the-catalogue-and-the-create-form-adminspaces-owner-2026-11-02)).
  The create form asks a creator managing several BDEs which one (none asked of a creator with one,
  every BDE offered to the platform admin), and a list may still be shown under a non-BDE. The
  profile form's parent picker (platform admin, lists) offers the BDEs only and sends the parent
  only when it changed. **F9**: a BDE's edit hub lists the entities depending on it, read-only, with
  a link to `/admin/spaces` for the platform admin, and its members editor offers a "Bureau du BDE"
  preset (the admin preset plus `VALIDATE_EVENTS`, `MANAGE_ASSO`, `MODERATE`, `bdePresetFor`). A
  BDE's own officers do not see which SPACES it governs there: that list is platform-admin only
  (`GET associations/spaces`), and WP-D1 opens no new read for it.

#### The parents list, validated by the owner on 2026-11-03, as is

Proposed by Claude, resolved against production by exact name (each name matched exactly one row),
validated by the owner on his tracking page as is (G1); he may correct a row later in production,
from the Dependencies panel. 74 rows: 44 lists, 30 associations, every governing parent the main BDE
(`bde`, which governs four saint-etienne spaces). 26 lists now under the BDS (14) or the BDA (12)
keep that link as the G3 label only. Migration 130 carries the same rows; its integration spec reads
them from the file. The second BDE's new name, **"BDE FSSS - Bureau des Élèves"** (G2, applied by
130), is the owner's exact choice of 2026-11-03, given to the lead as the answer to a direct
question.

| Name | Slug | Type | Current parent | New governing parent | G3 label |
| --- | --- | --- | --- | --- | --- |
| Califor'mines State University | califormines-state-university | list | bds | bde | bds |
| Co'Mines'Auté de l'Anneau | cominessariat | list | bds | bde | bds |
| Exc'Art'libur | excartlibur | list | bda | bde | bda |
| Faucon Mines'llenium | faucon-minesllenium | list | bds | bde | bds |
| Gaulw'arts | gaulwarts | list | bda | bde | bda |
| Hogw'Arts | hogwarts | list | bda | bde | bda |
| Les Tortues Mines'Ja | les-tortues-minesja | list | bds | bde | bds |
| Loup G'ART'ou | martiacartey | list | bda | bde | bda |
| Mines et une nuit | les-trois-minesquetaires | list | bds | bde | bds |
| Mines in Black | minesinblack | list | bds | bde | bds |
| Mines'Ger Games | minesger-games | list | bds | bde | bds |
| Mines'Tendo | mines-itaires | list | bds | bde | bds |
| Mines'Tervilles | minestervilles | list | bds | bde | bds |
| Mines'Victus | minesvictus | list | bds | bde | bds |
| Miy'Art'zaki | cartglass | list | bda | bde | bda |
| Moulins'Art | moulinsart | list | bda | bde | bda |
| Ph'art'aon | fort-boyart | list | bda | bde | bda |
| Pix'art | pixart | list | bda | bde | bda |
| RagMines'rök | ragminesrk-liste | list | bds | bde | bds |
| Ragn'art'ök | mammamiart | list | bda | bde | bda |
| Shao'Mines | shaomines | list | bds | bde | bds |
| T'Art'garyen | magicartpe | list | bda | bde | bda |
| Wond'Art'Land | wondartland | list | bda | bde | bda |
| Yakuz'Art | jurassic-partk | list | bda | bde | bda |
| Zooto'Mines | rockminesbalboa | list | bds | bde | bds |
| É'mines'sion | brainstormines | list | bds | bde | bds |
| AME | ame | association | - | bde | - |
| BDA - Bureau des Arts | bda | association | - | bde | - |
| BDI - Bureau des Internationaux | bdi | association | - | bde | - |
| BDS - Bureau des Sports | bds | association | - | bde | - |
| BT - Bureau Technique | bt-bureau-technique | association | - | bde | - |
| CoMines Out | comines-out | association | - | bde | - |
| DopaMines | dopamines | association | - | bde | - |
| EMSE Finance | emse-finance | association | - | bde | - |
| Fablab | fablab | association | - | bde | - |
| Forum Perspectives | forum | association | - | bde | - |
| Gala Illumines | gala-illumines | association | - | bde | - |
| GourMines | gourmines | association | - | bde | - |
| Humani'Mines | humani-mines | association | - | bde | - |
| L'Associflard | associflard | association | - | bde | - |
| Le Cercle | cercle | association | - | bde | - |
| Les Rootz | les-rootz | association | - | bde | - |
| MINO | mino | association | - | bde | - |
| MTM | mtm | association | - | bde | - |
| MiTV | mitv | association | - | bde | - |
| Mines Space | mines-space | association | - | bde | - |
| Mines'ergies | mines-ergies | association | - | bde | - |
| Mines'ramax | mines-ramax | association | - | bde | - |
| Mines, Études et Projets | mep | association | - | bde | - |
| Oenolo'mines | oenolo-mines | association | - | bde | - |
| Pac-Mines | pac-mines | association | - | bde | - |
| Pist'on Fire | pist-on-fire | association | - | bde | - |
| Respire | respire | association | - | bde | - |
| STO'Mines | sto-mines | association | - | bde | - |
| WANA | wana | association | - | bde | - |
| WoMines | womines | association | - | bde | - |
| Back m'in'es time | apocamines | list | bde | bde | - |
| CriMines'L | criminesl | list | bde | bde | - |
| FAT Liste | fat-liste | list | - | bde | - |
| Ho'Mines'Wood | homineswood | list | bde | bde | - |
| Illu'Mines'ati | illuminesati | list | bde | bde | - |
| Mines'Ception | minesception | list | bde | bde | - |
| Mines'Exploré | minesexplor | list | bde | bde | - |
| Mines'West | mineswest | list | bde | bde | - |
| Mines'neyland | minesvswild | list | bde | bde | - |
| Mines'sion Impossible | minession-impossible | list | bde | bde | - |
| Mines'tagnard | minestagnard | list | bde | bde | - |
| Mines'temporel | minestemporel | list | bde | bde | - |
| Mines'thologie | aminesrica | list | bde | bde | - |
| Mines'ti Verse | minesti-verse | list | bde | bde | - |
| Mines'versal Studios | minesversal-studios | list | bde | bde | - |
| Psychédé'Mines | minesxico | list | bde | bde | - |
| T'Art'iflette | tartiflette | list | - | bde | - |
| The Greatest Show'Mines | minesterpol | list | bde | bde | - |

Not rows of the list, and applied by the same migration: the second saint-etienne BDE (slug
`bde-bureau-des-eleves`, FSSS only) is renamed "BDE FSSS - Bureau des Élèves" (G2; the main `bde`
keeps its name), and MINITEL (`minitel`, governing one gardanne space on 2026-11-03) governs all five
(G4).

## 3. Per-item audience, for institutions only (C1)

**An institution's post or event may NARROW the institution's audience, never widen it.**
Associations and lists always publish to their entity's audience (the DTO refuses an item audience,
the composer does not offer it).

- `post_audiences(post_id, formation | NULL, campus | NULL)` and
  `association_calendar_event_audiences(event_id, ...)`. **No row = the whole audience.**
- AND-ed with the entity's reach at READ time: never wider than the entity, shrinking with it. The
  write refuses rules outside the entity's audience (`AUDIENCE_OUTSIDE_ENTITY`).
- Members of the institution see every item (D21). A read grant must meet the ITEM's rules too. A
  republication reaches the republisher's own readers (G4). `announceRecipientsSql` reads the same
  predicate. Edits re-open the event slices whose spaces changed (D4); readers newly reached by an
  edit are not re-notified. The composer's **"Visible par"** defaults to "Toute l'audience de X".
- Cost: one `NOT EXISTS (row) OR EXISTS (row reaching a reader space)` per candidate, indexed; the
  shape WP-C measured at +10 %
  ([WP-C](profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)); `EXPLAIN` owed
  with WP-I.

## 4. Events validated per space slice (B6, D3, D4)

### 4.1 The model

- **An event's spaces** are the spaces of its ceiling - the union of the organiser's audience and each
  ACCEPTED co-organiser's (section 5) - narrowed by its own rows if the organiser is an institution.
- **A slice is the set of the event's spaces under one governor** (2.3); spaces with no governor form
  the platform admin's slice. **The slices are DERIVED at read time** from the event's spaces and
  `spaces."bdeAssociationId"`, never stored.
- **Only the decisions are stored**: `association_calendar_event_decisions(event_id, governor_id |
  NULL, verdict validated|rejected, decided_by, decided_at, reason)`, unique per `(event_id,
  governor)`. **A slice with no decision row is pending.** So a partner accepting, an audience edit
  or a space changing governor produces a pending slice by construction, with no copy to keep in
  sync; and a decision whose governor no longer has a space in the event is inert.
- **The event appears in a space once that space's governor has validated it.** Reader rule: a member
  of the organiser or an accepted co-organiser (D21), OR one of their spaces is among the event's
  spaces AND its governor's decision is `validated`. Same for the anonymous selection, the `.ics`, a
  read grant's spaces.
- **Nothing is auto-validated** (user, 2026-09-14).
- The governor's queue: events with a space it governs and no decision of it. Under the correlated
  case (an association under BDE X addressing X's spaces) there is ONE slice, X's: today's single
  validation.

### 4.2 Changes after a decision (D4, "selon le changement")

| Change | Effect |
| --- | --- |
| a DATE moves | every decision row is deleted: every slice back to pending (today's rule, `associations.service.ts:2563-2627`, per slice) |
| the event's spaces change (an institution's narrowing edited, a partner joins or leaves, a partner's or the organiser's audience edited) | the decisions of governors whose set of spaces in the event CHANGED are deleted; a governor newly reached has none, so is pending; the others stand |
| a space changes governor | the new governor has no decision: pending in that space, structurally |
| title, description, poster, form | nothing |

Each deletion of a decision is logged with its cause. **Whenever a slice returns to pending (F7),
the organiser and every accepted partner are notified with the reason** (the date moved, the
audience changed, a partner joined or left, the space changed governor), **and so are the validators
concerned** - the governors left pending (`notifyEventValidatorsOfProposal`,
`associations.service.ts:2409`, per slice). The reason is a typed cause carried from the write that
deleted the decision, never a sentence parsed afterwards. A read-time-only change (a governor
reassigned) is announced by the admin action that made it, with the same two notifications.

### 4.3 The rest

| Topic | Rule |
| --- | --- |
| Partly validated | the organiser's and partners' people see one line per slice ("Validé : X - En attente : Y - Refusé : Z, motif"); a reader sees the event only where validated; by link, 404 outside any validated slice and membership |
| Summary `status` | kept, recomputed in the same transaction: `validated` if any decision is, `rejected` if every slice is rejected, `pending` otherwise; no reader path reads it |
| Declining, deleting | a governor DECLINES its slice; it never deletes the event (B3) |
| Breaks (`kind = 'break'`) | declared by a governor's validator on its own spaces: one slice |
| Existing events (owner's yes) | one decision row per governor the current ceiling reaches, copying the current status when it is `validated` or `rejected` (a pending event gets none): every reader sees exactly what they see today |
| Cost | the agenda predicate gains a join on the decisions, keyed by `event_id`; `EXPLAIN` owed with WP-E |

## 5. Partnerships - co-organised events (D5)

### 5.1 How co-organisation works today, from the code

| Step | What the code does | Where |
| --- | --- | --- |
| Invite | the organiser names co-organisers on the event form (`coOwnerIds`), as a holder of `PROPOSE_EVENT` in the organiser; each name becomes a `coorganise` proposal | `CoorganisationService.sync`, `coorganisation/coorganisation.service.ts:154-210`; sender flag line 65 |
| Who may be invited | ANY association row - association, list or institution: `resolveSender` checks only that the target exists and is not the organiser | 257-279 |
| Cap | 3 co-organisers (4 entities), accepted + pending counted, refused not | `associations/co-organiser-cap.ts:13`; measured 2026-10-10: 9 co-organised events, the most on one is 1 accepted + 2 pending |
| Accept / refuse | the invited entity's `POST_AS_ASSO` holders; acceptance inserts the `association_calendar_event_co_owners` row; a refusal is recorded and never re-asked; no expiry | acceptor flag line 66; `apply` 281-300 |
| Audience | organiser's audience union each accepted co-organiser's; pending or refused add nothing | `eventVisibleToUserSql`, `reader-spaces.ts:637-641` |
| Validation | the organiser's governing BDEs only; a partner's BDE has no say; **acceptance does not touch the status** (P13) | `mayValidateEvent`, `associations.service.ts:1846-1860` |
| Edit | an accepted co-organiser's `PROPOSE_EVENT` holders edit everything, dates included (a date move demotes the event) | `assertMayWriteEvent` 1870-1900 -> `findCalendarEventForAssociation` 1382-1401 |
| Co-organiser list | only the organiser side adds or removes; a co-organiser may only remove ITSELF (leave) | `sync`, line 190 |
| Delete | **an accepted co-organiser may delete the whole event** (P14) - D39 as built lists "edit, poster, delete" | `deleteCalendarEvent`, 2770-2777 |
| Leaving | a partner leaves or is removed: its row and its audience go; the event stays with its organiser | `end`, 214-250 |
| Deleted event | an `AFTER DELETE` trigger removes its co-owner rows and proposals | migration 074 |

### 5.2 How it fits the per-slice validation

- **Each partner accepts** (unchanged): no right, no reach before acceptance.
- **The audience is the union**, and **the slices are cut per space governor**, whoever brought the
  space in: a Gardanne association co-organising with a Saint-Etienne one puts the event in front of
  each campus's governor for its own spaces. Closes P13: an acceptance adds spaces, the new governors
  have no decision, so the event is pending there.
- **A partner leaves**: its spaces go unless another member of the union still reaches them;
  decisions of governors left with no space become inert; nothing else re-opens.
- **A partner's audience changes**: the event's spaces follow at read time; governors whose set
  changed are re-asked (4.2).
- **Edits (E2)**: a partner edits the text and the poster and may withdraw; only the organiser
  changes the date, the event's audience or the partner list, and only the organiser deletes (closes
  P14). In code: `assertMayWriteEvent` returns which side the caller writes from (the organiser, or
  a co-organiser through `findCalendarEventForAssociation`), and `updateCalendarEvent` /
  `deleteCalendarEvent` refuse a co-organiser-side date, audience, `coOwnerIds` or delete with one
  typed 403 (`CALENDAR_PARTNER_ORGANISER_ONLY`). D4 applies per slice whoever edits.
- **Partners of every type stay allowed** (an institution co-organising with an association is the
  School-and-a-club case). A list co-organising is allowed today and nothing argues against it.

### 5.3 Forbid partnerships? No - kept (E1).

**Decided: keep them.** They are the ONLY way an event crosses from one governor's spaces to
another's - republication carries posts, not events (D38) - so forbidding them would leave an
inter-campus event no route at all, against G4's intent. What makes them risky today is P13 and P14,
and both are fixed by the slices and by narrowing a partner's rights, not by forbidding the feature.
The coordinator's prior (keep) is confirmed by the code.

## 6. Associations, lists and institutions compared (D6)

Built from the code (server and `frontend/src/lib/associations/`) and the wiki. **Differs** marks a
cell that changes with the reform; **Disagree** marks code and wiki (or code comment) saying
different things today.

| # | Topic | Association - today | List - today | Institution - today | After the reform | Flag |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Who creates it | platform admin, or `MANAGE_ASSO` in any BDE (`associations.controller.ts:700-722`), on a governed campus | same | platform admin only (708-711) | same; the creating BDE becomes the parent | Differs (parent) |
| 2 | Parent | none for governance | `parentAssociationId`, display only ("owning BDE", entity 187-189) | none | association, list: optional, a BDE (2.2); a BDE: never; institution: never | Differs |
| 3 | Can govern a space | yes (`setBde`, `spaces.service.ts:167`) | no | no | association (BDE) or institution (2.3) | Differs |
| 4 | Audience | default creator's campus; no `everyone` | same | no default; may be `everyone` | default = parent's spaces; institution unchanged | Differs |
| 5 | Item audience | none (D38) | none | none | institution only may narrow (C1) | Differs |
| 6 | Who governs (validate, manage, moderate) | any BDE its audience reaches (`bde.ts:35-41`) | same | same - a reaching BDE manages its members and may delete it (P8) | parent BDE, else platform admin; events per space governor | Differs |
| 7 | Members managed by | own `MANAGE_MEMBERS`, governing BDEs, admin (`GlobalAdminOrAssociationRoleGuard` -> `mayAct`) | same | same in CODE; D20 and WP6e say "added nominatively by an admin" | association, list: own officers, parent BDE, admin; institution: **admin only** (G6) | Differs; **Disagree** (institution) |
| 8 | Deleted by | admin, or `MANAGE_ASSO` in a governing BDE (controller 743-757; client `editSections.ts`, `delete: isGlobalAdmin \|\| isSuperAdmin`); the flag's own comment says it "does not include deleting an association" (`association-member.entity.ts:20-24`) | same | same (P8) | association, list: platform admin or the PARENT BDE's `MANAGE_ASSO` holders (E3, as today but scoped to the parent); institution: platform admin only (E5, #2949); the flag's comment corrected (WP-R5) | Differs (scope); **Disagree** (comment vs code, the comment is wrong) |
| 9 | Profile edited by | `MANAGE_MEMBERS` holders, governing BDEs, admin (`PATCH :id`, 770-771); quota admin only; cotisation fields need `MANAGE_PRODUCTS` | same | same | a NEW "edit profile" permission, separate from `MANAGE_MEMBERS`, granted by migration to every current `MANAGE_MEMBERS` holder (E7, its own PR); super tier = parent BDE; institution: own officers + admin, never a BDE (E5) | Differs |
| 10 | Posting as | `POST_AS_ASSO`; never through the super tier (`SUPER_ADMIN_EXCLUDED_FLAGS`) | same (since 2026-10-31) | same | unchanged | - |
| 11 | Republishes others' posts | yes | **yes since 2026-10-31** (`posts/republication-sql.ts:7-11`); WP6e in profiles-and-access still says "a list still does not" | yes | every type, without exception (E6) | **Disagree** today (wiki stale) |
| 12 | Asks a person to republish their post (D38b) | yes | no | no (`republication-sql.ts:19`) | **every type (E6, its own PR)**: an institution may carry a student's personal post with the student's consent, lifting the D34-D36 point | Differs |
| 13 | Its posts member-repostable (WP-F6) | yes, if it has a rule | **never** (`reader-spaces.ts:318-336`) | yes, if it has a rule | **list posts become member-repostable (E6, its own PR)** | Differs |
| 14 | Events | `PROPOSE_EVENT`; validated by a governing BDE | same | same; with no rule, no validator (P9) | per space governor (section 4) | Differs |
| 15 | Co-organises | yes, any type (`resolveSender`) | yes | yes | unchanged; a partner edits text and poster and may withdraw, the organiser alone changes date, audience, partners, and deletes (E2) | Differs (rights) |
| 16 | Lydia, payout, shop, vault | yes; `MANAGE_PAYOUT_ACCOUNT` never through the super tier | **sells nothing since 2026-10-31** (`selling-kinds.ts:13`, 10.1); vault yes (`MANAGE_DOCUMENTS`, no kind check) | **sells nothing** (`selling-kinds.ts:13`); vault yes | association: unchanged; **list: collects through delegation - shop (cotisation included) and paid forms, NO own Lydia account (E4 corrected, F2); vault kept (F1)**; **institution: sells nothing, as today (F3); vault kept**; the list entity comment (`association.entity.ts:177-180`) corrected to say exactly that | Differs (list) |
| 17 | Payment delegation | `paymentParentAssociationId`; the child requests, the receiver accepts (10.3); a governing BDE and the platform admin may accept on the receiver's behalf, unrecorded | refused (`assertKindMaySell`, 10.1) | refused | association: unchanged; **list: the ONLY way to collect (F2)**; institution: none (F3); **in every case accepted only by the receiver's own `MANAGE_PRODUCTS` managers or the platform admin, never a governing BDE, each acceptance recorded (F4)**; the receiver is any association that accepts, not necessarily the list's BDE (F6); a revocation or a lost Lydia account pauses the list's paid items and notifies its managers until a new delegation is accepted (F5); kept apart from the governance parent (2.2) | Differs |
| 18 | Bookings, forms, cotisation, partnerships | yes, by their flags | bookings, free forms, partnerships yes; paid forms and cotisation refused (`selling-kinds.ts`) | bookings, free forms, partnerships yes; paid forms and cotisation refused | association, institution: unchanged (an institution stays free-only, F3); list: paid forms and cotisation through delegation (F2) | Differs (list) |
| 19 | Moderation of its content | any BDE holding `MODERATE` (global) | same | same | parent BDE, else platform admin (2.4) | Differs |
| 20 | Directory | `/associations` | `/lists` (campaign: `promo`, `name2`, `logoMediaId2`) | `/institutions` | unchanged | - |

## 7. Other simplifications considered

- **"formation x campus"** stays the unit for reading and for governing spaces (A1, A3); `openedAt`
  and the "OPEN spaces" wording go (WP-R5).
- **Audience shape**: keep the rule rows; the item audience reuses them.
- **The review cohort** stays outside the model: it seals messaging, search, calls and the people
  directory, which spaces do not bound (52 call sites in 13 files)
  ([review cohort](profiles-and-access.md#the-review-cohort---store-reviewers-in-a-world-of-their-own-2026-10-31)).
- **Staff with no cursus**: `campusWideReaderCampus` is a decision (D34-D36), left as is.

## 8. Target and path

**Target.** Audience panel: who sees; a parent bounded to its spaces, the admin free. Dependencies
panel: associations and lists under at most one BDE, BDEs and institutions under nothing, two
levels enforced by triggers; spaces under at most one governor, a BDE or an institution; all set by
the platform admin with a journal. The parent manages and moderates its children; space governors
validate event slices and moderate their students' personal content; the platform admin governs
the rest. Institutions may narrow an item. Partnerships stay, validated per slice; a partner edits
text and poster and may withdraw, the organiser alone changes the rest and deletes. A list holds no
Lydia account of its own and collects through a delegation its receiver accepted; an institution
sells nothing. Moderators hide and delete, never edit.

**Build (F8).** Once this proposal merges, every work package below is built, each in its own pull
request, in the order of the tables. A WP whose "Data change" column names a migration is opened as
a draft and held for the owner's hand-merge
([held](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)); the WPs with no data change
merge on their own.

**Quick wins - each ships BEFORE the reform, alone, on today's model:**

| WP | What | Why it cannot wait | Data change |
| --- | --- | --- | --- |
| **WP-Q1** | Partner rights (E2, closes P14): `assertMayWriteEvent` returns the side the caller writes from; a co-organiser-side date, audience, `coOwnerIds` change or delete is refused with one typed 403 (`CALENDAR_PARTNER_ORGANISER_ONLY`); the event form hides those controls for a partner; `coorganisation.integration.spec.ts` gains the four refusals and the allowed text, poster and withdrawal | a partner can delete another campus's event today | none |
| **WP-Q2** | P13 interim: accepting a co-organisation on a VALIDATED event returns it to `pending` (status, `validatedAt`, `validatedBy` cleared) in the acceptance's own transaction (`CoorganisationService.apply`, `coorganisation.service.ts:281-300`), logged; the event's validators are notified as for a proposal, and the organiser and the partners are notified with the reason (F7) - the date-move rule applied to the new reach. Superseded by WP-E, where an acceptance re-opens only the new governors' slices | today an acceptance widens a validated event with no validation | none |
| **WP-L** | A list collects through delegation and holds no Lydia account of its own (E4 corrected, F2, F4-F6) - **built in its own pull request, `feat/lists-collect-through-delegation`**, which supersedes 8.1 as first written; 8.1 now records what it must satisfy | the owner's decision | none on list data: every list counter is 0 in production (8.1); recording who accepted (F4) may add a column - held if so |

**The reform:**

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | The institution half is **#2949** (E5, at the predicate level). What remains: the moderator's EDIT removed (G3, P7) | one capability | none |
| **WP-R1** | Audience bounds per SPACE. **Built in #2949** with `BDE_SPACE_STANDINGS_SQL` and `ruleInsideGovernedSpaces` ("Lire tout, modifier dans ses espaces", owner 2026-11-03); there is no `GOVERNED_SPACES_SQL`. **The residual, in full:** governance is still read from REACH (`bdeFlagOverReachSql`), so a whole-campus rule on a campus two BDEs share (saint-etienne) makes BOTH BDEs uncapped super-admins of that association TODAY - only another BDE and an institution are excluded. And a whole-campus rule a star wrote while it governed every opened space of its campus makes ANOTHER BDE super-admin of that entity as soon as the platform admin opens a new space there and gives it that BDE: the bound is judged at the write, the reach at every request. WP-D2's governance by parent is what closes both - **closed by WP-D2 (2026-11-07, 2.4)** | server checks; closes P3 | none |
| **WP-D1** - **built (2.8)**; migrations 129-131 held for the owner | `parentAssociationId` generalised to associations; a separate display-only label column for the BDS or BDA link (G3); the parents list validated by the owner (G1); the two-level triggers (2.2); a space governor may be an institution; `dependency_journal`; the Dependencies panel beside the Audience panel; default parent and parent-derived default audience; `setBde`/`setAudiences` decoupled | additive; nothing reads the parent for governance yet; closes P2, P4, P10 | **schema + triggers: owner's yes; refused while the 2.7 count is above zero** |
| **WP-D1b** | An admin interface to manage the existing campuses and each campus's formations (G5): list, create, rename and retire a campus or a formation, including a formation attached to two campuses. A space is a formation x campus, so what a cross-campus formation means for its spaces (one space per campus, a BDE per space as today) MUST be designed before it is built; reversible choices are taken and written down here, an irreversible one goes to the owner. Built inside WP-D1 as its own step, AFTER the parents list is applied | WP-D1's parents list comes first; the interface edits `spaces` and the formation and campus lists only | needs the spaces model: owner's yes if a schema change |
| **WP-D2** - **built (2.4, 2026-11-07)** | `holdsBdeFlagOverSql` on the parent (2.4); no parent = admin; parent-bounded audience writes (G8: a BDE reads every audience on its campus and writes only inside its governed spaces; a wider rule is the admin's); deletion of an association or list by its parent BDE (E3) | ships when the owner says the parents are set; closes P1, P5, P9 | none |
| **WP-R4** - **built with WP-D2 (2.4, 2026-11-07)**; the moderator's edit was already removed (G3) | `MODERATE` scoped (2.4); no BDE moderates an institution's content, only the platform admin (G9) | needs WP-D2; closes P6 | none |
| **WP-I** | Institution item audience (section 3) | additive; closes P12 | **two tables: owner's yes** |
| **WP-E** | Events per slice (section 4) and partnerships under it (section 5): the decisions table, the space-governor predicate, both agendas and the `.ics`, per-slice notifications (the validators concerned, and the organiser and partners with the reason, F7), D4's re-opening (replacing WP-Q2's whole-event demotion), `EXPLAIN` | needs WP-D1 (space governors) and, for institutions, WP-I; closes P11, P13 | **one table + the event migration of 4.3: owner's yes** |
| **WP-R5** | Parent presets; `openedAt` and "OPEN spaces" removed; the stale WP6e line on lists; **the `MANAGE_ASSO` comment (`association-member.entity.ts:20-24`) corrected to say it includes deleting an association or list the BDE governs (E3)** | cosmetics | dropping `openedAt`: owner's yes |

Each WP changes its tests (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`,
`associations.service.never-auto-validates.spec.ts`,
`associations.service.revalidate-on-date-change.spec.ts`, `coorganisation.integration.spec.ts`, the
agenda and moderation specs) and updates [profiles-and-access](profiles-and-access.md) (D20, D22,
D23, D33, D39 amended) and [calendar](frontend/modules/calendar.md).

### 8.1 WP-L - a list collects through delegation, with no Lydia account of its own (E4 corrected, F2)

**Superseded as a build plan** by the pull request `feat/lists-collect-through-delegation` (F2),
which builds it from the settings audit's gaps G1-G8 (10.2). What follows is kept as the contract
that pull request must satisfy; where this section and 10.2 disagree, 10.2 holds (it was read from
`main`, this section was not).

**Where `main` stands**: a list SELLS NOTHING since 2026-10-31 (`selling-kinds.ts:13`,
`assertKindMaySell`, 10.1), and its delegation is unreachable, in the UI and through the API (10,
"Read this first"). So WP-L WIDENS an existing gate. **What a list gets**: the shop (the cotisation
product included) and paid forms, collected through payment delegation to an accepting association's
account (`paymentParentAssociationId`, `association.entity.ts:113-129`). **What it never gets**: its
OWN Lydia account. **What it keeps, unchanged**: the document vault (F1). An institution sells
nothing, as today (F3).

**The delegation rules (owner, 2026-11-02):**
- **The receiver is any association that accepts** - not necessarily the list's BDE (F6), which may
  hold no Lydia account.
- **Only the receiver's own managers (`MANAGE_PRODUCTS` on the receiving entity) and the platform
  admin may accept; a governing BDE never accepts on its behalf** (F4). Today the BDE super tier can
  (10.3), because `MANAGE_PRODUCTS` is not in `SUPER_ADMIN_EXCLUDED_FLAGS`: the approve and reject
  routes must ask the receiver's OWN membership or the platform admin, not `mayAct`'s super tier.
- **Every acceptance is recorded** (F4): who accepted, from which tier (own manager or platform
  admin), when, for which child - durable, readable by the platform admin, never only a log line.
- **On a revocation, a cancellation, or the receiver losing its Lydia account (a readiness revert
  OR an admin unlink), the list's paid items are paused automatically in the same transaction, and
  the list's managers are notified; everything resumes when a new delegation is accepted** (F5, gap
  G7). "Paused" is the existing withhold state the readiness revert already uses
  (`setLydiaReadiness`, `approvedDelegateIds`), so a resume is its symmetric release - never a
  product deleted or edited.

1. **`MANAGE_PAYOUT_ACCOUNT` excluded for lists, in one place.** One kind map - the one
   `selling-kinds.ts` already holds (`writablePermissions`, `SELLING_ONLY_FLAGS`, gap G2), not a
   second map beside `SUPER_ADMIN_EXCLUDED_FLAGS` - strips `MANAGE_PAYOUT_ACCOUNT` from a list and
   keeps `MANAGE_PRODUCTS`; `canManagePayoutAccount` reads it too (gap G5), so no tier - the platform
   admin included - creates or links a Lydia Business for a list.
2. **Lydia enrolment refused for a list**, with one typed code (`LIST_NO_OWN_LYDIA_ACCOUNT`), on the
   enrolment, readiness and cashier paths that the flag does not already cover - checked by the same
   map through one helper (`assertTypeMayHold(type, flag)`), never a second list of types.
3. **A paid feature on a list with no APPROVED delegate refuses clearly, at its entry**: creating a
   priced product, enabling the cotisation, publishing a paid form, and a buyer's checkout are refused
   with one typed code (`LIST_DELEGATE_REQUIRED`) whose client sentence says "choose the association
   whose Lydia account receives your payments" and links to the delegation section - instead of a
   failure deep in the payment provider call. A free product or a free form is unaffected.
4. **The delegation setting is made reachable for a list - it is NOT today** (corrected: an earlier
   draft of this point said it was). On `main`, `assertKindMaySell` refuses a list's delegation
   request and approval (`associations.service.ts:4349`, `:4424`), `writablePermissions` strips
   `MANAGE_PRODUCTS` from every list member row, and `EDIT_SECTIONS_BY_KIND.list`
   (`editSections.ts:149-164`) draws no `delegation` section (10, gaps G1-G3). WP-L opens the
   REQUEST to a list, lets a list officer hold `MANAGE_PRODUCTS`, draws `delegation`, `achats`,
   `cotisations` and a boutique-only `payments` section for a list, and tests that a list's officer
   reaches each; `editRights.payoutAccount` is false for a list, so Paiements shows the delegation
   state, never an enrolment button.

The entity comment (`association.entity.ts:177-180`, "minus the banking/shop/vault features") is
corrected to say what is true after WP-L.

**Production, read-only, counted by the coordinator on 2026-11-02: every list counter is 0** - no
list holds a Lydia account, a delegation, a product, a checkout, a purchase record or a document. So
WP-L touches no existing data, and the question of what to do with it does not arise. The counting
query, kept for a re-run before shipping:

```sql
SELECT
  (SELECT count(*) FROM associations
     WHERE type = 'list' AND "lydiaAccountId" IS NOT NULL)                         AS lists_with_lydia,
  (SELECT count(*) FROM associations
     WHERE type = 'list' AND "paymentParentAssociationId" IS NOT NULL)             AS lists_with_delegation,
  (SELECT count(*) FROM association_products p
     JOIN associations a ON a.id = p."associationId" WHERE a.type = 'list')        AS list_products,
  (SELECT count(*) FROM product_checkouts c
     JOIN associations a ON a.id = c."associationId" WHERE a.type = 'list')        AS list_checkouts,
  (SELECT count(*) FROM purchase_records r
     JOIN associations a ON a.id = r."associationId" WHERE a.type = 'list')        AS list_purchase_records,
  (SELECT count(*) FROM association_documents d
     JOIN associations a ON a.id = d."associationId" WHERE a.type = 'list')        AS list_documents;
```

If a re-run ever finds a list with its own Lydia account, WP-L does not disable it on its own: the
owner decides first, and nothing is deleted automatically.

## 9. Questions for the owner

**None open.** Decided, so no longer asked: partnerships kept (E1), the partner's rights (E2), a BDE
may delete its dependent associations and lists (E3), lists collect through delegation with no own
Lydia account (E4 corrected, F2), republication for every type (E6), a separate "edit profile"
permission (E7), lists keep the vault (F1), institutions sell nothing (F3), who accepts a delegation
(F4), what a revocation does (F5), who may receive (F6), who is told when an event returns to
pending (F7), and that every WP is built (F8). Existing list data: none in production, so no
question. The four questions of 10.6 are answered by F3-F6.

## 10. Settings audit - every edit section, per entity type (2026-11-02)

Read-only, from `origin/main` at `aa77c2ee1`. Paths are relative to `frontend/src/` (client) and
`apps/social-service/src/` (server) unless they name another app. Two open drafts change this
ground and are named where they do: **#2949** (grant ceiling; an institution's roster is the platform
admin's) and **#2953** (scoped `MODERATE`; an institution is deleted by the platform admin only).
Owner answers used here: lists keep every paid feature and the vault, hold no Lydia account of their
own, and are paid through a delegate that ACCEPTS; the profile right is decided (E7) and granted by
migration; republication is open to every type (E6).

**Read this first - section 8.1 point 4, as first written, did not hold on `main`** (corrected since). Since 2026-10-31 a list SELLS
NOTHING, on both sides: `associations/selling-kinds.ts:13` allows `association` only, and
`assertKindMaySell` refuses a list's delegation request (`associations.service.ts:4349`), approval
(`:4424`), cotisation enable (`:708`) and provisioning (`products.service.ts:2078`), product create and
update (`products.service.ts:1272`, `:1502`) and a form price (`forms/forms.service.ts:262`).
`writablePermissions` (`selling-kinds.ts:52`) strips `MANAGE_PRODUCTS` from every member row written
on a list, so no list officer can hold the right the delegation routes ask. On the client,
`EDIT_SECTIONS_BY_KIND.list` (`lib/associations/editSections.ts:149-164`) has no `payments`,
`achats`, `cotisations` or `delegation`. **A list cannot set its delegation today, neither in the UI
nor through the API** - even the platform admin calling the route is refused by `assertKindMaySell`.
WP-L is therefore the WIDENING of a gate that already exists, not a narrowing (10.2).

### 10.1 The sections, their gates and the routes behind them

Client gate = `editRights` + `mayOpenEditSection` (`lib/associations/editSections.ts:70-123`); the
roster of keys per kind = `EDIT_SECTIONS_BY_KIND` (`:149-164`). A = association (a BDE included),
L = list, I = institution. Server routes are in `associations/associations.controller.ts` unless said.

| Section | Kinds | Client gate | Server route and guard | Agree? |
| --- | --- | --- | --- | --- |
| `profile` | A L I | section always drawn; editing = `MANAGE_MEMBERS` (`routes/associations/[slug]/edit/[[section]]/+page.svelte:354`, `routes/lists/[slug]/edit/[[section]]/+page.svelte:238`) | `PATCH :id` at `MANAGE_MEMBERS` (`:769-811`); cotisation fields add `MANAGE_PRODUCTS` (`:788-801`); quota dropped silently for a non-admin (`:780-783`); `POST`/`DELETE :id/logo` at `MANAGE_MEMBERS` (`:822-862`) | yes - but the right is the wrong one (E7, 10.4), and the list form writes `parentAssociationId` (F1) |
| `members` | A L I | `MANAGE_MEMBERS` | `POST/PATCH/DELETE :id/members*` and reorder at `MANAGE_MEMBERS` (`:476`, `:864-910`) | yes on `main`; **institution: G6 not enforced on `main`** - #2949 makes add/update/remove platform-admin only (`INSTITUTION_MEMBERS_ADMIN_ONLY`) and draws the section for the admin only |
| `payments` | A | `MANAGE_PAYOUT_ACCOUNT` or `MANAGE_PRODUCTS` | Lydia card: core-service `POST payments/onboarding` -> `GET :id/manage-permission` (`:536-547`, `canManagePayoutAccount`); `GET :id/payout-account` (`:556-570`); disconnect and hand validation **platform admin only** (core-service `payment/payment.controller.ts:772-775`, `:803-805`, #2946). Boutique card: `:id/products*` at `MANAGE_PRODUCTS` (`:1381-1540`) | yes |
| `documents` | A L I | `MANAGE_DOCUMENTS` | `:id/vault-key`, `:id/documents*`, `:id/notes` at `MANAGE_DOCUMENTS` (`:1102-1186`); no kind check | yes; the list KEEPS it (owner, 2026-11-02) - section 9 question 1 is answered |
| `achats` | A | `MANAGE_PRODUCTS` | purchases, export, close at `MANAGE_PRODUCTS` (`:1389-1472`); refunds and statement at `MANAGE_PAYOUT_ACCOUNT` (`associations/refunds/refunds.controller.ts:29-95`, `assertPayoutManager`) | **partly** - the tab learns the refund right by a 403 (`EditAchatsTab.svelte:125-132`) although `rights.payoutAccount` is known (F6) |
| `cotisations` | A | `MANAGE_MEMBERS` or `MANAGE_PRODUCTS` | roster, tags, tiers at `MANAGE_MEMBERS` (`:1198-1330`); config through `PATCH :id` = `MANAGE_MEMBERS` (route) AND `MANAGE_PRODUCTS` (handler); tier products at `MANAGE_PRODUCTS` | **no** - a `MANAGE_PRODUCTS`-only holder is offered the config editor (`EditCotisationsTab.svelte:738`) and refused by the route guard (F5) |
| `delegation` | A | `MANAGE_PRODUCTS` | `:id/payment-delegation*` at `MANAGE_PRODUCTS` (`:1745-1838`) + `assertKindMaySell` | yes for A; absent for L (10.2) |
| `formulaires` | A L I | `MANAGE_FORMS` | `GET :id/forms` at `MANAGE_FORMS` (`:1188-1196`); writes through `assertFormManager` (`forms/forms.service.ts:747-750`) | yes; the list tab is handed a hard-coded `onlinePaymentsReady={false}` (`lists/.../+page.svelte:263`) |
| `reservations` | A L I | `MANAGE_BOOKINGS` | `BookingsService.mayManage` -> `mayAct(MANAGE_BOOKINGS)` (`bookings/bookings.service.ts:150-165`) | yes |
| `partnerships` | A L I | `MANAGE_PARTNERSHIPS` | `:id/partnerships*` at `MANAGE_PARTNERSHIPS` (`:1623-1711`) | yes |
| `republications` | A L I | `POST_AS_ASSO` or `PROPOSE_EVENT` | `proposals/proposals.controller.ts:25-50` -> `mayAct(senderFlag / acceptorFlag)` (`proposals/proposals.service.ts:547-556`) | yes; E6 (every type) is another agent's |
| `audience` | A I | global admin, or this entity's BDE super-admin when not an institution | `associations/:id/audiences` GET/PUT (`spaces/spaces.controller.ts:53-80`): admin, or a BDE star within its campus (per space in #2949); institution admin-only (`spaces/audience-policy.ts:97`) | **no for lists** - the server lets the BDE write a list's audience; no edit page draws it (`editSections.ts:141-143` says "written from the association edit tooling", but that page redirects every list to `/lists`) (F4) |
| `danger` | A L I | archive = `MANAGE_MEMBERS`; delete card = global admin or this entity's super-admin (`editSections.ts:88`) | archive = `PATCH :id {archived}` at `MANAGE_MEMBERS`; `DELETE :id` = admin or `isAssociationSuperAdminOf` (`:743-757`) | yes on `main`; **institution: a BDE may delete it on `main`** - #2953 adds `INSTITUTION_DELETE_ADMIN_ONLY` and the client follows |

### 10.2 Payment delegation for a list - the exact gaps

The routing itself is type-blind and correct: `resolvePaymentTarget`
(`associations/payment-delegation.util.ts:92-140`) sends an APPROVED delegate's money to the
parent's Lydia Business and fails closed when the parent is gone (`:111-121`) - it never falls back
to the child's own account. Every paid path asks it: paid forms (`forms/forms.service.ts:277`,
`:1728-1729`, `:1874`, `:2259`, `:2422`, and `forms/lydia-reconciliation.service.ts:396`), the shop
and the cotisation product (`products.service.ts:612-634`, `:1350`, `:1547`, `:2089`), the release of
withheld products (`:787-815`, `approvedDelegateIds`), and refunds, which the PARENT's payout managers
issue (`associations/refunds/refunds.service.ts:338-366`). Nothing on that path reads the entity's
type. What stops a list is the gate around it:

| # | Gap | Where | What WP-L must do |
| --- | --- | --- | --- |
| G1 | A list may not sell at all | `selling-kinds.ts:13` and its nine callers above | replace "may this KIND sell" by "may this ENTITY collect now": an association always; a list only through an APPROVED delegate (`isDelegating`); an institution never (F3). The delegation REQUEST must be open to a list - it is how it gets there |
| G2 | No list officer can hold `MANAGE_PRODUCTS` | `writablePermissions`, `SELLING_ONLY_FLAGS` (`selling-kinds.ts:46-53`) | for a list strip `MANAGE_PAYOUT_ACCOUNT` only. This is where section 8.1 point 1's `TYPE_EXCLUDED_FLAGS` belongs - one map, not two |
| G3 | The client draws no paid section for a list | `EDIT_SECTIONS_BY_KIND.list` (`editSections.ts:149-164`); `kindOffersFlag` derives the role editor from it | add `achats`, `cotisations`, `delegation`, and a list `payments` holding the boutique only. `SECTION_FLAGS.payments` (`:170-173`) carries `MANAGE_PAYOUT_ACCOUNT`, so adding `payments` as it is would OFFER the bank-account checkbox on a list: the offered flags must pass through the kind map (G2) |
| G4 | The client's readiness ignores delegation | `isPaymentAccountReady` / `canAssociationReceiveFormPayments` (`lib/associations/api.ts:2564-2580`) read the entity's OWN `lydiaOnboardingComplete` | a delegating entity - association or list - is told "payments not configured" by the forms editor (`routes/forms/create/+page.svelte:107`, `routes/forms/[id]/edit/+page.svelte:102`, `lib/components/forms/FormPaymentSection.svelte:94-99`) and the boutique (`EditBoutiqueTab.svelte:308`) while the server would accept. Serve one resolved field (`paymentsReady`, from `resolvePaymentTarget`) on the entity read and draw from it. **This gap exists TODAY for delegating associations** |
| G5 | A Lydia Business can still be created for a list | `canManagePayoutAccount` (`associations.service.ts:4510-4519`) has no kind check; core-service onboarding asks only it, then calls Lydia's `business/create`; the LINK is refused afterwards (`associations.service.ts:3207-3208`) | refuse in `canManagePayoutAccount` through the G2 map, so no Business is created at Lydia that Canari then refuses to link. Reachable today by the platform admin, or a member row written before 2026-10-31 |
| G6 | A list without a delegate meets a generic refusal | `assertPaymentsReady` (`associations.service.ts:4285-4300`) | 8.1 point 3's typed `LIST_DELEGATE_REQUIRED`, raised inside the readiness answer so every path inherits it |
| G7 | A revoked delegation, or a receiver that loses its Lydia, leaves the products on sale | 10.3 | withhold in the same transaction (10.3) |
| G8 | Refunds and the statement of a list's payments | `assertPayoutManager` on the LIST, a right a list will not hold | correct once G2 lands: the parent refunds its delegates' payments (`refunds.service.ts:359-366`). The list's `achats` tab shows the purchases without refund controls, from `rights.payoutAccount` (F6) |

Each gap is a test: G1 a list with an approved delegate creates a priced product, enables the
cotisation and publishes a paid form, and without one is refused `LIST_DELEGATE_REQUIRED`; G2 a list's
`MANAGE_PRODUCTS` survives a write, `MANAGE_PAYOUT_ACCOUNT` does not; G4 a delegating entity's form
editor offers payment; G5 `GET :id/manage-permission` answers `ok: false` on a list for the platform
admin; G7 a rejection and an unlink each withhold the child's products.

### 10.3 Is "the receiver accepts" already the delegation pattern? Yes.

The owner asked: *"ce n'est pas le motif actuellement en place pour la délégation ?"* - it is.

- **Request.** The CHILD asks: `POST :id/payment-delegation` at `MANAGE_PRODUCTS` on the child
  (`associations.controller.ts:1756-1762`) -> `requestPaymentDelegation` writes status `pending`
  (`associations.service.ts:4335-4372`, the write at `:4366-4369`). It refuses self-delegation, chains
  (a parent that itself delegates) and a requester that already receives delegations.
- **Accept.** The RECEIVER accepts: `POST :id/payment-delegation/children/:childId/approve` at
  `MANAGE_PRODUCTS` on the PARENT (`associations.controller.ts:1818-1826`) -> `approvePaymentDelegation`
  (`associations.service.ts:4415-4440`) requires a `pending` request naming this parent (`:4425-4430`)
  and the parent's own Lydia onboarding complete (`:4431-4435`), then writes `approved` (`:4436`).
  Until then `resolvePaymentTarget` routes nothing (`isDelegating` needs `approved`,
  `payment-delegation.util.ts:44-48`).
- **No path to `approved` without that call.** `:4436` is the only writer of `approved` outside the
  migration that created the column (`migrations/017_payment_delegation.sql`); `PATCH :id` cannot
  write the delegation columns (`UpdateAssociationDto` has none, `dto/association.dto.ts:113-206`).
  **But two tiers may make that call on the receiver's behalf**: the platform admin (`mayAct`
  answers true for every flag, `associations.service.ts:2024`) and a BDE super-admin governing the
  receiver (`MANAGE_PRODUCTS` is not in `SUPER_ADMIN_EXCLUDED_FLAGS`, `:2025-2033`). Neither is the
  receiver's treasurer, and nothing logs that the acceptance came from such a tier (answered by F4: the BDE tier may no longer accept, and every acceptance is recorded).
- **The child may switch or cancel alone**: a new request overwrites an approved one back to
  `pending` for the new parent (`:4366-4369`), and `DELETE :id/payment-delegation` clears it
  (`:4374-4385`) - its money then stops, it is never routed elsewhere without a new acceptance.
- **The receiver revokes**: `POST .../children/:childId/reject` (`associations.controller.ts:1828-1832`)
  -> `rejectPaymentDelegation` (`associations.service.ts:4443-4459`) clears both columns. The child's
  products stay `isActive`; its checkouts then resolve to its own account and refuse (fail closed,
  `payment-delegation.util.ts:132-140`). No money goes astray, but buyers meet active products that
  refuse, and nobody is told.
- **The receiver loses its Lydia**: a readiness REVERT withholds the receiver's products AND its
  approved delegates' (`setLydiaReadiness`, `associations.service.ts:3343`, via `approvedDelegateIds`)
  - correct. An UNLINK by the platform admin (`clearLydiaAccount`, `:4129-4160`) only nulls the
  account columns: nothing is withheld, neither its own products nor its delegates', and the
  delegation stays `approved`. Checkouts fail closed (`ready` false), so again no money goes astray,
  but every product stays visible and refuses.

So the consent step exists and is the receiver's; what is missing is the symmetric withhold on
reject, cancel and unlink (G7), and an audit of who accepted (F4).

### 10.4 The profile permission (E7) - the fields, and the concerns

`PATCH :id` writes `UpdateAssociationDto` (`associations/dto/association.dto.ts:113-206`):

| Field | Goes to the new profile right | Stays where |
| --- | --- | --- |
| `name`, `description`, `bioMarkdown`, `color`, `contactEmail`, `logoUrl` | yes | - |
| `categoryId` (the carte's thematic category - the nearest thing to "tags" a profile has) | yes | - |
| `promo`, `name2` (lists) and `logoMediaId2`; `POST`/`DELETE :id/logo` (`?slot=second` included) | yes | - |
| `documentQuotaBytes` | no | platform admin; today SILENTLY dropped (`associations.controller.ts:780-783`) - it should be a typed refusal, the client never sends it |
| `cotisationEnabled`, `cotisationMode`, `cotisationExpiresAt` | no | `MANAGE_PRODUCTS` |
| `archived` | no | `MANAGE_MEMBERS` (the Danger section; a lifecycle act, not the profile) |
| `parentAssociationId` | **no** | platform admin only (A4, B1) - today ANY `MANAGE_MEMBERS` holder of ANY kind may rewrite it: the list profile form sends it (`lib/components/associations/edit/EditProfileTab.svelte:128`) and nothing checks the kind or the caller (F1) |

There are no "links" fields: links live in `bioMarkdown`. The `:id/tags` routes are the COTISATION
tags granted to people (`associations.controller.ts:1198-1240`), not profile tags - they stay
`MANAGE_MEMBERS`.

Concerns for whoever builds it:
- **The route can no longer carry one flag.** Today the guard asks `MANAGE_MEMBERS` and the handler
  adds `MANAGE_PRODUCTS`, so the cotisation config needs BOTH (F5). Map each field to the right it
  needs, in one table, and ask `mayAct` once per distinct right the body touches.
- **Bit 12 (4096), deploy order.** `ALL_PERMISSION_FLAGS` bounds the member DTOs, so an old server
  answers 400 to a mask carrying it: deploy the server first, as for `MANAGE_BOOKINGS`.
- **Presets.** `ALL_CORE_FLAGS` gains it on both sides (`association-member.entity.ts`,
  `lib/associations/api.ts:43-55`); `SECTION_FLAGS.profile` (`editSections.ts:168`) becomes the new
  flag, so `permissionMaskFor` offers it on every kind. Not in `SUPER_ADMIN_EXCLUDED_FLAGS`.
- **The migration** (decided), same shape as 083 for `MANAGE_BOOKINGS`. Its count, read-only, before
  it runs: `SELECT a.type, count(*) FROM association_members m JOIN associations a ON a.id =
  m."associationId" WHERE m.permissions & 4 <> 0 GROUP BY a.type;`
- **#2949's grant ceiling** applies: a member grants the new bit only if it holds it, which the
  migration ensures for every current `MANAGE_MEMBERS` holder.

### 10.5 Inconsistencies across the three types

| # | Finding | Where | Proposed |
| --- | --- | --- | --- |
| F1 | A list officer rewrites the list's governing parent from the profile form | `EditProfileTab.svelte:128`, DTO `:176` | platform admin only (#2964), and **journaled since WP-D1**: a platform admin's `PATCH :id` parent goes through `SpacesService.setParent` (2.8) |
| F2 | **A BDE super-admin who is not a member cannot open a list's management area**, so E3 (the BDE deletes its lists) has no UI | `routes/lists/[slug]/edit/[[section]]/+page.svelte:158` and `:195` omit `isSuperAdminUser`, which the association page includes; the BDE reach is fetched without `await` (`:172`), so the decision races it | read the tier exactly as the association page does (awaited); better, one loader for both pages |
| F3 | `MANAGE_PAYOUT_ACCOUNT` is offered wherever `payments` is - after the decision it means nothing on a list | `SECTION_FLAGS.payments` (`editSections.ts:170-173`) | through the kind map (G2, G3) |
| F4 | A list's audience is writable on the server, drawable nowhere | `spaces/spaces.service.ts:224-235` vs `editSections.ts:141-143` | the Audience panel of `/admin/spaces` (#2951) or a list `audience` section; the comment corrected either way |
| F5 | Cotisation config: a `MANAGE_PRODUCTS`-only holder is offered an edit the route refuses | `EditCotisationsTab.svelte:738` vs `associations.controller.ts:769-801` | the per-field map of 10.4 |
| F6 | The Achats tab learns a right by failing | `EditAchatsTab.svelte:125-132` | pass `rights.payoutAccount` down; a 403 is then a defect, logged as one |
| F7 | Wording: `kindWording.list.editTitle` says "Gestion de l'association" while the list page says "Gestion de la liste"; `asso_flag_post_as` says "Publier au nom de l'asso" on lists and institutions | `lib/associations/kindWording.ts:76`, `frontend/messages/fr.json:1612` | `editTitle` from `list_edit_page_title`; a kind-neutral "Publier en son nom" |
| F8 | Presets per type: association Admin = 3871 (bank account included); list and institution Admin = 3103 (`adminPresetFor` masks the shop and the bank account); institution default = Publisher. After WP-L a list Admin is 3359 (shop, no bank account) | `EditMembersTab.svelte:40-47`, `editSections.ts:200-202` | follows from G2/G3 |
| F9 | A BDE association sees the same sections; only its member editor adds `VALIDATE_EVENTS`, `MANAGE_ASSO`, `MODERATE` (`AssociationMemberRow.svelte:67-72`). The Admin preset grants none of them, and nothing on its edit page shows the spaces it governs or the entities that depend on it | - | **built (2.8)**: a "Bureau du BDE" preset (Admin + the three), and the entities depending on it, read-only on its edit hub, linking to `/admin/spaces` for the platform admin; the spaces it governs stay platform-admin only |
| F10 | Institutions on `main`: governed by any reaching BDE for members and deletion (G6, E5) | `mayAct`, `DELETE :id` | #2949 and #2953, both open |
| F11 | Institutions sell nothing on `main` (`selling-kinds.ts:13`), while section 6 rows 16-18 still say "yes" | section 6 of this page | answered by F3 (sells nothing, as today); section 6 corrected |
| F12 | The `MANAGE_ASSO` comment says it does not delete an association | `association-member.entity.ts:20-24` | WP-R5 (known) |

### 10.6 Questions for the owner from this audit - all answered

Kept as asked. The owner took the recommended option each time: question 1 is F3, question 2 is
F4, question 3 is F5, question 4 is F6 (section 0).

1. **Les institutions doivent-elles pouvoir encaisser de l'argent (boutique, formulaires payants, cotisation) ?** Aujourd'hui le code le leur interdit totalement depuis le 31 octobre ; une ligne de cette page dit le contraire.
   - (Recommandé) Non, comme aujourd'hui : rien ne change dans le code, on corrige seulement cette page.
   - Oui, comme une liste : seulement via le compte Lydia d'une autre entité qui accepte.
   - Oui, comme une association : avec leur propre compte Lydia.
2. **Qui peut accepter, au nom de l'entité qui reçoit l'argent, la délégation de paiement d'une liste ?** Aujourd'hui, c'est quiconque a le droit « Gérer la boutique et les cotisations » sur l'entité qui reçoit, mais aussi l'admin plateforme et un membre du BDE qui gère cette entité, sans que personne ne voie qui a accepté.
   - (Recommandé) Les gestionnaires de l'entité qui reçoit et l'admin plateforme seulement, chaque acceptation étant tracée ; le BDE n'accepte plus à la place d'une entité qu'il gère.
   - Comme aujourd'hui, en ajoutant seulement la trace de qui a accepté.
3. **Quand l'entité qui reçoit l'argent retire sa délégation, ou perd son compte Lydia, que deviennent les produits et formulaires payants de la liste ?** Aujourd'hui ils restent affichés mais tout paiement est refusé, et personne n'est prévenu.
   - (Recommandé) Ils sont mis en pause automatiquement (comme quand Lydia bloque un compte) et les gestionnaires de la liste sont prévenus ; ils reviennent dès qu'une nouvelle délégation est acceptée.
   - Comme aujourd'hui : visibles, mais le paiement est refusé.
4. **L'entité qui reçoit l'argent d'une liste doit-elle être le BDE dont dépend la liste ?** Aujourd'hui la liste peut choisir n'importe quelle association dont le compte Lydia est prêt.
   - (Recommandé) N'importe quelle association qui accepte, comme aujourd'hui : le BDE n'a pas forcément de compte Lydia.
   - Seulement le BDE dont dépend la liste.

## 11. WP-PIN - a pin is a promotion per space, not a global flag (decided 2026-11-03)

**BUILT (2026-11-03, branch `feat/space-pins`)** - as designed below; what was built, where:

- **One SQL module**, `apps/social-service/src/posts/space-pins.ts`: who pins (`bdePinsInSpaceSql` =
  `bdeStandingInSpaceSql` at `MODERATE`, the platform admin decided by the caller), what is pinnable
  (`postPinnableInSpaceSql` = `postReachesSpaceSql` in `spaces/reader-spaces.ts` + the feed's own
  lifecycle terms: published, not hidden by moderation, not a dead reel), THE rank (`rankedPinsSql`),
  the reader's pins (`pinnedForViewerSql`, over `isPinSpaceOfUserSql` = own spaces + read-grant
  cells). `holdsBdeFlagOverSql` is deliberately NOT used: it answers "governs this ASSOCIATION" and
  excludes institutions and other BDEs, which pinning must not (decision 1, G9).
- **`postReachesSpaceSql`** ("visible to the readers of a space") is `postVisibleToUserSql` minus the
  personal doors (membership, follows, member reposts, read grants): an association's rules, a
  personal post's author's spaces, a republisher's rules unless it is archived (an archived carrier reaches nobody, as in the reader's predicate since #2965). `space-pins.integration.spec.ts` holds the
  two equal for a probe reader per space on every post.
- **Writes**: `SpacePinsService` (`space-pins.service.ts`) behind `SpacePinsController`:
  `PATCH /api/posts/:postId/pin|unpin` with `{ spaceId }`, and the governor's list
  `GET /api/posts/space-pins/:spaceId` (`shown` / `pending`). Refusals are typed bodies:
  `space_pin_limit`, `post_not_in_space` (409), `space_pin_forbidden` (403),
  `space_not_found` and `post_not_found` (404). **Authorisation comes FIRST** (review F4): the
  space's governance is checked before the space lock, before the post's existence and before its
  reach, so a caller who does not govern the space is told the same `403` whether the post exists or
  not - an unknown space included (only the platform admin hears `space_not_found`). The answer's
  `pinned` is the post's state IN THAT SPACE. **The body names the space, always, since floor
  `1.6.6`**: a body-less pin or unpin is a `400`; before it, the server pinned in the one space that
  fit and answered `space_required` otherwise, for builds up to `1.6.2`
  ([legacy-compatibility](legacy-compatibility.md#entries-166-retires-or-unblocks-the-owners-raise-of-2026-11-08)).
- **Reads**: every post the server serves carries `pinned` (per reader), `canPin` and `pinSpaces`
  (`{ spaceId, formation, campus, state }`, the menu's entries) - two queries per page in
  `PostsService.pinContext`. The feeds and the search sort by `pinnedForViewerSql`; the post-list
  cache key already carries the viewer, so no entry is shared across readers.
- **Client**: `PostActionsMenu` draws one entry per served space ("Épingler" alone with one;
  "Épingler pour ISMIN, Saint-Étienne" with several; "(en attente)" on a pending pin); a
  `space_pin_limit` refusal reads `post_pin_limit_reached`. The governor's list endpoint has no
  screen of its own yet: the pending state reaches the governor on the post's own menu.
- **Migrations**: 127 (`post_space_pins`, additive) and 128 (the move of the global pin, HELD for
  the owner's hand-merge; run on both estates by `v1.6.3`, its one flagged post carried).
  `posts.pinned` was read by nothing, then unmapped from the entity (2026-11-04), then dropped by
  134 (held: a DROP) in a LATER release, since an older image still named it in every INSERT
  ([durable-rules](durable-rules.md#release-and-ci---cicd)). 128 NOTICEs every pin it does not carry: each
  governed space where the post is visible but that had no room, and each flagged post pinned
  nowhere (visible in no governed space, or not live at run time - hidden, scheduled, an expired
  reel); nothing re-runs it, so the run's log is the re-pin-by-hand list.
- **The deploy window (review F2): nil for the new code.** `infrastructure/deploy/deploy-environment.sh`
  calls `apply_migrations` BEFORE the rolling replacement of the services (`rolling.sh`), so a new
  container never serves without 127 and 128 applied; while they apply, the OLD containers keep
  serving and keep reading `posts.pinned`, which 128 does not clear, so the global pin stays on top
  until the rollover. One loss is possible, and accepted: a pin or unpin made through the old routes
  in the minutes between 128's run and the rollover writes only `posts.pinned` and is not carried.
  An OLD client after the rollover reads `pinned` per reader and pins body-less (the rule under
  "Old clients" below), and so does an old web bundle still open in a tab. 128 being held, the loop
  takes the pre-migration backup (`migration_backup`) right before it.
- **Owner's answer to the review (2026-11-03): a BDE MAY pin, in its own space, a post by ANOTHER
  BDE or by an institution that is visible there** - pinning is a promotion, not moderation; the
  rule "no BDE acts on another BDE's content" (2026-11-03) covers moderation and management only.
- **A pin kept invisible is listed NOWHERE (review F5)**: not in a reader's feed, not in the
  governor's list, not on the post's menu in that space (the menu offers only spaces where the post
  is pinnable). It is removable only by `PATCH .../unpin` with that `spaceId`, and when its post
  becomes visible again it re-enters THE rank at its original `pinned_at` - which may push a SHOWN
  pin to "en attente" (the oldest of the four waits, whichever it is).
- **A pin filtered out for one reader still takes a shown slot (review F7).** The rank is per space,
  not per reader: a shown pin whose post a given reader is not served - the promotion cutoff, a
  blocked author, a grant-only reader looking at personal posts - is one of that space's 3 for
  everyone, and that reader simply sees fewer than 3 pins on top.

**Before WP-PIN.** `posts.pinned` was one global boolean, set by `PATCH /api/posts/:postId/pin|unpin`
behind `assertContentModerator` (platform admin, or any BDE member holding `MODERATE`); feeds sorted
`posts.pinned DESC`. So any BDE pinned any post to the top for every reader on every campus.
Production held exactly one pinned post (measured 2026-11-03).

**Owner decisions (2026-11-03)** - *"ce serait bien que le BDE puisse epingler (= mettre en avant)
n'importe quel post sur l'espace dont il est responsable"*:

1. Pinning is a PROMOTION right, separate from moderation. G9 (no BDE moderates an institution's
   content) must not remove it.
2. A BDE's pin puts the post on top ONLY for readers of the spaces that BDE governs.
3. Any post visible to the readers of those spaces can be pinned: associations, lists, institutions,
   students' personal posts, republications.
4. At most 3 pins per space. A 4th is refused with a typed error telling the client to unpin one first.
5. A pin never expires; only a gesture removes it.

**Coordinator addition (reversible).**

- **Reader spaces include read grants.** A reader's spaces for pin ordering are the spaces they belong
  to PLUS the spaces reached by their `read_grants` (formation NULL = the whole campus). A staff
  account with no space but a campus-wide grant sees, first, the pins of every BDE governing a space
  of that campus; a grant on another campus gives nothing.

**Lead's reversible choices (mine, not the owner's - change them by editing this list).**

- The platform admin may pin in any space, through the same per-space mechanism. There is no global
  flag any more.
- The right is held by a BDE member holding `MODERATE` in that BDE until a dedicated flag is decided;
  reversible, nothing else keys on it.
- **A pin whose post stops being visible in that space is kept, not shown, and not counted** toward
  the 3. Deleting at every visibility change would need a hook on each path that can change
  visibility (audience edit, unpublish, author leaving, soft delete) and a missed one leaves a
  phantom; computing "visible" at read time needs no hook and cannot drift. The cap is checked on
  the visible pins only. If the post becomes visible again its pin returns.
- **Never more than 3 shown (rule added 2026-11-03 by the coordinator's review).** A returning pin
  could make 4 visible. The deterministic rule: among a space's VISIBLE pins, order by `pinned_at`
  DESC (ties broken by `post_id`) and SHOW only the first 3. The others stay stored, are not shown
  to readers and are not counted as shown, and the governor's pin list for that space returns them
  flagged "en attente" (Paraglide fr/en) so one can be unpinned or left. The cap check on a new
  pin counts the SHOWN pins (at most 3), so a 4th is refused with `space_pin_limit` whether or not
  "en attente" pins exist. One shared SQL rank (`ROW_NUMBER() OVER
  (PARTITION BY space_id ORDER BY pinned_at DESC, post_id) <= 3`) serves the feed ordering, the
  `pinned` field and the governor list, so the three cannot disagree. Test: pin 3, hide one post,
  pin a new one (3 visible), make the hidden post visible again: four are visible, and the 3 with the
  newest `pinned_at` are shown. With the FIRST-pinned post the one hidden (the built test), the
  returning pin is the oldest and is the one listed "en attente"; had a later one been hidden, it
  would return among the 3 and the first-pinned post would wait instead - the rule is `pinned_at`,
  never "the returning one". Unpinning one of the 3 promotes the waiting pin.
- **UX.** The pin routes take the space: `PATCH /api/posts/:postId/pin` with `{ spaceId }`, same for
  `unpin`. The post menu lists the governed spaces where the post is visible; with exactly one it
  pins directly. There is no "pin in every space" shortcut (it would burn a slot in each space
  without the governor choosing it).
- **Migration of the one global pin.** It goes to every governed space where the post is visible and
  that has room (all empty today), and to none, with a `NOTICE` naming the post id, when no BDE
  governs a space it is visible in. Deterministic, loses no pin that has a possible home, invents no
  space. It is a data migration, so it carries the repo's hold marker and waits for the owner's
  hand-merge.

**Shape.**

- Table `post_space_pins (post_id, space_id, pinned_by, pinned_at)`, unique `(post_id, space_id)`.
- **The cap holds under concurrency by serialising on the space**: the pin transaction takes
  `pg_advisory_xact_lock` keyed on the space id, counts the visible pins, then inserts. The typed
  error is a 409 with a stable code (`space_pin_limit`), never matched by message.
- **Feeds**: `ORDER BY (pinned in one of the reader's spaces) DESC, created_at DESC`. The reader's
  space set (membership plus read grants) is part of the post-list cache key; never a global entry,
  or one campus's pin leaks to another.
- `canPin` per post is computed for the viewer (a governed space where the post is visible, and the
  right held). `pinned` in the response means pinned in one of the viewer's spaces.
- **Old clients.** They read `pinned` and send a body-less `pin`. `pinned` keeps the meaning above; a
  body-less pin was accepted when exactly one governed space fit and was otherwise refused with a
  typed `space_required` 409 - until floor `1.6.6`, since when it is a `400`. `posts.pinned` stops being read at once; the column is unmapped, then
  dropped in a later release (migration 134).
- Tests: unit; integration with two BDEs on one campus (an ISMIN pin is not on top for ICM readers);
  the 4th pin refused; two concurrent pins at 2 of 3 leave exactly 3; an institution post pinnable
  (G9 intact); unpin; a no-space account with a campus-wide read grant sees an ISMIN-space pin first,
  an account with a grant on another campus does not.

**Order.** Built on top of #2953 (moderation scoped per space, it touches the pin routes) and #2949
(governed spaces, `holdsBdeFlagOverSql`). No code is branched from either while open.
