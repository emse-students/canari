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

- **Access token**: JWT HS256, 15-minute TTL, stored in memory only (never localStorage).
- **Refresh token**: HttpOnly cookie, 7-day TTL, rotated on each use.
- **WebSocket auth**: cookie `canari_ws_token` carrying the access token.
- **Nginx verification**: `GET /api/auth/verify` injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` on success.

## Routes

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/oidc/callback` | none | Exchange Authentik auth code for JWT + refresh cookie; upsert local user |
| POST | `/api/auth/refresh` | cookie | Rotate refresh cookie, return new access token |
| POST | `/api/auth/logout` | cookie | Clear refresh cookie |
| GET | `/api/auth/verify` | Bearer | Validate JWT for Nginx auth_request |
| HEAD | `/api/auth/verify` | Bearer | Same as GET (Nginx HEAD probe) |

Dev only (disabled in production via `ENABLE_DEV_ROUTES=false`):

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/dev-login` | Instant login without OIDC (local dev) |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users/search?q=...` | JWT | Search users by id/displayName for autocomplete |
| GET | `/api/users/directory` | JWT | Paginated directory with filters (promo, formation, association) |
| GET | `/api/users/:id/avatar` | JWT | Fetch user avatar from external service |
| POST | `/api/users` | global admin | Create user manually |
| GET | `/api/users/me/notes` | JWT | Get caller's private notepad (Markdown) |
| PUT | `/api/users/me/notes` | JWT | Update caller's private notepad |
| GET | `/api/users/:id` | JWT | Get public profile (`me` resolves to caller) |
| PATCH | `/api/users/me` | JWT | Update caller's profile |
| DELETE | `/api/users/me` | JWT | Permanently delete account and all data across services |
| GET | `/api/users/admin/list` | global admin | List all users with admin status |
| PATCH | `/api/users/:id/admin` | global admin | Set/clear admin flag (cannot self-revoke) |

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
| `users` | `id` (OIDC sub), `displayName`, `promo`, `formation`, `bio`, `stripeCustomerId`, `admin` |
| `platform_config` | `maintenanceEnabled`, `maintenanceMessage`, `minClientVersion` |
| `notes` | `userId`, `content` (Markdown) |

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
| `ENABLE_DEV_ROUTES` | no | `true` enables dev-login (never in prod) |
