# Spaces, audiences and attachment - a reform proposal (2026-11-02)

**Status: PROPOSAL, nothing built, nothing decided beyond what section 0 quotes.** Written for the
owner to decide. It extends [profiles-and-access](profiles-and-access.md) (D16-D41, the audiences
chantier, WP-C read grants, WP-F5/F6) and does not restate it. Every `file:line` is from `main` at
the time of writing (`apps/social-service/src/` unless said otherwise).

## 0. What prompted it, and what is already decided

The owner, asked on 2026-11-02 who validates content that crosses spaces, chose **"the BDE of
origin alone"** and added: *"Il faut effectivement peut-etre reflechir a des rattachements. Et
peut-etre reformer un peu les espaces/audiences, je ne sais pas si on peut ameliorer les choses..."*

The same day's audit and answers, taken here as GIVEN (they are inputs, not questions):

| # | Decision (owner, 2026-11-02) | What the code does today |
| --- | --- | --- |
| G1 | Content crossing spaces is validated by the BDE of origin ALONE | ANY BDE whose space the association reaches (section 1.3) |
| G2 | `MODERATE` is scoped to the spaces the BDE governs | global (D23): any BDE holding it moderates everything |
| G3 | Nobody edits another person's post | the moderator tier may edit any post (`posts/posts.service.ts:592-608`, `canManage`) |
| G4 | Republication stays THE inter-campus mechanism | it is (D38, D38b), beside co-organisation (D39) |
| G5 | Public data matches only what Portail-etu shows | out of this page's scope, quoted for completeness |
| G6 | An institution's members are managed by the platform admin only | a BDE holding `MANAGE_ASSO` manages them when the institution reaches its space (section 1.5) |
| G7 | A BDE secretary may place themselves in any association they govern | already true through the super-admin tier (`mayAct`, `associations/associations.service.ts:2018-2035`) |

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
  table). It is set on `/admin/spaces` by the platform admin (`spaces/spaces.controller.ts:23`,
  `GlobalAdminGuard`; `spaces/spaces.service.ts` `setBde`), which ALSO inserts an audience rule so
  the BDE reaches what it governs.

### 1.2 Audiences (reach)

- An association, list or institution addresses people through `association_audiences` rows
  `(formation | NULL, campus | NULL)`, NULL meaning "any" (`spaces/association-audience.entity.ts`,
  D19/D33). A rule reaches a space by `ruleReachesSpaceSql` (`spaces/rule-sql.ts:8-12`), resolved at
  read time, so a change applies to past posts too (decision 4 of the audiences chantier).
