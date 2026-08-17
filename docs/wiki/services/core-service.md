# core-service

**Stack**: NestJS  
**Port**: 3012  
**Source**: `apps/core-service/`

## Responsibilities

The core-service is the authentication and user management hub. It:

- Implements OIDC login via Authentik (code exchange, JWT issuance, refresh rotation).
- Validates JWT tokens for Nginx `auth_request` (`GET /api/auth/verify`).
- Manages user profiles, search, and directory.
- Handles Stripe payments (Stripe Connect onboarding for associations, checkout sessions, saved cards, webhooks).
- Exposes platform configuration (maintenance mode, minimum client version).

## Auth model

- **Access token**: JWT HS256, 1-hour TTL, stateless, stored in memory only (never localStorage).
- **Refresh token**: HttpOnly cookie, 7-day idle TTL, **backed by a row in `auth_sessions`** and
  rotated on each use.
- **WebSocket auth**: cookie `canari_ws_token` carrying the access token.
- **Nginx verification**: `GET /api/auth/verify` injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` on success.

### Sessions (`auth_sessions`)

One row per long-lived login — one browser, one phone, one desktop app. The row is what makes
revocation possible at all: before it existed the refresh token was a self-describing 7-day bearer
credential, `logout` only cleared the cookie (revoking nothing), a stolen cookie minted a fresh
7 days on every use in parallel with the real user, and the single lever available was rotating
`JWT_SECRET` — which signs every user out of all six services at once.

**The access token deliberately stays stateless.** Making it a row would add a database round trip
to every service *and* to the nginx `auth_request`. So the row backs the **refresh** token, and the
consequence is stated rather than hidden: revoking a session stops it renewing itself immediately,
but an access token already handed out keeps working until it expires (≤ 1 h). The settings UI says
so in as many words.

**The row also names the MLS device it belongs to** (`deviceId`, nullable), written once per app
start after the client unlocks MLS — the first moment it can say which device it is. It is the only
join between a login, which lives here, and a device, which lives in the delivery service; without it
the security settings could list both and never say which row on one was which row on the other.
Binding also enforces **at most one live session per device**: see
[sessions](../sessions.md#one-session-per-device-enforced-where-the-device-becomes-known) for why a
second claim is unreachable by construction, and why the login endpoint cannot be the place that
supersedes it.

The refresh JWT carries two new claims:

| Claim | Meaning |
|---|---|
| `sid` | The session row. Stable for the life of the login. |
| `jti` | The **only** refresh token that row currently accepts. Rotated on every refresh. |

Verifying the signature is therefore no longer enough to be let in — the token must also name a
live session **and** be the one that session expects.

#### Replay detection, and the grace window that keeps it honest

A `jti` that is neither current nor freshly rotated has already been spent, which means the cookie
exists in two places. The session is **destroyed**, not merely refused: logging the event and
letting the rotation proceed (what Le Cercle does) hands the rotation to whoever presented the
token, so the theft succeeds and the alarm is decorative.

That rule cannot be applied naively. Two tabs of the same browser share one cookie, so a
double refresh is routine: exactly one wins, and the loser presents a token one generation old
through no fault of anyone. `previousTokenId` + `rotatedAt` keep the replaced token acceptable for
`ROTATION_GRACE_SECONDS` (60 s), during which the server hands back the **current** token without
rotating again. Only a token older than that, or reused after the window, counts as theft.

The rotation itself is a single conditional `UPDATE ... WHERE "tokenId" = :presented`, so the race
is settled by the database rather than by a read-then-write in the service.

#### Adopting pre-WP-SESS-2 tokens

A refresh token issued before this table existed carries no `sid`. Refusing it would sign every
logged-in user out on the deploy, so `POST /api/auth/refresh` opens a session for it instead. The
branch grants nothing new — the token is still signature-valid and unexpired, i.e. worth exactly
what it was worth the day before — and no legacy token can exist more than one refresh TTL (7 days)
after the release. **Safe to delete after 2026-08-12.**

#### A refresh token is not an access token

Both are signed with the same key, so a refresh token verifies anywhere an access token is checked.
Two explicit `type === 'refresh'` guards stop it being spent as one: in `/api/auth/verify` (which
would otherwise hand a 7-day credential the reach of a 1-hour one) and in the session-management
routes.

Those routes authenticate their caller from the Bearer token **in the controller**, not through
`NginxAuthGuard`: nginx serves `/api/auth` unauthenticated and deliberately blanks `X-User-Id`
there, so the guard would refuse every request. The refresh cookie rides along too (its path is
`/api/auth`) and is read for one purpose only — flagging which row is the caller's own.

## Routes

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/oidc/callback` | none | Exchange Authentik auth code for JWT + refresh cookie; upsert local user |
| POST | `/api/auth/refresh` | cookie | Rotate the session's `jti`, return a new access token; revokes the session on a replay |
| POST | `/api/auth/logout` | cookie | Delete the session row, then clear the cookie |
| GET | `/api/auth/sessions` | Bearer (+ cookie) | List the caller's live sessions, flagging the current one and naming each one's device |
| PUT | `/api/auth/sessions/current/device` | Bearer (+ cookie) | Bind the calling session to an MLS device, destroying any other session claiming it |
| DELETE | `/api/auth/sessions` | Bearer (+ cookie) | Revoke every session except the current one |
| DELETE | `/api/auth/sessions/:id` | Bearer | Revoke one of the caller's sessions (scoped to the caller) |
| GET | `/api/auth/verify` | Bearer | Validate JWT for Nginx auth_request |
| HEAD | `/api/auth/verify` | Bearer | Same as GET (Nginx HEAD probe) |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users/search?q=...` | JWT | Search users by id/displayName for autocomplete |
| GET | `/api/users/directory` | JWT | Paginated directory with filters (promo, formation, association) |
| GET | `/api/users/:id/avatar` | JWT | Proxy the user's MiGallery photo ([three outcomes](#the-avatar-proxy)) |
| POST | `/api/users` | global admin | Create user manually |
| GET | `/api/users/me/notes` | JWT | Get caller's notepad ciphertext (+ `legacyNotes` once, pre-encryption) |
| PUT | `/api/users/me/notes` | JWT | Store caller's notepad ciphertext; clears the legacy plaintext |
| GET | `/api/users/me/notes-key` | JWT | Caller's notepad key (32 bytes hex), generated on first use |
| GET | `/api/users/:id` | JWT | Get public profile (`me` resolves to caller) |
| PATCH | `/api/users/me` | JWT | Update caller's profile |
| DELETE | `/api/users/me` | JWT | Permanently delete account and all data across services |
| GET | `/api/users/admin/list` | global admin | List all users with admin status |
| PATCH | `/api/users/:id/admin` | global admin | Set/clear admin flag (cannot self-revoke) |

#### The avatar proxy

`avatar.service.ts` fetches `gallery.mitv.fr/api/users/<id>/avatar` with `x-api-key` and answers one
of **three** outcomes. The distinction exists for one reason: **only an ANSWER may be cached.**

| outcome | when | response | cached |
| --- | --- | --- | --- |
| `image` | upstream 200 | the bytes, upstream `Content-Type` | 1 h in process, 24 h in the browser |
| `absent` | upstream **404** - this user has no photo | `404`, no body | 10 min in process, 10 min in the browser |
| `unavailable` | timeout, transport failure, upstream 5xx/429, our key refused, or no key configured | `502`, no body, `Cache-Control: no-store` | never, at any layer |

- **The budget is 4 000 ms**, the number Le Cercle justified for the same endpoint. The four proxies
  of this one URL state the same budget rather than each inventing one.
- **An absence is the common case, not the edge one** (the campaign's two accounts measure 40/40
  upstream 404s), and it used to be re-asked on every render of every face, for ever. That is the
  amplification that turns one transient network fault into a burst of 502s instead of one line -
  measured on the portal as 479 recorded 502s from a single outbound failure.
- **`unavailable` is never disguised as a 404.** A 404 says "this user has no photo", which we do not
  know; and being cached, the lie would outlive the outage. This is the link-preview defect
  ([backlog](../backlog.md)) in another service, and it is refused here by construction.
- **An upstream 401/403 never reaches the browser as a 401.** This service's credentials are not the
  user's, and a 401 crossing that boundary is how an unrelated upstream fault becomes a logout. It is
  the one cause logged at `error` - a human must rotate a key - while a transient blip is a `warn`.
- **No response carries a body except the image.** A JSON error body on a request an `<img>` made is
  what produced three console lines per benign miss: `404`, then `ERR_BLOCKED_BY_ORB` (Chrome
  refusing a JSON body to an image destination), then `ERR_ABORTED`.

The client half is `frontend/src/lib/utils/userAvatarCache.ts`, and it answers a KIND rather than a
nullable URL: `blob` (bytes held locally), `direct` (nothing cached, let the element fetch it), or
`none` (the server answered and there is nothing to draw). `none` is what stops the second request -
the element used to be handed back the same URL and ask the server again for the answer just given.
`direct` is what keeps the native clients working, where the API is a different origin and `fetch`
can be refused while an `<img>` is not.

##### One lifetime, and the server states it (2026-08-17)

**The `max-age` above is honoured by the browser's HTTP cache and by nothing else.** The client used
to copy every avatar into a Cache Storage bucket (`canari-user-avatars-v1`) keyed by
`/api/users/<id>/avatar`, and **Cache Storage ignores `Cache-Control` entirely** - it is a plain
key/value store, and `cache.match()` performs no freshness check. So the 24 h the server sends
governed a cache that was never consulted again, and the first photo a device ever drew for a face
was the photo it kept for ever; the only eviction was the Settings "clear media cache" button. One
person therefore had one face per device, indefinitely - reported, and not reproducible by whoever
had only ever drawn them once.

- **A KEY NAMING A CONTENT MAY BE CACHED FOR EVER; A KEY NAMING AN IDENTITY MAY NOT.** This URL
  names a person and the photo behind it is MiGallery's to change. The same test tells the two other
  buckets apart: `mediaBlobCache` (an encrypted media id) and `associationLogoCache`
  (`/api/media/public/<mediaId>?v=<updatedAt>`, a NEW id on every upload) are content-addressed and
  were right to keep theirs.
- The module now holds a blob only for the mounts currently displaying that face, so a directory
  listing the same person twenty times costs **one** request and one decode. Requests in flight are
  coalesced, which the HTTP cache cannot do for itself.
- **The retired bucket is deleted at start-up** (`purgeRetiredAvatarCache`, called from the root
  layout). It is idempotent by construction: the absence of the bucket IS the durable state, so no
  flag records that it ran.
- **The native notification paths were never affected** and needed no change: Android
  (`CanariFirebaseMessagingService.kt`, `AVATAR_CACHE_MAX_AGE_MS`) and iOS
  (`NotificationService.swift`, `fetchAvatar`) both cache the face on disk with an explicit 24 h
  age check, matching this endpoint's `max-age`.
- Guarded by `userAvatarCache.test.ts`: reintroducing any store without an expiry makes "asks the
  server again for a face nothing is displaying any more" fail - verified by reintroducing one.

`chat-delivery-service` re-exposes the same image at `/api/mls/push/avatar/:targetUserId` for the
Android background service, and forwards core's status unchanged.

#### Name search (search + directory)

Both `/users/search` (autocomplete, top 10) and the name query of `/users/directory` share one
matcher (`applyFuzzyNameSearch` in `users/userSearch.ts`), so they behave identically:

- **Accent- and case-insensitive** via the `unaccent` extension.
- **Word-order-insensitive**: the query is split into whitespace terms AND-ed together, each matching
  anywhere in the display name (so "dupont jean" finds "Jean Dupont").
- **Typo-tolerant**: a term of >= 3 chars matches either as a substring OR by trigram
  `word_similarity` (>= 0.4) via the `pg_trgm` extension, so a single-character typo still finds the
  person. Terms of 1-2 chars match by substring only (too few trigrams to be meaningful).
- **Relevance-ranked**: results are ordered by a `search_score` (exact whole-query substring boost +
  trigram `similarity` of the whole name), closest first, then alphabetically. The directory keeps
  its alphabetical order when browsing by filters only (no name query).

Both `unaccent` and `pg_trgm` are enabled on boot in `UsersService.onModuleInit`.

### Platform admin

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users/admin/platform` | global admin | Get platform config (maintenance, min version) |
| PATCH | `/api/users/admin/platform` | global admin | Update platform config |
| GET | `/api/version` | none | Latest app version + platform gates |

