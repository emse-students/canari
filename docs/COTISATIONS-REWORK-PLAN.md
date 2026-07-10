# Cotisations rework - implementation plan

> **Status**: approved 2026-07-10; all open questions resolved. Phase 1 starting.
> **Scope**: association products + cotisation admin UX, product member-gating/pricing, Cercle
> recharge move to platform admin.

## 1. Summary

Rework how associations manage membership dues ("cotisations") and boutique products:

1. Replace the free-form product `type` dropdown with **dedicated tabs**: **Produits** (`other`),
   **Cotisations** (`membership`). The **Recharge du compte** (`balance_topup`, Cercle) type leaves
   the per-association UI entirely and moves to the **platform admin** interface (global admin only).
2. Model a cotisation as a **single canonical membership product per association**, with an
   auto-derived tag and a validity mode (lifetime vs dated), managed in a dedicated **Cotisations**
   tab that also shows a searchable, paginated, promo-sorted **cotisant roster** with manual add and
   an **.xlsx export**.
3. Add **member-gating** and **member pricing** to boutique products (reusing the existing tag
   machinery), so a product can be reserved to cotisants and/or cheaper for them.

## 2. Goals / non-goals

**Goals**
- Remove the confusing product `type` selector; one tab per concept.
- Make "who is a cotisant" a first-class, browsable, exportable list.
- Move manual cotisant add out of the "Achats" tab into "Cotisations".
- Restrict Cercle recharge (signed webhook that credits real money) to platform admins.
- Let products be members-only and/or member-priced with a simple checkbox UX.

**Non-goals (for this chantier)**
- Reworking the Cercle webhook protocol itself (only relocating + re-gating its management UI).
- Multi-tier cotisations per association (student/external, annual/lifetime coexisting). One
  cotisation per association; the validity mode is a single per-association setting.
- Changing the MLS / channel membership model (unrelated to dues).

## 3. Current state (facts)

- **Product entity** `apps/social-service/src/associations/entities/association-product.entity.ts`:
  `type: 'membership' | 'balance_topup' | 'other'` (L37-38), validated `@IsIn(...)` in
  `dto/association.dto.ts:354-355`. Cercle fields: `webhookUrl` (L59-60), `webhookSecret` (L63-64),
  both flagged "never returned/exposed". Purchase caps: `allowRepeatPurchase`, `maxPurchasesPerUser`,
  `maxPurchasesTotal`. Membership fields: `grantedTagName`, `tagExpiresAt`.
- **No product-level member gating or member pricing today**. `assertCanPurchase`
  (`products.service.ts:376-404`) only enforces active/onboarding + purchase caps; the only tag read
  (L398-401) allows re-buying an expired membership (renewal). Any logged-in user can buy any active
  product at the single `amountCents`.
- **Cotisant status = `UserTag`** (`apps/social-service/src/users/entities/user-tag.entity.ts`),
  convention `"<category>:<issuer-slug>-<year>"`. Managed by `UserTagService` (`grantOrRenew`,
  `hasActiveTag`, `revoke`, `listByAssoc`).
- **Forms already have member pricing**: `form.entity.ts` `pricingTagName` (L64), `basePriceMember`
  (L68). This is the pattern to mirror onto products.
- **Permission flags** `association-member.entity.ts:7-33`: `MANAGE_MEMBERS` (1<<2),
  `MANAGE_FORMS` (1<<4), `MANAGE_PRODUCTS` (1<<8), `MANAGE_STRIPE_CONNECT` (1<<9), BDE-only
  `MANAGE_ASSO` (1<<6) / `MODERATE` (1<<7). No cotisation/tag-specific flag. `ALL_CORE_FLAGS = 287`.
- **Association entity** `association.entity.ts`: has `stripeAccountId`, `stripeOnboardingComplete`,
  `isBDE`, `type`, `archived`, ... **no** `cotisationEnabled` / membership toggle.
- **Promo** lives on core-service `user.entity.ts:19-20` (`promo: int`), readable from social-service
  via the shared Postgres `users` table (existing raw SQL: `posts.service.ts:302-306`, enrichment
  query `products.service.ts:352-357`). No cross-service call needed.
- **Cercle webhook**: `products.service.ts` `fulfillProductPurchase` (L512) -> `dispatchCercleWebhook`
  (L578-644, HMAC-SHA256, 3 retries), audited in `webhook-delivery.entity.ts`; retry surface
  `listWebhookFailures` (L649) / `retryWebhookDelivery` (L665).