- **Policy** (`spaces/audience-policy.ts`): an `everyone` rule (campus NULL) is refused outside
  institutions (lines 42-51); the default at creation is the creator's campus, every formation
  (lines 58-68); a BDE "star" writes and reads the audience of entities whose rules sit inside the
  campuses it governs (lines 77-123); a non-admin creator must create on a governed campus
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
| P1 | **Reach decides governance.** There is no "home": the BDE that governs an association is whichever BDE its audience happens to reach | `bde.ts:35-41` joins `association_audiences` | a two-campus association is validated, managed and administered by EITHER BDE - contrary to D22 ("the BDE of the ORIGIN association") and to G1 |
| P2 | **Editing an audience silently moves governance.** Removing a campus or a formation from the rules removes that BDE's power; adding one grants it | `spaces.service.ts:224-258` (`setAudiences`), `setBde` inserts a rule | a governance change is a side effect of a visibility change, logged as an audience edit |
| P3 | **Two granularities for one question.** Validation and management are per SPACE; the audience-write bound and the creation bound are per CAMPUS | `bde.ts:35-41` vs `bde.ts:47-49`; `audience-policy.ts:77-141` | if two BDEs ever govern different formations of one campus, each may rewrite the audience of the other's associations (and so take governance of them, P2) |
| P4 | **Decision 3 is enforced half-way.** "An association on two campuses is TWO associations" - but the server refuses only campus-NULL rules; a global admin writing `(NULL, saint-etienne)` + `(NULL, gardanne)` passes | `audience-policy.ts:42-51` checks `campus === null` only | multi-campus associations can still be created by the grid, and legacy ones remain (WP-A left existing rows "until someone edits that entity") |
| P5 | **`MODERATE` is global** (D23) while G2 wants it scoped | `associations.service.ts:1994-1998` | a BDE of one campus moderates, pins and unmasks the anonymous posts of the other (`posts.service.ts:606-608`, `canPin`, `canUnmaskAnonymous`) |
| P6 | **The moderator tier edits others' posts** | `posts.service.ts:605`: `canManage: isModeratorTier \|\| isPublisher` | contradicts G3 |
| P7 | **Institutions fall under the BDE super-admin tier.** `holdsBdeFlagOver` never looks at the type, so a BDE holding `MANAGE_ASSO` manages the members of an institution whose rules reach its space | `mayAct` 2018-2035 -> `isAssociationSuperAdminOf` 1980 | contradicts D20 and G6; the AUDIENCE of an institution is refused to the star (`audience-policy.ts:97-102`), its MEMBERS are not |
| P8 | **No rule = no governor.** An entity with no audience row is governed by nobody but the platform admin, and invisible except to its members | `bde.ts:28-29` comment; WP6e (a new institution has no rule) | an institution's events reach no validator; WP-A's read-only measurement of rule-less rows was never recorded as run |
| P9 | **The formation half of a space is unused by governance in practice.** One BDE may govern ICM and ISMIN (071 comment); every preset an association can choose is "my campus" or "my campus + formations" (WP-B) | `071_spaces.sql`; `lib/associations/audiencePresets.ts` (frontend) | the unit people govern by is the campus; the formation is an audience filter |
| P10 | **The fine grid can express what no preset can.** The admin grid (`smallestRules`, `spaces.service.ts:70-90`) writes any set of pairs; the editor then reports it as "custom" | WP-B notes | two sources of truth for one shape; a custom audience may straddle campuses (P4) |
| P11 | **Two vocabularies for one cell.** Audience rules and read-grant cells are both "(campus, formation or whole campus)", in two tables with two NULL conventions | `association_audiences` vs `read_grants` (migration 078) | not a defect, an argument for one type (section 3.2) |

## 2. Attachment ("rattachement")

**Proposal: every association, list and institution has ONE home campus (`home_campus`), and the
BDE of that campus governs it** - validates its events, administers it (`MANAGE_ASSO`), moderates
its content (`MODERATE`, G2). The home is a column on `associations`, never derived from the
audience.

### 2.1 Home campus or home BDE?

| Option | Benefit | Cost |
| --- | --- | --- |
| **A. Home CAMPUS** (recommended) | a stable fact about the entity; survives a change of BDE (a new mandate, a renamed association) with no edit; matches how every preset is already expressed | needs "the BDE of a campus" to be ONE association (section 2.5) |
| B. Home BDE (a foreign key to the governing association) | explicit, no indirection | goes stale on every BDE change (a new association each mandate would orphan every attachment); a second fact to keep consistent with the spaces page |

### 2.2 How the home is set

| Option | Benefit | Cost |
| --- | --- | --- |
| **A. At creation, from the creator's campus** (recommended) - exactly today's default audience campus (`audience-policy.ts:58-68`), already refused when missing (`AUDIENCE_CREATOR_CAMPUS_REQUIRED`) and already bound to a governed campus for a BDE creator (`assertCreatorCampusGoverned`) | zero new UI for 99% of creations; reuses two typed refusals | a platform admin creating for another campus must pick it: one picker on the admin creation form |
| B. Derived from the creator's BDE | - | a creator with no BDE role (the ordinary case for a list) has none |
| C. Chosen by the platform admin every time | explicit | a queue nobody drains (CLAUDE.md, "a refusal is never a routing decision to a human queue") |

**Changing it later**: the platform admin only, as a deliberate act with its own journal line,
never as a side effect of an audience edit (closes P2).

### 2.3 Existing multi-campus associations - the migration, as a PLAN

**Data changes need the owner's yes. Nothing below is run by an agent against production; the
SELECTs are read-only and return aggregates.**

1. **Measure** (read-only, aggregates only):

   ```sql
   -- How many entities reach 0, 1 or 2 campuses, by type.
   SELECT a.type, n_campus, count(*) FROM (
     SELECT a.id, a.type, count(DISTINCT s.campus) AS n_campus
     FROM associations a
     LEFT JOIN association_audiences r ON r."associationId" = a.id
     LEFT JOIN spaces s ON (r.formation IS NULL OR r.formation = s.formation)
                       AND (r.campus IS NULL OR r.campus = s.campus)
     GROUP BY a.id, a.type) a
   GROUP BY a.type, n_campus ORDER BY 1, 2;

   -- How many hold a campus-NULL ("everyone") rule while not an institution (legacy of WP-A).
   SELECT a.type, count(DISTINCT a.id) FROM associations a
   JOIN association_audiences r ON r."associationId" = a.id
   WHERE r.campus IS NULL GROUP BY a.type;
   ```