### Payments (Stripe)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/payments/onboarding` | JWT | Start/resume Stripe Connect onboarding for an association |
| GET | `/api/payments/connect-status/:associationId` | JWT | Live Connect status, syncs DB on success |
| POST | `/api/payments/connect-dashboard-link/:associationId` | JWT | Single-use Stripe Dashboard login link |
| POST | `/api/payments/create-checkout-session` | JWT | Create Stripe Checkout session |
| POST | `/api/payments/verify-session` | JWT | Verify completed checkout, mark form submission paid |
| POST | `/api/payments/cancel-session` | JWT | Cancel unpaid checkout |
| POST | `/api/payments/setup-payment-method` | JWT | Create setup session to save a card |
| GET | `/api/payments/payment-methods` | JWT | List saved cards |
| DELETE | `/api/payments/payment-methods/:id` | JWT | Detach payment method |
| POST | `/api/payments/charge-saved-method` | JWT | Charge saved card for form submission |
| POST | `/api/payments/charge-product-saved-method` | JWT | Charge saved card for boutique product |
| POST | `/api/payments/internal/customer-id` | InternalSecret | Get/create Stripe customer (called by social-service) |
| POST | `/api/payments/webhook` | Stripe signature | Stripe webhook handler (`checkout.session.*`, `payment_intent.*`, `account.updated`) |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Root hello-world (basic health check) |

