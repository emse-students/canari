# Spaces, audiences and dependencies - a reform proposal (2026-11-02)

**Status: PROPOSAL, revised after each of the owner's five rounds of answers the same day (section
0). Nothing is built.** Written for the owner to decide. It extends
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
| 5 | E4 | ~~Lists lose Lydia payments, the shop and the document vault~~ - **CORRECTED by the owner the same day**: *"en fait je ne veux pas retirer la boutique aux listes, ni les formulaires ou autres payants. Par contre, une liste ne peut pas avoir de compte Lydia, donc elle est obligee de deleguer."* Lists KEEP the shop (cotisation included), paid forms and every paid feature; a list may NOT hold its own Lydia account, so its payments go through payment delegation (`paymentParentAssociationId`). The vault is NOT decided by the correction | WP-L (section 8.1); the vault is the open question |
| 5 | E6 | **Republication for EVERY type, without exception**: lists and institutions may ask a person to republish their post, so an institution may carry a student's personal post with the student's consent (this lifts the D34-D36 point); list posts become member-repostable | its own pull request; section 6, rows 11-13 |
| 5 | E7 | **A new "edit profile" permission, separate from `MANAGE_MEMBERS`**, granted by migration to every current `MANAGE_MEMBERS` holder | its own pull request; section 6, row 9 |
| 5 | E5 | **No BDE ever governs an institution** (decided in another thread; fixed at the predicate level by #2949 - archive, members, profile, audience, and every path that asks the same predicate) | WP-R0's institution half is #2949 |

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
  - The service checks the same rules first, so a refusal reaches the client as a typed 4xx; the
    trigger is what makes a hand-written `UPDATE` unable to break it.

### 2.3 Space governors - an institution included (D3)

The space axis is NOT the parent axis, and D2 does not touch it: **a space's governor may be a BDE or
an institution** (`setBde`'s type check, `spaces.service.ts:167`, widened to `association |
institution`; closes P10). So the admin may place a formation with no BDE under the School, whose
`VALIDATE_EVENTS` holders then answer for it; a space with no governor is the platform admin's. An
institution governing a space is still not a BDE for D2: it never becomes a parent, and nothing
depends on it.

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
`at`) in the same transaction (the shape of `read_grant_journal`, migration 078). The owner sets
the existing parents by hand; WP-D2 ships when he says they are set. **Read-only counts for him**
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
(the owner clears or corrects those rows by hand first).

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

Each deletion of a decision is logged with its cause. The write that changes the spaces notifies
the governors left pending (`notifyEventValidatorsOfProposal`, `associations.service.ts:2409`, per
slice); a read-time-only change (a governor reassigned) is announced by the admin action that made it.

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
| 16 | Lydia, payout, shop, vault | yes; `MANAGE_PAYOUT_ACCOUNT` never through the super tier | **yes in code** - no server or client type check (`editSections.ts:70-90`) - while the entity comment says lists are "associations minus the banking/shop/vault features" (`association.entity.ts:177-180`) | yes | association, institution: unchanged; **list: shop and every paid feature kept, NO own Lydia account - paid through delegation (E4 corrected, WP-L); vault open (question 1)**; the entity comment is corrected to say exactly that | Differs (own Lydia account); **Disagree** today (comment vs code) |
| 17 | Payment delegation | `paymentParentAssociationId`, any type, financial only | same | same | unchanged, kept apart from the governance parent (2.2); **for a list, the ONLY way to be paid (E4 corrected)** | Differs (list) |
| 18 | Bookings, forms, cotisation, partnerships | yes, by their flags; no type check | same | same | unchanged | - |
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
Lydia account of its own and is paid through delegation. Moderators hide and delete, never edit.

**Quick wins - each ships BEFORE the reform, alone, on today's model:**

| WP | What | Why it cannot wait | Data change |
| --- | --- | --- | --- |
| **WP-Q1** | Partner rights (E2, closes P14): `assertMayWriteEvent` returns the side the caller writes from; a co-organiser-side date, audience, `coOwnerIds` change or delete is refused with one typed 403 (`CALENDAR_PARTNER_ORGANISER_ONLY`); the event form hides those controls for a partner; `coorganisation.integration.spec.ts` gains the four refusals and the allowed text, poster and withdrawal | a partner can delete another campus's event today | none |
| **WP-Q2** | P13 interim: accepting a co-organisation on a VALIDATED event returns it to `pending` (status, `validatedAt`, `validatedBy` cleared) in the acceptance's own transaction (`CoorganisationService.apply`, `coorganisation.service.ts:281-300`), logged, and the event's validators notified as for a proposal - the date-move rule applied to the new reach. Superseded by WP-E, where an acceptance re-opens only the new governors' slices | today an acceptance widens a validated event with no validation | none |
| **WP-L** | A list has no Lydia account of its own and is paid through delegation (E4 corrected), detailed in 8.1 | the owner's decision | none: every list counter is 0 in production (8.1) |

**The reform:**

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | The institution half is **#2949** (E5, at the predicate level). What remains: the moderator's EDIT removed (G3, P7) | one capability | none |
| **WP-R1** | Audience bounds per SPACE (`GOVERNED_SPACES_SQL`) | server checks; closes P3 | none |
| **WP-D1** | `parentAssociationId` generalised to associations; the two-level triggers (2.2); a space governor may be an institution; `dependency_journal`; the Dependencies panel beside the Audience panel; default parent and parent-derived default audience; `setBde`/`setAudiences` decoupled | additive; nothing reads the parent for governance yet; closes P2, P4, P10 | **schema + triggers: owner's yes; refused while the 2.7 count is above zero** |
| **WP-D2** | `holdsBdeFlagOverSql` on the parent (2.4); no parent = admin; parent-bounded audience writes; deletion of an association or list by its parent BDE (E3) | ships when the owner says the parents are set; closes P1, P5, P9 | none |
| **WP-R4** | `MODERATE` scoped (2.4) | needs WP-D2; closes P6 | none |
| **WP-I** | Institution item audience (section 3) | additive; closes P12 | **two tables: owner's yes** |
| **WP-E** | Events per slice (section 4) and partnerships under it (section 5): the decisions table, the space-governor predicate, both agendas and the `.ics`, per-slice notifications, D4's re-opening (replacing WP-Q2's whole-event demotion), `EXPLAIN` | needs WP-D1 (space governors) and, for institutions, WP-I; closes P11, P13 | **one table + the event migration of 4.3: owner's yes** |
| **WP-R5** | Parent presets; `openedAt` and "OPEN spaces" removed; the stale WP6e line on lists; **the `MANAGE_ASSO` comment (`association-member.entity.ts:20-24`) corrected to say it includes deleting an association or list the BDE governs (E3)** | cosmetics | dropping `openedAt`: owner's yes |

Each WP changes its tests (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`,
`associations.service.never-auto-validates.spec.ts`,
`associations.service.revalidate-on-date-change.spec.ts`, `coorganisation.integration.spec.ts`, the
agenda and moderation specs) and updates [profiles-and-access](profiles-and-access.md) (D20, D22,
D23, D33, D39 amended) and [calendar](frontend/modules/calendar.md).

### 8.1 WP-L - a list has no Lydia account of its own and is paid through delegation (E4 corrected)

**What a list keeps**: the shop (the cotisation product included), paid forms and every other paid
feature - unchanged. **What it loses**: its OWN Lydia account. Its payments go through payment
delegation to a parent's account (`paymentParentAssociationId`, `association.entity.ts:113-129`).
The vault is not part of this WP (question 1).

1. **`MANAGE_PAYOUT_ACCOUNT` excluded for lists, in one place.** A map beside
   `SUPER_ADMIN_EXCLUDED_FLAGS` (`association-member.entity.ts`), `TYPE_EXCLUDED_FLAGS = { list:
   MANAGE_PAYOUT_ACCOUNT }`, read by `mayAct` and `mayActOnAny`
   (`associations.service.ts:2018-2077`): no tier - the platform admin included - holds it on a list,
   so every route that flag guards refuses with no edit of its own. The vault flag can join the same
   map later if question 1 says so.
2. **Lydia enrolment refused for a list**, with one typed code (`LIST_NO_OWN_LYDIA_ACCOUNT`), on the
   enrolment, readiness and cashier paths that the flag does not already cover - checked by the same
   map through one helper (`assertTypeMayHold(type, flag)`), never a second list of types.
3. **A paid feature on a list with no APPROVED delegate refuses clearly, at its entry**: creating a
   priced product, enabling the cotisation, publishing a paid form, and a buyer's checkout are refused
   with one typed code (`LIST_DELEGATE_REQUIRED`) whose client sentence says "choose the association
   whose Lydia account receives your payments" and links to the delegation section - instead of a
   failure deep in the payment provider call. A free product or a free form is unaffected.
4. **The delegation setting is reachable for a list.** It already is in the code: the routes
   `GET/POST/DELETE :id/payment-delegation` (`associations.controller.ts:1744-1770`) need
   `MANAGE_PRODUCTS`, which a list keeps, and the client's `delegation` section is drawn on the same
   flag (`frontend/src/lib/associations/editSections.ts:104`, `170`). WP-L adds a test that a list's
   officer reaches both, and the `editRights` change of point 1 (`payoutAccount` false for a list) so
   the Paiements section shows the delegation state instead of an enrolment button.

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

## 9. Questions for the owner (seventh round)

Decided, so no longer asked: partnerships kept (E1), the partner's rights (E2), a BDE may delete its
dependent associations and lists (E3), lists keep every paid feature but no own Lydia account (E4
corrected), republication for every type (E6), a separate "edit profile" permission (E7). Existing
list data: none in production, so no question.

1. **Les listes gardent-elles le coffre-fort de documents ?**
   - (Recommandé) Oui, comme aujourd'hui : il ne touche pas à l'argent, et la correction sur Lydia ne le concerne pas.
   - Non : on le retire aux listes (aucune liste n'a de document aujourd'hui, donc rien à supprimer).
