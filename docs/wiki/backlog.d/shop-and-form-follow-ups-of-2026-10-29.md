## P2 - The unpriced base tier: does it rank lowest, or must it be priced before a sibling links to it?

target: 1.10.0

Filed 2026-10-29 by the #2546 review and the owner's review of `1.5.1-alpha.7`; the cleanups and the
typed form items filed with it shipped on 2026-11-25 (one money formatter, `ProductPrice` read as a
plain value, the amount keypad on the physical keyboard; the form item type allowlist and
`@IsInt()` on `basePrice` were already in the DTO).

The base tier every association gets when it enables cotisations is created UNPRICED (`amountCents`
null), so `tier-pricing.ts` cannot rank it (`hasFixedPrice`) and a holder of it is refused EVERY rise
as `unranked` - a tier whose preferential price is linked to the base tier (dev's "Etudiant", 5 EUR
for holders of "Cotisation") is therefore never sold at that price to the people it names. The shop
now hides the unpriced tier itself (#2546, [cotisations](../cotisations.md)); whether an unpriced
base tier ranks lowest, or must be priced before a sibling may link to it, is the owner's call.