## Database

PostgreSQL (`auth_db`). Main tables:

| Table | Key columns |
|---|---|
| `users` | `id` (OIDC sub), `displayName`, `promo`, `formation`, `bio`, `stripeCustomerId`, `admin`, `notesCiphertext`, `notesKey`, `notes` (legacy) |
| `auth_sessions` | `id` (= `sid`), `userId` (FK CASCADE), `tokenId` (= current `jti`), `previousTokenId`, `rotatedAt`, `createdAt`, `lastUsedAt`, `expiresAt`, `userAgent`, `lastIp`, `deviceId` |
| `platform_config` | `maintenanceEnabled`, `maintenanceMessage`, `minClientVersion` |

`auth_sessions` rows are swept hourly, and any row past `expiresAt` is refused before it is swept —
the sweep is housekeeping, never a security boundary. `userAgent` and `lastIp` exist so the owner
can recognise a session that is not theirs; they are shown to nobody else, never used for
authorization, and die with the row. The IP is taken from the **last** `X-Forwarded-For` entry, not
the first: nginx appends the connecting address to whatever the client sent, so the head of that
list is attacker-controlled and only the tail is what nginx actually saw.

### Personal notepad

Stored as opaque AES-256-GCM ciphertext (base64) under a per-user key, the same envelope an
association's `notesCiphertext` uses — `encryptVaultNote`/`decryptVaultNote` are shared, not copied.
The key lives in `users.notesKey`, is generated on first use and is served only to its owner, so a
database dump alone cannot read a notepad.

Deliberately **not** zero-knowledge: the key is chosen so a forgotten PIN, a new device or a
reinstall never costs the user their notes. The service can decrypt if it decides to; the threat
this addresses is a readable database, not a hostile operator.

`users.notes` held the old plaintext and is kept only as a one-shot migration path: the server hands
it back as `legacyNotes` while no ciphertext exists, the client re-saves it encrypted, and the save
nulls the column. Only the client can encrypt, so the conversion cannot happen in SQL.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `AUTHENTIK_CLIENT_ID` | yes | OIDC client ID |
| `AUTHENTIK_CLIENT_SECRET` | yes | OIDC client secret |
| `AUTHENTIK_ISSUER` | yes | Authentik issuer URL |
| `FRONTEND_URL` | yes | OIDC redirect URI base |
| `STRIPE_SECRET_KEY` | no | Stripe secret key (payments) |
| `STRIPE_WEBHOOK_SECRET` | no | Stripe webhook signing secret |
| `INTERNAL_SECRET` | yes | Shared secret for service-to-service calls |
