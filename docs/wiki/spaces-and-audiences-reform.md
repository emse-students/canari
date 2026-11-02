# Spaces, audiences and attachment - a reform proposal (2026-11-02)

**Status: PROPOSAL, revised three times the same day after the owner's answers (section 0). Nothing is
built.** Written for the owner to decide. It extends [profiles-and-access](profiles-and-access.md)
(D16-D41, the audiences chantier, WP-C read grants, WP-F5/F6) and does not restate it. Every
`file:line` is from `main` at the time of writing (`apps/social-service/src/` unless said
otherwise).

## 0. What prompted it, and what is already decided

The owner, asked on 2026-11-02 who validates content that crosses spaces, chose **"the BDE of
origin alone"** and added: *"Il faut effectivement peut-etre reflechir a des rattachements. Et
peut-etre reformer un peu les espaces/audiences, je ne sais pas si on peut ameliorer les choses..."*

The same day's audit and answers, taken here as GIVEN:

| # | Decision (owner, 2026-11-02) | What the code does today |
| --- | --- | --- |
| G1 | Content crossing spaces is validated by the BDE of origin ALONE - **amended for events by B6** | ANY BDE whose space the association reaches (section 1.3) |
| G2 | `MODERATE` is scoped to the spaces the BDE governs | global (D23): any BDE holding it moderates everything |
| G3 | Nobody edits another person's post | the moderator tier may edit any post (`posts/posts.service.ts:592-608`, `canManage`) |
| G4 | Republication stays THE inter-campus mechanism | it is (D38, D38b), beside co-organisation (D39) |
| G5 | Public data matches only what Portail-etu shows | out of this page's scope, quoted for completeness |
| G6 | An institution's members are managed by the platform admin only | a BDE holding `MANAGE_ASSO` manages them when the institution reaches its space (section 1.5) |
| G7 | A BDE secretary may place themselves in any association they govern | already true through the super-admin tier (`mayAct`, `associations/associations.service.ts:2018-2035`) |

**First round of answers (questions 1-4 of the first version):**

| # | Answer | What it changed |
| --- | --- | --- |
| A1 | **The campus is NOT the unit.** *"il peut exister plusieurs formations pour un campus, et un BDE par formation"* - the admin grid shows, on one campus, one BDE governing four formations and another BDE governing the fifth | the home is a **governing BDE** (section 2) |
| A2 | *"Non, sauf l'existant"*: an association or a list addresses only its home's reach; the other campus is reached by republication or co-organisation; existing wider audiences stay until their next modification | the invariant of 2.4 |
| A3 | A BDE is designated **per formation x campus**, as today | every BDE bound is stated per space (2.5) |
| A4 | **Only the platform admin changes an association's home, and every change is logged** | 2.2 |

**Second round of answers:**

| # | Answer | What it changed |
| --- | --- | --- |
| B1 | *"On va faire la migration a la main. Apres, ca peut etre un reglage a la main, comme le public, accessible des admins uniquement. Et par defaut evidemment le BDE qui la cree. (idem pour les listes)"* | no computed proposal, no back-fill, no confirmation list; the home is an admin-only setting on `/admin/spaces`; the default is the creating BDE (2.1-2.3) |
| B2 | *"on peut avoir une asso/liste/institution sans rattachement"* | an entity with NO home is governed by the platform admin alone (2.1) |
| B3 | Another BDE sees the association and proposes a republication or a co-organisation; it validates and manages nothing | 2.6 |
| B4 | An institution is governed by the BDE the admin attaches it to; with no home, by the platform admin | 2.1 - this REPLACES G6's "platform admin only" for an ATTACHED institution's governance; its MEMBERS stay the admin's (G6) |
| B5 | A personal post is moderated by the BDE governing the author's space; under two BDEs, either | 2.5 |
| B6 | **The agenda is revisited**: *"Quand l'ecole propose un evenement elle choisit son audience ? Chaque BDE pourrait valider ou non pour la formation dont il est le BDE ?"* | section 4: an event is validated per audience SLICE, each BDE for its own spaces |
| B7 | *"Comment une institution choisit l'audience d'un post ? D'une proposition d'evenement ?"* - it cannot today | section 3: a post or an event may NARROW its entity's audience, never widen it |

## 1. The current model

### 1.1 Spaces

- A **space** is one `formation x campus` pair (D16): `spaces/space.entity.ts:18-34`, five
  formations x two campuses (`SPACE_FORMATIONS`, `SPACE_CAMPUSES`, lines 4-6) = **10 rows**, all
  present since D17 was relaxed (2026-10-04). The `openedAt` column and the "OPEN spaces" wording
  in the predicates are vestiges of the opening step that no longer exists.
