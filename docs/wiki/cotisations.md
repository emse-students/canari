# Cotisations (membership dues)

**Backend**: `apps/social-service/` (associations, forms, user tags)
**Frontend**: `frontend/src/lib/components/associations/edit/`, `frontend/src/lib/components/forms/`, `frontend/src/routes/shop/`
**Payments**: routed through `core-service` (Stripe Connect)

Cotisation is how an association records that a user has paid their membership dues for a period.
Canari does not store this as a boolean on the user or the association. Instead it is modelled as a
time-bounded **tag** granted to the user by the issuing association.

> **Do not confuse two "member" concepts.** `association_members` is the association's *staff /
> bureau roster* (roles + permission bitmask, shown in the trombinoscope). It is unrelated to dues.
> The cotisant / membership-dues status is `user_tags`, described below.

## Data model

### `user_tags` - the cotisant status

Table `user_tags`, entity `UserTag` (`apps/social-service/src/users/entities/user-tag.entity.ts`).

| Field | Purpose |
|---|---|
| `userId` | Tag holder |
| `tagName` | Convention `"<category>:<issuer-slug>-<year>"`, e.g. `"cotisant:bde-2026-2027"` |
| `issuingAssocId` | Association that granted the tag |
| `grantedBy` | Admin (or system) who granted it |
| `expiresAt` | Expiry instant; `null` means permanent |
| `metadata` | Free-form jsonb |

Unique on `(userId, tagName)`. A user "is a cotisant" of an association when they hold an **active**
(non-expired) tag issued by that association.

`UserTagService` (`apps/social-service/src/users/user-tag.service.ts`) is the single entry point:

- `grantOrRenew` - idempotent upsert; extends `expiresAt` on renewal.
- `hasActiveTag` - membership check used by form pricing.
- `revoke` - remove a tag.
- `listByAssoc` / `listByUser` / `listDistinctNamesForAssoc` - admin panel queries.

### Boutique products

A cotisation is sold as a boutique product of `type: 'membership'`
(`apps/social-service/src/associations/entities/association-product.entity.ts`) carrying:

- `grantedTagName` - the tag granted on successful purchase.
- `tagExpiresAt` - expiry applied to the granted tag.

### Form pricing fields

Forms (`apps/social-service/src/forms/entities/form.entity.ts`) support member pricing and can
themselves grant a tag:

- `pricingTagName` - tag checked at submit time; holders get the reduced rate.
- `basePriceMember` - reduced base price in cents (`null` = same as `basePrice`).
- `grantedTagName` + `tagExpiresAt` - a paid submission can grant/renew a cotisant tag. Prefer
  boutique membership products for this; the form path exists for adhesion-style forms.

Per-option reduced surcharges also exist (`priceModifierMember` on option items), surfaced in the
form builder when a `pricingTagName` is set.

## How a user becomes a cotisant

There are two paid flows and two manual (cash / override) flows. All money moves through
core-service using the association's **Stripe Connect** account; social-service never calls Stripe
directly. The association must have completed Stripe Connect onboarding before online sales work.

### A. Boutique membership product (recommended)

1. User opens `/shop`, buys the membership product (`ProductPurchaseButton` -> Stripe Checkout).
2. `products.service.ts#createCheckoutSession` calls core-service
   `POST /api/payments/create-checkout-session` with the association's `stripeConnectAccountId`.
3. On Stripe success, the webhook reaches core-service, then social-service
   `fulfillProductPurchase` -> `userTagService.grantOrRenew(...)` posts the cotisant tag.
4. `assertCanPurchase` blocks re-buying while the tag is still active.

### B. Paid form with `grantedTagName`

`forms.service.ts#markPaid` (after Stripe) or `#validateCashPayment` (cash) call
`grantOrRenew(...)` to grant/renew the tag on submission.

### C. Manual grant (cash payment / retroactive)

- `POST /api/associations/:id/products/:productId/grant` -> `grantProductPurchase`: records a
  purchase and grants the membership tag like a real sale (no Cercle webhook). Requires
  `MANAGE_PRODUCTS`. This is the recommended manual path (leaves an audit trail in "Achats").
- `POST /api/associations/:id/tags` -> `grantTag`: raw tag grant with an admin-supplied `tagName` /
  `expiresAt`. Requires `MANAGE_MEMBERS`. `DELETE /api/associations/:id/tags/:tagId` revokes.

## Member (reduced) pricing on forms

When a form has `pricingTagName` set, submission pricing is gated on the caller holding that tag:

```
memberPricing = userId && form.pricingTagName && hasActiveTag(userId, pricingTagName)
baseCents     = memberPricing && form.basePriceMember != null ? basePriceMember : basePrice
```

The same check runs in the submission-status endpoint so the public form page can display the
reduced total before payment (`forms.service.ts`). A member who fills a paid form pays the reduced
rate automatically; no coupon or code is involved.

## Where it lives in the UI

Association admin panel: **`/associations/[slug]/edit`** (the yellow "Gerer" button on the
association detail page). Tabbed, single-page.

| Task | Tab | Component |
|---|---|---|
| See active cotisants (read-only) | **Membres** | `edit/EditMembersTab.svelte` ("Statuts cotisants actifs" section) |
| Create a membership product | **Paiements** (boutique) | `edit/EditBoutiqueTab.svelte` (type "Cotisation", `grantedTagName` + expiry) |
| Grant a tag manually (cash / retroactive) | **Achats** | `edit/EditAchatsTab.svelte` (pick user + product -> grant) |
| Set member pricing on a form | form create/edit | `routes/forms/create/+page.svelte` payment section (`pricingTagName`, `basePriceMember`) |

> **UX note**: the "Membres" tab is read-only for tags; manual granting lives under "Achats", not
> "Membres". A user looking to "add a cotisant" may expect it under "Membres".

End-user (paying) surfaces:

- **`/shop`** - buy a membership product (Stripe Checkout; returns to `/shop?purchase_success=1`).
- **`/forms/[id]`** - fill a paid form; member pricing is applied automatically when the caller
  holds the form's `pricingTagName`.

## Permissions

- `MANAGE_MEMBERS` - grant/revoke tags directly (`/tags` endpoints), manage the staff roster.
- `MANAGE_PRODUCTS` - create boutique products, manual `grant` purchases, Stripe Connect setup.
- Global admin - all of the above.

## Relevant endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/associations/:id/tags` | List tags issued by the association (admin "Cotisants") |
| POST | `/api/associations/:id/tags` | Manually grant a tag (`MANAGE_MEMBERS`) |
| DELETE | `/api/associations/:id/tags/:tagId` | Revoke a tag |
| POST | `/api/associations/:id/products` | Create a boutique product (incl. `type: 'membership'`) |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for a product |
| POST | `/api/associations/:id/products/:productId/grant` | Manual purchase + tag grant (cash) |
| POST | `/api/forms/:id/submit` | Submit a form; applies member pricing, may grant a tag |
