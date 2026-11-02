# Spaces, audiences and attachment - a reform proposal (2026-11-02)

**Status: PROPOSAL, revised the same day after the owner's answers to its first four questions
(section 0). Nothing is built.** Written for the owner to decide. It extends
[profiles-and-access](profiles-and-access.md) (D16-D41, the audiences chantier, WP-C read grants,
WP-F5/F6) and does not restate it. Every `file:line` is from `main` at the time of writing
(`apps/social-service/src/` unless said otherwise).

## 0. What prompted it, and what is already decided

The owner, asked on 2026-11-02 who validates content that crosses spaces, chose **"the BDE of
origin alone"** and added: *"Il faut effectivement peut-etre reflechir a des rattachements. Et
peut-etre reformer un peu les espaces/audiences, je ne sais pas si on peut ameliorer les choses..."*

The same day's audit and answers, taken here as GIVEN:

| # | Decision (owner, 2026-11-02) | What the code does today |
| --- | --- | --- |
| G1 | Content crossing spaces is validated by the BDE of origin ALONE | ANY BDE whose space the association reaches (section 1.3) |
| G2 | `MODERATE` is scoped to the spaces the BDE governs | global (D23): any BDE holding it moderates everything |
| G3 | Nobody edits another person's post | the moderator tier may edit any post (`posts/posts.service.ts:592-608`, `canManage`) |
| G4 | Republication stays THE inter-campus mechanism | it is (D38, D38b), beside co-organisation (D39) |
| G5 | Public data matches only what Portail-etu shows | out of this page's scope, quoted for completeness |
| G6 | An institution's members are managed by the platform admin only | a BDE holding `MANAGE_ASSO` manages them when the institution reaches its space (section 1.5) |
| G7 | A BDE secretary may place themselves in any association they govern | already true through the super-admin tier (`mayAct`, `associations/associations.service.ts:2018-2035`) |

**The owner's answers to the first version's questions 1-4 (2026-11-02, second round):**

| # | Answer | What it changed in this page |
| --- | --- | --- |
| A1 | **The campus is NOT the unit.** *"il peut exister plusieurs formations pour un campus, et un BDE par formation"* - the admin grid shows, on one campus, one BDE governing four formations and another BDE governing the fifth | the home is a **governing BDE**, not a campus (section 2); how it is chosen is asked again (question 1) |
| A2 | *"Non, sauf l'existant"*: an association or a list addresses only its home's reach; the other campus is reached by republication or co-organisation; existing two-campus audiences stay until their next modification | the invariant of section 2.5; no trimming migration |
| A3 | A BDE is designated **per formation x campus**, as today | the `campuses`-table idea is dropped; the two-granularity defect (P3) is solved inside the per-space model (section 2.6) |
| A4 | **Only the platform admin changes an association's home, and every change is logged** | section 2.3 |

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

### 1.4 Memberships and reach

A membership opens an association's content to its member whatever their space (D21), and grants
the flags of `association_members.permissions`. Joining is decided by the association's admins.
Membership never moves an association onto a campus for the directory's map filter
(`associationRulesReachSpaceMatchingSql`, `reader-spaces.ts:185-195`).

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
| P9 | **No rule = no governor.** An entity with no audience row is governed by nobody but the platform admin, and invisible except to its members | `bde.ts:28-29` comment; WP6e (a new institution has no rule) | an institution's events reach no validator; WP-A's read-only measurement of rule-less rows was never recorded as run |
| P10 | **The fine grid can express what no preset can.** The admin grid (`smallestRules`, `spaces.service.ts:70-90`) writes any set of pairs; the editor then reports it as "custom" | WP-B notes | two sources of truth for one shape; a custom audience may straddle BDEs (P1) |
| P11 | **Two vocabularies for one cell.** Audience rules and read-grant cells are both "(campus, formation or whole campus)", in two tables with two NULL conventions | `association_audiences` vs `read_grants` (migration 078) | not a defect; noted, not acted on (section 3.2) |

