# Core Service

NestJS microservice for authentication, user management, and Stripe payments. Runs on port **3012**.

## Domains

### Authentication (OIDC)

Handles the full OIDC login flow via Authentik:

- **Code exchange**: `POST /api/auth/oidc/callback` — exchanges Authentik authorization code for JWT access token + HttpOnly refresh cookie. Upserts the local user on first login.
- **Refresh rotation**: `POST /api/auth/refresh` — issues a new access token and rotates the refresh cookie.
- **Logout**: `POST /api/auth/logout` — clears the refresh cookie.
- **Nginx verification**: `GET /api/auth/verify` — validates the JWT Bearer token for Nginx `auth_request`. Injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers on success.
- **Dev login**: `POST /api/auth/dev-login` — instant login without OIDC, disabled in production via `ENABLE_DEV_ROUTES=false`.

**Token model**:

| Token | Location | TTL | Rotation |
|---|---|---|---|
| Access token | In-memory only (never localStorage) | 15 minutes | — |
| Refresh token | HttpOnly cookie | 7 days | Rotated on each use |
| WebSocket auth | Cookie `canari_ws_token` | 15 minutes | — |

All tokens use JWT HS256 signed with a shared `JWT_SECRET`.

### Users

User profiles, search, and directory:

- **Profile**: public profile with `displayName`, `promo`, `formation`, `bio`, avatar. `GET /api/users/:id` (use `me` for caller).
- **Edit profile**: `PATCH /api/users/me`.
- **Account deletion**: `DELETE /api/users/me` — permanently deletes the account and all data across all services.
- **Avatar**: fetched from an external service, proxied through `GET /api/users/:id/avatar`.
- **Private notepad**: Markdown notes per user (`GET/PUT /api/users/me/notes`).
- **Search**: `GET /api/users/search?q=...` — autocomplete, accent- and case-insensitive, typo-tolerant via `pg_trgm` trigram similarity.
- **Directory**: `GET /api/users/directory` — paginated, filterable by promo, formation, association. Reuses the same fuzzy name search as the autocomplete endpoint.
- **Admin list**: `GET /api/users/admin/list` — all users with their admin status.
- **Admin toggle**: `PATCH /api/users/:id/admin` — set or clear the global admin flag (cannot self-revoke).

Both `unaccent` and `pg_trgm` PostgreSQL extensions are enabled on boot.

### Platform admin

Global platform configuration:

- **Get config**: `GET /api/users/admin/platform` — maintenance mode, minimum client version.
- **Update config**: `PATCH /api/users/admin/platform` — set maintenance message, toggle maintenance, bump minimum version.
- **Version endpoint**: `GET /api/version` — public, returns the latest app version and platform gates (used by clients for forced-update checks).

### Payments (Stripe)

Manages Stripe Connect for associations, Checkout sessions, and saved payment methods:

- **Connect onboarding**: `POST /api/payments/onboarding` — start or resume Stripe Connect onboarding for an association. Returns an account link URL.
- **Connect status**: `GET /api/payments/connect-status/:associationId` — live Connect status, syncs the database on successful onboarding.
- **Dashboard link**: `POST /api/payments/connect-dashboard-link/:associationId` — single-use Stripe Dashboard login link.
- **Checkout**: `POST /api/payments/create-checkout-session` — create a Stripe Checkout session for a product or form submission.
- **Session verification**: `POST /api/payments/verify-session` — verify completed checkout and mark form submission as paid.
- **Cancel session**: `POST /api/payments/cancel-session` — cancel an unpaid checkout.
- **Saved cards**: setup (`POST /api/payments/setup-payment-method`), list (`GET /api/payments/payment-methods`), detach (`DELETE`).
- **Charge saved card**: for form submissions (`POST /api/payments/charge-saved-method`) or boutique products (`POST /api/payments/charge-product-saved-method`).
- **Internal API**: `POST /api/payments/internal/customer-id` — get or create a Stripe customer, called by social-service with `InternalSecret`.
- **Webhooks**: `POST /api/payments/webhook` — handles `checkout.session.*`, `payment_intent.*`, and `account.updated` events from Stripe.

### Health

- `GET /` — basic health check (returns "Hello World!").

## Database

| Store | Purpose |
|---|---|
| PostgreSQL (`auth_db`) | Users, platform config, user notes |

Main tables:

| Table | Key columns |
|---|---|
| `users` | `id` (OIDC sub), `displayName`, `promo`, `formation`, `bio`, `stripeCustomerId`, `admin` |
| `platform_config` | `maintenanceEnabled`, `maintenanceMessage`, `minClientVersion` |
| `notes` | `userId`, `content` (Markdown) |

Migrations live in `src/migrations/` and are run automatically by TypeORM on startup.

## Startup

```bash
cd apps/core-service
npm run start:dev
```

Requires a running PostgreSQL instance, Authentik OIDC provider, and Stripe (optional, for payments).

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
| `ENABLE_DEV_ROUTES` | no | Set `true` to enable dev-login (never in production) |

## See also

- [Wiki: core-service](../../docs/wiki/services/core-service.md) — Full API table, auth model, name search algorithm
- [Wiki: Authentik (OIDC)](../../docs/wiki/infrastructure/authentik.md) — Identity provider setup
- [Wiki: Architecture](../../docs/wiki/architecture.md) — Service topology and Nginx routing
- [Wiki: Payments module](../../docs/wiki/frontend/modules/payments.md) — Frontend payment flow
