# MiConnect profiles and access - the reform (decided with the user, 2026-09-29)

**Status (2026-10-01): WP0, WPA and WP1 are BUILT AND LIVE on production (2026-09-30); WP2 is BUILT AND
TESTED, ON `main`, AND REACHES PRODUCTION WITH THE NEXT STABLE; WP3 is BUILT (backend, backfill, directory), WP4 to WP9 are PLANNED**. Every answer below was given by the user on
2026-09-29, one question at a time. The technical plan that turns them into work packages is section 4,
VALIDATED the same day. Sections 1 and 3 describe production as measured BEFORE WP0/WP1: read them as the
starting point, not as today's state. Anyone can log in to MiConnect with a School CAS account (and soon a Mines Saint-Etienne
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
1816 - the validator accepts anything. 6 accounts have no all-capitals word in their name, so their
`lastName` is empty - **and none of them is a person** (read 2026-09-30): authentik's
`AnonymousUser`, a `service-account` and the four campaign accounts `canari-test-*`. Every real
account splits. The `1816` was `les.roots`, an internal admin account the user DELETED as dead the
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
- **D31 - A personal post inherits its AUTHOR's spaces**; someone with no space (a staff post only)
  cannot publish one, and publishes through an institution instead. **Closed as MEMBERSHIP ONLY
  (user, 2026-10-05)**: through institutions they are a member of, nothing more.
- **D32 - Two cursus pay the MOST FAVOURABLE price**: the matrix is evaluated for each cursus and the
  cheapest cell wins. A question shown to, or a submission allowed for, any of their cursus is shown
  or allowed.
- **D33 - A post chooses its own visibility (user, 2026-10-04), amending D19's "fixed by the author".**
  An entity's audience rules are its CEILING - what it may address: the School everything, each of
  the two MEs its campus, an association its own. A post with no rule inherits them; an author may
  give it rules of its own, and the server refuses any outside the ceiling. Going beyond is the
  nominative grant of D24. One mechanism for associations, lists and institutions alike, so no
  entity needs a special case.

## 3. Found on the way

