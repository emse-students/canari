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
  `FORMATIONS` (frontend) and the enrolment prompt of `20-enrollment.yaml` (authentik); core-service
  stores a formation as free text and needs no change.
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

**Answered while writing the plan (second round, same day).**

- **D29 - WP0 builds a keyless avatar URL FIRST**, then switches MinoWiki and Archives to it, then
  revokes the key - no avatar is lost, and the key stays exposed until then.
- **D30 - The agenda stays PUBLIC, per space**: each open space has its own anonymous feed and
  `.ics`, as today's single feed.
- **D31 - A personal post inherits its AUTHOR's spaces**; someone with no space (a staff post only)
  cannot publish one, and publishes through an institution instead.
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
  the reader belongs to.
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
(D33)**: there is ONE School, which may share with one campus or the other, and TWO MEs (one per campus). Nothing reads these tables until 6b.

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

**Post-level targeting (asked 2026-10-04, built with the 6b composer picker):** a post's "Audience" menu in the advanced settings starts from its association's reach and may narrow it; on top of REACH (where) sit FILTERS (who, among those reached): promo (from the profile's cursus) and contributor status of the PUBLISHING association. Filters only narrow, so they cannot step over the ceiling; the server evaluates them and the author sees a count, never a list.

**The `isBDE` toggle on `/admin/associations` still exists and still drives every BDE check**: 6c moves
those checks onto the space's BDE and deletes the column, so until then the two say the same thing only
because the seed made them agree. Seen in a browser on a throwaway estate; the unit tests cover the
service (9) and the pair logic (5), and CI boots the real module.

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
