# MiConnect profiles and access - the reform (decided with the user, 2026-09-29)

**Status: DECIDED, NOT BUILT.** Every answer below was given by the user on 2026-09-29, one question
at a time. The technical plan that turns them into work packages is section 4, PROPOSED and
awaiting the user's validation. Anyone can log in to MiConnect with a School CAS account (and soon a Mines Saint-Etienne
Alumni SSO account), so who a person is, and what that opens, has to be modelled rather than
inferred from one self-declared string.

## 1. What exists today (measured on production, 2026-09-29 ~14:36 UTC)

Read with `ak shell` in `miconnect-server-1` on `ssh portail-etu-direct`, read-only. Counts are a
snapshot of a live population ([authentik](infrastructure/authentik.md#database-and-backup)).

**Sign-in.** `miconnect-auth` is an identification stage with NO password field: a source button and
nothing else. Two sources:

| Source | Kind | State |
| --- | --- | --- |
| `cas-emse` | OAuth/OIDC against `cas.emse.fr/cas/oidc` | 598 accounts linked. Its mapping `CAS EMSE` keeps `sub` (the username, `prenom.nom`) and `name`, nothing else |
| `alumni` | SAML | enabled and promoted, but its `sso_url` is a PLACEHOLDER (a YouTube URL), it has no property mapping and no account is linked |

**The CAS says nothing about the person.** Its public discovery document advertises the standard
OIDC claims only (`sub`, `name`, `given_name`, `family_name`, `email`, ...) - no affiliation, no
track, no year. So everything that decides access today is **declared at enrolment and verified by
nobody**.

**Enrolment, `miconnect-enrollment-cas`** (first sign-in):

1. `custom_statut` - "Je suis : Élève / Personnel de l'école" (the label/value pair keeps the value
   `Elève`, see [authentik](infrastructure/authentik.md#one-language-french-in-the-ecosystems-tu-2026-09-25)).
2. If `Elève` (policy `is-student`): `attributes.promo`, the ENTRY year (AST 2A enter the year
   before), validated `1816 <= promo <= this year`; `attributes.formation`, one of ICM / ISMIN / FSSS
   / Master.
3. `Merge attributes` copies the status into `attributes.school_status`, then write + login.

`miconnect-enrollment-alumni` asks promo + formation only. `miconnect-enroll-aluni-from-cas` is an
EMPTY flow, and the expression policy `Need Alumni Source` (force the alumni link above a promo) is
bound to nothing - the "colle" was sketched, never wired.

**Nothing can be corrected after enrolment.** `default-user-settings-flow` edits username, name,
email and locale only, and an `external` account cannot open authentik's user interface at all.

**What the applications receive.** Every OAuth provider carries `Promotion` (`promo`), `Formation`
(`formation`) and `First + Last Names` (`firstName`/`lastName`, split from `name`: words entirely in
capitals become the last name). All but MiGallery and the Cercle also carry `Personnel de l'école`
(`school_status`), which **no application reads**. The `profile` scope carries `groups`, and the only
group is `authentik Admins` (5, superuser). **No application has an access policy**: every account
can sign in to all nine.

**The population.** 600 `external` + 5 `internal` + 1 service account.

| | Accounts |
| --- | --- |
| Eleve, ICM | 550 |
| Eleve, ISMIN | 17 |
| Eleve, Master | 13 |
| Eleve, FSSS | 5 |
| "Personnel de l'ecole" (no promo, no formation) | 14 |
| no status at all | 1 |
| no CAS connection | 6 |

Promo (entry year): 2026 177, 2025 158, 2024 140, 2023 70, 2022 39, then 2021 x2, 2020, 2007 and
1816 - the validator accepts anything. **6 accounts have no all-capitals word in their name, so their
`lastName` is empty** and every name-based match (Canari's legacy cotisations, Sky's record link, the
Cercle's account reclaim) misses them.

**What each application decides from those claims** - `formation = 'ICM'` is the real access
criterion, hard-coded three times, and every admin flag is local:

| App | Reads | Decides |
| --- | --- | --- |
| Canari | `sub`, `name`, `firstName`, `lastName`, `promo`, `formation` | feed = ICM or admin (`feed-audience.ts`); history floor from `promo`; form prices and question visibility by promo/formation/cotisation buckets (`pricing/audience.ts`); legacy cotisations matched on name + promo. A claim that disappears is never cleared locally |
| Sky | the same + `email` | sign-in refused unless `formation = 'ICM'` or admin; record link on name + promo; godparent links need both promos |
| MiGallery | the same | album access by formation AND promo; a missing claim IS cleared locally |
| Le Cercle | `firstName`, `lastName`, `promo`, `formation`, all REQUIRED | a staff account cannot sign in at all (`requiredClaims`, `NOT NULL` columns) |
| Portail-etu | nothing (no sign-in) | displays promo only |

## 2. The model the user decided

**A person, then a list of affiliations.**

- **D1 - Affiliations are cumulative**, a free list: one person may hold several at once, and what
  they open is the UNION (D16).
- **D2 - Two kinds of affiliation.** A **cursus** (a formation and an entry year) and a **post** in
  one of three staff organisations: **EMSE**, **ME** (Maison des Eleves - "ME", never "MdE") and the
  **Alumni association**.
- **D3 - No graduated/current distinction.** A student and an alumnus are the same thing in the model:
  someone with a cursus. Any time filter goes through the promo.
- **D4 - Formations: ICM, ISMIN, FSSS (formation sous statut salarie), Autre** - one bucket for
  masters, doctorates and the rest, no sub-values.
- **D5 - Promo is the ENTRY year**, the School's and the alumni network's convention alike.
- **D6 - ONE campus per person**, Gardanne or Saint-Etienne, staff included.
- **D7 - The provider is only a way in.** CAS and Alumni SSO both give a name, a first name and an
  identifier, and lead to the SAME profile; the provider must never distinguish people. A student
  loses the School account at the end of the course, so they "font la colle": link the Alumni SSO to
  the same MiConnect account while the CAS still works. Someone arriving through the Alumni SSO alone
  gets an account too.

**Truth and corrections.**

- **D8 - Purely declarative.** Nobody verifies what is declared; the profile is visible in Canari's
  directory, and abuse is corrected after the fact.
- **D9 - Authentik is the ONE source of truth, edited from Canari.** Canari's admin directory writes
  to Authentik through its API; every application sees the change at its next sign-in (D14). Every
  change is traced (who, what, when).
- **D10 - Only an admin edits a profile**, every field, name included. A person asks for a
  correction from a button on their Canari profile; it lands in an admin queue, the admin applies it
  and the person is notified.
- **D11 - Enrolment asks: campus first, then boxes.** "I am / was a student" -> formation + entry
  year (one cursus at enrolment; a second one is added by an admin); "I work for" -> EMSE / ME /
  Alumni, zero to three. At least one cursus or one post is required.
- **D12 - Nobody outside the boxes gets in**: a CAS account that fits no box (visiting researcher,
  contractor) is refused at enrolment.
- **D13 - Staff need nothing beyond organisation and campus.** Fine-grained rights are NOMINATIVE
  (D19).
- **D14 - A change takes effect at the next sign-in.**

**Who reaches which application - decided centrally by MiConnect (D15)**, one authentik policy per
application computed from the same profile, so no application keeps a hard-coded `'ICM'`:

| Application | Who may sign in |
| --- | --- |
| Canari | any valid profile |
| Sky | a cursus ICM (unchanged) |
| MiGallery | any valid profile |
| Le Cercle | any valid profile - so its promo/formation must become optional |
| MinoWiki, Archives MINO | any valid profile |

**Inside Canari - spaces.**

- **D16 - A SPACE is a formation x campus pair** (ICM Saint-Etienne, ISMIN Gardanne, ...). What a
  reader sees is the UNION of the spaces their affiliations open.
- **D17 - A space exists only once an admin opens it**, and it is opened when a BDE is ready to
  govern it. Before that its members have the common modules and whatever targets them.
- **D18 - Common to every valid profile, with no border between spaces: messaging, forms/ticketing,
  the directory.** The existing block is the only boundary.
- **D19 - Feed, agenda and associations are per space, and an audience is FIXED BY THE AUTHOR, never
  chosen.** Most content is published by an association, so it inherits the association's space: an
  ICM post never lands in an ISMIN feed. An association therefore carries a campus and/or a
  formation. Reaching beyond it (an ICM Saint-Etienne association addressing the FSSS) is set by an
  admin on the association, and a nominative permission may WIDEN one post (the rare inter-campus
  case).
- **D20 - A new publishing entity type, "Institution"** (Ecole, ME, Alumni association), beside
  association and list, to publish in its own name and propose events. Its members are added
  NOMINATIVELY by an admin: declaring "personnel ME" proves nothing (D8) and only informs the
  directory.
- **D21 - Joining an association of another space opens its content** to that member.
- **D22 - One BDE per space**, designated in a rebuilt interface (the current way of choosing which
  association is the BDE is not good). It validates the agenda of its space; content crossing spaces
  is validated by the BDE of the ORIGIN association, once.
- **D23 - Moderation stays GLOBAL** (reports, hide, mute), as today.
- **D24 - Rules by population, plus nominative permissions that only ADD.** A nominative grant never
  removes what a population gives; removal is moderation's job. Grants are made by a global admin,
  or by a BDE for its own space; cross-space rights (widening, profiles, institutions) stay with
  global admins. The interface is a rebuild of the current reviewers page (`/admin/document-reviewers`).
- **D25 - Form prices keep their current criteria** (promo, formation, and the cotisation to the
  FORM's association, which already exists in `pricing/audience.ts`). No campus or post bucket, no
  cross-association cotisation.

**Migrating the existing accounts.**

- **D26 - Campus is deduced**: ISMIN -> Gardanne, everyone else -> Saint-Etienne; errors go through
  the correction button (D10).
- **D27 - The 14 "Personnel de l'ecole" and the account with no status become an EMSE post.**
- **D28 - The colle: a reminder first, then mandatory.** A Canari banner and a skippable MiConnect
  stage for promo N-1 (N the current year) as soon as the Alumni SSO works; from a date the user
  sets, the MiConnect stage blocks until the link is made.

## 3. Found on the way

- **A MiGallery API key travels in plain text in claims.** The property mapping `avatar` builds a
  URL carrying it, and it is attached to MinoWiki and Archives MINO, so any user of either can read
  it in their own id_token or userinfo. The value is not written here. Tracked in
  [backlog](backlog.md#p1---a-migallery-api-key-is-handed-to-every-user-of-minowiki-and-archives-in-their-own-claims-found-2026-09-29).
- **The Alumni source's `sso_url` is a placeholder** while the source is enabled and promoted.
  Whether its button renders on the sign-in page was not observed.

## 4. The technical plan - PROPOSED 2026-09-29, awaiting the user's validation

### Four facts the plan is shaped by

- **Canari never re-reads Authentik after the first sign-in.** `refreshToken`
  (`apps/core-service/src/auth/auth.controller.ts`) reloads only `admin`, and the session is 7 days
  IDLE with no absolute cap (`auth-sessions.service.ts`). An active user never passes through
  `oidc/callback` again, so "at the next sign-in" (D14) would be NEVER for Canari. Hence Canari, the
  editor, writes its OWN row in the same request (WP4), and the migration writes Canari's rows
  directly (WP3). D14 then holds for the other applications, which re-read claims at sign-in.
- **The `sub` every application holds is `hashed_user_id`** (`sha256("{pk}-{install id}")`, all nine
  providers), and authentik's user API cannot filter on it (`UsersFilter` has `uuid`, `username`,
  `attributes`... and no `uid`). So Canari must also receive the Authentik `uuid` to address a user
  it edits.
- **A client chooses its scopes, and old APKs request `openid profile promo name formation`.** New
  claims under a NEW scope would never reach an old client's login, so they are attached to the
  `profile` scope, which every client but the Cercle already requests (a scope may carry several
  mappings; `profile` carries two today).
- **`users` is ONE table in `auth_db`, read by raw SQL from social-service** (feed audience, promo
  floor, custom feed, rosters), and core serves promo/formation to pricing over HTTP. There is ONE
  `isBDE` association (27 members) among 47 associations and 44 lists (production, 2026-09-29), and
  no notion of campus anywhere in code.

### The work packages, in order

**WP0 - P1, independent, first: the MiGallery key in MinoWiki's and Archives' claims.** Remove the
`avatar` mapping from both providers (or give them a keyless avatar URL), THEN delete the key in
MiGallery's `/admin/api-keys` - deleting first breaks both apps' avatars. A MiGallery key is
`read`/`write`/`admin`, never per-route (`src/lib/server/permissions.ts`), so a `read` key reads
every read-scoped API. Canari, Sky and the Cercle send their own keys in a header and are not
affected. [backlog](backlog.md#p1---a-migallery-api-key-is-handed-to-every-user-of-minowiki-and-archives-in-their-own-claims-found-2026-09-29).

**WP1 - Authentik holds the profile; nothing observable changes.**

- `attributes.profile = {version: 1, campus: "saint-etienne" | "gardanne", cursus: [{formation,
  promo}], posts: ["EMSE" | "ME" | "ALUMNI"], firstName?, lastName?}` - the explicit names end the
  capitals heuristic for the 6 accounts (D10).
- A mapping on scope `profile` emits `campus`, `cursus` and `posts`; a second one, on Canari's three
  providers only, emits `miconnect_uuid` (`user.uuid`).
- `Promotion` and `Formation` are re-derived from `profile.cursus[0]`, and `First + Last Names`
  prefers the explicit names, so every consumer keeps working untouched. That is a shim, declared in
  [legacy-compatibility](legacy-compatibility.md) with its removal condition (WP9).
- The migration (D26, D27) is ONE idempotent `ak shell` script: a dry run printing every change,
  then the write; the old keys stay until WP9. Before it, the daily `authentik_db` dump is checked.

**WP2 - The enrolment flow (D11, D12, D7).** One flow bound to BOTH sources: campus (radio); "Je
suis ou j'ai été élève" (checkbox) -> formation + entry year; "Je travaille pour" -> three checkboxes
EMSE / ME / Alumni. A validation policy refuses "none of them" with the D12 message, and an
expression policy writes `attributes.profile`. `custom_statut`, `is-student`, `Merge attributes` and
the `Personnel de l'école` mapping retire with WP9.

**WP3 - Canari reads the profile.** A core migration adds `miconnectUuid`, `campus`, `cursus` (jsonb)
and `posts` (text[]); the callback REPLACES them wholesale (a claim that disappears clears, unlike
today). `promo` and `formation` stay as columns derived from the first cursus until every consumer
has moved (WP6). Backfill: a script run in `ak shell` emits `{uid, uuid, profile}` for every account,
imported into `auth_db` in one transaction - the only way to reach users who will never sign in
again. Profile and directory show campus, cursus and posts; the directory gains campus and post
filters.

**WP4 - Editing from Canari (D9, D10).**

- An authentik service account with an RBAC role limited to viewing and changing users; its token is
  a new secret (`infrastructure/MIGRATION.md`). **Production only**: dev and production share ONE
  MiConnect, so a dev edit would change a real person - on dev the endpoint refuses with a typed
  error, and dev holds no token.
- `PUT /users/:id/profile` (global admin): read the authentik user by `uuid`, write
  `attributes.profile` (a read-modify-write of the whole `attributes`, which a PATCH replaces), then
  Canari's row, then an audit row `profile_changes(user, actor, before, after, at)`.
- The correction request (D10): a button on the profile, a queue in `/admin`, a notification when it
  is applied or refused. Every string through Paraglide.

**WP5 - Access to each application, decided by MiConnect (D15).** Expression policies bound to the
applications, engine mode `any`: `profile-valid` on all of them except Sky, which gets `cursus-icm`;
and on each application a group `acces-<app>` for nominative exceptions (Sky's non-ICM admins,
today `SKY_ADMIN_SUBS`, move there). Then, and only then, the applications: Sky DELETES its ICM gate
(callback and `hooks.server.ts`) rather than keeping a second copy; the Cercle drops `promo` and
`formation` from `requiredClaims`, makes both columns nullable (a STRICT table, so a rebuild
migration), and its UI stops assuming them.

**WP6 - Spaces in Canari (D16 to D22), five pull requests.**

- **6a, data.** `spaces(id, formation, campus, opened_at, bde_association_id)`,
  `association_spaces(association, space)`, `post_extra_spaces(post, space)`, and
  `associations.type` gains `institution`. Migration: open `ICM x saint-etienne`, attach every
  existing association and list to it, make today's `isBDE` association its BDE. The `isBDE` column
  is deleted at the end of 6c, never kept beside the new model.
- **6b, readers.** ONE function, `readerSpaces(user)`: the open spaces matching (a cursus's
  formation, the person's campus), plus the content of the associations they belong to (D21). It
  replaces `feed-audience.ts`, its client twin `feedAudience.ts`, the announce scheduler's audience
  and the agenda filter. A post is visible when its association's spaces, or its extra spaces, meet
  the reader's.
- **6c, governance.** Validating an event is VALIDATE_EVENTS in the BDE of the event association's
  space, and only those people are notified; the BDE's MANAGE_ASSO powers are scoped the same way;
  MODERATE stays global (D23).
- **6d, admin UI.** A spaces page (open a space, designate its BDE) replaces the `isBDE` toggle; an
  association's spaces are edited there.
- **6e, institutions.** Created by a global admin, members added nominatively (D20); they publish and
  propose events like an association.

**WP7 - Nominative grants (D24).** `grants(user, capability, space NULL, granted_by, at)`, add-only;
`document_reviewer_grants` migrates into it and `/admin/document-reviewers` becomes the permissions
page. A BDE grants within its space; cross-space capabilities (widening a post, institutions,
profiles) stay with global admins.

**WP8 - The colle (D28), BLOCKED on the Alumni SSO existing.** A real `sso_url` and mappings (name,
alumni id) on the `alumni` SAML source, bound to WP2's flow; a claim `alumni_linked`; a Canari banner
for promo N-1; a stage in `miconnect-auth`, skippable before the date the user sets and blocking
after it. authentik links a source to the account that is ALREADY signed in, which is exactly the
colle - to be proven on dev with a real alumni account.

**WP9 - The shims go.** The `promo`/`formation`/`school_status` claims and columns and the old
attribute keys, once nothing reads them - each removal measured, per
[legacy-compatibility](legacy-compatibility.md).

**Dependencies.** WP0 whenever. WP1 -> WP2 and WP3; WP3 -> WP4 -> WP5; WP3 -> WP6 -> WP7; WP8 waits
for the SSO; WP9 last.
