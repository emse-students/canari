## P2 - one tap from Canari signs the user into its MiConnect sites, and MiGallery's notifications go through Canari (owner, 2026-11-07: decided; Canari's half of the handoff built 2026-11-08, every site's flag OFF)

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

### 0. Where it stands (2026-11-08)

**Built, Canari's half of the handoff (H1, H2, H5 minus the push tap route).** What it does, and its
tests, are in [sessions](../sessions.md#the-sign-in-handoff-to-the-miconnect-sites-2026-11-08):
the mint `POST /api/auth/handoff`, the JWKS `GET /api/auth/handoff/jwks`, the registry
`libs/contracts/ecosystem-sites.json`, the vectors `libs/contracts/handoff-token.cases.json`
(written by `bun tools/handoff-vectors/generate.ts`), the one opener `openEcosystemSite`, and the
secret `HANDOFF_SIGNING_KEY` (the production secret was provisioned by the lead, with the owner's
approval, on 2026-11-08; PKCS#8 verified). **Every site's `handoff` flag is OFF**, so nothing
changes for a user.

**A site's flag goes on only when ALL of these hold** (security review of #3155, 2026-11-08; the
same list heads `libs/contracts/ecosystem-sites.json`):

1. **F3's access check runs at mint**: core-service asks MiConnect that the user is ACTIVE and that
   `check_access?for_user` passes on the target application, and mints nothing otherwise. Under F1
   alone (sub only) a handoff BYPASSES MiConnect's access decisions for every site - a deactivated
   account, Sky's ICM policy, any future D15 rule - so **F1 is never enough to turn a flag on**.
   MiGallery's flag stays OFF until the H0 check confirms the MiConnect reads (owner, 2026-11-08).
   **H0 ran on 2026-11-11: `check_access?for_user` honours `for_user` for a superuser only, so this
   condition cannot be met by a read-only account as written** - the measurement and the
   alternatives are [in section 9](#h0s-result-2026-11-11-read-only-on-the-running-authentik-202680---f3-as-designed-is-blocked).
2. **The site's provider `sub_mode` was read as `hashed_user_id`** on MiConnect (section 9), so the
   `sub` Canari signs is the `sub` the site keys its rows by.
3. **The site's redemption is live with the login-CSRF answers of section 3.7**: handoff sessions
   marked, every state-changing action behind a fresh MiConnect sign-in, and the interstitial
   always shown. **Sky and Le Cercle need the same review of their state-changing actions** (Sky's
   record linking and profile edits, Le Cercle's orders and membership) before their flags go on.

**Taken here as the reversible recommended options (lead's brief, 2026-11-08):**

- **The token carries `sub` only today (the F1 shape).** F3 adds the access check at mint (the
  condition above) and, later, `claims`, which is additive for a site that ignores an unknown member.
- **No migration on Canari.** The mint is stateless; single use is the site's ledger.
- **Only a token of a LIVE session mints**: a sid-less (legacy) access token, which names no
  session whose end could stop it, is refused (`auth.controller.handoff.spec.ts`).
- **`/mes-photos/confirmer` is OFF the dest allowlist.** Its only purpose is the "C'est moi"
  actions, which a handoff session must not perform without a fresh MiConnect sign-in (section
  3.7), so landing there signed in by a handoff buys nothing. A gallery push with faces to confirm
  lands on `/mes-photos` (section 5.4).
- **A rotation is a hard cut at Canari, NOT at the sites**: one variable, the
  [Keys](../sessions.md#keys) rule, but each site caches the JWKS. The JWKS answers
  `max-age=60`, each site sets `cacheMaxAge` to 60-120 s (section 8), so a rotated-out key stops
  verifying within two minutes; after a COMPROMISE the operator also restarts each site (or flushes
  its JWKS cache) right after the deploy, so the old key dies at once. Section 3.2's two-key
  rotation is superseded.
- **`not_yet_valid` is its own class** (an `iat` more than 30 s in the future), beside `expired` and
  `too_long` (section 3.6, step 3).
- **Dev mints nothing** (`DEV_HANDOFF_SIGNING_KEY` unset, manifest `silent`): a dev token is
  `wrong_issuer` at every production site, so the plain open is dev's configured state, said once at
  info (section 4).
- **On the web, a popup-blocked tab mints nothing** and the click is said at warn: replacing Canari's
  own tab would drop its socket and MLS state, which the launcher exists to avoid.
- **The interstitial consumes nothing**: the redemption answers `confirm` BEFORE the ledger insert,
  ALWAYS (a session or none, section 3.7), and the user's click sends the same token again
  (section 8).

**Not built yet:** H3 (the vendored verifier in `libs/`; the reference is `verifyHandoff` in
`handoff-redeem.contract.spec.ts`, and section 8 is the contract), the `/ecosystem/[site]` tap route
(it belongs with N1), and everything on a site (H4, H6, H7).

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
  allowlist of `dest` path patterns (MiGallery: `/`, `/mes-photos`, `/albums/<uuid>` -
  `/mes-photos/confirmer` was removed by the review of 2026-11-08, section 0; Sky and Le Cercle:
  `/`). **core-service composes the URL**
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
   `not_yet_valid`, `too_long`);
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

**An interstitial, ALWAYS, before anything is written** (amended by the review of 2026-11-08). If
the browser holds a live site session for a different `sub`, the redemption shows "Vous êtes
connecté en tant que A - continuer en tant que B ?". If it holds none, it shows "Vous allez être
connecté en tant que B", with B's name AND photo. Either way B's session opens only on a click, and
the token is consumed only then. This covers a Canari account switch, and it is half of the
login-CSRF answer of 3.7 - the other, decisive half being that a handoff session cannot perform a
state-changing action without a fresh MiConnect sign-in.

#### 3.7 Threats

| Threat | Answer |
| --- | --- |
| **Replay** | single use from the `jti` row; 60 s; the fragment is removed before the POST |
| **A link forwarded to someone else** | the token is minted per tap and redeemed by the browser it opens. The URL that remains in history no longer carries it (`replaceState`) and was consumed anyway. **Residual:** an address copied before the page loaded, used by someone else within 60 s, signs them in as the user. No binding to the opening browser is possible, because the system browser shares no secret with the app. This is accepted, and named here |
| **Open redirect** | Canari composes the URL from a closed registry, so no origin comes from input; `dest` is signed, matches an allowlist at mint, and is validated again by the site |
| **Phishing** | a token reaches only a registered origin. A phishing page cannot get one, because Canari never builds a URL from input, and a token stolen anyway is bound to one `aud` and expires in 60 s. The landing page loads no third-party script that could read the fragment |
| **CSRF on the redemption** | JSON with a same-origin `Origin` check. This stops a cross-site POST, and NOTHING more: the site's OWN landing page posts the token, so the check passes for any token that reaches it |
| **Login CSRF - the serious one** (review of 2026-11-08, High) | **The attack:** the attacker's server holds HIS Canari session and mints a fresh token on every visit (the throttle allows 20 a minute), then sends any visitor to `<site>/auth/handoff#<token>`. The landing page posts it, `Origin` passes, and a visitor with no site session is signed in AS THE ATTACKER. On MiGallery, a victim then invited to enrol their face (from `/mes-photos`, which Canari itself links) puts their biometric into the attacker's account. **The 60 s lifetime is no defence**: the token is minted per visit. **The answers, in order of weight:** **(a) decisive - a session opened by a handoff is MARKED** (a column on the site's session row), and every state-changing action that matters requires a FRESH MiConnect OIDC sign-in from such a session (a step-up that replaces the mark): on MiGallery the face enrolment, every consent or grant, and the `/mes-photos/confirmer` "C'est moi" actions. An attacker's account can be browsed into, never written to by the victim. **(b) the interstitial of 3.6, always**: "Vous allez être connecté en tant que B", with B's photo, before anything is written, even with no session. It warns, it does not prove: a victim may click through. **(c) recorded, not chosen: binding the token to the opening browser.** The site sets a nonce cookie and sends the browser through a Canari app link carrying the nonce, Canari mints with it, and the site redeems only a token whose nonce equals its cookie. It defeats the attack completely, at a UX cost: every open becomes a round trip site -> app -> browser, which on iOS and Android leaves the browser and comes back through the app's link handling, and fails where the app is not installed or the link is not claimed. Not chosen while (a) holds; it is the answer if a site cannot mark its sessions. **Sky and Le Cercle:** the same review of their state-changing actions is owed before their flags go on (section 0) |
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
- **The tap.** `deepLink` names an in-app route, `/ecosystem/migallery?dest=/mes-photos`, also when
  `toConfirm > 0`: `/mes-photos/confirmer` is off the handoff allowlist (section 0), because its "C'est
  moi" actions need a fresh MiConnect sign-in from a handoff session anyway. The route mints (3.3)
  and opens. The push opens
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
| H0 | Canari (read-only) | **Spike:** the three Authentik API calls of 3.4 on the running version, with a read-only service account, and **each site provider's `sub_mode`, read and recorded as `hashed_user_id`** (section 9) before that site's flag can go on. **The lead creates the account through the MiConnect admin API, with the owner's agreement, and tells the owner when it is done (E)** | a written result here: F3 or F1 |
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

### 8. The contract MiGallery implements (WP-H4)

**Everything Canari owes is in place; this is what MiGallery builds, exactly.** Sky and Le Cercle
implement the same contract with their own admission (section 4). The reference for steps 1-5 is
`verifyHandoff` in `apps/core-service/src/auth/handoff/handoff-redeem.contract.spec.ts`.

**Configuration: two variables, the same names on all three sites.**

| Variable | Production value | What it is |
| --- | --- | --- |
| `CANARI_HANDOFF_ISSUER` | the origin of production's `FRONTEND_URL` first entry (the lead reads it on the estate before setting it) | the ONE issuer accepted; a dev token is `wrong_issuer` |
| `CANARI_HANDOFF_JWKS` | `<issuer>/api/auth/handoff/jwks` | the public keys, through `jose`'s `createRemoteJWKSet(url, { cacheMaxAge: 60_000 })` - 60 to 120 s, never jose's 10-minute default, so a rotated-out key stops verifying within two minutes (the JWKS itself answers `max-age=60`); an unknown `kid` refetches |

The audience is a constant in MiGallery's code, `migallery`, never a variable.

**After a key COMPROMISE** (not an ordinary rotation): the operator rotates `HANDOFF_SIGNING_KEY`,
deploys Canari, then restarts MiGallery's process (or flushes its JWKS cache) at once, so the
compromised key stops verifying immediately rather than within `cacheMaxAge`.

**The ledger** (SQLite, one table, created like every other MiGallery table):

```sql
CREATE TABLE IF NOT EXISTS handoff_redemptions (
  jti         TEXT PRIMARY KEY,
  sub         TEXT NOT NULL,
  exp         INTEGER NOT NULL,   -- seconds since the epoch, from the token
  redeemed_at INTEGER NOT NULL
);
```

Purged by a proof, not a timer: at each redemption,
`DELETE FROM handoff_redemptions WHERE exp < :now - 30`. A row past that bound protects nothing,
because step 1 refuses its token as `expired` first.

**1. `GET /auth/handoff`, the landing page.** Served with `Referrer-Policy: no-referrer`,
`Cache-Control: no-store`, and no third-party script. Its script, before anything else:

```js
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname); // the token leaves the address bar at once
```

then `POST /api/auth/handoff` (same origin, `credentials: 'same-origin'`) with `{ "token": token }`,
and it acts on the answer:

| Answer | The page does |
| --- | --- |
| `200 { "outcome": "ok", "dest": "/mes-photos" }` | `location.replace(dest)` |
| `200 { "outcome": "confirm", "current": "<A's name or null>", "next": { "name": "<B's name>", "photo": "<B's avatar URL on MiGallery>" } }` | the interstitial, ALWAYS: with `current`, "Vous êtes connecté en tant que A - continuer en tant que B ?"; without, "Vous allez être connecté en tant que B", B's photo beside the name. **Continuer** sends `{ "token": token, "confirm": true }` again (the token held in the page's memory only); **Annuler** goes to `/` and writes nothing |
| `200 { "outcome": "unknown_user", "dest": "/mes-photos" }` | the ordinary OIDC login with `redirectTo=dest` (an honest first visit) |
| `4xx { "outcome": "<class>" }` | the ordinary OIDC login, no `redirectTo` |
| an empty fragment | the ordinary OIDC login |

**2. `POST /api/auth/handoff`, the redemption.** In this order, each step ending in the outcome
named and logged `[HANDOFF] refused class=<outcome> jti=<jti or none>` - **never the token**:

0. `Origin` exactly MiGallery's own origin, else `403 { outcome: "bad_origin" }`;
   `Content-Type: application/json`, else `415`; a body `{ token: string (<= 4096 characters),
   confirm?: boolean }`, else `400 { outcome: "invalid" }`.
1. `jwtVerify(token, JWKS, { algorithms: ['ES256'], typ: 'canari-handoff+jwt', issuer, audience:
   'migallery', clockTolerance: 30, requiredClaims: ['sub', 'jti', 'iat', 'exp', 'dest'] })`.
   **Classify by the error's CLASS and its `claim` field, never its message** (the repository
   rule): `JWTExpired` -> `expired`; `JWTClaimValidationFailed` with `claim === 'iss'` ->
   `wrong_issuer`, with `claim === 'aud'` -> `wrong_audience`; every other failure (signature,
   `alg`, `typ`, an unknown `kid`, a malformed token, a missing claim) -> `invalid`. All `400`.
2. On the verified payload: every claim of its type (`dest` a string, `iat` and `exp` numbers),
   else `invalid`; `iat > now + 30` -> `not_yet_valid`; `exp - iat > 60` -> `too_long`.
3. `dest` through `safeRedirectTarget` (`src/lib/auth-redirect.ts`), else `bad_dest`.
4. **No `confirm: true` -> the interstitial, ALWAYS** (a live session of another user or none at
   all): `200 { outcome: "confirm", current, next }`, `next` read from the `users` row of `sub`
   (name and photo; an unknown `sub` answers `unknown_user` here instead, step 6). **Nothing is
   written**: the token is not consumed, so the click redeems it within its lifetime (past it, step 1
   says `expired` and the page goes to the login). A live session of the SAME user skips the
   interstitial: nothing changes hands.
5. **Single use:** `INSERT OR IGNORE INTO handoff_redemptions (jti, sub, exp, redeemed_at)`; no row
   inserted -> `409 { outcome: "replayed" }`, logged at WARN. The insert is the decision: nothing
   reads first and writes afterwards.
6. **Admission (F1):** the `users` row whose id is `sub`. None -> `200 { outcome: "unknown_user",
   dest }`, and the page sends the user through OIDC. **F1 writes nothing on the row.** Under F3
   this step becomes the half of the OIDC callback after the claims (`handleUserInDatabase` with the
   token's `claims`, nulls cleared), extracted so both paths call one function.
7. **The ordinary session, MARKED**: made by the same function the OIDC callback uses (one
   `sessions` row, 7 days, the `migallery_session` cookie with its usual attributes) with one
   difference, a column `via_handoff = 1` on the row (an additive column, default 0). A replaced
   session of another user is deleted first. `200 { outcome: "ok", dest }`, logged
   `[HANDOFF] redeemed jti=<jti> sub=<sub>`.

**The step-up - the decisive answer to login CSRF (section 3.7).** A session whose row says
`via_handoff = 1` may browse, and may NOT perform, until the user has signed in through MiConnect
in this browser: **the face enrolment (selfie), every consent or its withdrawal, every grant or
share, and the `/mes-photos/confirmer` "C'est moi" / "Ce n'est pas moi" actions.** Each such route
checks the mark server-side and answers `403 { code: "STEP_UP_REQUIRED" }`; the page then sends the
user through the ordinary OIDC login with `redirectTo` = the page. The OIDC callback writes a new
session WITHOUT the mark (and deletes the marked one), so after one MiConnect sign-in the user acts
normally. Victim and attacker therefore cannot be confused where it matters: MiConnect itself names
who is signing in. The list of guarded routes is enumerated in MiGallery's code, and a test fails if
a state-changing route under `/api` is neither on it nor explicitly exempted (a read-only route, a
logout).

**What it must not do:** take the token from a query string or a GET; log it; create a new kind of
session (the mark is a column of the ordinary one); skip the interstitial; let a marked session
past a guarded route.

**Its tests (H4's gate):** every case of `libs/contracts/handoff-token.cases.json` through steps
1-3, with `createLocalJWKSet(vectors.jwks)` and jose's `currentDate` set to the case's `now`,
answering `expect` (`bad_dest` is `safeRedirectTarget` refusing `//evil.example/x`); the `replay`
sequence against one ledger -> `ok`, then `replayed`; a wrong `Origin` -> `bad_origin`; NO session
-> `confirm` and no ledger row, then `confirm: true` -> `ok`; a live session of another `sub` -> the
same; an unknown `sub` -> `unknown_user`; the session opened carries `via_handoff = 1`; every guarded
route answers `STEP_UP_REQUIRED` to a marked session and works after an OIDC sign-in; the
guarded-route enumeration test; the token in no log line (asserted on the captured logger). The
vectors are COPIED from Canari and regenerated only there.

**Then Canari turns the flag on**, and only when the three conditions of section 0 hold (F3's access
check at mint, `sub_mode` read as `hashed_user_id`, this redemption live with the mark, the step-up
and the interstitial): `"handoff": true` for `migallery` in `libs/contracts/ecosystem-sites.json` and
its two copies (`handoff-sites.ts`, `ecosystemSites.ts`), in a Canari release made after MiGallery's
is live; then the phone readings of section 6.

### 9. The read-only MiConnect service account (WP-H0) - for the lead to create

**The code that ships today (sub only) reads nothing from MiConnect, and that is exactly why no
flag may go on yet** (section 0): without the access check below, a handoff bypasses MiConnect's
own decisions. **F3's first two reads are therefore the condition for EVERY site's flag**, the
third (claims) follows. The account is read by **core-service at mint time**, never by a site, and
its token would be a NEW
secret (`MICONNECT_READER_TOKEN`, production only like `MICONNECT_EDITOR_TOKEN`; not introduced until
F3 is built). It is a different account from `miconnect-canari-editor` (WP4), which may write.

**The three reads, and why each:**

| Read | Authentik API | Why |
| --- | --- | --- |
| who the user is at MiConnect, and whether they are still active | `GET /api/v3/core/users/?uuid=<users.miconnect_uuid>` -> `pk`, `is_active` | the user API cannot filter on the hashed `sub` ([profiles-and-access](../profiles-and-access.md#four-facts-the-plan-is-shaped-by)) and Canari holds the user's Authentik uuid; a deactivated account mints nothing |
| whether MiConnect lets this user into the target application | `GET /api/v3/core/applications/<slug>/check_access/?for_user=<pk>` -> `{ passing, messages }` | MiConnect's policy bindings decide who enters (D15, Sky's ICM rule); a refusal mints nothing, as the OIDC flow would have refused |
| the claims that site's own property mappings compute for this user | `GET /api/v3/providers/oauth2/<provider pk>/preview_user/?for_user=<pk>` -> `{ preview: { ... } }` | fresh claims without Canari duplicating any mapping (the reason F2 was rejected) |
| **once per site, before its flag goes on** (H0): the provider's subject mode | `GET /api/v3/providers/oauth2/<provider pk>/` -> `sub_mode` | must read `hashed_user_id`, the mode Canari's `users.id` is ([profiles-and-access](../profiles-and-access.md#four-facts-the-plan-is-shaped-by)); any other mode means the site keys its rows by another `sub` and Canari's token would name nobody there, or the wrong person. Recorded here per site |

**The permissions, all read-only, as one RBAC role on the service account:**

- `authentik_core.view_user` - the user lookup, and the `for_user` argument of the two other reads;
- `authentik_core.view_application`, on the three applications (MiGallery, Sky, Le Cercle) only -
  `check_access`;
- `authentik_providers_oauth2.view_oauth2provider`, on their three OAuth2 providers only, and
  `authentik_core.preview_user` - `preview_user`.

**Nothing else:** no `add_*`, `change_*` or `delete_*`, no token, flow or event access, no other
application or provider. The exact codenames, and whether `check_access?for_user` and
`preview_user` exist on the RUNNING version, are what H0 verifies first, read-only. If the user
lookup or `check_access` is missing, **no flag goes on** and this section records why; if only
`preview_user` is missing, the access check ships without claims (the site keeps its own row, F1's
admission) and this section records that.

#### H0's result (2026-11-11, read-only, on the running authentik 2026.8.0) - F3 AS DESIGNED IS BLOCKED

Read in the running server's own source and through read-only ORM queries; **nothing was created**
(no account, role or token), because the second read cannot be made by a read-only account.

| Read | On 2026.8.0 | Usable by a read-only account? |
| --- | --- | --- |
| user by `uuid` | `core/api/users.py`: a `UUIDFilter` on `uuid` | **yes**, with `view_user` |
| `check_access?for_user` | `core/api/applications.py`, `check_access`: `for_user` is honoured **only when the caller `is_superuser`**; for anyone else it is silently IGNORED and the policy engine runs for the CALLER | **no** - a non-superuser gets the service account's own answer, a silent wrong answer, and a superuser token is the opposite of read-only |
| `preview_user` | `providers/oauth2/api/providers.py`: `view_oauth2provider` on the provider + `authentik_core.preview_user` on the user | **yes** |
| `sub_mode` | read from each provider row | **`hashed_user_id` on all three**: `miconnect-migallery`, `miconnect-sky`, `miconnect-cercle` (and on every other production provider) |

**What decides access today, measured.** The three production applications (`migallery`, `sky`,
`cercle`) have **zero enabled policy bindings** (engine mode `any`), and the tenant flag
`core_default_app_access` (`AppAccessWithoutBindings`) is **`True`**. So MiConnect's only decision
for these three today is "the account exists and is active"; Sky's ICM rule lives in Sky's own code
(`callback/+server.ts`, `gateHandler`), not in MiConnect. The policy `test` endpoint
(`policies/api/policies.py`) runs ONE policy, not an application's engine (bindings to groups and
users, negation, mode, the empty-result flag), so evaluating it from Canari would duplicate
MiConnect's decision - rejected for the reason F2 was.

**Condition 1 of section 0 therefore cannot be met as written**, and no flag goes on. The
alternatives, for the lead/owner to choose (not taken here):

- **F3-bound (recommended):** read-only account with `view_user`, `view_application` and
  `authentik_policies.view_policybinding` on the three applications. At mint: the user by uuid must
  be `is_active`; the target application must have **zero enabled bindings** and
  `core_default_app_access` must be `True` - exactly the inputs from which `check_access` would
  answer `passing` - else refuse (`policy_bound`, fail-closed). A binding added later turns the
  handoff OFF for that site until authentik honours `for_user` for a non-superuser. Same answer as
  OIDC today, no duplicated policy logic, no superuser.
- **A superuser service account:** rejected - it can write everything.
- **Wait for upstream:** no date.
