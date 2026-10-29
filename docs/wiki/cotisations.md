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

### A tag counts only for the association that issued it

One invariant, enforced at four points:

- **A raw grant names one of the grantor's own tiers.** `POST :id/tags` (`grantTagForAssociation`)
  accepts a name only when it is one of the association's own cotisation tier tags for the current
  academic year - its catalogue, `listCotisationTiers` - and answers `403 TAG_NOT_ISSUER_TIER`
  otherwise. Ownership is read from the catalogue, never from the shape of the name: a slug prefix
  says nothing about who issues a tag. The tier is then granted exactly like the roster's manual
  add (`grantCotisant`): the buyer's tier lock, the sibling-tier XOR, unranked as a manager's
  decision; an explicit `expiresAt` replaces the derived expiry.
- **A grant never crosses issuers.** `grantOrRenew`'s upsert updates an existing `(userId, tagName)`
  row only when it was issued by the same association (`DO UPDATE ... WHERE "issuingAssocId" IS NOT
  DISTINCT FROM EXCLUDED."issuingAssocId"`). Otherwise it writes nothing and throws
  `TagHeldByAnotherIssuerError` (`409 TAG_HELD_BY_ANOTHER_ISSUER`): a settlement records the
  payment `paid_not_granted`, a paid form's grant answers it as a refusal (also
  `paid_not_granted`), and the cash sale, the manual add, the legacy claim and the raw grant
  surface the 409. No grant is ever reported for a row the reads below would not count.
- **Tier-holding reads count only rows issued by the tier's own association**: `hasActiveTag` and
  `getActiveTag` take the issuer, so `heldVariantKeys` (the rank of a grant, `holdsAnyCotisation`,
  `listHeldCotisationTiers`), `heldCotisationTiersByAssociation`, the shop's `tierFactsOf` and
  listing facts (relation, preferential price, rank), the renewal check and the Cercle status all
  ask "issued by THIS association". The sibling-tier XOR (`revokeByName`) deletes only the
  association's own rows, like `revoke`. A product's `requiredTags`, a gate that names tags across
  associations by design, is the one reader of `hasActiveTagFromAnyIssuer`.
- **Two associations' tag names never coincide.** A tier's tags are `cotisant:<stem>` or
  `cotisant:<stem>-<academicYear>`, its stem being `<slug>` or `<slug>-<variantKey>`
  (`cotisationStem`). Two stems derive a common name exactly when they are equal or one is the
  other plus `-<academicYear>` (`cotisationStemsCollide`). `assertCotisationStemFree`
  (`associations/cotisation-namespace.ts`, `409 COTISATION_TAG_COLLISION`) refuses a new stem that
  collides with another association's slug or tier stem, on every path that creates one: the
  association's creation, a tier's creation and a tier's retag. **A future path that derives a slug
  or a tier key calls it with the derived value.** It takes no lock: no lock of the order spans
  two associations, and a race between two creations is bounded by the two points above (a
  collision can refuse a grant, never let one association's row count for another's tier). A retag
  is also refused
  (`409 TIER_TAG_NAME_TAKEN`) when a holder of the old tag already holds a row of the new name.

`tag-issuer-scope.integration.spec.ts` proves each point against a real PostgreSQL.

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
never drifts from `deriveCotisationTag`. `ProductsService.update` drops `grantedTagName` and
`tagExpiresAt` for a membership product the same way, and `resolveGrantTag` derives NOTHING for a
membership product whose association has no `cotisationMode`: a stored tag string is never granted as
typed, so every tag a membership purchase issues is a derived tier tag. **What is recorded then:**
with cotisations disabled, the checkout opening and the cash sale of such a product are refused
`409 COTISATION_DISABLED` before any payment is requested or recorded; a payment that lands anyway
(an attempt opened before the switch) is recorded `paid_not_granted` with an ERROR line, like any
paid tier not granted, so the hourly report and the purchases tab see it. Creating a membership product
requires cotisation to already be enabled (`cotisationMode` set), since the tag can't be derived
otherwise.

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

### A new tier's key is derived from its label (server, 2026-10-26)

Decided by the user: the key (`variantKey`) is a TECHNICAL id that no person types, sees or edits.
`POST /api/associations/:id/products` accepts `deriveVariantKey: true` on a `membership` product sent
WITHOUT a `variantKey`; `ProductsService.create` then derives the key from `name` with
`variantKeyFromLabel` (`cotisation-tag.util.ts`): lowercase, ASCII-folded, every other run of
characters one hyphen, a year-shaped tail dropped, `palier` for a label with no letter or digit, and
`-2`, `-3`... until it is free among the association's tiers (the base tier's null key never
collides). Everything after is unchanged: `deriveCotisationTag` names the tag from that key, the
sibling XOR and the base tier (`variantKey: null`) are untouched.

- **Two creates at once get two keys.** Nothing in the table makes a key unique, so the sibling read
  and the insert run in ONE transaction under `lockAssociationTiers` EXCLUSIVE - the retag's lock
  (`users/buyer-tier-lock.ts`: `pg_advisory_xact_lock(hashtextextended('tier:<associationId>', 0))`),
  every read on that transaction's manager. The second create waits for the first to commit and
  then sees its row. Everything that may call another service (payment routing) runs BEFORE the
  lock. `tier-key-derivation.integration.spec.ts` holds it against a real PostgreSQL, and fails
  with the lock removed. A unique index would be a migration, proposed in
  [backlog](backlog.md#p3---post-stable-proposal-for-the-user-a-partial-unique-index-on-tier-keys-2026-10-26).
- **The key fits the tag.** A tag is `varchar(100)`, and the dated form
  `cotisant:<slug>-<key>-YYYY-YYYY` is the longest, so `variantKeyCap(slug)` is 100 minus that
  form's fixed part minus room for a `-999` suffix, at most 60. A slug that leaves no room is
  refused with a 400 rather than truncated into a tag that no longer derives.
- **No key ends in a year.** A dated tag already ends in the academic year, so a key such as
  `cotisation-2026-2027` would make one tier's tag read like the dated tag of a `cotisation` tier.
  "Cotisation 2026-2027" derives `cotisation` (then `cotisation-2` if taken); a year INSIDE a label
  ("Gala 2026 VIP") stays, and so does a single year ("Promo 2024" derives `promo-2024`).
- **A derived key is never refused (decided 2026-10-28).** The derivation AVOIDS every shape a typed
  key is refused for, rather than letting the label earn a refusal about a key the manager never
  saw: it never matches `YEAR_SHAPED_VARIANT_KEY` (the one pattern `assertVariantKeyFree`'s
  `TIER_KEY_YEAR_SHAPED` also reads - the year tail is removed again after the length cap, and a
  suffix of at most three digits cannot form a year), and a candidate whose stem collides with
  another association's (`stemCollidesElsewhere`, `assertCotisationStemFree`'s comparison) steps on
  to the next suffix. Chosen over a dedicated refusal message because it stays a pure,
  deterministic function of the label and the existing stems. The one refusal left is the
  exhaustion of `-2` ... `-999` (409 `TIER_KEY_EXHAUSTED`), since a longer suffix would overflow the
  tag column.
- **A derived key never re-adopts a deleted tier's holders.** A tier deleted before the delete guard
  can have left ACTIVE holders of its tag (the hourly orphan count). Recreating the same label would
  give the same key, and every such holder would silently become a holder of the NEW tier (its
  member pricing, its `cotisant-status`). So a candidate whose stem this association still has an
  active `user_tags` row of (`heldTierTagNames`, read in the same locked transaction) is skipped
  like a taken key: "Avec alcool" recreated over an orphan derives `avec-alcool-2`. **A TYPED key
  (older clients) is not checked against it and can still re-adopt those holders** - that path is
  unchanged.