## 2. Attachment ("rattachement") to a governing BDE

**Proposal: every association, list and institution has ONE home BDE (`home_bde_id`), the
association designated as BDE of one or more spaces (A1, A3). That BDE governs it** - validates its
events, administers it (`MANAGE_ASSO`), moderates its content (`MODERATE`, G2). The home is a column
on `associations`, never derived from the audience.

### 2.1 What the home points at

| Option | Benefit | Cost |
| --- | --- | --- |
| **A. The BDE association itself** (`home_bde_id -> associations.id`, recommended) | exactly the owner's words ("rattache a un BDE"); a BDE governing four formations is ONE home, with no arbitrary pick among its spaces; the governance predicate is one join | if the admin removes a BDE's last space, its attached entities are left with a home that governs nothing - handled explicitly in 2.4 |
| B. A home SPACE (`home_space_id -> spaces.id`), the governing BDE derived from it | never dangles (spaces are never deleted); follows a redesignation automatically | over-specifies: an association of the four-formation BDE must be pinned to ONE of its four spaces for no reason, and the migration has to invent that choice |

### 2.2 How the home is set at creation

The creator's BDE is not always one BDE: a person with two cursus may sit in spaces of two BDEs, and
a platform admin may create for anyone. Options, asked as **question 1**:

| Option | Benefit | Cost |
| --- | --- | --- |
| **A. The BDE governing the creator's space; when the creator's spaces have two BDEs, the creator picks one of them** (recommended) | automatic in the ordinary case; the pick is offered only between BDEs the creator actually belongs to; a BDE creator keeps today's bound (it creates only what it governs, `assertCreatorCampusGoverned`, made per space in 2.6) | one picker, shown rarely; the platform admin's creation form gets a BDE picker |
| B. The creator's BDE, no choice: first one found | no UI | an arbitrary pick is a non-deterministic rule |
| C. Chosen by the platform admin every time | explicit | a queue nobody drains (CLAUDE.md, "a refusal is never a routing decision to a human queue") |

A creator with no space is refused exactly as today with no campus
(`AUDIENCE_CREATOR_CAMPUS_REQUIRED`, renamed to say "space").

### 2.3 Changing it later (A4)

**The platform admin only**, as a deliberate act, never as a side effect of an audience edit
(closes P2). Each change writes an append-only `association_home_journal` line (`association_id`,
`from_bde`, `to_bde`, `actor`, `at`), the shape `read_grant_journal` already has (migration 078,
WP-C), in the same transaction. Account deletion anonymises the actor as WP-C does.

### 2.4 Existing associations - the migration, as a PLAN

**Data changes need the owner's yes. Nothing below is run by an agent against production; the
SELECTs are read-only and return aggregates.**