- A **reader's spaces** are the pairs whose campus is theirs and whose formation is one of their
  cursus formations: `isReaderSpaceSql`, `spaces/reader-spaces.ts:88-90` (pure twin
  `readerSpaces`, lines 52-63). No campus or no cursus = no space. Staff (campus, empty cursus) get
  the agenda of their campus through a special case, `campusWideReaderCampus` (lines 71-76).
- A space carries ONE optional BDE, `spaces."bdeAssociationId"` (`space.entity.ts:32-33`); the same
  association may be the BDE of several spaces (`migrations/071_spaces.sql`, the comment under the
  table), and in production one campus is split between two BDEs (A1). It is set on `/admin/spaces`
  by the platform admin (`spaces/spaces.controller.ts:23`, `GlobalAdminGuard`;
  `spaces/spaces.service.ts` `setBde`), which ALSO inserts an audience rule so the BDE reaches what
  it governs.

### 1.2 Audiences (reach)

- An association, list or institution addresses people through `association_audiences` rows
  `(formation | NULL, campus | NULL)`, NULL meaning "any" (`spaces/association-audience.entity.ts`,
  D19/D33). A rule reaches a space by `ruleReachesSpaceSql` (`spaces/rule-sql.ts:8-12`), resolved at
  read time, so a change applies to past posts too (decision 4 of the audiences chantier).
- **Policy** (`spaces/audience-policy.ts`): an `everyone` rule (campus NULL) is refused outside
  institutions (lines 42-51); the default at creation is the creator's campus, every formation
  (lines 58-68); a BDE "star" writes and reads the audience of entities whose rules sit inside the
  CAMPUSES it governs (lines 77-123); a non-admin creator must create on a governed campus
  (lines 131-141).
- **Visibility** of an association's content: a member (D21), OR its rules reach one of the
  reader's spaces, OR (read paths only) a nominative read grant meets its rules
  (`associationVisibleToUserSql`, `reader-spaces.ts:168-177`; grants lines 125-143). A personal post
  needs a SHARED space with its author (`sharesSpaceWithAuthorSql`, lines 232-237) or an accepted
  follow (WP-F5) or a consented repost (WP-F6).

### 1.3 BDE governance scope

- "Is a BDE" = designated on at least one space (`isBdeAssociationSql`, `spaces/bde.ts:14-16`).
- **The governance predicate** `holdsBdeFlagOverSql` (`spaces/bde.ts:35-41`): user U holds flag F
  in the BDE of ANY space that association A's audience rules reach. Read by `VALIDATE_EVENTS`
  (`mayValidateEventsOf`, `associations.service.ts:1832`, the pending queue at 2095-2112, the
  proposal notification at 2398-2420) and by `MANAGE_ASSO` (`isAssociationSuperAdminOf`, 1980,
  hence `mayAct` and `mayActOnAny`, 2018-2077).
- **The audience-write bound** uses a DIFFERENT granularity: `BDE_GOVERNED_CAMPUSES_SQL`
  (`spaces/bde.ts:47-49`) returns the CAMPUSES of the governed spaces, not the spaces.
- **`MODERATE` is not scoped at all**: `isContentModerator` asks "a BDE somewhere"
  (`associations.service.ts:1994-1998`, via `callerHasAnyBdeFlag`). 16 call sites ask an unscoped
  BDE question (`isContentModerator`, `callerHasAnyBdeFlag`, `isUserBdeAdmin`,
  `isAssociationSuperAdmin`): the moderation controller, lives, live chat, comment identity, posts.

### 1.4 Events and their validation

- An event is ONE row with ONE status, `pending | validated | rejected`
  (`associations/entities/association-calendar-event.entity.ts:3-7`), plus `validatedBy/At` and
  `rejectedBy/At/rejectionReason`.
- **It has no audience of its own**: it reaches the union of its organiser's audience and each
  ACCEPTED co-organiser's (`eventVisibleToUserSql`, `reader-spaces.ts:637-641`; D39). The signed-in
  agenda filters with it (`restrictToViewerSpaces`, `associations.service.ts:1678-1688`); the
  anonymous agenda narrows by a selection through `eventReachesSpaceMatchingSql`
  (`reader-spaces.ts:204-212`, `restrictToSelection`, `associations.service.ts:1694-1711`).
  Readers see `validated` only; the proposers also see `pending`, the editor view `rejected`
  (`associations.service.ts:1617-1622`).
- **Creation is always `pending`**, the platform admin and a BDE included (user, 2026-09-14,
  `createCalendarEvent`, `associations.service.ts:2453-2503`; spec
  `associations.service.never-auto-validates.spec.ts`).
- **Validation and rejection** set the one status (`validateCalendarEvent` 2697-2712,
  `rejectCalendarEvent` 2715-2741; routes `associations.controller.ts:1029`, `:1045`), allowed to
  `mayValidateEvent` - the platform admin, or `VALIDATE_EVENTS` in ANY BDE the ORGANISER's audience
  reaches (`associations.service.ts:1832-1866`). A co-organiser's audience widens the reach but
  routes NO validator.