- **Older clients keep working**: an explicit `variantKey` is still honoured on create and update.
  Sending both is refused (400), and so is `deriveVariantKey` on a non-membership product.
- **The key is fixed by a label edit**: `update` changes a tier's key only when `variantKey` itself
  is sent (`planTierRetag`, the conversion below); a rename alone leaves the key, the tag and every
  cotisant holding it where they are. A spec holds this.
- **The client reads a CAPABILITY before offering tier creation**: `GET
  /api/associations/:id/cotisation-options` answers `tierKeyFromLabel: true`. The global
  `ValidationPipe` (`whitelist: true`) STRIPS an unknown field, so an older social-service would
  silently drop `deriveVariantKey` and create a BASE tier instead of the named one asked for. A
  client that does not read the field therefore offers no tier creation at all - it never tries
  and classifies the failure. **social-service is never rolled back below the first release
  publishing the field**: a client that read it would create a base tier against the older server.

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
| The platform `paymentProvider` is saved as active (core `PlatformService.updateConfig`), or a global admin presses **Release withheld products** (`POST /api/users/admin/platform/release-withheld-products`) | social `POST internal/payments/provider-activated` -> `releaseWithheldForAllAssociations` | every association holding a withheld product |

**The platform-wide sweep answers `{ released, failed }`, and core refuses a partial one** with a 502
whose body carries the typed code `WITHHELD_RELEASE_INCOMPLETE` and the SAVED config: the provider IS
switched, only the release is missing, and the admin screen says exactly that (by code, never by
message). The retry is the explicit button, never re-saving the form: the form PATCHes only what
changed since its snapshot, so after a reload it sends no provider at all. **An orphaned withheld
product is skipped, not failed** - `association_products` has no foreign key to `associations`,
deleting an association leaves its products behind, and counting one as a failure would make every
activation answer 502 forever; the skip is logged with the ids. **The canonical cotisation
(`provisionCotisationProduct`) is withheld like any other product** when payments are not ready, so
the same releases put it on sale.

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
both), and inactive tiers are swept too: a tier taken off sale is still held by its cotisants. Because
the XOR REPLACES the held tier, a buyer may only buy a sibling tier that is a rise - next section.

### Rising to a higher tier

Decided by the user on 2026-10-26: a holder of a lower tier pays only the complement to rise, and a
holder of the highest tier is not offered membership.

**The complement IS the admin's preferential price - nothing is computed.** It is the stored pair
`memberPriceTag` (which sibling tier qualifies) + `amountCentsMember` (what its holders pay) on the
dearer tier - the pair the admin screen presents as one sentence, "a holder of [tier] who moves to X
pays [N] EUR instead of the full price". The Cercle set it in production on 2026-10-26 on the
alcohol tier (full price 30 EUR, 15 EUR for holders of the other tier). A rise to a tier with NO pair
set is charged in FULL; setting it is the admin's job, and making that visible is the admin
screen's. An automatic `target - held` was designed and dropped the same day: it would have
duplicated or contradicted the admin's setting. `tier-pricing.ts` `fixedPriceFor` is the ONE
function that picks the amount, called by the checkout (`resolvePurchase`) and the listings alike.
**The complement price freezes when the checkout opens**: the attempt row stores the amount asked,
and settlement records the row's amount, never a re-read of the product - an admin who edits the
preferential price while the buyer is paying changes the next checkout, not this one.

**`memberPriceTag` names a TIER, read at use time.** The column stores a tag string, and a `dated`
association's tags change every academic year - an exact match on the saved string would have
stopped the preferential price at the first rollover. `linkedTierKey` reads the string as the
sibling tier whose tag STEM it carries (with or without a year suffix), and the buyer qualifies when
they hold that tier's CURRENT tag. Save time enforces what read time assumes: the tag must name
another tier of the same association, and `amountCentsMember` must be above zero and below the full
price (checked only when a request touches one of the three columns, so an older row still saves its
other edits). Renaming a tier's `variantKey` re-points the siblings linked to it in the same
transaction. A link that still names no tier (a row from before these rules) applies no
preferential price and logs at WARN, once per product per process (`memberPriceTierKeyOf`) - judged
only when the viewer's tiers were read: a guest holds nothing, so the link is not judged on every
public page view.

**What the server refuses (`assertTierIsARise`, on every `membership` checkout).** Rank comes from
DATA with no stored ordinal and no migration: `variantLevel` is null in production and only ever
sorted the shop. `tierRelation` compares the target's PRODUCT price (`amountCents`, never what the
holder paid) with the held tier's. A buyer holding several tier tags is ranked against ONE of them,
picked deterministically by `pickHeldTier`: an unrankable one first, else the dearest, ties broken
by key (named tiers in code-point order, the base tier last). The verdict is taken BEFORE the
purchase records are read, so the code does not depend on how the held tier was obtained:

| Relation | When | Checkout |
|---|---|---|
| `none` | nothing held | sold as before |
| `higher` | target price `>` held price | sold, at `fixedPriceFor`'s amount; the XOR swaps at settlement |
| `held` | the target is a held tier - ANY of them, the cheaper of two included (`tierRelationOf`) | 409 `PRODUCT_ALREADY_PURCHASED`, paid for or granted |
| `lower` | target price `<=` held price | 409 `TIER_NOT_A_RISE` - equal counts |
| `unranked` | a tier is held and either side has no fixed price (grid, free amount) | 409 `TIER_NOT_RANKABLE` - no rank is guessed |

**A paid form that grants a tier is held to the same rule, before any payment.** `submit` asks
`UserTagService.rankCotisationTier` (the same `rankTier` decision the ranked grant takes) for every
answer that owes money, online or in cash, and refuses through `formTierRefusal` (`tier-pricing.ts`:
the checkout's `tierRefusal` mapping, with two codes a form words its own way). `lower` and
`unranked` answer the shop's codes and sentences; the tier already held answers
`409 FORM_TIER_ALREADY_HELD` ("you already hold the membership this form grants", not the shop's
"already bought this product"); and a form whose `cotisationVariantKey` names a tier that no longer
exists - its product was DELETED; a tier only taken off sale stays in the catalogue and is ranked as
usual - answers `409 FORM_TIER_NOT_SOLD` to EVERY submitter, a holder of nothing included,
checked against the tier catalogue before any rank (the grant validates against that catalogue and
would throw on it). It is a pre-check outside any lock; the grant re-ranks under the buyer's lock when
the money lands (`grantCotisantIfARise`), and a refusal there is the `paid_not_granted` case below.

**Two attempts, one tier.** Opening a checkout of a tier first settles the buyer's open attempts of
EVERY sibling tier (`productsToSettleBefore`): cancelled at the provider, or recorded if already
paid. That runs before the lock, so two tabs could both pass it; under the lock the opening also
refuses `CHECKOUT_IN_PROGRESS` while ANY open attempt of a sibling tier exists
(`assertNoSiblingAttemptOpen`) - the partial unique index covers only the same product.

**The settlement grants on what the opening decided, never on a price (user, 2026-10-27).** The
opening freezes WHICH tier it ranked against on the attempt row: `product_checkouts.heldTierProductId`
(migration 112), the product id of `pickHeldTier`'s choice, null when nothing was held. A product id
rather than the tier key, because a retag renames the key between an opening and its settlement while
the id stays; and an opened checkout over a held tier always has that tier's product (a held tag with
no product is `unranked`, refused at the opening). The settlement re-reads, under the buyer's lock,
only WHICH tiers the buyer holds now, and `settlementVerdict` (`tier-pricing.ts`) decides with no
price at all:

