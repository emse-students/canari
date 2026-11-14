# MiConnect profiles and access - the reform (decided with the user, 2026-09-29)

> **Without an account, see [What Canari serves without an account](anonymous-surface.md)** (owner,
> 2026-11-02): nothing a signed-out visitor reads may go further than portail-etu.emse.fr shows. A
> profile's memberships and past roles need a session since that day.

**Status (2026-10-01): WP0, WPA and WP1 are BUILT AND LIVE on production (2026-09-30); WP2 is BUILT AND
TESTED, ON `main`, AND REACHES PRODUCTION WITH THE NEXT STABLE; WP3 is BUILT (backend, backfill, directory), WP4 to WP9 are PLANNED**. Every answer below was given by the user on
2026-09-29, one question at a time. The technical plan that turns them into work packages is section 4,
VALIDATED the same day. Sections 1 and 3 describe production as measured BEFORE WP0/WP1: read them as the
starting point, not as today's state. Anyone can log in to MiConnect with a School CAS account (and soon a Mines Saint-Etienne
Alumni SSO account), so who a person is, and what that opens, has to be modelled rather than
inferred from one self-declared string.

> **Proposed reform (2026-11-02, partly decided):** audience and dependencies as two independent axes -
> an association or list under at most one BDE, one governor per space - amending D20, D22, D23,
> D33 and D39. See
> [spaces-and-audiences-reform](spaces-and-audiences-reform.md).

## 1. What exists today (measured on production, 2026-09-29 ~14:36 UTC)

Read with `ak shell` on the identity-provider host, read-only. Counts are a
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
group is the identity provider's administrators group. **No application has an access policy**: every account
can sign in to all nine.

**The population.** 600 `external` accounts, a few `internal` ones and 1 service account.

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
1816 - the validator accepts anything. 6 accounts have no all-capitals word in their name, so their
`lastName` is empty - **and none of them is a person** (read 2026-09-30): authentik's
`AnonymousUser`, a `service-account` and the four campaign test accounts. Every real
account splits. The `1816` was an internal admin account the user DELETED as dead the
same day.

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
- **D4 - Formations: ICM, ISMIN, FSSS (formation sous statut salarie), PDIS, Autre** - one bucket for
  masters, doctorates and the rest, no sub-values. **PDIS added 2026-10-04 (user), same shape as the
  others and nobody in it yet**: the list lives in `SPACE_FORMATIONS` + migration 071 (social-service),
  `FORMATIONS` (frontend, ONE list: `profileEdit.ts` re-exports it), `FORMATIONS` in core-service
  `miconnect-profile.ts` (it VALIDATES a profile edit's cursus - a person in PDIS would be refused
  without it) and the enrolment prompt of `20-enrollment.yaml` (authentik). The blueprint reaches
  production by itself: every stable release runs `apply-blueprints.sh apply` (`serve-prod.yml`).
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
  **RELAXED 2026-10-04 (user): every formation x campus pair exists from the start; nothing is opened.**
- **D18 - Common to every valid profile, with no border between spaces: messaging, forms/ticketing,
  the directory.** The existing block is the only boundary.
