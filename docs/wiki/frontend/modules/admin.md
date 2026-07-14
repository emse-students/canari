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

`balance_topup` (Cercle recharge) products are managed here, not in an association's boutique. The
page has a beneficiary-association selector (a global admin recharges on behalf of an association),
creates/edits the top-up products, and retries failed Cercle webhook deliveries. Creating or
updating a `balance_topup` product requires a **global admin** - enforced server-side in
`products.service.ts` (D7), not merely by this route's `isGlobalAdmin()` guard. See
[Cotisations](../../cotisations.md) for the product model.

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