1. **Measure** (read-only, aggregates only):

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

   -- Of those reaching two BDEs, how many do so through a whole-campus rule (P4's default).
   SELECT count(DISTINCT r."associationId") FROM association_audiences r
   WHERE r.formation IS NULL AND r.campus IS NOT NULL;
   ```

   **Expect the two-BDE bucket to be LARGE on the split campus**: P4 gave every association created
   there since WP-A a whole-campus rule. That is why the proposal below is computed, not typed.

2. **Add the column**, nullable: `home_bde_id UUID NULL REFERENCES associations(id) ON DELETE SET
   NULL`, plus `association_home_journal`. Nothing reads them yet.
3. **Back-fill the unambiguous** (one idempotent statement): every entity whose rules reach the
   spaces of exactly ONE BDE gets that BDE. A BDE itself gets itself (a BDE always reaches what it
   governs, `setBde`).
4. **The ambiguous ones** (two BDEs, or no BDE):
   - the social service cannot read `users` in a migration (`users` belongs to core-service; a
     fresh database would fail, WP-A's own note), so the proposal is computed by a one-off READ
     script: **the BDE governing the spaces of the majority of the entity's officers** (members
     holding any permission), tie broken by the creator's spaces (question 1);
   - the platform admin confirms each on a short list ("Rattachements a confirmer" on
     `/admin/spaces`); each confirmation is a home change, so it is journaled (2.3);
   - until confirmed, a NULL home is governed by the platform admin alone - today's P9 behaviour,
     made explicit rather than accidental.
   - Institutions: governed by the platform admin whatever their home (G6); a home only routes their
     event validation (question 3). The School keeps a NULL home.
5. **Switch the predicate** (WP-R3 below) only once step 4's list is empty or the owner accepts
   what remains NULL.
6. **Reach is NOT trimmed (A2).** A legacy audience reaching beyond its home keeps reaching it; it is
   refused on its next edit (2.5), exactly as WP-A treated legacy everyone rules.

**When a BDE loses its last space later** (the admin redesignates): the entities attached to it are
NOT silently moved. `setBde` logs `[spaces] N entities attached to a BDE that governs nothing` at
warn, they fall back to platform-admin governance (as a NULL home), and they appear on the same
confirmation list. No refusal blocks the redesignation.

### 2.5 Reach and governance become two concepts

| Concept | Question it answers | Stored in | Who writes it |
| --- | --- | --- | --- |
| **Home** (governance) | who validates, administers, moderates | `associations.home_bde_id` | set at creation (2.2); changed by the platform admin only, journaled (A4) |
| **Audience** (reach) | who sees it | `association_audiences` | the home BDE (inside its own spaces) or the platform admin |

**Invariant for an association and a list (A2): every space its audience reaches is governed by its
home BDE.** Checked on every audience WRITE (a new typed code, `AUDIENCE_OUTSIDE_HOME`); legacy rows
that break it stay until the entity's next edit, and the editor shows the out-of-home part as what
the save will drop. Crossing to another BDE's spaces - the other campus, or the other BDE of the same
campus - is republication or co-organisation (G4).

**The default audience at creation** becomes **every space governed by the home BDE** (written as
the smallest rule set, `smallestRules`: a whole-campus rule only when that BDE governs the whole
campus). Closes P4.

**An institution** may reach anything (an everyone rule, two campuses), and is governed by the
platform admin whatever its home (G6).

**The governance predicate becomes** (sketch, not code):

```sql
-- user U holds flag F in the BDE governing association A
EXISTS (SELECT 1 FROM associations gov_a
  JOIN association_members gov_m ON gov_m."associationId" = gov_a.home_bde_id
  WHERE gov_a.id = A AND gov_a.type <> 'institution'   -- G6
    AND gov_m."userId" = U AND (gov_m.permissions & F) <> 0
    AND EXISTS (SELECT 1 FROM spaces gov_s WHERE gov_s."bdeAssociationId" = gov_a.home_bde_id))
```

No rule matching, one row per association: simpler and cheaper than `bde.ts:35-41`, and the same
text serves validation, management and (scoped) moderation. The last clause makes a home that
governs nothing govern nobody (2.4).

### 2.6 Two BDEs on one campus: the audience bounds per space (A3, closes P3)

With a BDE per formation x campus, every BDE bound must be stated in SPACES, the granularity the
designation has:

- `BDE_GOVERNED_CAMPUSES_SQL` is replaced by **`BDE_GOVERNED_SPACES_SQL`**: the `(formation,
  campus)` pairs whose BDE U holds F in.
- A rule is **inside** a set of governed spaces when EVERY space it reaches is in the set - so a
  whole-campus rule `(NULL, campus)` is inside only for a BDE governing every formation of that
  campus; the four-formation BDE writes four pair rules (the editor does it for it).
- **Write and read** (`assertBdeMayWriteAudience`, `assertBdeMayReadAudience`): before the home
  exists (WP-R1), current AND submitted rules must be inside the caller's governed spaces; once it
  exists (WP-R3), the bound is simply **the caller holds `MANAGE_ASSO` in the entity's home BDE**,
  and the submitted rules must be inside the home's spaces (the invariant). A BDE never reads or
  writes the audience of another BDE's association, whatever campus they share.
- **Creation** (`assertCreatorCampusGoverned`): the default rules must be inside the creator's
  governed spaces - which they are by construction once the default is "the home's spaces".

**Moderation scope (G2), derived from the home:**

| Content | Moderated by |
| --- | --- |
| an association's or list's post, comment, event, live | its home BDE |
| an institution's | platform admin only |
| a personal post, comment, live | the BDE governing one of the AUTHOR's spaces (question 4) |
| a report | the moderator of the reported content, by the rows above; the queue is filtered accordingly |
| muting a user | the BDE governing one of that user's spaces |

`canManage` loses the moderator tier (G3): a moderator HIDES or DELETES, never edits.
`canUnmaskAnonymous` and `canPin` follow the table above.

### 2.7 How the other BDEs relate

**Recommended (question 2): read only, plus the two existing proposal mechanisms.** Under G1 the home
BDE alone validates; every other BDE - of the other campus, or of the other formations of the same
campus:

- **reads** what reaches its readers like anyone else (no governance view of a foreign entity);
- **proposes** through what exists: republication into one of its own associations (D38, accepted
  by the receiving side) and co-organisation (D39, the event stays validated by the ORGANISER's home
  BDE - which is what `mayValidateEvent` already does by reading the event's own `associationId`);
- **does NOT co-validate**: a second validator is a second queue and a disagreement nobody
  arbitrates, and G1 rules it out.

## 3. Other simplifications considered

### 3.1 Is "formation x campus" the right unit?

**Yes, for reading AND for governing (A1, A3).** The first version of this page proposed the campus
as the governing unit; the split campus refutes it. The space stays the unit everywhere; what
changes is that every BDE bound is expressed in spaces (2.6). The `spaces` table stays (it carries
the designation); its `openedAt` column and the "OPEN spaces" wording go (WP-R5).

### 3.2 Audience shape

Under the invariant, an association's audience is always "some or all of its home BDE's spaces".

| Option | Benefit | Cost | Breaks |
| --- | --- | --- | --- |
| **A. Keep the rule rows, constrain them** (recommended) | no predicate rewrite; read paths unchanged | the per-space bound of 2.6 | nothing |
| B. A formation list on `associations`, rules kept for institutions | one row per entity | two representations, two code paths in every predicate | every predicate in `reader-spaces.ts` |
| C. One `audience_cell` type shared with `read_grants` (P11) | one vocabulary | a migration of two tables | WP-C's tests and journal |

### 3.3 Presets

Under the invariant, two presets cover every legal association or list audience: **"all of my BDE's
spaces"** and **"some formations among them"** (replacing "my campus" and "my campus plus
formations", which are wrong on a split campus). The fine grid is then needed only for institutions
(question 5). Cost: one UI change; nothing a user loses.

### 3.4 How institutions fit

An institution is an `associations` row (WP6e) and stays one. What changes: excluded from the BDE
super-admin tier (G6, closes P8) by the `type <> 'institution'` clause above; may keep any reach; its
home BDE, when it has one, only routes its event validation (question 3).

### 3.5 The review cohort

Considered: folding the cohort into the model as a sealed extra space. **Not recommended.** The
cohort also seals what spaces do NOT bound - messaging, search, calls, the people directory (D18 is
borderless) - so it would still need its own rule there (52 call sites in 13 files today), and a
fake space would leak into the `CHECK` constraints, the MiConnect enums and every picker. It is
orthogonal to this reform and stays as built
([review cohort](profiles-and-access.md#the-review-cohort---store-reviewers-in-a-world-of-their-own-2026-10-31)).

### 3.6 Staff with no cursus

`campusWideReaderCampus` (`reader-spaces.ts:71-76`) special-cases staff for the agenda. D34-D36
decided staff see student content ONLY by membership or grant, so the special case is a decision,
not a defect. **Left as is.**

## 4. The recommended target model, and the path

**Target, in four sentences.** Every association, list and institution is attached to one governing
BDE, chosen at creation and changed only by the platform admin, with a journal; that BDE validates,
administers and moderates associations and lists, and the platform admin governs institutions. An
association's or list's audience stays inside its home BDE's spaces, chosen from two presets;
crossing to another BDE is republication or co-organisation, and existing wider audiences stay until
edited. Every BDE bound is stated in formation x campus spaces, the unit a BDE is designated on.
Moderators hide and delete, never edit.

**Work packages, each shippable alone, in order:**

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | Exclude institutions from the BDE super-admin tier (G6) and remove the moderator's EDIT (`canManage`, G3) | two predicates, no schema; closes P7 and P8 today | none |
| **WP-R1** | The audience bounds per SPACE (`BDE_GOVERNED_SPACES_SQL`, write/read/create, 2.6) | server checks only; closes P3 now, before any home exists | none |
| **WP-R2** | `home_bde_id` and `association_home_journal`, the back-fill of the unambiguous rows, the read script and the admin confirmation list; nothing reads the column for governance | additive | **migration + back-fill: owner's yes** |
| **WP-R3** | Governance switched to the home (`bde.ts`); audience refused outside the home's spaces (`AUDIENCE_OUTSIDE_HOME`); the default audience = the home's spaces; the creation picker (2.2); the admin's home change, journaled | behind the measured, emptied list of WP-R2; closes P1, P2, P4, P5, P9 | none beyond WP-R2 |
| **WP-R4** | `MODERATE` scoped by the table of 2.6: reports queue, hide/delete, pin, unmask, mute | depends on WP-R3's predicate; closes P6 | none |
| **WP-R5** | Presets "all of my BDE's spaces" / "some formations"; the grid read-only for associations (if question 5 says so); `openedAt` and the "OPEN spaces" wording removed | UI and cosmetics; closes P10 | dropping `openedAt`: owner's yes |

Each WP changes its tests with it (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`, the moderation and posts visibility specs),
and updates [profiles-and-access](profiles-and-access.md) (D22, D23 amended).