- **Editing**: a move of the DATES returns a validated event to `pending`; a title, description,
  poster or form does not (`updateCalendarEvent`, `associations.service.ts:2545-2627`; spec
  `associations.service.revalidate-on-date-change.spec.ts`).
- **Deletion**: the organiser's people, or a governing BDE / the platform admin across associations
  (`deleteCalendarEvent`, `associations.service.ts:2748-2780`).
- **Notifications**: a proposal notifies the `VALIDATE_EVENTS` holders of every governing BDE
  (`notifyEventValidatorsOfProposal`, `associations.service.ts:2409`); a decision notifies the
  organiser's admins (`notifyAssocAdminsOfEventAction`, 2362).
- The agenda pages and their deposit rules: [calendar](frontend/modules/calendar.md#who-may-deposit-from-the-global-agenda-and-whose-id-carries-the-right).

### 1.5 Pain points and inconsistencies, measured from the code

| # | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| P1 | **Reach decides governance.** There is no "home": the BDE that governs an association is whichever BDE its audience happens to reach | `bde.ts:35-41` joins `association_audiences` | an association reaching two BDEs' spaces is validated, managed and administered by EITHER - contrary to D22 ("the BDE of the ORIGIN association") and to G1 |
| P2 | **Editing an audience silently moves governance.** Removing a space from the rules removes that BDE's power; adding one grants it | `spaces.service.ts:224-258` (`setAudiences`), `setBde` inserts a rule | a governance change is a side effect of a visibility change, logged as an audience edit |
| P3 | **Two granularities for one question - and the split campus makes it live (A1).** Validation and management are per SPACE; the audience-write, audience-read and creation bounds are per CAMPUS | `bde.ts:35-41` vs `bde.ts:47-49`; `audience-policy.ts:77-141` | on the split campus each of the two BDEs may read and rewrite the audience of the other's associations, and by P2 take governance of them |
| P4 | **The default audience crosses BDE borders.** A new association or list gets `(NULL, creator's campus)` - every formation of the campus | `audience-policy.ts:58-68`, written by `associations.service.ts:565` | on the split campus every association created since WP-A reaches BOTH BDEs' spaces, so BOTH govern it (P1) - from the day of its creation |
| P5 | **Decision 3 is enforced half-way.** "An association on two campuses is TWO associations" - but the server refuses only campus-NULL rules; a global admin writing `(NULL, saint-etienne)` + `(NULL, gardanne)` passes | `audience-policy.ts:42-51` checks `campus === null` only | multi-campus associations can still be created by the grid, and legacy ones remain (WP-A left existing rows "until someone edits that entity") |
| P6 | **`MODERATE` is global** (D23) while G2 wants it scoped | `associations.service.ts:1994-1998` | any BDE moderates, pins and unmasks the anonymous posts of every other (`posts.service.ts:606-608`, `canPin`, `canUnmaskAnonymous`) |
| P7 | **The moderator tier edits others' posts** | `posts.service.ts:605`: `canManage: isModeratorTier \|\| isPublisher` | contradicts G3 |
| P8 | **Institutions fall under the BDE super-admin tier.** `holdsBdeFlagOver` never looks at the type, so a BDE holding `MANAGE_ASSO` manages the members of an institution whose rules reach its space | `mayAct` 2018-2035 -> `isAssociationSuperAdminOf` 1980 | contradicts D20 and G6; the AUDIENCE of an institution is refused to the star (`audience-policy.ts:97-102`), its MEMBERS are not |
| P9 | **No rule = no governor.** An entity with no audience row is governed by nobody but the platform admin, and invisible except to its members | `bde.ts:28-29` comment; WP6e (a new institution has no rule) | an institution's events reach no validator |
| P10 | **The fine grid can express what no preset can.** The admin grid (`smallestRules`, `spaces.service.ts:70-90`) writes any set of pairs; the editor then reports it as "custom" | WP-B notes | two sources of truth for one shape; a custom audience may straddle BDEs (P1) |
| P11 | **One validation for many audiences.** An event carries ONE status, granted by ANY one governing BDE, and is then shown in EVERY space its organiser and co-organisers reach | `association-calendar-event.entity.ts:3-7`; `mayValidateEventsOf` 1832; `eventVisibleToUserSql` 637-641 | the School's event validated by one BDE appears in the other BDE's spaces with no say from it (the case B6 names); a co-organiser's BDE never sees the event it will be shown in |
| P12 | **A post or an event cannot choose its audience.** Its reach is its entity's (or its organisers') whole audience; an institution addressing everyone cannot announce something to one formation | `postVisibleToUserSql` (`reader-spaces.ts:411-436`, "a post has no rules of its own any more (D38)"); `eventVisibleToUserSql` ("an event has no space rules of its own") | the School must either reach everyone or not publish |

## 2. Attachment ("rattachement") to a governing BDE

