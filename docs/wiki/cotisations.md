# Cotisations (membership dues)

**Backend**: `apps/social-service/` (associations, user tags, products)
**Frontend**: `frontend/src/lib/components/associations/edit/`, `frontend/src/routes/shop/`,
`frontend/src/routes/admin/cercle/`
**Payments**: routed through `core-service` (Stripe Connect)

Cotisation is how an association records that a user has paid their membership dues. Canari does not
store this as a boolean on the user or the association: it is modelled as a (possibly time-bounded)
**tag** granted to the user by the issuing association.

> **Do not confuse two "member" concepts.** `association_members` is the association's *staff /
> bureau roster* (roles + permission bitmask, shown in the trombinoscope). It is unrelated to dues.
> The cotisant / membership-dues status is `user_tags`, described below.

## Data model

### `user_tags` - the cotisant status

Table `user_tags`, entity `UserTag` (`apps/social-service/src/users/entities/user-tag.entity.ts`).

| Field | Purpose |
|---|---|
| `userId` | Tag holder |
| `tagName` | Canonical cotisation tag, see below |
| `issuingAssocId` | Association that granted the tag |
| `grantedBy` | Admin (or system) who granted it |
| `expiresAt` | Expiry instant; `null` means permanent |
| `metadata` | Free-form jsonb |

Unique on `(userId, tagName)`. A user "is a cotisant" of an association when they hold an **active**
(non-expired) tag issued by that association.

### The canonical cotisation tag (single source of truth)

`deriveCotisationTag(slug, mode)` in `apps/social-service/src/associations/cotisation-tag.util.ts`
is the **only** place the tag string is built. It MUST be used both when provisioning the membership
product and when checking gating/pricing, so everything stays aligned. An association's cotisation
has a `cotisationMode`:

- **`lifetime`** - buy once, never expires. Tag `cotisant:<slug>`, `expiresAt = null`.
- **`dated`** - renewed each academic year. Tag `cotisant:<slug>-<academicYear>` (e.g.
  `cotisant:bde-2026-2027`), `expiresAt = 31 August` of the end year. The academic year is derived by
  `getAcademicYear()`: from August (month >= 8) onward it is `<year>-<year+1>`, otherwise
  `<year-1>-<year>`. Rolling the tag over per year keeps each year's roster clean.

Expiry is **always derived server-side**, never picked by an admin. `associations.service` sets
`cotisationExpiresAt` when the `dated` mode is enabled/saved. Because the tag is re-derived at
**fulfillment time** (`resolveGrantTag` in `products.service.ts`), a purchase that lands after the
academic-year rollover grants the new year's tag, not a stale one.

### The membership product

Each cotisation is sold as **one canonical boutique product** of `type: 'membership'`
(`apps/social-service/src/associations/entities/association-product.entity.ts`). Its granted tag is
derived by `deriveCotisationTag` at fulfillment - admins never type a `tagName` or expiry for it.
Enabling a cotisation auto-provisions this product; the Cotisations tab only edits its label/price.

### Multi-tier cotisations (named variants)

Some associations sell more than one cotisation tier (e.g. Le Cercle's "avec-alcool" /
"sans-alcool" forfaits). A `membership` product can carry a `variantKey` (e.g. `"avec-alcool"`),
which `deriveCotisationTag(slug, mode, now, variantKey)` suffixes onto the tag
(`cotisant:cercle-avec-alcool`) so each tier gets its own tag namespace. `variantLevel` is a reserved
ordinal for a future "tier >= N" inclusion check (not used yet).

**Upgrade pricing (`memberPriceTag`)**: a tier-upgrade product can set `memberPriceTag` to a sibling
tier's tag name and `amountCentsMember` to the price delta. The reduced price then applies **iff the
buyer holds that specific tag** - it does NOT fall back to the generic asso-wide cotisant check the
way plain `amountCentsMember` does when `memberPriceTag` is unset. Example: the "avec-alcool" product
sets `memberPriceTag = "cotisant:cercle-sans-alcool"` so a sans-alcool cotisant switching up only
pays the difference; someone with no cotisation at all pays full price.

