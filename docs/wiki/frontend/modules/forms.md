# Forms module

**Routes**: `src/routes/forms/[id]/` (fill), `src/routes/forms/create/` + `src/routes/forms/[id]/edit/` (admin)
**Components**: `src/lib/components/forms/`
**Shared logic**: `src/lib/forms/` (`cotisationSettings.ts`, `itemsPayload.ts`, `questionTypes.ts`)

## Responsibilities

- Render dynamic association forms for member submissions.
- Support optional online payments (Stripe Checkout) or cash payments.
- Display submission confirmation and payment status.
- Let a form manager build and configure a form, including its member price and the cotisation a
  paid submission grants.

## Form submission flow

```
/forms/:id
  -> GET /api/forms/:id (form definition: fields, basePrice, allowCashPayment)
  -> GET /api/forms/:id/check           (returns `memberPricing`, computed SERVER-side)
  -> User fills form
  -> POST /api/forms/:id/submit { answers, paymentMethod }

If basePrice > 0 and online payment:
  -> POST /api/payments/create-checkout-session
  -> Redirect to Stripe Checkout
  -> On return: POST /api/payments/verify-session

If cash payment:
  -> Submit marked as "pending cash"
  -> Association admin validates/cancels via EditFormsTab
```

## Payment methods

| Method | Flow |
|---|---|
| Free | Direct submit, no payment |
| Stripe Checkout | Redirect to Stripe-hosted page, return to `/forms/:id?session_id=...` |
| Saved card | `POST /api/payments/charge-saved-method` (no redirect) |
| Cash | Submit marked pending, association admin validates manually |

## Key component: forms/[id]/+page.svelte

The single form submission page handles all four payment flows. Key state:

- `form` — form definition loaded on mount
- `answers` — user-provided field values
- `paymentStep` — `'form' | 'payment' | 'confirmation'`
- `memberPricing` — a BOOLEAN returned by the API, never derived here. The fill page has no idea
  which tag or tier decides it, which is why swapping that rule server-side needed no change here.
- Card registration setup: `POST /api/payments/setup-payment-method` (Stripe SetupIntent)

## The admin screens

`forms/create` and `forms/[id]/edit` are two thin pages over one set of components. They were two
700-to-900-line copies of each other until 2026-08-23, and the copies had drifted in eight ways a
user could see (two toggle sizes on one screen, a select missing its focus ring, two different
placeholders on the same picker, a cash-expiry field that was a bare input on one page and a
labelled component on the other). Everything shared now lives in one place:

| Piece | What it owns |
|---|---|
| `FormSection.svelte` | The card: icon, title, optional badge, optional collapsing |
| `FormPaymentSection.svelte` | Price, beneficiary, member price, payment methods, cash |
| `FormQuestionsSection.svelte` | The builder list, drag-and-drop, the type picker |
| `FormAdvancedSettings.svelte` | The collapsed "advanced" category (today: the cotisation grant) |
| `FormSaveBar.svelte` | The footer summary and the save button |
| `MemberPriceFields.svelte` | The "cotisants pay less" block |
| `CotisationTierPicker.svelte` | Picks a tier BY NAME |
| `ui/controlClasses.ts` | The one class string every input and select wears |
| `ui/Select.svelte`, `ui/Toggle.svelte` | The select and the switch, one geometry each |
| `forms/cotisationSettings.ts` | The cotisation state, and the payload it becomes |
| `forms/itemsPayload.ts` | Questions to/from the wire, euros to/from cents |

Section order, top to bottom: **General** (title, description, poster), **Responses** (cap, repeat
submissions, opening date), **Payment**, **Questions**, **Co-managers** (edit only), **Advanced
settings** (collapsed).

## Cotisations: a form names a TIER, never a tag

This is the rule the whole cotisation surface turns on, and it is the one thing to read before
touching it. See migration `050_forms_cotisation_by_reference.sql` for the full reasoning.

A form stores **which tier**, and the tag is derived at grant time:

| Column | Meaning |
|---|---|
| `memberPriceEnabled` | The form has a member price at all. Gates `basePriceMember` AND every option's `priceModifierMember` — which is why it is not `basePriceMember != null` |
| `memberPriceVariantKey` | Restricts the member price to one tier. **NULL = any tier** of the association |
| `basePriceMember` | Member base price in cents; null = only the options are discounted |
| `grantsCotisation` | A paid submission grants the association's cotisation |
| `cotisationVariantKey` | Which tier is granted. **NULL = the base tier** — the deliberate difference from the column above: "who counts as a member" is a set, "what does payment grant" is exactly one |