**Every association, list and institution has AT MOST ONE home BDE (`home_bde_id`), the
association designated as BDE of one or more spaces (A1, A3).** With a home, that BDE governs the
entity: validates its events for its own spaces (section 4), administers it (`MANAGE_ASSO`),
moderates its content (`MODERATE`, G2). **With no home (B2), the platform admin alone governs it.**
The home is a column on `associations`, never derived from the audience.

### 2.1 What the home is, and who governs what

- **The home points at the BDE association itself** (`home_bde_id -> associations.id`), not at a
  space: a BDE governing four formations is ONE home, with no arbitrary pick among its spaces.
- **Associations and lists**: governed by their home BDE; with no home, by the platform admin.
- **Institutions (B4)**: governed by the BDE the admin attaches them to (event validation,
  moderation); with no home, by the platform admin. **Their MEMBERS stay the platform admin's in
  every case (G6)** - the super-admin tier excludes `type = 'institution'` from member management
  whatever the home (closes P8).
- **When a BDE loses its last space** (the admin redesignates): its attached entities are governed
  by nobody but the platform admin (the predicate of 2.4 requires the home to govern a space), and
  `setBde` logs at warn how many entities that left attached to a BDE that governs nothing. Nothing
  is moved silently and no refusal blocks the redesignation.

### 2.2 How the home is set (B1, A4)

- **At creation: the creating BDE**, for an association and a list alike. Creation by a non-admin is
  already reserved to a BDE holding `MANAGE_ASSO` (`assertCreatorCampusGoverned`,
  `audience-policy.ts:131-141`, called at `associations.service.ts:565-574`); the home is THAT BDE.
  A creator holding `MANAGE_ASSO` in two BDEs picks one on the creation form. **A platform admin
  creating** leaves the home empty unless they pick one; an institution starts with no home, as it
  starts with no rule (WP6e).
- **Afterwards: an admin-only setting**, edited like the audience on `/admin/spaces` (a "Rattachement"
  column beside the grid), and on the entity's admin edit tab. No BDE and no association officer can
  change it.
- **Every change is journaled**: an append-only `association_home_journal` line (`association_id`,
  `from_bde`, `to_bde`, `actor`, `at`), the shape `read_grant_journal` already has (migration 078,
  WP-C), written in the same transaction. Account deletion anonymises the actor as WP-C does.

### 2.3 Existing entities - set by hand (B1)

**No computed proposal, no back-fill, no confirmation list.** The owner sets the existing homes by
hand on `/admin/spaces` once the column and the setting exist (WP-R2). Every existing entity starts
with NO home - governed by the platform admin - until he sets it, so **the governance switch (WP-R3)
ships only when the owner says the homes are set**; before that, the current predicate stays.

**For information only, read-only and aggregate** (no agent runs it against production; the result
sizes the hand work):

```sql
-- How many entities reach the spaces of 0, 1 or 2 distinct BDEs, by type.
SELECT type, n_bde, count(*) FROM (
  SELECT a.id, a.type, count(DISTINCT s."bdeAssociationId") AS n_bde
  FROM associations a
  LEFT JOIN association_audiences r ON r."associationId" = a.id
  LEFT JOIN spaces s ON (r.formation IS NULL OR r.formation = s.formation)
                    AND (r.campus IS NULL OR r.campus = s.campus)
  GROUP BY a.id, a.type) x
GROUP BY type, n_bde ORDER BY 1, 2;

-- How many entities carry a whole-campus rule (P4's default, the two-BDE case on the split campus).
SELECT count(DISTINCT r."associationId") FROM association_audiences r
WHERE r.formation IS NULL AND r.campus IS NOT NULL;

-- Once the column exists: how many entities still have no home, by type.
SELECT type, count(*) FROM associations WHERE home_bde_id IS NULL GROUP BY type;
```

### 2.4 Reach and governance become two concepts

| Concept | Question it answers | Stored in | Who writes it |
| --- | --- | --- | --- |
| **Home** (governance) | who validates, administers, moderates | `associations.home_bde_id`, NULL allowed | the creating BDE at creation; afterwards the platform admin only, journaled |
| **Audience** (reach) | who sees it | `association_audiences` | the home BDE (inside its own spaces) or the platform admin |

**Invariant for an ATTACHED association or list (A2): every space its audience reaches is governed
by its home BDE.** Checked on every audience WRITE (a new typed code, `AUDIENCE_OUTSIDE_HOME`);
legacy rows that break it stay until the entity's next edit, and the editor shows the out-of-home
part as what the save will drop. Crossing to another BDE's spaces - the other campus, or the other
BDE of the same campus - is republication or co-organisation (G4). **An entity with no home** has no
BDE bound: only the platform admin edits its audience. **An institution** may reach anything (an
everyone rule, two campuses), attached or not.

