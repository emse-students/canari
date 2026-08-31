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

Each cotisation is sold as one or more boutique product(s) of `type: 'membership'`
(`apps/social-service/src/associations/entities/association-product.entity.ts`). Its granted tag is
derived by `deriveCotisationTag` at fulfillment - admins never type a `tagName` or expiry for it.
Enabling a cotisation auto-provisions the base (single-tier) product; the Cotisations tab edits its
label/price and lets admins add further tiers (WP-COT-6).

`ProductsService.create` **auto-derives** `grantedTagName`/`tagExpiresAt` server-side for any
`type: 'membership'` product from the association's `slug`/`cotisationMode` + the product's own
`variantKey` - a client-supplied `grantedTagName` is always ignored for this type, so the tag string
never drifts from `deriveCotisationTag`. Creating a membership product requires cotisation to already
be enabled (`cotisationMode` set), since the tag can't be derived otherwise.

`ProductsService.provisionCotisationProduct` (called after `PATCH /associations/:id` when
`cotisationEnabled` is true, e.g. mode edits) resyncs **every** `membership` product's tag - not just
one - so a slug rename or `lifetime`<->`dated` mode switch keeps all tiers' tags aligned, not just the
base one.

### Multi-tier cotisations (named variants)

Some associations sell more than one cotisation tier (e.g. Le Cercle's "avec-alcool" /
"sans-alcool" forfaits). A `membership` product can carry a `variantKey` (e.g. `"avec-alcool"`),
which `deriveCotisationTag(slug, mode, now, variantKey)` suffixes onto the tag
(`cotisant:cercle-avec-alcool`) so each tier gets its own tag namespace. `variantLevel` is a reserved
ordinal for a future "tier >= N" inclusion check (not used yet, see WP-COT-8).

Admins manage tiers from the Cotisations tab (`EditCotisationsTab.svelte`, WP-COT-6): the
auto-provisioned base tier (`variantKey: null`) is listed first; additional tiers are created with a
name, price, and a required `variantKey`. Each tier's edit form can also set the upgrade-pricing link
(`memberPriceTag` + `amountCentsMember`, next section) via a dropdown of sibling tiers.

**Getting rid of the base tier (WP-COT-11).** Enabling cotisation always provisions a base tier, and
its un-suffixed tag answers `tier: null` on `cotisant-status` - which a consumer such as Le Cercle
reads as "no forfait". A multi-tier association therefore has to get rid of it, two ways:

- **Convert it.** `variantKey` is editable on an existing tier. `ProductsService.update` detects the
  change, re-derives `grantedTagName`/`tagExpiresAt`, and - in the SAME transaction - renames the tag
  on every `user_tags` row the association issued under the old name. Because the tag is fully
  derived, nobody loses their cotisation over a re-labelling. A key already used by a sibling tier is
  refused (`assertVariantKeyFree`): two tiers deriving one tag would make the forfait a coin flip.
- **Delete it**, once another tier exists. The server refuses to delete the LAST membership product
  while cotisations are enabled - with no tier left, nothing grants or recognizes the tag and the
  whole cotisation silently stops working. Note that deleting a tier does NOT delete the tags already
  granted under it, so its holders stop being recognized: convert rather than delete when the tier
  has cotisants.

`tierVariantKeys()` returns **named tiers before the base one**, so a user still holding a legacy
base tag alongside a named tier is reported at the named tier rather than at `tier: null`.

**`isActive` gates BUYING a tier, never recognizing one.** Every enumeration of an association's
tiers - `listCotisationTiers`, `revokeSiblingTierTags`, `isBuyerCotisant`, `cotisantStatusFor`,
`getCotisantStatusBySlug` - covers all `membership` products regardless of `isActive`. A tier is
inactive either because it was withdrawn from sale or because the association could not take
payments when it was created (product creation forces `isActive: false` in that case, and records
WHY in `activationWithheld` - see below), and neither fact says anything about the cotisants already
holding its tag. Filtering on it made every cotisant of an
association without a Stripe account report `isCotisant: false` - the Cercle's whole roster locked
out, silently, with the tags still in the database. Only the boutique listings (`listByAssoc`,
`listAllActive`) filter on `isActive`, which is what it is for.

### A product withheld for want of a payment account releases itself