- **A MiGallery API key travels in plain text in claims.** The property mapping `avatar` builds a
  URL carrying it, and it is attached to MinoWiki and Archives MINO, so any user of either can read
  it in their own id_token or userinfo. The value is not written here. Closed by WP0 on 2026-09-30
  ([section 4](#the-work-packages-in-order)).
- **The Alumni source's `sso_url` is a placeholder** while the source is enabled and promoted.
  Whether its button renders on the sign-in page was not observed.

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
   is passed through `infrastructure/authentik/compose.yml` from `/srv/miconnect/.env`. MiGallery reads
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

The `?api_key=` query path that only this mapping used is still accepted by the route. Removing it
is a MiGallery follow-up.

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
(`le-cercle/src/lib/server/auth/authentik/index.ts`), so nothing ever uses those tokens later;
`akadmin` is KEPT with its password, as the break-glass account if the CAS is down.

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
  profile, for 607 accounts - the ONLY differences were 14 `Master -> Autre` and `les.roots`' `1816`.
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
  `profile_post_*`). The profile page (own and by id) shows them as chips (`ProfileChips.svelte`, reading `cursus` only, so a person not yet backfilled shows no chip until the backfill or their next sign-in).
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
  MICONNECT_EDITOR_TOKEN` from `/srv/miconnect/.env`, declared with `:?` in the stack's `compose.yml`,
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
  MODERATE stays global (D23).
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
the grid needs to draw itself), `PUT /api/associations/spaces/:id/bde` (designate or clear; only a
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
:id`) read it; MODERATE stays global (D23). An event is judged on its OWN association, read from the
row, never the URL's. The client draws per-association controls from `GET
/api/associations/me/bde-reach` and the pending queue's per-row `canValidate`. **Left unscoped on
purpose** (no association to scope to): creating an association, categories, carte, document
reviewers - WP7's question. Table, routes and proof:
[association-permissions](association-permissions.md#wp6c-step-2-a-bde-governs-the-associations-its-spaces-reach-2026-10-04).
**Production consequence**: while every association still carries 071's single (ICM,
saint-etienne) rule, the one BDE governs all of them and nothing changes; the scoping bites the day
the grid gives an association a reach outside its BDE's spaces.

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
  with its author. Reels are posts here. Scheduled, hidden and expired-reel rules are unchanged.
- **The gate** (`FeedAudienceGuard`, `IN_FEED_AUDIENCE_SQL`): an admin, a reader with at least
  one space, or a member of at least one association. **Readers**: `GET /api/posts` (all four
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
- **A personal post by someone with no space** (staff, D31 not yet enforced at publish) is seen
  only by its author, admins - and nobody else.
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
| Personnel (School, ME, Alumni association) | institution x campus | only by membership or an explicit rule; never a student's personal post | next |

Order: WP6c (BDE per space, `isBDE` deleted) comes first (D35). A new association reaches its creator's
spaces by default (D36, built - see below; NOT an institution, which starts with no rule, WP6e). A personnel is DECLARED at enrolment, nothing more (user, 2026-10-04), and one person may be a student
and a personnel: the spaces add up. Being personnel gives NO right to publish as the School: that takes
membership of the institution's own instance, exactly as for an association. Everyone ticks `EMSE`, so that
box no longer defines anything.

### D37-D41 - What each surface shows

| Surface | Who sees it | State |
| --- | --- | --- |
| Association post | author; members; readers its association's audience reaches (or a republishing one's), passing the filters | built (filters not built) |
| Personal post | author and people sharing a space; never an institution; an admin only by id | built |
| Republication (D38) | only associations and institutions, by proposal accepted by the other's admins; never a personal post; card shows "republished by X, Y"; notifies only those who newly see it | built ([as built](#d38-republication-as-built-2026-10-04)) |
| Event (D39) | union of the audiences of the organiser and of each ACCEPTED co-organiser | built ([as built](#d39-co-organisation-as-built-2026-10-05)) |
| Agenda signed in | as events above | built |
| Agenda anonymous / `.ics` (D40) | one feed per selection (campus, formation x campus, "mine") | built, bare URL refused, **selection SIGNED since 2026-10-06** ([as built](#d40---the-anonymous-agenda-per-selection-as-built-2026-10-05), [amended](#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)); "mine" is the signed-in agenda only |
| Association directory (D37) | associations reaching one's spaces, or one belongs to | built |
| Association page | NOT LISTED for a reader outside its audience, but reachable by a link (user, 2026-10-04); the member list does NOT follow the audience | existing |
| Association map | filters to show or hide associations and to select them by campus, formation | server filter built, map next |
| Feed (the gate) | admin, or one space, or one membership | built |
| Admin browsing (D41) | exactly like an ordinary reader; opens one post by id for moderation | built |
| Messaging, forms, people directory | any valid profile, no border | built |

### Filters and rights

| Item | Rule |
| --- | --- |
| Filters (promo, contributor) | kept, per association, cumulated: original's OR a republication's that reaches the reader - **NOT BUILT: no promo or contributor filter exists in code yet**, so nothing narrows either branch |
| Per-post space rules (`post_audiences`, ceiling, DTO `audiences`) | removed (D38, migration 073) |
| Join an association | its admins add the member; following opens nothing |
| Moderation | global (D23) |

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
| `all` | the whole catalogue | every PICKER and admin screen (`listAssociations`): co-organiser, a list's parent, payment delegation, past roles, the shop's names, the people directory's filter, the agenda's filter and deposit target, the composer for an admin, `/admin/spaces`, `/admin/cercle`, `/admin/carte` |

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
  - `republishedBy` (oldest first) draws "Republie par X, Y +N" under the header, one card per
    post;
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
  until they do). One association's feed shows no selector. The SEO agenda page (`serverSeo`), which
  reads anonymously, asks once per campus and merges - so an association with no rule, on no campus,
  does not appear in that JSON-LD.
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
- **Open on purpose:** `eventId` (the one-evening link, no signature), a **signed-in** JSON read (already
  narrowed to the reader's spaces by `restrictToViewerSpaces`), and a **server-internal** read.
- **The SEO agenda page** (`serverSeo`) keeps its per-campus reads unchanged and passes its existing
  `X-Internal-Secret` (`internalHeaders()`): the JSON feed treats a valid internal secret as trusted
  and skips the signature (`isInternalSecret`, timing-safe, `internal/is-internal-secret.util.ts`). No second secret, no public bypass; the
  public JSON-LD is untouched.
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

### WP6e institutions as built (2026-10-05)

Migration `075_institution_type.sql` (replay-safe) adds `CHK_associations_type` over `association | list | institution`.
An institution is an `associations` row of that type, so it reuses every mechanism rather than adding a second one:

- **Created by a global admin only** (D20, D24): `POST /api/associations` with `type: 'institution'` is a 403 for a BDE
  member holding MANAGE_ASSO, before any write. Since 2026-10-07 the UI is `/institutions/new` (button "Créer une institution" on `/institutions`, global admin only; the checkbox of `/associations/new` is gone), see [associations](frontend/modules/associations.md#one-header-and-one-creation-flow-for-the-three-directories-2026-10-07).
- **Members are added nominatively** by the existing member admin; **publishing in its name needs membership of it**
  with `POST_AS_ASSO`, exactly as for an association (being personnel gives no right, D34-D36). Events are proposed with
  `PROPOSE_EVENT` the same way; the post composer and the event picker are type-agnostic.
- **Republishing**: `REPUBLISHING_ASSOCIATION_TYPES` is now `association, institution` (a list still does not); the
  dialogs offer institutions. Co-organisation takes any association row, so institutions co-organise too.
- **Listings**: `?type=institution` is accepted by the directory and the public listing. **`/institutions` is its own page**
  (user, 2026-10-05): the same directory API and `AssociationTile` as `/associations` and `/lists`, narrowed by type, so the
  same visibility (rules reaching the reader's spaces, plus memberships, D37). `/associations` no longer lists institutions in
  its catalogue (the cleaner reading of the choice; its "mine" shelf still shows the ones the reader belongs to) and carries an
  "Institutions" button, as it does for lists. The page is `noindex` like `/lists` and has its title in `resolve.ts`. An
  institution can never be a BDE (the `/admin/spaces` button is for `association` only).
- **Reach**: its audience rules (its ceiling, D33) are the same `association_audiences` rows, edited on the grid.
  **A new institution has NO rule** (user, 2026-10-05): `AssociationsService.create` skips D36's default for
  `type: 'institution'`, so it is visible to its members only until an admin ticks the `/admin/spaces` grid (a global
  admin's own spaces are rarely the School's). D33's one mechanism is kept: the type decides the default, nothing else
  differs. `associations.service.create-default-audience.spec.ts` carries the control (an institution created by someone
  with spaces writes no rule).
- **D31 closes as "membership only"** (user, 2026-10-05): a person with no space publishes through the institutions they
  are a MEMBER of, with `POST_AS_ASSO`. Nothing to build; no way to pick an institution one does not belong to.

### Audiences policy as built (WP-A, 2026-10-08)

Server half of the seven decisions of [the decisions](#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08); the client presets (WP-B) come after. One module, `spaces/audience-policy.ts`, holds the rules and the typed codes (classified at the throw: a client reads `code`, never the message).

- **Default at creation replaces D36's "creator's spaces"**: `AssociationsService.create` writes, in the transaction of the row, ONE rule `(formation NULL, campus = the creator's profile campus)` for an association AND a list. A creator with no valid campus is refused `400 AUDIENCE_CREATOR_CAMPUS_REQUIRED` and the row rolls back (decision 5, never guessed). An institution still gets NO rule: the creating global admin ticks its audience afterwards (`PUT /api/associations/:id/audiences`).
- **`everyone` refused outside institutions** (decision 6): `setAudiences`, the one write path of the audience (the admin grid and the BDE both call it), refuses any rule with `campus` NULL - a formation across campuses included, which is the multi-campus audience decision 3 rules out - with `400 AUDIENCE_EVERYONE_INSTITUTION_ONLY`, for a global admin too. Creation writes only a campus rule, and `PATCH` cannot change an entity's type, so nothing else writes a rule. Existing everyone rules stay until someone edits that entity.
- **The BDE star** (decision 7): `PUT /api/associations/:id/audiences` is open to a global admin OR the holder of MANAGE_ASSO in a BDE (`BDE_GOVERNED_CAMPUSES_SQL`: the campuses of the spaces that BDE governs). A star is refused `403` when it is not a star (`AUDIENCE_ADMIN_OR_BDE_REQUIRED`), when the target is an institution (`AUDIENCE_INSTITUTION_ADMIN_ONLY`), or when EITHER what the entity addresses now OR what is submitted leaves its campuses, or the entity has no rule at all (`AUDIENCE_OUTSIDE_BDE_CAMPUS`). `PUT /api/associations/spaces/:id/bde` (the BDE flag) stays global-admin only. `GET .../audiences` is open to a star on the same bound since 2026-10-08 (see WP-B below).
- **A change applies to everything, past posts included** (decision 4): visibility is computed from the CURRENT rules at read time and nothing is stored on a post (D38). Proof: `reader-spaces.integration.spec.ts` moves an association's audience under a stored post and the post follows (skipped without `SOCIAL_IT_DATABASE_URL`).
- **No back-fill migration.** `users` belongs to core-service, so a social migration reading `users.campus` would fail on a fresh database, and an entity D36 left rule-less (creator with no space) was left so on purpose. Measure first, read-only (never run by an agent against production), then decide with the user:

```sql
SELECT a.type, count(*) AS no_rule, count(u.campus) AS creator_has_campus
FROM associations a
LEFT JOIN users u ON u.id = a."createdBy"
WHERE a.type IN ('association', 'list')
  AND NOT EXISTS (SELECT 1 FROM association_audiences r WHERE r."associationId" = a.id)
GROUP BY a.type;
```

Closed by WP-B (2026-10-08): `AssociationsService.create` refuses a NON-admin creator `403 AUDIENCE_OUTSIDE_BDE_CAMPUS` when the default campus is not one `BDE_GOVERNED_CAMPUSES_SQL` returns for them, inside the transaction (the row rolls back; `assertCreatorCampusGoverned` in `audience-policy.ts`). A global admin is unchanged and runs no governed-campus query. Cases in `associations.service.create-default-audience.spec.ts`.

### Audiences client presets as built (WP-B, 2026-10-08)

Client half of the seven decisions. Files: `lib/associations/audiencePresets.ts` (pure: `offeredPresets`, `presetToRules`, `readPreset`), `audienceRefusal.ts` (the five codes), `components/associations/edit/EditAudienceTab.svelte`, `components/profile/ProfileCampusPrompt.svelte`.

- **Three presets, and `everyone` only for an institution.** Decision 1 lists three presets but also says `everyone` is for institutions, so an association or a list is offered TWO (`campus`, `formations`) and an institution THREE. `presetToRules` maps them to `(null, campus)`, `(formation, campus)` per ticked formation, and `(null, null)`; a half-filled choice yields NO rule, never a wider one. The server stays the rule (`AUDIENCE_EVERYONE_INSTITUTION_ONLY`).
- **Where.** An "Audience" tab on the association edit page, for a global admin, or a BDE star of THIS association (`me/bde-reach`) when it is not an institution. A member of the association alone does not see it: the server refuses them (`AUDIENCE_ADMIN_OR_BDE_REQUIRED`), so offering it would be a button that can only fail. The global admin keeps the campus picker and a link to the `/admin/spaces` grid.
- **A star READS the current audience, inside its campus (user, 2026-10-08: "campus de l'etoile seulement").** `GET /api/associations/:id/audiences` is a global admin's, or a star's for an entity whose CURRENT rules all lie within the campuses it governs (`assertBdeMayReadAudience`, the read half of the write check: same codes `AUDIENCE_OUTSIDE_BDE_CAMPUS` / `AUDIENCE_INSTITUTION_ADMIN_ONLY` / `AUDIENCE_ADMIN_OR_BDE_REQUIRED`, an unruled entity refused). The editor reads it with `getAssociationAudiences` for both roles and preselects the matching preset (a custom, grid-edited audience is reported as custom); only when the read is refused does it open with no preset ticked and the "saving replaces what is in force" warning.
- **Typed refusals.** `audienceRefusalCode` reads `SocialApiError.code` (set by `request()` from the body), never the message; each of the five codes has a Paraglide sentence (`audience_err_*`).
- **No campus: the profile prompt** (decision 5). `AssociationCreatePage` reads the own profile on mount and, for an association or a list with no valid campus, shows `ProfileCampusPrompt` instead of the form; a stale profile that the server still refuses (`AUDIENCE_CREATOR_CAMPUS_REQUIRED`) lands on the same prompt. The campus is MiConnect's and only an admin edits it, so "complete the profile" is the EXISTING correction request (`ProfileCorrectionRequest`) plus the link to `/profile`.
- Tests: `audiencePresets.test.ts`, `audienceRefusal.test.ts`; server `associations.service.create-default-audience.spec.ts`.

### Nominative read grants as built (WP-C, 2026-10-08)

The seven decisions of [the decisions](#the-nominative-read-grants---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08), WP7 of D24.

- **Model** (migration `078_read_grants.sql`): `read_grants(user_id, campus, formation NULL = whole campus, granted_by, created_at)`, unique per cell (`COALESCE(formation, '')`, so NULL repeats are refused), no end date; `read_grant_journal` is append-only (`grant`/`revoke`, `actor`, `at`). A revocation deletes the grant row and writes the journal line in one transaction; setting a state already held writes nothing, so the journal records changes only. API: `GET`/`PUT /api/associations/read-grants` (`read-grants/read-grants.*`), GLOBAL ADMIN ONLY on both - the list is internal, a grantee cannot even read their own row. Granting to an unknown account is a 404.
- **Visibility plugs into the one predicate**: `readGrantReachesAssociationSql` in `spaces/reader-spaces.ts` - a grant cell contains the OPEN spaces it matches, and an association is reached when one of ITS RULES reaches such a space (any type; an institution addressing Gardanne is reached by a Gardanne cell whatever campus the grantee has). It is spliced through `ReadOpts.readGrants`, which only the `*ToViewerSql` read paths turn on (feed, search, one post, comments, reactions, votes, signed-in agenda, calendar link) and the feed gate (`IN_FEED_AUDIENCE_SQL`, so a named reader with no space and no membership opens the feed). It goes into the ASSOCIATION branch of `postVisibleToUserSql` (and the republisher's), never the personal-post branch: personal posts stay invisible by construction.
- **Not widened**: `announceRecipientsSql` and `NEWLY_REACHED_BY_REPUBLICATION_SQL` use the plain predicate, so a grantee is NEVER notified; the directory (`associationVisibleToViewerSql`) is unchanged; the agenda signing (D40, `signAgendaFeedSelection`, `READER_SPACES_SQL`) signs the reader's OWN spaces only, a grant adds none, and the anonymous selection has no reader. Publishing is untouched: a grantee publishes through an institution they belong to (D31).
- **UI**: `/admin/read-access` replaces `/admin/document-reviewers`: a person x (campus x whole-campus/ICM/ISMIN/FSSS/PDIS/Autre) grid of checkboxes (ISTP is FSSS, noted on the page), the journal, and below them the document-reviewer section unchanged (its `document_reviewer_grants` rows were NOT moved: it is a different capability - public documents - and still open to BDE super-admins, who do not see the grid).
- **Proof**: `spaces/read-grants.integration.spec.ts` (real PostgreSQL, `SOCIAL_IT_DATABASE_URL`): per-post matrix over four named readers, personal posts never visible (even with `adminSeesAll`), no-grant readers unchanged, gate, agenda, no notification, directory unwidened, revocation, unique key, idempotent migration; `read-grants.service.spec.ts` for the writes.
- **THE WRITE BOUNDARY (review of 2026-10-08, user decision "read + react/comment")**: a grant lets its holder **read, react, comment and like a comment: YES; vote in a poll, republish, publish: NO.** `postVisibleToViewerSql` counts the grant by default (every read) and takes an explicit `readGrants: false` for the writes a grant never opened. `PostsService.assertVisible(postId, viewer, intent)` has a REQUIRED intent: `'READ_OR_REACT'` (post by id, calendar link, reaction, comment, comment like) or `'VOTE'` (the poll vote, grant-free). `RepublicationsService.assertVisibleTo` is grant-free: a grantee who also publishes as some association X cannot republish into X a post only the grant shows them (404, like any post they cannot see). Publishing a post is unchanged and stays through an institution (D31). Proof: `read-grants.integration.spec.ts` (read-or-react vs vote over every post and reader), `republications.integration.spec.ts` (a grantee who is POST_AS of an association is refused, no row written), `posts.service.visibility.spec.ts` (the SQL of `'VOTE'` has no `read_grants`), `posts.controller.visibility.spec.ts` (each route passes its intent).
- **Ids**: `users.id` is the OIDC subject lowercased (`NginxAuthGuard` lowercases `x-user-id`; core-service does the same), so the controller lowercases the grantee id and the actor before storing. No foreign key crosses services, so the account-deletion hook (`InternalController.deleteUserData`) deletes the account's grants and anonymises it (`[deleted]`) in the journal, both as grantee and as actor.
- **Cost, measured** (throwaway PostgreSQL 16, 50,000 posts over 300 associations, 20,000 users, 40,000 requested grants = 8,000 grantees with a few cells each - a real grantee holds at most 12 cells, so "20k grants on 200 users" cannot exist; `EXPLAIN (ANALYZE, BUFFERS)` of `postVisibleToViewerSql` as a filter, `ORDER BY createdAt DESC LIMIT 20`, 3rd run, JIT off): a reader with NO grant 600 ms / 198k buffers before this change, 670 ms / 268k buffers with it (+10%, the per-row grant lookup finding no row); a grantee 1,060 ms / 464k buffers. With JIT on the same queries are 930 / 1,180 / 1,500 ms. The baseline itself is a nested loop over every post (the predicate is evaluated per row), which is the pre-existing shape of the feed predicate, not this change. **No index added**: `CREATE INDEX ON association_audiences ("associationId")` was tried and the planner kept the sequential scan of a 300-row table in all six plans; `read_grants` is already served by `idx_read_grants_user` (bitmap index scan).
- **Owed**: one look at the grid signed in. The feed cache is dropped on every real change.

#### The eight dev checks (2026-10-09, `dev.canari-emse.fr` on `1.2.1-alpha.1`, same code as `v1.2.1`)

Set up through the API as the dev global admin (`canari-test-delta`): two throwaway associations, one with the audience `(campus gardanne, every formation)` holding a post and a poll post, one saint-etienne control. Grantee: `canari-test-gamma` (ICM, saint-etienne), granted the whole gardanne campus with `PUT /api/associations/read-grants`. Every fixture, the grant, the membership and the BDE flag were removed afterwards (re-read in the dev database: 0 left).

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | a grantee sees the association posts of the granted campus | PASS | before the grant `GET /api/posts/:id` 404 for both posts; after it 200, and both are in `GET /api/posts?limit=50` |
| 2 | no personal post of that campus | PASS, on the predicate | dev has NO personal post by a gardanne author and `canari-test-epsilon`'s credentials are not in `test-accounts.json`, so no end-to-end post. The shipped `postVisibleToViewerSql` was run read-only on the dev database with the grant live, over a personal post by each of the 8 gardanne users: `false` for all 8, `true` for the association post |
| 3 | can react | PASS | `POST /reactions` 201 |
| 4 | can comment | PASS | `POST /comments` 201 |
| 5 | cannot vote through the grant | PASS | `POST /polls/:pollId/vote` 404 `Post not found`; the stored poll keeps zero votes |
| 6 | cannot republish through the grant | PASS | the grantee, `POST_AS` of a saint-etienne association, gets 404 `Post not found` and no row is written; control: the same grantee republishes a post it sees natively, 201 |
| 7 | a revoke restores the baseline | PASS | after the revoke: post 404, reaction 404, comment 404, the posts gone from the feed, `Publication introuvable` on screen |
| 8 | a star reads audiences of its own campus only | PASS | before: 403 `AUDIENCE_ADMIN_OR_BDE_REQUIRED`; as `MANAGE_ASSO` of a saint-etienne BDE: own-campus association 200 `[{campus: saint-etienne}]`, the gardanne association 403 `AUDIENCE_OUTSIDE_BDE_CAMPUS` |

Two P3 client defects were found on the way, both in the [backlog](backlog.md#audiences-of-associations-lists-and-institutions---built-in-production-since-v120).

### FEED_GATE - a 403 is a verdict, not a failure (2026-10-06)

Proven cause: `FeedAudienceGuard` answers a signed-in reader with no space and no association `403` (by design, tested in `feed-audience.guard.spec.ts`), and `routes/posts/+page.svelte` mapped EVERY rejected posts read to `posts_load_error_title`. The redirect to `/chat` only fires on a KNOWN `false` verdict, so an unknown or stale `true` verdict (revalidated behind the render, no redirect) landed on the error. Fix on the client, by status: `isFeedAudienceRefusal` / `isOutsideFeedAudience` (`lib/posts/feedAudience.ts`) classify a 403, correct the remembered verdict, and the page renders the `posts_no_audience_*` empty state; 401/5xx/transport keep the generic error and its retry. Test: `feedAudienceRefusal.test.ts`.

### The audiences chantier - the decisions (user, 2026-10-07; moved from the backlog 2026-10-08)

Seven decisions on the audience of associations, lists and institutions (the last was Master's recommendation, accepted): (1) the manager chooses among THREE presets, never the raw grid - my campus; my campus plus the formations I name; everyone (offered to institutions only; the global admin keeps the full grid in Espaces & audiences); (2) default at creation is the association's campus, every formation, applied automatically and editable, a list likewise; (3) an association present on two campuses is TWO associations, partners on a shared event (D39, migration 074), with no multi-campus audience on one entity; (4) a change of audience applies to everything, past posts included; (5) a manager with no campus completes their profile first; (6) only institutions, created by a global admin, may target everyone, and the SERVER refuses `everyone` elsewhere; (7) the star (space BDE) may set the audience of the associations of ITS campus only. As built: WP-A, WP-B and the star's read above.

### The nominative read grants - the decisions (user, 2026-10-07; moved from the backlog 2026-10-08)

WP7 of this plan (D24: grants only ADD, a global admin grants across spaces). Cases named: the director of the ME, the ME communication and the School's student liaison reading the posts of associations but not the personal posts of students; a director of formations reading the associations of Saint-Etienne and Gardanne. Decisions: (1) a grid of checkboxes per person shaped like `/admin/spaces` (campus x formation, and whole campus); (2) it covers the posts of associations, lists AND institutions of the ticked spaces - an institution of ANOTHER campus too - with comments, reactions, events and agenda; (3) NEVER the personal posts of students; (4) readers may react and comment; (5) a global admin grants, the grant ADDS and never removes; (6) staff without a cursus see nothing more by default, the named ones do (closes the staff-feed question); (7) no end date, the list of named readers is internal (global admins only), and a journal keeps who granted what to whom and when. The user's "ISTP" is FSSS. Named readers only READ and react, and get NO notifications for their perimeter (answers of 2026-10-07). As built: WP-C above.