**The default audience at creation** becomes **every space governed by the home BDE** (written as
the smallest rule set, `smallestRules`: a whole-campus rule only when that BDE governs the whole
campus). Closes P4.

**The governance predicate becomes** (sketch, not code):

```sql
-- user U holds flag F in the BDE governing association A
EXISTS (SELECT 1 FROM associations gov_a
  JOIN association_members gov_m ON gov_m."associationId" = gov_a.home_bde_id
  WHERE gov_a.id = A
    AND gov_m."userId" = U AND (gov_m.permissions & F) <> 0
    AND EXISTS (SELECT 1 FROM spaces gov_s WHERE gov_s."bdeAssociationId" = gov_a.home_bde_id))
-- plus, for MANAGE_ASSO's member management only: AND gov_a.type <> 'institution'   (G6)
```

No rule matching, one row per association: simpler and cheaper than `bde.ts:35-41`. A NULL home
matches nothing, so only the platform admin (whom every caller checks first) acts.

### 2.5 The BDE bounds per space (A3, closes P3), and moderation (G2, B5)

With a BDE per formation x campus, every BDE bound is stated in SPACES:

- `BDE_GOVERNED_CAMPUSES_SQL` is replaced by **`BDE_GOVERNED_SPACES_SQL`**: the `(formation,
  campus)` pairs whose BDE U holds F in.
- A rule is **inside** a set of governed spaces when EVERY space it reaches is in the set - so a
  whole-campus rule `(NULL, campus)` is inside only for a BDE governing every formation of that
  campus; the four-formation BDE writes four pair rules (the editor does it for it).
- **Audience read and write**: before the home exists (WP-R1), current AND submitted rules must be
  inside the caller's governed spaces; once it exists (WP-R3), the bound is **the caller holds
  `MANAGE_ASSO` in the entity's home BDE**, and the submitted rules must be inside the home's spaces.
  A BDE never reads or writes the audience of another BDE's association, whatever campus they share.

**Moderation scope:**

| Content | Moderated by |
| --- | --- |
| an attached association's, list's or institution's post, comment, live | its home BDE |
| the same, with no home | platform admin only |
| a personal post, comment, live | the BDE governing the AUTHOR's space; an author under two BDEs, either (B5) |
| a report | the moderator of the reported content, by the rows above; the queue is filtered accordingly |
| muting a user | the BDE governing one of that user's spaces |

`canManage` loses the moderator tier (G3): a moderator HIDES or DELETES, never edits.
`canUnmaskAnonymous` and `canPin` follow the table above.

### 2.6 How the other BDEs relate (B3)

Every BDE other than the home - of the other campus, or of the other formations of the same campus:

- **sees** the association like anyone its audience reaches;
- **proposes** a republication into one of its own associations (D38) or a co-organisation (D39);
- **validates and manages nothing** of it - except the slice of an EVENT shown in its own spaces
  (section 4), which is the only place B6 lets a second BDE decide.

## 3. Per-item audience: a post or an event narrows its entity's audience (B7)