2. **Add the column**, nullable: `ALTER TABLE associations ADD COLUMN home_campus VARCHAR(32) NULL
   CHECK (home_campus IS NULL OR home_campus IN ('saint-etienne','gardanne'))`. Nothing reads it yet.
3. **Back-fill the unambiguous** (one SQL statement, idempotent): every entity whose rules reach
   exactly ONE campus gets that campus. Expected to be the near totality (the 071 seed put every
   pre-reform association on one space; every creation since WP-A writes one campus rule).
4. **The ambiguous ones** (two campuses, or an everyone rule, or no rule):
   - the social service cannot read `users` in a migration (`users` belongs to core-service; a
     fresh database would fail, WP-A's own note), so the proposal is computed by a one-off READ
     script: the campus of the majority of its members holding any permission, tie broken by the
     creator's campus;
   - the platform admin confirms each on a short list ("Rattachements a confirmer" on
     `/admin/spaces`), the only manual step, sized by step 1;
   - until confirmed, a NULL home is governed by the platform admin alone - today's P8 behaviour,
     made explicit rather than accidental.
   - Institutions: the School (everyone) keeps a NULL home; each campus institution gets its campus.
5. **Switch the predicate** (WP-R2 below) only once step 4's list is empty or the owner accepts
   what remains NULL.
6. **Reach is NOT trimmed by the migration.** A legacy two-campus audience keeps reaching both
   campuses (nobody loses sight of anything on the day of the switch); it is refused on its next
   edit, exactly as WP-A treated legacy everyone rules. Trimming is the owner's call (question 2).

### 2.4 How the other campuses' BDEs relate

**Recommended: read only, plus the two existing proposal mechanisms.** Under G1 the home BDE alone
validates; the other campus's BDE:

- **reads** what reaches its readers like anyone else (no governance view of a foreign entity);
- **proposes** through what exists: republication into one of its own associations (D38, accepted
  by the receiving side) and co-organisation (D39, the event stays validated by the ORGANISER's home
  BDE - which is what `mayValidateEvent` already does by reading the event's own `associationId`);
- **does NOT co-validate**: a second validator is a second queue and a disagreement nobody
  arbitrates, and G1 rules it out.

### 2.5 Reach and governance become two concepts

| Concept | Question it answers | Stored in | Who writes it |
| --- | --- | --- | --- |
| **Home** (governance) | who validates, administers, moderates | `associations.home_campus` | set at creation; changed by the platform admin only |
| **Audience** (reach) | who sees it | `association_audiences` | the entity's home BDE (within the home campus) or the platform admin |

**Invariant for an association and a list: audience is inside the home campus** (closes P4,
enforces decision 3 on the server). Crossing campuses is republication or co-organisation (G4).
**An institution** may reach anything (an everyone rule, two campuses), and is governed by the
platform admin whatever its home (G6); its home only says which BDE validates its EVENTS (question
6).

**The BDE of a campus.** Today a BDE is designated per space. Governance by campus needs one BDE per
campus: either keep `spaces."bdeAssociationId"` and require every space of a campus to name the same
association (a CHECK through a trigger, or a refusal in `setBde`), or move the designation to a
`campuses` table of two rows. Recommended: **the second** - a two-row table is the truth, the
per-space column is then derived and dropped; `isBdeAssociationSql` keeps its meaning
(question 3).

**The predicate becomes** (sketch, not code):

```sql
-- user U holds flag F in the BDE governing association A
EXISTS (SELECT 1 FROM associations gov_a
  JOIN campuses gov_c ON gov_c.campus = gov_a.home_campus
  JOIN association_members gov_m ON gov_m."associationId" = gov_c."bdeAssociationId"
  WHERE gov_a.id = A AND gov_a.type <> 'institution'   -- G6
    AND gov_m."userId" = U AND (gov_m.permissions & F) <> 0)
```

No rule matching, one row per association: simpler and cheaper than `bde.ts:35-41`, and the same
text serves validation, management and (scoped) moderation. `BDE_GOVERNED_CAMPUSES_SQL` becomes
"the campuses whose BDE U holds F in", the SAME granularity (closes P3).

**Moderation scope (G2), derived from the home:**

| Content | Moderated by the BDE of |
| --- | --- |
| an association's or list's post, comment, event, live | the entity's home campus |
| an institution's | platform admin only |
| a personal post, comment, live | the AUTHOR's profile campus (question 7) |
| a report | the campus of the reported content, by the rows above; the queue is filtered accordingly |
| muting a user | the user's profile campus |

`canManage` loses the moderator tier (G3): a moderator HIDES or DELETES, never edits.
`canUnmaskAnonymous` and `canPin` follow the table above.

## 3. Other simplifications worth considering

### 3.1 Is "formation x campus" the right unit?

- **For READING: keep it.** It is what makes a personal post visible to the people of one's own
  formation and campus (`sharesSpaceWithAuthorSql`), what the agenda signs (D40), and what read
  grants target. Changing it changes who sees whose personal posts - a product decision, not a
  simplification.
- **For GOVERNING: drop it** (P9). The campus is the unit (section 2.5).
- **The table itself**: 10 constant rows whose only non-derived column is the BDE. Once the BDE
  moves to `campuses`, `spaces` could become a constant `VALUES` list. Benefit: one table and the
  vestigial `openedAt` gone. Cost: two predicate files (`bde.ts`, `reader-spaces.ts`) join it and
  every integration spec seeds it. **Recommended: keep the table, drop `openedAt` and the "OPEN"
  wording** - the saving is cosmetic, the churn real.

### 3.2 Audience as "campus plus optional formations"

With the home invariant, an association's audience is ALWAYS "its home campus, all formations or
some" - exactly the two presets WP-B offers. Options:

| Option | Benefit | Cost | Breaks |
| --- | --- | --- | --- |
| **A. Keep the rows, constrain them** (recommended) | no predicate rewrite; the grid and the read paths unchanged | none beyond WP-R3's refusal | nothing |
| B. A column `audience_formations text[]` (empty = all) on `associations`, rules table kept for institutions only | one row per entity | two representations, two code paths in every predicate | every predicate in `reader-spaces.ts` |
| C. One `audience_cell` type shared with `read_grants` (P11) | one vocabulary | a migration of two tables | WP-C's tests and journal |

### 3.3 Presets

Under the invariant, the presets cover 100% of what an association or list may address, so **the
fine grid is needed only for institutions**. Recommended: the `/admin/spaces` grid keeps its
institution rows and shows associations read-only; the editor's "custom" state disappears for them
(closes P10). Cost: one UI change; nothing a user loses (a custom audience inside one campus IS the
formations preset).

### 3.4 How institutions fit

An institution is an `associations` row (WP6e) and stays one. What changes: excluded from the BDE
super-admin tier (G6, closes P7) by the `type <> 'institution'` clause above; may keep any reach;
its home only routes its event validation (question 6). The School keeps a NULL home.

### 3.5 The review cohort

Considered: folding the cohort into the model as a third, sealed "campus". **Not recommended.** The
cohort also seals what spaces do NOT bound - messaging, search, calls, the people directory (D18 is
borderless) - so it would still need its own rule there (52 call sites in 13 files today), and a
fake campus would leak into the `CHECK` constraints, the MiConnect enum and every campus picker.
It is orthogonal to this reform and stays as built
([review cohort](profiles-and-access.md#the-review-cohort---store-reviewers-in-a-world-of-their-own-2026-10-31)).

### 3.6 Staff with no cursus

`campusWideReaderCampus` (`reader-spaces.ts:71-76`) special-cases staff for the agenda. Expressing a
reader as "a campus plus zero or more formations" would make staff an ordinary reader with no
formation - but D34-D36 decided staff see student content ONLY by membership or grant, so the
special case is a decision, not a defect. **Left as is.**

## 4. The recommended target model, and the path

**Target, in four sentences.** Every association, list and institution has one home campus; the
BDE designated for that campus governs associations and lists (validation, management, scoped
moderation), and the platform admin governs institutions. Audience is separate and, for an
association or a list, stays inside the home campus, chosen from two presets; crossing campuses is
republication or co-organisation. Reading stays per formation x campus space. Moderators hide and
delete, never edit.

**Work packages, each shippable alone, in order:**

| WP | What | Ships alone because | Data change |
| --- | --- | --- | --- |
| **WP-R0** | Exclude institutions from the BDE super-admin tier (G6) and remove the moderator's EDIT (`canManage`, G3) | two predicates, no schema; closes P6 and P7 today | none |
| **WP-R1** | `home_campus` column, back-fill of the unambiguous rows, the read script and the admin confirmation list; nothing reads the column | additive | **migration + back-fill: owner's yes** |
| **WP-R2** | One BDE per campus (`campuses` table or the `setBde` refusal) and the governance predicate switched to the home (`bde.ts`), same granularity for validation, management and the audience bound | behind the measured empty list of WP-R1; closes P1, P2, P3, P8 | **migration: owner's yes** |
| **WP-R3** | Audience refused outside the home campus for associations and lists (a new typed code beside `AUDIENCE_OUTSIDE_BDE_CAMPUS`); legacy rows kept until edited | server refusal only; closes P4 | none |
| **WP-R4** | `MODERATE` scoped by the table of section 2.5: reports queue, hide/delete, pin, unmask, mute | depends on WP-R2's predicate; closes P5 | none |
| **WP-R5** | The grid read-only for associations, presets only; `openedAt` and the "OPEN spaces" wording removed | cosmetic and UI; closes P10 | dropping `openedAt`: owner's yes |
| **WP-R6** (only if question 2 says so) | Trim the legacy two-campus audiences to the home | the owner's choice | **data change: owner's yes** |

Each WP changes its tests with it (`bde.integration.spec.ts`, `spaces.service.spec.ts`,
`associations.service.create-default-audience.spec.ts`, the moderation and posts visibility specs),
and updates [profiles-and-access](profiles-and-access.md) (D22, D23 amended).

## 5. Questions for the owner

1. **Pour une association qui touche aujourd'hui les deux campus, comment choisit-on son campus de rattachement ?**
   - (Recommande) Le serveur propose le campus de la majorite de ses membres responsables, et l'admin plateforme confirme sur une courte liste.
   - Le campus de la personne qui l'a creee, sans confirmation.
   - L'admin plateforme choisit a la main, au cas par cas, sans proposition.
2. **Une association ou une liste peut-elle encore s'adresser directement a l'autre campus ?**
   - (Recommande) Non : elle s'adresse a son campus, l'autre campus passe par la republication ou la co-organisation ; celles qui touchent deja les deux campus le gardent jusqu'a leur prochaine modification.
   - Non, et on retire tout de suite l'autre campus aux associations existantes.
   - Oui, mais seulement si l'admin plateforme le decide.
3. **Le BDE est-il designe par campus ou par formation et campus ?**
   - (Recommande) Un BDE par campus, qui gouverne toutes les formations de ce campus.
   - Comme aujourd'hui, un BDE par formation et campus, sachant que deux BDE d'un meme campus se marchent alors dessus.
4. **Qui peut changer le campus de rattachement d'une association apres sa creation ?**
   - (Recommande) L'admin plateforme seul, et le changement est journalise.
   - Le BDE actuel, en le cedant a l'autre campus.
   - Les deux BDE ensemble.
5. **Que peut faire le BDE de l'autre campus face a une association qui n'est pas rattachee a lui ?**
   - (Recommande) La lire comme tout le monde, et proposer une republication ou une co-organisation ; il ne valide rien et ne gere rien.
   - Il voit aussi ses evenements en attente, sans pouvoir les valider.
6. **Qui valide les evenements d'une institution (la Maison des Eleves, l'Ecole) ?**
   - (Recommande) Le BDE de son campus de rattachement ; pour une institution sans campus (l'Ecole), l'admin plateforme.
   - Personne : les membres d'une institution sont nommes par l'admin plateforme, leurs evenements paraissent sans validation.
   - Toujours l'admin plateforme.
7. **Quel BDE modere une publication personnelle d'un etudiant ?**
   - (Recommande) Le BDE du campus de l'auteur.
   - Le BDE de chaque campus ou la publication est vue.
8. **Garde-t-on la grille fine "Espaces & audiences" pour les associations ?**
   - (Recommande) Non : pour une association ou une liste, seulement les deux choix simples (tout mon campus, ou mon campus et certaines formations) ; la grille reste pour les institutions.
   - Oui, telle qu'aujourd'hui, a cote des choix simples.