- **Export precedent**: `forms.service.ts:785` `exportSubmissions` (ExcelJS `.xlsx`),
  `forms.controller.ts:316` `GET :id/export` (owner or `MANAGE_FORMS`). Mirror this for cotisants.
- **Admin routes** already exist: `frontend/src/routes/admin/{associations,users,moderation,status,agenda,platform}/+page.svelte` + `+layout.svelte`. Cercle gets a new sibling page.
- **Frontend touchpoints**: `edit/EditBoutiqueTab.svelte`, `edit/EditAchatsTab.svelte`,
  `edit/EditMembersTab.svelte`, edit page `routes/associations/[slug]/edit/+page.svelte`,
  `routes/shop/+page.svelte`, `shop/ProductPurchaseButton.svelte`, `lib/associations/api.ts`,
  forms pricing `routes/forms/create/+page.svelte` + `FormBuilder.svelte`.

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | One cotisation per association = a single canonical `membership` product | Reuses the whole existing purchase/grant/Stripe flow untouched; enables checkbox-based gating (no tag typing) |
| D2 | Cotisation tag is **auto-derived** from the association slug: `cotisant:<slug>` (lifetime) or `cotisant:<slug>-<year>` (dated). **Dated mode rolls over per academic year**: each period is a new tag namespace (e.g. `-2026-2027`) with expiry **31/08**, so per-year rosters/history stay clean | Admins never type tag names; product gating becomes a checkbox; per-year cotisant lists are exact |
| D3 | Validity mode is a **per-association** setting (confirmed, not per-cotisant): **lifetime** (`tagExpiresAt = null`, buy once) or **dated** (academic-year expiry, renewable) | Matches "certaines assos a vie, d'autres a l'annee" |
| D4 | New `Association.cotisationEnabled: boolean` gates the Cotisations tab | Makes "does this asso take dues" explicit instead of inferred |
| D5 | Cotisations tab permission = **reuse `MANAGE_MEMBERS`** for roster/add; price/validity edits require `MANAGE_PRODUCTS` | User choice; no migration; separates roster admin from money |
| D6 | Product member-gating = new `membersOnly: boolean`; member price = new `amountCentsMember: number \| null` on `AssociationProduct` | Mirrors forms' pattern; both resolve to the asso's own cotisation tag |
| D7 | `balance_topup` management moves to `/admin/cercle` (global admin), with an association-beneficiary selector | Signed money-moving webhook is too sensitive for per-asso `MANAGE_PRODUCTS` |
| D8 | Cotisant export = `.xlsx` via ExcelJS, mirroring `exportSubmissions` | Consistency with form-submission export |
| D9 | Roster shows **active cotisants only** (non-expired tag of the current period) | Simplest; covers day-to-day management; export sorts the active set |
| D10 | Manual add **grants the tag only** - no payment/amount captured | Keep the manual path a pure "mark as cotisant"; cash-amount tracking stays out |

### Minor confirmations (defaults accepted)
- The **Achats** tab is **kept** for non-cotisation purchase history (only the manual cotisant-add moves out).
- `membersOnly` means cotisant **of the same association** (no cross-asso gating).
- The cotisation product carries an **editable free-text label** (e.g. "Cotisation annuelle BDE").
- Export columns: **Nom, Prenom, Promo, Cotisation, Date, Echeance** - **no email** (PII).
- Cotisants **without a promo** (externals, staff) are grouped in a "Sans promo" block at the list end.
- Forms "tarif cotisant": simplify the tag autocomplete to a checkbox in **phase 4** (optional).

## 5. Data model changes

### 5.1 `AssociationProduct` (new columns)
- `membersOnly: boolean` (default `false`) - purchase reserved to holders of the asso cotisation tag.
- `amountCentsMember: int | null` (default `null`) - reduced price for cotisants (`null` = same as
  `amountCents`).

### 5.2 `Association` (new columns)
- `cotisationEnabled: boolean` (default `false`) - reveals the Cotisations tab and cotisation config.
- `cotisationMode: 'lifetime' | 'dated' | null` - validity mode (null when disabled).
- `cotisationExpiresAt: timestamptz | null` - deadline for `dated` mode, **derived server-side**
  from the mode (dated -> 31/08 of the current academic year, lifetime -> null) in
  `associations.service.update`; never chosen by the client, so it always matches the granted tag.
  The admin only picks the mode; there is no expiry date picker in the UI.