## 5. Questions for the owner (second round)

1. **Comment choisit-on le BDE de rattachement d'une association ?**
   - (Recommandé) Pour une association existante : le serveur propose le BDE qui gouverne les espaces de la majorité de ses responsables, et l'admin plateforme confirme sur une courte liste. Pour une nouvelle : le BDE de l'espace de la personne qui la crée ; si elle relève de deux BDE, elle choisit entre les deux.
   - Toujours le BDE de la personne qui l'a créée, sans proposition ni confirmation.
   - L'admin plateforme choisit à la main, à chaque fois.
2. **Que peut faire un autre BDE (celui de l'autre campus, ou celui des autres formations du même campus) face à une association qui n'est pas rattachée à lui ?**
   - (Recommandé) La voir comme tout le monde, et proposer une republication ou une co-organisation ; il ne valide rien et ne gère rien.
   - Il voit aussi ses événements en attente de validation, sans pouvoir les valider.
3. **Qui valide les événements d'une institution (la Maison des Élèves, l'École) ?**
   - (Recommandé) Le BDE auquel l'admin plateforme la rattache ; pour une institution sans rattachement (l'École), l'admin plateforme.
   - Personne : ses membres sont nommés par l'admin plateforme, ses événements paraissent sans validation.
   - Toujours l'admin plateforme.
4. **Quel BDE modère une publication personnelle d'un étudiant ?**
   - (Recommandé) Le BDE qui gouverne l'espace de l'auteur (s'il relève de deux BDE, l'un comme l'autre).
   - Le BDE de chaque espace où la publication est vue.
5. **Garde-t-on la grille fine « Espaces & audiences » pour les associations et les listes ?**
   - (Recommandé) Non : seulement deux choix simples, « tous les espaces de mon BDE » ou « certaines formations parmi eux » ; la grille reste pour les institutions.
   - Oui, telle qu'aujourd'hui, à côté des choix simples.
