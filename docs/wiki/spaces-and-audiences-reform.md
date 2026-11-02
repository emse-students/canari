# Spaces, audiences and dependencies - a reform proposal (2026-11-02)

**Status: PROPOSAL, revised four times the same day after the owner's answers (section 0). Nothing
is built.** Written for the owner to decide. It extends [profiles-and-access](profiles-and-access.md)
(D16-D41, the audiences chantier, WP-C read grants, WP-F5/F6) and does not restate it. Every
`file:line` is from `main` at the time of writing (`apps/social-service/src/` unless said
otherwise).

**The model in one paragraph.** Two independent axes, each with its own panel on `/admin/spaces`.
**Audience** says who SEES an entity (today's grid). **Dependencies** say who GOVERNS it - validates,
manages, moderates: an entity depends on ONE parent (a BDE, an institution) or on nothing (then the
platform admin governs), and every space depends on one governor too. The two are correlated by
defaults and shown side by side, never coupled: changing one never silently changes the other.

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
| G6 | An institution's members are managed by the platform admin only | a BDE holding `MANAGE_ASSO` manages them when the institution reaches its space (P8) |
| G7 | A BDE secretary may place themselves in any association they govern | already true through the super-admin tier (`mayAct`, `associations/associations.service.ts:2018-2035`) |

**First round:**

| # | Answer | Effect |
| --- | --- | --- |
| A1 | **The campus is NOT the unit**: *"il peut exister plusieurs formations pour un campus, et un BDE par formation"* - on one campus one BDE governs four formations and another the fifth | governance is attached to an entity, never to a campus |
| A2 | *"Non, sauf l'existant"*: an association or a list addresses only its governor's reach; the other campus through republication or co-organisation; existing wider audiences stay until edited | reconciled with the decoupling in 2.5 (question 1) |
| A3 | A BDE is designated **per formation x campus**, as today | every BDE bound is stated per space (2.6) |
| A4 | **Only the platform admin changes an entity's governor, and every change is logged** | 2.8 |

**Second round:**

| # | Answer | Effect |
| --- | --- | --- |
| B1 | *"On va faire la migration a la main. Apres, ca peut etre un reglage a la main [...] accessible des admins uniquement. Et par defaut evidemment le BDE qui la cree. (idem pour les listes)"* | no computed proposal, no back-fill; an admin-only setting; the default is the creating entity (2.8) |
| B2 | *"on peut avoir une asso/liste/institution sans rattachement"* | no parent = the platform admin governs (2.3) |
| B3 | Another BDE sees the association and proposes a republication or a co-organisation; it validates and manages nothing | 2.7 |
| B4 | An institution is governed by what the admin attaches it to; with nothing, by the platform admin | 2.3 |
| B5 | A personal post is moderated by the BDE governing the author's space; under two, either | 2.7 |
| B6 | *"Quand l'ecole propose un evenement elle choisit son audience ? Chaque BDE pourrait valider ou non pour la formation dont il est le BDE ?"* | section 4: events validated per audience slice |

**Third round:**

| # | Answer | Effect |
| --- | --- | --- |
| C1 | *"Comment une institution choisit l'audience d'un post ? D'une proposition d'evenement ?"*, then: **narrowing an item's audience is for INSTITUTIONS ONLY**; associations and lists always use their entity's audience | section 3 |
| C2 | *"dans la refonte des espaces, on peut avoir deux grands panneaux de gestion : l'un pour l'audience, l'autre pour les 'dependances' ? [...] meme si c'est souvent correle [...] on peut imaginer des cas autres. Notamment avec les institutions, qui sont plus hautes souvent."* | section 2: audience and dependencies are two axes, two panels |

## 1. The current model

### 1.1 Spaces

- A **space** is one `formation x campus` pair (D16): `spaces/space.entity.ts:18-34`, five
  formations x two campuses (`SPACE_FORMATIONS`, `SPACE_CAMPUSES`, lines 4-6) = **10 rows**, all
  present since D17 was relaxed (2026-10-04). `openedAt` and the "OPEN spaces" wording are vestiges.
- A **reader's spaces**: campus is theirs, formation one of their cursus formations
  (`isReaderSpaceSql`, `spaces/reader-spaces.ts:88-90`; pure twin `readerSpaces`, 52-63). Staff
  (campus, empty cursus) get their campus's agenda by `campusWideReaderCampus` (71-76).
- A space carries ONE optional BDE, `spaces."bdeAssociationId"` (`space.entity.ts:32-33`), which
  must be of type `association` (`spaces.service.ts` `setBde`); the same association may be the BDE
  of several spaces (`migrations/071_spaces.sql`). Set on `/admin/spaces` by the platform admin
  (`spaces/spaces.controller.ts:23`, `GlobalAdminGuard`). **`setBde` also inserts an audience rule**,
  and `setAudiences` re-adds the governed spaces to a BDE's own audience (`spaces.service.ts:240-246`):
  governance and audience are coupled in both directions today.

### 1.2 Audiences (reach)

- `association_audiences` rows `(formation | NULL, campus | NULL)`, NULL = "any"
  (`spaces/association-audience.entity.ts`, D19/D33), matched by `ruleReachesSpaceSql`
  (`spaces/rule-sql.ts:8-12`) at read time.
- **Policy** (`spaces/audience-policy.ts`): `everyone` refused outside institutions (42-51); default
  = the creator's campus, every formation (58-68); a BDE "star" reads and writes inside the CAMPUSES
  it governs (77-123); a non-admin creator creates on a governed campus (131-141).
- **Visibility** of an entity's content: a member (D21), OR its rules reach one of the reader's
  spaces, OR (read paths) a read grant meets its rules (`associationVisibleToUserSql`,
  `reader-spaces.ts:168-177`; grants 125-143). **A post or an event has no rules of its own**
  (`postVisibleToUserSql`, 411-436; `eventVisibleToUserSql`, 637-641): per-post rules existed (D33,
  `post_audiences`) and were dropped by D38 (migration `073_republications.sql`).

### 1.3 Governance scope

- "Is a BDE" = designated on at least one space (`isBdeAssociationSql`, `spaces/bde.ts:14-16`).
- `holdsBdeFlagOverSql` (`spaces/bde.ts:35-41`): U holds F in the BDE of ANY space A's audience
  reaches. Read by `VALIDATE_EVENTS` (`mayValidateEventsOf`, `associations.service.ts:1832`, the
  pending queue 2095-2112, the proposal notification 2398-2420) and `MANAGE_ASSO`
  (`isAssociationSuperAdminOf`, 1980, hence `mayAct`/`mayActOnAny`, 2018-2077).
- The audience bounds use the CAMPUSES of the governed spaces (`BDE_GOVERNED_CAMPUSES_SQL`,
  `spaces/bde.ts:47-49`).
- `MODERATE` is unscoped (`isContentModerator`, `associations.service.ts:1994-1998`); 16 call sites
  ask an unscoped BDE question (moderation controller, lives, live chat, comment identity, posts).

### 1.4 Events and their validation

- ONE status per event, `pending | validated | rejected`
  (`associations/entities/association-calendar-event.entity.ts:3-7`).
- Reach = organiser's audience union each ACCEPTED co-organiser's (`eventVisibleToUserSql`,
  `reader-spaces.ts:637-641`; D39). Signed-in agenda: `restrictToViewerSpaces`
  (`associations.service.ts:1678-1688`); anonymous selection: `eventReachesSpaceMatchingSql`
  (`reader-spaces.ts:204-212`, `restrictToSelection`, 1694-1711). Readers see `validated`; proposers
  `pending` too (1617-1622).
- Always created `pending`, platform admin and BDE included (user, 2026-09-14;
  `createCalendarEvent`, 2453-2503; `associations.service.never-auto-validates.spec.ts`).
- Validated or rejected as a whole (`validateCalendarEvent` 2697-2712, `rejectCalendarEvent`
  2715-2741; routes `associations.controller.ts:1029`, `:1045`) by `mayValidateEvent`: the platform
  admin or `VALIDATE_EVENTS` in ANY BDE the ORGANISER reaches (1832-1866).
- A DATE move returns a validated event to `pending`; text, poster, form do not (2545-2627;
  `associations.service.revalidate-on-date-change.spec.ts`).
- Deleted by the organiser's people, or a governing BDE / the admin across associations (2748-2780).
- Notified: proposal -> every governing BDE's validators (`notifyEventValidatorsOfProposal`, 2409);
  decision -> the organiser's admins (`notifyAssocAdminsOfEventAction`, 2362).
- Pages: [calendar](frontend/modules/calendar.md#who-may-deposit-from-the-global-agenda-and-whose-id-carries-the-right).

### 1.5 Pain points, measured from the code

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| P1 | **Reach decides governance** | `bde.ts:35-41` joins `association_audiences` | an association reaching two BDEs' spaces is governed by EITHER, contrary to D22 and G1 |
| P2 | **Governance and audience move each other**: an audience edit grants or removes a BDE's power; `setBde` writes an audience rule; `setAudiences` re-adds a BDE's governed spaces | `spaces.service.ts:224-258` | neither change is visible as what it is |
| P3 | **Two granularities**: validation and management per SPACE, audience and creation bounds per CAMPUS - live on the split campus (A1) | `bde.ts:35-41` vs `47-49`; `audience-policy.ts:77-141` | each of the two BDEs of one campus may rewrite the other's audiences, and by P2 take governance |
| P4 | **The default audience crosses BDE borders**: `(NULL, creator's campus)` | `audience-policy.ts:58-68`, written at `associations.service.ts:565` | on the split campus every new association is governed by both BDEs from day one |
| P5 | **Decision 3 half-enforced**: only campus-NULL rules are refused, so a two-campus audience passes for the admin | `audience-policy.ts:42-51` | multi-campus associations are still creatable |
| P6 | **`MODERATE` is global** | `associations.service.ts:1994-1998` | any BDE moderates, pins and unmasks anonymous posts everywhere (`posts.service.ts:606-608`) |
| P7 | **Moderators edit others' posts** | `posts.service.ts:605` | contradicts G3 |
| P8 | **Institutions under the BDE super-admin tier**: `holdsBdeFlagOver` never checks the type | `mayAct` 2018-2035 -> 1980 | a BDE manages an institution's members, contrary to D20 and G6 |
| P9 | **No rule = no governor**, by accident | `bde.ts:28-29` | an institution's events reach no validator |
| P10 | **Only an association can govern a space** | `setBde` type check | a formation with no BDE has no validator but the admin, and an institution cannot take it |
| P11 | **One validation for many audiences** | entity 3-7; `mayValidateEventsOf` 1832; 637-641 | an event validated by one BDE appears in another BDE's spaces with no say from it |
| P12 | **An institution cannot narrow a post or an event** | 411-436, 637-641 | the School must reach everyone or not publish |

## 2. Two axes: audience and dependencies (C2)

### 2.1 The axes and their panels

| Axis | Question | Stored in | Panel on `/admin/spaces` | Who writes it |
| --- | --- | --- | --- | --- |
| **Audience** | who SEES the entity | `association_audiences` (unchanged) | **"Audience"**: today's grid, kept | the platform admin; the entity's governor within its own spaces (2.6) |
| **Dependencies** | who GOVERNS it: validates, manages, moderates | `associations.parent_id` (NULL allowed) for entities; `spaces."bdeAssociationId"` for spaces, now called the space's **governor** | **"Dépendances"**: a tree - each governor with the spaces and entities under it, the entities with no parent apart | the platform admin only, journaled (A4) |

### 2.2 One parent (a tree), not several

| Option | Validation | Moderation | Verdict |
| --- | --- | --- | --- |
| **A. One parent per entity: a tree** (recommended) | one governor answers for the entity; G1's "origin alone" holds by construction | one moderator per item, no conflicting decisions | deterministic, explainable in one sentence, and a cycle is refused on write (an entity cannot depend on its own descendant) |
| B. Several parents (a graph) | who validates - any, all, a quorum? Any reintroduces P1 under another name; all creates a queue nobody owns | two moderators may disagree on one item, and nothing arbitrates | rejected: it is today's defect with a panel on it |

Institutions "higher" (C2) fit the tree directly: the School may be the parent of BDEs and of
associations; a BDE the parent of its associations and lists. What a parent's power reaches -
its direct children only, or every descendant - is **question 2**; the recommendation is direct
children only, so each entity has exactly one governor and the platform admin stays the only
authority above everything.

### 2.3 What a parent governs, and how `holdsBdeFlagOver` changes

**The three super-permissions follow the dependency axis, never the audience:**

| Flag | Held in | Over |
| --- | --- | --- |
| `VALIDATE_EVENTS` | the governor of a SPACE | the event slices of that space (section 4) |
| `MANAGE_ASSO` | the PARENT of an entity | that entity's administration (members, documents, forms, products), minus `SUPER_ADMIN_EXCLUDED_FLAGS`; for an institution, NOT its members (G6) |
| `MODERATE` | the PARENT of an entity, or the governor of the author's space for a personal item | that entity's posts, comments, lives (2.7) |

An entity with no parent (B2) is governed by the platform admin alone. These flags take effect in
ANY entity that is a parent or a governor - a BDE as today, and an institution once it is one;
`isBdeAssociationSql` becomes "governs at least one space or is the parent of at least one entity",
which is what the routes naming no association ask (creating one, the categories, the carte).

**`holdsBdeFlagOverSql(user, association, flag)`** (`spaces/bde.ts:35-41`) stops joining
`association_audiences` and becomes **`holdsParentFlagOverSql`**:

```sql
EXISTS (SELECT 1 FROM associations gov_child
  JOIN association_members gov_m ON gov_m."associationId" = gov_child.parent_id
  WHERE gov_child.id = ${association}
    AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0)
```

(with descendants, question 2, a recursive CTE over `parent_id`). Its callers keep their names;
`mayValidateEventsOf` moves to the per-slice predicate of section 4:

```sql
-- U holds F in the governor of space S
EXISTS (SELECT 1 FROM spaces gov_s
  JOIN association_members gov_m ON gov_m."associationId" = gov_s."bdeAssociationId"
  WHERE gov_s.id = ${space} AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0)
```

Both are one join on an indexed key: cheaper than today's rule matching.

### 2.4 Spaces sit on the dependency axis too

A space's governor is the entity its `bdeAssociationId` names - **an association (a BDE) or, newly,
an institution** (P10): a formation with no BDE can be placed under the School, whose validators then
answer for it. A space with no governor is the platform admin's (question 3).

### 2.5 Correlated, never coupled

- **Defaults derive from the parent.** At creation the parent is the creating entity (B1: the BDE
  the creator acts from; a creator holding `MANAGE_ASSO` in two picks one; a platform admin creating
  picks one or leaves none). The default AUDIENCE is the spaces the parent governs (as the smallest
  rule set, `smallestRules`); if it governs none (an institution parent), the parent's own audience.
  Closes P4.
- **No silent change.** Changing a parent never writes an audience; changing an audience never
  changes a governor. `setBde` stops inserting a rule and `setAudiences` stops re-adding governed
  spaces (both in `spaces.service.ts`), amending the 2026-10-04 "a BDE always reaches what it
  governs" into a default plus a mismatch.
- **Mismatches are information.** Both panels flag, without refusing: an entity whose audience
  reaches a space whose governor is not its parent; an entity whose parent governs none of its
  audience; a space governor that does not reach the space it governs.
- **A2 under decoupling - question 1.** Recommended: **a rule for the governors, freedom for the
  platform admin.** A parent writing a child's audience stays bounded to the spaces it governs (2.6),
  so a BDE can never address another BDE's spaces on its own; the platform admin may write any
  audience, and a mismatch it creates is shown, never refused. Existing wider audiences stay (A2).
  The alternatives: a default plus a warning for everyone (lets a BDE address the other BDE's
  students), or a rule for everyone including the admin (forbids the cases C2 wants possible).

### 2.6 The governor's audience bounds, per space (A3, closes P3)

- `BDE_GOVERNED_CAMPUSES_SQL` becomes **`GOVERNED_SPACES_SQL`**: the spaces whose governor U holds F
  in.
- A rule is **inside** those spaces when every space it reaches is in them; a whole-campus rule is
  inside only for a governor of every formation of that campus (the four-formation BDE writes four
  pair rules, the editor doing it for it).
- A non-admin may read and write an entity's audience only when they hold `MANAGE_ASSO` in its
  PARENT, and only inside the parent's governed spaces. Before `parent_id` exists, the bound is
  "current AND submitted rules inside the caller's governed spaces" (WP-R1).
- The presets offered to a governor: "all of our spaces" / "some formations among them". The grid
  stays the platform admin's (the Audience panel).

### 2.7 Moderation (G2, B5) and the other governors (B3)

| Content | Moderated by |
| --- | --- |
| an entity's post, comment, live | `MODERATE` in its parent; no parent: platform admin |
| a personal post, comment, live | `MODERATE` in the governor of the AUTHOR's space; an author under two governors, either (B5) |
| a report | the moderator of the reported content; the queue is filtered accordingly |
| muting a user | the governor of one of that user's spaces |

`canManage` loses the moderator tier (G3): hide and delete, never edit; `canPin` and
`canUnmaskAnonymous` follow the table.

Any governor other than the parent **sees** the entity like any reader, **proposes** a republication
(D38) or a co-organisation (D39), and **validates or manages nothing** of it - except the slice of an
event shown in its own spaces (section 4).

### 2.8 Setting the dependencies, and the migration by hand (B1, A4)

- Only the platform admin changes a parent or a space governor, on the Dependencies panel; each
  change writes an append-only `dependency_journal` line (`subject_kind` entity|space, `subject_id`,
  `from_id`, `to_id`, `actor`, `at`) in the same transaction - the shape of `read_grant_journal`
  (migration 078); account deletion anonymises the actor as WP-C does.
- **Existing entities start with no parent and are set by the owner by hand.** The governance switch
  (WP-D2) ships when the owner says they are set; until then the current predicate stays.
- **Read-only counts for the owner** (aggregates; no agent runs them against production):

```sql
-- Entities by type and number of distinct space governors their audience reaches (the hand work).
SELECT type, n_gov, count(*) FROM (
  SELECT a.id, a.type, count(DISTINCT s."bdeAssociationId") AS n_gov
  FROM associations a
  LEFT JOIN association_audiences r ON r."associationId" = a.id
  LEFT JOIN spaces s ON (r.formation IS NULL OR r.formation = s.formation)
                    AND (r.campus IS NULL OR r.campus = s.campus)
  GROUP BY a.id, a.type) x
GROUP BY type, n_gov ORDER BY 1, 2;

-- Spaces with no governor.
SELECT count(*) FROM spaces WHERE "bdeAssociationId" IS NULL;

-- Once parent_id exists: entities still without a parent, by type.
SELECT type, count(*) FROM associations WHERE parent_id IS NULL GROUP BY type;

-- Once parent_id exists: mismatches - entities reaching a space their parent does not govern.
SELECT count(DISTINCT a.id) FROM associations a
JOIN association_audiences r ON r."associationId" = a.id
JOIN spaces s ON (r.formation IS NULL OR r.formation = s.formation)
             AND (r.campus IS NULL OR r.campus = s.campus)
WHERE a.parent_id IS NOT NULL AND s."bdeAssociationId" IS DISTINCT FROM a.parent_id;
```

## 3. Per-item audience, for institutions only (C1)

**An institution's post or event may NARROW the institution's audience, never widen it.**
Associations and lists always publish to their entity's audience; the DTO refuses an item audience
for them, and the composer does not offer it.

- **Storage**: `post_audiences(post_id, formation | NULL, campus | NULL)` and
  `association_calendar_event_audiences(event_id, ...)`, the shape of `association_audiences`. **No
  row = the whole entity audience**: every existing item, and every item nobody narrows.
- **Structural, never a stored copy**: the item's rules are AND-ed with the entity's reach at READ
  time, so an item can never reach a space its entity does not; if the entity's audience shrinks,
  the item shrinks with it and its now-outside rows are inert. The write refuses rules outside the
  entity's current audience (`AUDIENCE_OUTSIDE_ENTITY`).
- **History**: D33 built per-post rules and D38 dropped them (2026-10-04) so that only a
  republication widens; narrowing keeps that rule intact (G4).

| Topic | Rule |
| --- | --- |
| Members (D21) | a member of the institution sees every item of it; the narrowing applies to the space branch |
| Read grants (WP-C) | a grant reaches a narrowed item only when its cell meets the ITEM's rules too (the AND in `readGrantReachesAssociationSql`) |
| Republication (D38) | the narrowing restricts the institution's own branch; a republication reaches the republisher's readers, as its admins accepted (G4) |
| Co-organisation (D39) | an institution's event narrows the union ceiling (section 4.1) |
| Per-slice validation | the slices are cut from the narrowed spaces only; a governor left out is never asked |
| Announcements | `announceRecipientsSql` reads the same predicate: a narrowed post notifies only whom it reaches |
| Anonymous agenda, `.ics` | the selection applies the narrowed spaces |
| Edits after publication | editable by whoever may edit the item; visibility follows at the next read; newly reached readers are not re-notified; logged; for an event, the slices whose spaces changed re-open (question 4) |
| Feed cache | an item audience edit drops it, as `setAudiences` does |
| Composer | a **"Visible par"** picker on the institution's composer and event form, defaulting to "Toute l'audience de X", chips per space grouped by governor; hidden when the institution reaches one space; labels through Paraglide |
| Cost | one `NOT EXISTS (row) OR EXISTS (row reaching a reader space)` per candidate, indexed by `post_id` / `event_id`; for the no-row majority, one empty index probe - the shape WP-C measured at +10 % on the feed predicate ([WP-C](profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)). `EXPLAIN (ANALYZE, BUFFERS)` before/after owed with WP-I |

## 4. Events validated per audience slice (B6)

### 4.1 The model

- **An event's ceiling** is the union of its organiser's audience and each ACCEPTED co-organiser's
  (today's reach). An institution's event may narrow it (section 3); an association's or list's
  event uses it whole.
- **Its spaces are cut into SLICES, one per space GOVERNOR** (2.4): the four-formation BDE decides
  once for its four spaces; the School decides for a formation placed under it; spaces with no
  governor form one slice, the platform admin's (question 3).
- **Who validates a slice is the governor of its spaces, NOT the event entity's parent.** The two
  coincide in the correlated case (an association under BDE X addressing X's spaces has one slice,
  X's - today's single validation); they differ only on a mismatch, a co-organisation or an
  institution, and then each governor answers for its own students, which is what B6 asks.
- **Each slice has its own decision**: `association_calendar_event_validations(event_id,
  governor_id | NULL, status, decided_by, decided_at, reason)`, unique per `(event_id, governor)`.
  `VALIDATE_EVENTS` holders of that governor decide it (the second predicate of 2.3).
- **The event appears in a space once that space's slice is validated.** Reader rule: a member of
  the organiser or an accepted co-organiser (D21), OR one of their spaces is among the event's
  spaces AND its slice is `validated`. Same rule for the anonymous selection, the `.ics` and a read
  grant's spaces.
- **Nothing is auto-validated** (user, 2026-09-14): every slice starts `pending`.

### 4.2 How it fits the rest

| Topic | Rule |
| --- | --- |
| Co-organisation (D39) | an acceptance widens the ceiling and opens a `pending` slice per NEW governor; decided slices are untouched. A co-organiser leaving deletes the slices left with no space, logged |
| Republication (D38) | concerns posts: republishing a post announcing an event opens no slice |
| Partly validated | the organiser's people see one status per slice ("Validé : X - En attente : Y - Refusé : Z, motif"); a reader sees the event only in validated slices, nothing about the others; by link, a 404 outside any validated slice and membership |
| Summary `status` | kept, derived in the same transaction: `validated` if any slice is, `rejected` if all are, `pending` otherwise; no reader path decides on it |
| Notifications | each new slice notifies ITS governor's validators (`notifyEventValidatorsOfProposal` per slice); the no-governor slice the platform admins; each decision the organiser's admins, naming the slice. A governor is never told of an event outside its spaces |
| Edits after validation | question 4; recommended: a DATE move re-opens every slice (today's rule, 2563-2627, per slice), an audience change only the slices whose spaces changed, text changes nothing |
| Declining, deleting | a governor DECLINES its slice with an optional reason and never deletes the event (B3); deletion stays with the organiser's people, its parent and the platform admin |
| Breaks (`kind = 'break'`) | declared by a validator on its own spaces; one slice |

### 4.3 Existing events - a plan, owner's yes

No audience row (= the whole ceiling, today's reach) and one slice per governor that ceiling
reaches, plus the no-governor slice, **each copying the event's current status**: on the day of the
switch every reader sees exactly what they see today. A data migration: the owner's yes.

### 4.4 Cost

The agenda predicate gains a join on the event's validations (and, for an institution, its audience
rows), all keyed by `event_id`. `EXPLAIN` before/after on production-sized data is owed with WP-E.

## 5. Other simplifications considered

- **Is "formation x campus" the right unit?** Yes, for reading and for governing spaces (A1, A3).
  The `spaces` table stays; `openedAt` and the "OPEN spaces" wording go (WP-R5).
- **Audience shape**: keep the rule rows (no predicate rewrite; the item audience reuses them).
  A formation list per entity or one cell type shared with `read_grants` both cost a migration of
  every predicate for no reader-visible gain.
- **The review cohort** stays outside the model: it also seals messaging, search, calls and the
  people directory, which spaces do not bound (52 call sites in 13 files today), and a fake space
  would leak into every `CHECK` and picker
  ([review cohort](profiles-and-access.md#the-review-cohort---store-reviewers-in-a-world-of-their-own-2026-10-31)).
- **Staff with no cursus**: `campusWideReaderCampus` is a decision (D34-D36), left as is.

## 6. Target and path

**Target.** Two panels. Audience: who sees, today's grid, a governor bounded to its spaces, the
admin free. Dependencies: a tree in which every entity has at most one parent and every space at
most one governor, set by the platform admin alone with a journal, the creating entity by default;
the parent manages and moderates its children, the space governor validates event slices and
moderates personal content of its students, the platform admin governs whatever has no parent.
Defaults correlate the axes, panels show mismatches, nothing couples them. Institutions may narrow
an item; events are validated slice by slice. Moderators hide and delete, never edit.

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | Institutions excluded from the super-admin's member management (G6); the moderator's EDIT removed (G3) | two predicates; closes P7, P8 | none |
| **WP-R1** | Audience bounds per SPACE (`GOVERNED_SPACES_SQL`, read/write/create) | server checks; closes P3 now | none |
| **WP-D1** | The dependency axis: `associations.parent_id` (cycle refused), a space governor may be an institution, `dependency_journal`; the Dependencies panel (tree, mismatches) beside the Audience panel; the default parent and the parent-derived default audience at creation; `setBde` and `setAudiences` stop writing each other's axis; nothing reads `parent_id` for governance yet | additive; the owner then sets parents by hand; closes P2, P4, P10 | **schema: owner's yes** (no back-fill) |
| **WP-D2** | Governance switched to the dependency axis: `holdsParentFlagOverSql` for `MANAGE_ASSO`, no parent = platform admin; the governor-bounded audience writes of 2.5 | ships when the owner says the parents are set; closes P1, P5, P9 | none |
| **WP-R4** | `MODERATE` scoped by 2.7 | needs WP-D2; closes P6 | none |
| **WP-I** | Institution item audience (section 3) | additive, institutions only; closes P12 | **two tables: owner's yes** |
| **WP-E** | Events per slice (section 4): the validations table, the space-governor predicate, both agendas and the `.ics`, per-slice notifications, edit and decline rules, the per-slice view, the derived status, `EXPLAIN` | needs WP-D1 (space governors) and, for institutions, WP-I; closes P11 | **one table + the event migration of 4.3: owner's yes** |
| **WP-R5** | Governor presets; `openedAt` and "OPEN spaces" removed | cosmetics | dropping `openedAt`: owner's yes |

Each WP changes its tests (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`,
`associations.service.never-auto-validates.spec.ts`,
`associations.service.revalidate-on-date-change.spec.ts`, the agenda and moderation specs) and
updates [profiles-and-access](profiles-and-access.md) (D22, D23, D33, D39 amended) and
[calendar](frontend/modules/calendar.md).

## 7. Questions for the owner (fourth round)

1. **Une association ou une liste doit-elle rester dans les espaces de l'entité dont elle dépend ?**
   - (Recommandé) Oui quand c'est son BDE (ou son institution) qui règle son audience : il ne peut choisir que parmi ses propres espaces. L'admin plateforme, lui, peut tout régler ; un écart est alors signalé dans les deux panneaux, sans être bloqué. Les audiences plus larges qui existent déjà restent.
   - Non, ce n'est qu'un réglage par défaut avec un avertissement, pour tout le monde (un BDE pourrait alors viser les étudiants d'un autre BDE).
   - Oui pour tout le monde, admin plateforme compris, sans exception.
2. **Le pouvoir d'une entité parente s'arrête-t-il à ses enfants directs ?**
   - (Recommandé) Oui : l'École gère les BDE qui dépendent d'elle, mais pas les associations qui dépendent de ces BDE ; chaque entité a un seul responsable, et l'admin plateforme reste au-dessus de tout.
   - Non : une entité gère toute sa descendance (l'École gère aussi les associations des BDE qui dépendent d'elle).
3. **Une formation qui n'a pas de BDE : qui valide les événements qui la visent ?**
   - (Recommandé) L'admin plateforme par défaut ; l'admin peut aussi la placer sous une institution (l'École, par exemple), qui valide alors pour elle.
   - Personne : l'événement n'y apparaît jamais.
   - Personne : il y apparaît sans validation (ce qui contredit la règle « jamais validé automatiquement »).
4. **Quand un événement déjà validé est modifié, qui doit le revalider ?**
   - (Recommandé) Changement de date : tous les responsables revalident. Changement d'audience : seuls ceux dont les formations changent. Titre, description, affiche : personne.
   - Toute modification remet l'événement en attente pour tous.
   - Seul le changement de date compte, comme aujourd'hui.

Settled by the answers, so not asked: the grid stays as the Audience panel (C2); item narrowing is
for institutions only (C1); a governor that does not want an event in its spaces declines its slice
and cannot delete the event (B3, B6); a republication of a narrowed post reaches the republisher's
own readers (G4).