**Today a post or an event cannot choose who sees it.** An association post is visible when its
association is (`postVisibleToUserSql`, `reader-spaces.ts:411-436`: *"A post has no rules of its
own any more (D38)"*); an event when its organiser or an accepted co-organiser is
(`eventVisibleToUserSql`, `reader-spaces.ts:637-641`: *"an event has no space rules of its own"*).
So the School, addressing everyone, cannot announce something to the ICM students only.

**History - this was built once and removed.** D33 (2026-10-04) gave a post its own rules inside its
entity's ceiling (`post_audiences`); D38 dropped them the same day (migration
`073_republications.sql`; [profiles-and-access](profiles-and-access.md#d38-republication-as-built-2026-10-04))
so that **a post's audience widens only through a republication**. What follows keeps that rule
intact: an item can only NARROW, never widen, so republication remains the one widening path (G4).

### 3.1 The rule

- **An entity's post or event MAY carry its own audience rules**, in the shape and NULL convention
  of `association_audiences`: `post_audiences(post_id, formation | NULL, campus | NULL)` and
  `association_calendar_event_audiences(event_id, ...)`. **No row = the entity's whole audience**,
  which is every existing item and every item nobody narrows.
- **Narrowing is structural, never a stored copy.** The item's own rules are AND-ed with the
  entity's reach at READ time: a reader is reached through the entity's branch when the entity
  reaches one of their spaces AND (the item has no rule OR one of its rules reaches one of those
  spaces). An item therefore can never reach a space its entity does not, whatever its rows say; if
  the entity's audience later shrinks, the item shrinks with it, and its now-outside rows are inert,
  not rewritten. The write path refuses rules outside the entity's current audience anyway
  (`AUDIENCE_OUTSIDE_ENTITY`), so an author is never shown a choice that does nothing.
- **Personal posts are not concerned**: a personal post's reach is its author's spaces, followers
  and member reposts (WP-F5, WP-F6); the DTO refuses an audience on it.

### 3.2 How it fits the rest

| Topic | Rule |
| --- | --- |
| **Members (D21)** | a member of the entity still sees every item of it: the narrowing applies to the space branch only. Members are the entity's own people; hiding its own post from them would be a surprise, not a privacy |
| **Read grants (WP-C)** | a grant reaches a narrowed item only when its cell meets the ITEM's rules too: a reader granted ISMIN does not read a School post narrowed to ICM. Same AND, spliced in `readGrantReachesAssociationSql` |
| **Republication (D38)** | the republisher's branch stays independent: a republication reaches the republisher's own readers, as accepted by the republisher's admins. **The narrowing restricts the ORIGINAL entity's branch, not a republication** - widening is exactly what republication is for (G4), and it already needs the receiving side's acceptance |
| **Co-organisation (D39)** | an event's ceiling is the union of its organiser's and accepted co-organisers' audiences (section 4.1); its rules narrow that union |
| **Per-slice validation (section 4)** | an event's spaces are its narrowed audience; slices are cut from those spaces only, so a BDE whose spaces the event left out is never asked |
| **Announcements** | `announceRecipientsSql` reads the same predicate, so a narrowed post notifies only the readers it reaches - no second rule |
| **Anonymous agenda, `.ics` (D40)** | the selection applies the event's narrowed spaces |
| **Edits after publication** | the audience of a post or an event is editable by whoever may edit it (the publisher's `POST_AS_ASSO`, the event's writers); visibility follows at the next read (decision 4 of the audiences chantier). Readers newly reached by a widening (within the entity) are NOT re-notified - an edit is not a publication - and the change is logged. For an event, an audience change re-opens the slices whose spaces changed (question 3) |
| **The feed cache** | an item audience edit drops the post list cache, as `setAudiences` does |

### 3.3 The composer

A **"Visible par"** picker on the post composer and the event form, **defaulting to the entity's
whole audience** ("Toute l'audience de X"). It lists the spaces the entity reaches as chips
(formation x campus), grouped by BDE so that a narrowing that drops a BDE's spaces is visible as
such; it is NOT shown when the entity reaches a single space. Every label through Paraglide.

### 3.4 Cost

One extra term per candidate row: `NOT EXISTS (item rule) OR EXISTS (item rule reaching a reader
space)`, keyed by an index on `post_id` / `event_id`. For the overwhelming majority (no row) it is
one index probe that finds nothing - the same shape WP-C measured for read grants: +10 % on the feed
predicate (600 -> 670 ms on the synthetic 50,000-post set,
[WP-C](profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)). The `EXPLAIN
(ANALYZE, BUFFERS)` before/after on the same synthetic set is owed with WP-I, and the index is kept
only if the planner uses it.

### 3.5 Scope

Who may narrow is **question 4**: every entity (institutions, associations, lists), or institutions
only. The mechanism is the same either way; the scope is a DTO check and whether the picker renders.

## 4. Events validated per audience slice (B6)

### 4.1 The model

- **An event chooses its audience** by the per-item rule of section 3, inside a **ceiling** that is
  the union of the organiser's audience and each ACCEPTED co-organiser's - today's reach
  (`eventVisibleToUserSql`), so nothing an event could reach is widened. No row = the whole ceiling,
  so an event nobody narrows behaves as today. An institution addressing everyone (the School) can
  now propose an event for one formation (closes P12).
- **The event's SPACES** are the spaces of its ceiling that its own rules (if any) reach. **They are cut into SLICES, one
  per BDE** governing at least one of them (`spaces."bdeAssociationId"`): the four-formation BDE
  decides once for its four spaces, not four times. Spaces with no BDE form one more slice, decided
  by the platform admin (question 2).
- **Each slice has its own decision**, in a new `association_calendar_event_validations(event_id,
  bde_association_id | NULL, status, decided_by, decided_at, reason)`, unique per
  `(event_id, bde)`. A BDE's `VALIDATE_EVENTS` holders validate or decline ITS slice only.
- **The event appears in a space once that space's slice is validated.** The reader-side rule:
  visible to a reader when they are a member of the organiser or an accepted co-organiser (D21, as
  today), OR one of their spaces is among the event's spaces AND that space's slice is `validated`.
  The anonymous agenda selection and the `.ics` apply the same slice rule to the selected spaces; a
  read grant opens the event in a granted space under the same condition.
- **Nothing is ever auto-validated** (user, 2026-09-14): every slice starts `pending`, whoever
  creates the event, the home BDE and the platform admin included.

### 4.2 How it fits the rest

| Topic | Rule |
| --- | --- |
| **The home BDE** | validates its own slice like any other BDE. For an attached association or list, the A2 invariant keeps its audience inside the home's spaces, so **its own events have exactly ONE slice, the home's** - today's single validation, unchanged. Several slices arise only for institutions, entities with no home, legacy wider audiences and co-organised events |
| **Co-organisation (D39)** | a co-organiser's acceptance widens the ceiling; the organiser may then add the new spaces to the event's audience, which opens a `pending` slice for each NEW BDE - the slices already decided are untouched. A co-organiser leaving shrinks the ceiling: the audience rows outside it and the slices left with no space are deleted, logged |
| **Republication (D38)** | concerns POSTS, not events: republishing a post that announces an event does not put the event in the republisher's agenda, and opens no slice. Unchanged |
| **Partly validated** | the organiser's people see one status per slice ("Validé : BDE A - En attente : BDE B - Refusé : BDE C, motif"); a reader sees the event, normally, only in the spaces whose slice is validated, and nothing about the others; the event's own page reached by a link answers 404 to a reader in no validated slice and no membership, as today for an invisible event |
| **The summary `status` column** | kept, derived in the same transaction as each decision: `validated` when at least one slice is, `rejected` when every slice is, `pending` otherwise - so the lists, badges and specs that read it keep a meaning, and no reader path decides on it any more |
| **Notifications** | on creation, and on each new slice, the `VALIDATE_EVENTS` holders of THAT slice's BDE are told (`notifyEventValidatorsOfProposal` per slice, `associations.service.ts:2409`); the no-BDE slice tells the platform admins; each decision tells the organiser's admins which slice was decided (`notifyAssocAdminsOfEventAction`, 2362). A BDE is never told about an event with no space of its own |
| **Edits after validation** | a move of the DATES returns EVERY slice to `pending` (each BDE validated a date - today's rule, `associations.service.ts:2563-2627`, applied per slice); an audience change returns to `pending` only the slices whose spaces changed (question 3); a title, description, poster or form changes nothing |
| **Declining and deleting** | a BDE DECLINES its slice, with an optional reason; it does not delete the event. Deleting the whole event stays with the organiser's people, its home BDE and the platform admin - another BDE "validates and manages nothing" (B3) beyond its slice (B6); today any governing BDE may (`deleteCalendarEvent`, 2748-2780) |
| **Breaks** (`kind = 'break'`) | declared by a validator on its own spaces; one slice, its own. Unchanged in substance |

### 4.3 Existing events - a plan, owner's yes

For each existing event: NO audience row (section 3: no row = the whole ceiling, organiser plus
accepted co-organisers, exactly today's reach), and one slice per BDE that ceiling reaches, plus the no-BDE slice if any, **each copying the event's
current status**. Every reader therefore sees exactly what they see today on the day of the switch.
A data migration: it waits for the owner's yes, like every data change here.

### 4.4 Cost

The agenda predicate gains a join on the event's audience and its validations; both are keyed by
`event_id` and small. `EXPLAIN` on the agenda query before and after, with the event volume of
production, is owed with WP-E (as WP-C measured its own predicate).

## 5. Other simplifications considered

### 5.1 Is "formation x campus" the right unit?

**Yes, for reading AND for governing (A1, A3).** The first version proposed the campus as the
governing unit; the split campus refutes it. The `spaces` table stays (it carries the designation);
its `openedAt` column and the "OPEN spaces" wording go (WP-R5).

### 5.2 Audience shape

| Option | Benefit | Cost | Breaks |
| --- | --- | --- | --- |
| **A. Keep the rule rows, constrain them** (recommended) | no predicate rewrite; read paths unchanged; the event audience reuses the same shape | the per-space bound of 2.5 | nothing |
| B. A formation list on `associations`, rules kept for institutions | one row per entity | two representations, two code paths in every predicate | every predicate in `reader-spaces.ts` |
| C. One `audience_cell` type shared with `read_grants` | one vocabulary | a migration of two tables | WP-C's tests and journal |

### 5.3 Presets

Under the invariant, two presets cover every legal audience of an attached association or list:
**"all of my BDE's spaces"** and **"some formations among them"** (replacing "my campus" and "my
campus plus formations", wrong on a split campus). Whether the fine grid stays for associations and
lists is **question 1**.

### 5.4 The review cohort

Considered: folding the cohort into the model as a sealed extra space. **Not recommended.** The
cohort also seals what spaces do NOT bound - messaging, search, calls, the people directory (D18 is
borderless) - so it would still need its own rule there (52 call sites in 13 files today), and a
fake space would leak into the `CHECK` constraints, the MiConnect enums and every picker
([review cohort](profiles-and-access.md#the-review-cohort---store-reviewers-in-a-world-of-their-own-2026-10-31)).

### 5.5 Staff with no cursus

`campusWideReaderCampus` (`reader-spaces.ts:71-76`) special-cases staff for the agenda. D34-D36
decided staff see student content ONLY by membership or grant, so the special case is a decision,
not a defect. **Left as is**; under section 4 a staff reader's agenda keeps whole-campus events whose
slices are validated.

## 6. The recommended target model, and the path

**Target.** Every association, list and institution has at most one home BDE: the creating BDE by
default, then set by the platform admin alone, with a journal. An attached entity is governed by its
home (an institution's members excepted, always the admin's); an entity with no home by the platform
admin. An attached association's or list's audience stays inside its home's spaces; crossing to
another BDE is republication or co-organisation, and existing wider audiences stay until edited.
Every BDE bound is stated in formation x campus spaces. A post or an event may narrow its entity's
audience, never widen it; an event is validated slice by slice, each BDE for its own spaces. Moderators hide and
delete, never edit.

**Work packages, each shippable alone, in order:**

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | Exclude institutions from the BDE super-admin member management (G6) and remove the moderator's EDIT (`canManage`, G3) | two predicates, no schema; closes P7 and P8 today | none |
| **WP-R1** | The audience bounds per SPACE (`BDE_GOVERNED_SPACES_SQL`, read/write/create, 2.5) | server checks only; closes P3 before any home exists | none |
| **WP-R2** | `home_bde_id` (NULL allowed) and `association_home_journal`; the default home at creation (the creating BDE, a picker for a two-BDE creator); the admin-only "Rattachement" setting on `/admin/spaces`; nothing reads the home for governance yet | additive; the owner then sets the existing homes by hand | **schema migration: owner's yes** (no back-fill) |
| **WP-R3** | Governance switched to the home (`bde.ts`), NULL home = platform admin only; audience refused outside the home's spaces (`AUDIENCE_OUTSIDE_HOME`); the default audience = the home's spaces | ships when the owner says the homes are set; closes P1, P2, P4, P5, P9 | none |
| **WP-R4** | `MODERATE` scoped by the table of 2.5: reports queue, hide/delete, pin, unmask, mute | depends on WP-R3's predicate; closes P6 | none |
| **WP-I** | Per-item audience (section 3): `post_audiences` and `association_calendar_event_audiences`, the AND-ed term in the post and event predicates and in the read-grant branch, the write refusal outside the entity, the "Visible par" picker on the composer and the event form, the cache drop, the `EXPLAIN` before/after; scope per question 4 | independent of the homes; additive (no row = today's reach); closes P12 | **two tables, no data: owner's yes for the schema** |
| **WP-E** | Events validated per slice (section 4), on top of WP-I's event audience: the validations table, the reader rule on both agendas and the `.ics`, the per-slice notifications, the edit and decline rules, the organiser's per-slice view, the derived summary status, the `EXPLAIN` before/after | needs WP-I's event audience; its slices are computed from `spaces`, not from homes, so it does not wait for WP-R3; closes P11 | **one table + the event migration of 4.3: owner's yes** |
| **WP-R5** | Presets "all of my BDE's spaces" / "some formations"; the grid per question 1; `openedAt` and the "OPEN spaces" wording removed | UI and cosmetics; closes P10 | dropping `openedAt`: owner's yes |

Each WP changes its tests with it (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`,
`associations.service.never-auto-validates.spec.ts`,
`associations.service.revalidate-on-date-change.spec.ts`, the agenda and moderation specs), and
updates [profiles-and-access](profiles-and-access.md) (D22, D23, D39 amended) and
[calendar](frontend/modules/calendar.md).

## 7. Questions for the owner (third round)

1. **Garde-t-on la grille fine « Espaces & audiences » pour les associations et les listes ?**
   - (Recommandé) Non : seulement deux choix simples, « tous les espaces de mon BDE » ou « certaines formations parmi eux » ; la grille reste pour les institutions et pour les associations sans rattachement.
   - Oui, telle qu'aujourd'hui, à côté des choix simples.
2. **Un événement qui touche des formations sans BDE : qui le valide pour elles ?**
   - (Recommandé) L'admin plateforme, pour ces formations-là seulement.
   - Personne : l'événement n'y apparaît jamais.
   - Personne : il y apparaît sans validation (ce qui contredit la règle « jamais validé automatiquement »).
3. **Quand un événement déjà validé est modifié, qui doit le revalider ?**
   - (Recommandé) Changement de date : tous les BDE revalident. Changement d'audience : seuls les BDE dont les formations changent. Titre, description, affiche : personne.
   - Toute modification, quelle qu'elle soit, remet l'événement en attente pour tous les BDE.
   - Seul le changement de date compte, comme aujourd'hui ; un changement d'audience ne remet rien en attente.
4. **Qui peut restreindre une publication ou un événement à une partie de son audience (par exemple l'École qui ne vise que les ICM) ?**
   - (Recommandé) Toutes les entités : institutions, associations et listes, avec le même sélecteur « Visible par », réglé par défaut sur toute l'audience.
   - Les institutions seulement.

Already settled by the answers, so not asked: a BDE that does not want an event in its formations
DECLINES it for them only and cannot delete it (B3, B6); a republication of a narrowed post reaches
the republisher's own readers (G4, section 3.2).
