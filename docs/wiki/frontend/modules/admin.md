# Admin module

**Routes**: `src/routes/admin/`  
**Components**: `src/lib/components/moderation/`

## Responsibilities

- Platform configuration (maintenance mode, minimum client version).
- Content moderation (post reports).
- User management (global admin only).

## Access control

**`/admin` is not one permission, it is four tiers sharing a shell.** The layout decides who gets in
and which items appear; every page repeats its own check, because a route is reachable by URL.

| Tier | How the client knows | Source |
| --- | --- | --- |
| Platform administrator | `isGlobalAdmin()` | `X-Global-Admin`, injected by nginx from `auth_request` |
| BDE super-admin | `isAssociationSuperAdmin()` | `MANAGE_ASSO` in a BDE association |
| Content moderator | `isContentModerator()` | `MODERATE` in a BDE association |
| Association admin | any membership with `isAdmin` (at least one flag) | `GET /api/associations/me/list` |

The last three all come from **one** membership request, `ensureMyAssociations()`, which publishes
both BDE tiers as a side effect. It is awaited rather than probed in the background wherever it
decides a REDIRECT: a background probe bounces the very user it was meant to admit whenever it loses
the race.

## Routes, and who reaches them

| Route | Section | Who |
| --- | --- | --- |
| `/admin` | Home (cards) | Any association admin, any content moderator, any platform admin |
| `/admin/agenda` | Pending agenda events | Any association admin |
| `/admin/moderation` | Reports, hidden posts, mutes | Content moderator or platform admin |
| `/admin/document-reviewers` | Public-document reviewer grants | BDE super-admin or platform admin |
| `/admin/carte` | Carte de la Vie Asso | BDE super-admin or platform admin |
| `/admin/associations` | Association list and creation | Platform admin |
| `/admin/platform` | Maintenance, minimum client version | Platform admin |
| `/admin/users` | User list, admin flag | Platform admin |
| `/admin/status` | Presence and connections | Platform admin |
| `/admin/cercle` | Cercle top-up product | Platform admin |
| `/admin/storage` | Storage usage | Platform admin |

**The way in is the dashboard's "Administration" tile**, shown to anyone holding at least one
association flag (so every moderator sees it), plus a direct link to `/admin/agenda` from the
calendar. Nothing else links into this tree.

**A tier without its screen is a right nobody can exercise.** `/admin/moderation` was gated on
`isGlobalAdmin()` in three places at once - the nav item, the home card and the page's own redirect -
while the server had `MODERATE` accepted on the reports, mutes and comment endpoints. A BDE holding
the flag could reach none of it, and the whole tier was reachable only by someone who already knew
the URL. Whenever a permission is added to a server-side check, the matching screen is part of the
same change.

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
| `minClientVersion` | Minimum app version; older clients are blocked until they update |

On save, the frontend also triggers `refreshAppVersionCheck()` to apply the new version gate without reload.

> **`minClientVersion` is now the only thing that interrupts a user.** Since the store release there
> is no optional update prompt at all - a client merely behind the deployed version is told nothing,
> because the store updates people by itself and a modal on every launch was pure friction. The
> version is available passively in the "A propos" block of `/settings`. Raising this field is
> therefore the whole escalation ladder in one step: it blocks the app outright
> (`PlatformGateOverlay`, `shouldBlockSessionUnlock`) and offers the store as the only way forward.
>
> **Raise it only once the store rollout has actually reached devices.** The gate is enforced the
> instant it is saved, while a Google Play review plus rollout takes days and an App Store review
> longer - set it to a version nobody can install yet and every mobile user is locked out with a
> button that leads to a store still serving the old build. The safe sequence is: ship, wait for the
> new version to be live on both stores, then raise the minimum.

The destination of that block is resolved at runtime, not from configuration - see
[mobile](../mobile.md#where-an-update-comes-from) for why a sideloaded Android install must never be
sent to Google Play.

## Moderation

Three tabs, open to a content moderator (BDE `MODERATE`) or a platform admin - the same tier every
endpoint behind them accepts:

| Tab | Reads | Acts |
| --- | --- | --- |
| Reports | `GET /api/moderation/reports` | review/dismiss, hide the post, delete it, delete a reported comment, mute the author |
| Hidden posts | `GET /api/posts/hidden` | unhide, delete, mute |
| Muted users | `GET /api/moderation/muted` | unmute |

**There is ONE report store.** `content_reports`, written by `POST /api/moderation/reports` and read
by this queue. A second one existed until 2026-08-27 - a `reports` JSONB column on `posts`, written
by `POST /api/posts/:postId/report` and read by `GET /api/posts/reported` - and **neither end had a
caller**, so no report ever went there: 112 posts on production, 0 with a row in it. Both routes and
the column are gone. The queue also takes reports on a PERSON (`contentType: 'user'`), previewed by
display name. [Reporting and blocking](../../moderation-and-blocking.md)

## User management

Global admins can list all users (`GET /api/users/admin/list`) and toggle admin status (`PATCH /api/users/:id/admin`). An admin cannot revoke their own admin flag.