| Held now | Verdict | Granted |
|---|---|---|
| nothing, and the opening froze nothing | `nothing-held` | yes - the XOR replaces nothing |
| nothing, where the opening froze a tier (it expired or was revoked since, or its product is deleted) | `frozen-gone` | no - the price paid was a rise over a tier the buyer no longer has |
| only the frozen tier (matched by product id, so a retag still matches) | `as-opened` | yes - what the opening decided |
| the target itself | `held` | no |
| any other tier: obtained since, held where the opening saw none, or a second one beside the frozen tier | `held-changed` | no |

An admin who edits a tier's price between the opening and the payment therefore changes nothing. A
row opened before migration 112 carries NULL and settles as "nothing was held": the cautious reading,
since a buyer who holds a tier then lands in `paid_not_granted` - reported, and closed by a person -
rather than having it replaced. No `status` value was added to `product_checkouts`: a paid rise not
granted is still a `paid` attempt.

**Paid and not granted is a durable state, `paid_not_granted`.** A settlement verdict that does not
grant (above) leaves the held tier alone, so the XOR cannot replace it. The payment is recorded with status `paid_not_granted` on
`purchase_records` (a varchar with no CHECK - no migration), logged at ERROR, listed with a "Not
granted" mark in the association's purchases and its export (it is money received), never counted
as having bought the product, and counted every hour by `PaidNotGrantedScheduler` (:29, `count=0`
at log, ERROR while non-zero). `receivedStatus` (`purchase-record.entity.ts`) is the one place the
status is chosen from "delivered or not", for the boutique and the forms alike. Three more payments
take the marker: a settlement whose product row was DELETED while its buyer paid (nothing can be
delivered, no tag, no top-up - logged at ERROR, a refund is owed); a paid form whose payment landed
with no seat (`paid_over_capacity`), so no grant ran; and a form payment whose record is written by a
call that ran no grant itself (a replay after the record write failed) - that call reads whether the
submitter holds the form's tier NOW (`formTierDelivered`), the only durable trace of what the earlier
grant decided. A grant that FAILED (retryable) in the same call is marked too, since nothing is held
when the record is written; a later replay that grants it does not clear the mark. That read
OVER-marks by design - a replay racing the run still granting, a retried grant, a tier risen from
since - so the mark, the purchases hint and the hourly line all say to check what the buyer holds
before refunding, never that a refund is owed. The mark stays as history; the payment leaves the hourly count only when a person CLOSES it (below), never by a clock.

**Closing a marked payment (user, 2026-10-27).** A refund or a grant by hand is owed; the manager
records which one happened from the purchases list ("Mark refunded" / "Mark granted", an in-app
confirmation). `POST /api/associations/:id/purchases/:purchaseId/close` with `{ outcome }`, guarded
`MANAGE_PRODUCTS` like the rest of that list, writes ONE row in `purchase_record_closings` (migration
113: the record id, `refunded` or `granted`, `closedByUserId`, `createdAt` from the server's own
`now()`), unique per purchase record. The record keeps `paid_not_granted` as history, the list and the
export show the outcome beside the mark, and the hourly count reads only the marked records with NO
closing row (`countUnclosedPaidNotGranted`). No clock closes anything. Each closing writes one `[SHOP]
[AUDIT]` line naming the outcome, the manager, the association and the buyer.

**`granted` performs the grant, and only a protected one (decided 2026-10-27, after review).** It
grants the tier paid for IN the same transaction, through the manual grant path
(`grantCotisantWithin`): a boutique record's tier is its product's, a paid form's is the form's
`cotisationVariantKey`. But first `closingGrantVerdict` decides, under the buyer's tier lock and on
the record LOCKED `FOR UPDATE`, and refuses with a typed 409, nothing written:

| Refusal | Code | Why only a refund is left |
|---|---|---|
| `buyer-erased` | `PURCHASE_BUYER_ERASED` | the buyer is an erased account (`[deleted]`, or `[deleted]:<id>`, `isErasedAccount`): a grant would mint a cotisant out of the placeholder |
| `tier-gone` | `PURCHASE_TIER_GONE` | the product or form names no tier any more, the association has no mode, or the catalogue `grantCotisantWithin` validates against lacks it - so that grant's own 400s never surface |
| `year-over` | `PURCHASE_YEAR_OVER` | a `dated` association, and the academic year of `paidAt` is over: the tier it bought cannot be granted for another year |
| `target-held` | `PURCHASE_TARGET_ALREADY_HELD` | the buyer holds the tier paid for, and its tag is NOT this payment's delivery: granting would only renew it, and the closing row would take off the report a payment still owed a refund. Whether the held tag IS the delivery is read from its provenance first (`deliveryOf`): a tag already stamped with another record (`metadata.purchaseRecordId`), granted by another payment (`paymentIntentId` present and not this record's - a null on either side matches nothing, and a paid grant never falls back to time), by a legacy claim (`legacy`), or by a form answer that is not this record's (`submissionId`) is refused, however recent. A form answer counts as this record's only when it is an answer to this record's form, by its buyer, AND the buyer has exactly ONE paid record AND exactly ONE paid answer (`paid`/`paid_over_capacity`, `totalPaid` > 0) for that form: a purchase record names no answer, so with two the tag cannot be told to be this one's, and the manager grants or replaces explicitly instead (no migration was added for it). The answers are counted too because fulfilment writes the grant, then the record, apart and outside the tier lock: a second paid answer whose record is not written yet would otherwise read as ONE. Manual and cash grants write `paymentIntentId` null, so they never count as a delivery: a cash record closes only by a refund or an explicit grant. That answer is the delivery whatever the times (the replay that raced the run still granting), and so is this payment's own intent. A tag with no provenance - a manager's roster grant, which the hourly report asks for - is the delivery when first granted after `paidAt`. A delivered closing records `granted`, grants and renews nothing (no validity change), and only stamps the tag with `purchaseRecordId`, so ONE delivery closes ONE payment; the stamp writes only an unstamped tag. **Accepted (2026-10-28):** a manager who revokes the tier and grants it afresh makes a new tag with a new `createdAt`, which counts as a delivery. The closing is manager-attested: the same person could equally record `refunded` falsely, and the hourly ERROR line is what tells them to grant by hand. Nothing engineers around it. **Also accepted (2026-10-28):** a tag row reused across academic years keeps its old keys - `legacy`, a past `submissionId`, a past stamp - so a returning member's roster re-grant over such a row is refused by `deliveryOf`, as it was by time before (a renewal keeps the row's first `createdAt`); the manager then records `refunded` or grants explicitly. A `granted` closing carries what the list showed (`expectDelivered`, the row's `delivered`): when that is no longer so - a tag revoked between the list and the click - it is refused `409 PURCHASE_CLOSING_CHANGED` and writes nothing, so a confirmation saying "nothing is granted" never grants. The list reads its closing advice in a fixed number of queries per association, whatever the number of open rows (`closingContextOf`), the same reads the closing makes for its one locked row |
| `not-a-rise` | `PURCHASE_NOT_A_RISE` | ranked like a checkout (`tierRelationOf`, product prices, against the DEARER tier when two are held), the tier is `lower`: granting would move the buyer DOWN, the XOR revoking a dearer tier bought since |
| `not-comparable` | `PURCHASE_TIER_NOT_COMPARABLE` | the tier paid for or the one held has no fixed price (a grid, a free amount): `unranked`, which cannot be told from a move down |
| `held-tier-deleted` | `PURCHASE_HELD_TIER_DELETED` | `unranked` because the tier held is the tag of a DELETED tier (an orphan, [below](#a-tier-deleted-while-people-still-hold-it)). Unlike the rows above a repair exists, and the sentence names it: a manager grants the tier from the roster - its sibling swap removes the orphan - and the closing then finds that grant as the delivery |

`none` and `higher` grant. The SAME function answers the purchases list without the lock, as advice:
an open marked row carries `grantRefusal` and `buyerTier` (the tier the buyer holds now, read before
any refusal so even an early one names it; none for an erased buyer), shows that tier and the reason, and offers "Mark refunded" only when a refusal stands. `refunded` is never
refused this way, so the report can always be drained, and takes no tier lock (it writes no tag).
Other refusals: 404 for a record of another association (every read is scoped to the PATH's
association), 409 `PURCHASE_NOT_CLOSABLE` (not marked), `PURCHASE_ALREADY_CLOSED` (the first outcome
stands; the unique index is the durable guarantee, and only a violation of
`purchase_record_closings_one_per_record`, by constraint name, is read as one). Every 409 re-reads
the list in the panel, so the row shows the state that refused it.

**The export says what is kept.** `Montant` is what was received; `Montant conserve` is 0 for a
refunded payment, so a sum of it is the income and never counts money that went back. An OPEN
payment not granted still counts as kept until its refund is recorded: its `Statut` says it is to
settle.

**Erasure and the tier paths queue, they do not deadlock nor leave a real id.** The erasure rewrites
`product_checkouts`, then `purchase_records`, then deletes `user_tags` (`ERASURE_TIER_ORDER`, its
order pinned by `account-erasure.spec.ts`): the order a settlement (checkout row, then its new record,
then the tag) and a closing (record, then tag) take. Checkouts FIRST matters: an erasure meeting a
settlement mid-flight waits on its checkout row, so the record that settlement inserts is committed
before the erasure rewrites `purchase_records` - records first would miss it and leave the real id
(the interleaving is tested against PostgreSQL). An erasure first is seen by both: a closing refuses
`PURCHASE_BUYER_ERASED`, and a settlement of a checkout already rewritten to `[deleted]:<id>` records
`paid_not_granted`, grants nothing and dispatches no top-up (a refund is owed). That record carries
`[deleted]`, the one form the erasure writes on `purchase_records` - the `[deleted]:<id>` form stays
on `product_checkouts`, whose partial unique index needs one value per row - so a count by `userId`
on `purchase_records` finds every erased buyer's payment. One that runs second
rewrites the record the other committed and deletes its tag.

**The frozen tier, and a buyer holding two.** Two tier products sharing the held key (a catalogue from
before keys were unique per association) freeze the smallest product id and log a WARN. If that
product is deleted before the settlement, the frozen key goes with it and the settlement reads
`held-changed`: marked, reported, closed by a person. A buyer holding TWO tiers at once is refused at
the OPENING (`TIER_NOT_RANKABLE`, WARN): ranked against one and frozen on it, the settlement would read
the other as `held-changed` every time and take the money for nothing. The rule lives in
`relationOf`, the call the listings share with the checkout, so such a buyer is shown every other
tier as `unranked` and offered no button. Production held no such buyer
on 2026-10-27 (every cotisant held one tier), so the refusal is cheaper than storing every held tier.
A paid form is NOT
covered by the freeze: it has no checkout row, and `grantCotisantIfARise` still ranks it on the
prices of its settlement.

**One lock per buyer per association decides the order, behind one per association.** Every
per-buyer path takes, in `lockBuyerTiers` (`users/buyer-tier-lock.ts`, the one implementation),
`pg_advisory_xact_lock_shared` on `tier:<associationId>` and then `pg_advisory_xact_lock` on
`tier:<associationId>:<userId>` (the one-key `hashtextextended(key, 0)` form the chat service already
uses). A tier retag takes the association key EXCLUSIVE (`lockAssociationTiers`) and never a buyer
key. THE ORDER, for every path: **association lock -> buyer lock -> checkout row (`FOR UPDATE`) ->
`user_tags`**. The second comer on a buyer blocks until the first COMMITS; every path reads the
products, the tier keys and the buyer's tags only AFTER both locks, so under READ COMMITTED it sees
the earlier commit. No clock, no retry; a hash collision could only make two keys wait for each
other.

| Path | Takes |
| --- | --- |
| Checkout opening (rank, amount, attempt row) | association shared + buyer |
| Settlement (re-rank, grant, XOR) | association shared + buyer |
| Cash sale (`grantProductPurchase`; the product re-read after the locks) | association shared + buyer |
| `grantCotisant` - the roster picker; tiers and tag derived after the locks | association shared + buyer |
| A paid form's grant (`grantCotisantIfARise`: ranked like a settlement, refused -> `paid_not_granted`) | association shared + buyer |
| Legacy claim (`grantCotisantUnlessHeld`: "already holds one" read under the locks) | association shared + buyer |
| Raw tag grant (`POST :id/tags`, `grantTagForAssociation`: one of the association's own tier tags, then the manual add's body) | association shared + buyer |
| Tag revocation (`revoke`: the holder read from the row, then the delete) | association shared + buyer |
| Closing a `paid_not_granted` payment (`closePaidNotGranted`: the record `FOR UPDATE`, then a `granted` grant) | association shared + buyer |
| Tier retag (`update` changing a `variantKey`) | association EXCLUSIVE only |
| Tier delete (`delete` of a `membership` product: the holder count, then the delete) | association EXCLUSIVE only |

**The retag is ONE transaction under the exclusive lock**: it re-reads the product, checks the key,
saves the renamed tier, re-points the sibling `memberPriceTag` links it reads INSIDE, and renames
every holder's tag. A per-buyer path that derived the OLD tag before the rename and wrote it after
would leave a tag the rename never saw; the shared lock makes it wait for the rename's commit. The
manual grants, the cash sale and the raw tag grant are a manager's decision and are NOT ranked: a
manager may still downgrade someone on purpose.

**Every read inside a locked transaction goes through that transaction's `manager`.** A read on
another pool connection would hold the lock while waiting for a free connection: ten such
transactions fill the default pool (10), each waits for an eleventh, and the service hangs for good.
`TypeOrmModule` also sets `extra.connectionTimeoutMillis: 10_000` in `app.module.ts`: node-postgres
waits forever by default (0), and 10 s is far above any query here, so a request that cannot get a
connection fails alone instead of everything hanging.

**Nothing that calls another service runs under the lock**, so a slow peer can never hold a buyer
waiting. A checkout opening is split in two: `preparePurchase` fetches the active payment provider,
the routing it gives and, for a grid priced on promo or formation, the buyer's profile - all before
the lock; `decidePurchase`, under it, reads only this database. It reloads the association and the
product by id and recomputes the routing with the provider already fetched; if ANY field of it
changed (`sameRouting`: provider, account, receiving association, readiness, delegation), it refuses
`409 PAYMENT_ROUTING_CHANGED` - no retry, nothing opened, and trying again uses the new account. The
profile is the one other input fetched before the lock: if the product re-read under it has a grid
that prices on promo or formation and the preparation did not fetch the profile (the grid was added
in between), it refuses `409 PURCHASE_PRICING_CHANGED` rather than price on the "everyone else"
cell or call out under the lock.

`product-tier-lock.integration.spec.ts` proves it against a real PostgreSQL, asserting every wait
through `pg_locks` rather than a timer: two concurrent settlements; a settlement and a checkout
opening each blocked on a held lock, then re-reading the grant made under it; a manual grant and a
settlement on one buyer, ending on one tier; two tabs opening two sibling tiers, one refused; a
retag and a settlement of the same tier, never leaving the old tag; and every locked path run on a
pool of ONE connection. With the lock, the sibling check or the manager-bound read removed, the
matching case fails. The same file proves the 2026-10-27 half: migrations 112 and 113 run twice
cleanly; an opening freezes the tier it ranked against; a price lowered between opening and payment
is still GRANTED; a tier obtained since the opening still marks the payment; a payment is closed once,
two concurrent closings leave one row and one typed refusal, `granted` grants by hand; and the hourly
count drops by exactly the closed payment. It also ranks a paid
form's pre-check against the real tables, and settles a payment for a deleted product.

A tier rolls over in `dated` mode, so the previous year's tag no longer counts as held. The
provider's own floor (`LYDIA_MIN_AMOUNT_CENTS` in core-service) still answers `AMOUNT_OUT_OF_RANGE`
before any request is issued.

**What the listings get.** `/products/all` and the per-association listing annotate every product
with `viewerTierRelation` (the checkout's `relationOf`, `none` for a non-tier or a guest),
`viewerDueCents`: what a checkout would charge THIS viewer now - null for a refused tier, the grid's
cell for a gridded product, null for a free amount - `cotisationDisabled` (a membership product of
an association with no cotisation mode, which the checkout refuses `COTISATION_DISABLED`; its
`viewerDueCents` is null too), and `memberPriceTierKey` (the tier the product's `memberPriceTag`
names, read by `linkedTierKey`, absent when there are no tier facts). Purchase caps and tag gates are
not folded in. `/shop` and the association page display them through the SAME helpers
(`lib/pricing/viewerPrice.ts`) and never recompute money: the preferential price is `viewerDueCents`,
and a refused or disabled membership gets the reason instead of a button (see "Where it lives in the
UI" below); `paymentRefusal.ts` words each refusal code.

**A `memberPriceTag` that prices nothing is refused at save.** Create and update answer
`400 MEMBER_PRICE_TAG_NOT_A_TIER` when the tag names no OTHER cotisation tier of the product's own
association (another association's tag, a non-tier tag, the product's own tier): such a link would
charge every buyer the full price, silently. The tier form words that refusal for the manager from its
code (`tierSaveRefusal` in `frontend/src/lib/associations/tierKeyRefusal.ts`, beside the year-shaped
key refusal). Two rows can still carry one, and both are charged in
full with a `WARN` once per product per process: a row written before the rule (an unrelated edit still saves), and
a sibling whose linked tier product was DELETED - deleting a tier does not clear or refuse the links
naming it, so the admin re-points or clears them by hand.

**A paid form's grant never revokes a dearer tier.** `grantCotisantIfARise` ranks the target against
the ONE tier `pickHeldTier` picks, not against `heldKeys`: a user holding two legacy tier tags who
pays to renew the CHEAPER one gets `lower` (or `unranked`) - refused before any payment by the
form's pre-check, or, when that changed only after the payment opened, recorded `paid_not_granted` -
rather than renewing the cheap tag and letting the sibling XOR revoke the dearer one.

### A tier deleted while people still hold it

Every read above derives a holder's tier from the membership products that EXIST: a tag counts as
tier X only because a product with key X derives it. Deleting a tier product therefore left its
holders with a tag that named nothing - ranked as holding NO tier (`none`), they could buy any tier,
a cheaper one included, and the sibling XOR, which revokes only the tags of existing tiers, never
dropped it. Two halves close it (2026-10-27), and both are needed: the first stops new orphans, the
second handles the ones already written and any path that bypasses the first.

**Deleting a tier people hold is refused.** `ProductsService.delete` of a `membership` product
answers `409 TIER_HAS_HOLDERS` with `holderCount` beside the code while anyone holds the tier ACTIVE
(`UserTagService.countActiveTierHolders`: an unexpired row whose name is the tier's tag stem, alone or
with an academic-year suffix, so both modes and every year count). It counts only the rows THIS
association issued - the rows every tier read counts (`hasActiveTag`) and the only ones its revoke
(`revokeByName`) reaches. Another association's row, or a row no association issued, is held for
nobody here and out of reach of its managers: counting it could block a delete for ever, and
returning its number would be a count that crosses associations. It is asked with cotisations switched off too: the tags stay held, and
switching the mode back on must not find them orphaned. The count and the delete run in ONE
transaction under the association's tier lock EXCLUSIVE - the retag's lock, no new order: it waits
for every per-buyer transaction in flight and holds the next ones back, so a grant cannot land
between the count and the delete. The same transaction refuses `409 TIER_CHECKOUT_OPEN` while an
attempt of the tier may still be paid (open, not past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`, at
most about 35 minutes), and while an answer to one of the association's forms granting the tier
still waits for its money (`pending` within its hold, `PENDING_HOLD_CUTOFF_SQL`, or `pending_cash`;
`assertNoOpenTierFormPayment`): deleted then, the payment would deliver nothing and owe a refund. A
form submit takes no tier lock, so an answer opened in the very instant of the delete is not seen; it
lands `paid_not_granted` and the hourly report names it. The
Cotisations tab words both refusals (`asso_cotisations_tier_delete_has_holders`, with the count and
the right that can act - the delete needs `MANAGE_PRODUCTS`, moving holders needs `MANAGE_MEMBERS`;
`asso_cotisations_tier_delete_checkout_open`). The holders are moved first - a manual grant of another
tier swaps the tag out, a retag renames it for everybody (the way to drop a held base tier), a revoke
removes it. The old rule stays: the LAST tier of an association with cotisations enabled is never
deletable.

**A tier tag name is derived by the server, never taken from a typed field** - the guards are the
issuer-scoping ones of [A tag counts only for the association that issued it](#a-tag-counts-only-for-the-association-that-issued-it)
(the raw grant's `403 TAG_NOT_ISSUER_TIER`, the product edit dropping a membership product's
`grantedTagName` / `tagExpiresAt`, and `resolveGrantTag` granting nothing without a cotisation
mode); otherwise a typed name would be read as a deleted tier of the granter, refusing its holder
every tier.

**A row no association issued** (written before issuers were recorded; none exists today) is held for
nobody, blocks no delete, and is out of every manager's reach: removing one is an operator's job.

**A retag renames only the CURRENT tag of the old stem.** A `lifetime` tag, or another year's tag, of
the old key is left as it was - and, the key being gone, it becomes an orphan of the association.
That predates this section; the hourly `[ORPHAN_TIER_TAGS]` count is what shows it, and the swap of
the next grant clears it.

**A tag of a tier already gone is read by NAME, as a held tier with no price.** An orphan is an
ACTIVE row the association itself ISSUED (`issuingAssocId`), in its cotisation namespace
(`cotisant:<slug>` or `cotisant:<slug>-...`), that `linkedTierKey` matches to none of its current
tiers (`orphanTierTags`, `tier-pricing.ts`; read by `UserTagService.heldOrphanTierTags` and, from tags
already loaded, by the listings). Scoping to the issuer is what keeps another association whose slug
merely extends this one out of it. An orphan is handed to `pickHeldTier` as a held tier whose product
is null, and the rule for that already existed: an unrankable held tier wins, so every purchase of
another tier is `unranked` -> `409 TIER_NOT_RANKABLE`, at the checkout, at settlement (recorded
`paid_not_granted`), in a paid form's pre-check and its ranked grant, and when a manager closes a
payment paid and not granted as `granted` (`held-tier-deleted`, its own sentence naming the repair, read
for all the list's buyers at once by `heldOrphanTierTagsOf`). The sibling XOR
(`revokeSiblingTierTags`, the one implementation) revokes orphans with the other siblings, scoped to
the issuer, so a manager's grant of any tier is the repair, logged at WARN. The legacy claim COUNTS
an orphan as held (`unless-holding-any`): granting would run the XOR and DELETE it - possibly the tag of
a dearer PAID tier, the only record of what the holder paid - on a claim no manager made. The claim
grants nothing and swaps nothing; the holder is left to a manager's explicit grant. That legacy row is
then closed `already-held` (`LegacyCotisationService`, a null grant closes the row), and closed for
good: a later manager regrant does not reopen it, and the next sign-in does not retry it - the
manager's grant IS the outcome. An orphan is NOT added to `heldKeys`: a tier that is gone still grants no
member price and opens no gate, as before. Reading one is a decision input, logged at debug; the
estate's count is ONE line an hour, `[ORPHAN_TIER_TAGS] count=N` (`countOrphanTierTags`, in the
`PaidNotGrantedScheduler` run, its own `try`), `log` at zero and WARN while any is held.

**Why refuse, not rank or revoke on purchase.** A deleted tier has no price, so no rank can be
defended. Ranking it as `none` is the defect itself; revoking it at a purchase would let a holder of a
deleted DEAR tier replace it with a cheap one, the paid downgrade this section exists to prevent.
`unranked` is deterministic, costs nothing on the money path (refused before any payment request),
and is resolved by the one person entitled to decide what the holder now holds: a manager. No orphan
tier tag exists in production today (measured read-only, 2026-10-27); the hourly line is what says so
from now on.

**A tier key is never shaped like an academic year** (`2024-2025`, or ending `-2024-2025`;
`assertVariantKeyFree`, at creation and on a retag). Its tag would be the very name of a `dated` tag
of another tier - `cotisant:<slug>-2024-2025` is the base tier's - so `linkedTierKey` could not tell
the two apart, and once such a tier was deleted its holders' tag would read as the base tier's
rather than as an orphan. Refused with a 400 typed `TIER_KEY_YEAR_SHAPED`, which the Cotisations
tab words with the shape to avoid (`tierKeyRefusalMessage`, on a creation and on a save); a tier
that already has such a key keeps it until it is retagged, and a retag AWAY from it is accepted.

`tier-orphan-holders.integration.spec.ts` proves both halves against a real PostgreSQL: a delete
refused with its count (an expired holder not counted), a delete with none, a delete blocked on a
per-buyer lock then counting the grant made under it (the wait asserted through `pg_locks`, filtered
on that lock's key and on another backend), a delete racing a settlement refused either way and the
tier granted, a delete refused `TIER_CHECKOUT_OPEN` while a form answer granting the tier waits for
its money (a live online answer, and cash; an expired answer and a paid one do not block), an orphan
refusing a lower tier at the checkout and the form pre-check, a manager's grant revoking the orphan
but not another issuer's row of the same name, the legacy claim leaving an orphan as it is (nothing
granted, nothing swapped), a raw grant in the namespace refused, another association's holders of
the same name neither counted nor blocking, the hourly count, a closing as `granted` for an orphan
holder refused `PURCHASE_HELD_TIER_DELETED` with nothing written - and then accepted once a
manager's roster grant has swapped the orphan out - and a retag TO a year-shaped key refused while
one FROM it is accepted.

**Prod facts, 2026-10-26.** The Cercle has two tiers, `sans-alcool` 15.00 EUR and `avec-alcool`
30.00 EUR, no grid, `variantLevel` null, and the preferential pair on the alcohol tier only. No real
payment of a complement has happened yet.

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
  Members-only products are disabled with a hint. The price is the server's: a preferential price is
  shown struck-through next to the full one exactly when `viewerDueCents` is below `amountCents`
  (`preferentialDueCents` in `lib/pricing/viewerPrice.ts`), and a tier whose `viewerTierRelation` is
  `held`, `lower` or `unranked`, or a membership whose association disabled its cotisations
  (`cotisationDisabled`), gets no purchase button, only the sentence saying why (`tierNotOffered`,
  `tierNotOfferedText`) - the checkout would refuse it with a 409. Nothing on the page decides who
  qualifies for a member price; the "for holders of" suffix names the tier the server read the tag
  as naming (`memberPriceTierKey`, `linkedTierName`), and the tier the viewer holds
  (`viewerActiveTier`) only lights the "your current tier" badge. The association page's product
  list renders the same price, suffix and refusal through the same helpers. `viewerActiveTier` is the specific tier
  `variantKey` the viewer currently holds for that association, if any (`null` for a single-tier
  association or a non-cotisant).
- **`/forms/[id]`** - fill a paid form; member pricing is applied automatically when the caller
  holds the form's `pricingTagName`.

## How a user becomes a cotisant

All money moves through core-service using the association's **Stripe Connect** account;
social-service never calls Stripe directly. Online sales require completed Stripe Connect onboarding.

### A grant or renewal is one statement, never a save of the tag it read (2026-10-25)

Every path below ends in `grantOrRenew`, and it reads nothing first: it is ONE
`INSERT ... ON CONFLICT ("userId", "tagName") DO UPDATE` (the entity's `@Unique` index). A tag not
held is inserted with this grant's issuer; a tag held has `expiresAt` replaced when given and
`metadata` merged in SQL (`user_tags.metadata || EXCLUDED.metadata`), so two renewals keep both their
keys. `RETURNING (xmax = 0)` tells the two apart for the log line. A `save` of the tag read would
write back what changed since the read and re-insert a tag revoked in between; a read then an insert
would let two first grants both insert. Here a revoke is ordered before or after the statement,
never inside it, and of two first grants the second renews the first. Proven by social-service's
`users/user-grant-write-gone.integration.spec.ts`
([core-service](services/core-service.md#a-user-write-updates-columns-never-saves-the-row-it-read-2026-10-25)).

### A. Membership product (recommended)

1. User opens `/shop`, buys the membership product (`ProductPurchaseButton` -> Stripe Checkout).
2. `products.service.ts#createProductCheckout` calls core-service with the association's
   `connectAccountId`.
3. On Stripe success the webhook reaches core-service, then social-service `fulfillProductPurchase`
   -> `resolveGrantTag` derives the current tag -> `userTagService.grantOrRenew(...)`.
4. `assertCanPurchase` blocks re-buying while the tag is still active.

### B. Paid form with `grantedTagName`

`forms.service.ts#markPaid` (after Stripe) or `#validateCashPayment` (cash) grant through
`grantCotisantIfARise`; `submit` refuses a tier that is not a rise before any payment (see "Rising
to a higher tier").

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
  `MANAGE_PRODUCTS`. **With no amount given, it records what the checkout would charge that
  beneficiary** (user, 2026-10-29): their grid cell, or the fixed price through `fixedPriceOf` - the
  preferential `amountCentsMember` when they qualify by `fixedPriceFor`'s rule. It used to record the
  full `amountCents` whoever the beneficiary was. **The cashier sees that amount before the sale and
  may type another**: `GET .../products/:productId/grant-quote?userId=` answers it from
  `cashSaleQuoteFor`, the one computation the sale itself runs (`priced` with `preferential`,
  `typed` for a free amount, `not-sold` when the grid closes the combination), and the Achats tab
  shows it under the amount field, which is always offered and sent as `amountCents` when filled.
  **A free amount's bounds bind only an amount the cashier TYPES**: the resolved default is a price
  the checkout charges unchecked too, so a member price under `customAmountMinCents` is recorded. The
  price is read before the buyer's tier lock, as the grid cell always was: a tier granted to that
  buyer in the same instant can leave the default one tier stale, never the grant itself.
- `POST /api/associations/:id/tags` -> raw tag grant with an admin-supplied `tagName`/`expiresAt`
  (`MANAGE_MEMBERS`), the name being one of the association's own tier tags, granted like the
  manual add ([above](#a-tag-counts-only-for-the-association-that-issued-it)); `DELETE /api/associations/:id/tags/:tagId` revokes. The revoke is scoped to
  `:id`, not to the tag id alone: `MANAGE_MEMBERS` is granted per association, so an unscoped delete
  let an admin of any association revoke any other association's cotisant (WP-COT-9).

## Seeding from a legacy estate (`legacy_cotisations`)

Every path above writes a tag for something that happened **in Canari**. A member who paid the BDE
or Le Cercle before Canari existed holds nothing, and the association's only record is a file. Le
Cercle's own migration out of its legacy database drops the membership explicitly - *"Doesn't take
into account the membership. Canari integration takes care of it."* - so this is the half that was
missing on both sides.

`legacy_cotisations` (migration `059`, entity `LegacyCotisation`) stages one row per legacy cotisant
and waits for them to sign in. **A one-shot grant was not an option**: Canari holds 395 accounts
against roughly 1400 legacy cotisants, so it could only ever have served the accounts that already
existed.

### The key, and why it is a natural one

`normalizeMatchKey(lastName, firstName, promo)`
(`apps/social-service/src/users/legacy-cotisation.util.ts`) is the ONE implementation, shared by the
import and the claim - two spellings of this key match nothing at all rather than matching wrongly.

Neither legacy estate carries an email and **Canari's `users` table has no email column**, so
`(lastName, firstName, promo)` is the only key available. It was measured before being chosen: zero
collisions among the 1169 Cercle cotisants carrying a promo, and zero inside any year group of the
BDE sheet. The promo is load-bearing rather than decorative - the same first-and-last name appears in
two different year groups of that sheet - which is why a user with no promo is skipped rather than
matched on the name alone.

**A name carrying `?` is refused.** Le Cercle's legacy base holds no non-ASCII byte at all: the
accents were destroyed before the export and replaced by a literal `?`, two per accented letter,
across 150 of its 1169 cotisants (67 in promos still at school). Stripped like any other
punctuation, `"Cl??ment"` yields the valid-looking key `cl ment` that no sign-in can ever match -
one cotisant in eight lost silently. The import repairs them instead, against a directory export
with intact accents: a `?` run becomes one wildcard per two characters and only a **unique** hit is
accepted. Measured over the 150: 141 unique, 9 none, **0 ambiguous**, which is what makes the repair
safe to automate rather than a guess.

### The claim runs on every sign-in

`LegacyCotisationService.claimFor` is called by core-service after the OIDC upsert, through
`POST internal/legacy-cotisations/claim` (`X-Internal-Secret`, like the rest of that module).

**Not on first login, deliberately.** The claim terminates on `claimedByUserId` - durable state -
not on the account being new. Keyed on creation it would strand every user who signed in before
their association's list was loaded, and a grant that failed at that one instant could never be
retried. Against the indexed `matchKey` a user with nothing waiting costs one lookup returning no
rows, and the whole thing is order-independent and self-healing.

The grant goes through `grantCotisant` like every other path, with `grantedBy: 'system:legacy-import'`
and the provenance in `metadata`, so a legacy grant is visible in the Cotisations roster exactly like
a manual one. It is granted BEFORE the row is closed: `grantOrRenew` upserts, so a crash between the
two costs a repeated grant, where closing first would cost the cotisation outright.

Three things it will not guess:

| Situation | What happens | Why |
|---|---|---|
| The user already holds a tag from that association | Row closed, nothing granted | The XOR sibling revoke in `grantCotisant` would take away the tier they **paid for**. With 200 BDE and 234 Cercle tags across 395 accounts, this is the ordinary case, not an edge one |
| Two source rows normalize to one key | Import **refused**, nothing written | Resolved in front of whoever can still read the file, rather than by coin flip at a sign-in months later. Enforced by a partial unique index on `(matchKey, associationId) WHERE "claimedByUserId" IS NULL` |
| A second account matches an already-claimed row | Logged as `CONFLICT`, nothing granted | A real homonym in one promo, or a duplicated source row. Both need a human, and neither may be guessed |

A grant that throws leaves the row pending and is retried on the next sign-in; each row is caught on
its own, so one bad association cannot swallow the rows behind it. The claim never throws - a
cotisation that cannot be granted must not cost somebody their sign-in.

### Loading a source

`apps/social-service/scripts/import-legacy-cotisations.ts`, run by hand, never on a schedule: both
sources are frozen exports of systems Canari replaced. Re-running it stages nothing new.

```sh
bun scripts/import-legacy-cotisations.ts --source bde --file "Liste cotisants 25_26.xlsx" \
    --promo-1a 2025 --dry-run
bun scripts/import-legacy-cotisations.ts --source cercle --file legacy-readonly-backup.db \
    --repair-names promo.csv --dry-run
```

| Source | Shape | Staged | Tier |
|---|---|---|---|
| BDE spreadsheet | three year-group blocks side by side, `NOM / Prenom / Cotisation` | 269 of 471 rows (`oui` only) | base (`variantKey: null`) |
| Le Cercle legacy SQLite | one `transaction` row against consommable `2`, "Cotisation Cercle" | 1160 | `avec-alcool` |

**A year group is a position in the sheet, never a promo**, so `--promo-1a` is required rather than
inferred: next year's sheet has the same three blocks and three different promos.

**The Cercle price must not be read as a tier.** The avec/sans-alcool split post-dates the whole
legacy estate, where one cotisation always carried alcohol; the nominal amount only tracks inflation
(26 EUR from 2017, 30 EUR from 2023), so filtering on it would silently drop two thirds of the
roster. The consommable is asserted **by name** before anything is read, so a dump that numbers its
products differently fails loudly instead of staging a roster of beer drinkers.

Both associations are `lifetime`, which is what makes a historical list meaningful at all: the tag
carries no academic year and does not expire. 1175 of Le Cercle's 1194 legacy buyers paid exactly
once, which is the same fact from the other side.

**Three rows were refused and STAY EXCLUDED - decided by the user 2026-09-22** (*"Elles restent
exclues, ferme la ligne"*). One had an empty `Cotisation` cell between filled neighbours, two carried
accents no directory entry resolves; the import refused to guess on all three. No hand-added row is
owed: if one of the three ever pays, the ordinary shop path serves them.

**Both assumptions behind the key are measured (2026-09-11).** The promo conventions of Authentik,
the Cercle legacy base and the directory export agree at offset 0 - 206 accounts match the directory
and 119 a Cercle cotisant, against 12 and 2 at offset +1 and nothing beyond; a graduation year where
the legacy stores an entry year would have made every key wrong by 3 with nothing to report it.
`promo.csv`, which the 141 accent repairs rest on, is an export dated 2025-11-13 covering 2016-2025,
and covers 962 of the 1019 undamaged Cercle cotisants (94%). The decisive test simulated the failure
mode - corrupt an accented name, REMOVE its true owner from the reference, run the real repair: 599
simulations, 599 refusals, zero wrong person accepted; with the owner present, 599 of 599 named
correctly.

**The promo-2026 cohort is unserved by design and it is the LARGEST** - 153 of production's 396
accounts on 2026-09-11, 1A who arrived after both lists were frozen. They must pay through the shop,
and the membership products' `isActive = false` is deliberate (user, 2026-09-11).

### Loading a DEPLOYED estate - `--emit-sql`, because there is no connection to open

Dropping the `--dry-run` connects with `DB_*`, which works locally and nowhere else: neither
`canari-dev-postgres-1` nor `canari-prod-postgres-1` publishes a port, and the way into either is
`docker exec ... psql` from the box ([databases](infrastructure/databases.md)). The alternative -
lifting a production password onto a workstation to open a tunnel - buys nothing and puts a
credential somewhere it has no reason to be.

So the script renders the load instead, and `psql` applies it:

```sh
bun scripts/import-legacy-cotisations.ts --source cercle --file legacy-readonly-backup.db \
    --repair-names promo.csv --emit-sql /tmp/cercle.sql
<ssh to the host> 'docker exec -i <dev postgres container> psql -U <db user> -d <db> -v ON_ERROR_STOP=1' \
    < /tmp/cercle.sql
```

**The emitted file names real people and this repository is public.** Write it outside the tree; the
file says so in its own header, because that is where whoever opens it will be.

Three properties make the emitted transaction the same load rather than a weaker one:

- **It carries its own preconditions.** A `DO` block raises unless the association exists, has
  cotisation enabled, and has the named tier in its catalogue. The last one is not decoration:
  `grantCotisant` validates the tier again at every claim, so a load naming a tier that does not
  exist stages perfectly and then refuses each member separately, at whatever hour they sign in.
- **The association id is resolved by the statement**, never interpolated. Both estates run the same
  schema with different ids, and a file carrying one estate's uuid would apply cleanly against the
  other and attach every row to the wrong association.
- **It is idempotent on the same partial index the connected path uses**, so a re-run stages nothing
  twice and never reopens a claimed row.

`ON_ERROR_STOP=1` is not optional. Without it `psql` reports a failed statement and carries on to
the next, which for a `BEGIN`-wrapped load means every later statement is refused as "current
transaction is aborted" - one real error buried under a thousand identical ones.

### Reading the staging table (`/admin/legacy-cotisations`)

A claim that grants nothing is invisible: the user sees no tag, and nothing tells them why. The
screen at `/admin/legacy-cotisations` is the only window onto that, global admin only - the table
spans every estate loaded and names people who have no Canari account at all.

It serves one question, "why has this person not got their tag", and answers it by showing
**`sourceLabel` and `matchKey` on the same row**. The gap between the two spellings is nearly always
the answer: an accent the source destroyed, a compound name, a promo the source wrote as a year
group. The search box spans both columns, so an accent-free query still finds an accented row.

| Tab | Rows | What it means |
|---|---|---|
| Waiting | `claimedByUserId IS NULL` | Nobody matching has signed in yet - the ordinary state |
| Granted | `claimedByUserId IS NOT NULL` | With `metadata.disposition`: `granted`, or `already-held` when Canari already knew a cotisation for that association and the row closed without touching it |
| Namesakes | more than one row per `(matchKey, associationId)` | Two people normalize to one key, or one source row was duplicated. **Nothing can resolve this alone**: the first to sign in takes the cotisation and the rest stay stuck, so a human must look |

The namesake count is a window function rather than a flag, because the pending-only unique index
lets a second row exist for a key the moment the first is claimed - which is exactly the homonym
case it has to catch. The three tallies span the whole table and never the filtered page; the tab's
own `total` is what pagination walks.

### What the load did, projected on production (shipped 2026-09-11, `v0.17.1`)

**1429 rows are staged on dev and on production** - 269 BDE, 1160 Cercle, applied through
`--emit-sql` and `psql`, `INSERT 0 0` on a re-run. Projected against production's 396 accounts by
computing each user's key with `normalizeMatchKey` itself, rather than an approximation of it in SQL:

| | staged | has an account today | will be GRANTED | will close `already-held` |
| --- | --- | --- | --- | --- |
| BDE | 269 | 152 | 27 | 125 |
| Le Cercle | 1160 | 156 | 33 | 123 |

Zero keys are held by two accounts on either estate, so the collisions tab starts empty and any row
appearing in it later is a real homonym. The remaining ~1120 rows belong to people with no account,
which is the whole reason this is a staging table and not a one-shot grant.

**`already-held` is the DOMINANT case, not the rare one** - 248 of the 308 rows that have an account.
Each is somebody who already paid through Canari and whose row closes without granting, because the
sibling-tier revoke inside `grantCotisant` would otherwise take away the tier they paid for. The guard
is therefore load-bearing on first contact with real data. The next sign-in should move
`/admin/legacy-cotisations` off zero in the claimed tab; until it does, an empty screen and a broken
claim look identical.

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
| GET | `/api/associations/products/all` | All active products + per-product `viewerIsCotisant`/`viewerActiveTier`/`viewerTierRelation`/`viewerDueCents` (shop) |
| POST | `/api/associations/:id/products` | Create a product (incl. `type: 'membership'`) (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for a product |
| POST | `/api/associations/:id/products/:productId/grant` | Manual purchase + tag grant (`MANAGE_PRODUCTS`) |
| GET | `/api/associations/:id/products/:productId/grant-quote?userId=` | The amount that grant records for that beneficiary when none is typed (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/purchases/:purchaseId/close` | Record how a `paid_not_granted` payment was settled, `refunded` or `granted` (grants the tier by hand); once per payment (`MANAGE_PRODUCTS`) |
| POST | `/api/associations/:id/webhook-failures/:deliveryId/retry` | Re-fire a failed Cercle delivery (`MANAGE_PRODUCTS`, scoped to `:id`) |
| DELETE | `/api/associations/:id/webhook-failures/:deliveryId` | Drop a failed delivery settled by hand (`MANAGE_PRODUCTS`) |
| POST | `/api/forms/:id/submit` | Submit a form; applies member pricing, may grant a tag |
| GET | `/api/public/cotisant-status` | Cercle-facing live cotisant status by `assoSlug`+`sub` (`X-Api-Key`, not `MANAGE_*`) |
| POST | `internal/legacy-cotisations/claim` | Grants what a legacy estate recorded for a signing-in user (`X-Internal-Secret`, core-service only) |
| GET | `/api/associations/admin/legacy-cotisations` | Read-only staging table: waiting / granted / namesakes (global admin). Under `associations/` because `/api/admin/*` is proxied to chat-gateway |

## See also

- [frontend/modules/associations.md](frontend/modules/associations.md) - association model, permission flags, admin panel tabs.
- [services/social-service.md](services/social-service.md) - service boundaries (associations, user tags, forms).
- [frontend/modules/admin.md](frontend/modules/admin.md) - platform admin surfaces, including `/admin/cercle` (Cercle top-ups).
- [frontend/modules/payments.md](frontend/modules/payments.md) - Stripe Connect and the shop/checkout flow.
- [../user-guide/membre.md](../user-guide/membre.md) - "Cotiser a une association" (end-user guide).
- [../PROD-TEST-CERCLE.md](../PROD-TEST-CERCLE.md) - production runbook for the Canari <-> Cercle link.
