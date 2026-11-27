## The shop screens - decided by the user on 2026-10-26: built, what is left (audited 2026-11-19)

target: 1.9.1

**Built** since the first real Cercle top-up (2026-10-26): one membership card with its tiers inside it
(`MembershipCard.svelte`, #2546); the rise priced by the admin's preferential price, with the server
refusing a lower or equal tier and exposing `viewerTierRelation` and `viewerDueCents` so the client never
recomputes money (`products.service.ts`, `viewerPrice.ts`, #2591); a top-up chosen from quick amounts plus
"other amount" on an in-app keypad (`AmountPicker.svelte`); locale prices; the purchase-aware return banner
(#2546, #3482); the Achats rework with a fill-in sentence for a rise (`TierRiseEditor.svelte`), and the tier's
`variantKey` no longer editable (`EditCotisationsTab.svelte`); the association creation form derives its slug
from the name. Decisions kept for reference: no maximum top-up, no Cercle balance on the card (it needs a
route on the Cercle's host), product names shown to people are never the technical ones, and **a technical
id is never shown, typed or edited by a person**. The Lydia card page is Lydia's.

**Left, found by no reading:** (1) one reading of the whole shop (`/shop`, the association page,
`ProductPurchaseButton`) on a phone with the tokens and the payment apps as the visual reference - none is
recorded in [device-verification](../device-verification.md); (2) the sweep of every screen for a
technical id shown or typed, never run as a sweep (the association page title was its first target); the
follow-ups of the keypad and the money formatter are in [the shop and form follow-ups](shop-and-form-follow-ups-of-2026-10-29.md).
Mechanism: [payments](../frontend/modules/payments.md).