**XOR on fulfillment**: granting a tiered product's tag also revokes the buyer's tag(s) for the
association's *other* tiers, in the same DB transaction (`revokeSiblingTierTags` in
`products.service.ts`) - a cotisant holds exactly one tier of a given association at a time. Buying a
sibling tier for the first time is allowed even if another tier was already purchased (purchase caps
are tracked per-product, not per-association), but re-buying the *same* tier while its tag is still
active is blocked like any other membership renewal check.

### Product member gating & pricing

Any boutique product (not just membership) can gate or discount on cotisant status:

- `membersOnly` - reserved to holders of **any** of the association's active cotisation tier tags
  (`isBuyerCotisant` enumerates every distinct `variantKey` among the association's `membership`
  products via `tierVariantKeys()` - not just the base, un-suffixed tag - so this stays correct for
  multi-tier associations).
- `requiredTags` - a generalized gate: an arbitrary list of tag names, the buyer needing **any one**
  of them (`text[]`, OR semantics). Not scoped to the owning association - lets a product be gated on
  a tag from another association or a form's `pricingTagName`. Takes **precedence** over
  `membersOnly` when set (checked instead of, not in addition to, the asso-wide check); `null`/empty
  falls back to the `membersOnly` behavior above.
- `amountCentsMember` - reduced price in cents for cotisants (`null` = same as `amountCents`).

All three are enforced server-side in `products.service.ts` (`isBuyerCotisant`, `hasAnyActiveTag` +
`assertCanPurchase`); the client only mirrors the *display*.

### Form pricing fields

Forms (`apps/social-service/src/forms/entities/form.entity.ts`) support member pricing and can grant
a tag: `pricingTagName` (checked at submit for the reduced rate), `basePriceMember` (`null` = same as
`basePrice`), and `grantedTagName` + `tagExpiresAt` for adhesion-style forms. Prefer the membership
product for selling dues; the form path exists for adhesion forms.

## Where it lives in the UI

Association admin panel: **`/associations/[slug]/edit`** (the yellow "Gerer" button). Tabbed,
single-page. The rework split cotisations into their own tab and moved Cercle top-ups to platform
admin:

| Task | Tab / page | Component | Permission |
|---|---|---|---|
| Enable cotisation, pick `lifetime`/`dated`, edit membership label & price, manage the roster | **Cotisations** | `edit/EditCotisationsTab.svelte` | config = `MANAGE_PRODUCTS`; roster = `MANAGE_MEMBERS` |
| Sell/gate ordinary products (`type: 'other'`), set `membersOnly` + member price | **Paiements** (boutique) | `edit/EditBoutiqueTab.svelte` | `MANAGE_PRODUCTS` |
| Create/edit `balance_topup` (Cercle) products + retry failed webhooks | **`/admin/cercle`** | `routes/admin/cercle/+page.svelte` | **global admin only** |
| Set member pricing on a form | form create/edit | `routes/forms/create/+page.svelte` | `MANAGE_FORMS` |

The **product `type` dropdown was removed** from the boutique: membership is managed in the
Cotisations tab, `balance_topup` moved to `/admin/cercle` (with a beneficiary-association selector,
since a global admin recharges on behalf of an association), and the boutique itself only handles
`type: 'other'`.

### The Cotisations tab roster

`EditCotisationsTab.svelte` shows the association's **active** cotisants (D9: `expiresAt IS NULL OR
expiresAt > NOW()`), enriched with `firstName`/`lastName`/`promo` from the shared `users` table.
It is promo-sorted (**NULLS LAST** - "Sans promo" grouped last), searchable, offset-paginated
(infinite scroll), and exportable to `.xlsx` (headers: Nom, Prenom, Promo, Cotisation, Date,
Echeance). Manual add grants the canonical tag only (D10: no payment/amount recorded); revoke
deletes the tag.

End-user (paying) surfaces:

- **`/shop`** - buy a membership product (Stripe Checkout; returns to `/shop?purchase_success=1`).
  Members-only products are disabled with a hint, and member pricing is shown struck-through next to
  the reduced price. Gating/labeling uses the per-product `viewerIsCotisant`/`viewerActiveTier` flags
  returned by `/products/all` (computed server-side; no client-side tag derivation).
  `viewerActiveTier` is the specific tier `variantKey` the viewer currently holds for that
  association, if any (`null` for a single-tier association or a non-cotisant).
- **`/forms/[id]`** - fill a paid form; member pricing is applied automatically when the caller
  holds the form's `pricingTagName`.

## How a user becomes a cotisant

All money moves through core-service using the association's **Stripe Connect** account;
social-service never calls Stripe directly. Online sales require completed Stripe Connect onboarding.

### A. Membership product (recommended)

1. User opens `/shop`, buys the membership product (`ProductPurchaseButton` -> Stripe Checkout).
2. `products.service.ts#createProductCheckout` calls core-service with the association's
   `stripeConnectAccountId`.
