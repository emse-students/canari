## P2 - one tap from Canari signs the user into its MiConnect sites, and MiGallery's notifications go through Canari (owner, 2026-11-07: decided, designed, not built)

**The owner's decisions of 2026-11-07, recorded as decided.**

- **A. No separate MiGallery app.** MiGallery tells Canari when a member has new photos, Canari sends
  the push, and a tap opens MiGallery from Canari. The former open question about a MiGallery
  application is settled by this decision: **no app; MiGallery's notifications go through Canari.**
  `open-questions.md` now points here.
- **B. A one-time sign-in handoff.** When Canari, already signed in, opens a site, it passes a
  single-use token that lives for seconds, and the site redeems it to sign the user straight in.
  This replaces a MiConnect prompt in the browser: the browser's MiConnect cookie expires, and a
  native app cannot put a cookie into Safari or Chrome.
- **B is generalised (owner follow-up, 2026-11-07).** It is one mechanism for **every site Canari
  opens that signs in through MiConnect**: one token format whose audience is the target site, one
  minting endpoint, and one verification contract that each site adopts. **Every other site is out
  of scope and is opened plainly, as it is today.**

**The owner's answers of 2026-11-07 to the four questions of section 7, recorded as decided.**

- **C. The gallery notification is OFF by default**: the member opts in. (Section 5.4's "ships ON" is
  superseded; the category's default is disabled and the settings screen offers it.)
- **D. It is sent ONLY to devices on content-free push (wake)**, so the notification waits for
  WP-W4/W5. A full-mode device receives none: nothing leaks to Google or Apple in the meantime.
- **E. The read-only MiConnect service account** (H0) is created by the lead through the MiConnect
  admin API, with the owner's agreement, and the owner is told when it is done.
- **F. NO "announce this album" action, ever.** Phase 2 is removed from this design.
- **G. The handoff covers only the sites Canari opens that sign in through MiConnect** (as B says):
  every other site is opened plainly.

Everything below is design. File:line references are against `main` on 2026-11-07. Sibling
repositories are named relative to this one (`../MiGallery`, `../Sky`, `../le-cercle`,
`../refonte-portail-etu`).

### 1. Which sites are in scope, and how Canari opens them today

**In scope: Canari opens it AND it signs in through MiConnect.**

| Site | Where Canari opens it | How it opens |
| --- | --- | --- |
| MiGallery (`gallery.mitv.fr`) | the app launcher, `frontend/src/lib/navigation/ecosystemSites.ts:27-32`; the "change profile photo" button, `frontend/src/routes/profile/(me)/+page.svelte:18-21` (to `/mes-photos`) | the launcher draws plain anchors (`EcosystemLauncher.svelte:13-27`: "every link opens a new tab"). On Tauri the global capture handler sends the click to `openExternal` (`frontend/src/lib/utils/openExternal.ts:72-77`), which calls `@tauri-apps/plugin-opener`'s `openUrl` (`:101-103`): **the system default browser, not an in-app tab**. On the web it is a new tab (`:105`). The profile button uses `navigateExternal` (`:117-124`): the system browser on Tauri, and on the web **it replaces Canari's own tab** (`:122`), which the launcher's comment calls the thing to avoid |
| Le Cercle (`cercle.emse.fr`) | the launcher, `ecosystemSites.ts:33-38` | as above |
| Sky (`sky.emse.fr`) | the launcher, `ecosystemSites.ts:39-44` | as above |

**The in-app tab exists, and only sign-in uses it.** `tauri-plugin-customtabs` backs Canari's own
OIDC sign-in and its MiConnect end-session (`frontend/src/lib/stores/auth.ts:594`): an
`ASWebAuthenticationSession` on iOS that shares Safari's cookie jar
(`frontend/src-tauri/plugins/tauri-plugin-customtabs/ios/Sources/CustomTabsPlugin.swift:83-104`,
`prefersEphemeralWebBrowserSession = false` at `:104`), a Custom Tab on Android
([auth](../frontend/modules/auth.md), the sign-out table). The launcher never uses it.

**Opened plainly, out of scope:** Portail-etu (`ecosystemSites.ts:45-50`; it has no sign-in at all,
[profiles-and-access](../profiles-and-access.md) section 1), payment checkouts, calendar
exports, store and release pages, links inside messages and posts, legal links, and a MiGallery
album link inside a message (`frontend/src/lib/utils/ecosystemHosts.ts:55-66` only previews it).
The last one is excluded deliberately, see section 3.7.

### 2. How the three sites authenticate today

**All three are OIDC clients of the same MiConnect, and they key a person by the same OIDC `sub`.**
Canari's `users.id` IS the MiConnect `sub` ([auth](../frontend/modules/auth.md), "the id
guarantee"). The ids already agree across the sites in production: Canari asks MiGallery for
`/api/users/<Canari user id>/avatar` (`apps/core-service/src/users/avatar.service.ts:245`), and
Le Cercle asks Canari for `cotisant-status?sub=<uuid>` (`../le-cercle/docs/wiki/canari-integration.md:21`).
**No site maps by email.**

| | MiGallery | Sky | Le Cercle |
| --- | --- | --- | --- |
| Sign-in | `GET /api/auth/login`, then `/api/auth/callback`: `completeOIDCFlow` (`../MiGallery/src/lib/auth.ts:377`) exchanges the code, reads userinfo, and writes the row with `handleUserInDatabase` (`:269`), **nulls included** | `auth/login`, then `auth/callback`: **the ICM gate** (`../Sky/src/routes/auth/callback/+server.ts:65-74`), then `resolveLogin`, which may answer `choice` and send the user to `/auth/link` (`:89-103`) | `routes/auth/callback/+page.server.ts`: verifies the ID token against the remote JWKS with `jose` (`../le-cercle/src/lib/server/auth/authentik/index.ts:180-191`), with **four REQUIRED claims** (`:161`), then `upsertUser` (`:97`) and `syncCanariMembership` (`:108`) |
| Session | an opaque token in `migallery_session`, one row in `sessions`, **7 days** (`../MiGallery/src/lib/db/sessions.ts:19`, `:57`), `sameSite=lax` (`src/lib/session.ts:29-33`) | opaque `sky_session`, one row, **7 days**, `sameSite=lax` (`../Sky/docs/wiki/authentication.md`, Sessions) | a **5-minute** signed JWT in a cookie plus an **8-hour** row, rotated in SQL (`../le-cercle/docs/wiki/authentication.md`, The session) |
| Logout | deletes the row, then the cookie (`../MiGallery/src/routes/api/auth/logout/+server.ts:16-36`); MiConnect untouched | deletes the row; MiConnect untouched | revokes the row |
| Return path | `safeRedirectTarget` (`../MiGallery/src/lib/auth-redirect.ts:33`), pinned by `tests/auth-redirect.test.ts` | always `/` | always `/` |

**Why the user is asked again.** Canari's own session renews itself for as long as the app is used
(7-day refresh, `apps/core-service/src/auth/auth.controller.ts:235`) and **Canari never re-reads
MiConnect after the first sign-in** ([profiles-and-access](../profiles-and-access.md#four-facts-the-plan-is-shaped-by),
"Canari never re-reads Authentik"). The site's cookie lasts 7 days at most (8 hours for Le Cercle),
and the browser's MiConnect cookie expires on its own clock. So a user who lives in Canari meets a
MiConnect prompt every time they open a site they have not opened in a week, and the native app has
no way to refresh either cookie.

### 3. The handoff protocol

#### 3.1 Recommendation, against the alternative

**Recommended: the signed handoff token.** The alternative is to open each site through an OIDC
authorization request in an in-app tab (`ASWebAuthenticationSession` / Custom Tab) that shares
MiConnect's cookie. It loses on three counts:

1. **It fails exactly where the complaint is.** It works only while MiConnect's own cookie is alive,
   and the complaint is that it is not. Canari's session outlives MiConnect's by design (section 2),
   so only Canari's session can vouch for the user at that moment.
2. **On iOS there is no in-app browsing tab that shares a cookie with Safari.**
   `ASWebAuthenticationSession` is a sign-in sheet that ends on a callback scheme. It is not a place
   to browse a gallery, and nothing reopens it later. `SFSafariViewController` has had its own
   cookie jar since iOS 11. MiGallery would end up in a sheet that cannot be found again.
3. **The handoff works in whatever browser the system opens**, the default one included when it is
   not Safari or Chrome, and the site's own 7-day cookie then lives there for the next visit.

**What the OIDC route had that the handoff must rebuild:** MiConnect is the source of each site's
claims, and MiConnect decides who may enter each application (D15,
[profiles-and-access](../profiles-and-access.md)). A token signed by Canari bypasses both unless
the design carries them. Section 3.4 does that.

#### 3.2 The token

A compact JWS, minted by **core-service** (Canari's auth service). The precedent in the same
controller is the Adminer session: an authenticated call buys a short credential for a navigation
that carries no bearer (`auth.controller.ts:1253-1276`, `adminer-access.service.ts`).

```
header  { "alg": "ES256", "typ": "canari-handoff+jwt", "kid": "<RFC 7638 thumbprint>" }
payload { "iss": "https://canari.emse.fr",       // the estate that minted it
          "aud": "migallery" | "sky" | "le-cercle",
          "sub": "<MiConnect sub>",
          "jti": "<128 random bits, base64url>",  // the nonce, and the single-use key
          "iat": <s>, "exp": <iat + 60>,
          "dest": "/mes-photos",                   // a path on the audience, never a URL
          "claims": { ... } }                      // section 3.4
```

- **Asymmetric, so a site can verify and never mint.** ES256 (P-256). `jsonwebtoken`, which
  core-service already uses, signs it, and `jose`, which Le Cercle already uses, verifies it. It is
  a NEW key, `HANDOFF_SIGNING_KEY` (core-service only; `infrastructure/MIGRATION.md` and the env
  manifest). Never `JWT_SECRET`, which signs Canari's access tokens with HS256
  (`auth.controller.ts:434`): an explicit `typ` and a separate key keep a handoff token from ever
  being taken for an access token, or the reverse (RFC 8725).
- **Key distribution: one JWKS**, `GET /api/auth/handoff/jwks` on core-service, public and
  cacheable. Each site holds the issuer and the JWKS URL in two variables and fetches the keys with
  `jose`'s `createRemoteJWKSet`, as Le Cercle already does for MiConnect. An unknown `kid` triggers
  a refetch. So a rotation is one step: publish the new key beside the old one, then remove the old
  one once a token's 60 s and the cache have passed. There is no "previous key" variable (Le Cercle
  rejected one for the same reason: `../le-cercle/docs/wiki/authentication.md`, "Why there is no
  second signing key").
- **The estates do not cross.** Dev mints under `https://dev.canari-emse.fr` with its own key.
  A production site trusts exactly one issuer, so a dev token is `wrong_issuer` there.
- **The audience registry is server-side and closed.** It lists the three sites: id, origin, and an
  allowlist of `dest` path patterns (MiGallery: `/`, `/mes-photos`, `/mes-photos/confirmer`,
  `/albums/<uuid>`; Sky and Le Cercle: `/`). **core-service composes the URL**
  (`<origin>/auth/handoff#<token>`) and the client never supplies an origin. That is what keeps the
  endpoint from becoming an open redirect, and keeps a token from being sent anywhere else. The
  addresses move into a contract file (`libs/contracts/ecosystem-sites.json`) that
  `ecosystemSites.ts` and the registry both read. Today `ecosystemSites.ts:16` claims to be the only
  place they are written, and a second copy on the server would break that claim.

#### 3.3 Minting

`POST /api/auth/handoff { aud, dest }` -> `{ url }`, on core-service:

- requires a live access token (`requireAccessToken`, `auth.controller.ts:421`). Since 2026-10-25 an
  access token lives no longer than its session row ([sessions](../sessions.md)), so a revoked
  Canari session mints nothing;
- refuses an `aud` outside the registry or a `dest` outside its allowlist, each with a typed
  refusal;
- is throttled per account (`AccountThrottlerGuard`);
- writes one audit line, `[HANDOFF] minted aud=<site> user=<sub> jti=<jti>`. **The token itself is
  never logged**, in Canari or on a site.

#### 3.4 Claims, and who may enter: MiConnect still decides

The site must not lose what OIDC gave it. Three options:

- **F2 - the token carries Canari's copy of the claims. Rejected.** Canari never re-reads MiConnect
  after the first sign-in, and MiGallery opens albums by formation AND promo and clears a missing
  claim (`../MiGallery/docs/wiki/authentication.md:61-70`). A stale Canari copy would reopen a
  promo's albums that MiConnect had closed.
- **F3 - recommended: core-service asks MiConnect at mint time** with a read-only service account.
  First, the application's access check for this user and the target application. A refusal mints
  nothing, so Sky's ICM rule and every future D15 policy are MiConnect's answer, as with OIDC.
  Second, the target provider's own claim preview for this user, so the claims are computed by
  **that site's property mappings** and no mapping is duplicated in Canari. The result goes into
  `claims`, and the site applies it through **its unchanged OIDC write path**
  (`handleUserInDatabase`, `upsertUser`, `refreshPersonIdentity`). Nulls are cleared exactly as on
  an OIDC login. A deactivated MiConnect account is refused at this step too.
- **F1 - the fallback if F3's spike fails: `sub` only.** The site attaches a session to its
  EXISTING row and writes nothing. A `sub` it has never seen goes to its ordinary OIDC login with
  `dest` (an honest first visit, not a pretend). The cost is that a claim changed in MiConnect
  reaches the site only at its next OIDC sign-in, which the handoff may postpone indefinitely, and
  D15 policies would be enforced only by each site's own copy of them (Sky's ICM gate at
  `callback/+server.ts:70`).

**F3 depends on Authentik API calls that this design has not yet verified on the running version.**
WP-H0 is a read-only spike that settles them: look up a user by `uid`, the application's access
check `for_user`, and the OAuth2 provider's user preview. If one is missing, F1 ships and this
paragraph records why.

#### 3.5 How the token travels: the fragment

`https://<site>/auth/handoff#<token>`. **A fragment is never sent to a server.** It stays out of
access logs, the edge's logs and every `Referer`. A query string would land in all three. So
redemption takes two steps on the site:

1. **`/auth/handoff`, a landing page with no third-party script**, served with
   `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. It reads `location.hash`, removes
   it at once with `history.replaceState` (a reload, the back button or a copied address bar then
   carries no token), and POSTs `{ token }` to the redemption route;
2. **`POST /api/auth/handoff`**, same origin, `Content-Type: application/json`, and **an `Origin`
   header equal to the site's own origin** or a refusal. A cross-site form cannot send JSON without
   a preflight, and the Origin check closes what remains. It answers `{ dest }` and the page
   navigates there.

**How Canari opens it.** Tauri: `openUrl` to the system browser, as the launcher does today. Web:
the Adminer pattern (`frontend/src/lib/admin/adminerSession.ts:55-75`), which opens `about:blank`
during the click itself so no popup blocker drops it, cuts `opener`, then points the tab at the
URL. On the web this also fixes the profile button's replacement of Canari's own tab.

#### 3.6 Redemption, single use, and the session it opens

The verification contract, in this order. Each step ends in a typed outcome, logged with its class
and never the token:

1. parse; `typ` = `canari-handoff+jwt`; `alg` in `{ES256}`, so `none` and HS256 are refused
   (algorithm confusion); `kid` in the JWKS; signature (`invalid`);
2. `iss` = the one configured issuer (`wrong_issuer`); `aud` = the site's own id (`wrong_audience`);
3. `exp` not past, `iat` not in the future, each with 30 s of leeway for clock skew; **`exp - iat`
   no more than 60**, so even a signed token with a longer lifetime is refused (`expired`,
   `too_long`);
4. `dest` passes the site's own redirect validator (MiGallery's `safeRedirectTarget`), even though
   Canari signed it (`bad_dest`);
5. **single use, from durable state:** `INSERT INTO handoff_redemptions (jti, sub, exp)`, where
   `jti` is the primary key. If no row is inserted, the token was already redeemed, so the result
   is `replayed`, at warn. The insert is the decision; nothing reads first and writes afterwards
   ([sessions](../sessions.md), "Settle the race in SQL");
6. the site's own admission, through **the same function its OIDC callback calls after the claims**.
   Each site extracts that half of its callback so the two paths cannot drift. This gives Sky's ICM
   gate and record linking (`choice` -> `/auth/link`), Le Cercle's required claims and its Canari
   membership sync, and MiGallery's row write;
7. **the ordinary session of that site**, with its usual lifetime and cookie. The handoff creates no
   new kind of session.

**The ledger is purged by a proof, not a timer.** A row whose `exp` is more than the leeway in the
past can go: step 3 refuses its token before it can reach step 5, so deleting the row cannot let
the token back in. Only the token's validity bound involves a clock, as for any credential. Whether
a token has been used is answered by the row alone.

**A browser already signed in as someone else.** If the browser holds a live site session for a
different `sub`, the redemption does **not** replace it silently. It shows "Vous êtes connecté en
tant que A - continuer en tant que B ?" and opens B's session only on a click. This covers a Canari
account switch, and it blocks the login-CSRF in 3.7 whenever a session exists. When no session
exists, the site shows the new session's name, which the site headers already do.

#### 3.7 Threats

| Threat | Answer |
| --- | --- |
| **Replay** | single use from the `jti` row; 60 s; the fragment is removed before the POST |
| **A link forwarded to someone else** | the token is minted per tap and redeemed by the browser it opens. The URL that remains in history no longer carries it (`replaceState`) and was consumed anyway. **Residual:** an address copied before the page loaded, used by someone else within 60 s, signs them in as the user. No binding to the opening browser is possible, because the system browser shares no secret with the app. This is accepted, and named here |
| **Open redirect** | Canari composes the URL from a closed registry, so no origin comes from input; `dest` is signed, matches an allowlist at mint, and is validated again by the site |
| **Phishing** | a token reaches only a registered origin. A phishing page cannot get one, because Canari never builds a URL from input, and a token stolen anyway is bound to one `aud` and expires in 60 s. The landing page loads no third-party script that could read the fragment |
| **CSRF on the redemption** | JSON with a same-origin `Origin` check. **Login CSRF** (an attacker mints a token for HIS account and gets a victim to open it, so the victim's acts, a selfie enrolment for example, land in the attacker's account) needs the victim to open it within 60 s. It is blocked by the confirmation above when the victim has a session, and remains possible when they have none, as with any bearer link. MiGallery's selfie enrolment already requires an explicit ticked agreement and shows whose account it is |
| **Links inside messages** | **never handed off.** Otherwise a link a stranger wrote would decide which path the victim's own signed-in session opens, and would extend any GET with side effects on that site to users whose cookie had expired. Only Canari's own buttons (the launcher, the profile photo, a push tap) mint |
| **Minting abuse** | an access token is required, the account is throttled, every mint is logged, and `aud` and `dest` come from closed lists |

#### 3.8 Logout

**The sessions stay independent, as they are under OIDC today.** A site's logout deletes its row
(MiGallery `logout/+server.ts:16-36`). Canari's sign-out ends Canari and MiConnect
([sessions](../sessions.md#what-a-cookie-is-and-is-not)) and does not reach into a site, exactly as
today. The only new behaviour: after a site logout, the next tap in Canari signs the user in again,
because the tap is an explicit request to open the site as the Canari account. No back-channel
logout is designed. Its cost (a revocation fan-out to three sites) would buy nothing OIDC gives
today.

### 4. What each site needs to adopt it, and what makes each one hard

**One verifier, three copies.** `handoff-verify.ts` (it depends on `jose`) and the landing page live
in Canari under `libs/` as the source, together with the vectors
`libs/contracts/handoff-token.cases.json`. The vectors cover a valid token, expired, `too_long`,
wrong `iss`, wrong `aud`, wrong `typ`, `alg: none`, an HS256 token signed with the public key, a bad
`dest`, and a replay. Each site vendors the verifier **byte-identically** and runs the vectors in its
own tests. **WP-H-ADOPT-<site>** is the per-site package: the `handoff_redemptions` table, the
landing page, the redemption route, the callback split (step 6), the confirmation screen, and two
environment variables (`CANARI_HANDOFF_ISSUER`, `CANARI_HANDOFF_JWKS`).

| Site | What is hard |
| --- | --- |
| **MiGallery** | **The site that matters most, and the one with the most at stake.** Album access is keyed on promo and formation with nulls cleared, so F1's stale rows are a real defect here (F3 exists because of this). It holds face data: the confirmation in 3.6, and the face routes refusing an impersonated session, must hold for a handoff session too. It runs on MiTV's machine, not the school host, so it reaches the JWKS over the public internet; it already does the same for MiConnect. It is SQLite (`bun:sqlite`), so the ledger is one table. Its `__oidc_return` mechanism (`authentication.md:19-32`) already proves the destination logic |
| **Sky** | **The callback is the gate.** The ICM rule (`callback/+server.ts:65-74`) and record linking (`:89-103`, with a 15-minute pending cookie) sit inline in the callback, so the split in step 6 is real work there. A `choice` must lead to `/auth/link` exactly as after OIDC. Under F1, a `sub` not yet linked to a `people` record cannot be handed off and goes to OIDC. Sky has no `jose` yet (one dependency). `gateHandler` (`src/hooks.server.ts:93`) re-checks ICM on every request, so a handoff session is bounded by it as well |
| **Le Cercle** | **The least code: it already verifies a JWT against a remote JWKS with `jose`** (`authentik/index.ts:180-191`). **The hardest to keep identical:** it is on the school's GitLab, and `tools/ecosystem-shape/shape.mjs` (claim 6, byte-identical shared files) reads only the four GitHub repositories, so drift in its copy is caught only by its own vector test. Its four claims are REQUIRED (`:161`), so a staff account is refused by the handoff exactly as by OIDC, and under F1 the existing row must already satisfy them. Its sessions last 8 hours, so it is the site that benefits most |

**Each site is enabled in Canari only after its release is live:** a `handoff: true` flag per site
in `ecosystem-sites.json`. Before that, Canari would land a token on a `/auth/handoff` that answers
404. A site without the flag is opened plainly, which is today's behaviour, not a fallback.

**A refused mint opens the site plainly**, and that IS a fallback. It is logged at warn with the
refusal's class and counted. On dev, where no audience is configured, the plain open is the
configured state and is logged once at info.

### 5. The notification path

#### 5.1 What MiGallery can actually know

- **"New photos of you": yes**, from the match engine. A member's photos are their visible matches
  (`auto`, or confirmed by them: `VISIBLE_MATCH_SQL` in `../MiGallery/src/lib/server/face-photos.ts`,
  [option C](https://github.com/emse-students/MiGallery/blob/main/docs/wiki/face-matching-option-c.md)
  A6). The engine also knows **faces waiting for the member's answer** (`suggested`). Both exist only
  for members with an open face consent.
- **"Photos added to an album you follow": not today.** MiGallery has no album follow. Its
  favourites are per photo (`user_favorites`, `../MiGallery/src/lib/db/schema.sql:68`), and an
  album has no "published" moment, only a creation and a visibility
  (`../MiGallery/docs/wiki/albums-and-permissions.md`). Inferring "new album for your promo" from
  uploads would send a push per upload burst to hundreds of people. **No album notification exists
  or will** (decision F): there is no "announce this album" action.

So v1 has **one kind: `gallery_new_photos`** (n new photos, m to confirm), for consenting members.

#### 5.2 MiGallery tells Canari: a service-to-service call

**MiGallery pushes and Canari does not poll.** Polling would mean Canari asking about every user,
and only MiGallery knows when a pass ended.

- **The route:** `POST /api/external/gallery/notices` on **social-service**, beside the push content
  keys and `PushService.notifyContent` (`apps/social-service/src/push/push.service.ts:33-43`). It
  needs one exact-path nginx location: `/api/external` today goes to core-service
  (`infrastructure/local/Dockerfile.frontend:1190-1198`) and strips the trust headers.
- **Auth: a per-caller key, `MIGALLERY_NOTICE_KEY`,** in `x-api-key`, compared in constant time as
  in `apps/core-service/src/external/external.controller.ts:59-70`, but **not** the shared
  `EXTERNAL_API_KEY` (Sky's). One key per caller makes revoking one caller one step. It is the
  reverse of `MIGALLERY_API_KEY`, which Canari presents to MiGallery
  (`infrastructure/docker-compose.prod.yml:269-270`).
- **The body:** `{ idempotencyKey, kind: "gallery_new_photos", recipients: [{ sub, newPhotos, toConfirm }] }`.
  It holds **counts only: no asset id, no album, no face** (section 5.5).

#### 5.3 Batching and deduplication: one push per batch, never one per photo

**On MiGallery, three durable facts:**

1. **`face_notice_ledger (user_id, asset_id)`** records the photos already announced to a member.
   A batch is `visible matches - ledger`. It is keyed by asset rather than by match row, because the
   engine re-decides faces and replaces holder rows (`recordDecisions`, A4), so a key on the row
   would announce the same photo twice;
2. **a batch closes at the first ingestion tick whose pass found nothing new to process**. That is
   the end of an import, shown by an empty pass rather than guessed by a quiet-period timer. The
   worker ticks every 10 minutes (A3), so a batch waits at most one extra tick. One import of one
   event produces one push per member;
3. **an outbox row per closed batch**, written in the same transaction as the ledger rows, sent
   until a 2xx arrives. Its `idempotencyKey` is `<batch id>`, so a retry after a lost answer is the
   same notice.

**On Canari:** `external_notice_receipts (source, idempotency_key)` as the primary key, inserted
before any push. A conflict means "already delivered": the route answers 200 and sends nothing. The
push also carries a `collapseKey` (`gallery`, a field the push envelope already has,
[content-free-push](../protocols/content-free-push.md#32-everything-sent-through-sendpushtouser---no-durable-row-exists-so-one-is-written)),
so an unread earlier notice is replaced on the device rather than stacked.

#### 5.4 The opt-out, and older clients

- **A new category, `gallery`**, in `apps/chat-delivery-service/src/services/push-category.ts:12-36`
  and its frontend mirror (the contract test pins the two together), with `gallery_new_photos` ->
  `gallery` in `CATEGORY_BY_CONTENT_KEY` (`:48`). The stored value is the set of DISABLED categories
  (`notification-preference.entity.ts:14-25`), and **the owner decided this category is OFF by
  default (C)**: it needs a way to be default-disabled (an opt-in category) rather than the
  opt-out the other categories use, so the member turns it on.
- **A client older than the switch cannot draw it** (`push-category.ts:78-79` explains why existing
  kinds reuse an existing id). So a gallery notice is sent only to devices at or above the release
  that carries both the switch and the tap route, using the `minAppVersion` floor `sendPushToUser`
  already honours.
- **The tap.** `deepLink` names an in-app route, `/ecosystem/migallery?dest=/mes-photos` (or
  `/mes-photos/confirmer` when `toConfirm > 0`). The route mints (3.3) and opens. The push opens
  Canari, and Canari opens MiGallery, signed in.

#### 5.5 Content-free push, and privacy - **for the owner**

- **Content-free push compatibility is free by construction.** The notice goes through
  `notifyContent` -> `sendPushToUser`, so in wake mode it becomes an envelope like every social push
  (option A,
  [content-free-push](../protocols/content-free-push.md#32-everything-sent-through-sendpushtouser---no-durable-row-exists-so-one-is-written)).
  The text is composed on the device from `contentKey` and the counts (Paraglide, both languages),
  and no French sentence is composed on the server.
- **In full mode the push itself is the leak.** Until a device is on the envelope, Google or Apple
  would read `contentKey = gallery_new_photos` and the counts. Since only a face match produces that
  key, this tells them that **face recognition matched this person in N new photos**, which is a
  fact derived from Art. 9 processing. **Decided (D, owner, 2026-11-07): send this kind only to devices
  that receive the wake** (`push_mode = wake` and envelope version 2, WP-W4). The feature waits
  for content-free push on Android and iOS; the leak is not accepted in the meantime.
- **Two things change a processing purpose, and the register, the privacy policy and MiGallery's
  terms must change together:**
  1. **a new recipient and a new use of the match result.** MiGallery (MiTV, its controller) sends
     Canari the fact "this member has n new photos of them". The DPIA's stated purpose is "let a
     member find the event photographs they appear in"
     ([dpia-migallery-faces](../compliance/dpia-migallery-faces.md) section 1). Notifying them
     through another service is a new use and a transfer to another controller's system. Register
     rows G2-G3 ([register-of-processing](../compliance/register-of-processing.md#4-migallery-controller-mitv)),
     Canari's own rows and recipients (section 8, and Google and Apple while in full mode), the
     privacy policy, and MiGallery's `/cgu` (a new terms version) all change;
  2. **`face_notice_ledger` is new data derived from matching.** It belongs in the member's erasure
     transaction (withdrawal and account deletion, A5) and in the DPIA's data and retention rows.
  **The owner decided it is an opt-in (C).** MiGallery sends a notice only for a member whose face
  consent is open AND who has turned the category on.

### 6. Work packages, in order

| # | Repo | Package | Gate that proves it |
| --- | --- | --- | --- |
| H0 | Canari (read-only) | **Spike:** the three Authentik API calls of 3.4 on the running version, with a read-only service account. **The lead creates the account through the MiConnect admin API, with the owner's agreement, and tells the owner when it is done (E)** | a written result here: F3 or F1 |
| H1 | Canari | `libs/contracts/handoff-token.cases.json` (the vectors of section 4) and `libs/contracts/ecosystem-sites.json` (ids, origins, `dest` allowlists, `handoff` flag); `ecosystemSites.ts` reads it | contract tests in core-service and the frontend that read the same file |
| H2 | Canari core-service | the mint (3.3), the JWKS, `HANDOFF_SIGNING_KEY` (+ `MIGRATION.md`, env manifest), F3's MiConnect read | unit tests: every vector minted or refused as written; a revoked session mints nothing; an `aud` or `dest` outside the registry is refused; the token never appears in a log line (assert on the captured logger) |
| H3 | Canari `libs/` | `handoff-verify.ts` and the landing page, the source copies; `shape.mjs` claim 6 extended to them for the GitHub repositories | the vectors pass against the module; `bun tools/ecosystem-shape/shape.mjs` exits 0 |
| H4 | MiGallery | WP-H-ADOPT-migallery (section 4) | the vectors; replay -> `replayed`; a wrong `Origin` -> refused; `dest` through `safeRedirectTarget` (its existing refusal list); a live session for another `sub` -> the confirmation; F3 claims go through `handleUserInDatabase` with nulls cleared (extend `tests/sso-mirror.test.ts`) |
| H5 | Canari frontend | **one opener**, `openEcosystemSite(id, dest)`: mint, then `openUrl` (Tauri) or the Adminer pattern (web); the launcher and the profile button go through it; the `/ecosystem/[site]` tap route; MiGallery's flag ON | unit tests: a flagged site mints, an unflagged one opens plainly, a refused mint opens plainly with a warn; a test that fails if a registered origin is opened anywhere but through the opener |
| H6 | Sky | WP-H-ADOPT-sky: the callback split first, then the handoff | the vectors; a non-ICM account is refused by both paths through the one function; `choice` -> `/auth/link` |
| H7 | Le Cercle (GitLab) | WP-H-ADOPT-le-cercle | the vectors in its own CI; a staff account is refused by both paths |
| N1 | Canari social-service + chat-delivery | the receiver (5.2), receipts (a migration), `gallery_new_photos`, the `gallery` category with its mirror, the `minAppVersion` floor, wake-only delivery (5.5), the nginx location, Paraglide strings | integration tests: the same key twice -> one push; an unknown `sub` -> counted and no push; category off -> no push; a full-mode device -> no push |
| C1 | Canari (wiki) + MiGallery | **the owner's:** the register, the privacy policy, MiGallery's `/cgu` and the DPIA rows of 5.5, **before N2's switch** | the owner's sign-off, recorded here |
| N2 | MiGallery | ledger, batch close, outbox, sender behind `CANARI_NOTICES_ENABLED` (OFF), the ledger in the erasure transaction, the counts in the hourly report | tests: a two-tick import -> one outbox row; a re-decided face is not announced twice; withdrawal deletes the ledger rows; a retried send reuses its key |

**What a phone reading must confirm (Mi 9T and iPhone 12, on dev first and then production):**

1. With MiGallery's and MiConnect's cookies cleared in the system browser, the launcher lands
   **signed in** on MiGallery, and the profile button on `/mes-photos`, with no MiConnect prompt.
   On iOS this is read in the default browser.
2. Reloading the landing page, or going back to it, shows no token in the address bar and redeems
   nothing. The site log shows exactly one `redeemed` for that `jti`.
3. A second redemption of a captured token is refused `replayed` (by curl against dev).
4. A MiGallery batch spanning two ticks produces **one** push on each phone. A tap opens Canari,
   then MiGallery signed in on the right page. With the category off: no push.
5. A Canari account switch, then the launcher: the "continuer en tant que" screen.
6. Sky with a non-ICM test account is refused as after OIDC. Le Cercle with an account missing a
   required claim is refused as after OIDC.

### 7. The questions that were the owner's - all answered on 2026-11-07

1. Face notice default: **OFF, opt-in** (C). The register, policy and terms update still comes before
   N2 in any case.
2. Delivery: **only to devices on content-free push** (D), so after WP-W4/W5.
3. The read-only MiConnect service account: **created by the lead via the MiConnect admin API, the
   owner told** (E).
4. Album announcements: **never** (F).

Reversible choices taken as recommended unless the owner says otherwise: ES256 and a JWKS; 60 s;
the fragment; the confirmation before a session for another `sub` is replaced; no handoff from
links inside content; social-service as the receiver; one key per caller.