- (Price/label live on the canonical membership product, not duplicated here.)

### 5.3 Migrations
- SQL migration adding the columns above (follow `apps/social-service/src/migrations/` style, cf.
  `001_permissions_bitmask.sql`).
- **Backfill**: feature is essentially **unused in production** (confirmed) - migration is free. Still
  add a defensive backfill for any stray `membership` product (set `cotisationEnabled = true`, derive
  `cotisationMode` from `tagExpiresAt`, rewrite `grantedTagName` to the canonical tag), but no special
  preservation of existing tags/webhooks is required.

## 6. Backend changes (social-service)

- **Cotisant roster**: `GET /api/associations/:id/cotisants?search=&cursor=&limit=` - returns active
  cotisant tag holders enriched with `firstName`, `lastName`, `promo`, `grantedAt`, `expiresAt`;
  sorted promo then last name; keyset pagination. Extend the existing enrichment SQL
  (`products.service.ts:352-357`) to also select `promo`. Gate: `MANAGE_MEMBERS`.
- **Cotisant export**: `GET /api/associations/:id/cotisants/export` - ExcelJS `.xlsx`
  (cols: Nom, Prenom, Promo, Cotisation, Date, Echeance), mirroring `exportSubmissions` +
  the `forms.controller.ts:316` Content-Disposition handling. Gate: `MANAGE_MEMBERS`.
- **Manual add**: grant the cotisation tag only via `grantTag` (no purchase/amount recorded); exposed
  from the Cotisations tab. Gate: `MANAGE_MEMBERS`.
- **Cotisation config**: `PATCH /api/associations/:id` accepts `cotisationEnabled`, `cotisationMode`,
  `cotisationExpiresAt`; enabling provisions/updates the canonical membership product (name, price,
  `grantedTagName`, `tagExpiresAt`). Gate: `MANAGE_PRODUCTS`.
- **Product gating/pricing**:
  - `create`/`update` product DTO gains `membersOnly`, `amountCentsMember`.
  - `assertCanPurchase` (`products.service.ts:376-404`): if `membersOnly`, require an active asso
    cotisation tag, else reject with a clear error.
  - `resolvePurchase` (L250-284): when the buyer holds the cotisation tag and `amountCentsMember` is
    set, charge the reduced amount.
- **Cercle relocation**: `balance_topup` create/update gated on **global admin** (X-Global-Admin),
  not `MANAGE_PRODUCTS`. Add/confirm an `associationId` beneficiary on the create path so the admin
  chooses the recipient asso. Remove `balance_topup` from the per-asso product create surface.
- **Type discriminator**: keep `type` in the entity/DTO; each creation path sets it server-side. The
  DTO `@IsIn(['membership','balance_topup','other'])` stays.

## 7. Frontend changes

### 7.1 Association boutique -> two tabs
- Edit page `routes/associations/[slug]/edit/+page.svelte`: replace the single boutique tab with
  **Produits** and **Cotisations**; drop the `type` dropdown in `EditBoutiqueTab.svelte` (each tab
  fixes the type). Remove the Recharge/`balance_topup` option here.
- **Produits tab**: current boutique product management, minus type selection; add the two new
  controls (checkbox "Reserve aux cotisants", input "Prix cotisant").
- **Cotisations tab** (new): visible iff `cotisationEnabled`.
  - Config block (gated `MANAGE_PRODUCTS`): enable toggle, validity mode (a vie / echeance + date),
    price.
  - Roster (gated `MANAGE_MEMBERS`): search bar, promo-sorted list, infinite scroll over the paginated
    endpoint, "Ajouter un cotisant" (moved from `EditAchatsTab.svelte`), "Exporter (.xlsx)".
- `EditMembersTab.svelte`: drop the read-only "Statuts cotisants actifs" section (superseded by the
  Cotisations tab).

### 7.2 Platform admin -> Cercle page
- New `frontend/src/routes/admin/cercle/+page.svelte` (global admin), listed in the admin layout:
  manage `balance_topup` products, choose beneficiary association, webhook config + failure retry
  surface (`listWebhookFailures` / `retryWebhookDelivery`).