3. On Stripe success the webhook reaches core-service, then social-service `fulfillProductPurchase`
   -> `resolveGrantTag` derives the current tag -> `userTagService.grantOrRenew(...)`.
4. `assertCanPurchase` blocks re-buying while the tag is still active.

### B. Paid form with `grantedTagName`

`forms.service.ts#markPaid` (after Stripe) or `#validateCashPayment` (cash) call `grantOrRenew(...)`.

### C. Manual grant from the Cotisations tab (cash / retroactive)

- `POST /api/associations/:id/cotisants` -> `userTagService.grantCotisant`: grants the canonical tag
  only, no purchase recorded (D10). Tag + expiry derived server-side. Requires `MANAGE_MEMBERS`.
- `POST /api/associations/:id/products/:productId/grant` -> `grantProductPurchase`: records a
  purchase *and* grants the tag like a real sale (leaves an audit trail in "Achats"). Requires
  `MANAGE_PRODUCTS`.
- `POST /api/associations/:id/tags` -> raw tag grant with an admin-supplied `tagName`/`expiresAt`
  (`MANAGE_MEMBERS`); `DELETE /api/associations/:id/tags/:tagId` revokes.

## Member (reduced) pricing on forms

When a form has `pricingTagName` set, submission pricing is gated on the caller holding that tag:

```
memberPricing = userId && form.pricingTagName && hasActiveTag(userId, pricingTagName)
baseCents     = memberPricing && form.basePriceMember != null ? basePriceMember : basePrice
```

The same check runs in the submission-status endpoint so the public form page can show the reduced
total before payment. No coupon or code is involved.

## Permissions

- `MANAGE_MEMBERS` - grant/revoke tags (`/tags`, `/cotisants`), read/export the roster, manage the
  staff roster.
- `MANAGE_PRODUCTS` - enable cotisation, edit the membership product, create boutique products,
  manual `grant` purchases, Stripe Connect setup.
- **Global admin** - all of the above, **plus** `balance_topup` (Cercle) product create/update,
  which is enforced server-side (D7), not merely gated by the `/admin/cercle` route.

## Relevant endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/associations/:id/tags` | List active tags issued by the association (`MANAGE_MEMBERS`) |
| POST | `/api/associations/:id/tags` | Manually grant a raw tag (`MANAGE_MEMBERS`) |
| DELETE | `/api/associations/:id/tags/:tagId` | Revoke a tag |
| GET | `/api/associations/:id/cotisants` | Paginated, searchable active roster (`MANAGE_MEMBERS`) |
| POST | `/api/associations/:id/cotisants` | Grant the canonical tag only, no payment (`MANAGE_MEMBERS`) |
| GET | `/api/associations/:id/cotisants/export` | Roster as `.xlsx` (`MANAGE_MEMBERS`) |
| GET | `/api/associations/products/all` | All active products + per-product `viewerIsCotisant`/`viewerActiveTier` (shop) |
| POST | `/api/associations/:id/products` | Create a product (incl. `type: 'membership'`) (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for a product |
| POST | `/api/associations/:id/products/:productId/grant` | Manual purchase + tag grant (`MANAGE_PRODUCTS`) |
| POST | `/api/forms/:id/submit` | Submit a form; applies member pricing, may grant a tag |

## See also

- [frontend/modules/associations.md](frontend/modules/associations.md) - association model, permission flags, admin panel tabs.
- [services/social-service.md](services/social-service.md) - service boundaries (associations, user tags, forms).
- [frontend/modules/admin.md](frontend/modules/admin.md) - platform admin surfaces, including `/admin/cercle` (Cercle top-ups).
- [frontend/modules/payments.md](frontend/modules/payments.md) - Stripe Connect and the shop/checkout flow.
- [../user-guide/membre.md](../user-guide/membre.md) - "Cotiser a une association" (end-user guide).