`isActive = false` is written by two decisions that must never be confused: an admin taking a product
off sale, and creation refusing to put one on sale because the association had no usable payment
target yet. Both wrote the same value and nothing recorded the difference, so **every product on prod
was inactive - five of five, the boutique empty platform-wide** - and no screen could say why. An
association would complete its Stripe onboarding and nothing would happen, because the thing that
would have to change was invisible.

**`activationWithheld` is that missing evidence, and it is an ALLOWLIST**: true only on a product
whose creation asked for `isActive: true` and was refused for want of a payment target. Releasing
sweeps `{ associationId, activationWithheld: true }` and nothing else, so a product an admin took off
sale is never resurrected - and any explicit `isActive` write from the admin UI clears the flag,
because from that moment the admin's decision is the one on record.

Release fires on the four events that make payments possible, all composed in
`associations.controller.ts` (the service cannot inject `AssociationsService` - `FormsModule` already
imports `AssociationsModule`):

| Event | Handler | Scope |
|---|---|---|
| Stripe onboarding completes | `markStripeComplete` | the association **and its approved delegating children** |
| Lydia onboarding completes | `markLydiaComplete` | same |
| A payment delegation is approved | `approvePaymentDelegation` | the child that gained a payment route |

Each release re-resolves `resolvePaymentTarget` rather than trusting the event: readiness depends on
the ACTIVE provider and on delegation, and a Stripe completion on an association that switched to
Lydia proves nothing. The cascade catches per child, so one failing child cannot lose the releases
behind it. Migration `057` backfills the flag for the products that predate it, inside an
`IF NOT EXISTS (column)` guard - a CD replay must not re-mark a product an admin has since withdrawn.

The per-tier **on-sale switch** in the Cotisations tab is the other half: `isActive` had no control
anywhere in the UI, which is why the BDE cotisation sat unbuyable for its whole existence. The switch
carries the reason a tier is off sale, because "inactive" alone does not say who decided it.

### A product prices on the same grid a form does