The predecessors — `pricingTagName`, `grantedTagName`, `tagExpiresAt` — stored a literal tag string
typed into the admin screen, and were dropped. Three things were wrong with a literal, all silent:

1. **It went stale.** A dated cotisation's tag carries the academic year. A form configured in June
   stored `cotisant:bde-2025-2026`; submitted in October it granted a tag for a year that was over.
   `provisionCotisationProduct` resyncs the association's products on every slug or mode change;
   nothing resynced a form, and nothing could — the form did not record which tier it meant.
2. **It could not name a tier.** A multi-tier association got the base tag or a hand-typed guess,
   which is the "cotisant nobody can see" that `grantCotisant` refuses to mint.
3. **It bypassed the XOR.** Granting a raw tag through `grantOrRenew` skipped
   `revokeSiblingTierTags`, so a user could hold two tiers at once by buying one in the boutique and
   the other through a form.

Granting now goes through `UserTagService.grantCotisant`, the same call the boutique and the manual
roster add use, so all three are impossible by construction.

### Where the tier list comes from

`GET /api/associations/:id/cotisation-options` -> `{ tiers: { variantKey, name }[], mayGrant }`.

One call answers both questions the screen has: what may be offered, and what this caller is allowed
to do with it. `mayGrant` is `MANAGE_MEMBERS` on that association (or global admin) - see the gate
below. Not `:id/cotisation-tiers`, which requires `MANAGE_MEMBERS` merely to *read* and carries the
derived `tagName` no screen has any use for; the tier list here is unguarded for the same reason
`:id/products` is, since a tier's NAME is already public on the association page.

**No screen ever renders a `variantKey`, an id, or a tag.** The picker shows `name`; the key travels
on the wire only. `AssociationTagAutocomplete` and `GET :id/tag-catalog` were deleted along with the
raw-tag UI that was their only caller.

### Granting a cotisation needs MANAGE_MEMBERS, the member price does not

Creating a form needs nothing but an account. Linking it to an association needs membership. But
`grantsCotisation` hands out association membership, and `UserTagService.grantCotisant` has always
required `MANAGE_MEMBERS` - so a plain member with `MANAGE_FORMS` could save a form whose grant would
be refused at payment time, or, worse, use the form as a side door around the flag that guards the
roster. `assertCotisationConfigValid` now takes the caller and refuses the setting itself, and
`mayGrant` hides the toggle so nobody picks an option the save would reject.

The member price is deliberately NOT gated: offering a discount to existing cotisants grants nothing
and changes no one's membership.

## A form's association is chosen once, at creation

A form is either personal or an association's, and `update` refuses any change to `associationId`
(absent means unchanged; a different value is a 400 naming the reason). Moving a form between the two
would ask who owns it afterwards, and there is no answer that does not surprise someone: the owner
who created it, or the managers who inherited it. The edit screen therefore shows the association as
read-only text rather than a disabled picker - a disabled control suggests someone with more rights
could change it, and there is no such someone.

## What `/forms` lists

Three sources, merged by id and sorted newest-first: forms the caller owns, forms they co-own, and
forms linked to an association where they hold `MANAGE_FORMS`. `assertFormManager` has always
accepted that third set, so those forms were editable and exportable by API while appearing in no
list on any screen - reachable only by someone who already knew the URL.

Each row therefore says whose form it is, by NAME (`Form.associationName`, resolved server-side;
null for a personal form and for a form whose association has since been deleted). That line used to
print the raw form id, which told a person nothing.

`EditFormsTab` offers edit and delete on the same set from the association's own space. Its actions
are unconditional because the tab itself only renders for a caller holding `MANAGE_FORMS`.

### Configurations the API refuses

`FormsService.assertCotisationConfigValid` runs on create AND update, and rejects every setting that
would look saved and then do nothing:

- a grant or a member price with no beneficiary association;
- a grant on a form that does not require payment — a zero-total submission is stored `free` and
  never reaches `markPaid`, so the grant could not fire;
- a grant or member price on an association with no cotisation;
- a `variantKey` the association does not sell;
- a base-tier grant on an association that sells named tiers only.

## Note on form management

Association admins also reach a form's submissions, cash validation, edit and delete through the
associations module (`edit/EditFormsTab.svelte`). Building and configuring a form happens in the two
admin routes above.

## Tests

`apps/social-service/src/forms/forms.service.cotisation.spec.ts` (the config refusals, the
`MANAGE_MEMBERS` gate, link immutability, member-price eligibility, granting on payment) and
`forms.service.list.spec.ts` (the three sources, dedup, ordering, naming). The forms module had no
test at all before 2026-08-23.
