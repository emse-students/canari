# Forms module

**Routes**: `src/routes/forms/[id]/` (fill), `src/routes/forms/create/` + `src/routes/forms/[id]/edit/` (admin)
**Components**: `src/lib/components/forms/`
**Shared logic**: `src/lib/forms/` (`cotisationSettings.ts`, `itemsPayload.ts`, `questionTypes.ts`)

## Responsibilities

- Render dynamic association forms for member submissions.
- Support optional online payments (Stripe Checkout) or cash payments.
- Display submission confirmation and payment status.
- Let a form manager build and configure a form, including its price grid and the cotisation a
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
| `FormPaymentSection.svelte` | Base price, beneficiary, the price grid, payment methods, cash |
| `FormQuestionsSection.svelte` | The builder list, drag-and-drop, the type picker |
| `FormAdvancedSettings.svelte` | The collapsed "advanced" category (today: the cotisation grant) |
| `FormSaveBar.svelte` | The footer summary and the save button |
| `FormAudienceSection.svelte` | Who may answer at all (`submitCondition`) |
| `PriceGridEditor.svelte` | The dimensions, and the cell grid they cross into |
| `CriterionEditor.svelte` | One dimension's buckets |
| `AudienceConditionEditor.svelte` | One condition's criteria, used by the form AND by a question |
| `forms/priceMatrix.ts` | The matrix state, its cross product, and the payload it becomes |
| `forms/criteriaOptions.ts` | The promo / formation option lists a criterion offers |
| `forms/audience.ts` | The pre-save guard against a condition with no criterion |
| `CotisationTierPicker.svelte` | Picks a tier BY NAME |
| `ui/controlClasses.ts` | The one class string every input and select wears |
| `ui/Select.svelte`, `ui/Toggle.svelte` | The select and the switch, one geometry each |
| `forms/cotisationSettings.ts` | The cotisation state, and the payload it becomes |
| `forms/itemsPayload.ts` | Questions to/from the wire, euros to/from cents |

Section order, top to bottom: **General** (title, description, poster), **Responses** (cap, repeat
submissions, opening date), **Who may answer**, **Payment**, **Questions**, **Co-managers** (edit
only), **Advanced settings** (collapsed). Audience sits before money on purpose: who may answer is
read first, what they pay second.

## Pricing is a MATRIX, so no priority rule exists to get wrong

A price used to be one number plus an optional "cotisants pay less" second number. What managers
actually price on is several things at once - the BDE cotisation depends on the promo, the formation
AND the answer to a menu question. Expressed as an ordered list of rules, that needs a priority
rule, and a priority rule is a thing to get wrong: two rules both matching one person, and whichever
sorts first wins for reasons nobody wrote down.

So the ticked "Filtrer par..." boxes declare **dimensions**, and the grid is their **cross product**.
Exactly one cell applies to any given person, so there is nothing to prioritise, and completeness is
a save-time invariant rather than a runtime hope.

Two properties make that work:

- **A dimension is a PARTITION, not a filter.** Every criterion carries the buckets a manager wrote
  plus one generated, undeletable `others` bucket (`OTHERS_BUCKET_ID = '_others'`). Without it a
  dimension leaves the people it does not name unpriced; with it the cross product stays small and
  everybody lands in exactly one cell.
- **A question used as a dimension contributes no additive `priceModifier`.** Its cell already
  carries the choice, so a supplement on top would charge it twice. The server enforces it
  (`pricedQuestionIds`), and the builder hides the per-option supplement fields for those questions.

`pricing/price-matrix.ts` resolves a submitter to a cell, `pricing/validate.ts` refuses an
incomplete or self-contradicting matrix at save time, and `pricing/audience.ts` holds
`matchesCondition` plus `SubmitterFacts` - the promo, formation and cotisation facts assembled by
`submitter-facts.service.ts`.

### What the app knows about a person, and why a price may rest on it

Measured on prod 2026-08-23, `auth_db.users`, 221 rows:

| Attribute | Values seen | Comes from |
|---|---|---|
| `formation` | `ICM` 213, `ISMIN` 3, `Master` 2, null 3 | Authentik `userinfo`, refreshed at every login |
| `promo` | 2022 (4), 2023 (15), 2024 (72), 2025 (101), 2026 (24), plus 2020, 1850, 1816, null 2 | idem |
| cotisation tier | `AssociationProduct` rows, `type='membership'`, per association | the association's own catalogue |

Three facts shape the feature:

1. **Neither attribute is self-declared.** `UpdateUserDto` carries `bio` and nothing else; `promo` and
   `formation` are written only by `findOrCreateFromOidc`. That is what makes them safe to price on -
   the payer cannot move themselves into a cheaper cell. **If that DTO ever gains `promo`, this
   becomes a self-service discount**, which is why the warning is written at the DTO itself.
2. **`formation` is a small OPEN vocabulary, not an enum.** The next value arrives from Authentik with
   no deploy, so the picker offers what EXISTS and the `others` bucket catches what it has not seen.
3. **Both can be null**, and five rows on prod are. A null is not an error and must price.

`promo` is a **graduation year**, not a study year, and "1A pays 10 EUR" is how a grid gets asked for.
A bucket saying `promo = 2029` is a snapshot - right this year, wrong the next, exactly the mistake
migration `050` had just finished removing from cotisation tags. So a promo bucket says which it
means: `{ kind: 'promo', years }` for graduation years, or `{ kind: 'studyYear', years }` resolved
against the academic year at quote time, which is what a form reused every year wants and what the UI
offers first. The academic-year roll is the one `deriveCotisationTag` already uses.

