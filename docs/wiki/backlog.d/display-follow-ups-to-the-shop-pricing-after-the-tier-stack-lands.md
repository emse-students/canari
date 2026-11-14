## Display follow-ups to the shop pricing (after the tier stack lands)

target: 1.10.0

Left by the review of #2544. Start after the tier stack (#2544 and its followers) has merged.

- **P3 - two docs claim the settlement's rule for a form grant.** `rankTier`'s and
  `RankedGrantOutcome`'s comments in `user-tag.service.ts` say a form grant is ranked like a
  settlement, but a held tier differs: the form grant renews it, the settlement does not grant it.
- **P3 - no client wording for `MEMBER_PRICE_TAG_NOT_A_TIER`** in the admin tabs: add a Paraglide
  message (fr, en).
- **P3 - a cash sale's default price is computed outside `lockBuyerTiers`, one tier stale at worst.**
  `grantProductPurchase`'s `cashSaleQuoteFor` reads the beneficiary's tiers (`tierFactsOf`, or the
  grid's `listHeldCotisationTiers`) before `fulfillProductPurchase` takes the buyer's lock, so a tier granted
  or revoked in the same instant can leave the recorded default one tier off; the tag and the record
  stay correct, and a cashier is present. Compute the default inside the locked transaction, both
  branches ([cotisations](../cotisations.md#c-manual-grant-from-the-cotisations-tab-cash--retroactive)).
