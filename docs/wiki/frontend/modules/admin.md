# Admin module

**Routes**: `src/routes/admin/`  
**Components**: `src/lib/components/moderation/`

## Responsibilities

- Platform configuration (maintenance mode, minimum client version).
- Content moderation (post reports).
- User management (global admin only).

## Access control

All admin routes check `isGlobalAdmin()` (derived from `X-Global-Admin` header injected by Nginx). Non-admins are redirected to `/admin` (or `/`) immediately.

## Routes

| Route | Description |
|---|---|
| `/admin` | Admin dashboard (overview) |
| `/admin/platform` | Platform configuration |
| `/admin/moderation` | Content moderation queue |
| `/admin/users` | User list with admin flag management |
| `/admin/cercle` | Cercle (`balance_topup`) products, per beneficiary association |

## Cercle top-ups (`/admin/cercle`)

The Cercle recharge is configured here, not in an association's boutique. The page is a
beneficiary-association selector (Le Cercle preselected by slug) over **one** `balance_topup`
product: amount bounds, webhook URL, webhook secret. It is not a product catalogue - a recharge
exists once per beneficiary, so the shape is imposed rather than offered: the buyer picks the
amount (`allowCustomAmount`, no fixed price) and the server forces `allowRepeatPurchase` with both
purchase caps cleared, a top-up being repeatable by nature and impossible to exhaust. Failed
webhook deliveries are listed below, each retryable **or deletable** - deletion is for a top-up
already settled by hand on the Cercle side, where a retry would credit it twice. Creating or
updating a `balance_topup` product requires a **global admin** - enforced server-side in
`products.service.ts` (D7), not merely by this route's `isGlobalAdmin()` guard. See
[Cotisations](../../cotisations.md) for the product model.

Each product also carries a **test button** (`simulateCercleTopup`): it credits 5 EUR to the
pressing admin's own Cercle account through the production path with no Stripe charge, and shows
what the dispatcher recorded (delivered / failed, attempt count, the `pi_canari_test_…` intent). A
failed test lands in the retry list on the same page. The rules it does and does not reproduce are
in [Cotisations](../../cotisations.md#outbound-canari---cercle-balance_topup-webhook); the operational
runbook is `docs/PROD-TEST-CERCLE.md` (step V5).

## Platform configuration (`/admin/platform`)

Fetches and updates `GET/PATCH /api/users/admin/platform`:

| Setting | Description |
|---|---|
| `maintenanceEnabled` | Show maintenance gate to all non-admin users |
| `maintenanceMessage` | Custom message shown during maintenance |
| `minClientVersion` | Minimum app version; older clients see an upgrade prompt |

On save, the frontend also triggers `refreshAppVersionCheck()` to apply the new version gate without reload.

## Moderation

The moderation queue lists reported posts. Moderators can:
- View report details (reporter, reason, content).
- Remove the post (`DELETE /api/posts/:postId`).
- Dismiss the report (no action).

## User management

Global admins can list all users (`GET /api/users/admin/list`) and toggle admin status (`PATCH /api/users/:id/admin`). An admin cannot revoke their own admin flag.