## One predicate, three uses

The criteria that divide a price grid are the same criteria that gate a question and gate the form:

| Where | Field | Meaning |
|---|---|---|
| The form | `submitCondition` | Who may submit at all |
| A question | `showIf` | Who sees this question |
| A price cell | the dimension buckets | What this person pays |

All three are `AudienceCondition`, all three are judged by `matchesCondition`, whose keys are ANDed.
One editor component builds all of them, so a form reserved to one promo and a price for that promo
cannot disagree.

### Conditional questions are evaluated on the SERVER now

`dependsOn`/`dependsValue` used to be a browser-only rule, which had two live consequences: `submit`
enforced `required` on hidden questions while the client sent only visible answers (so a required
question behind a condition made the form unsubmittable for the people the condition excluded), and
an answer to a hidden question was accepted with its price modifier charged. Both get much worse once
an answer can select a price cell, which is why `pricing/visibility.ts` landed with the matrix rather
than after it.

`visibleItemIds` is memoised, order-independent, and resolves a dependency cycle to *hidden* - a
question depending on itself has no defensible answer, and hidden is the reading that charges nobody.
`normaliseCondition` folds the legacy `dependsOn` pair into `showIf.answer` so exactly one evaluator
exists, and **ANDs the two shapes**: the builder offers both controls on one question, so "only for
cotisants" and "only if Q1 = menu B" are two requirements of one question. `showIf.answer` wins over
the legacy pair when both name an answer.

### The submit button says what the catalogue says

`submitLabel` looked like a manager's setting and never was one: no screen has ever offered a field
for it, both admin pages wrote a hard-coded French literal computed from `requiresPayment`, and the
fill page rendered it raw with `|| 'Envoyer'` behind it for the rows the entity default had left as
`'Submit'`. An English viewer read French. Migration `052` drops the column; the label is a Paraglide
message derived from `requiresPayment` at render time. If a per-form label is ever wanted, it comes
back as a message KEY or a translated map, never as one language's sentence in a column.

### A condition with no criterion is refused, twice

An empty condition applies to everybody, so it restricts nothing and hides nothing. The server
refuses it (`parseAudienceCondition`), but that refusal is a developer sentence about a document -
not what a manager should read for having flipped a switch and stopped. So `forms/audience.ts`
catches it before the request, naming the form or the question it belongs to.

## Cotisations: a form names a TIER, never a tag

This is the rule the whole cotisation surface turns on, and it is the one thing to read before
touching it. See migration `050_forms_cotisation_by_reference.sql` for the full reasoning.

A form stores **which tier**, and the tag is derived at grant time:

| Column | Meaning |
|---|---|
| `grantsCotisation` | A paid submission grants the association's cotisation |
| `cotisationVariantKey` | Which tier is granted. **NULL = the base tier**, not "any tier": "who counts as a member" is a set, "what does payment grant" is exactly one |

The member price is no longer a column. `memberPriceEnabled`, `memberPriceVariantKey` and
`basePriceMember` were "cotisants pay less" spelled as three columns and one hard-coded discount
axis; migration `051_form_price_matrix.sql` drops them, because a cotisation tier is now just one
dimension a price grid may be divided on, alongside promo, formation and an answer. Production held
one form, with `memberPriceEnabled` false and `basePriceMember` null, so nothing needed migrating.

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

### Granting a cotisation needs MANAGE_MEMBERS, pricing on one does not

Creating a form needs nothing but an account. Linking it to an association needs membership. But
`grantsCotisation` hands out association membership, and `UserTagService.grantCotisant` has always
required `MANAGE_MEMBERS` - so a plain member with `MANAGE_FORMS` could save a form whose grant would
be refused at payment time, or, worse, use the form as a side door around the flag that guards the
roster. `assertCotisationConfigValid` now takes the caller and refuses the setting itself, and
`mayGrant` hides the toggle so nobody picks an option the save would reject.

Dividing a price grid on a cotisation tier is deliberately NOT gated: charging existing cotisants a
different amount grants nothing and changes no one's membership.

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

- a grant with no beneficiary association, or a price grid divided on a cotisation tier without one;
- a grant on a form that does not require payment — a zero-total submission is stored `free` and
  never reaches `markPaid`, so the grant could not fire;
- either of those on an association with no cotisation;
- a `variantKey` the association does not sell;
- a base-tier grant on an association that sells named tiers only.

## Note on form management

Association admins also reach a form's submissions, cash validation, edit and delete through the
associations module (`edit/EditFormsTab.svelte`). Building and configuring a form happens in the two
admin routes above.

## Tests

`apps/social-service/src/forms/forms.service.cotisation.spec.ts` (the config refusals, the
`MANAGE_MEMBERS` gate, link immutability, granting on payment) and `forms.service.list.spec.ts` (the
three sources, dedup, ordering, naming). The forms module had no test at all before 2026-08-23.

The matrix carries its own: `pricing/audience.spec.ts` (`matchesCondition`, every criterion shape),
`pricing/price-matrix.spec.ts` (cell resolution, the `others` bucket, completeness), `validate.ts`'s
refusals through `forms.service.matrix.spec.ts` (an incomplete grid, a double-counted question, a
condition with no criterion), `pricing/visibility.spec.ts` (memoisation, cycles, the legacy pair
ANDed with `showIf`) and `frontend/src/lib/forms/priceMatrix.test.ts` (the cross product and the
payload).