### 7.3 Shop + forms
- `shop/+page.svelte` + `ProductPurchaseButton.svelte`: show member price when applicable; block/label
  members-only products for non-cotisants.
- Forms pricing UX (`routes/forms/create/+page.svelte`, `FormBuilder.svelte`): optionally simplify the
  tag autocomplete to a "tarif cotisant" checkbox resolving to the asso cotisation tag. **Optional /
  phase 4** - do not block the core rework on it.
- `lib/associations/api.ts`: new roster/export/config calls; updated product create/update payloads.

## 8. Permissions matrix (after)

| Action | Gate |
|---|---|
| Manage misc products (Produits tab) | `MANAGE_PRODUCTS` |
| View/add/export cotisants (roster) | `MANAGE_MEMBERS` |
| Edit cotisation price/validity/enable | `MANAGE_PRODUCTS` |
| Manage Cercle recharge (`/admin/cercle`) | Global admin (X-Global-Admin) |
| Product members-only gating / member price config | `MANAGE_PRODUCTS` |

## 9. i18n / docs / tests

- **i18n**: add FR + EN Paraglide keys for all new labels (tabs, roster columns, validity modes,
  members-only, member price, admin Cercle page). No inline literals.
- **Wiki**: update `docs/wiki/cotisations.md` (tabs, gating/pricing, per-asso model, Cercle in admin),
  `docs/wiki/frontend/modules/associations.md` (tab list), `docs/wiki/services/social-service.md`
  (new endpoints + product fields), `docs/wiki/frontend/modules/admin.md` (Cercle page).
- **User guide**: add a short "Cotiser / gerer les cotisants" section to `docs/user-guide/membre.md`.
- **Tests**: entity/DTO for new fields; `assertCanPurchase` members-only reject; `resolvePurchase`
  member price; roster pagination + search + promo sort; export headers; Cercle admin gating (403 for
  non-global-admin); frontend component tests for the new tabs. Update any snapshot/label assertions.

## 10. Phased plan

- **Phase 1 - Backend model**: migrations (5.1-5.3) + DTOs + `assertCanPurchase`/`resolvePurchase`
  gating/pricing + cotisation config on `PATCH association` + Cercle re-gating. Tests. Verify.
- **Phase 2 - Cotisations tab**: roster endpoint + export endpoint; frontend Cotisations tab (config +
  roster + add + export); drop the read-only section from Members. Tests.
- **Phase 3 - Boutique split + admin Cercle**: Produits/Cotisations split, remove type dropdown,
  members-only/member-price controls; `/admin/cercle` page; shop rendering. Tests.
- **Phase 4 - Polish + docs**: optional forms "tarif cotisant" checkbox unification; i18n sweep; wiki +
  user-guide updates; final CI.

Each phase ends green (`bun run check`, `cargo`/Jest/Vitest as relevant) and is independently
committable on `main`.

## 11. Resolved questions / residual risks

- **D3 (resolved)**: validity mode is per-association, not per-cotisant.
- **Rollover (resolved)**: dated mode uses a new academic-year tag namespace (`-<year>`), expiry 31/08.
- **Roster (resolved)**: active cotisants only.
- **Manual add (resolved)**: grants the tag only, no payment captured.
- **Prod state (resolved)**: feature unused in production - migration is free.
- **Residual risk**: Cercle re-gating is a behavior change; even with no live `balance_topup`, keep the
  admin-only gate enforced server-side (not just hidden in the UI). Done in phase 1 (service-level).
- **Dated-mode yearly rollover (fixed, option a)**: the granted tag is now derived at **fulfillment
  time** via `ProductsService.resolveGrantTag` (used by both the Stripe and cash grant paths) and the
  membership renewal check in `assertCanPurchase`, so a purchase always grants/checks the current
  academic-year tag regardless of when the canonical product was last provisioned. Membership products
  without a cotisation mode fall back to their stored tag. `provisionCotisationProduct` still keeps the
  stored `grantedTagName` roughly in sync for display, but correctness no longer depends on it.
- **Phase 3 note**: enabling cotisations provisions the canonical product with `amountCents = null`
  (unpurchasable, inert) - the Cotisations tab config block MUST let the admin set the price when
  enabling, so the cotisation is actually buyable.
- **Decision deferred**: a dedicated `MANAGE_COTISATION` flag later (rejected now in favor of reusing
  `MANAGE_MEMBERS`, D5).