`association_products.priceMatrix` is the SAME document a form carries, resolved by the same
`src/pricing/` module - see
[forms](frontend/modules/forms.md#pricing-is-a-matrix-so-no-priority-rule-exists-to-get-wrong) for
why a grid rather than a rule list. Criteria available on a product: **promo, formation and
cotisation tier**. Not `answer`: a product has no questions, and the empty `CriteriaContext.questions`
a product is validated against is what refuses one.

**A grid REPLACES the fixed pricing outright.** While `priceMatrix` is set, `amountCents`,
`amountCentsMember` and `memberPriceTag` decide nothing - `resolvePurchase` and `grantProductPurchase`
branch on the matrix before they ever look at `amountCents`, and both editors hide the fields it
replaces rather than leaving figures on screen that nothing charges. That is the whole reason there
is no priority rule between the two mechanisms: only one of them is ever live.

A null cell is a REFUSAL, not a price of zero: checkout is rejected with "not available for your
situation", and the listings disable the button rather than offering a press that always fails.

**`viewerPrice` is how a listing shows a gridded price.** Only the server can price a grid (it alone
holds the viewer's promo and formation), so `listAllActive` and `listByAssoc` annotate each product
with `{ kind: 'fixed' | 'grid', amountCents, dependsOnProfile }`. `kind` is the discriminator and not
a nicety: "there is no grid" and "the grid closed this combination" would otherwise both arrive as a
null price, and only the second must stop the sale. `frontend/src/lib/pricing/viewerPrice.ts` is the
only reader of it. Profiles are batched - one `profileFor` call per distinct user across the whole
listing, skipped entirely when no product on the page rests on promo or formation.

**Upgrade pricing (`memberPriceTag`)**: a tier-upgrade product can set `memberPriceTag` to a sibling
tier's tag name and `amountCentsMember` to the price delta. The reduced price then applies **iff the
buyer holds that specific tag** - it does NOT fall back to the generic asso-wide cotisant check the
way plain `amountCentsMember` does when `memberPriceTag` is unset. Example: the "avec-alcool" product
sets `memberPriceTag = "cotisant:cercle-sans-alcool"` so a sans-alcool cotisant switching up only
pays the difference; someone with no cotisation at all pays full price.

**XOR**: granting one tier's tag also revokes the user's tag(s) for the association's *other* tiers,
in the same DB transaction - a cotisant holds exactly one tier of a given association at a time.
`UserTagService.revokeSiblingTierTags` is the single implementation, called both by a paid
fulfillment and by a manual grant, so the two paths cannot drift apart. The base tier participates
like any other (an association that kept it alongside named tiers must not leave a buyer holding
both), and inactive tiers are swept too: a tier taken off sale is still held by its cotisants. Buying a
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
  **Ignored, and hidden by both editors, while `priceMatrix` is set** - the grid's cotisation
  criterion is where a gridded product says what a cotisant pays.

All three are enforced server-side in `products.service.ts` (`isBuyerCotisant`, `hasAnyActiveTag` +
`assertCanPurchase`); the client only mirrors the *display*.

### Form pricing fields

Forms (`apps/social-service/src/forms/entities/form.entity.ts`) price through a **matrix** and can
grant a cotisation: `priceMatrix` (dimensions and their cells, one of which may be a cotisation tier)
plus `grantsCotisation` + `cotisationVariantKey`, which names a TIER and never a tag. The literal-tag
fields `pricingTagName`, `grantedTagName` and `tagExpiresAt` were dropped by migration `050`, and the
hard-coded member-price columns by `051` - see
[forms](frontend/modules/forms.md#pricing-is-a-matrix-so-no-priority-rule-exists-to-get-wrong).
Prefer the membership product for selling dues; the form path exists for adhesion forms.

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
(infinite scroll), and exportable to `.xlsx` (headers: Nom, Prenom, Promo, Cotisation, Forfait, Date,
Echeance). Manual add grants the canonical tag only (D10: no payment/amount recorded); revoke
deletes the tag.

**Changing a cotisant's forfait**: on a multi-tier association the roster's tier badge is a picker.
Switching it re-calls `grantCotisant` with the new `variantKey` - there is no dedicated "upgrade"
endpoint and there must not be one, since granting already revokes the siblings in the same
transaction (XOR). Upgrade and downgrade are therefore the same operation, and no intermediate state
exists in which the cotisant holds two forfaits or none.

**Tier label (`tier`/"Forfait", WP-COT-6)**: `UserTagService.buildTierLabelMap` maps each active
tiered product's *derived* tag name to its display name (e.g. `Avec alcool`), so both the roster and
the export can show which forfait a cotisant holds without the client re-deriving tags. The base tier
(`variantKey: null`) is intentionally left unlabeled - its column/badge stays blank, since labeling it
would be noise for the common single-tier association.

End-user (paying) surfaces:

- **`/shop`** - buy a membership product (Stripe Checkout; returns to `/shop?purchase_success=1`).
  Tiers of one association are sorted base-first (`compareTiers`, stable sort by `variantLevel`).
  Members-only products are disabled with a hint, and member pricing is shown struck-through next to
  the reduced price - but only when `qualifiesForMemberPrice` says the viewer is actually eligible
  (WP-COT-7): the asso-wide `viewerIsCotisant` check when the product has no `memberPriceTag`, or
  (for a tier-upgrade product) finding the sibling product whose `grantedTagName` equals
  `memberPriceTag` and comparing `viewerActiveTier` to that sibling's `variantKey` - the same join the
  admin tab's dropdown already encodes, mirrored client-side since `/products/all` returns every
  sibling in one array. A product whose `variantKey` matches `viewerActiveTier` gets a "your current
  tier" badge. Gating/labeling all reads the per-product `viewerIsCotisant`/`viewerActiveTier` flags
  returned by `/products/all` (computed server-side; no client-side tag *derivation*, only this join).
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

- `POST /api/associations/:id/cotisants` -> `userTagService.grantCotisant`: grants a tier's tag only,
  no purchase recorded (D10). Tag + expiry derived server-side from the optional `variantKey`, which
  must name one of the association's membership products - an arbitrary key would mint a tag no
  product grants and no gate checks. **Enumerating tiers ignores `isActive`** (see below). Omit it
  for a single-tier association; an association
  that dropped its base tier refuses the empty choice rather than granting an orphan base tag. The
  grant and the XOR sibling revoke share one transaction, exactly like a paid purchase, so a manual
  add can never leave a user holding two forfaits (WP-COT-10). Requires `MANAGE_MEMBERS`.
- `GET /api/associations/:id/cotisation-tiers` backs the roster's forfait picker. Gated on
  `MANAGE_MEMBERS`, deliberately **not** `MANAGE_PRODUCTS`: whoever manages the roster must be able
  to pick a tier without also being allowed to edit the boutique.
- `POST /api/associations/:id/products/:productId/grant` -> `grantProductPurchase`: records a
  purchase *and* grants the tag like a real sale (leaves an audit trail in "Achats"). Requires
  `MANAGE_PRODUCTS`.
- `POST /api/associations/:id/tags` -> raw tag grant with an admin-supplied `tagName`/`expiresAt`
  (`MANAGE_MEMBERS`); `DELETE /api/associations/:id/tags/:tagId` revokes. The revoke is scoped to
  `:id`, not to the tag id alone: `MANAGE_MEMBERS` is granted per association, so an unscoped delete
  let an admin of any association revoke any other association's cotisant (WP-COT-9).

## Cotisation-dependent pricing on forms

A cotisation tier is one dimension a form's price grid may be divided on, alongside promo, formation
and the answer to a question. `SubmitterFactsService` assembles the caller's facts (which tier they
hold, their promo, their formation), `pricing/price-matrix.ts` resolves them to exactly one cell, and
the same resolution runs in the submission-status endpoint so the form page shows the real total
before payment. No coupon or code is involved.

The predecessor was a single hard-coded "cotisants pay less" axis (`memberPriceEnabled`,
`basePriceMember`, `priceModifierMember`), dropped by migration `051`.

## Cercle integration (outbound + inbound)

Cercle (external service) tracks a per-user cash **balance**; Canari tracks **cotisant status**.
Each service is the source of truth for its own half, and neither caches the other's data.

### Outbound: Canari -> Cercle (`balance_topup` webhook)

When a `balance_topup` product (created at `/admin/cercle`, global admin only) is purchased via
Stripe, `ProductsService.dispatchCercleWebhook` (`products.service.ts`) POSTs the recharge to the
product's `webhookUrl`:

- **Signature**: `X-Canari-Signature: sha256=<hex hmac>` - HMAC-SHA256 of the raw JSON body, keyed
  by the product's own `webhookSecret` (set per-product, not a shared env secret). The `sha256=`
  prefix is part of the contract (the GitHub/Stripe convention) and the receiver must strip it
  before decoding: `Buffer.from('sha256=<hex>', 'hex')` stops at the first non-hex character and
  yields an EMPTY buffer, so a comparison against it fails on length rather than on the digest -
  a receiver that forgets the prefix rejects every delivery while looking like a secret mismatch.
- **Payload**: `{ productId, userId, amountCents, paymentIntentId, timestamp }`. `userId` doubles as
  the OIDC `sub` (see below) and `paymentIntentId` is the idempotency key.
- **Retries**: 3 immediate attempts (`CERCLE_RETRY_DELAYS = [1s, 5s, 15s]`), then an automatic
  ladder on a lengthening backoff (`CERCLE_AUTO_RETRY_BACKOFF = [5min, 30min, 2h, 6h, 24h]`) driven
  by `CercleDeliveryScheduler` every 5 minutes, then a manual retry from `/admin/cercle`.

**One `webhook_deliveries` row per top-up**, updated in place by every later attempt - never one row
per attempt. That is the shape the whole feature depends on, and getting it wrong is what made the
retry button look dead: a retry that INSERTS leaves the failure it was pressed on in the list
whatever happens, so a success adds an invisible `delivered` row and a failure adds a second
visible one. Consequences worth knowing:

- `attemptCount` is the TOTAL number of sends for that top-up, across the initial dispatch and every
  retry since. `autoRetryCount` is separate and counts only automatic ones, because the initial
  dispatch already burns three attempts and a shared counter would report the automatic ladder as
  exhausted before it started.
- `nextAttemptAt` is when the scheduler will try again. **Null on a `failed` row means the automatic
  ladder is exhausted and a human must act** - which is exactly what the `/admin/cercle` failure
  list is for. A delivery still failing a day later is a configuration problem, not an outage, and
  retrying it forever would hide it.
- The payload and the signature are rebuilt **on every attempt** from the product as it stands, so
  a corrected `webhookUrl` or a rotated `webhookSecret` takes effect with no change to the row. A
  product that has lost its webhook configuration takes its deliveries OFF the ladder instead of
  retrying into the void.
- A **manual** retry is exactly ONE attempt: re-running the 3-attempt ladder sleeps 5s then 15s with
  a 10s timeout each, so the admin's request could hang for the better part of a minute and time out
  at the proxy. It also resets `autoRetryCount`, since pressing it means something was fixed.
- The weekly GC (`purgeDeliveredWebhooks`) only deletes `delivered` rows older than 30 days, so a
  failure is never swept out from under the ladder.

`listWebhookFailures` returns a `FailedDelivery` DTO, not the entity: the row carries two uuids and
neither tells an admin whose top-up is stuck, so the member's name and the product's are joined in.
A member who no longer exists stays `null` rather than getting a placeholder - "the account is gone"
and "the Cercle refused it" call for different actions.

A `balance_topup` product is always `allowRepeatPurchase: true` with both purchase caps cleared
(forced on create AND on update): a recharge is repeatable by nature and credits an account on
another site, so it can never run out. The default `false` made `assertCanPurchase` refuse every
top-up after a user's first one.

**`webhookSecret` never leaves the server.** Products are returned through `toSafeProduct`, which
nulls it and adds `webhookConfigured: boolean`. It had no projection at all before: `/products/all`
answers every logged-in user, and a signature is worthless once its key is in a JSON response.
`webhookUrl` is returned - it is the Cercle's public endpoint, and the admin form must show it.

**A CASH GRANT MAY NOT BE RECORDED AGAINST A TOP-UP PRODUCT** (`grantProductPurchase`, refused with
a 400). The manual grant on an association's Achats tab records a sale in Canari's books and passes
`dispatchWebhook: false`; even if it did not, the dispatch requires a `stripePaymentIntentId` and a
cash sale has none - the intent IS the idempotency key the Cercle deduplicates on. So the line would
read as a recharge, credit nothing on the Cercle, and no retry could ever repair it, because there
is no key to retry under. The type is also filtered out of the grant selector, but the selector is a
courtesy and the server check is the control. **The bar credits a member from the Cercle's own till
screen**, which writes its own ledger line.

**There is no test lever left on this path.** `/admin/cercle` used to carry a button that ran the
whole production credit for the pressing admin on a synthetic `pi_canari_test_` intent; it was
removed on 2026-08-28 (see `CHANGELOG.md`) because a control that credits a real balance on another
system, and writes a real accounting row, is not a test. What now proves the link is a real purchase
through the boutique, and the delivery list on `/admin/cercle`.

**The outbound half is live and proven against the real Cercle (2026-08-03)**: deliveries land on
the first attempt, and on the Cercle they produce one `ledger` row (`type='topup'`, `uuid_staff`
null - no human behind a Canari credit) plus one `canari_ledger_details` row carrying the intent.
Replaying an intent returns 200 `duplicate: true` and moves nothing, enforced by a `NOT NULL UNIQUE`
column rather than by an application check; a forged signature, a negative amount and a future
timestamp are refused (401/400/422) with no ledger write. See
[../PROD-TEST-CERCLE.md](../PROD-TEST-CERCLE.md) for the exact probes.

#### What debugging that link cost, so it is not paid twice

- **`webhookUrl` must be the FINAL https URL.** The dispatcher sets `maxRedirects: 0` and accepts
  2xx only, so an `http://` value that would redirect fails every delivery.
- **An undeployed SvelteKit route answers an HTML 404**, which is indistinguishable from a broken
  receiver: for a webhook, "not working" and "not deployed" are the same status code. Probe the route
  before reading the code.
- **A 404 from a real receiver is a failed delivery, not a lost payment**: a user who has never
  signed into the Cercle does not exist there yet, and the manual retry is what fixes it once they do.
- **Compare secret FINGERPRINTS before anything else.** Every mismatch on this path presents as "the
  secrets differ", including the ones that are not - the `sha256=` prefix bug above presented exactly
  that way while both secrets were identical.
- **A delivery id is not an authorization.** Retry and delete resolve the product through
  `associationId` as well, or an admin of any association acts on another's top-up.
- **Prove idempotency by re-signing a FRESH body** with the same key field, never by replaying the
  exact bytes: byte-identity would pass even if the deduplication were a checksum of the request.
- **An integrity check that is permanently red because of fixture data is not a monitor.** Seed rows
  need the same opening ledger entry real rows get, or nobody can ever act on the alarm.

### Inbound: Cercle -> Canari (`GET /api/public/cotisant-status`)

Before crediting a recharge or granting a forfait-priced action, Cercle can query a user's live
cotisant status:

```
GET /api/public/cotisant-status?assoSlug=<slug>&sub=<oidcSub>
X-Api-Key: <CERCLE_API_KEY>

200 -> { "isCotisant": boolean, "tier": string | null, "expiresAt": string | null }
```

- **Auth**: `X-Api-Key` matched (timing-safe) against `CERCLE_API_KEY`; unset/mismatched key ->
  403. Rate-limited (20 req/min) via `@nestjs/throttler` to blunt key brute-forcing. Reachable
  through the nginx `/api/public/` location, which skips `auth_request` and strips client-supplied
  trust headers - this endpoint's own guard is the only auth in front of it.
- **No id-mapping needed**: `sub` (the caller's OIDC subject) IS the Canari `userId`
  (`findOrCreateFromOidc` uses `userinfo.sub` as the primary key), so Cercle can call this directly
  with the `sub` it already has from its own OIDC session.
- **`tier`** is the held product's `variantKey` (`null` for a single-tier association or a
  non-cotisant); `expiresAt` is ISO 8601 or `null` for a lifetime tag. Implemented by
  `ProductsService.getCotisantStatusBySlug`, which reuses the same tier-enumeration pattern as
  `isBuyerCotisant`/`cotisantStatusFor` rather than a separate tag-derivation path.
- Canari is authoritative for this half and answers live; **whether the Cercle caches the answer is
  the Cercle's choice, and today it does.** Its `syncCanaryMembership` maps the reply onto
  `users.id_membership` and re-runs only when the 5-minute session JWT is refreshed, so an active
  user costs ~1 request per 5 minutes. With the 20 req/min throttle counted per source IP, and the
  Cercle being one IP, that puts the ceiling near 100 concurrent users. Past it the throttle answers
  429, which the Cercle treats like any fetch failure: it falls back to the stored membership, so
  the bar keeps working on slightly stale tiers rather than locking everyone out - except for a user
  logging in for the FIRST time, who has nothing stored to fall back on.

Setting both directions up on the real hosts, and the checks that prove the link works there, are in
[../PROD-TEST-CERCLE.md](../PROD-TEST-CERCLE.md).

## Permissions

`MANAGE_MEMBERS` is granted **per association**, so a tag revoke must be scoped to
`issuingAssocId`: deleting on the tag id alone lets a manager of one association strip a tag issued
by another - a cross-tenant IDOR (WP-COT-9).

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
| DELETE | `/api/associations/:id/tags/:tagId` | Revoke a tag issued by `:id` (`MANAGE_MEMBERS`) |
| GET | `/api/associations/:id/cotisants` | Paginated, searchable active roster (`MANAGE_MEMBERS`) |
| POST | `/api/associations/:id/cotisants` | Grant a tier's tag only, no payment (`MANAGE_MEMBERS`) |
| GET | `/api/associations/:id/cotisation-tiers` | Tiers offered, for the manual-add picker (`MANAGE_MEMBERS`) |
| GET | `/api/associations/:id/cotisants/export` | Roster as `.xlsx` (`MANAGE_MEMBERS`) |
| GET | `/api/associations/products/all` | All active products + per-product `viewerIsCotisant`/`viewerActiveTier` (shop) |
| POST | `/api/associations/:id/products` | Create a product (incl. `type: 'membership'`) (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for a product |
| POST | `/api/associations/:id/products/:productId/grant` | Manual purchase + tag grant (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/webhook-failures/:deliveryId/retry` | Re-fire a failed Cercle delivery (`MANAGE_PRODUCTS`, scoped to `:id`) |
| DELETE | `/api/associations/:id/webhook-failures/:deliveryId` | Drop a failed delivery settled by hand (`MANAGE_PRODUCTS`) |
| POST | `/api/forms/:id/submit` | Submit a form; applies member pricing, may grant a tag |
| GET | `/api/public/cotisant-status` | Cercle-facing live cotisant status by `assoSlug`+`sub` (`X-Api-Key`, not `MANAGE_*`) |

## See also

- [frontend/modules/associations.md](frontend/modules/associations.md) - association model, permission flags, admin panel tabs.
- [services/social-service.md](services/social-service.md) - service boundaries (associations, user tags, forms).
- [frontend/modules/admin.md](frontend/modules/admin.md) - platform admin surfaces, including `/admin/cercle` (Cercle top-ups).
- [frontend/modules/payments.md](frontend/modules/payments.md) - Stripe Connect and the shop/checkout flow.
- [../user-guide/membre.md](../user-guide/membre.md) - "Cotiser a une association" (end-user guide).
- [../PROD-TEST-CERCLE.md](../PROD-TEST-CERCLE.md) - production runbook for the Canari <-> Cercle link.