- **D19 - Feed, agenda and associations are per space, and an audience is FIXED BY THE AUTHOR, never
  chosen.** Most content is published by an association, so it inherits the association's space: an
  ICM post never lands in an ISMIN feed. An association therefore carries a campus and/or a
  formation. Reaching beyond it (an ICM Saint-Etienne association addressing the FSSS) is set by an
  admin on the association, and a nominative permission may WIDEN one post (the rare inter-campus
  case).
  **AMENDED FOR INSTITUTIONS ONLY (owner, 2026-11-10): an institution CHOOSES the reach of each
  post** - the spaces it targets, inside the audience the admin gave it (never wider: the server
  refuses anything else), and the public in them (Tous / Étudiants / Personnel), with no default and
  editable after publishing both ways. Associations, lists and personal posts keep the rule above
  ([as built](#an-institutions-reach-per-post-as-built-owner-2026-11-10)).
- **D20 - A new publishing entity type, "Institution"** (Ecole, ME, Alumni association), beside
  association and list, to publish in its own name and propose events. Its members are added
  NOMINATIVELY by an admin: declaring "personnel ME" proves nothing (D8) and only informs the
  directory. Since 2026-11-02 the server holds "an admin" to the PLATFORM administrator: adding,
  editing or removing an institution's member is a 403
  `ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY` for anyone else, its own members and a BDE
  super-admin included, and handing one of its members `MANAGE_MEMBERS` is a 400 of the same code
  ([association-permissions](association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02)).
  **No BDE manages an institution, ever** (owner, 2026-11-02: "une institution n'a personne au
  dessus"): its audience reaching a BDE's space confers no super-admin tier (archive, members,
  profile, audience, delete). `holdsBdeFlagOverSql` carries the condition once, so every management
  caller inherits it; only its own members, within their flags, and the platform admin manage it.
  **AMENDED by WP-D2 (2026-11-07): an institution has no parent, and the predicate tests its type even
  for a hand-written one** ([reform 2.4](spaces-and-audiences-reform.md#24-who-governs-what-and-how-the-predicates-change)).
  **But the agenda is the BDE's** (owner, 2026-11-03: *"Aucun BDE n'a les droits de gestion sur une
  institution, mais c'est le BDE qui a tous les droits sur l'agenda des formations dont il est le
  BDE"*): event validation follows the spaces an event TARGETS, not who governs its organiser, so the
  BDE of those spaces validates, rejects and holds every agenda right over an institution's event
  (`holdsBdeAgendaRightOverSql`). Until WP-E brings per-slice validation, an institution's event is
  validated by a BDE governing the spaces it targets, or by the platform admin
  ([association-permissions](association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02)).
- **D21 - Joining an association of another space opens its content** to that member.
- **D22 - One BDE per space**, designated in a rebuilt interface (the current way of choosing which
  association is the BDE is not good). It validates the agenda of its space; content crossing spaces
  is validated by the BDE of the ORIGIN association, once. **AMENDED by WP-D1 (2026-11-03): a space's
  governor may be an institution (it answers for the agenda and manages nothing), designating one no
  longer writes an audience rule, and every change is journaled**
  ([reform 2.8](spaces-and-audiences-reform.md#28-wp-d1-as-built-2026-11-03---built-its-three-migrations-held-for-the-owner)).
  **AMENDED by WP-D2 (2026-11-07): the BDE of a space no longer governs the associations whose
  audience reaches it.** An association or list is governed (`MANAGE_ASSO`, `MODERATE` over what it
  publishes, deletion - E3) by its PARENT BDE only (`parentAssociationId`); with no parent, or a
  parent governing no space, by the platform admin alone. The space's BDE keeps the AGENDA of its
  space and its students' personal content
  ([reform 2.4](spaces-and-audiences-reform.md#24-who-governs-what-and-how-the-predicates-change)).
- **D23 - Moderation stays GLOBAL** (reports, hide, mute), as today. **AMENDED 2026-11-02 (owner):
  a BDE's `MODERATE` is SCOPED to the spaces it governs, and editing another person's post is nobody's
  power** - read [D23 amended](#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02).
  **Since WP-D2/WP-R4 (2026-11-07) an association's content is moderated by its PARENT BDE**, not by
  the BDEs of the spaces it reaches.
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

**The 2026-09-05 direction this model replaces.** The user had asked to separate ICM and ISMIN
*"comme si on avait deux instances de Canari. Seule la partie admin et la messagerie/communautes
doivent etre en commun"*, parked on three questions the code could not answer. D16-D23 answer all
three: a person may hold both (D1, union of spaces), administration and moderation are global (D23,
D24), and a member sees another space's associations only by joining one (D19, D21). The
cartography and the portal follow the association's spaces (WP6), so no separate per-school flag is
built.

**Answered while writing the plan (second round, same day).**

- **D29 - WP0 builds a keyless avatar URL FIRST**, then switches MinoWiki and Archives to it, then
  revokes the key - no avatar is lost, and the key stays exposed until then.
- **D30 - The agenda stays PUBLIC, per space**: each open space has its own anonymous feed and
  `.ics`, as today's single feed. **Amended 2026-10-06 (D40): the feed of a selection needs a link the
  server SIGNED for the reader's own spaces** ([D40 amended](#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)).
- **D31 - A personal post inherits its AUTHOR's spaces.** **Amended by the owner on 2026-11-02**:
  someone with no space (a staff post only) MAY publish a personal post, and it is visible to their
  ACCEPTED FOLLOWERS only (and to its author; a platform admin opening it by id) - the WP-F5
  follower disjunct, no space rule reaching anyone. No code change: nothing refuses the write, and
  the predicate already answered so. Pinned in `follower-visibility.integration.spec.ts` ("a person
  with NO SPACE may publish a personal post"). Speaking for an institution stays MEMBERSHIP ONLY
  (user, 2026-10-05): through institutions they are a member of, nothing more.
- **D32 - Two cursus pay the MOST FAVOURABLE price**: the matrix is evaluated for each cursus and the
  cheapest cell wins. A question shown to, or a submission allowed for, any of their cursus is shown
  or allowed.
- **D33 - A post chooses its own visibility (user, 2026-10-04), amending D19's "fixed by the author".**
  An entity's audience rules are its CEILING - what it may address: the School everything, each of
  the two MEs its campus, an association its own. A post with no rule inherits them; an author may
  give it rules of its own, and the server refuses any outside the ceiling. Going beyond is the
  nominative grant of D24. One mechanism for associations, lists and institutions alike, so no
  entity needs a special case. **The ceiling no longer decides who governs (WP-D2, 2026-11-07)**: an
  audience edit can neither take an entity over nor hand it away; the parent writes its child's
  ceiling inside its own spaces only (G8), and a wider rule is the platform admin's.

## 3. Found on the way

- **A MiGallery API key travels in plain text in claims.** The property mapping `avatar` builds a
  URL carrying it, and it is attached to MinoWiki and Archives MINO, so it was readable in a claim. The value is not written here. Closed by WP0 on 2026-09-30
  ([section 4](#the-work-packages-in-order)).
- **The Alumni source's `sso_url` is a placeholder** while the source is enabled and promoted.
  Whether its button renders on the sign-in page was not observed. The SP metadata the IdP needs
  is served and was measured 2026-10-22 ([authentik](infrastructure/authentik.md#the-alumni-saml-source-what-to-hand-the-idp-and-what-is-still-missing-2026-10-22)).

## 4. The technical plan - VALIDATED by the user 2026-09-29

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
- **A user id is visible ASCII (0x21-0x7E, no whitespace) with no `:`, BY CONSTRUCTION (2026-10-22).** 64-hex in practice
  (the `sub` above), but nothing required it: `users.id` is a raw `varchar(255)`
  (`users/entities/user.entity.ts:7-9`). One validator, `userIdRuleBroken` / `assertMintableUserId`
  in `apps/core-service/src/users/user-id.ts`, runs at the two places an id is made - the sign-in
  callback (`auth/auth.controller.ts`, right after the `sub` check) and the administrator's
  `UsersService.create` - and refuses with a typed 400 `USER_ID_INVALID` naming the broken rule,
  logged at ERROR without the id (worded by `auth_user_id_invalid` on the sign-in screen). WHY:
  every comparison of a user id lowercases ASCII letters only (`canonicalUserId` in
  `frontend/src/lib/mls-client/leafIdentity.ts`, `canonical_identity` in mls-core), while stored
  rows were lowercased with full Unicode - the two agree on ASCII alone; and the MLS device identity
  `userId:deviceId` is split on its one colon; and the client stores a sender trimmed
  (`frontend/src/lib/db/messagePayload.ts`), so whitespace would make two ids one. The exact 64-hex
  shape is deliberately NOT required: a plain ASCII id made earlier keeps signing in. Counted
  read-only on 2026-10-23 before the rule merged: no existing id on either estate breaks it (every
  one is 64-hex).
- **A client chooses its scopes, and old APKs request `openid profile promo name formation`.** New
  claims under a NEW scope would never reach an old client's login, so they are attached to the
  `profile` scope, which every client but the Cercle already requests (a scope may carry several
  mappings; `profile` carries two today).
- **`users` is ONE table in `auth_db`, read by raw SQL from social-service** (feed audience, promo
  floor, custom feed, rosters), and core serves promo/formation to pricing over HTTP. There is ONE
  `isBDE` association (27 members) among 47 associations and 44 lists (production, 2026-09-29), and
  no notion of campus anywhere in code.

### The work packages, in order

**WP0 - P1, independent, first: the MiGallery key in MinoWiki's and Archives' claims (D29).**
MiGallery gains an avatar URL that needs no secret (it has none today: the route requires a session
or a key, and its `Cache-Control` is deliberately `private` because of the edge), the `avatar`
mapping switches to it, THEN the key is deleted in MiGallery's `/admin/api-keys` - deleting first
breaks both apps' avatars. A MiGallery key is
`read`/`write`/`admin`, never per-route (`src/lib/server/permissions.ts`), so a `read` key reads
every read-scoped API. Canari, Sky and the Cercle send their own keys in a header and are not
affected.

**WP0 is DONE (2026-09-30), in that order.**

1. MiGallery `v2.15.6` ([#371](https://github.com/emse-students/MiGallery/pull/371)) serves
   `/api/users/<id_user>/avatar?sig=<s>`, where `s = base64url(HMAC-SHA256(key, id_user))`, unpadded.
   A signature opens ONE avatar: a bad one gets `403`, no signature and no key gets `401`.
2. The `avatar` mapping computes the same value in Python from `MIGALLERY_AVATAR_SIGNING_KEY`, which
   is passed through the stack's environment file. MiGallery reads
   the same key as `AVATAR_SIGNING_KEY` from its GitHub secret.
3. Before saving, the switch evaluated the new expression for one account and fetched the URL.
   MiGallery answered `200`, and only then was the mapping saved.
4. The leaked key was deleted. It was MiGallery row 11 (`authentik`, scope `read`), matched by its
   hash prefix and label, never by its value.

Two things are worth knowing next time:

- **The edge blocks a `Python-urllib` user agent** with a `403` that never reaches MiGallery. The
  probe's first attempt read as a signature mismatch. It needs a browser user agent.
- **MinoWiki and Archives may still hold the old URL**, with the dead key, for an account that has
  not signed in since the switch. That URL now gets a `401`. The next sign-in replaces it, and nothing
  is exposed by it.

Legacy key-in-URL access on the MiGallery side is tracked privately for removal.

**WPA - authentik as code, BEFORE WP1 (user, 2026-09-29: *"on a tout fait à la main, peut-être
qu'on peut faire mieux et plus propre, homogène"*).** Every custom object - flows, stages, prompts,
policies, mappings, sources, providers, applications, the brand and its CSS - becomes an authentik
BLUEPRINT in `infrastructure/authentik/blueprints/`, mounted at `/blueprints/custom` and applied by
the worker, secrets through `!Env`. Then the restore path holds by construction instead of by the
paragraphs of [authentik](infrastructure/authentik.md) listing hand mutations to redo, and WP1/WP2
are written as blueprint diffs, reviewed in a pull request, rather than `ak shell` sessions. The
same pass settles homogeneously what the audit found and left
([authentik](infrastructure/authentik.md#the-hand-built-configuration-audited-2026-09-29)): one
naming scheme, PKCE `S256` on the CAS source (one sign-in by a human proves it), launch URLs on the
final names, the Cercle's token lifetimes justified or aligned, the OOBE blueprint back to
`successful`. **Decided by the user the same day: the plan is validated, WP0 then WPA; the
blueprints ship with the RELEASE pipeline** (the deploy library copies `compose.yml` and
`blueprints/` to the host, no fifth visible workflow). A DEV instance of authentik was decided the
same day and **REVERSED on 2026-09-30 - ONE authentik instance, full stop** (user: *"je ne veux pas
de https://auth-dev.canari-emse.fr ou autre ... Une seule instance d'authentik"*). The only change
still owed by the DSI is `auth.canari-emse.fr` -> `miconnect.emse.fr`, already requested. So a flow
change is proven by the CI instance (fresh, then upgraded) and a dry run on production, and the
profile editor (WP4) is tried on the production instance with test accounts. **Second round, same day:** internal NAMES in English with a
`miconnect-` prefix (`miconnect-enrollment-prompt-cursus`, `miconnect-claim-promo`), displayed TEXT
in French in the "tu" register; the Cercle's 30 s / 2 min tokens are KEPT and documented, because it
reads the verified id_token once at its callback and discards the rest
(`le-cercle/src/lib/server/auth/authentik/index.ts`), so nothing ever uses those tokens later.

**WPA is two pull requests, both MERGED AND APPLIED to production on 2026-09-30.**

1. **WPA-1: the blueprints describe production as it IS, and a release applies them.** Every name
   and value is kept, so no behaviour changes. The proof: a fresh instance built from the files
   equals production field by field, with one exception, a trailing newline no blueprint can write
   ([authentik](infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30)).
   Production was prepared first, the same day. Its `.env` gained `MICONNECT_CAS_CONSUMER_SECRET`,
   read from the database and never printed, and only the worker was recreated, so sign-in stayed
   up. The dry run then reported exactly the predicted 1 change; `apply` wrote it, and a second dry
   run reported 0.
2. **WPA-2: the normalization**, as blueprint diffs (2026-09-30):
   - the `miconnect-` names: 26 objects, each renamed IN PLACE by a conditioned entry, and every
     name another system holds kept
     ([authentik](infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30));
   - PKCE `S256` on the CAS source: the CAS redirect carries `code_challenge_method=S256` since
     the apply, and **the user's own sign-in PROVED it** (MiGallery, 2026-09-30 19:18 UTC: the CAS
     callback, `login`, then `/application/o/token/` `200`);
   - launch URLs on the names that answer: `cercle.emse.fr`, `mino.emse.fr` (and MinoWiki's
     `logout_uri`), `sky.emse.fr`. The old hosts `301` there. Archives and
     MiGallery keep theirs, having no final host yet;
   - every provider allows `authorization_code` and `refresh_token`, nothing else. The evidence,
     read on production: every client that is code here sends `grant_type=authorization_code`; the
     `/authorize` log holds 198 of 198 `response_type=code`; since 2026-03-05, no `login` event
     carries a token/app-password method, and no device token exists;
   - the brand's unset `flow_invalidation` / `flow_user_settings` STAY unset. authentik looks a
     missing brand flow up by designation, measured: `/flows/-/default/invalidation/` answers
     `302` to `default-invalidation-flow`. The settings flow is WP4's to decide;
   - the brand CSS header no longer says "paste this into the admin UI";
   - the OOBE instance: re-applying it changes no object (measured, rolled back), so the `error` is
     a status only. **Reset on production 2026-09-30 with the user's go**, through authentik's own
     `apply_blueprint` task: 31 of 31 `successful`, sign-in unchanged;
   - **the `Portail Etu` provider and application are DELETED** (user, 2026-09-30), as `state:
     absent` entries. 949 authorizations for 81 people from April to 2026-07-01, none since; its
     callback `portail-etu.emse.fr/auth/callback` is a `404`, and the refonte has no sign-in.

   **Applied by hand on 2026-09-30 with the user's go**, before any release: 105 changes, the two
   deletions, row counts otherwise unchanged; the dry run after it reported 0, and `/authorize`
   still answers `302` to `miconnect-auth`. The next stable re-applies and reports 0.

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

**WP1 as built (2026-09-30)**, with two decisions the user took that day:

- **`Master` becomes `Autre` EVERYWHERE, at once** - the profile AND the `formation` claim, so WP1
  is NOT invisible for those 14 accounts. What reads the value: MiGallery grants 21 albums to
  `formation = Master` and offers it as a choice (converted in the same minute, and its choice list
  by its own PR); Canari has no form or product naming it; Sky reads `ICM` only; the Cercle already
  has an `autre` bucket.
- **The explicit names are the capitals split the name mapping made**, so no real account's
  `firstName` / `lastName` changes. The accounts authentik owns - `AnonymousUser` and outpost service
  accounts - get no profile.
- `infrastructure/authentik/migrate-profile.sh dry-run|apply` writes a profile ONLY where there is
  none, so a re-run never overwrites enrolment's or an admin's. Enrolment builds the same profile,
  in `miconnect-enrollment-merge-status`, by the same rules; the enrolment choice `Master` is `Autre`.
- `miconnect-claim-profile` (scope `profile`, every provider) emits `campus`, `cursus`, `posts`;
  `miconnect-claim-uuid` (scope `profile`, Canari's three providers) emits `miconnect_uuid`.
- **Proven before any write.** Locally: five accounts shaped like production's, the claims each
  mapping emits, the enrolment policy on a student and a staff submission, a second migration
  writing 0. On production, read-only: the claims today against the claims from the migrated
  profile, for 607 accounts - the ONLY differences were 14 `Master -> Autre` and one deleted admin account's `1816`.
- **The order on production is forced**: the name, formation and promo claims read the profile
  only, so the migration is written BEFORE the blueprints are applied, and run again after them
  for anyone who enrolled in between.
- **Switched on production 2026-09-30, with the user's go**, in that order: 606 profiles written
  (2 skipped: `AnonymousUser`, the outpost), the blueprints applied (15 changes), MiGallery's 21
  `formation = Master` album grants turned `Autre` right after them, the second pass writing 0 and a
  blueprint dry-run saying `0 change(s)`. Then, read-only, the claims every one of the 606 accounts
  now receives against the claims it received before: the ONLY difference is 14 `Master -> Autre`.
  **This was applied from the PR's branch, so a stable cut from a `main` without it would apply the
  OLD mappings back** - the PR merged before any release.

**WP2 - The enrolment flow (D11, D12, D7).** One flow bound to BOTH sources: campus (radio); "Je
suis ou j'ai été élève" (checkbox) -> formation + entry year; "Je travaille pour" -> three checkboxes
EMSE / ME / Alumni. A validation policy refuses "none of them" with the D12 message, and an
expression policy writes `attributes.profile`. `custom_statut`, `is-student`, `Merge attributes` and
the `Personnel de l'école` mapping retire with WP9.

**WP2 as built (2026-10-01).** ONE flow, `miconnect-enrollment` - the former `miconnect-enrollment-cas`,
renamed in place so the CAS source keeps pointing at it - and BOTH sources (`cas-emse`, `alumni`)
enrol through it (D7). The alumni flow and the old status question are deleted.

- **Page 1**: campus (radio, `saint-etienne` / `gardanne`, the person's own choice - D6, never
  deduced from the formation as the migration did), "Je suis ou j'ai été élève", and three checkboxes
  "Je travaille pour" EMSE / la Maison des Élèves / l'association des Alumni. The policy
  `miconnect-enrollment-validate-affiliation` refuses a page with no box ticked and says why, in
  French (D12). A checkbox is `required: false`, otherwise authentik demands that it be ticked.
- **Page 2** (formation + entry year) is bound to `miconnect-enrollment-is-student`, so a person who
  only ticked a post is never asked for a cursus. An impossible year is refused WITH a message; it
  used to re-show the page with none.
- **The profile** is written by `miconnect-enrollment-merge-status`: the campus, one cursus when
  student, a post for each box ticked (so a cursus AND a post are cumulative - D1), the explicit
  names. It keeps writing `school_status` (`Elève` / `Personnel de l'école`) and the `formation` /
  `promo` attributes, for the legacy claims until WP9.
- **Proven by DRIVING the flow, not by evaluating its policies.** `test-enrollment-flow.py` seeds a
  plan the way a source does and posts through authentik's own executor: a student, an ISMIN student
  who chose Saint-Etienne, staff on two posts, a student who is also an alumni post, a page with no
  box, an impossible year. It runs in CI after the blueprints' idempotence check, and was seen to
  FAIL with the D12 guard removed. Two traps were in the test and not the flow: authentik's session
  cookie is a signed JWT (a bare session key is ignored outside TEST and the executor quietly plans
  anew, with an empty context - the username "vanished"), and a completed POST answers with a redirect.
- **Not observed**: a real first CAS sign-in through the new pages - every account already exists, so
  nothing on production can exercise it. The first new person is the observation.
- **It reaches production with the next stable** (the release applies the blueprints): no order
  constraint, unlike WP1. The pre-release's dry run against production shows the diff first.

**WP3 - Canari reads the profile.** A core migration adds `miconnectUuid`, `campus`, `cursus` (jsonb)
and `posts` (text[]); the callback REPLACES them wholesale (a claim that disappears clears, unlike
today). `promo` and `formation` stay as columns derived from the first cursus until every consumer
has moved (WP6). Backfill: a script run in `ak shell` emits `{uid, uuid, profile}` for every account,
imported into `auth_db` in one transaction - the only way to reach users who will never sign in
again. Profile and directory show campus, cursus and posts; the directory gains campus and post
filters.

**WP3 as built (2026-10-01).**

- Migration `apps/core-service/src/migrations/008_user_miconnect_profile.sql`: `miconnectUuid`
  (unique where set), `campus`, `cursus` jsonb NOT NULL default `[]`, `posts` text[] NOT NULL default
  `{}`. Idempotent; run twice on a throwaway Postgres.
- `users/miconnect-profile.ts` parses the claims (`parseProfileClaims`): an absent or malformed claim is
  the EMPTY value, an unknown campus/post or a malformed cursus entry is dropped with a warning. `findOrCreateFromOidc`
  takes that profile, REPLACES the columns, derives `promo`/`formation` from `cursus[0]` (a person
  with no cursus now has them cleared - before, a claim that vanished was kept) and writes only when
  something changed. The legacy `promo`/`formation` claims are no longer read: WP1 derives them from the
  same profile, so reading both was two sources for one fact.
- Backfill: `infrastructure/authentik/backfill-canari-profiles.sh dry-run|apply` exports
  `{uid, uuid, profile}` through `ak shell` (`export-profiles.py`, read-only; `uid` is the
  `hashed_user_id` that `users.id` holds) and runs ONE transaction against `auth_db` (container
  chosen by compose label). `dry-run` rolls back and prints updated / exported / users. Tried
  end to end against a throwaway Postgres with a stubbed export: dry-run left 0 rows, apply wrote them,
  a second apply was identical, a row the export did not name was untouched.
  **Prod: apply it AFTER the migration has run (the next deploy), with the user's go.**
- API: `PublicUserDto` and the directory row carry `campus`, `cursus`, `posts`; `/users/directory`
  takes `campus` and `post` filters (either alone is a valid filter). `miconnectUuid` is never public.
- Frontend: the directory shows each cursus entry, the posts and the campus, and filters on campus
  and post (Paraglide keys `directory_label_campus`, `directory_label_post`, `profile_campus_*`,
  `profile_post_*`). The profile page (own and by id) shows them as ONE muted line since 2026-11-10 (`ProfileSummaryLine.svelte`, reading `cursus` only, so a person not yet backfilled shows no entry until the backfill or their next sign-in).
- **Not observed**: a real sign-in writing the columns on dev/prod.

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

**WP4 as built (2026-10-04), in two pull requests.**

**4a - the editor account, the endpoint, the audit.**

- **The account is code**: `infrastructure/authentik/blueprints/80-profile-editor.yaml` builds the
  service account `miconnect-canari-editor`, the role `miconnect-profile-editor` (global permissions
  `view_user` and `change_user`, nothing else), the group `miconnect-profile-editors` that carries the
  role to the account, and its API token (`expiring: false`). The token key is `!Env
  MICONNECT_EDITOR_TOKEN` from the stack's environment file, declared with `:?` in the stack's `compose.yml`,
  so a `.env` that forgets it fails the start and the applier refuses an unresolved `!Env` before it
  commits. **The same value is the GitHub secret `MICONNECT_EDITOR_TOKEN`** that production's
  core-service reads ([MIGRATION](../../infrastructure/MIGRATION.md)).
- **Proven by USING the token**, not by listing permissions: `test-profile-editor.py` runs in CI after
  the blueprints' idempotence check and calls authentik's real API with the token. It reads a user by
  `uuid`, PATCHes `attributes`, and sees `403` on creating a user, deleting one and changing a flow.
  Two things it found: authentik's token serializer overwrites `expires` at every apply, which made a
  second apply report a change forever (the applier now ignores `expires` on a non-expiring token),
  and the token `key` must be digest-compared, never printed (`SECRETS`).
- **`PUT /users/:id/profile`** (global admin, `ProfileEditService`): validates the whole profile
  (campus, cursus entries of ICM / ISMIN / FSSS / Autre with a plausible year, posts, both names;
  D11 enforced), reads the authentik user by the person's `miconnectUuid`, writes
  `attributes.profile` as a read-modify-write of the WHOLE `attributes` (authentik's PATCH replaces it)
  plus the user's `name`, then in ONE transaction Canari's row (the four columns, `promo` and
  `formation` derived from the first cursus, the names, `displayName`) and the audit row
  `profile_changes(userId, actorId, before, after, at)` (migration `009`). `before` is what authentik
  held. An edit that changes nothing writes nothing at authentik and leaves no audit row. A failure at
  authentik stops everything; a failure after it is logged at `error` as the two sources disagreeing
  until the person's next sign-in re-reads the profile into Canari.
- **Refusals are TYPES with a stable `code` in the body**, never prose to branch on
  (`profile-edit.errors.ts`): `PROFILE_EDIT_DEV_ESTATE` (403), `PROFILE_EDIT_NOT_CONFIGURED` (503),
  `PROFILE_EDIT_NOT_LINKED` (409, no `miconnectUuid` yet), `PROFILE_EDIT_UPSTREAM` (502),
  `PROFILE_EDIT_INVALID` (400, with the problems per field).
- **How Canari knows it is dev**: `DEPLOY_BUILD`, which the dev deploy renders and production
  deliberately does not (`platform/deploy-build.ts`, `isDevEstate`). It is used only to REFUSE, and
  never alone: dev also holds no token (`env-manifest.tsv`: `warn` on production, `skip` on dev;
  absent from `docker-compose.dev.yml`, asserted by `compose-wiring.test.sh`). Losing the variable on
  dev would degrade to `NOT_CONFIGURED`, never to an edit of a real person. On production, a missing
  token is logged at `error`, the refusal being a deployment fault.
- **Not observed**: a real edit against production's authentik. The first one is the observation.
- **To do by the user, before the first edit**: create the secret value, put it in the MiConnect
  stack's `.env` AND in the GitHub secret `MICONNECT_EDITOR_TOKEN`; the next stable applies the
  blueprint (creating the account and token) and deploys core-service with it.

**4b - the correction request (D10), as built 2026-10-05.**

- **Request**: a person with no open one asks from their profile (`ProfileCorrectionRequest.svelte`,
  `POST /users/me/profile-correction`, message required). ONE OPEN REQUEST PER PERSON is a partial
  unique index over `pending`/`applying` (migration core `010`, table `profile_correction_requests`), so two clicks cannot queue
  twice; `GET /users/me/profile-correction` returns the open or latest answered one.
- **Queue**: `/admin/profile-corrections` (global admin), oldest first. **Apply** is the WP4a edit with
  the request id in the body (`PUT /users/:id/profile`, `ProfileCorrectionService.apply`). The request is CLAIMED (`pending` -> `applying`) BEFORE authentik is written, released if the edit fails, so two admins never both write; a crash mid-edit leaves `applying`. Ids are uuid-validated (typed NOT_FOUND), and the requester reads a projection without `resolvedBy`. The edit,
  the request's closing and `profile_changes.requestId` agree, so the audit reads "asked for, then
  done". **Refuse** is `POST /users/admin/profile-corrections/:id/refuse` with an optional note.
- **Notification**: core-service calls social's internal `POST /internal/notifications/profile-correction`
  (types `profile_correction_applied` / `profile_correction_refused`; the note rides in `text`; actor =
  the platform, never the admin). In-app only (`skipPush`): the native push tables have no sentence for
  the two types yet - the push is the follow-up.
- **Not observed**: any of it against the real authentik (the token `MICONNECT_EDITOR_TOKEN` is not
  set yet); tests use mocks.

**WP5 - Access to each application, decided by MiConnect (D15).** Expression policies bound to the
applications, engine mode `any`: `profile-valid` on all of them except Sky, which gets `cursus-icm`;
and on each application a group `acces-<app>` for nominative exceptions (Sky's non-ICM admins,
today `SKY_ADMIN_SUBS`, move there). Then, and only then, the applications: Sky DELETES its ICM gate
(callback and `hooks.server.ts`) rather than keeping a second copy; the Cercle drops `promo` and
`formation` from `requiredClaims`, makes both columns nullable (a STRICT table, so a rebuild
migration), and its UI stops assuming them.

**WP6 - Spaces in Canari (D16 to D22), five pull requests.**

- **6a, data.** `spaces(id, formation, campus, opened_at, bde_association_id)`,
  `association_audiences(association, formation NULL, campus NULL)` (rules, see 6a as built), `post_audiences(post, formation NULL, campus NULL)`, and
  `associations.type` gains `institution`. Migration: open `ICM x saint-etienne`, attach every
  existing association and list to it, make today's `isBDE` association its BDE. The `isBDE` column
  is deleted at the end of 6c, never kept beside the new model.
- **6b, readers.** ONE function, `readerSpaces(user)`: the open spaces matching (a cursus's
  formation, the person's campus), plus the content of the associations they belong to (D21). It
  replaces `feed-audience.ts`, its client twin `feedAudience.ts`, the announce scheduler's audience
  and the agenda filter. A post is visible when its own rules (else its publisher's) reach an open space
  the reader belongs to. **BUILT 2026-10-04 - see WP6b as built, below.**
- **6c, governance.** Validating an event is VALIDATE_EVENTS in the BDE of the event association's
  space, and only those people are notified; the BDE's MANAGE_ASSO powers are scoped the same way;
  MODERATE stayed global (D23) until 2026-11-02, when it was scoped too ([D23 amended](#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02)).
- **6d, admin UI.** A spaces page (open a space, designate its BDE) replaces the `isBDE` toggle; an
  association's spaces are edited there.
- **6e, institutions.** Created by a global admin, members added nominatively (D20); they publish and
  propose events like an association.

**WP6a as built (2026-10-04), with one decision the user took that day.** *"La ME de Saint-Etienne ne va
s'adresser qu'au Campus de Saint-Etienne, idem pour le pole Saint-Etienne de l'ecole"* - so who an
association (or list, or institution) addresses is a RULE, not a list of spaces. Migration
`apps/social-service/src/migrations/071_spaces.sql`: `spaces` (formation, campus, `openedAt`,
`bdeAssociationId`; unique pair, CHECKs on the D4/D6 values, one BDE per space and one space per
BDE), `association_audiences` (one row per rule, `formation`/`campus` where NULL means "any":
(ICM, saint-etienne) one space, (NULL, saint-etienne) the whole campus - the ME and the School's
pole there - and (NULL, NULL) everyone; an association has one or more rows, D19), `post_audiences` (the same rule shape, chosen by a post's author - see D33);
entities in `social-service/src/spaces/`. The rules are resolved against the OPEN spaces at read
time (6b), so a space opened later is reached with no edit to any association; a plan with explicit
association-to-space links would have left it unreached until an admin added it to each. Seed: ICM x
saint-etienne, every association and list addressing it, and the BDE set ONLY if exactly one
association carries `isBDE` (production has one, user 2026-10-04; zero or several: left NULL with a
notice - an admin designates it on the 6d page). Tried on a throwaway Postgres with one, zero and
two `isBDE`, replayed, a duplicate rule refused, a bad value refused, cascade. **Deferred to 6e on
purpose**: `associations.type` gaining `institution` (nothing could create one yet). **Settled the same day
(D33)**: there is ONE School, which may share with one campus or the other, and TWO MEs (one per campus). 6b reads them (below).

**WP6d as built (2026-10-04, on the 6a branch).** API in `social-service/src/spaces/`, all global-admin
only (`NginxAuthGuard` + `GlobalAdminGuard`), registered BEFORE `AssociationsController` so the literal
`associations/spaces` wins over `associations/:id`: `GET /api/associations/spaces` (every pair with its
BDE), `GET /api/associations/spaces/audiences` (the rules of EVERY association in one read, which is all
the grid needs to draw itself - replaced by the catalogue's per-row rules and removed at floor `1.6.6`), `PUT /api/associations/spaces/:id/bde` (designate or clear; only a
regular association, never a list; **the same association may be the BDE of several spaces - user,
2026-10-04, so the migration carries NO unique index on the BDE column**) and
`GET/PUT /api/associations/:id/audiences` (replace the rules in one transaction, de-duplicated; **an
empty set is allowed - the association then reaches nobody, user 2026-10-04**).

**D17 RELAXED (user, 2026-10-04): NO ONE OPENS A SPACE.** All ten pairs (5 formations x 2 campuses)
are seeded by migration 071, so there is no open/close route and no "open a space" form. D17's other
half stands: a pair with no BDE has no governance yet.

**The screen, `/admin/spaces` (nav entry "Espaces", global admins), is ONE GRID** (user: "une vue
globale", then "quelque chose a la Discord"): associations in rows; columns are "everyone", then per
campus a "whole campus" box and one box per formation. **Two levels, ticked like folders**: ticking a
campus ticks its five formations, unticking one formation leaves the campus half-ticked. The pure logic
is `lib/associations/audienceRules.ts`: the page reads the stored rules as a set of pairs and WRITES THE
SMALLEST EQUIVALENT RULE SET (all pairs = one `(null,null)`, a whole campus = one `(null,campus)`, else
pair rules), so a campus rule keeps covering a formation added later and the page always shows what is
stored. A star in the corner of a pair box makes the association the BDE of that pair. **A BDE always
reaches what it governs, and the SERVER holds that, not the page**: designating one adds the pair's
rule in the same transaction when its rules do not cover it, and a rule set submitted without a
governed pair gets it put back. The page shows that box ticked and locked until the star goes. A list
has no star.

**Post-level targeting (asked 2026-10-04; its SERVER half - rules on a post, held to the ceiling - shipped with 6b, the composer menu and the filters are a later PR):** a post's "Audience" menu in the advanced settings starts from its association's reach and may narrow it; on top of REACH (where) sit FILTERS (who, among those reached): promo (from the profile's cursus) and contributor status of the PUBLISHING association. Filters only narrow, so they cannot step over the ceiling; the server evaluates them and the author sees a count, never a list.

**WP6c, step 1 (2026-10-04): `isBDE` IS GONE.** `spaces/bde.ts` `isBdeAssociationSql` is the ONE
definition: an association is a BDE exactly when it is the BDE of at least one space. The three BDE
queries (`isUserBdeAdmin`, `callerHasAnyBdeFlag`, the proposal notification) use it; the entity's `isBDE`
is a read-only `VirtualColumn` derived from it, so every API and the frontend keep reading the same
field; the toggle that sat on the former `/admin/associations` page was a read-only badge, and that page was deleted 2026-10-07 (the star on `/admin/spaces` designates). Migration `072_drop_is_bde.sql`
drops the column and REFUSES while a flagged association governs no space (071 seeds a BDE only when
exactly one was flagged), so no one silently loses VALIDATE_EVENTS / MANAGE_ASSO / MODERATE. Tried on a
throwaway Postgres: drop, replay, refusal; the virtual column read against real rows.

**WP6c, step 2 (2026-10-04, branch `feat/spaces-6c-scope`, stacked on step 1): A BDE GOVERNS THE
ASSOCIATIONS ITS SPACES REACH.** One predicate, `spaces/bde.ts` `holdsBdeFlagOverSql(user,
association, flag)`: the user holds `flag` in the BDE of a space one of the association's rules
reaches. "The event association's space(s)" are therefore the spaces its rules reach - several:
the BDE of ANY of them; none: a global admin only. VALIDATE_EVENTS (validate, reject, edit, delete,
deposit, `break`, and who is TOLD of a proposal) and MANAGE_ASSO (the super-admin tier, `DELETE
:id`) read it; MODERATE stayed global (D23) until 2026-11-02 ([D23 amended](#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02)). An event is judged on its OWN association, read from the
row, never the URL's. The client draws per-association controls from `GET
/api/associations/me/bde-reach` and the pending queue's per-row `canValidate`. **Left unscoped on
purpose** (no association to scope to): creating an association, categories, carte, document
reviewers - WP7's question. Table, routes and proof:
[association-permissions](association-permissions.md#wp6c-step-2-a-bde-governs-the-associations-its-spaces-reach-2026-10-04).
**Production consequence**: while every association still carries 071's single (ICM,
saint-etienne) rule, the one BDE governs all of them and nothing changes; the scoping bites the day
the grid gives an association a reach outside its BDE's spaces.

**The super-admin writing a member row (owner, 2026-11-02).** The tier EXERCISES every right on
the associations it governs except `SUPER_ADMIN_EXCLUDED_FLAGS` (`POST_AS_ASSO`,
`MANAGE_PAYOUT_ACCOUNT`), but it may WRITE any flag into a membership row, its own included: a BDE
officer is often the president of another association and seats themself there with full rights.
Only an explicit row carries the two excluded rights, and every super-admin write that grants one -
or `MANAGE_PRODUCTS`, whose explicit row is what accepts a list's payment delegation - is logged at
info with the association and the flag names. An ordinary member holding `MANAGE_MEMBERS`
is capped at its own flags, granting, revoking and removing alike; any member leaves through the
"Quitter" button, except the last holder of `MANAGE_MEMBERS` (`ASSOCIATION_LAST_MEMBER_MANAGER`)
([association-permissions](association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02)).

**WP6b as built (2026-10-04)**, branch `feat/spaces-6b-readers`, stacked on 6a/6d. Every server
read that serves a post, an event or an announcement asks ONE module,
`social-service/src/spaces/reader-spaces.ts`; `posts/feed-audience.ts` ("ICM plus global admins")
is deleted, and the client no longer decides from `formation === 'ICM'`.

- **A reader's spaces** (`readerSpaces`, and its SQL twin `isReaderSpaceSql`): the pairs whose
  formation is one of their `cursus` formations AND whose campus is their `campus`. No campus or
  no cursus is no space. The SQL uses jsonb containment, so a malformed `cursus` matches nothing
  rather than failing every reader's query.
- **AN ADMIN BROWSES AS AN ORDINARY READER (user, 2026-10-04: "ce serait un peu le bordel sinon").**
  The feed, the search, the announcements and the agenda give a global admin exactly what their own
  spaces and memberships give: an admin who is an ICM Saint-Etienne student sees what an ICM
  Saint-Etienne student sees, and an admin with no space sees only what they wrote. What an admin
  keeps is OPENING one post BY ITS ID (a report or moderation link: `assertVisible`, option
  `adminSeesAll`) and the gate (they can reach the feed to moderate). Nobody else gets that.
- **A post is visible** (`postVisibleToUserSql`) to its author, to a member of its association (D21: any
  `association_members` row - there is no pending state), and otherwise when its association's
  rules reach one of the reader's spaces - or, since D38, when a REPUBLISHING association is
  visible to the reader the same way ([D38 as built](#d38-republication-as-built-2026-10-04)). The
  per-post `post_audiences` rules 6b first built are gone. A PERSONAL post (anonymous included) is visible to readers sharing at least one space
  with its author - and, since WP-F5, a NON-anonymous one to the author's accepted followers
  ([as built](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31)). Reels are posts here. Scheduled, hidden and expired-reel rules are unchanged.
- **The gate** (`FeedAudienceGuard`, `IN_FEED_AUDIENCE_SQL`): an admin, a reader with at least
  one space, or a member of at least one association (later: a named reader, an accepted follower,
  and - 2026-11-14 - staff of a campus an institution's rules reach, for the staff-by-campus door).
  **Readers**: `GET /api/posts` (all four
  feeds), `/search`, `/:postId`, `/:postId/calendar-link` and `/calendar-link/:eventId` apply
  the per-post predicate; a post the reader may not see is a **404** (before the moderation 403,
  which would confirm the id). Voting, reacting, commenting and liking a comment are refused the
  same way.
- **Announce**: the recipients of a post are everyone who can see THAT post, minus its author
  (`announceRecipientsSql`); a personal post's followers are told only if they can see it.
- **Agenda**: a SIGNED-IN reader's aggregated feed and per-association `/events` keep an event
  when its association - or, since D39, an ACCEPTED co-organiser (`eventVisibleToUserSql`) -
  reaches one of their spaces, or they are a member (an admin is an ordinary reader here, see
  above). The
  anonymous agenda and its `.ics` (D30) are unchanged: like the promo cutoff, this is relevance.
- **Post-level rules - REMOVED by D38** (migration 073 drops `post_audiences`; the DTO `audiences`,
  `rulesOutsideCeiling` and the read-time ceiling are deleted). A post's audience widens only
  through a republication.
- **Cache**: `SpacesService.setAudiences`/`setBde` and `addMember`/`removeMember` drop the
  feed cache (keyed per reader; no TTL was added). A change to a user's campus or cursus is
  served stale for at most the existing 30 s TTL.
- **Client**: `GET /api/posts/audience` -> `{ inAudience }`, the guard's own SQL. The verdict stays
  remembered per account for first paint and is revalidated behind it; only a boolean answer
  changes it.

**Proof.** `reader-spaces.integration.spec.ts` runs every fragment against a real PostgreSQL with
migration 071 (an ICM Saint-Etienne student and a second one, an ISMIN Gardanne student, an admin,
a staff member with no cursus who is a member, a reader with a campus and nothing else, a profile
not yet backfilled; an association on (ICM, saint-etienne), one on the whole Gardanne campus,
personal and anonymous posts, a post narrowed by its own rule) and asserts exactly who sees what,
the gate, the announce recipients and the agenda; it also proves `READER_SPACES_SQL` and
`readerSpaces` agree. A control (the read-time ceiling removed) made 4 of its 15 cases fail. The
service was then booted on a throwaway database with the same cast and every endpoint read per
reader: list (all, associations), search, one post, calendar link, the aggregated agenda (signed in
and anonymous, `.ics` included), a create refused outside the ceiling and on a personal post, and
the announce sweep's recipient counts.

**Judgement calls (the most conservative where it changed who sees what):**

- ~~A post's own rules are held to the ceiling at read time~~ and ~~the share preview skips a post
  with rules of its own~~ - both went with the rules themselves (D38).
- **A personal post by someone with no space** (staff; allowed, D31 as amended 2026-11-02) is seen
  by its author, an admin opening it by id, and - since WP-F5 - the author's accepted followers.
- ~~An association created after migration 071 has NO rule.~~ Superseded by D36 (below): it
  reaches its creator's spaces by default.
- The `custom` feed's promo/formation filters still read the legacy `users.promo`/`formation`
  columns; they only narrow, after visibility.

**PRODUCTION CONSEQUENCES - THE RELEASE ORDER IS FORCED.** The migration gave every existing
association the single rule (ICM, saint-etienne), so the moment this ships **only ICM x
Saint-Etienne readers see existing association posts**, until an admin edits the grid at
`/admin/spaces`. And a reader whose `campus`/`cursus` columns are still EMPTY - the WP3 backfill
(`infrastructure/authentik/backfill-canari-profiles.sh`) not yet applied, and they have not signed
in since - has no space: **they LOSE the feed** (unless a member of an association), where today
`formation = 'ICM'` lets them in. So, in this order: (1) the 6a/6d release (migration 071) and the
WP3 backfill applied on production with the user's go; (2) the grid set at `/admin/spaces` (every
association's real reach, the BDEs); (3) only then the release carrying 6b. A local preview running
an older social-service answers `/api/posts/audience` with a 400 (the `:postId` route): the client
keeps its remembered verdict, and the server must be restarted to show 6b.

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

**Dependencies.** WP0 whenever. WPA -> WP1 -> WP2 and WP3; WP3 -> WP4 -> WP5; WP3 -> WP6 -> WP7; WP8 waits
for the SSO; WP9 last.

## The access plan - who sees what (decided with the user, 2026-10-04)

Answered one question at a time on 2026-10-04. It removes the per-post space rules WP6b built (D38).
State: **built** = in a draft PR, **next** = decided, not built, **open** = to settle.

### D34-D36 - Who is who

| Population | Space | Sees student content | State |
| --- | --- | --- | --- |
| Student or alumnus (no distinction) | formation x campus (an alumnus keeps the former one) | what their spaces and memberships reach | built |
| Personnel (School, ME, Alumni association) | institution x campus | only by membership or an explicit rule; never a student's personal post, unless the student accepted them as a follower (decided 2026-10-25, built 2026-10-31 as WP-F5: [as built](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31)), or accepted an institution's request to carry it, which a staff member of that institution then reads (amended by the owner 2026-11-02 for this consented path only: [D38b amended](#d38b-amended---every-kind-may-ask-and-an-institutions-request-shows-its-audience-owner-2026-11-02)); a nominative read grant still never opens one (WP7) | built |

Order: WP6c (BDE per space, `isBDE` deleted) comes first (D35). A new association reaches its creator's
spaces by default (D36, built - see below; NOT an institution, which starts with no rule, WP6e). A personnel is DECLARED at enrolment, nothing more (user, 2026-10-04), and one person may be a student
and a personnel: the spaces add up. Being personnel gives NO right to publish as the School: that takes
membership of the institution's own instance, exactly as for an association. Everyone ticks `EMSE`, so that
box no longer defines anything.

### D37-D41 - What each surface shows

| Surface | Who sees it | State |
| --- | --- | --- |
| Association post | author; members; readers its association's audience reaches (or a republishing one's), passing the filters | built (filters not built) |
| Personal post | author and people sharing a space; the readers of an association, a list or an institution its author let carry it (D38b, every kind since 2026-11-02: [amended](#d38b-amended---every-kind-may-ask-and-an-institutions-request-shows-its-audience-owner-2026-11-02)); the author's ACCEPTED followers whatever their space, never for an anonymous post, in Suivis and not in Tout ([WP-F5](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31)); an institution only with the author's consent; an admin only by id; a member's repost with the author's consent reaches the reposter's accepted followers the same way, never for the post of a members-only entity (WP-F6, built in #2859, released in `v1.6.0`; lists admitted 2026-11-02, [as built](#wp-f6---member-reposts-with-the-authors-consent-as-built-2026-11-01)) | built |
| Republication (D38) | associations, lists (2026-10-31) and institutions, by proposal accepted by the other's admins; a personal post only with its AUTHOR's consent, asked by any of the three kinds (D38b, amended 2026-11-02); card shows "republished by X, Y"; notifies only those who newly see it | built ([as built](#d38-republication-as-built-2026-10-04), [D38b](#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built)) |
| Event (D39) | union of the audiences of the organiser and of each ACCEPTED co-organiser | built ([as built](#d39-co-organisation-as-built-2026-10-05)) |
| Agenda signed in | as events above | built |
| Agenda anonymous / `.ics` (D40) | one feed per selection (campus, formation x campus, "mine") | built, bare URL refused, **selection SIGNED since 2026-10-06** ([as built](#d40---the-anonymous-agenda-per-selection-as-built-2026-10-05), [amended](#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)); "mine" is the signed-in agenda only |
| Association directory (D37) | associations reaching one's spaces, or one belongs to | built |
| Association page | NOT LISTED for a reader outside its audience, but reachable by a link (user, 2026-10-04); the member list does NOT follow the audience | existing |
| Association map | filters to show or hide associations and to select them by campus, formation | server filter built, map next |
| Feed (the gate) | admin, or one space, or one membership | built |
| Admin browsing (D41) | exactly like an ordinary reader; opens one post by id for moderation | built |
| Messaging, forms, people directory | any valid profile, no border (forms: the link is enough, owner 2026-10-31); **the people directory is a dashboard row and a page for every signed-in member since 2026-11-13** (it was linked to staff only, the server always answered any member; the row shows the same fields as a public profile, no per-field privacy setting exists in core-service to honour; the review-cohort rule still applies; blocked accounts are hidden in both directions, like the New chat search, `applyBlockVisibility`) | built |
| Shop, partnerships | `/shop` lists the products and cards of an association VISIBLE to the reader (D37's predicate); a card claimed by id outside it is a 404; a product stays PAYABLE by anyone holding its association page's link | built ([as built](#the-shop-the-partnerships-and-the-bookings-follow-the-campus-owner-2026-10-31)) |
| Booking spaces | an association's space: as its association; a personal space: those on its owner's CAMPUS (staff included); by id, a 404 outside it | built ([as built](#the-shop-the-partnerships-and-the-bookings-follow-the-campus-owner-2026-10-31)) |

### Filters and rights

| Item | Rule |
| --- | --- |
| Filters (promo, contributor) | kept, per association, cumulated: original's OR a republication's that reaches the reader - **NOT BUILT: no promo or contributor filter exists in code yet**, so nothing narrows either branch |
| Per-post space rules (`post_audiences`, ceiling, DTO `audiences`) | removed (D38, migration 073) |
| Join an association | its admins add the member; following opens nothing |
| Follow a person | a REQUEST the person accepts or refuses (WP-F1-F4, decided 2026-10-25); an ACCEPTED follow opens the person's non-anonymous personal posts and lives across spaces, in Suivis (WP-F5) |
| Moderation | scoped to the BDE's governed spaces; the platform admin global; only the author edits a post ([D23 amended](#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02), 2026-11-02) |

### Decided last (user, 2026-10-04)

| Item | Decision |
| --- | --- |
| Republish a post one's association already sees | immediate, by those who may publish in its name; only a PROPOSAL to ANOTHER association needs acceptance |
| Who accepts a proposal (post or co-organisation) | those who may publish in the receiving association's name; no new grant |
| Pending proposals | a notification to the acceptors and a "pending" queue on the association's management page; NO expiry (no clock decides a refusal); the sender may withdraw |
| A co-organiser refuses or leaves | the event stays with its organiser, the audience union is recomputed without it |

| Item | Decision |
| --- | --- |
| Republished card | "Republished by X, Y" line, reactions and comments on the original, notification only for those who newly see the post |
| Personnel | declared; spaces add up with a cursus; publishing as an institution needs membership of its instance |

### D36 and D37 as built (2026-10-04)

**D36 - a new association reaches its creator's spaces** (SUPERSEDED 2026-10-08: it now reaches its creator's CAMPUS, see [audiences policy](#audiences-policy-as-built-wp-a-2026-10-08); a list too; **an institution does NOT**, user
2026-10-05 - it starts with no rule, see WP6e below). `AssociationsService.create` (the one path
for an association AND a list, `POST /api/associations`) writes, in the SAME transaction as the row,
the creator's spaces (`READER_SPACES_SQL`, the twin of `readerSpaces`) as the smallest equivalent
rule set (`smallestRules` in `spaces/spaces.service.ts`, the server twin of the grid's `toRules`: a
whole campus is one `(null, campus)` rule, every pair one `(null, null)`). The grid then shows them
as ticked boxes. A creator with no space (no campus or no cursus - a global admin who is not a
student, typically) writes NO rule: the association reaches its members only until an admin ticks
the grid. The creator is the caller, who need not become a member.

**D37 - the directory.** `GET /api/associations` takes `scope`:

| `scope` | Lists | Read by |
| --- | --- | --- |
| `directory` (default) | associations whose rules reach one of the caller's spaces, plus those the caller is a member of (any role) - `associationVisibleToViewerSql`, the agenda's predicate; a global admin is an ordinary reader | `/associations`, `/lists` (`listAssociationDirectory`) |
| `all` | the whole catalogue | every PICKER and admin screen (`listAssociations`): co-organiser, a list's parent, payment delegation, past roles, the shop's names, the people directory's filter, the agenda's filter and deposit target, the composer for an admin, `/admin/cercle`, `/admin/carte`. `/admin/spaces` reads its own paged, platform-admin catalogue instead (`GET associations/admin/catalogue`, [admin](frontend/modules/admin.md#the-catalogue-and-the-create-form-adminspaces-owner-2026-11-02)) |

**`scope=all` is open to any signed-in caller, NOT admin-only, and that is deliberate**: half the
pickers belong to non-admins (a co-organiser from the other campus, a past role in an association one
is not reached by), and a hidden association is not a secret - D37 is relevance, its page stays
reachable by its link and the public listing already names every association. An admin-only switch
would have emptied those pickers for the people who use them.

`?campus=` and `?formation=` (either scope, D4/D6 values, anything else a 400 like an unknown
`scope`) keep the associations whose OWN rules reach at least one space matching them -
`associationRulesReachSpaceMatchingSql`; a membership does not put an association on a campus it
does not address, and an association with no rule is on no campus. This is the server half of the
association map. The frontend's directory cache is now per reader (the answer depends on who asks).

**Unchanged, read in the code:** `GET /api/associations/slug/:slug` and `/:id` (the page by its
link), `/:id/members`, `/me/list`, and the PUBLIC `GET /api/public/associations` (anonymous, read by
the sitemap): it still lists every association - an anonymous caller has no space to filter by, as
for the anonymous agenda (D40 decides that one later).

**Old clients.** An installed app embeds its frontend, so an app older than this change calls
`/api/associations` with no `scope` and gets the DIRECTORY on every screen, its pickers and admin
pages included, until it updates. Nothing breaks or is lost (the grid writes per association), but
a picker on an old app may miss an association the user is not reached by.

**Proof.** `reader-spaces.integration.spec.ts` (real PostgreSQL, migration 071): every reader's
directory, six map filters, an association with no rule on no campus, and D36's rules for a creator
with a space and one without; a control (the campus clause removed from the map filter) failed 3 of
them. `associations.service.create-default-audience.spec.ts` holds the transaction and the rule set,
`associations.controller.spec.ts` the scope wiring and the 400s, `directoryScope.test.ts` the
frontend's two requests and their separate cache keys. `AssociationsService.list` and `create` were
also run through TypeORM against a copy of a local estate (directory per reader, a membership
adding one, the map filter, creation with and without a space).

### The shop, the partnerships and the bookings follow the campus (owner, 2026-10-31)

An audit found that a product, a partnership card and a booking space were listed to, and could be
bought, claimed or booked by, every signed-in account, whatever its campus. The listings and the
claim now ask the directory's predicate (D37) of the row's OWNING association, and a personal
booking space its owner's campus - no new column, no migration:

| Surface | Rule | Where |
| --- | --- | --- |
| Shop (`/shop`) | `listAllActive` keeps the products whose association is visible to the reader (`associationVisibleToViewerSql`: a member of it, D21, or its rules reach one of their spaces) | `products.service.ts` |
| A purchase by id | NOT scoped (owner, 2026-10-31: buying by link is allowed, as with forms): whoever holds the association page's link may pay for what it lists | `products.service.ts` (`preparePurchase` asks no campus) |
| Partnerships | `listAllActive` and `listActiveByAssoc` keep the cards whose association is visible; `claimCard` answers 404 `PARTNERSHIP_NOT_FOUND` outside it | `partnerships.service.ts` |
| Booking spaces | an ASSOCIATION space follows its association (listing and every use by id); a PERSONAL space opens only to those whose `users.campus` is its owner's (`sameCampusAsViewerSql`: the campus, NOT a formation x campus space - owner, 2026-10-31: *"people without a formation still have a campus"*; the review cohort matches only itself) - outside it, 404 `space-not-found` on read and on booking; the account linked to one of its resources (D10) passes the campus check on a READ by id only (`getSpace`, `spaceSlots`; the audience still holds), never to book or upload | `bookings.service.ts` (`listedSpaces`, `assertSpaceVisible`) |

**Unchanged on purpose:** the association's page reached by its link (D37) keeps listing its
products (`listByAssoc`); the manager paths (`grantProductPurchase`, `quoteCashSale`, the space
organiser) are not scoped; forms are not (the link is enough); a personal booking space is still
LISTED to its owner alone (D43). A global admin is an ordinary reader here (D41), and the review
cohort's narrowing (`review-cohort-reach.ts`) still runs - it composes, since a review account has no
real space and the predicate is membership alone for it. A refusal by id is a 404, asked AFTER the
cohort's typed 403, so the cohort keeps its own answer.

**Two decisions the owner took on review (2026-10-31).** A personal booking space follows its owner's
CAMPUS, not a space, so staff (a campus, an empty cursus) can offer one to their campus - the school
psychologist case; an owner with no campus opens theirs to nobody else. And a product of another
campus is not on /shop, yet whoever holds the association page's link may BUY it: the campus decides
what the shop offers, not who may pay. A partnership card stays hidden and unclaimable outside the
audience.

**Client cache.** Every per-reader cache (the directory, the profile, the memberships) is forgotten
when the reader's own campus or cursus changes - `noteReaderSpaces` (`stores/user.ts`) compares the
profile `GET /api/users/me` returns with the one last recorded (durable state, never a clock); the
access token carries neither. Saving an association's audience rules or a space's BDE drops the held
directory (`setAssociationAudiences`, `setSpaceBde`).

**Proof.** `shop-partnership-visibility.integration.spec.ts` and the `the campus` block of
`bookings.service.integration.spec.ts`, against a real PostgreSQL: another campus is not listed and
gets a 404 on a claim or a booking by id, the same campus is served, a member of the association
from the other campus is served (D21), a purchase by link from another campus goes through, a staff
owner's space is booked by a student of its campus and refused to the other one, and the same
campus is no bridge across the review cohort. A control that opened personal spaces to everyone made
the three personal-space cases fail.

### Who sells: an association, a list through its delegate, never an institution (owner, 2026-11-02)

| Kind | Shop, cotisation, paid forms | Own Lydia account | How it collects |
| --- | --- | --- | --- |
| Association | yes | yes | its own Lydia, or a delegate's if it delegates |
| List | yes | **never** (`LIST_NO_OWN_LYDIA_ACCOUNT`) | ONLY through an APPROVED payment delegation to any association whose Lydia is ready - not necessarily its BDE; without one, every collecting write is refused `LIST_DELEGATE_REQUIRED` |
| Institution | **never** (`ASSOCIATION_KIND_DOES_NOT_SELL`) | never | does not collect |

The delegation is accepted only by the receiver's own `MANAGE_PRODUCTS` holders or the platform
admin - never by a BDE governing the receiver - and every acceptance is recorded. A revoke, or the
receiver losing its Lydia, pauses the list's products and paid forms and tells its managers; a new
acceptance resumes them. The mechanism is in
[associations](frontend/modules/associations.md#what-a-list-and-an-institution-manage-owner-2026-10-31)
and [payments](frontend/modules/payments.md#pause-and-resume-when-the-receiver-stops-collecting-owner-2026-11-02).

### D38 republication as built (2026-10-04)

Branch `feat/spaces-repost`, stacked on `feat/spaces-6c-scope`. Migration `073_republications.sql`
drops `post_audiences` and creates two tables.

**`post_republications(postId, associationId, republishedBy, republishedAt)`**, primary key the
pair, both foreign keys `ON DELETE CASCADE`. `postVisibleToUserSql` gains ONE disjunct: a
republishing association visible to the reader by the association predicate itself (member, or
its rules reach a space of theirs). Adding a disjunct is MONOTONE, and the notification relies on
that.

**`proposals(kind, subjectId, fromAssociationId, toAssociationId, status, ...)`** - GENERIC, so
co-organisation (D39) is a second `kind` on the same table, routes and queue. `kind` is
CHECK-listed (`'repost'`, and `'coorganise'` since migration 074). The status is `pending -> accepted | refused | withdrawn`, with a
CHECK tying `decidedAt`/`decidedBy` to it. A unique partial index on `(kind, subjectId,
toAssociationId) WHERE status <> 'withdrawn'` makes a proposal idempotent: a second one is a 409,
and a REFUSAL IS RECORDED (it keeps its place, so the same post cannot be proposed there again).
An `AFTER DELETE` trigger on `posts` removes its `repost` proposals; `subjectId` cannot carry a
foreign key, since what it names depends on the kind.

- **The mechanism** (`proposals/`): `ProposalsService` holds the state machine, the rights and the
  queue. A kind registers a `ProposalKindHandler`, which declares the sender and acceptor flags,
  resolves the sending association from the subject, and provides `apply` (run INSIDE the decision
  transaction), `announce` and `describe`. A decision is a conditional `UPDATE ... WHERE
  status = 'pending'`, so two deciders cannot both win: the loser gets a 409. Routes:
  `GET /api/associations/:id/proposals` (`{incoming, outgoing}`, pending only, 403 without the
  flag) and `POST /api/associations/proposals/:id/accept|refuse|withdraw`.
- **Republishing** (`posts/republications.service.ts`, the `repost` handler; both flags are
  `POST_AS_ASSO`):
  - `POST /api/posts/:id/republications` republishes AT ONCE. It needs `POST_AS_ASSO` in the
    republishing association, and the post must be visible to the actor (opened by id, so an admin
    included - our reading of "already sees").
  - `POST /api/posts/:id/republication-proposals` PROPOSES. It needs the post's own association's
    `POST_AS_ASSO`; its acceptors are notified (`repost_proposed`).
  - `DELETE /api/posts/:id/republications/:associationId` lets an association withdraw its own.
  - Refusals: a personal post (400), the post's own association (400), a non-`association` type
    (400; institutions join with 6e), a hidden, scheduled or expired post (404), and a muted
    actor.
- **Who is notified** (`association_repost`): only the readers who see the post FOR THE FIRST TIME,
  minus its author. The republication transaction locks the post row (`FOR UPDATE`) and, BEFORE it
  inserts the row, asks `NEWLY_REACHED_BY_REPUBLICATION_SQL` - the association's readers who cannot
  see the post now. With visibility monotone, that is exactly "after minus before", read from state
  and never from a clock. The announce sweeper stamps `feedNotifiedAt` and reads its recipients in
  ONE transaction, under the same lock. So:
  - a republication before the first announce adds nothing of its own, and the sweep tells
    everyone;
  - a republication after it tells only the new readers;
  - nobody is told twice.
- **Removal**: hiding a post (moderation, manual or automatic) deletes its republications and its
  pending repost proposals in the same transaction. Deleting a post cascades through the foreign
  key and the trigger.
- **The card**:
  - `republishedBy` (oldest first) draws "Republie par X +N" on the line of the post's time
    ("2 h . Republie par BDE", user 2026-10-24), one card per post - the card and the reel
    overlay alike (`republishedByText`);
  - `canRepublish`, `canProposeRepublication` and `canUnrepublishAs` are server answers that draw
    the menu entries;
  - `RepublishDialog` offers the reader's `POST_AS_ASSO` associations (republish), or the
    directory (propose).
- **The queue**: a "Propositions" tab on `/associations/<slug>/edit` (named "Republications"
  until D39; its section key is still `republications`, which older notifications link to).
- **The proposal notification**: its `postId` carries the RECEIVING association's id, and the
  notifications page resolves that id to a slug before it routes. Its push carries no `postId`, so
  a tap on the phone opens the feed, not the queue.

**Not built:**

- The promo and contributor FILTERS of D38. Nothing narrows a republication branch.
- ~~Institutions as republishers~~ - built with 6e (below).

A local `synchronize` database lacks 073's trigger and partial index, so its duplicate-proposal
check and delete cleanup differ from production's. The integration specs apply 073 itself.

**Proof**: `posts/republications.integration.spec.ts` and `spaces/reader-spaces.integration.spec.ts`
run against a real PostgreSQL with 073 applied:

- republish at once;
- propose, accept, refuse, withdraw and a duplicate proposal;
- a personal post and the permissions refused;
- visibility before and after;
- the first-time notification set;
- hide and delete removing everything.

A control that drops the `NOT visible-before` term from the newly-reached SQL fails 3 cases.

### D38b - a personal post republished with its author's consent (decided 2026-10-19, as built)

**The decision (user, 2026-10-19):** *"J'aimerais bien qu'on puisse republier en tant
qu'association le post d'une personne."* An association PROPOSES and the AUTHOR consents: nothing
is visible before they accept. Only holders of `POST_AS_ASSO` in the proposing association may
ask. The author may withdraw the republication at any time, and so may the association.
Deleting the post removes everything, as for D38.

**The shape: a fourth kind of proposal, addressed to a PERSON.** Migration
`096_personal_republication_requests.sql` (094 and 095 were taken by open pull requests on
2026-10-19) makes the generic table address EITHER an association or a user:

- `toUserId` (nullable), with `toAssociationId` now nullable too.
- `CHK_proposals_one_target`: exactly one of the two.
- `CHK_proposals_user_target_kind`: `repost-personal` addresses a user, and nothing else does.
- `UQ_proposals_subject_from_user_target`: one standing request per (post, proposing association).
  A refusal stands; a withdrawal frees the place.
- `IDX_proposals_user_target_pending`: the inbox read.
- The post-delete trigger now also covers `repost-personal`.

`ProposalsService` gains `UserProposalKindHandler` (`resolveRecipient`, `apply`, `announce`,
`decided`, `describeRequests`), `proposeToUser` and `listForUser`. The handler is
`posts/personal-republications.service.ts`.

**Routes:**

- `POST /api/posts/:id/republication-requests {associationId}` - ask the author.
- `GET /api/posts/me/republication-requests` - the author's inbox.
- `POST /api/associations/proposals/:id/accept|refuse|withdraw` - the generic routes. The
  recipient alone decides: no administrator stands in.
- `DELETE /api/posts/:id/republications/:associationId` - the author may withdraw ANY
  republication of their personal post, and the association its own.

**Refusals, checked in this order. Each is a typed `code` (`REPOST_PERSONAL_*`), and each has an
integration case:**

1. A post that is absent, hidden, scheduled or expired: 404.
2. A post the proposer does not see WITHOUT a read grant and without the administrator's reach by
   id: 404. The refusal confirms nothing about the post.
3. An association post: 400. D38's routes apply to it.
4. An anonymous post: 400. An association carrying it would tie it back to its author.
5. The proposer's own post: 400.
6. An association of a kind nobody listed (`PERSONAL_REPUBLISHING_ASSOCIATION_TYPES`; a list and
   an institution were refused here until the owner's decision of 2026-11-02, [amended](#d38b-amended---every-kind-may-ask-and-an-institutions-request-shows-its-audience-owner-2026-11-02))
   or an archived one: 400.
7. A block either way between the proposer and the author: 403.
8. A post the association already carries: 409.
9. A request that already stands (pending or refused): 409, from the unique index.
10. The caps: 409. They are STATE, not a clock: at most 20 pending requests per author and 10 per
    association, counted under `pg_advisory_xact_lock`.
11. A muted proposer is refused at the route (`assertNotMuted`). A muted AUTHOR cannot accept
    (403 on accept): accepting would widen what they published.

**Visibility.** The personal branch of `postVisibleToUserSql` gains
`republicationReachesUserSql`. A personal post is now ALSO visible to the readers of an
association carrying it. Read grants never reach that branch.

**Who is told:**

- The AUTHOR gets `repost_personal_requested`, in-app and as a push.
  - The push is `contentKey` `social_repost_personal_requested`, composed on the device from
    `strings.xml` and `Localizable.strings` (fr and en).
  - Its tap target is `fr.emse.canari://republication-requests`, which opens
    `/notifications/requests`.
- On acceptance, the newly reached readers are told ONCE, under the D38 lock
  (`newlyReachedByPersonalRepublicationSql`):
  - the association's readers who could not see the post;
  - minus anyone in a block with the author;
  - minus, before the first announce, the author's followers, whom the sweep tells.
- The PROPOSER gets `repost_personal_accepted` or `repost_personal_refused` in-app, with no push.
- **Only the FIRST ask of a (post, association) pair is announced** (review of #2116): the state is
  the earlier `proposals` row, read in the asking transaction, never a clock. A withdrawal by the
  association also deletes the author's bell row for that request, so ask / withdraw / ask cannot
  ring the author again. `repost_personal_requested` is in `MUTABLE_PUSH_TYPES`: the author's mute
  of the asking association silences it.

**What an officer sees of a request it sent.** The association queue describes a
`repost-personal` request only to a viewer who sees the post (`postVisibleToViewerSql`, no read
grant, no administrator reach). To another `POST_AS_ASSO` holder of the association, `subjectId`,
`subject` and `toUser` are null: the queue says "a request to an author", never the post's id, its
preview or the name. A withdrawal answers `{ id, status }` only, never the row (which names the
author and the post).

**An asker who no longer speaks (second review of #2116).** "Speaks" is ONE SQL predicate,
`senderSpeaksSql`: the asker holds `POST_AS_ASSO` in the association and is not muted. A request
whose asker stopped speaking - flag lost, left, muted, erased - is:

- not shown in the author's inbox and not counted in its badge;
- not counted in either cap (20 per author, 10 per association);
- voided when the author accepts it: 409 with code `PROPOSAL_SENDER_GONE`;
- voided when the same association asks again for the same post, so the pair's place in the
  unique index is freed;
- voided at once by the asker's erasure (`proposals_voided`).

Voided means `withdrawn` with `decidedBy` = `[voided]` (`PROPOSAL_VOIDED_BY`), which names neither
the author nor the asker, and the author's bell row goes in the same transaction. A flag change or a
departure does NOT void at that moment: those have many writers. The predicate makes the request
inert until one of the voids above finds it.

**Lock order: the associations (`FOR KEY SHARE`), then the subject, then the proposal.**
`ProposalsService.lockInOrder` takes it for every decision (accept, refuse, withdraw) of every kind
and every ask to a person. The handler's `lockSubject` is `lockPostRow` (the post `FOR UPDATE`) for
the republication kinds; `coorganise` has none, so its next lock is the proposal itself.

| Writer | 1. association | 2. subject | 3. proposal |
| --- | --- | --- | --- |
| a decision or an ask (`lockInOrder`) | `FOR KEY SHARE`, from and to | the post `FOR UPDATE` (none for `coorganise`) | the conditional `UPDATE` |
| a moderation hide, a post delete | - | the post | its pending proposals (096's trigger for a delete) |
| a republication withdrawal (`unrepublish`) | - | the post | - |
| the account erasure | `FOR NO KEY UPDATE`, its FIRST statement, every association its writes reach, ordered by id (`ERASURE_ASSOCIATION_LOCK_SQL`) | the posts it scrubs | LAST (`ERASURE_PROPOSAL_STATEMENTS`) |
| an association delete (`AssociationsService.remove`) | `FOR UPDATE`, its FIRST statement | its events (074's trigger), forms, members, then the row's cascade (never posts: `posts."associationId"` has no foreign key) | through the trigger and the cascade |

- The erasure anonymised `proposedBy` first, then locked the posts the account had reacted to,
  until a fix. Two connections reproduced `deadlock detected` against an acceptance, and the erasure
  aborted.
- The association delete took the association LAST (2026-10-19, review of the D38b second pass): it
  deleted the events first, whose 074 trigger took their `coorganise` proposals, then waited on a
  co-organisation decision's `KEY SHARE` while that decision waited on the proposal. Reproduced as
  `40P01` on PostgreSQL 18. It must be `FOR UPDATE`: `FOR NO KEY UPDATE` does not conflict with
  `KEY SHARE`.
- The erasure reached the association only at `UPDATE associations SET "createdBy"`, near its end
  (2026-10-19, review of the fix above). For an account that created an association and belonged
  to it, the erasure held the member row while the delete held the association and its events; each
  then waited on the other (`40P01`, PostgreSQL 18). The erasure now locks first every association
  one of its writes reaches through a row the delete removes: created, member, role history, push
  mutes, events it created, validated or rejected, forms it owns or answered, proposals and the
  republications it made or that name its posts (the post delete cascades into them), and the
  booking spaces under its bookings, participations, blocks, files and linked resources. A
  missing source reopens the cycle for its rows. `FOR NO KEY UPDATE` conflicts with the delete's
  `FOR UPDATE`, is the lock the `createdBy` update takes anyway, and does not block a decision's
  `KEY SHARE`. Id order keeps two erasures apart too.
- Two deletes of associations that co-organise each other's events can still deadlock. This is
  older than both fixes and is a P3 in [backlog](backlog.md).
- A `KEY SHARE` blocks a delete or a KEY change of the association, never another edit. The key is
  the primary key AND every unique column, so a write of `slug` (unique) waits behind an in-flight
  decision, as a delete does.

Five integration cases hold the contested row from a second connection and prove the order: a hide,
an association delete against an acceptance (the delete holds the association), an erasure racing
an acceptance (both complete), and two in `coorganisation.integration.spec.ts` against the real
`AssociationsService.remove`. One is a co-organisation decision, the other an erasure of the
association's creator and member. In both the delete waits holding nothing, and both sides complete.
Each fails with its lock removed.

**The counts.** The inbox's "readers who would see it first" is computed by the very query
acceptance notifies with (`newlyReachedByPersonalRepublicationSql`, with the post's
`feedNotifiedAt`), so the two agree. `/notifications` reads only
`GET /api/posts/me/republication-requests/count`.

**The author's request states plainly:**

- who asked (the member);
- in which association's name;
- the post;
- how many readers would see it for the first time - a count, never names.

**Withdrawal:**

- The author's withdrawal deletes the row and records the request as `refused`: it stands, so the
  same association cannot ask again.
- The association's withdrawal records it as `withdrawn`, so it may ask again later.

**Removal:**

- Hiding the post (`dropRepublicationsOf`) deletes its republications and PENDING requests; an
  accepted or refused request stays until the post is deleted.
- Deleting the post: the foreign key and the trigger.
- The author's erasure deletes every request addressed to them (`proposals_to_user`).
- The proposer's erasure voids their PENDING requests (`[voided]`, bell rows deleted): no one is
  left to speak for them. Their decided requests keep the record, with `proposedBy` anonymised.

**The client:**

- The menu entry "Demander à republier" (`canRequestRepublication`) opens
  `RepublishDialog` in `request` mode. It lists the reader's HELD `POST_AS_ASSO` associations of
  a kind that may ask - every kind since 2026-11-02 ([amended](#d38b-amended---every-kind-may-ask-and-an-institutions-request-shows-its-audience-owner-2026-11-02)).
- The card shows "Demande envoyee au nom de X" for a pending request (`republicationRequests`),
  and the menu offers "Annuler la demande de X".
- The inbox is `/notifications/requests`. `/notifications` links to it when something is waiting.
- An association's sent requests appear in its "Propositions" tab, addressed to the author.

**Not built (in [backlog](backlog.md)):**

- No expiry for a pending request: it waits like a D38 proposal.
- No per-author opt-out of being asked.
- No list of the readers reached.

**Proof:** `posts/personal-republications.integration.spec.ts`, against PostgreSQL with 096
applied. It covers every refusal above with its code, and:

- the inbox and the queue;
- accept, refuse, and both withdrawals;
- the notification sets;
- the muted author;
- hide, delete and erasure;
- the two CHECKs;
- the caps;
- that the card offers exactly what the write accepts.

### D39 co-organisation as built (2026-10-05)

Branch `feat/spaces-coorganise`, stacked on `feat/spaces-repost`. Until then a co-organiser
(`coOwnerIds`) was added without its consent, held every right on the event at once, and the agenda
filter read the organiser only.

**The model.** Naming a co-organiser is a `coorganise` proposal (subject = the event) on the generic
`proposals` table. `association_calendar_event_co_owners` now means **accepted**: its row is written
only by the acceptance (`apply`). Both readers of that table therefore read consent:

- the rights - `findCalendarEventForAssociation`: edit, poster, delete, as before, but only once
  accepted;
- the reach - `eventVisibleToUserSql` in `spaces/reader-spaces.ts`.

A pending or refused co-organiser lives only in `proposals`, so it has no right and no appearance.

- **Flags**: the sender is the organiser (`PROPOSE_EVENT`, the right that writes its events); the
  acceptors are the receiver's `POST_AS_ASSO` holders - the repost rule, no new grant. They are
  notified (`coorganise_proposed`, push key `social_coorganise_proposed` in the Android, iOS and NSE
  tables; `postId` carries the receiving association, like `repost_proposed`).
- **Reach**: an event is visible to a signed-in reader when its organiser OR an accepted
  co-organiser is visible to them (D21 membership included) - the union, since an event has no
  rules of its own. ONE predicate, used by `restrictToViewerSpaces` for the aggregated feed and the
  per-association `/events`. Those are the only two server reads that filter events per reader:
  - event announcements to readers do not exist (the `event_*` notifications go to the
    association's proposers and the BDE validators);
  - the post-linked event routes are gated by the post's own visibility;
  - the anonymous feed and `.ics` are untouched (D40 is a separate package).
- **Through the event form** (`coOwnerIds` on create and update, `CoorganisationService.sync`,
  against the current state):
  - a new name is proposed;
  - a pending one left out is withdrawn;
  - an accepted one left out is ENDED: its row goes, and its proposal moves `accepted -> withdrawn`
    so the pair may be asked again;
  - a refused one is NOT asked again (the refusal stands; logged);
  - a caller writing through a co-organiser's own route may only remove that association (leave);
    anything else is a 403 before any write.
  - Because `AssociationsModule` cannot import the proposals, the co-organisation module registers
    a port (`co-organisers.port.ts`) at boot, the way a kind registers with `ProposalsService`.
- **A co-organiser that refuses or leaves**: the event stays with its organiser, and its audience
  is recomputed on the next read (the row is gone). No expiry; no clock decides a proposal.
- **Reading the states**: `GET /api/associations/:id/events/:eventId/co-organisers` (accepted,
  pending, refused), for whoever may write the event through `:id` - the write rule, now
  `AssociationsService.assertMayWriteEvent`, shared with the controller.
- **Frontend**:
  - the picker shows each co-organiser's state and lists the refused ones apart;
  - the form sends `coOwnerIds` only once the states have loaded, since the event's own `coOwners`
    names only the accepted ones and a list seeded from it would withdraw every pending proposal;
  - the receiving side decides in the proposal queue, renamed "Propositions" for both kinds.

**The cap: FOUR associations in total, the organiser and three co-organisers (user, 2026-10-10).**
Accepted and pending both count (a pending proposal holds its seat), a refused one holds nothing.
`CoorganisationService.sync` refuses an ADDITION that would pass three, and `createCalendarEvent`
checks the same count before it saves (a refusal after the save would leave an event the caller was
told failed); both throw `CALENDAR_COORGANISER_CAP`, which `calendarErrorMessage` names. The DTO's
`@ArrayMaxSize(10)` stays a transport bound ON PURPOSE: a DTO at 3 would answer a generic
validation error and make the typed code unreachable. Only an addition is refused, so an event over
the cap could still be edited and shrunk - none exists: **prod, read-only, 2026-10-10: 9 events with
co-organisers, the most on one event is 1, 2 proposals pending.** Nothing was grandfathered, nothing
deleted. The picker stops the overflow first (counter `n / 4`, [calendar](frontend/modules/calendar.md)).

**Migration 074 (`074_coorganise.sql`), replay-safe** (every statement guarded; the spec runs it twice):

1. `coorganise` is added to the kind CHECK.
2. Duplicate co-owner pairs and orphans are removed. The table was built by `synchronize` with no
   unique key, so either may exist; then a unique index on `(event_id, association_id)` is created.
3. **EXISTING CO-OWNERS ARE BACKFILLED AS ACCEPTED** - one `accepted` proposal each, decided by
   `migration-074`. They keep their rights and their reach: a backfill dropping them would have taken
   both away silently.
4. An `AFTER DELETE` trigger on `association_calendar_events` removes an event's co-owner rows and
   its `coorganise` proposals.

**Proof.** `coorganisation/coorganisation.integration.spec.ts` runs the real `AssociationsService`,
`ProposalsService` and `CoorganisationService` against PostgreSQL, over tables built by
`synchronize` and migrations 071-074. It covers:

- the backfill and its replay;
- propose, accept, refuse and withdraw, by the form and by the queue;
- no right and no agenda entry before acceptance, both after;
- the union reach;
- leave and removal recomputing the reach;
- the permission refusals;
- the delete trigger.

`reader-spaces.integration.spec.ts` adds the event predicate to the reader matrix. A control that
removes the co-organiser branch of `eventVisibleToUserSql` fails 2 cases.

**Not verified**: no browser pass (the picker states, the queue rows and the notification were
checked by `svelte-check` and the component tests only), and no device push.

#### E2: partner rights on a co-organised event (WP-Q1, 2026-11-03)

Owner decision E2 of [spaces-and-audiences-reform](spaces-and-audiences-reform.md): **a partner edits
the text and the poster and may withdraw; only the organiser changes the date, the audience or the
partner list, and only the organiser deletes.** Before it, "edit, poster, delete" of D39 as built
above meant every right, the date and the delete included (P14: a Gardanne partner could delete a
Saint-Etienne event).

- **The side.** `assertMayWriteEvent` now returns `{ isGlobalAdmin, isBde, side }`. `side` comes from
  `eventWriteSide` (`associations/event-write-side.ts`, the one rule): the organiser when the write
  is routed through the event's own association, a `partner` when it is routed through an accepted
  co-organiser. The organiser is read from the event ROW, never the URL.
- **The refusals**, one typed 403 `CALENDAR_PARTNER_ORGANISER_ONLY` (`partnerOrganiserOnlyRefusal`),
  thrown before any write of the event:
  - `updateCalendarEvent`: a partner whose `startsAt` or `endsAt` actually MOVED (a resubmitted,
    unchanged date is not a change - both modals send every field);
  - `CoorganisationService.sync`: a partner-side list that adds anyone or removes anyone but itself
    (it was a bare 403 with a message; now typed);
  - `deleteCalendarEvent`'s member branch.
- **No partial write.** Every partner-side refusal (and the cap) is checked BEFORE the first write of `updateCalendarEvent`: `CoOrganiserPort.check` runs the read-only plan of `sync` ahead of the form-link detach, so a refused request changes nothing (integration case: form link plus an illegal partner-list change).
- **Allowed for a partner**: title, description, the poster routes (they ask `assertMayWriteEvent`,
  which a partner passes), and WITHDRAWAL (`coOwnerIds` without itself, unchanged).
- **Audience.** An event has no audience of its own today (it is the union of the organiser's and the
  accepted partners', D39), so no write field exists to refuse. When WP-I gives institutions an item
  audience, that write must call the same `eventWriteSide` and refuse a partner.
- **Not changed**: a platform admin and a governing validator (`isBde`) are the organiser side through
  every route, as before - E2 narrows the partner, nobody above. Verified in the integration spec.
- **The form.** `GET /api/associations/:id/events/:eventId/write-side` answers `{ side }` from that
  same rule; the form reads it with the co-organiser states (a failure of either is `failed`, the side
  stays `unknown`). The date and the partner list are drawn and SENT for `organiser` only; a partner
  sees a note and a "withdraw" button instead. The delete buttons of an association's own calendar
  section are shown only for events it organises (the server stays the authority).
- **The form link is the organiser's too** (decision, review of 2026-11-03; reversible, it is one
  condition in `updateCalendarEvent` and one in `toUpdatePayload`). A partner does NOT own the link: a
  CHANGE of `linkedFormId` from the partner side (detach, or another form) is the same typed 403
  (`partnerOrganiserOnlyRefusal('linkedForm')`), before any write; resending the value it loaded is not
  a change and is accepted. The client never sends `linkedFormId` unless the side is `organiser`. This
  also removes an untyped 400 (the partner's own association does not own the organiser's form) that
  broke a partner's plain text edit.
- **One transaction, one lock, one connection.** `updateCalendarEvent`, `validateCalendarEvent` and
  `rejectCalendarEvent` run inside `withEventLock` (`AssociationsService`). Its lock order is THE GLOBAL
  ONE (`ProposalsService.lockInOrder`; `AssociationsService.remove` takes its association `FOR UPDATE`
  before it deletes events): the event's organiser and every association the edit names as a partner,
  `FOR KEY SHARE` in id order, THEN the event row `FOR NO KEY UPDATE`. The first draft locked the event
  first, and an edit adding a partner could hold the event while a delete of the organiser held the
  association: a cycle Postgres could not see, because the edit's proposal insert ran on another
  connection while the edit's own connection sat idle. `NO KEY UPDATE` rather than `UPDATE` so the
  `FOR KEY SHARE` of foreign-key inserts into tables referencing the event is not blocked.
- **Everything on the lock's manager.** The checks (`CoOrganiserPort.check(request, manager)`), the form
  ownership read, the form-link detach, the partner endings, the k proposals
  (`ProposalsService.proposeWithin`, which hands back its announcement) and the event save are ONE
  transaction on ONE pooled connection: they commit or none does (a failing k-th proposal leaves no
  field, detach, ended partner or earlier proposal), and a few concurrent edits cannot starve the pool.
  The announcements and the other notices run after the commit. An event CREATION is the same
  unit (`createCalendarEvent`): associations `KEY SHARE` first, then the form ownership read, the
  detach, the event insert and `sync(request, manager)` in ONE transaction, so a failing k-th proposal
  leaves no event behind (it used to leave an event with no proposals and a 500, which the retry
  duplicated). The manager-less `sync(request)` branch was deleted: creation was its only caller, and it now passes its manager.
  The delete-versus-edit integration case bounds its deleter with `lock_timeout` (failure path only: a
  lock-order regression fails with SQLSTATE 55P03 instead of hanging the suite) and its waiter matches
  any lock wait under the suite's `application_name`, not statement text.
- **A co-organisation ACCEPTANCE takes the same lock** (WP-Q2): `CoorganisationService.lockSubject`
  locks the event row in `lockInOrder`, so it runs `associations -> event row -> proposal` and is serialised
  with an edit, a validation and a rejection.
- **Tests.** `coorganisation.integration.spec.ts` gains the refusals (start, end, partner list,
  delete), the allowed text and poster (through `setEventImageFromUpload` / `clearEventImage`), the withdrawal, the form-link rows, a validator tier derived by `mayValidateEvent`, and a deterministic interleaving (a hook between the check and the save starts a validation and returns once Postgres reports it waiting on the lock, failing explicitly if it settles first), the organiser-delete versus partner-edit ordering (a held association lock, never a hang) and the rollback of a failing k-th proposal;
  `eventForm.test.ts` and `EventFormModal.coOwners.svelte.test.ts` pin the form.

#### WP-Q2: an acceptance on a validated event reopens it (2026-11-03)

P13 of [spaces-and-audiences-reform](spaces-and-audiences-reform.md): an acceptance adds the partner's
audience to a validated event with nobody validating the new part. Interim rule, before WP-E:

- **The demotion.** `CoorganisationService.apply` - inside the acceptance's own transaction, so the
  partner row and the demotion commit together or not at all - sets a VALIDATED event back to
  `pending` (`status`, `validatedAt` and `validatedBy` cleared) and logs it (`[COORG] ... back to
  pending`). It fires once: the `WHERE status = 'validated'` guard leaves a pending or rejected event
  alone (nothing announced), and an acceptance that inserted no row (conflict) does nothing.
- **The announcement (F7), after commit**, through ONE method every return to the queue now shares,
  `AssociationsService.announceEventReopened(event, reason, actorId)` (reason typed in
  `associations/event-reopen.ts`: `date_moved` | `coorganiser_joined`):
  - the validators concerned (`notifyEventValidatorsOfProposal`): as for a proposal on a date move; for
    an ACCEPTANCE they get the same type as the parties (`event_pending_coorganiser`) with
    `meta.audience = 'validators'`, so the bell reads "a accepté de co-organiser un événement, à valider
    de nouveau" and never shows the acceptor as proposing. They are told FIRST, and the parties' list
    excludes them: somebody who is both gets ONE notice, the actionable one;
  - the organiser's and every accepted partner's `PROPOSE_EVENT` holders, WITH THE REASON
    (`notifyEventReopenedParties`): the notification type is the reason (`event_pending` for a moved
    date, new `event_pending_coorganiser` for a joined partner), `meta.reason` repeats it. The actor
    is never told their own act. The row says "a accepté de co-organiser votre événement, qui attend une
    nouvelle validation". The announcement RE-READS `status = 'pending'` first and logs and skips when
    a validator said yes in the meantime;
- **The date-move path** (`updateCalendarEvent`, the only other place an event returns to pending
  today) calls the same method. It used to tell the validators and the organiser's proposers only;
  the partners are now told too, and `notifyAssocAdminsOfEventAction` lost its `'pending'` action.
- **Lock order.** The acceptance is serialised with an event edit, a validation and a rejection:
  `CoorganisationService.lockSubject` takes the event row `FOR NO KEY UPDATE` in `lockInOrder`, so every
  decision is associations (`KEY SHARE`) -> event row -> proposal, the order of `withEventLock`. The
  demotion is an explicit `UPDATE` of the three status columns; an edit that waited for the lock
  reads the demoted row, so no stale `validated` is ever written back.
- **Native tables.** `event_pending_coorganiser` is a seventh social content key: strings in the
  Android `values` / `values-en`, the iOS app and NSE `Localizable.strings` (fr, en), the Android
  service, the NSE and `canari_push.mm`, and `push-category.ts` (`events`). Compiled by nobody here:
  native verification is owed ([device-verification](device-verification.md)).
- **Superseded by WP-E.** The whole-event demotion is deliberately blunt. WP-E (events per slice,
  section 4 of the proposal) replaces it with a per-slice reopening: an acceptance re-opens only the
  new governors' slices, and the typed reason stays as the cause carried from the write.
- **Proof.** `coorganisation.integration.spec.ts`: a validated event goes pending with stamps cleared
  and the row in; the organiser and partners are told once with the reason and the validators once;
  a second acceptance cannot fire again; a pending and a rejected event are untouched and silent; the
  date-move path announces by the same rule; one person who is validator and party gets one notice; a
  re-validated event is not announced; a failing notification is logged and the commit stays; two
  acceptances at once give one demotion and one announcement; an acceptance interleaved with an
  organiser edit ends pending with the stamps cleared. Existing reach assertions now re-validate the event
  after the acceptance, since it leaves the agenda until a validator says yes again.

### D40 - the anonymous agenda per selection, as built (2026-10-05)

`GET /api/associations/calendar/feed` and `feed.ics` (public) take `?campus=` and `?formation=`
(D4/D6 values; an unknown one is a 400, because a saved subscription URL must fail where it is typed).
`eventReachesSpaceMatchingSql` (`spaces/reader-spaces.ts`) keeps an event when its ORGANISER's rules
or an ACCEPTED co-organiser's (D39) reach a space matching the selection: rules only, an anonymous
reader has no membership. Neither parameter is no selection and the feed stays whole. A signed-in
reader of `/feed` gets both filters. No migration. Proof: the integration spec's five selections
against real PostgreSQL, plus the service and controller specs.

**Decided by the user (2026-10-05):**

- **"Mine" exists only in the signed-in agenda.** No per-user secret URL: a calendar app sends no
  identity and none will be given one.
- **The bare anonymous URL is REFUSED**: a 400 with code `AGENDA_SELECTION_REQUIRED`, for `feed.ics`
  and the anonymous JSON feed. A `campus`/`formation`, an `associationId` (one association is its own
  selection) or an `eventId` (the single-evening link) is enough; a signed-in JSON read is narrowed
  to the reader's spaces and is not refused. The user took the cost knowing it: subscriptions saved
  before this release stop working ([legacy-compatibility](legacy-compatibility.md#nothing-to-remove---a-calendar-subscription-saved-before-d40-now-gets-a-400-2026-10-05)).
- **AMENDED 2026-10-06 - read [D40 amended](#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06): the selection is signed, and the selector below
  now offers only the reader's own spaces.**
- **The selector** (`AgendaSelectionFields`, `lib/calendar/agendaSelection.ts`) sits in the subscribe
  modal and on the PDF export page. It defaults to the reader's own campus and first cursus formation
  (`defaultAgendaSelection`); a reader with no space gets nothing and must choose (no link, no month
  until they do). One association's feed shows no selector. The SEO agenda page publishes no event
  since 2026-11-02 ([D40 closed](#d40-closed---no-event-is-published-to-an-anonymous-reader-2026-11-02)).
- **`GET /api/public/associations`** (the sitemap) stays COMPLETE, unchanged.

### D40 amended - the selection is SIGNED, and only the reader's own spaces are signed (2026-10-06)

**Decided by the user (2026-10-06, four answers):** the subscription selector offers *the reader's OWN
spaces only* (own campus, own formations; an association from its own page); the restriction is a
**stateless signed URL that carries no identity**; an individual event link (`eventId`) stays open
like an SEO page; and *"no need to be a member of an association to see/access an event; any
constraint on that has no reason to exist"* - so membership gates nothing here, and an association
with no audience rule is NOT "members only" for its feed. The anonymous `associationId` feed
returning every event of such an association is therefore **intended**; the leak this closes is the
one that remained: ANY campus or formation could be named in a URL by anyone.

**Tightened 2026-10-07 (user: *"les gens d'un campus ou d'une formation ne devraient pas pouvoir faire ca"*):** a student is signed ONE space, a campus AND a formation of theirs - never a campus alone, a formation alone or "all campuses"; the selector offers no "any" once the reader has a campus. Staff keep their own campus whole. An event across campuses reaches both agendas through a co-organiser partnership (D39), not through a wider subscription. Links already saved keep working: verification never reads the reader.

**As built:**

- `POST /api/associations/calendar/feed-signature` (signed-in only; body `{campus?, formation?,
  associationId?}`) answers `{ sig }`: base64url HMAC-SHA256 of the canonical selection
  `v1|campus=..|formation=..|association=..` under **`AGENDA_SIGNING_KEY`** (`agenda-signature.ts`).
  It signs a campus the reader's spaces contain, a formation their spaces contain, or a pair that is
  one of their spaces (`READER_SPACES_SQL`, the twin of `readerSpaces`); anything else is a 403
  `AGENDA_SELECTION_FORBIDDEN`, an empty body a 400 `AGENDA_SELECTION_REQUIRED`. An association
  needs only to exist. **A reader with a campus but a cursus with no entry (EMSE staff, 11 prod accounts on 2026-10-07; user decision the same day) has no space, yet is signed `campus=<own campus>` with no formation - and nothing else** (another campus, any formation: 403). A reader with a cursus keeps own-spaces exactly; a reader with no campus is signed nothing. The canonical string is unchanged (`v1|campus=saint-etienne|formation=-|association=-`), so the URL stays stateless. The feed of a campus-only selection is what it always was: every event whose organiser's (or accepted co-organiser's) rules reach ANY space of that campus, i.e. every formation of it plus the campus-wide and EMSE-wide audiences (`eventReachesSpaceMatchingSql`, a null formation = any). `campusWideReaderCampus` (`reader-spaces.ts`) is the one predicate, asked only when the reader has no space.
- `feed.ics` and the ANONYMOUS JSON `feed` take `&sig=`. A `campus` / `formation` /
  `associationId` selection without it is a **403 `AGENDA_SIGNATURE_REQUIRED`**; with a signature made
  for another selection (another campus, a widened or narrowed one, an association) or a tampered one,
  a **403 `AGENDA_SIGNATURE_INVALID`** (constant-time compare, logged `[AGENDA_SIG]`); no selection at
  all stays the 400 `AGENDA_SELECTION_REQUIRED`. `from`/`to` are NOT signed, so the window stays free.
  `assertAgendaAccess` (`directory-query.ts`) replaced `assertAgendaSelected`.
- **Open:** a **signed-in** JSON read (already narrowed to the reader's spaces by
  `restrictToViewerSpaces`). **Since 2026-11-02** the one-event link is signed too and the internal
  secret is no bypass: the SEO agenda page reads no feed ([D40 closed](#d40-closed---no-event-is-published-to-an-anonymous-reader-2026-11-02)).
- **Fails closed:** with `AGENDA_SIGNING_KEY` unset or under 32 characters the signing route and every
  signed selection answer **503**; nothing is ever served unchecked.
  **Refused at deploy since 2026-10-06**: `render-env.sh` fails the deploy naming the secret when the
  value is blank or under 32 characters (`min_length`, asserted in `deploy-env.test.sh`), because the
  iPhone reading on dev found the runtime 503 was the first place a short key showed. **The modal tells
  the two apart**: `createFeedSigner` reports `error` only for a 4xx refusal (campus text) and
  `unavailable` for a 5xx or a transport failure (its own "try later" text), classified by
  `SocialApiError` type and status, never by message.
- **Rotation is the revocation:** a new key invalidates every saved subscription URL at once. The
  signature names no one, so no single URL can be revoked. Procedure: replace the GitHub secret
  (`AGENDA_SIGNING_KEY`, dev `DEV_AGENDA_SIGNING_KEY`) and deploy; readers re-subscribe from
  `/calendar` ([MIGRATION](../../infrastructure/MIGRATION.md)).
- **Frontend:** `AgendaSelectionFields` offers "any" plus the reader's OWN campus and cursus formations
  (`campusSelectOptions(reader)`, `formationSelectOptions(reader)`) in the subscribe modal and the PDF
  export; `createFeedSigner` (`calendar/signedFeedUrl.svelte.ts`) asks for the signature while the
  modal is open and the URL carries it; the modal states that links saved before 2026-10-06 stopped
  working. A staff reader (campus, empty cursus: `isCampusWideReader`) sees their campus and "all formations"; the "complete your profile" text stays for a reader with neither a campus nor a cursus.
- **Known cost:** an anonymous visitor on an association's PUBLIC page cannot obtain a subscription
  link - signing needs a session. A calendar subscription needs an account.
- **Proof:** controller and signature specs (other campus, tampered, unsigned, `eventId` unsigned,
  another selection's signature, rotated key, unset key, internal caller), and a run against the local
  estate's real PostgreSQL.
- **Staff reading, as verified (2026-10-07, local estate rebuilt at `62a02ba0d`, real PostgreSQL and a real session):** a sandbox reader with campus `saint-etienne` and `cursus = []` was signed `campus=saint-etienne` with no formation (201); `campus=gardanne` and `campus=saint-etienne&formation=ICM` were each a 403 `AGENDA_SELECTION_FORBIDDEN`. The signed `feed.ics` answered 200 `text/calendar` and the unsigned one 403 `AGENDA_SIGNATURE_REQUIRED`. The feed held the events of several formations of the campus (organisers whose audiences were ICM and ISMIN of that campus). The subscribe modal offered Campus "Saint-Etienne" and "Toutes les formations", carried `campus=saint-etienne&sig=` in its link and did not show the complete-your-profile text. The sandbox user's cursus was restored afterwards. Not read: a gardanne-only event staying out of the feed (no such organiser existed locally).

### D38b amended - every kind may ask, and an institution's request shows its audience (owner, 2026-11-02)

**The decision, verbatim:** *"Oui partout sans exception je pense. Si un étudiant demande à
l'institution de le republier, je ne vois pas le problème ?"* - and, on the consent screen: *"Une
institution n'est pas forcément l'école, mais oui, ça peut être pertinent d'afficher un
avertissement sur l'audience potentielle d'une institution"*.

It amends **D38b** (who may ask a person) and **D34-D36** ("never a student's personal post
reaches the personnel side"), the latter **for this consented path only**.

- **Asking a person (D38b)**: `PERSONAL_REPUBLISHING_ASSOCIATION_TYPES`
  (`posts/republication-sql.ts`) names `association`, `list` and `institution`. It keeps its own
  allowlist, so a kind added later is refused (`REPOST_PERSONAL_ASSOCIATION_TYPE`) until someone
  lists it. Every other D38b rule stands: nothing is visible before the author accepts, the
  author may withdraw at any time, and the caps, blocks and anonymity refusals are unchanged.
- **What an accepted institution reaches**: the republication disjunct of `postVisibleToUserSql`
  was never typed, so the institution's audience reads the post - its members (a staff member
  among them) and the spaces its rules reach. A staff member holds no space (a campus, no cursus),
  so membership is how the staff side reads it.
- **Member reposts (WP-F6)**: `MEMBER_REPOSTABLE_ASSOCIATION_TYPES` (`spaces/reader-spaces.ts`)
  admits a LIST's post under the same conditions as an association's: at least one audience rule.
  A members-only entity's post stays refused, whatever its kind.
- **The warning**: for an INSTITUTION's request the author's inbox
  (`GET /api/posts/me/republication-requests`) carries `details.institutionAudience`
  (`institutionAudiencesOf`, `personal-republications.service.ts`), read from CURRENT state and
  never named after the School:
  - `everyone`: a `(NULL, NULL)` rule;
  - `spaces`: the rules;
  - `staffMembers`: a member with a campus and no cursus, the D34-D36 personnel; a review account
    never counts.

  `/notifications/requests` draws it (`institutionAudienceWarning`, `posts/republication.ts`):
  - "tout le monde" said plainly;
  - otherwise the spaces it reaches, or that it addresses none;
  - ALWAYS that its members see the post too, also when it has rules;
  - and the staff side whenever staff belong to it.

  Any other kind carries `null`. The warning is the owner's scope for institutions only: an
  association or a list may also count staff among its members, and its request carries no
  warning.
- **The author consents to the audience they were shown** (review of #2965): the warning carries
  a `fingerprint` (`audienceFingerprint`, a digest of the three fields), the acceptance sends it
  back (`POST /api/proposals/:id/accept`, body `{ audienceFingerprint }`), and the server computes
  it again with the SAME function, inside the acceptance's transaction after its locks
  (`assertConsentCurrent`). A mismatch, or none carried for an institution, is a 409
  `REPOST_PERSONAL_AUDIENCE_CHANGED`: nothing is decided, the client re-reads the inbox, draws the
  new warning, says why, and the author answers again.
  **An older build is refused, deliberately**: it draws no warning and sends no fingerprint, so its
  Accept of an institution's request is that same 409, read there as "no longer pending", and the
  request stays stuck on that device until the app updates (Refuse works). No fallback accepts
  without a fingerprint; floor `1.6.6` retired the case
  ([legacy-compatibility](legacy-compatibility.md#entries-166-retires-or-unblocks-the-owners-raise-of-2026-11-08)).
- **After acceptance, the audience is LIVE**: who sees the post follows the carrier's CURRENT
  audience rules and membership, never the snapshot the author accepted. A rule added later, or a
  member who joins, reads it; a member who leaves stops. The author's remedy is to withdraw the
  republication, at any time.
- **An archived carrier carries nothing**: `republicationReachesUserSql` and the newly-reached count
  (`NEWLY_REACHED_BY_REPUBLICATION_SQL`) skip an archived association, and so do the feeds' count
  of republications (`countedRepublicationsSql`, the Associations and Suivis tabs) and the card's
  "Republié par" (`republishersOf`), so archiving an entity takes its republications out of every
  feed it reached and off every card (un-archiving restores them, read from state);
  `memberRepostablePostSql` refuses an archived entity's own post.
- **No second hop**: a reader who sees a personal post only THROUGH a carrier may not member-repost
  it. The reposter's first-hand predicate (`REPOSTER_FIRST_HAND`, `FIRST_HAND`) drops the
  republication disjunct for personal posts (`personalRepublications: false`), so the post reaches
  no further than the audience its author accepted.
- **The bell follows the post**: `bellRowShownSql` re-checks visibility for every POST-BOUND row
  type (`POST_BOUND_NOTIFICATION_TYPES`: reposts, republications, announces, mentions, comments,
  replies, reactions and the `repost_personal_*` rows), so a withdrawn republication, a member who
  left, or an archived carrier takes the row out of the bell on the next read. A push already
  delivered to a device cannot be recalled. A mention is held to the read's gate when written
  (#2947, `mentionRecipientsOf`), a post's mentions told at its announce. The bell's cost and query
  shape are on [posts](frontend/modules/posts.md#the-bell-re-checks-the-post-review-of-2965-2026-11-03).
- **The client**:
  - `personalRequestCandidates` offers the same three kinds;
  - `republishCandidates` and `proposalCandidates` now also offer a LIST, which the server has
    accepted since 2026-10-31 but the client had kept out;
  - the menu entry reads "Demander à republier" ("Ask to share").

**Every place that enforced D34-D36, and what this decision did to it:**

| Place | Rule it holds | Same rule? | Done |
| --- | --- | --- | --- |
| `PERSONAL_REPUBLISHING_ASSOCIATION_TYPES` (server write and the card's offer, `PostsService.republishAsOf`) | which kinds may ask to carry a personal post | yes | widened to every kind |
| `personalRequestCandidates` (client) | the same, as offered | yes | widened, mirrors the server |
| `sharesSpaceWithAuthorSql` (`reader-spaces.ts`) | the DEFAULT reach of a personal post: a shared space, which staff never hold | no - nothing consented | unchanged |
| the personal branch spliced without `readGrants` (WP7, decision 3) | a nominative read grant never opens a student's post | no - a grant is not the author's consent, and the author's count excludes it | unchanged, asserted again by the new case |
| `acceptedFollowerOfAuthorSql` (WP-F5) | an accepted follower, a personnel included | already a consented lift | unchanged |
| `IN_FEED_AUDIENCE_SQL` | who may open the feed at all | no | unchanged (an institution's staff member is admitted by membership) |
| `AssociationsService.create` / `audience-policy.ts` (an institution starts with no rule, `everyone` is an institution's only) | an institution's audience | no | unchanged |
| publishing AS an institution needs membership (`POST_AS_ASSO`; `EditMembersTab`'s default) | being personnel gives no right | no | unchanged |

**Proof**:
- `posts/personal-republications.integration.spec.ts`, against PostgreSQL:
  - an institution asks;
  - its staff member reads nothing before acceptance and the post after it, and is told once;
  - a read-grant holder still reads nothing;
  - the author's withdrawal ends it, the staff member's bell row included;
  - the staff member leaving the institution hides the post and its bell row;
  - an acceptance carrying a stale or no fingerprint is a typed 409 that decides nothing;
  - an archived institution carries nothing, newly reaches nobody, and its own post is not
    member-repostable;
  - a list asks, and the author refuses it;
  - an unlisted kind and an archived one are refused;
  - the warning follows the institution's rules and its staff membership.
- `posts/member-reposts.integration.spec.ts`: a list's post is reposted and reaches the followers;
  renamed to an unlisted type, it is refused, offered nothing and carries nothing; a personal post
  seen only through a carrier is a 404 and offered nothing (no second hop); a post-bound bell row
  follows the post's visibility, a row bound to no post is left alone.
- `posts/republished-feed-sql.integration.spec.ts`: an archived carrier neither admits nor dates a
  post in the Associations tab, and its "Republié par" is gone.
- `posts/bell-page.integration.spec.ts`: the bell's plan walks migration 126's index and stops with
  the page.
- `spaces/member-repostable.spec.ts` and `associations.controller.institution.spec.ts`: the two
  allowlists.
- The client's `republication.test.ts` and `page.senderGone.svelte.test.ts`: the warning on the
  consent screen, its members line, and an acceptance refused for a changed audience re-reading
  the warning.

### D23 amended - MODERATE is scoped, and only the author edits a post (2026-11-02)

**Decided by the owner (2026-11-02):** *"Limiter a son espace de gouvernance, mais on garde masque,
supprime, epingle, leve l'anonymat... En fait tout sauf changer l'integrite du post, c'est a dire le
modifier"* - then, the same day: **nobody edits another person's post, the platform admin included.**

**A POST'S INTEGRITY: ONLY ITS AUTHOR CHANGES ITS TEXT.** The author is the publisher: the writer of a
personal post; for a post in an association's name, the association - **any holder of `POST_AS_ASSO`
in it edits its posts (decided, owner, 2026-11-02)**, a platform admin only by holding that flag
there. A BDE moderator and the platform admin are refused 403 `POST_EDIT_PUBLISHER_ONLY`
(`PostsService.assertMayEdit`); the card's pencil is served apart from the bin (`canEdit`, beside
`canManage`). A platform admin edits their OWN posts like anyone.

**A COMMENT'S INTEGRITY, THE SAME RULE (owner, 2026-11-02).** Only a comment's author edits its text:
the writer of an ordinary or an anonymous comment, any `POST_AS_ASSO` holder for an association's.
A moderator of the post and the platform admin may still hide or delete it, never rewrite it: an
edit by either is refused 403 `COMMENT_EDIT_AUTHOR_ONLY` (`PostInteractionsService.editComment`),
and the served `canEdit` of `commentRights` - the ONE statement that both draws the pencil and
enforces the write - is false for them. The admin tier does not count as holding `POST_AS_ASSO`
there (`CommentIdentityService.viewerFor` asks `mayActOnAny` without it). **Deleting is MODERATE's
within its scope**: the served `canDelete` is the author, the platform admin, or a moderator of the
post the comment sits under, for a plain, an anonymous and an association's comment alike - the same
answer `POST /moderation/comments/:id/delete` gives, so the bin and the route agree (2026-11-02).

**THE BDE'S `MODERATE` IS SCOPED** like MANAGE_ASSO, in `spaces/bde-moderation.ts`, on the one per-space
standing every BDE power reads (`bdeStandingInSpaceSql`, `spaces/bde.ts`):

| Target | In the BDE's scope when |
| --- | --- |
| an association's post or live | the BDE is the association's PARENT (`holdsBdeFlagOverSql`, WP-R4 on WP-D2, 2026-11-07), whatever spaces it reaches - never an institution's, never a parentless one's |
| a post or live in ANOTHER BDE's name | never, even when it is seen in the BDE's own spaces: only the platform admin, as for an institution (owner, 2026-11-03); a BDE's own content is its own members' |
| a personal post or live | its author belongs to one of the spaces the BDE governs (`isReaderSpaceSql`) |
| a comment | the post it sits under is in scope AND, for a comment in an association's name, so is that association's content - never an institution's or another BDE's (owner, 2026-11-03) (`bdeModeratesCommentSql`). Judged on itself: a reply the moderator does not moderate stays, under a moderation tombstone of what it answered (lead, 2026-11-04, [moderation-and-blocking](moderation-and-blocking.md#decisions-taken-2026-11-04-the-lead-reversible)) |
| a live chat line | its live is in scope (read from the live, or from its cut once purged) |
| a person (mute, unmute, broadcast withdrawal) | they belong to one of the BDE's spaces |
| a report | what it is about is in scope; once its content is gone, the platform admin's |

Kept within the scope: hide, unhide, delete, unmask, reading an anonymous author, deleting a
comment, cutting a live and hiding its chat lines, muting, reviewing a report. An association with no
parent (since WP-D2; before it, one with no audience rule), a person with no space (staff) and **an
institution** are governed by no BDE: their
content is the platform admin's to moderate. The institution follows from the owner's rule that no BDE
governs one (2026-11-02, 2026-11-03), even when its audience reaches a BDE's space - the management
predicate carries that exclusion once, and moderation reads it (proved in
`bde-moderation.integration.spec.ts`). **The platform admin stays global for every one of these.**

- **The door and the reach.** `isContentModerator` ("moderates somewhere") still opens the moderation
  surfaces; every act asks the scoped predicate of its target (`mayModeratePost`, `mayModerateComment`,
  `mayModerateLive`, `mayModerateUser`, `mayModerateReport`), each a composition of ONE predicate
  (`bdeModeratesPublisherSql` for association content, the per-space standing for a person's). A BDE
  moderator refused on content in an institution's or a BDE's name gets 403
  `MODERATION_RESERVED_TO_PLATFORM_ADMIN` (2026-11-04), one otherwise outside its scope 403
  `MODERATION_OUT_OF_SCOPE`, a caller who moderates nowhere 403 `MODERATOR_REQUIRED`, classified at
  the throw (`refuseModeration` and `MODERATION_RESERVED_SQL`, logged `[MODERATION]`) and worded by
  the client (`describeModerationRefusal`). **Never a 401** on these routes (review of
  #2953): only a 401 may log a user out, and these callers' sessions are fine - the post and comment
  routes answered "Not your post" / "Not your comment" / "Content moderator required" as 401s and now
  answer typed 403s (`POST_EDIT_PUBLISHER_ONLY`, `COMMENT_EDIT_AUTHOR_ONLY`, `COMMENT_DELETE_FORBIDDEN`,
  `MODERATOR_REQUIRED`). No client branch read those 401s.
- **The lists are narrowed in SQL**: the report queue (`reportInBdeScopeSql`), the hidden posts and the
  muted list, so a page's bounds stay true.
- **The client draws only what the server accepts**: `canManage`, `canPin`, `canUnmaskAnonymous` per
  post and comment `canDelete` from the post's scope; `canEdit` for the pencil; per report
  `canMuteReporter` / `canMuteReportedUser` (the latter also gates the broadcaster withdrawal); per
  live `viewerModerates`, on the list AND on `GET /lives/:id` (the staff hide button). **An absent
  field is false, never a fallback**: the pencil is not drawn from `canManage`, nor the hide button
  from "moderates somewhere" - either would draw a control the server refuses.
- **Live chat**: an out-of-scope BDE moderator is no staff for that live and gets the hide route's 404,
  as any non-staff caller does.
- **Proof:** `bde-moderation.integration.spec.ts` (real PostgreSQL: posts, people, lives including a
  purged one, the report queue by type), `posts.service.can-manage.spec.ts` (BDE in and out of scope,
  the platform admin's edit of another person's post refused), the moderation and lives controller
  specs.

### The agenda's space filter (owner, 2026-11-10)

A reader whose signed-in agenda reaches SEVERAL spaces narrows the VIEW to one campus or one
formation. It replaced the "Association" select of `/calendar`, which named nothing a reader thinks
in; an association is still reached from its own page, and a `?association=` deep link keeps working
(the remembered space is ignored while it is active, and a "show everything" button resets both).

- **Options** come from `GET /api/associations/calendar/spaces` (signed in), `AGENDA_REACHED_SPACES_SQL`
  (`reader-spaces.ts`): the reader's OWN spaces; the spaces addressed by the rules of an association
  they are a MEMBER of (D21); and, for a read grant, the spaces of a ticked cell that an association
  addresses. **The (NULL, NULL) "everyone" rule addresses no space here**, and an association merely
  visible through its rules adds nothing - otherwise every reader would get every option. So a
  one-space student reaches one space (filter hidden); a student who joined an association of another
  space, or staff or an admin with read grants over several spaces, reach those.
  `agendaSpaceOptions` (`calendar/agendaSpaceFilter.ts`) lists "Tous les espaces", the campuses, then
  the formations, **drops an axis with a single value (its option would equal "all") and hides the
  control when fewer than two choices remain**.
- **An event visible only through membership (D21)** whose association does not address the chosen
  space is hidden under that filter: the narrowing keeps events by the spaces their association
  addresses, not by who may read them.
- **Narrowing** is the feed's existing `campus=` / `formation=` query (`restrictToSelection`,
  `eventReachesSpaceMatchingSql`), applied on top of `restrictToViewerSpaces`: it can only shrink the
  answer. It is a view setting and decides nothing about access.
- **Remembered per reader** in `localStorage` (`ACCOUNT_KEY.agendaSpaceFilter`, swept with the
  account). The first month is asked with the remembered value; a value the reader's spaces no longer
  offer is dropped and the month re-read. The subscribe link and the PDF export keep their own
  selectors (D40) and do not follow this filter.

### D40 closed - no event is published to an anonymous reader (2026-11-02)

**Decided by the owner (2026-11-02):** only what the student portal shows is public, and it shows no
event. So without a session, NO event is served, whatever the association's audience - an institution
addressing everyone included. The anonymous ways in are capabilities a member hands out, and only
those:

- **A signed selection** (`/calendar/feed` and `feed.ics` with `sig`, [D40 amended](#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)) - unchanged.
- **A signed single-event link** (`feed.ics?eventId=..&sig=..`): `sig` is that EVENT's signature,
  `v1|event-ics|event=<id>` under `AGENDA_SIGNING_KEY` (`signEventIcs`, `agenda-signature.ts`; its own
  canonical prefix, so neither kind can be read as the other). The server serves it on every validated
  event it lists (`icsSig`, `withEventIcsSig`, on `/calendar/feed`, `/:id/events`, and the linked
  event of a post or a form, `withOneEventIcsSig`; `event-ics-sig-routes.spec.ts` fails if a route
  drops it); the client puts
  it in the "add to my calendar" link (`eventIcsAbsoluteUrl`, the event modal's export) and builds no
  link without it. An unsigned or wrongly signed request is a **bodyless 403**, logged with the tag
  `[AGENDA_ICS_REFUSED]` - the count to read after a release, to measure links still saved in the
  old form. No time-based grace period.
- **What a signature is, accepted by the owner as a capability link (2026-11-02):** it **never
  expires**, it is **not bound to the event's current audience** (it names the event, nothing else:
  a link handed out stays valid if the audience later narrows), and **only a rotation of
  `AGENDA_SIGNING_KEY` revokes it** - which revokes every agenda link, selections included. The same
  holds for a signed selection. Whoever holds the link reads that one event; that is the design.

What answers nothing without a session:

- **`GET /api/associations/:id/events`** answers an EMPTY list, never a 401 - the public association
  page draws "no event", as it does for every other gated block (`AssociationsService.isAnonymousAgendaRead`,
  logged `[AGENDA]`). A signed-in reader keeps `restrictToViewerSpaces`, a global admin the whole.
- **The server-side SEO of `/calendar`** writes no `Event` into its JSON-LD and reads no feed
  (`serverSeo.ts`): the JSON-LD of a page is read by every anonymous visitor and crawler. The internal
  secret grants the feed nothing.
- **Consumers, enumerated:** the association page's agenda block (`AssociationCalendarSection`, the
  only anonymous reader of `/:id/events`: empty for a visitor); the composer's linkable-event picker
  (`listLinkableValidatedCalendarEvents`, signed in); the edit pages (signed in); a post's linked
  event (`/posts/:id/calendar-link`, guarded, behind the post's own visibility); a form's linked event
  (`/forms/:id/calendar-link`, guarded since 2026-11-02 and filtered by `eventVisibleToViewerSql`, so a
  reader outside the event's audience gets `null`); the event modal's
  "add to my calendar" link (signed per event); the native apps run the same web client. **nginx** has
  no per-route allowlist here: `/api/associations` goes through `auth_request` to core's `verify`,
  which answers 200 with empty identity headers for an anonymous caller, so the decision is the
  service's and nothing changes at the edge.
- **Proof:** `associations.service.calendar-owner.spec.ts` (an anonymous read answers before any
  query), `coorganisation.integration.spec.ts` on real PostgreSQL (an association addressing everyone
  is empty anonymously and read signed in), the controller specs (the event link signed for that
  event, refused bodyless otherwise, never on the selection's signature; the internal secret is no
  bypass), `serverSeo.test.ts` (no feed read, no `Event`) and `eventIcsUrl.test.ts` (no link without
  the signature).

### WP6e institutions as built (2026-10-05)

Migration `075_institution_type.sql` (replay-safe) adds `CHK_associations_type` over `association | list | institution`.
An institution is an `associations` row of that type, so it reuses every mechanism rather than adding a second one:

- **Deleted by a global admin only (owner, 2026-11-02)**, as it is created: `DELETE /api/associations/:id` on an
  institution is a 403 `INSTITUTION_DELETE_ADMIN_ONLY` for a BDE member holding MANAGE_ASSO that governs it, which
  keeps deleting the associations and lists it governs. The edit page's `editRights(..).delete` follows (`editSections.ts`).
- **Created by a global admin only** (D20, D24): `POST /api/associations` with `type: 'institution'` is a 403 for a BDE
  member holding MANAGE_ASSO, before any write. Since 2026-10-07 the UI is `/institutions/new` (button "Créer une institution" on `/institutions`, global admin only; the checkbox of `/associations/new` is gone), see [associations](frontend/modules/associations.md#one-header-and-one-creation-flow-for-the-three-directories-2026-10-07).
- **Members are added nominatively** by the platform administrator alone (since 2026-11-02, D20 above; it was the existing member admin until then); **publishing in its name needs membership of it**
  with `POST_AS_ASSO`, exactly as for an association (being personnel gives no right, D34-D36). Events are proposed with
  `PROPOSE_EVENT` the same way; the post composer and the event picker are type-agnostic.
- **Republishing**: `REPUBLISHING_ASSOCIATION_TYPES` is now `association, institution` (a list still does not); the
  dialogs offer institutions. Co-organisation takes any association row, so institutions co-organise too.
- **Listings**: `?type=institution` is accepted by the directory and the public listing. **`/institutions` is its own page**
  (user, 2026-10-05): the same directory API and `AssociationTile` as `/associations` and `/lists`, narrowed by type, so the
  same visibility (rules reaching the reader's spaces, plus memberships, D37). `/associations` no longer lists institutions in
  its catalogue (the cleaner reading of the choice; since 2026-10-19 the reader's own institutions are the "Mes institutions" block on top of `/institutions`, and "Mes listes" on top of `/lists`) and carries an
  "Institutions" button, as it does for lists. The page is `noindex` like `/lists` and has its title in `resolve.ts`. An
  institution can never be a BDE (the `/admin/spaces` button is for `association` only).
- **Reach**: its audience rules (its ceiling, D33) are the same `association_audiences` rows, edited on the grid.
  **A new institution has NO rule** (user, 2026-10-05): `AssociationsService.create` skips D36's default for
  `type: 'institution'`, so it is visible to its members only until an admin ticks the `/admin/spaces` grid (a global
  admin's own spaces are rarely the School's). D33's one mechanism is kept: the type decides the default, nothing else
  differs. `associations.service.create-default-audience.spec.ts` carries the control (an institution created by someone
  with spaces writes no rule).
- **D31 closes as "membership only"** (user, 2026-10-05): a person with no space publishes AS AN INSTITUTION through the institutions they
  are a MEMBER of, with `POST_AS_ASSO`. Nothing to build; no way to pick an institution one does not belong to. (Amended 2026-11-02: they may also publish a personal post, seen by their accepted followers only - see D31.)

### Audiences policy as built (WP-A, 2026-10-08)

Server half of the seven decisions of [the decisions](#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08); the client presets (WP-B) come after. One module, `spaces/audience-policy.ts`, holds the rules and the typed codes (classified at the throw: a client reads `code`, never the message).

- **Default at creation replaces D36's "creator's spaces"**: `AssociationsService.create` writes, in the transaction of the row, the creator's default for an association AND a list - a global admin's whole profile campus, a BDE star's governed spaces of it (`creatorDefaultRules`, aligned 2026-11-03, see WP-B below). A creator with no valid campus is refused `400 AUDIENCE_CREATOR_CAMPUS_REQUIRED` and the row rolls back (decision 5, never guessed). An institution still gets NO rule: the creating global admin ticks its audience afterwards (`PUT /api/associations/:id/audiences`).
- **`everyone` refused outside institutions** (decision 6): `setAudiences`, the one write path of the audience (the admin grid and the BDE both call it), refuses any rule with `campus` NULL - a formation across campuses included, which is the multi-campus audience decision 3 rules out - with `400 AUDIENCE_EVERYONE_INSTITUTION_ONLY`, for a global admin too. Creation writes only a campus rule, and `PATCH` cannot change an entity's type, so nothing else writes a rule. Existing everyone rules stay until someone edits that entity.
- **The BDE star** (decision 7; since 2026-11-03 "Lire tout, modifier dans ses espaces", owner, verbatim): `PUT /api/associations/:id/audiences` is open to a global admin OR the holder of MANAGE_ASSO in a BDE (the spaces that BDE governs, `BDE_SPACE_STANDINGS_SQL`); `PUT /api/associations/spaces/:id/bde` (the BDE flag) stays global-admin only. A star is refused `AUDIENCE_ADMIN_OR_BDE_REQUIRED` when it governs no space and `AUDIENCE_INSTITUTION_ADMIN_ONLY` on an institution. Otherwise a star READS the audience of any association or list of its campus (`assertBdeMayReadAudience`: one rule on a campus where it governs a space, or no rule); it WRITES only an entity it already governs (`holdsBdeFlagOverSql` at MANAGE_ASSO - never an institution, never another BDE, `AUDIENCE_OUTSIDE_BDE_CAMPUS`), and every rule the write ADDS or REMOVES must lie inside the spaces it governs (`changedRules` + `ruleInsideGovernedSpaces`). A rule already in force that exceeds them - a whole-campus rule over a campus two BDEs share - is left as it is: the star can neither remove nor widen it (`403 AUDIENCE_RULE_BEYOND_BDE_SPACES`); widening beyond its spaces is the platform admin's alone. The read returns each rule with `editable`, and the editor lists the non-editable ones read-only and sends them back unchanged. This closes the two-granularity gap until the governance reform lands (WP-R1 of `spaces-and-audiences-reform.md`, draft PR #2948); see [association-permissions](association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02).
- **A change applies to everything, past posts included** (decision 4): visibility is computed from the CURRENT rules at read time and nothing is stored on a post (D38). Proof: `reader-spaces.integration.spec.ts` moves an association's audience under a stored post and the post follows (gated on `SOCIAL_IT_DATABASE_URL`, which CI's `test-social-integration` sets).
- **No back-fill migration.** `users` belongs to core-service, so a social migration reading `users.campus` would fail on a fresh database, and an entity D36 left rule-less (creator with no space) was left so on purpose. Measure first, read-only (never run by an agent against production), then decide with the user:

```sql
SELECT a.type, count(*) AS no_rule, count(u.campus) AS creator_has_campus
FROM associations a
LEFT JOIN users u ON u.id = a."createdBy"
WHERE a.type IN ('association', 'list')
  AND NOT EXISTS (SELECT 1 FROM association_audiences r WHERE r."associationId" = a.id)
GROUP BY a.type;
```

Closed by WP-B (2026-10-08), aligned 2026-11-03: a NON-admin creator's entity starts with an audience it may EDIT (`creatorDefaultRules` in `audience-policy.ts`, from `BDE_SPACE_STANDINGS_SQL`): the spaces of its profile campus its BDE governs - the whole campus when it governs every opened space of it, otherwise one rule per governed formation, never a whole campus it shares with another BDE. A creator governing no space of its campus is refused `403 AUDIENCE_OUTSIDE_BDE_CAMPUS` inside the transaction (the row rolls back). A global admin is unchanged (its whole profile campus) and runs no standing query. Cases in `associations.service.create-default-audience.spec.ts`.

### Audiences client presets as built (WP-B, 2026-10-08)

Client half of the seven decisions. Files: `lib/associations/audiencePresets.ts` (pure: `offeredPresets`, `presetToRules`, `readPreset`), `audienceRefusal.ts` (the five codes), `components/associations/edit/EditAudienceTab.svelte`, `components/profile/ProfileCampusPrompt.svelte`.

- **Three presets, and `everyone` only for an institution.** Decision 1 lists three presets but also says `everyone` is for institutions, so an association or a list is offered TWO (`campus`, `formations`) and an institution THREE. `presetToRules` maps them to `(null, campus)`, `(formation, campus)` per ticked formation, and `(null, null)`; a half-filled choice yields NO rule, never a wider one. The server stays the rule (`AUDIENCE_EVERYONE_INSTITUTION_ONLY`).
- **Where.** An "Audience" tab on the association edit page, for a global admin, or a BDE star of THIS association (`me/bde-reach`) when it is not an institution. A member of the association alone does not see it: the server refuses them (`AUDIENCE_ADMIN_OR_BDE_REQUIRED`), so offering it would be a button that can only fail. The global admin keeps the campus picker and a link to the `/admin/spaces` grid.
- **A star READS the current audience of its campus ("Lire tout", owner 2026-11-03; it was "campus de l'etoile seulement", 2026-10-08, with every rule inside).** `GET /api/associations/:id/audiences` is a global admin's, or a star's for an entity with a rule on a campus where it governs a space, or with no rule (`assertBdeMayReadAudience`: codes `AUDIENCE_OUTSIDE_BDE_CAMPUS` / `AUDIENCE_INSTITUTION_ADMIN_ONLY` / `AUDIENCE_ADMIN_OR_BDE_REQUIRED`). Each rule carries `editable`; the ones beyond the star's spaces are listed read-only. The editor reads it with `getAssociationAudiences` for both roles and preselects the matching preset (a custom, grid-edited audience is reported as custom); only when the read is refused does it open with no preset ticked and the "saving replaces what is in force" warning.
- **Typed refusals.** `audienceRefusalCode` reads `SocialApiError.code` (set by `request()` from the body), never the message; each of the five codes has a Paraglide sentence (`audience_err_*`).
- **No campus: the profile prompt** (decision 5). `AssociationCreatePage` reads the own profile on mount and, for an association or a list with no valid campus, shows `ProfileCampusPrompt` instead of the form; a stale profile that the server still refuses (`AUDIENCE_CREATOR_CAMPUS_REQUIRED`) lands on the same prompt. The campus is MiConnect's and only an admin edits it, so "complete the profile" is the EXISTING correction request (`ProfileCorrectionRequest`) plus the link to `/profile`.
- Tests: `audiencePresets.test.ts`, `audienceRefusal.test.ts`; server `associations.service.create-default-audience.spec.ts`.

### Nominative read grants as built (WP-C, 2026-10-08)

The seven decisions of [the decisions](#the-nominative-read-grants---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08), WP7 of D24.

- **Model** (migration `078_read_grants.sql`): `read_grants(user_id, campus, formation NULL = whole campus, granted_by, created_at)`, unique per cell (`COALESCE(formation, '')`, so NULL repeats are refused), no end date; `read_grant_journal` is append-only (`grant`/`revoke`, `actor`, `at`). A revocation deletes the grant row and writes the journal line in one transaction; setting a state already held writes nothing, so the journal records changes only. API: `GET`/`PUT /api/associations/read-grants` (`read-grants/read-grants.*`), GLOBAL ADMIN ONLY on both - the list is internal, a grantee cannot even read their own row. Granting to an unknown account is a 404.
- **Visibility plugs into the one predicate**: `readGrantReachesAssociationSql` in `spaces/reader-spaces.ts` - a grant cell contains the OPEN spaces it matches, and an association is reached when one of ITS RULES reaches such a space (any type; an institution addressing Gardanne is reached by a Gardanne cell whatever campus the grantee has). It is spliced through `ReadOpts.readGrants`, which only the `*ToViewerSql` read paths turn on (feed, search, one post, comments, reactions, votes, signed-in agenda, calendar link) and the feed gate (`IN_FEED_AUDIENCE_SQL`, so a named reader with no space and no membership opens the feed). It goes into the ASSOCIATION branch of `postVisibleToUserSql` (and the republisher's), never the personal-post branch: personal posts stay invisible by construction.
- **Not widened**: `announceRecipientsSql` and `NEWLY_REACHED_BY_REPUBLICATION_SQL` use the plain predicate, so a grantee is NEVER notified; the directory (`associationVisibleToViewerSql`) is unchanged; the agenda signing (D40, `signAgendaFeedSelection`, `READER_SPACES_SQL`) signs the reader's OWN spaces only, a grant adds none, and the anonymous selection has no reader. Publishing is untouched: a grantee publishes through an institution they belong to (D31).
- **UI**: `/admin/read-access` replaces `/admin/document-reviewers`. Since 2026-10-16 it is two tabs drawn by one template - a card per named reader with their campuses and formations as chips, edited in a sheet (ISTP is FSSS, noted there), each change saved at once with an undo toast, the journal folded under the list - and the document reviewers in the other tab ([admin](frontend/modules/admin.md#read-access-adminread-access)). It was first built as a person x (campus x whole-campus/ICM/ISMIN/FSSS/PDIS/Autre) grid of checkboxes; the document-reviewer list stayed a separate capability (its `document_reviewer_grants` rows were NOT moved: it is a different capability - public documents - and still open to BDE super-admins, who do not see the grid).
- **Proof**: `spaces/read-grants.integration.spec.ts` (real PostgreSQL, `SOCIAL_IT_DATABASE_URL`): per-post matrix over four named readers, personal posts never visible (even with `adminSeesAll`), no-grant readers unchanged, gate, agenda, no notification, directory unwidened, revocation, unique key, idempotent migration; `read-grants.service.spec.ts` for the writes.
- **THE WRITE BOUNDARY (review of 2026-10-08, user decision "read + react/comment")**: a grant lets its holder **read and react: YES; comment and like a comment: YES only with their switch "voit les commentaires" on (2026-11-04, next bullet); vote in a poll, republish, publish: NO.** `postVisibleToViewerSql` counts the grant by default (every read) and takes an explicit `readGrants: false` for the writes a grant never opened. `PostsService.assertVisible(postId, viewer, intent)` has a REQUIRED intent: `'READ_OR_REACT'` (post by id, calendar link, reaction), `'COMMENT'` (list, write, edit and like a comment, report a comment - the grant counts, then the comments predicate of the next bullet) or `'VOTE'` (the poll vote, grant-free). `RepublicationsService.assertVisibleTo` is grant-free: a grantee who also publishes as some association X cannot republish into X a post only the grant shows them (404, like any post they cannot see). Publishing a post is unchanged and stays through an institution (D31). Proof: `read-grants.integration.spec.ts` (read-or-react vs vote over every post and reader), `republications.integration.spec.ts` (a grantee who is POST_AS of an association is refused, no row written), `posts.service.visibility.spec.ts` (the SQL of `'VOTE'` has no `read_grants`), `posts.controller.visibility.spec.ts` (each route passes its intent). **Narrowed on 2026-11-04 for comments** - next bullet.
- **COMMENTS AND PEOPLE OF A GRANT-ONLY POST (the 2026-11-04 amendment, [decisions](#the-nominative-read-grants---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08))**. ONE predicate, `commentsWithheldFromViewerSql(post, viewer)` in `spaces/reader-spaces.ts`, the posts' half of the ONE definition of "withheld" (`withheldFromGrantOnlyReaderSql`, shared with the live chat - next bullet): the viewer is no global admin, holds a grant, their switch is OFF (`readerSeesGrantCommentsSql`: no `read_grant_readers` row with `sees_comments`), the post is visible WITH grants and NOT visible WITHOUT them (both arms `adminSeesAll`, as the by-id gate does, and a reader who also reaches the post natively - own space, membership, republication, accepted follow, member repost - keeps everything). It composes with the "Entre étudiants" gate ([as built](#the-students-only-switch-as-built-owner-2026-11-04)) with no term of its own: the gate sits INSIDE `postVisibleToUserSql` and closes the grant door on such a post, so there the two visibility arms agree (no grant door either way) and the predicate is never true: a named reader who reaches it only through a grant - a student holding a grant on another cell included - never opens it, and one who reaches it natively keeps everything; a live has no students-only column, so the live half below is unaffected. Its consumers, each asking it and nothing else:
  1. **list, write, edit and like a comment, and report one** - `assertVisible(.., 'COMMENT')` (the edit's answer serves the comment, who liked it included; deleting one's own comment stays open), and `ModerationService` asks `readPostOpenVerdict(.., 'COMMENT')` for a comment report - a third `PostAccessIntent` (`post-openable.ts`: the grant opens the audience term, then a withheld reader is `not-found`, the 404 of an invisible resource);
  2. **the served post** - feed, search, reels, one post by id, a vote's and a write's answer - through `PostViewerContext.commentsWithheldIds` (`commentsWithheldPostIds`, `posts/comments-withheld.ts`, asked only of the page's posts NOT in `grantFreeIds` - the predicate's own last term - so an ordinary reader's page and an administrator's cost no query for it) and the two shaping points (`shapeListRow`, `toPublicPostFromEntity`): `canSeeComments: false`, no `comments`, no `commentCount`, `reactions` = the reader's own entry plus `otherReactionCounts` (a tally by type), named polls served as tallies (`votes: number`, `votesByUser` = the reader's own) - never another id;
  3. **the reaction routes' answer** - `PostsService.serveReactionsTo`, for the add AND the removal (which is not gated, so it also stopped listing a post's reactors to whoever held its id: an outsider gets their own entry only);
  4. **comment-borne notifications** - a comment's mention and, new, a REPLY ask `mentionRecipientsOf(.., 'COMMENT')` (a reply was pushed to the parent's writer with no visibility check); the bell hides every comment-borne row on such a post (`commentBorneNotificationSql`): `comment` and `reply`, and a `mention` a comment wrote - classified at the write since migration 132 (`post_notifications."commentId"`, set by every row a comment writes), and for an older row by the actor it already holds (a post's own mention names the post's author, or the anonymous actor on an anonymous post; anybody else is a comment). Two old comment mentions stay shown, as a post's: the post author's in a comment of their own post, and an anonymous or association comment's on an anonymous post;
  5. **the poll vote** is unchanged: grant-free (`'VOTE'`), so a grant-only reader never voted, switch or not.
  Reacting stays open (`'READ_OR_REACT'`). The switch is per PERSON (`read_grant_readers`, migration 132, not held: a new table, a relaxed NOT NULL, a widened check, and the nullable `post_notifications."commentId"`), set by `PUT /api/associations/read-grants/comments` (`setSeesComments`, global admin only, idempotent, 404 for an unknown account when turned on), journalled as `cmt_show`/`cmt_hide` lines of `read_grant_journal` (no cell: `campus` NULL, a check ties the two), changes only; the feed cache is dropped on a change. Revoking a reader's LAST cell turns their switch back OFF in the same transaction, journalled as `cmt_hide` by the revoking admin, so a reader granted again later starts OFF like any new one. Erasure deletes the reader's row and anonymises `updated_by`. Client: `canSeeComments === false` draws no comment button, count, preview or thread on a card (`PostCard`) and no comment column on a reel's rail (`ReelActionRail`), the reaction badges count `reactionCountsOf` and open no "who reacted"; the admin sheet carries the switch ([admin](frontend/modules/admin.md#read-access-adminread-access)). Proof: `spaces/read-grants.integration.spec.ts` "comments of a grant-only post" (real PostgreSQL; three readers - OFF, ON, granted AND native - over react, list/write/like a comment, the served comments and count, reactors and voters, `serveReactionsTo`, the vote, comment mentions and replies, the bell and its mention rows old and new, the last revocation's reset, the journal, migration idempotence); `posts.service.blocked-list.spec.ts` through the SHIPPED feed and search (`listPosts`, `searchPosts` -> `viewerContext` -> `shapeListRow`), and that an ordinary reader's page asks nothing; `posts.controller.visibility.spec.ts` (the edit's gate), `moderation.service.spec.ts` (a comment report refused, a post report filed). **Break-proof, run 2026-11-04**: with `commentsWithheldFromViewerSql` returning `false`, 7 of its 11 tests fail (comments, count, reactors/voters, the reaction answer, mentions/replies, the bell, re-hiding), and 3 unit tests with them; with the `'COMMENT'` term of `readPostOpenVerdict` removed, 3 integration tests and `posts.service.visibility.spec.ts` fail. Run again after the review of #2998: without the withholding call in `shapeListRow`, the feed and search tests fail (2); without the `commentId` term, 2 bell tests; without the last-revocation reset, 1 integration and 1 unit test; without the edit's gate, 1; with a comment report on the post's intent, 1.
- **THE CHAT OF A GRANT-ONLY LIVE (owner, 2026-11-04, the same switch, built)**. A named reader who watches an association's live ONLY through their grant sees the video, the viewer count and the floating reactions, and NOT its chat - unless their switch is on. ONE predicate, `liveChatWithheldFromViewerSql(live, viewer)`: the lives' half of `withheldFromGrantOnlyReaderSql`, on `liveVisibleToUserSql` with and without grants (a member's live never opens through a grant, so in practice an association's live). It is asked IN the watch rule's own statement (`LivesService.assertMayWatch`), so the visibility and the chat's fate are read on one snapshot. Its consumers, each through that one answer:
  1. **the open** - `GET /api/lives/:id` carries `chatWithheld`, so the viewer draws no chat (and no chat toggle) from the first frame - the comments rule exactly, nothing hinting at a hidden discussion ([lives](services/lives.md#who-may-watch-the-rule-of-a-post));
  2. **the stream** - the chat rides the manifest poll (one request a tick, [lives](services/lives.md#who-may-watch-the-rule-of-a-post)), and a withheld reader's chat block reads NO message row: `messages: []`, `messagesCursor` = the newest seq, the reactions as for anyone, `withheld: true`. Nothing is hidden client-side only: the lines never leave the server;
  3. **sending** - `POST /api/lives/:id/messages` asks `LivesService.mayChat`: `403 LIVE_CHAT_WITHHELD`, nothing written. A 403 and not the 404 a withheld comment gets: the reader watches a live that IS visible to them, and a chat 404 means "the live is over" to the client (`isLiveOverRefusal`). A floating-reaction burst stays open (`mayWatch` only), as a post's reactions do;
  4. **reporting a line** - `ModerationService.createChatLineReport` reads `chatWithheld` in `reportableLive`'s statement: the `404 LIVE_NOT_FOUND` of a hidden line (no line was served, so none can be reported). A report of the LIVE itself stays open: they watch it;
  5. **moderation** - hiding a line and the staff queue are the broadcaster's and staff's (`mayModerateLive`), never a reader's: unchanged;
  6. **notifications** - a chat line writes no bell row and no push, to anybody (the server cannot read a sealed line, so there is no mention to resolve); the live's own announcement already leaves named readers out (`liveAudienceSql`, the plain predicate).

  **A switch flip mid-live** holds from the NEXT poll on, both ways, without a reopen: every poll asks the predicate again, from the row - no cache, no timer. OFF: the next block is withheld and the client drops every line and its message cursor; ON: the client polls as a joiner (no cursor) and is served the backlog like anyone opening the live. A send racing the flip is refused 403 and the client applies the same verdict. Client: `LiveChatSession` (`onKey(key, { chatWithheld })`, `receive`, `onWithheld`), `LiveViewer` drawing no chat area and no chat toggle while withheld (a send while withheld is refused locally, `'withheld'`, and a block still opening when the chat is withheld draws none of its rows); the switch's two hint lines in `/admin/read-access` now name the lives' chat. No migration: the switch is migration 132's `read_grant_readers`. Proof: `lives/lives.integration.spec.ts` "a named reader and the chat of an association live" (real PostgreSQL; four readers - OFF, ON, admin, native - over the open, the poll with and without a cursor, the send and the burst, a line's report, no notification, and a flip ON then OFF mid-live); `lives.controller.spec.ts` (the flag reaches the chat read and is never a manifest field), `live-chat.service.spec.ts` (a message asks `mayChat`, a burst `mayWatch`); client `liveChat.test.ts` (the open, a withheld block, the way back, a 403 send, a send while withheld, a block withheld mid-way), `LiveViewer.svelte.test.ts` (no chat, no toggle, the reactions kept). **Break-proof, run 2026-11-04**: with `liveChatWithheldFromViewerSql` returning `false`, all 5 integration tests fail; with the send asking `mayWatch` and the report's term removed, 3 (send, report, flip).
- **Ids**: `users.id` is the OIDC subject lowercased (`NginxAuthGuard` lowercases `x-user-id`; core-service does the same), so the controller lowercases the grantee id and the actor before storing. No foreign key crosses services, so the account-deletion hook (`InternalController.deleteUserData`) deletes the account's grants and anonymises it (`[deleted]`) in the journal, both as grantee and as actor.
- **Cost, measured** (throwaway PostgreSQL 16, 50,000 posts over 300 associations, 20,000 users, 40,000 requested grants = 8,000 grantees with a few cells each - a real grantee holds at most 12 cells, so "20k grants on 200 users" cannot exist; `EXPLAIN (ANALYZE, BUFFERS)` of `postVisibleToViewerSql` as a filter, `ORDER BY createdAt DESC LIMIT 20`, 3rd run, JIT off): a reader with NO grant 600 ms / 198k buffers before this change, 670 ms / 268k buffers with it (+10%, the per-row grant lookup finding no row); a grantee 1,060 ms / 464k buffers. With JIT on the same queries are 930 / 1,180 / 1,500 ms. The baseline itself is a nested loop over every post (the predicate is evaluated per row), which is the pre-existing shape of the feed predicate, not this change. **No index added**: `CREATE INDEX ON association_audiences ("associationId")` was tried and the planner kept the sequential scan of a 300-row table in all six plans; `read_grants` is already served by `idx_read_grants_user` (bitmap index scan).
- **Owed**: one look at the grid signed in. The feed cache is dropped on every real change.

#### The eight dev checks (2026-10-09, `dev.canari-emse.fr` on `1.2.1-alpha.1`, same code as `v1.2.1`)

Set up through the API as the dev global admin (a dedicated test account): two throwaway associations, one with the audience `(campus gardanne, every formation)` holding a post and a poll post, one saint-etienne control. Grantee: a dedicated test grantee (ICM, saint-etienne), granted the whole gardanne campus with `PUT /api/associations/read-grants`. Every fixture, the grant, the membership and the BDE flag were removed afterwards (re-read in the dev database: 0 left).

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | a grantee sees the association posts of the granted campus | PASS | before the grant `GET /api/posts/:id` 404 for both posts; after it 200, and both are in `GET /api/posts?limit=50` |
| 2 | no personal post of that campus | PASS, on the predicate | dev has NO personal post by a gardanne author and that test account's credentials are not in the harness state, so no end-to-end post. The shipped `postVisibleToViewerSql` was run read-only on the dev database with the grant live, over a personal post by each of the 8 gardanne users: `false` for all 8, `true` for the association post |
| 3 | can react | PASS | `POST /reactions` 201 |
| 4 | can comment | PASS | `POST /comments` 201 |
| 5 | cannot vote through the grant | PASS | `POST /polls/:pollId/vote` 404 `Post not found`; the stored poll keeps zero votes |
| 6 | cannot republish through the grant | PASS | the grantee, `POST_AS` of a saint-etienne association, gets 404 `Post not found` and no row is written; control: the same grantee republishes a post it sees natively, 201 |
| 7 | a revoke restores the baseline | PASS | after the revoke: post 404, reaction 404, comment 404, the posts gone from the feed, `Publication introuvable` on screen |
| 8 | a star reads audiences of its own campus only | PASS | before: 403 `AUDIENCE_ADMIN_OR_BDE_REQUIRED`; as `MANAGE_ASSO` of a saint-etienne BDE: own-campus association 200 `[{campus: saint-etienne}]`, the gardanne association 403 `AUDIENCE_OUTSIDE_BDE_CAMPUS` |

Two P3 client defects were found on the way, both in the [backlog](backlog.d/audiences-of-associations-lists-and-institutions-built-in-production-since-v1-2.md).

### Follow requests, member reposts and visibility between spaces - the decisions of 2026-10-25, all shipped

**Closed 2026-11-11 (backlog triage, batch 11):** WP-F1 to WP-F7 all shipped - F1-F4 in `1.5.1`, F5 in `1.5.4`, F6 in production since `v1.6.1`, F7 done - and the review's open items are built (the three lists page by cursor; a save keeps the categories its build does not know, `unknownDisabled` in `notifications/preferencesApi.ts`; the unblock severs first) or moot (the `minClientVersion` question: the floor is `1.6.6`). The record below is the plan as decided, kept as the history of these sections.

**Starts AFTER the stable `1.4.1`; WP-F1 to F4 shipped in `1.5.1` (#2616), WP-F5 MERGED (#2827, ships in `1.5.4`), WP-F6 IN PRODUCTION since `v1.6.1` (#2859, migrations 121 and 123; hardened by #2917, and #2920 made the posts of lists and members-only associations non-repostable).** Today following a person is free and
silent (`user_follows`, no status), a personal post is seen by readers sharing a space with its
author (`postVisibleToUserSql`), and only associations republish (D38, D38b in
[profiles-and-access](#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built)).

#### The decisions

1. **Member reposts.** A member may republish another member's post to THEIR OWN followers, with
   the AUTHOR's consent: an "allow reposts" setting, per author or per post. A post of an
   association or an institution that addresses at least one space is reposted without asking;
   never the post of a list or of a members-only association (owner, 2026-11-02). Never an anonymous post. A block
   applies both ways. Hiding the original removes every repost. Same rules for reels. A repost
   enters the Suivis feed of the reposter's followers at the time of the repost; a notification goes
   only to readers who NEWLY see the post (the D38 rule).
2. **Follow requests.** Following a PERSON becomes a request the person accepts or refuses.
   Associations, lists and institutions stay free to follow, with no acceptance phase. Students are
   PRIVATE by default (requests to approve), every other profile public (accepted automatically);
   each user may change their own setting.
3. **Existing follows are kept**, recorded as accepted. Every user gets a followers list with a
   "remove follower" action. The processing goes into the register (C5) and the privacy policy.
4. **Visibility opens to accepted followers.** The user: *"Si on garde le systeme d'acceptation,
   pas la peine d'avoir des barrieres, meme entre espace, campus, formation etc. On peut ouvrir les
   vannes de visibilite je pense."* With acceptance in place, a personal post is visible to its
   author's ACCEPTED followers whatever their space, campus or formation, and the D34-D36 rule
   "personnel never see a student's personal post"
   ([profiles-and-access](#d34-d36---who-is-who)) no longer holds for a
   personnel the student accepted. Read grants (WP7) stay out of the personal branch.
5. **The opening reaches ONLY accepted followers** (user, 2026-10-25, answering the lead's open
   question). The Tout feed stays filtered by spaces for non-followers, so what widens is exactly
   what the author approved, one person at a time.

#### Follow requests: the four product rules taken on 2026-10-25, all of it still to build

- **Q1 - ALL PERSONAL ACCOUNTS ARE PRIVATE** (user: *"Tous les comptes sont prives alors. Pas besoin
  de faire de distinctions entre les comptes."*). Following any PERSON is a request the person
  accepts; there is no public/auto-accept variant, no per-profile default and no setting to switch
  it. Entities (associations, lists, institutions) stay free to follow. "Private" governs who may
  FOLLOW; space visibility of the Tout feed is unchanged. This SUPERSEDES decision 2's "students
  private by default, every other profile public, each user may change it" and removes the setting
  from WP-F1.
- **Q2 - A member's repost of an ENTITY post DOES widen its audience** to the reposter's followers
  (user: "Oui, jusqu'aux abonnes du membre"). The repost still needs no consent from the entity,
  never covers an anonymous post, and obeys blocks both ways and the hide cascade. WP-F6 and WP-F5
  must treat it as a disclosure change: Opus security review, and the repost's reach is the
  reposter's ACCEPTED followers only.
- **Q3 - Minors: moot.** With one rule for every person, no age-based or profile-based distinction
  exists to confirm; none is stored or added.
- **Q4 - A private account stays findable** by name in search and suggestions and can be asked; its
  posts reach only accepted followers (plus the space rule, per Q1).

#### Confirmed by scenario with the user (2026-10-25) and three ideas that came with it

Checked with four cases: a student asks a student, a staff member asks a student (same rule, no
exception by profile), two people sharing a space still see each other's posts in the space feed
without following, and a member's repost (author consent given) reaches the reposter's followers
even when they do not follow the author. **New, from the same answers:** (a) the "Tout" tab renamed "Mon espace" and (b) the information
button explaining each tab are BUILT (#2857); (b) now MOVES into guided help as a hint on the tab
bar, and (c) a broader tutorial on the first open after an update is decided as the "what's new"
help, both in [guided-help](frontend/guided-help.md#owner-decisions-of-2026-11-03).

#### The work packages, in order: one small pull request each, its starting point and its proof

Planned 2026-10-27 against `main` at `a97e1cea5`. **Releases, not merges, are the unit that
matters here:** WP-F1 to WP-F4 and WP-F7 reach users in ONE stable - F1 alone would turn every new
follow into a request nobody can answer - and that stable carries a data migration, so it ships on
the user's go. WP-F5 and WP-F6 each follow in a LATER stable. **The two packages marked DISCLOSURE
(F5, F6) get an adversarial Opus security review before the lead arms them**; the others get the
ordinary review.

- **WP-F1 - the data model, the migration, and every reader counting accepted rows only. BUILT,
  draft pull request #2589.** Migration 114 adds `user_follows.status` (`pending` / `accepted`, a
  CHECK) with every existing row `accepted` (decision 3), then sets the default to `pending` so a
  writer that forgets the column fails closed; a partial index on what is pending FOR a person
  serves F2's inbox. `POST /api/posts/users/:id/follow` now writes a `pending` request and answers
  `{ ok, status }`; `DELETE` unfollows or withdraws; `GET .../follow-status` answers
  `{ following, status }` (`following` kept true for a request, for older clients -
  [legacy-compatibility](legacy-compatibility.md)). NO setting (Q1). Old WP-F2 is folded in, because
  a pending row read as a follow would be a leak the day F1 merges: the Suivis arm
  (`getFollowedUserIdsForUser`), the announce sweep (`announceRecipientsSql(true)`), the personal
  republication's newly-reached rule and the live push (`liveAudienceSql`) all AND ONE fragment,
  `acceptedFollowSql` (`follows/follow-status.ts`); the erasure and the block severing delete
  whatever the status. Proof: `user-follow-status.integration.spec.ts` (existing rows accepted,
  replay a no-op, a status-less insert pending, the CHECK), a pending follower in the reader-spaces,
  personal-republication and lives PostgreSQL specs - all three fail when the fragment is `TRUE` -
  and `follows.service.spec.ts` (a follow lands pending, a re-ask never downgrades an accepted one).
  Details: [social-service](services/social-service.md#a-follow-of-a-person-is-a-request-first-wp-f1-migration-114-decided-2026-10-25).
- **WP-F2 - the request API: inbox, accept, refuse, and the one notification. BUILT, draft pull
  request #2601, stacked on #2589.** Start:
  `follows/follows.service.ts`, `posts/posts.controller.ts` (the follow routes), the D38b request
  queue in `posts/personal-republications.service.ts` for the shape. `GET` the pending requests FOR
  the caller (the partial index of 114), `POST .../accept` (pending -> accepted, under a row lock so
  a concurrent withdraw cannot be accepted), `POST .../refuse` (the row is deleted; a refusal tells
  nobody and does not stop a later ask). A new request notifies ONE person through the existing
  `PostNotificationsService` (a `follow_request` type: a bell row and a push, `contentKey` for the
  native renderers, NOT in `MUTABLE_PUSH_TYPES`); an acceptance notifies the requester
  (`follow_accepted`) - each at most ONCE per pair, from a `user_follow_notices` row (never a
  clock), and the ask route is throttled per caller. An ask of an id that is not a person is 404
  `FOLLOW_TARGET_NOT_FOUND`, an ask across a block 403 `FOLLOW_BLOCKED`, both decided inside the one
  `INSERT ... SELECT`. The block severing deletes both directions whatever the status, and the
  request bell rows with them: a spec pins it.
  Proof: unit specs for each transition, a PostgreSQL spec for accept-vs-withdraw, the
  `post-notifications` spec for the two types, and the block case.
- **WP-F3 - the followers list and "remove follower". BUILT, draft pull request #2605, stacked
  on #2601.** `GET` my ACCEPTED followers (a person sees
  only their own list), `DELETE` one of them (the row goes, the removed person is told nothing and
  may ask again), and `GET` my own outgoing requests so a request can be withdrawn from a list.
  Start: `FollowsService`, the controller. Proof: a spec that a removed follower drops out of the
  Suivis arm, the announce and the live push at once (the F1 readers), and that one person cannot
  read another's list.
- **WP-F4 - the client screens, every string through Paraglide (`messages/fr.json` and `en.json`).
  BUILT, draft pull request #2616 (stacked on #2605).** As built: the inbox is
  `/notifications/follow-requests` (banner on `/notifications`, host `follow-requests`); "Mes
  abonnes" is the profile section `followers`, with the sent requests under it; the push renderers
  were F2's; a `follows` notification category with its switch; the rig row is FOL-REQ-1 on
  [cross-client-testing](cross-client-testing.md). The plan as written:
  The profile button in three states (Suivre / Demande envoyee / Abonne(e)), reading `status`; the
  request inbox beside the D38b requests in the notifications screen (accept / refuse); "Mes
  abonnes" with "Retirer" in the profile; the bell rows of `follow_request` / `follow_accepted`
  and their push renderers (Kotlin, Swift, web). Start:
  `frontend/src/routes/profile/[id]/+page.svelte:175`, `frontend/src/lib/posts/api.ts:669`.
  Proof: component tests, `bun run check`, and a rig row (two contexts: ask, see "Demande envoyee",
  accept, see the posts in Suivis; remove, stop seeing). Retires nothing yet: `following` stays
  until the floor passes this stable.
  **Left open by the 2026-10-27 review, each owed before the item it names:**
  - **Pagination of the three lists, a PRECONDITION OF WP-F5 - BUILT 2026-10-31 on the WP-F5 pull
    request**: cursor paging, server and client ([as built](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31)).
  - **P3 - an older build that saves its switches turns `follows` back on.** The client keeps only
    the categories it knows when it reads the disabled set (`fetchNotificationPreferences` filters
    through `isNotificationCategory`) and the PUT REPLACES the set, so a build older than WP-F4
    that saves any switch silently re-enables `follows` - and the same holds for every category
    added after a build shipped. The server cannot tell what the caller knew: the fix is a client
    that sends the categories it knows (`known`) so the server keeps the rest, and it protects only
    builds that send it - the floor (`minClientVersion`) closes the rest. Measured: not yet; the
    window is a person who turned `follows` off on a new build and then saves a switch on an old one.
  - **Should `minClientVersion` move with this stable?** A build older than WP-F4 reads
    `following: true` for a PENDING request (the legacy field, [legacy-compatibility](legacy-compatibility.md)),
    so it shows "Suivi" for an ask nobody has answered, and it has no inbox to answer one. Nothing
    leaks - the reader filters are server-side - but the person asked can only answer from a new
    build. A decision for the user when the stable is cut, with the share of old clients measured
    from the version header then.
  - **A row the block severing missed came back when the block was lifted - FIXED 2026-10-31 on
    the WP-F5 pull request (F2 of its review)**: the unblock severs the pair before lifting the
    block and is refused while it cannot ([as built](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31)).
  - **Owner decision - a re-ask after a refusal rewrites the target's unread bell row** (no push,
    one row per pair, but no cap on how often it is rewritten). Product decision 3; left as built.
- **WP-F5 - the visibility opening to ACCEPTED followers (DISCLOSURE: Opus security review before
  arming). MERGED as #2827, ships in `1.5.4`** (owner reconfirmed 2026-10-31):
  [as built](#wp-f5---accepted-followers-read-across-spaces-as-built-2026-10-31),
  the policy paragraph and register C5/C19 in the same pull request. The one-time notice is
  WAIVED (owner, 2026-10-31: *"Non, ouvrir directement"*); the three follow lists now page by
  cursor; the security review's F2-F6 are fixed on the same pull request; F1 is DECIDED (owner,
  2026-11-01: *"Ouvrir à tous les abonnés"*): follows made before follow requests existed open
  across spaces like answered ones. **Still owed before it arms**: the review's re-read. The plan as written: Add an accepted-follower disjunct to the personal branch of `postVisibleToUserSql`
  (`spaces/reader-spaces.ts`), reusing `acceptedFollowSql`; NEVER for an anonymous post (following
  someone must not unmask what they posted anonymously), never through a read grant, and monotone
  for the newly-reached computation; the Tout feed stays filtered by spaces for everyone else
  (decision 5). Ships only in a stable AFTER the one carrying F3 and F4, with a one-time notice to
  every person that their followers will see their posts across spaces, so the grandfathered
  followers can be pruned first. Proof: an integration matrix (accepted / pending / none x same
  space / other space x personal / anonymous / association post), the read-grants spec unchanged,
  and the privacy-policy paragraph in the same pull request.
- **WP-F6 - member reposts with the author's consent, reels included (DISCLOSURE: Opus security
  review before arming). IN PRODUCTION since `v1.6.1` (#2859, migration 121), hardened by #2917 (migration 123); since #2920 the posts of lists and members-only associations are not repostable**
  ([as built](#wp-f6---member-reposts-with-the-authors-consent-as-built-2026-11-01));
  it changed who sees what, and shipped on the owner's go. The plan as
  written: The consent setting (per author, per post); the SQL beside the
  republication kinds (`posts/republication-sql.ts`, entity-only today); the consent check modelled
  on `posts/personal-republications.service.ts`; an ENTITY post reposted without consent but
  reaching the reposter's ACCEPTED followers only (Q2); never an anonymous post; blocks both ways;
  the cascades (hide, delete, block, erasure); feed placement in Suivis at the repost time; the
  D38 newly-reached notification; the share action in `frontend/src/lib/posts/sharePost.ts`.
  Proof: the D38b refusal list re-run for a member reposter, a hide removing every repost, a
  notification only for the newly reached, and the policy paragraph in the same pull request.
- **WP-F7 - the register and the privacy policy for follow requests. DONE 2026-11-02.** The text
  rode with the code: register C5 and the `/legal/privacy` paragraphs (follows, member reposts,
  retention table) arrived in the F5 and F6 pull requests, and this package re-read them against
  the code (the `FOLLOW_ASKS_PER_DAY` cap of 50, the notice row kept until an erasure, the refusal
  and withdrawal deletes, the F6 consent default ON, the erasure deletes of `member_reposts` and
  `user_repost_settings`) and found them exact; #2917 and #2920 had already amended C5 and the
  privacy page in step ("notified, or announced to, through a repost"; lists and members-only
  associations not repostable), so this package changes neither. The terms (`/legal/cgu`) name followers only for
  lives and need nothing; the D37-D41 table of
  [profiles-and-access](#d37-d41---what-each-surface-shows) was the one stale
  line, now corrected.

#### Risks, and what proves each away

- **Disclosure.** WP-F5 widens who reads a personal post. Grandfathered follows were never
  consented to, so the predicate change must not land before the followers list and "remove
  follower" are live, and each user should be told once that followers now see their posts across
  spaces. Proof: WP-F5's matrix, and the Opus review.
- **Notification volume.** A follow request is one push to one person; a repost notifies only the
  newly reached, under the D38 lock, so a repost of a widely seen post notifies almost nobody.
  Proof: the newly-reached spec counting zero for readers who already saw the post.

### WP-F5 - accepted followers read across spaces, as built (2026-10-31)

Decisions 4 and 5 of the [follow requests](#follow-requests-member-reposts-and-visibility-between-spaces---the-decisions-of-2026-10-25-all-shipped)
(user, 2026-10-25, reconfirmed 2026-10-31): a PERSONAL post, and a personal LIVE, are visible to
the author's ACCEPTED followers whatever their space, campus or formation; the opening reaches
nobody else.

- **One disjunct, in the personal branch only**: `acceptedFollowerOfAuthorSql`
  (`spaces/reader-spaces.ts`) is ORed into the personal branch of `postVisibleToUserSql` and of
  `liveVisibleToUserSql`, never the association branch. It holds when an `accepted` `user_follows`
  row (`acceptedFollowSql`) links the reader to the author, NO block stands between them either
  way (checked here rather than trusted to the best-effort severing, so a left-over row cannot
  re-open anything), and both stand on the same side of the review cohort's boundary.
- **Never an anonymous post** (`NOT COALESCE(post.anonymous, false)`): a follower reading an
  anonymous post would learn who wrote it - the same reason the Suivis arm already excluded
  anonymous posts ("the leak is membership, not the name") and D38b never carries one. A live has no
  anonymous form.
- **Never a read grant**: the personal branch takes no `readGrants`, as before (WP7).
- **Tout stays SPACES (decision 5)**: `postVisibleToUserSql` takes `followers: false`
  (`FollowerOpts`), passed by the `all` and `custom` arms of `listPosts` only. **Never by the
  CanaReels viewer** (`feed=reels`, 2026-11-03): it is not a tab but the union of the three, so it
  asks the whole predicate - it used to read `feed=all`, and an accepted follower on another campus
  never saw the reels of the member they follow there
  ([reels](frontend/modules/reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16),
  point 3). Everything else - the
  Suivis arm, the Associations arm (where the FOLLOWER disjunct changes nothing: a personal post is
  there only through a republication the reader sees - but the arm DOES drop WP-F6's member-repost
  door, `memberReposts: false`, owner 2026-11-02: an association post a reader reaches only through
  a followed person's repost is in Suivis and never in Associations, as the privacy policy says;
  proven against PostgreSQL in `member-reposts.integration.spec.ts`), the search, a post by id, its comments, reactions and votes,
  the D38b request menu, the announcement (`announceRecipientsSql`) and the newly-reached rules -
  counts the follower.
- **Monotone in republications, unchanged**: the disjunct reads no republication, so
  `NEWLY_REACHED_BY_REPUBLICATION_SQL` still computes "after and not before"; an accepted follower
  already sees the post and is never newly reached. `newlyReachedByPersonalRepublicationSql`'s
  "never a follower before the first announce" term is now implied by it for every post D38b can
  carry, and kept as the statement that keeps the two notification paths apart.
- **Notifications follow from the predicate**: the announcement sweep already narrows a personal post
  to the author's accepted followers who SEE it, and the live push (`liveAudienceSql`) to followers
  who may watch it; both now reach the cross-space follower, and neither touches an anonymous post.
- **Revocation is the row**: unfollowing (`leave`), "Retirer" (`removeFollower`) or a block
  deletes or overrides the follow, and the next read no longer counts it; the first two also drop
  the feed cache, as a block already did, so no cached Suivis page outlives them.
- **A block's left-over follow cannot come back (F2 of the review)**: the block's severing is
  best-effort and harmless while the block stands (the predicate checks the block itself), so the
  durable record that a severing is owed is THE BLOCK ROW: `UserBlocksService.unblock`
  (core-service) severs the pair, both directions, BEFORE deleting it, and a severing that fails
  refuses the unblock with a 503 and leaves the block in place. Nothing can recreate a follow in
  between - an ask and an acceptance are both refused across a block inside their own statement.
  After an unblock the two people follow each other only through a new request.
- **The feed gate admits a follower (F3 of the review)**: `IN_FEED_AUDIENCE_SQL` also admits the
  holder of one accepted follow, so a staff member with a campus, no cursus and no
  membership is not pushed a post the gate then refuses (proved through `FeedAudienceGuard`).
- **Grandfathered follows open like any other (F1 of the review, owner 2026-11-01: "Ouvrir à tous
  les abonnés")**: migration 114 recorded every pre-request follow as accepted with
  `acceptedAt = createdAt`, though nobody answered it. The owner decided they open across spaces
  exactly like an answered follow, so no predicate tells them apart (a switch prepared for the
  other answer was deleted unflipped). The privacy policy says so, and each person may prune their
  followers list; `follower-visibility.integration.spec.ts` proves such a follow opens a post and
  a live.
- **No one-time notice (owner, 2026-10-31: "Non, ouvrir directement")**: the backlog planned a
  notice to every person before the opening, so the grandfathered followers could be pruned first;
  the owner waived it. The opening ships as is; the followers list pages to its end (below).
- **The D38b request menu counts the follower, deliberately (2026-10-31)**: a cross-space follower
  who may post as an association that can ask sees the "ask to carry" entry on a post they read as a
  follower, and may ASK. Nothing widens before the AUTHOR consents, exactly as for a reader of the
  same space.
- **The three follow lists page by cursor (a precondition of the opening)**: the inbox, the
  followers and the sent requests answer at most `FOLLOW_PAGE_MAX` (100) rows a page, newest first,
  ordered `(instant DESC, id DESC)`; each entry carries an opaque `cursor` (`follows/follow-cursor.ts`:
  PostgreSQL's own text of the instant plus the row id - never a JS `Date`, which drops the
  microseconds) and `?after=<cursor>` starts the next page right after it, so a row answered or
  removed while the list is read shifts nothing. `offset` is gone (older clients only ever sent 0).
  The client appends pages behind a "Voir plus" button (`nextFollowCursor`, `appendFollowPage`);
  a list of 250 is proved reachable whole, server and client.
- **Proof**: `spaces/follower-visibility.integration.spec.ts` (real PostgreSQL: accepted / pending /
  none x same space / other space x personal / anonymous / association post, the live, the
  announcement and the live push, a block either way with the row left behind, a removal, an
  unfollow, a read grant, Tout against the default for every non-follower, monotone newly-reached);
  `lives.integration.spec.ts` (an accepted cross-space follower is pushed, listed and let in until a
  block or a removal; a pending one is not); `posts.service.visibility.spec.ts` (which feed arms
  carry the follower disjunct); `review-cohort.integration.spec.ts` (a follow across the cohort
  boundary opens nothing, either way); `follow-requests.integration.spec.ts` (250 rows per list,
  a removal between two pages, a forged cursor, the unfollow's cache drop);
  `core-service/src/users/user-blocks.service.spec.ts` (sever before lifting, 503 keeps the block). `reader-spaces` and `personal-republications` PostgreSQL specs were
  re-pointed where the opening changes who sees or is newly reached.

### WP-F6 - member reposts with the author's consent, as built (2026-11-01)

Decision 1 and Q2 of the [follow requests](#follow-requests-member-reposts-and-visibility-between-spaces---the-decisions-of-2026-10-25-all-shipped)
(user, 2026-10-25); the consent's shape is the owner's of 2026-11-01: a PER-AUTHOR setting
"Autoriser mes abonnés à republier mes posts", ON by default, plus a per-post override. A PERSON
republishes a post, reels included, to THEIR OWN accepted followers. A disclosure change: Opus
security review before arming.

- **Migration 121, additive**: `member_reposts (postId, reposterId, repostedAt)`, keyed by the pair,
  the post's foreign key `ON DELETE CASCADE`; `user_repost_settings (userId, allowReposts)` - NO
  ROW IS THE DEFAULT, ON, so nothing is backfilled; `posts."allowReposts"` (NULL follows the
  setting). **Migration 123, additive** (hardening, 2026-11-02): `member_repost_notices (postId,
  recipientId)`, the told ledger below, backfilled from the `member_repost` bell rows.
- **One disjunct, both branches**: `memberRepostReachesUserSql` (`spaces/reader-spaces.ts`) is ORed
  into the personal AND the association branch of `postVisibleToUserSql` (Q2: a repost of an entity
  post widens it to the reposter's followers). It holds when an ACCEPTED `user_follows` row links
  the reader to a reposter, the post is not anonymous, reader, reposter and author stand on the
  same side of the review cohort, and no block stands between reader and reposter - nor, for a
  PERSONAL post, between reader and author or reposter and author. The author pairs are left out
  for an entity post on purpose: its `authorId` is the officer who wrote it, and a feed that
  changed when a reader blocked that person would name them (the oracle `blockedAuthorSql`
  documents). Blocks are CHECKED, never trusted to the severing. Left out with `followers: false`:
  Tout and the promo browse stay feeds of spaces (decision 5). **Left out of the Associations feed
  too (`memberReposts: false`, 2026-11-02)**: that feed lists what associations publish and
  republish, and a repost's reach shows in Suivis only - an entity post a reader sees only through a
  followed person's repost is not in it. Never a read grant. Monotone in reposts.
- **A repost never outlives what its reposter holds (Opus review, 2026-11-01)**: the row alone
  carries nothing. `memberRepostCarriesSql` also asks that the reposter STILL sees the post
  FIRST-HAND (`postVisibleToUserSql` with `memberReposts: false, readGrants: false` - it never
  recurses) and is not muted (`user_moderation.isMuted`, the only account restriction
  social-service holds, the one D38b's `senderSpeaksSql` reads). An author who removes the
  follower, a reposter who unfollows or leaves a members-only association, a muted reposter: the
  row stays and reaches nobody until the access comes back. The SAME helper filters the card's
  "Republié par" names and the Suivis arm (`followedRepostLateralSql`, `republishedFeedAtSql`), so a
  stale row neither names, surfaces nor dates a post.
- **An association is never the second step**: every D38/D38b path asks the predicate with
  `memberReposts: false` - the republication's `assertVisibleTo`, the request's
  `assertVisibleWithoutGrant` and `describe`, and the offers (`PostsService.firstHandIds`, a
  column of the one `grantFreeVisibleIds` query; the requestable query). A vote keeps the
  grant-free set: a repost opens every reader-side act a follow opens.
- **The bell**: a `member_repost` row is shown only while its recipient still sees the post
  (`bellRowShownSql`, `getNotifications`): its text preview must not outlive the access, and the
  access ends on paths (an unfollow, a removal, a membership) no repost write can hook. The row is
  left to the 90-day sweep.
- **Consent is state, not a predicate term**: `repostConsentSql` (an entity post always; a personal
  one by its override, else the setting, else ON) is read by the write under the author's advisory
  lock (`member-repost:author:<id>`), then the post row; turning the setting off, or an override
  that leaves a post without consent, deletes the rows it no longer covers under the SAME lock in
  the same transaction. No repost outlives a "no", and none can read "yes" while a "no" commits.
- **NO CHAIN (decided 2026-11-01 by the lead, holding the owner's autonomy)**: only a reader who
  sees the post FIRST-HAND may repost it - through its own audience (a shared space, the author's
  accepted followers, an association that carries it, membership or the rules of its entity). A
  reader who sees it ONLY through another member's repost may not: the author's consent covers one
  step of reach, not an unbounded chain. The write and the card ask the predicate with
  `memberReposts: false` (`FIRST_HAND`, `member-reposts.service.ts`).
- **NEVER THE POST OF A MEMBERS-ONLY ENTITY OR OF AN UNLISTED TYPE (owner, 2026-11-02)**: an entity
  post is repostable only when its association's type is ALLOWED - `MEMBER_REPOSTABLE_ASSOCIATION_TYPES`,
  an allowlist, so a type added later stays refused until listed; a LIST was refused here in the
  morning and admitted the same day ("Oui partout sans exception", [amended](#d38b-amended---every-kind-may-ask-and-an-institutions-request-shows-its-audience-owner-2026-11-02)),
  so every kind of today is on it - and addresses at
  least one space (an `association_audiences` row); an association with no rule is read by its
  members only, and a member's repost would carry its post past that circle. One clause,
  `memberRepostablePostSql` (`spaces/reader-spaces.ts`), read by the write (the 404 of a post not
  seen, nothing confirmed, and again inside its newly-reached set), by the card's `repostable` offer, and inside `memberRepostCarriesSql` -
  so a repost written before the decision, or before its association lost its last rule, reaches,
  names and dates nothing, with no row deleted; read from state, so an association that gains a rule
  makes its posts repostable again. Production held 0 member reposts at the decision (0 of a list,
  0 of a members-only association; 44 lists, 0 members-only associations among 94), so nothing was
  left to clean.
- **Refusals, in order, each a typed `MEMBER_REPOST_*` code and an integration case**: absent,
  hidden, scheduled or expired (404); not seen FIRST-HAND without a grant and without the admin's
  by-id reach (404, nothing confirmed - a reader who sees it only through a repost included); anonymous (400); the reposter's own personal post (400); a block either
  way with a personal post's author (**the SAME 404 as a post not seen, body included**, since
  2026-11-02: a refusal no longer distinguishes a block); no
  consent (403); already reposted (409, the key). A muted account is refused at the route. An entity post the reposter wrote is NOT refused as "own":
  the refusal would tell them whose it is.
- **Who is told (the D38 rule)**: `NEWLY_REACHED_BY_MEMBER_REPOST_SQL`, asked under the post row's
  lock BEFORE the row exists - the reposter's accepted followers who cannot see the post now, minus
  the blocks and the cohort above. A PERSONAL post is told at the repost, announced or not (its
  announcement goes to the author's followers only); an ENTITY post not yet announced is told
  nothing - the sweep tells everyone who sees it by then. Type `member_repost`, push
  `social_member_repost` (Kotlin, the NSE and `canari_push.mm`, fr and en), category `posts`.
  **ONCE PER (post, reader), EVER (2026-11-02)**: the newly-reached set is read from visibility,
  which an "Annuler" undoes, so it alone cannot say who was already told. The repost's transaction
  inserts the pairs into
  `member_repost_notices` (`ON CONFLICT DO NOTHING RETURNING`) and tells only the pairs it wrote -
  whoever reposts the post, however often. At most once: a pair is recorded even if the push after
  the commit fails (that loss is logged). The repost's answer is `{ postId }` and carries no count
  of who was reached. **The announcement writes its share (2026-11-02, review of #2917)**: an
  entity post not yet announced is told nothing at the repost, and the sweep tells everyone who
  sees it - so in its stamp transaction the sweep records in the same ledger the readers it reaches
  ONLY through a member repost (`ANNOUNCE_ENTITY_RECIPIENTS_RECORDING_REPOSTS_SQL`,
  `post-announce.scheduler.ts`). Without it, a take-back then a repost found them newly reached and
  told them a second time, `member_repost` after `association_post`. **The recipients and the
  ledger rows are ONE statement** (a CTE whose INSERT selects from the recipients): as two READ
  COMMITTED statements, an `unrepost` - which takes no lock - committing between them left a reader
  told but unrecorded. Only an entity post asks it: a personal post's followers see it first-hand.
  A reader who sees the post first-hand is not recorded, so one who LOSES that access later and is
  reached by a repost is told then - a new reach, not the same one twice. **The write's
  newly-reached set repeats the repost rule** (`memberRepostablePostSql`), so an officer removing
  an association's last audience rule after the write's check cannot get a `member_repost` pushed
  for a post its rows no longer carry. Migration 123 holds a SHARE ROW EXCLUSIVE lock on
  `posts` until its COMMIT, backfill included: writes to `posts` (reactions and comments live in the
  row) wait for it, reads do not - its comment says so since the same date.
- **Suivis at the repost's time**: the followed arm admits a post a followed person reposted and
  places it at the latest of its publication, its counted republications and its reposts by people
  the reader follows (`republishedFeedAtSql`). **One `LEFT JOIN LATERAL` per candidate
  (`followedRepostLateralSql`, 2026-11-02)** computes that latest carrying repost, never for an
  anonymous post; admission (`MEMBER_REPOSTED_BY_FOLLOWED_SQL`) and placement (`FOLLOWED_REPOST_AT`)
  read its column. It replaced two subqueries that each ran `memberRepostCarriesSql` on every
  followed repost of every candidate; the third evaluation, inside the visibility predicate, stays -
  it is the read gate. Measured on a SYNTHETIC seed (3 000 users, 30 000 posts, 3 000 reposts, a
  reader following 60; not the dev estate): the query without its visibility clause went from about
  5.4 s to 3.8 s (median of 5), and the whole query stays dominated by the per-candidate visibility
  predicate, which this change does not touch.
- **The feed cache (2026-11-02)**: a repost write used to sweep EVERY reader's cached pages. It now
  drops the pages of the people concerned - the reposter, or the author of a consent change, plus
  the reposters whose rows the change deleted - and of each one's ACCEPTED followers, nobody else's
  (`invalidatePostListCacheFor`, one SCAN that deletes only the selected viewers' keys; the key's
  builder and reader are side by side in `post-list-cache.ts`). What stays stale for up to the
  page's TTL is the `canRepost` offer of a reader who sees an author's post through a shared space
  after that author's consent changed - a hint the write re-checks under the consent lock, as
  before (the old sweep ran only when rows were removed).
- **Removal**: a hide (`dropRepublicationsOf` -> `dropMemberRepostsOf`, both moderation paths); a
  delete (the foreign key, which takes `member_repost_notices` too); the reposter's erasure
  (`member_reposts`, `user_repost_settings`), a reader's (`member_repost_notices`) and
  the author's (their personal posts are deleted, the key cascades); a block
  (`severFollowsBetween` -> `severMemberRepostsBetween`, personal posts only; core-service's unblock
  severs again before it lifts); a withdrawn consent; the reposter's own "Annuler"; the AUTHOR's
  "Retirer" on one reposter (below).
- **The author sees who reposted, and removes ONE repost (owner, 2026-11-02)**. On their own
  personal, non-anonymous post the author's card carries `repostCount`, and the post menu draws
  "Republié par N personnes" above zero; it opens `PostRepostersSheet` (the follow lists' rows and
  paging), each row with "Retirer". **Who is listed** is `repostShownToAuthorSql`
  (`member-reposts.service.ts`): `memberRepostCarriesSql` asked with the AUTHOR as the reader - the
  reposter on the author's side of the review cohort, no block either way between them, not muted,
  still seeing the post first-hand. The author learns who reposted (the owner accepted that
  disclosure), but never someone the app otherwise keeps out of their sight, and a stale row that
  reaches nobody is neither listed nor counted. The list, the count and the removal read the SAME
  fragment. **The removal** is a plain delete of one `member_reposts` row under the consent lock
  then the post row (`member-repost:author:<id>`, then `FOR UPDATE`, the order `repost` and
  `setPostConsent` take); a repost the list does not show - gone, or by someone a block or the
  cohort hides - is ONE typed 404 `MEMBER_REPOST_NOT_LISTED`, so the removal probes nothing the list
  does not show. **The removed reposter is NOT told** (no bell, no push): their card stops offering
  "Annuler ma republication", as after a withdrawn consent, and they may repost again while the
  author consents - no per-person refusal was asked; an author who wants no reposts at all withdraws
  consent on the post. `member_repost_notices` is left as every removal leaves it: a reader told
  once is never told again, whoever reposts later. Anyone but the author of a personal,
  non-anonymous post gets the uncoded 404 of a post not seen, on both routes; an entity post has no
  list (its `authorId` is the officer). Feed pages dropped: the author's, the removed reposter's,
  and each one's accepted followers'. A reposter's own repost and take-back drop the AUTHOR's pages
  too (a personal post only, `dropAuthorCountOf`; `unrepost` reads the author in its `DELETE ...
  RETURNING`): without it the author's cached `repostCount` contradicted the list for up to a
  page's TTL. The sheet removes several rows at once and puts back only the row whose removal was
  refused, at its place (never a snapshot of the list). The DELETE route refuses a `reposterId` no
  user could hold with a 400 `REPOSTER_ID_INVALID` before any query (`PERSON_KEY.accepts`: 1..255
  characters, no control character - wider than today's mint rule on purpose, so an id minted
  before it can still be listed, paged and removed; the cursor's length cap is computed from that
  worst case, 4 UTF-8 bytes a character).
- **"Republié par vous" (owner, 2026-11-02)**: the reader who reposted a post reads "vous" FIRST on
  its "Republié par" line - "Republié par vous", "vous et Marie", "vous, Marie et 2 autres"
  (`republishedByText`, `republication.ts`, post header and reel overlay). It reads the card's own
  `repostedByMe`, which only that reader's card carries: no query was added, and nobody else is
  shown it. **`repostedByMe` is the UNFILTERED `mine` set** (`member-repost-card.ts`: a row by the
  reader exists, whatever `memberRepostCarriesSql` says of it), unlike the names in `repostedBy`.
  So a reader whose repost carries nothing now - muted, blocked, no longer seeing the post
  first-hand - still reads "Republié par vous", and that is kept on purpose: it is what keeps
  "Annuler ma republication" offered, the reader's one way to delete a row they wrote.
- **The card**: `canRepost`, `repostedByMe`, `repostedBy` (the people the READER follows who
  reposted it - a stranger is not told who reposted) and, on the reader's own personal post only,
  `repostConsent { override, effective }` and `repostCount`; an entity-loaded post no longer spreads
  `allowReposts`. Two queries a page (`member-repost-card.ts`), restating the write's refusals.
- **Routes**: `POST|DELETE /api/posts/:id/reposts`, `GET|PUT /api/posts/me/repost-settings`,
  `PUT /api/posts/:id/repost-consent {allowReposts: boolean | null}` (the author of a personal
  post; 404 to anyone else); `GET /api/posts/:id/reposts?limit&after` (the author's list, keyset
  on `(repostedAt, reposterId)`, the follow lists' cursor with a person's id as its key,
  `follow-cursor.ts` `PERSON_KEY`) and `DELETE /api/posts/:id/reposts/:reposterId` (the author's
  removal), both 404 to anyone else. **Every one is throttled per caller (2026-11-02)**,
  `UserResourceThrottlerGuard` (the routes name `:postId`, which it does not read, so the bucket is
  the caller alone across every post): 20 reposts, take-backs or author removals a minute, 10
  consent changes, 60 reads of the setting or of the reposter list (`member-reposts.controller.ts`, asserted by its throttle spec). **Counted
  PER REPLICA**: `ThrottlerModule.forRoot` names no storage, so the counts are one process's
  memory - N replicas allow up to N times each limit, and a restart forgets them. It bounds a loop,
  it is not a quota; the told-once ledger, not the throttle, is what keeps a reader from a second
  notice.
- **The client**: the "Republier pour mes abonnés" / "Annuler ma republication" row, in the share sheet
  AND (owner, 2026-11-02) in the post's "..." menu, just above the association republications, both
  through `toggleMyRepost` (posts and reels, `sharePost.ts`); the post menu's "Autoriser / Interdire les republications de
  ce post" for its author; the switch in Settings > Préférences (`RepostConsentSetting`); the
  "Republié par" line names reposters after associations, "vous" first for the reader who
  reposted; the author's "Republié par N personnes" menu row and its sheet; the bell row
  `member_repost`.
  **Read on the Mi 9T, `1.6.3-alpha.2`, 2026-11-02 (before WP-F6's sheet, which that build does not
  carry):** on an association's post the menu lists Partager, "Republier pour mes abonnés", Signaler
  ce post, each icon 16x16 (measured on the drawn `svg`); a tap posts the repost (`201 POST
  /api/posts/<id>/reposts`, toast "Republié pour vos abonnés"), the menu then reads "Annuler ma
  republication", whose tap takes it back (`200 DELETE`) and the label returns. On the member's own
  post the row is absent and the author's "Interdire les republications de ce post" shows, its icon
  16x16 too. PASS; the iPhone not read.
- **Not built**: a live is never reposted (accepted); an officer may repost their own association's post (accepted: refusing
  it would name them).
- **Proof**: `posts/member-reposts.integration.spec.ts` (PostgreSQL, 121 applied twice): the D38b
  refusal list re-run for a member reposter, no chain (a reader reached only by a repost is refused
  and offered nothing), accepted vs pending vs none, Tout untouched, a block
  either way and a left-over row, the newly reached only (announced or not, personal or entity),
  hide, delete and severing, the setting OFF and the override both ways, the card against the
  write; a repost that outlives its reposter's access (removed follower, unfollow, members-only
  association left, muted) reaches nobody, names nobody and leaves no bell preview. Since
  2026-11-02 also: a block's refusal is byte-for-byte the 404 of a post not seen; repost, take back
  and repost three times tells the newly reached once; migration 123's backfill (and its replay)
  keeps a reader told before it from being told again; a repost and a consent change drop exactly
  the expected readers' cached pages; the Suivis lateral admits and dates a carried repost and
  neither for a blocked reader or a muted reposter. `member-reposts.controller.throttle.spec.ts`,
  `post-list-cache.spec.ts` and `posts.service.republished-feed.spec.ts` hold the rest. The
  author's list and removal (same spec, "THE AUTHOR SEES WHO REPOSTED"): newest first minus a block
  left behind either way (the reposter's, and the AUTHOR's), a muted reposter, one who lost
  first-hand access and a review-cohort reposter - each also uncounted and unremovable (the typed
  404, the row kept) - the card's count equal to the list, paging by cursor
  and a forged cursor refused, the uncoded 404 to a reposter, a follower, an entity post's officer,
  an anonymous post and a missing one; one removal leaves the other reposts and the reach they give,
  tells nobody, keeps the notice ledger, drops exactly the expected pages and leaves the reposter
  free to repost; a hidden or absent repost is the typed 404 with its row kept. Client:
  `republication.test.ts` ("vous" alone, "vous et X", "vous, X et N autres") and
  `PostRepostersSheet.svelte.test.ts`.
  `republications.integration.spec.ts` and `personal-republications.integration.spec.ts`: an
  officer who sees a post only through a repost cannot republish or ask, and is offered nothing.
  The six PostgreSQL specs that share the predicate apply 121. The post of a list or of a
  members-only association (2026-11-02): the write's 404 is byte-for-byte a not-seen one, the card
  offers nothing, and a row written before carries nothing until the association gains a rule
  (`member-reposts.integration.spec.ts`; the clause itself in `spaces/member-repostable.spec.ts`).

### The review cohort - store reviewers in a world of their own (2026-10-31)

**The owner's requirement (2026-10-31):** the Google Play and App Store reviewers sign in with accounts
the team gives them, and they must see no real person's data while no member ever sees what they do.
Until then ONE review account was hidden from search, the directory and the feed, but it carried a
real student profile, so it READ that space's posts and lives, and a live it started reached that
space; a second account (a counterpart to call and to watch) had no rule at all.

**The rule:** the review accounts are a COHORT that is a space of its own, and **nothing crosses its
boundary in either direction** - "Tout fermer" (owner, 2026-10-31). A review account finds, reads,
follows, messages, calls, mentions and buys only within the cohort; a member never does any of these
with a review account. It holds **whatever profile the identity provider hands the account**, so
nobody has to keep a reviewer's profile empty. Every refusal of an ACT is the same typed 403,
`REVIEW_COHORT_BOUNDARY`, worded neutrally like a block's: it never says the other account is a
review account. A READ across the boundary returns nothing, as for anything outside one's spaces.

| Surface | Rule | Where |
| --- | --- | --- |
| Search and the people directory | a review account finds the cohort only; nobody but a global admin finds a review account | `applyReviewCohortVisibility`, core `users.service.ts` |
| A profile (`GET /users/:id`, `POST /users/batch`) | refused across the boundary, both ways (a batch reads an id across it as unknown); a global admin opens every profile, a review account opens no admin's | `assertMayOpenProfile` / `profilesOpenTo`, core `users.service.ts` |
| What a profile shows (memberships, roles, follow status, Minesweeper standing) | empty across the boundary, both ways; memberships and roles need a session since 2026-11-02 ([anonymous-surface](anonymous-surface.md)) | `profileOpenAcrossCohort`, `follow-requests.controller.ts`, `minesweeper.service.ts` |
| A face and the shared-link preview (`GET /users/:id/avatar`, the SSR head of `/profile/<id>`) | a review account has none: the same 404 for everybody, never cached. Neither request carries the viewer (an `<img>`, the SSR process), so a review account opening `/profile/<member>` gets exactly what an anonymous visitor gets - since 2026-11-02 the generic head, never the member's name ([anonymous-surface](anonymous-surface.md)) | core `users.controller.ts`, `internal-users.controller.ts` |
| Spaces | a review account has NO real space | `isReaderSpaceSql`, its pure twin `readerSpaces`, `spaces/reader-spaces.ts` |
| Personal posts, member lives, their announcements and live pushes | two review accounts share the cohort space; a review account and a member never share one | `sharesSpaceWithAuthorSql` |
| The feed gate | a review account is in the audience (its cohort is a space) | `IN_FEED_AUDIENCE_SQL` |
| Feed and post search | a review account's posts are also filtered on the AUTHOR for every reader outside the cohort but an admin | `reviewCohortAuthorFilterSql`, `spaces/reader-spaces.ts` |
| Comments, reactions, mentions | no notice crosses (post author, parent author, mention), and a mention across is not sent at creation or at an edit | `post-interactions.service.ts`, `posts.service.ts` |
| Follow requests | an ask, and an acceptance of one written before the rule, refused both ways; a row written before the rule is left out of the inbox, the followers, the sent requests and the bell | `recordFollowRequest`, `follow-requests.service.ts`, `sameSideOfReviewCohortSql` |
| Communities | no invitation link or salon invitation seats one side among the other; a roster row across the community creator's side entitles no NEW seat in its key group - the question is asked of a pending seat only, so a device already active keeps its keys | `review-cohort-community.ts`, `channel.service.ts` |
| The shop, partnerships, an association's roster, its forms | a review account sees, buys, claims, submits and reads the roster of only the associations it is a member of - none real; nobody but an admin sees a review account on a roster, and the public roster never lists one; a personal form is not answered across | `review-cohort-reach.ts`, `products` / `partnerships` / `forms.service.ts`, `listMembers`, `listMembersPublic` |
| Association membership and read grants | an officer cannot add a review account to a roster holding a member, nor a member to the cohort's; a read grant never opens a real association to a review account | `assertRosterStaysOnOneSide`, `readGrantReachesAssociationSql` |
| The Minesweeper board | each side ranks among its own; a member never sees a review account on the board | `minesweeper.service.ts` |
| Conversations and calls | no Add, invitation link or admission puts the two sides in one conversation, and no call or ring crosses | chat-delivery `utils/review-cohort-groups.ts`, `enrolAdmittedPeople`, `calls.service.ts` |
| Booking spaces (the Reservations page, and a space reached by its link) | a review account lists and uses only spaces a review account created, and nobody else lists or uses those - a link reaches the space, never across; nobody books for, or names as a participant, someone across | `listedSpaces`, `assertSameSideAsSpace`, `bookings.service.ts` |

**AN ADMIN BROWSES LIKE ANY READER, AND THE COHORT IS NOT ONE OF THEIR SPACES.** The house rule holds:
browsing the feed, the "Live now" list or the agenda, a platform admin sees their own spaces and
nothing of the cohort. An admin reaches the cohort only by an id: a post opened by its id
(`adminSeesAll`), a profile, and **a review account's live opened by its id (`adminSeesCohort`,
`get` and `manifest` only)** - no admin ever shares the cohort's space, so without it a reported live
of the cohort could be judged by nobody. It opens the key and the manifest and nothing else: the
admin's chat lines and reactions on that live are refused (`mayWatch`).

**Rows written before the rule: two kinds close themselves, the rest is the operator's.** A follow
(pending or accepted) or a bell row across the boundary is left out of every list and the bell. A
community roster row across its creator's side stops a NEW join only: entitlement is asked of a
pending seat, never of an active one, so a device seated before the rule keeps its keys, and the row
still shows on the roster. **So every crossing row - a community seat, an association membership, a
booking - is removed by the operator BEFORE the secret changes, through the app (leave, remove,
cancel), never by a raw delete.** None is filtered out of the rosters or the booking lists, and
deliberately: counted on both estates on 2026-10-31 (read-only), there were none - no community,
association or booking crossing the boundary, no seat - and none can be written since, because every
writer of those rows is gated (a community row has three writers: creation, which seats its creator,
an invitation link and a salon invitation; a booking and its participants have one, `book`). A
filter for rows that cannot exist would be a second rule nobody exercises. The count is re-run before
each change of the list, and a crossing row it finds is removed, not hidden. What the operator also
does is the review account's OWN history - its conversation with a member is left the way the app
leaves one, never by a raw delete. An officer cannot make a review account a member of a real association (the add is
refused while the roster holds a member), so an association reaches a review account only when it is
the cohort's own.

**Where the cohort comes from:** `SERVICE_ACCOUNT_USER_ID` (dev `DEV_SERVICE_ACCOUNT_USER_ID`), a
comma-separated list of user ids, read by `review-cohort.ts` - one module, byte-identical in
core-service, social-service and chat-delivery-service (declared duplicate). An entry follows the
user-id grammar (`users/user-id.ts`: visible ASCII, no `:`) minus `,`, and is read lower-cased, as
every service compares a user id. **An entry outside
it stops each of the three services at boot** (`assertReviewCohortConfigured`): dropping it would
leave that account visible with no sign of it. The three are replaced `overlap`
([cicd](cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)), so a new replica that never
becomes healthy is removed, the previous one keeps serving and the deploy fails red. An id is never
written into SQL as text: bound as a parameter, or hex-encoded where a fragment has no parameter
slot. The ids, the accounts and their credentials are in the private operations notes, never here
([MIGRATION](../../infrastructure/MIGRATION.md)). Pinned by `review-cohort.spec.ts` and the cohort
block of `users.service.spec.ts` (core-service); `review-cohort.integration.spec.ts`,
`follow-requests.integration.spec.ts` and `bookings.service.integration.spec.ts` against PostgreSQL,
and the cohort cases of the products, partnerships, forms, roster, posts and comment specs
(social-service); `add-enrolment.integration.spec.ts`, `members.controller.blocks.spec.ts`,
`refusal-codes.spec.ts` and `calls.service.spec.ts` (chat-delivery-service).

**THE SECRET CHANGES IN THREE STEPS, IN THIS ORDER** (2026-10-31): (1) ship the release carrying
the cohort code with the CURRENT one-id value - the rule runs with a one-member cohort; (2) once the count of
crossing rows (below) reads zero for the full list, change the secret to the full list (and its `DEV_` twin); (3) redeploy that same release (a rerun of its deploy
is a redeploy). Never the list before the code: a value the running code reads differently is a
second change hidden in the first. **One window is accepted:** step 3 replaces the three services
one after another, so for a few seconds one may read the old list and another the new one - the
account being added is outside the cohort in one and inside it in the other, and that account is
fictional, holds no relationship and has posted nothing anybody can see.

**What it does not do:** it changes no account. The cohort's own content (a few fictional posts, a
conversation, a link-only booking space) is seeded by an operator BEFORE the deploy - with the
current code a review account shares no space with anyone, so what it posts is seen by nobody until
the cohort reaches it - and the review notes are on
[store-review-live-checklist](store-review-live-checklist.md).

### FEED_GATE - a 403 is a verdict, not a failure (2026-10-06)

Proven cause: `FeedAudienceGuard` answers a signed-in reader with no space and no association `403` (by design, tested in `feed-audience.guard.spec.ts`), and `routes/posts/+page.svelte` mapped EVERY rejected posts read to `posts_load_error_title`. The redirect to `/chat` only fires on a KNOWN `false` verdict, so an unknown or stale `true` verdict (revalidated behind the render, no redirect) landed on the error. Fix on the client, by status: `isFeedAudienceRefusal` / `isOutsideFeedAudience` (`lib/posts/feedAudience.ts`) classify a 403, correct the remembered verdict, and the page renders the `posts_no_audience_*` empty state; 401/5xx/transport keep the generic error and its retry. Test: `feedAudienceRefusal.test.ts`.

### The audiences chantier - the decisions (user, 2026-10-07; moved from the backlog 2026-10-08)

Seven decisions on the audience of associations, lists and institutions (the last was Master's recommendation, accepted): (1) the manager chooses among THREE presets, never the raw grid - my campus; my campus plus the formations I name; everyone (offered to institutions only; the global admin keeps the full grid in Espaces & audiences); (2) default at creation is the association's campus, every formation, applied automatically and editable, a list likewise; (3) an association present on two campuses is TWO associations, partners on a shared event (D39, migration 074), with no multi-campus audience on one entity; (4) a change of audience applies to everything, past posts included; (5) a manager with no campus completes their profile first; (6) only institutions, created by a global admin, may target everyone, and the SERVER refuses `everyone` elsewhere; (7) the star (space BDE) may set the audience of the associations of ITS campus only. As built: WP-A, WP-B and the star's read above.

### The nominative read grants - the decisions (user, 2026-10-07; moved from the backlog 2026-10-08)

WP7 of this plan (D24: grants only ADD, a global admin grants across spaces). Cases named: the director of the ME, the ME communication and the School's student liaison reading the posts of associations but not the personal posts of students; a director of formations reading the associations of Saint-Etienne and Gardanne. Decisions: (1) a grid of checkboxes per person shaped like `/admin/spaces` (campus x formation, and whole campus); (2) it covers the posts of associations, lists AND institutions of the ticked spaces - an institution of ANOTHER campus too - with comments, reactions, events and agenda; (3) NEVER the personal posts of students; (4) readers may react and comment; (5) a global admin grants, the grant ADDS and never removes; (6) staff without a cursus see nothing more by default, the named ones do (closes the staff-feed question); (7) no end date, the list of named readers is internal (global admins only), and a journal keeps who granted what to whom and when. The user's "ISTP" is FSSS. Named readers only READ and react, and get NO notifications for their perimeter (answers of 2026-10-07). As built: WP-C above.

**AMENDED BY THE OWNER ON 2026-11-04 - decisions (2) and (4), for comments.** Students' comments are their own expression, like their personal posts, which a grant never opens. So: (a) a named reader who sees an association, list or institution post ONLY through the grant does not see its comments; (b) it is a PER-READER switch "voit les commentaires" in the "Accès en lecture" sheet, OFF by default for new AND existing named readers, each change journalled like a grant; (c) with it OFF the reader may still REACT, but not comment nor like a comment - the comment button and count are not shown, and the API answers 404 as for an invisible resource; ON keeps the behaviour above (read and comment); (d) with it OFF, reactions and poll votes are TOTALS, never who; (e) only when the grant is the reader's ONLY door - visible with grants and not without them - so a reader who also reaches the post natively keeps everything; (f) no new notification may leak. And (owner, same day): "un truc clair et propre, le plus user-friendly possible" - the switch reads plainly in the existing sheet (a label and one line saying what the reader will and will not see), and on the reader's side no dead control, nothing hinting at a hidden discussion. As built: the "Comments and people of a grant-only post" bullet of WP-C above. **And (owner, same day) the chat of an association's live is the same rule**: a named reader who sees a live only through their grant sees the video but not its chat - no lines, no sending - unless the same switch is on; no second switch. As built: "The chat of a grant-only live", WP-C above.

### The students-only switch, as built (owner, 2026-11-04)

The owner's decisions (2026-11-04; an audience chosen per post was weighed and turned down as too
heavy, the association's audience stays the base): (1) one switch when publishing, "Entre
étudiants", OFF by default, no per-association default; (2) the rule is on WHO READS, never on how
the post travels - republication, member reposts and pins stay allowed; (3) a student is an
account with a cursus (a campus and a formation, so a space); (4) it complements the comments
withheld from named readers, who see nothing of such a post; (5) the author may change it after
publishing, both ways, at once; (6) the post and its event are independent; (7) associations and
lists only; (8) a republished post keeps its chip and its rule, with no block or warning. The
owner's requirement on the result: clear, clean and as user-friendly as possible - one switch, one
line saying who will and will not see the post, a chip on the card, no new screen.
The rule in one line: an association's or a list's post may be marked "Entre étudiants" when it is
published and changed afterwards both ways, and is then read only by STUDENTS and by the MEMBERS
OF THE ASSOCIATION THAT PUBLISHED IT, whatever the path. Staff without a cursus and named readers
see nothing of it. OFF by default, for every author.

- **Model** (migration `133_post_students_only.sql`, additive, not held): `posts."studentsOnly"`
  boolean NOT NULL DEFAULT false (a catalogue change, no rewrite), and `CHK_posts_students_only_entity`:
  a personal post never carries it. The entity's TYPE is the write's to refuse, since a CHECK
  cannot read `associations`.
- **ONE conjunct of the one predicate**: `studentsOnlyAdmitsUserSql` in `spaces/reader-spaces.ts`
  narrows EVERY door of `postVisibleToUserSql` but two - the post's author, and `adminSeesAll` with
  `adminModerates` (the moderation read, below). It
  admits a reader who is a student (`isStudentSql`: at least one SPACE, so a campus and a cursus
  formation that make a space; staff and a review account have none) or a member of the post's own
  association (`isMemberSql` on `posts."associationId"`, never a republisher's). Because it reads no
  republication and no repost, the predicate stays monotone in both, and the two newly-reached rules
  (`NEWLY_REACHED_BY_REPUBLICATION_SQL`, `NEWLY_REACHED_BY_MEMBER_REPOST_SQL`) restate it on their
  "after" side, so a carrier's staff member or a reposter's staff follower is never told about a post
  they will not see. Republication, member reposts and pins stay allowed (decision 2, 8): the rule
  follows the post wherever it arrives. On such a post the READ GRANT door is closed outright
  (`ReadOpts.grantGuard` = "not students-only", the lead's decision below), so a student holding a
  grant on another cell does not read through it either.
- **Every consumer, and the test that proves it** (`posts/students-only.integration.spec.ts`, real
  PostgreSQL, every case with the switch OFF - the reader IS reached - then ON): the predicate; the
  feed arms `associations`, `all`, `followed` and the CanaReels viewer `reels` (the shipped
  `listPostRows`); the search (the shipped `searchPosts` statement); the post by id with every intent,
  read, react, comment and vote (`readPostOpenVerdict`); the comments withheld from a named reader
  (#2998: OFF they are withheld, ON there is nothing left to withhold); the reaction answer
  (`serveReactionsTo`); the bell (`bellRowShownSql`); the announcement (`announceRecipientsSql`) and
  a mention (`mentionRecipientsOf`); a republication's and a member repost's newly-reached readers; a
  pin in a space a named reader's cell holds (the feed drops the post); the agenda's link back to the
  post (`findPostLinkedToCalendarEvent`); a change of the switch read at once; a student's grant on
  another cell (closed); the platform admin, who opens it only with `allowHidden`; and a REPOST
  PROPOSAL (`RepublicationsService.announce` and `describe`), whose text an acceptor the gate refuses
  never gets. The public link
  preview (`PostPreviewService.findShareable`, the only anonymous surface that names a post) refuses
  such a post (`post-preview.service.spec.ts`). The sitemap lists no post since 2026-11-02.
- **The write** (`posts/students-only.ts`): `STUDENTS_ONLY_ASSOCIATION_TYPES` = association, list, an
  allowlist; anywhere else a 400 with `code: students_only_not_offered`. Both equal
  `libs/contracts/students-only.json`, which the client's constants are asserted against too. Turning
  it OFF is never refused. `updatePost` changes it when the edit names it (absent leaves it alone, so
  an older client never clears it), a reel's included (`posts.service.students-only.spec.ts`).
- **A change reaches every path at once**: the predicate reads the row, so no audience is stored
  anywhere; `updatePost` invalidates EVERY cached feed page (`invalidatePostListCache`, asserted in
  the unit spec). A sweep alone RACED a feed read that computed its page before the flip and stored
  it after (review of #3010), so the cache carries a GENERATION (`posts:list:generation`, plus one
  per reader for `invalidatePostListCacheFor`): every invalidation increments it first, a page is
  stored with the stamp it was computed under, and a page whose stamp is not current is never served
  (`readPostListPage`, one `MGET`). The order makes it deterministic for a delete or a hide too, and a
  failed sweep harmless; only a failed increment can leave a page stale, and it throws to a caller
  that logs it (`post-list-cache.spec.ts` plays the interleavings). The counters carry NO TTL, on
  purpose: a counter reset to 0 could match a page still stored under its earlier value, and Redis
  runs `volatile-lru` on both estates, which evicts only keys with a TTL - so without one they are
  never evicted, and AOF keeps them across restarts. The same spec asserts that policy in both
  compose files; the cost is one small integer per reader a member repost ever reached. The prefix moved to `v3` with the
  stored shape, so a `v2` replica in a rolling deploy never serves a stamped value as a page. The
  served association card and every served post carry `studentsOnly` and the association's `type`.
- **Text copied where the predicate is not asked again**: the swept list is every `previewOf` of a
  post's markdown in the service. The announcement, a mention, a reply, a republication's and a
  member repost's newly-reached readers are all chosen by the predicate. A repost PROPOSAL was not:
  its notification is bound to the receiving association's queue, not to the post, so the bell never
  re-asks; `announce` now sends the text only to the acceptors `studentsOnlyAdmitsUserSql` admits and
  an empty text (the push reads "Publication à relayer") to the others, and the queue's `describe`
  takes the viewer (`ProposalKindHandler.describe(ids, viewerId)`, every kind) and blanks the preview
  for one the gate refuses. The proposal itself still reaches every acceptor, who decides by opening
  the post - which the predicate answers. A proposal's BELL ROW written while the switch was OFF
  keeps its text in the table, and its `postId` names the queue, so `bellRowShownSql` never
  re-asks; `getNotifications` blanks it at the read (`repostProposalTextWithheldSql`, which finds the
  post through the proposal the row announced: same sending association, queue and proposer). It
  FAILS CLOSED: the text shows only while such a proposal leads to a post that exists, is not hidden
  and admits the recipient, and none leads to one that refuses them - so a post deleted or hidden
  (its proposals dropped with it) or a sending association deleted takes the text along. A BDE `MODERATE` holder sees the text of a REPORTED or
  HIDDEN post in the moderation queues (`getHiddenPosts`, the report queue's 250-character preview),
  as for any post they moderate: moderation is the one surface the switch does not narrow.
- **Notifications already delivered - the reversible choice (taken in the build, 2026-11-04)**: a bell
  row is re-asked against the predicate at every read, so closing hides it from the readers it
  withdraws and reopening shows it again; nothing is deleted. A push already shown on a phone cannot
  be recalled; tapping it answers the 404 of a post not seen. Reopening tells nobody new: the post was
  announced once, and a second announcement would be a second notice of the same post.
- **The event is independent** (decision 6): `studentsOnly` is on the post only; the event linked to
  it keeps its own visibility in the agenda and the public calendar. Only the link FROM the event TO
  the post follows the post's rule. A FORM attached to the post is independent the same way: it stays
  reachable by its own id under its own rules, and only the post that carries it is withheld.
- **The client**: `StudentsOnlySwitch.svelte` (a `Toggle`, label "Entre étudiants", and one line that
  follows its position: who will see the post when ON, that everyone of the association's audience
  will when OFF) in the composer, the reel publish step and the edit form - offered while the
  identity is an association or a list (`studentsOnlyOffered`), and in the edit form also on any post
  that already carries it, so it can always be reopened. The composer keeps it in its draft, and
  hands it to the reel step and back ("Garder comme post") inside ONE object, `ComposerReelState`
  (`lib/posts/composerReelState.ts`), through `PostComposerBar`, `CameraOverlay`, `ReelCapture` and
  `ReelPublishSheet`, so no field of that round trip can be carried one way only.
  `StudentsOnlyChip.svelte` on the card's time line and on the reel viewer, for every reader. A
  refusal reads `post_students_only_not_offered`. Nothing on a republisher's side changes (decision 8).

**Decisions taken in the build, reversible, recorded here:**

1. "A student" is an account with at least one SPACE (`isStudentSql`), the vocabulary every other
   rule uses. So a student whose campus and formation have no OPENED space is refused, like staff,
   until that space opens - the same gap they meet on every other space-based rule.
2. The platform admin keeps the MODERATION read only (see the lead's decision S2 below); browsing
   (feed, search, bell) shows an admin without a cursus nothing of it, like any staff member.
3. The post's author always reads it, even after leaving the association.
4. "Members" are the members of the PUBLISHING association only (decision 2 says so); a republisher's
   members without a cursus do not read it.
5. Reopening a post announces nothing new (above).

**The lead's decisions of the review of #3010 (2026-11-04), restrictive and reversible; the owner may
revisit them:**

- **S1 - a read grant never opens an "Entre étudiants" post.** The grant door of the predicate
  carries `grantGuard` = "not students-only" (`associationVisibleToUserSql` and the republication
  disjunct), so on such a post the doors are asked WITHOUT grants: a student who also holds a grant
  on another cell does not read that cell's post through it. A grant is a staff tool; the switch
  says the post is not for staff.
- **S2 - the platform admin bypasses the gate only to MODERATE.** `adminSeesAll` opens such a post to
  an admin only with `adminModerates`, which `readPostOpenVerdict` sets from `allowHidden` - the
  post by id, its comment page and a comment's moderation, the routes a platform admin calls as
  one. Reacting, commenting, voting and browsing ask the gate of an admin like of anyone, so an
  admin without a cursus cannot act on a post they could not read.

**Usage, counted on production 2026-11-14, read-only: not used.** 0 of 327 posts carry
`studentsOnly` (0 of the 63 posts of the last 7 days), ten days after `v1.6.5` shipped it.

### An institution's reach per post, as built (owner, 2026-11-10)

**The owner's decisions (2026-11-10)**, amending D19 for institutions only:

1. **Spaces.** The institution ticks the spaces (formation x campus) the post targets, with the
   shortcuts "a whole campus" and "a whole formation" - never wider than the audience the admin
   gave the institution; the server refuses anything else (typed, at the throw).
2. **Public**, a second choice: **Tous / Étudiants / Personnel** - everyone in the ticked spaces,
   only students (an account with a cursus), or only staff (no cursus).
3. **No default.** Nothing is pre-selected; "Publier" stays disabled until both are chosen.
4. **Editable after publishing, both ways.** Narrowing withdraws the post from the excluded readers
   at once, widening gives it back; an edit sends no new notification.
5. **Everything a post reaches follows the rule** - feed, search, the post by id, comments,
   reactions, votes, notifications and announcements, trends - so it lives in the ONE visibility
   predicate. An event announced by the post keeps its own visibility.
6. "Clair, propre, user-friendly": one compact block.

Shipped in `1.6.10` (#3314); the readings owed are an entry of [the readings owed](plan.md#readings-owed).

The rule in one line: an INSTITUTION chooses, at every post, the spaces of its own audience the post
targets and the public in them (everyone, the students, the staff), with no default, and may change
both after publishing, both ways. Associations, lists and personal posts keep D19. It is the posts
half of the reform's C1 / WP-I ([reform section 3](spaces-and-audiences-reform.md#3-per-item-audience-for-institutions-only-c1)).



**Schema - migration `162_institution_post_reach.sql`, plain (not held).** Two nullable columns on
`posts`, no new table: `"reachPublic"` (`'all' | 'students' | 'staff'`) and `"reachSpaces"` (a jsonb
array of `{formation, campus}` pairs). Three CHECKs, added `NOT VALID` then validated (every row is
NULL): the two are set together or not at all, and only on an entity's post; the public is one of
the three; the spaces are a non-empty array. NULL on both is every post that is not an
institution's, and every institution post written before the file - read as the institution's whole
audience, everyone, which is what it was published to. **No backfill.** Two columns rather than the
`post_audiences` table section 3 sketched: the reach is written and edited with the row, in its own
statement, with nothing to keep consistent across tables, and read by containment (`@>`) exactly as
`users.cursus` is - a malformed value contains nothing, so it fails closed. Concrete pairs rather
than NULL-wildcard rules: the shortcuts are the composer's, and "a whole campus" is stored as the
campus's spaces the institution reaches today. Not held: every statement is plainly additive under
the hold judge (`infrastructure/lib/migration-hold.sh`); the reform's F8 ("every migration held")
was written for the reform's own schema changes. Decided NOT held by the lead (2026-11-10): a new owner
decision, an additive schema, and the owner wants it in `1.6.10`.

**The predicate** (`spaces/reader-spaces.ts`), two changes, each read from the row at every query:

- **The public is a gate over every door but the author's**, beside the switch:
  `institutionReachAdmitsUserSql` admits a reader when the post has no reach, its public is `all`,
  `students` and the reader is a student (`isStudentSql`, the switch's definition), `staff` and they
  are not - or they are a member of the publishing institution (D21: an institution's members read
  everything it publishes). `postPublicAdmitsUserSql` ANDs it with `studentsOnlyAdmitsUserSql`, and
  it is what `postVisibleToUserSql` narrows every door with, what the two newly-reached rules restate
  on their "after" side, and (as `postPublicAdmitsViewerSql`) what a repost proposal's text is
  withheld by. **`students` closes the read-grant door and the browsing admin's by-id door exactly as
  the switch does** (S1, S2 of the review of #3010): the guard is "not students-only AND public is
  not `students`". **"Staff" is exactly `NOT isStudentSql`: any account with no space** - staff (a
  campus and an empty cursus), a student whose campus and formation make no opened space, an account
  with no campus, and a review account - the SQL and every sentence here mean that set, nothing
  narrower; the picker's "Personnel" hint names who it reaches in those terms.
- **Staff by campus, a door of its own (owner, 2026-11-14, "Oui, par campus")**:
  `institutionReachStaffCampusDoorSql` opens a "Tous" or "Personnel" post to every STAFF ACCOUNT OF
  A CAMPUS (`isCampusStaffSql`: a campus, no cursus entry, not a review account - the SQL twin of
  `campusWideReaderCampus`, held to it by `reader-spaces.integration.spec.ts`) whose campus is the
  campus of a space the post ticked AND that the institution's rules still reach. So the School
  addresses its staff without naming each one. It sits beside the rules door in
  `postVisibleToUserSql` (and `eventVisibleToUserSql`, the same fragment), so every consumer below
  gets it - the bell and the announcement included: such staff are TOLD of the post. Under the
  public gate like every door: "Étudiants" closes it. Not opened: a post with no reach (legacy, or
  not an institution's), staff of another campus, a ticked space outside the audience; a student
  gains nothing (a student of an unticked space of the same campus still does not read it); nor an
  account whose cursus names a formation with no opened space (it passes the "Personnel" public but
  is not staff of a campus). `postReachesSpaceSql` is unchanged (a space's readers are students).
  **The feed gate** (`IN_FEED_AUDIENCE_SQL`) admits such staff when an INSTITUTION's rules reach a
  space of their campus, or a staff account told of a post would be refused the feed that holds it
  (the follow precedent, F3 of WP-F5).
- **The spaces narrow the post's OWN institution door**: `associationVisibleToUserSql` takes a
  `spaceFilter` (`ReadOpts.spaceFilter`), threaded into the rules door and the read-grant door, and
  `postVisibleToUserSql` passes `institutionReachHoldsSpaceSql` for the post's own association only. So a
  reader is reached through a space that BOTH one of the institution's rules reaches AND the post
  ticked - never wider than the audience, and shrinking with it. A membership is not narrowed (D21),
  and **a republisher still reaches its own readers** (G4, republication stays the inter-campus
  mechanism), as do a member's repost and an accepted follow: the public still applies to them.
  `postReachesSpaceSql` (pins, campus trends, suggested posts) asks the same filter, and **honours
  the public**: a space's readers are students (they have the space), so a `staff` post reaches no
  space and never takes a student space's pin slot, trend or suggestion (review of #3314).

Every consumer goes through it: the feed arms and the CanaReels viewer, the search, the post by id
with every intent (read, react, comment, vote), the comments withheld from a named reader, the
reactions' answer, the bell (re-asked at every read), the announcement and mentions, the newly-reached
readers of a republication and a member repost, a pin, a trend, a suggestion, the agenda's link back
to the post. The public link preview (`PostPreviewService.findShareable`) refuses a post whose public
is `students` or `staff`, as it refuses "Entre étudiants"; spaces alone narrow an audience as any
association's does, and leave the preview as it was.

**The write** (`spaces/institution-reach.ts`, `resolveInstitutionReachWrite`, the ONE decision, shared
with [calendar events](#an-institutions-reach-per-calendar-event-as-built-owner-2026-11-13)):
`reach: { spaces, public }` on `POST /api/posts` and `PATCH /api/posts/:id`. On a create, an
institution's post without one is a 400 `institution_reach_required`; on any other post a reach is
`institution_reach_not_offered` (a live replay too: it keeps its live's audience, D8); a malformed one
`institution_reach_invalid`; a space the institution's audience does not reach
`institution_reach_outside_audience`. The spaces are folded and sorted, so two equal choices store
one value. An edit with no `reach` leaves the stored one alone (an older client never clears it, and a
legacy post keeps its whole audience until an edit chooses one); a present one replaces it, both ways.
Every change drops the feed cache (`invalidateListCache`, the generation of #3010), and nothing is
announced again: a bell row already delivered is re-asked against the predicate at every read, as for
the switch. The constants equal `libs/contracts/institution-reach.json`, asserted on both sides.

**The options** - `GET /api/posts/reach-options/:associationId` answers `{ spaces }`, the spaces the
institution's audience reaches, campus then formation: `INSTITUTION_REACH_OPTIONS_SQL`, the SAME
statement the write checks against, so what is offered and what is accepted cannot disagree. 403 for
a caller who may not publish as it (`canPostAs`), 400 `institution_reach_not_offered` for an entity
that is not an institution.

**Served**: every post carries `reach: { spaces, public } | null` (`foldServedReach`), to every
reader, so the card can say who it is for.

**The client** (`frontend/src/lib/posts/institutionReach.ts`, the contract's mirror):
`InstitutionReachPicker.svelte`, one block in the composer, the reel publish step and the edit form,
shown while the identity is an institution: the option spaces grouped by campus, a campus chip that
ticks or unticks the whole campus, a "Toute une formation" row only for a formation present on
several campuses, the public as three choices with none selected, and ONE line that says what is
missing or who will see the post. "Publier" stays disabled until a space and a public are chosen. The
composer keeps the choice in its draft and hands it to the reel step inside `ComposerReelState`. The
edit form starts from `post.reach`; a legacy post (`reach: null`) shows the picker empty and saves
without a reach until a choice is complete. `InstitutionReachChip.svelte` on the card's time line and
in the CanaReels viewer: the public and the one space, or a count, every space in its title. The four
codes read as localized sentences (`publishFailure.ts`).

Four rules from the review of #3314: **every reach leaving a component is built by `plainReach`**
(fresh objects - a `$state` proxy makes IndexedDB's structured clone throw `DataCloneError`, and the
publish queue stores the payload there; `CreatePostForm.institutionReach.svelte.test.ts` clones the
enqueued call); **the edit form sends a reach only after the author touched the picker** (`ontouch`) -
the picker prunes, on its own, a ticked space the audience no longer holds, and that is not a choice;
**a failed options load offers Retry**, and options on a campus this build does not know are not
drawn, ACCUSED by a `console.warn` and, when nothing is left, told to the author
(`post_reach_unknown_campus`); **the four codes are FINAL in the durable publish queue**
(`retryCannotCure`, `QueuedPostFailure.final`): the queue re-sends the payload it stored, so a Retry
would be refused word for word - the banner offers Delete alone.

#### Decisions taken in the build, reversible

1. **"Personnel" and "Tous" reach the staff of a ticked space's campus (owner, 2026-11-14, "Oui,
   par campus")** - the staff-by-campus door above - beside the staff who already had a door (the
   institution's members, named readers whose grant cell meets a ticked space, a republisher's or a
   reposter's staff readers). Built on 2026-11-10 as "only the staff who already have a door" and
   parked for the owner, who answered on 2026-11-14
   ([open-questions](open-questions.md#decided-2026-11-14-by-the-owner-oui-par-campus---an-institutions-personnel-public-reaches-every-staff-account-of-its-campuses)).
   Reversible: one disjunct and one gate term. The association-level readers (the shop, the
   partnerships, the directory, an institution's live, an event or a post with no reach) are NOT
   widened: they carry no per-item public, and opening an institution to its campus's staff as a
   whole is a separate question, parked in the same entry.
2. **A republication and a member repost keep reaching their own readers** (G4); only the public
   follows the post there.
3. **An institution's members read every post of it**, whatever its reach (D21), as the switch lets
   the publishing association's members in.
4. **A legacy institution post keeps NULL** (its whole audience, everyone) until an edit gives it a
   reach; the edit form does not force one.
5. **An entity's type is not editable today** (`UpdateAssociationDto` has no `type`; only a direct
   database edit changes it), so a post that carries a reach always belongs to an institution. If the
   type ever became editable, an ex-institution's post would keep a reach it can no longer change:
   the options route answers `400 institution_reach_not_offered` (the picker shows its load error)
   and a PATCH naming a reach is refused the same way - the type change would then have to clear
   `"reachPublic"`/`"reachSpaces"` on that entity's posts in the same transaction (or the write
   accept a reach on a post that already has one), and the edit form draw the picker from the
   served `type` alone (review of #3314, unreachable today, nothing built).
6. **Events carry their own reach since 2026-11-13** (below): the event a post announces is read
   through the EVENT's predicate, never the post's. The `association_calendar_event_audiences` table
   of reform section 3 was not built: events took the posts' two columns instead.

#### Proof

`posts/institution-reach.integration.spec.ts` (real PostgreSQL; ten readers - students of two
ticked and one unticked space, the institution's member and officer, two named readers, a carrier's
staff, an outsider, the platform admin - under four reaches: none, one space for everyone, two spaces
for students, two spaces for staff) over the predicate, the `associations` and `all` feeds
(`listPostRows`), the search, the post by id (read and comment), the bell and the announcement, a
republication's newly-reached readers, `postReachesSpaceSql`, a ticked space outside the audience
(opens nothing), an edit narrowing then widening, the options and the write's four refusals against
a real audience, and migration 162's CHECKs and re-run. `posts.service.institution-reach.spec.ts`:
the contract, the create (stored, required, outside, not offered), the edit (narrow and widen with the
cache dropped, absent leaves it, refused on an association and a replay), the options' refusals, the
served field; `post-preview.service.spec.ts`, the link preview refused for students or staff and
kept for everyone. **Break-proof, run 2026-11-10**: with `institutionReachHoldsSpaceSql` (then
`postReachHoldsSpaceSql`) always true, 9 of the 28
integration tests fail; with `institutionReachAdmitsUserSql` always true, 11.

### An institution's reach per calendar event, as built (owner, 2026-11-13)

The owner's decisions, final: an INSTITUTION chooses, for EACH calendar event it files, the
formation x campus spaces (with "tout un campus" and "toute une formation") and the public (Tous /
Étudiants / Personnel, the posts' meaning); nothing is pre-selected and "Déposer" stays disabled
until both are chosen; the reach is editable after validation or publication, both ways, sends no
notification and does NOT send the event back to validation; and it is ONE model with posts - the
same picker, the same refusals, the same chip, the post code factored rather than copied.

**Schema - migration 165** (`165_institution_event_reach.sql`): `association_calendar_events` gains
the posts' two nullable columns, `"reachPublic"` and `"reachSpaces"`, with the same three CHECKs
(added `NOT VALID`, then validated). NULL is every event that is not an institution's and every
institution event filed before the migration: its whole audience, as before. No backfill. **Not
held**: `migration_hold_reason` returns empty (additive only), as for 162.

**One shared code path** - nothing of the posts' half was copied:

- `spaces/institution-reach.ts` (moved from `posts/`): `resolveInstitutionReachWrite` takes a
  `subject` (`'post' | 'event'`) that changes only its dev-facing messages; the typed codes are the
  posts' four. `institutionReachOptionsOffered` is the options statement both routes answer with.
- `spaces/reader-spaces.ts`: `institutionReachHoldsSpaceSql` (the ticked-pair containment, renamed
  from `postReachHoldsSpaceSql`), `institutionReachAdmitsUserSql` (the public gate) and
  `institutionReachNotForStudentsSql` (what closes the read-grant and admin doors to a `students`
  item) are read by BOTH `postVisibleToUserSql` and `eventVisibleToUserSql`.
- The client: `InstitutionReachPicker.svelte` takes `subject` (the missing-choice line says
  "déposer") and `loadOptions` (the event form passes `getEventReachOptions`);
  `InstitutionReachChip.svelte` on the event's detail.

**The predicate** - `eventVisibleToUserSql(event, user)`, the ONE event predicate: the public gates
every door (`institutionReachAdmitsUserSql`), the spaces narrow the organiser's own door (rules and
read grants, through `ReadOpts.spaceFilter`), and a `students` event closes the read-grant door.
`eventReachesSpaceMatchingSql` (the agenda's space filter and the anonymous per-selection feed) asks
the same filter, and a `staff` event reaches no space, as `postReachesSpaceSql` does. **Staff by
campus** (owner, 2026-11-14): a "Tous" or "Personnel" event opens to the staff of a ticked space's
campus through the posts' fragment, `institutionReachStaffCampusDoorSql` - so the signed-in agenda,
the event by id, the opening reminders and a post's event card all follow; the anonymous feeds do
not change (a `staff` event is still withheld from them).

**Co-organised events - decided by the lead, reversible:**

1. **The public gates every door**, an accepted co-organiser's included.
2. **The organiser's members AND an accepted co-organiser's members are exempt from the public**:
   they co-own the event, edit it from the partner side, and list it on their own page - hiding it
   from them would hide their own event.
3. **The spaces narrow only the institution's own door** (rules and read grants). **An accepted
   co-organiser keeps its own audience**, as a republisher keeps its readers for a post (G4): an
   institution that co-organises with an association reaches that association's readers through it.
4. **Only the organiser sets the reach** (E2): a partner's PATCH naming one is refused with
   `partnerOrganiserOnlyRefusal('reach')`, and the form draws the picker on the organiser side only.

**Every surface asks it**: the agenda lists and their filters, the event by id, the search, the
`.ics` and JSON feeds (personal, judged by the reader's predicate; and the anonymous ones, see the
policy below), the opening reminders (`eventOpeningSeenBySql`, asked when the followers are written AND
again at the opening, so a narrowing in between drops a reader), the feed's event card and a post's
linked event (`eventCardShownToViewerSql`: an event with a reach is shown only to a reader its own
predicate admits; one without is unchanged).

**Anonymous feeds - the same rules as posts (lead's decision, review of #3460, reversible).** A post
whose public is `students` or `staff` never reaches an anonymous reader (the link preview refuses
it), so neither does an event: every anonymous read - an association-only link AND a signed
campus/formation selection feed, `.ics` or JSON - withholds an event whose public is `students` or
`staff`, whatever space it ticks (`restrictAnonymousToPublicReach`). Those links are signed over the
SELECTION, not a reader, and are shareable, so they cannot carry a public. A selection still narrows
by `eventReachesSpaceMatchingSql` (the ticked spaces). **The signed ONE-event link is left whole, as
intended**: it is minted for one event by a reader who saw it, and shares that event as a forwarded
invitation would.

**Version skew.** The event form offers the reach only on an estate that advertises `eventReach` in
`/api/version` (`eventReachOffered`); an old app on a new server meets `400
institution_reach_required` on an institution's create (accepted, the posts' precedent). Both are in
[legacy-compatibility](legacy-compatibility.md).

**The write**: `reach` on the event create and update routes, through `resolveInstitutionReachWrite`:
mandatory on a create by an institution, refused on any other owner, and on an edit absent leaves
the stored one alone. The status is never touched. **The options**:
`GET /api/associations/:id/events/reach-options` - a global admin, anyone who may propose the
institution's events (`PROPOSE_EVENT`), or anyone who validates them; 403 otherwise; 400
`institution_reach_not_offered` for a non-institution.

**Served**: every event carries `reach: { spaces, public } | null` (`servedInstitutionReach`).

**The form** (`frontend/src/lib/calendar/eventForm.ts`): `canSetReach` is true when "Au nom de" is an
institution (the global agenda) or on the institution's own page for its own events; `offersReach`
adds the organiser side; `reachBlocksSave` keeps the save disabled while a required reach is
incomplete. A new event's reach is required; an existing one's only when it already carries one (a
legacy event saves without until a choice is complete). An edit sends the reach only once the picker
was touched (the posts' rule from the review of #3314). The four codes read as event sentences
(`calendarErrors.ts`).

#### Proof - events

`associations/institution-event-reach.integration.spec.ts` (real PostgreSQL; an institution on a
whole campus, an association co-organising from another campus, readers of a ticked space, of an
unticked space inside the audience, staff, members of both, an outsider): migration 165's CHECKs and
re-run; a reader of a ticked space sees the event; a reader of an unticked space inside the audience
does not; the public gate (students, staff, all); an edit narrows at once and widens back; a space
outside the audience opens nothing; the co-organiser door; the anonymous selection; the event card;
the write's refusals and the options; a signed selection feed withholding a `students` event (and a
`staff` one) through the very space it ticked, the clause captured from the service's own method.
`opening-reminders.integration.spec.ts` (11): a narrowed event's
opening reaches nobody it no longer admits. **Break-proof, run 2026-11-13**: with
`institutionReachHoldsSpaceSql` always true, 11 of 11 fail; with `institutionReachAdmitsUserSql`
always true, 11 of 11; with the selection exemption put back in the anonymous clause, the
selection-feed test fails. The readings owed on a phone are in
[the backlog](backlog.d/institution-event-reach.md).

