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
| `FormPaymentSection.svelte` | Beneficiary, the single-price / grid toggle, payment methods, cash |
| `FormQuestionsSection.svelte` | The builder list, drag-and-drop, the type picker |
| `FormAdvancedSettings.svelte` | The collapsed "advanced" category: responses, audience, cotisation |
| `FormSaveBar.svelte` | The footer summary and the save button |
| `pricing/PriceGridEditor.svelte` | The dimensions, and the cell grid they cross into |
| `pricing/CriterionEditor.svelte` | One dimension's buckets |
| `AudienceConditionEditor.svelte` | One condition's criteria, used by the form AND by a question |
| `pricing/priceMatrix.ts` | The matrix state, its cross product, and the payload it becomes |
| `pricing/criteriaOptions.ts` | The promo / formation option lists a criterion offers |
| `forms/audience.ts` | The pre-save guard against a condition with no criterion |
| `pricing/CotisationTierPicker.svelte` | Picks a tier BY NAME |
| `ui/controlClasses.ts` | The one class string every input and select wears |
| `ui/Select.svelte`, `ui/Toggle.svelte` | The select and the switch, one geometry each |
| `forms/cotisationSettings.ts` | The cotisation state, and the payload it becomes |
| `forms/itemsPayload.ts` | Questions to/from the wire, euros to/from cents |
| `forms/summary.ts` | The save bar's one line: question count, and what the form costs |
| `forms/gridProblem.ts` | One sentence per `GridProblem` code, for the editor AND the save button |

Section order, top to bottom: **General** (title, description, poster), **Payment**, **Questions**,
**Advanced settings** (collapsed). The two pages carry the SAME sections in the SAME order: a
setting reachable only once a form exists is a setting a manager cannot plan for.

### Four sections, because six of them buried the common case

The screen carried six top-level cards on 2026-08-26, and a manager writing a plain free form -
title, questions, save - scrolled past every one of them. A response cap, a repeat switch, an
opening date, an audience restriction and a cotisation grant are each wanted by a handful of forms a
year, so they moved into **Paramètres avancés** as three groups separated by dividers: *Réponses*
(cap, repeats, shotgun date), *Qui peut répondre* (`submitCondition`), *Cotisation* (the grant).

A folded section holding a live restriction is a setting nobody can see, so the header carries a
**badge**: `Accès restreint` when `submitCondition` is set, otherwise a count of the settings that
are actually doing something. The audience wins over the count because it is the one that decides
whether a person may answer at all.

**Payment is a MODE, not two half-live displays.** The section used to show the single price and the
grid together, with the price relabelled "Prix par défaut" and used only to seed a new cell - two
numbers on screen, one of which charged nobody. It is now one toggle: either `Prix de base public`
or the grid, never both. Switching the grid on seeds it from the price that was on screen (so no
total changes), switching it off drops it, and removing the last criterion leaves the grid ON with
nothing to divide on - the mode is the manager's to flip, not the editor's.

That state is a save-time refusal (`no_criterion`), because `matrixPayload` sends null for a grid
with no dimension: the save would look accepted while quietly keeping the single price.

### The save bar says the same thing on both pages

`formSummary` exists because the two pages had drifted: create printed the price, edit printed only
the question count, so one form summarised itself two ways depending on which door you came in by.
A grid gets a RANGE (`8 - 20 €`) rather than one number, since it has no single price. Two
duplicated `_short` error keys went the same way - the long sentences are the ones both pages use.

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

`pricing/price-matrix.ts` resolves a subject to a cell, `pricing/validate.ts` refuses an
incomplete or self-contradicting matrix at save time, and `pricing/audience.ts` holds
`matchesCondition` plus `PricingFacts` - the promo, formation and cotisation facts assembled by
`pricing/pricing-facts.service.ts`.

**The module sits at `src/pricing/`, not under `src/forms/`** (moved 2026-08-31). A boutique product
prices on the same grid, and a shared mechanism kept inside one consumer is a mechanism the second
consumer copies. `PricedSubject` is the one thing that varies: it selects the wording of a refusal
("this form" vs "this product") and nothing else, so a single validator can say what is wrong in
terms the manager on that screen recognises. A product's `CriteriaContext.questions` is EMPTY, which
is exactly what refuses an `answer` dimension on it - a product has no questions to price on, and
that refusal costs no code of its own.

### A cell may say the combination DOES NOT EXIST

Some configurations are not sold: "non-cotisant, formule week-end" is a combination the association
never offers. A price cannot say that - 0 means free - and `submitCondition` cannot either, since it
is an AND of criteria and this is a *combination* being excluded, not a person. So a cell is
`CellValue = number | null`, and `null` is the manager's decision that nobody in that situation may
answer (added 2026-08-26, on the user's request to be able to close the grid for "tous les autres").

Three states, never to be confused, and the whole design rests on telling them apart:

| Cell | Meaning | Who honours it |
|---|---|---|
| a number | the price, `0` included = free | `submit` charges it |
| `null` | the combination does not exist | `submit` REFUSES; the fill page greys the option out |
| absent | broken invariant - completeness is enforced at save | `resolveCellPrice` throws |

`hasCell` is the one predicate that separates them, mirrored on both sides. The invariant is
untouched: the grid is still complete, exactly one cell still applies to anybody, and there is still
no priority rule. What changed is that the cell a person lands in may refuse them.

Where each part of that lives:

- **Editor**: a cell toggles between a number and `Indisponible`, and the CELL is the gesture. An
  unavailable cell has nothing to type in, so clicking it is what reopens it; an open cell owes its
  click to the caret, so closing it is the one action left on a control that overlays the cell and
  costs no width (`.cell-action`, shown on hover or while the cell holds the focus, and always shown
  on a coarse pointer - the only affordance a touch screen has). Coming back restores `0`, not the
  price that was there, because that price is gone and `0` is the one value nobody mistakes for a
  considered one. A grid with EVERY cell unavailable is refused on both sides
  (`all_unavailable`, `assertMatrixValid`): that is a closed form, not a priced one.
- **Geometry**: `.price-grid` in `app.css` owns the column sizes; the editor supplies only the two
  counts. The total width has to be NAMED, which is the non-obvious part: `table-layout: fixed` on a
  table of width `auto` treats column widths as PROPORTIONS, not sizes - nine columns declared at
  8rem inside a 1020px box measured 83-91px in Chrome, and unequal. With the total named, every
  price column is exactly its declared size and the wrapper scrolls once they no longer fit; below
  that total each column stretches by the same factor, so they stay equal.
- **Server**: `resolveCellPrice` returns `null` rather than throwing, and `submit` refuses right
  after it - not in `assertMaySubmit`, because only the VISIBLE answers decide which cell applies.
  `hasSubmission` reports `maySubmit: false` when the submitter's whole row is closed, the same
  outcome as an audience refusal.
- **Fill page**: `pricingViewFor` writes every combination explicitly, `null` included. The page's
  old `cells[key] ?? baseCents` was exactly the fallback that would have priced an unavailable
  combination; it now refuses instead, greys out the options that lead to a closed cell (shown, not
  hidden - an option that vanishes reads as a bug), and disables the submit button.

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

`promo` is an **ENTRY year**: la promo 2024 is the cohort that entered the school in 2024. That is
the whole definition, and the prod distribution above corroborates it - 2025 is the largest cohort
and 2026 already exists, which no graduation reading explains.

**It was read as a graduation year here, and that was wrong.** On that reading a bucket needed a
second, relative mode - `yearsToGraduation`, computed as `promo - academicEndYear` - so that "1A"
would not go stale every September. The mode shipped and matched NOBODY it was ever set for: for the
promo 2025 evaluated in 2026 the expression yields -1, while the editor only ever offered 0..4. The
absolute mode was no better off, offering a six-year window (`end-1..end+5`) that contained no cohort
on prod and omitted the three largest that do.

A relative mode cannot be repaired, either: it needs a cursus length, and nothing in this platform
records one (ICM and ISMIN run three years, Master two). So there is **one reading and no mode**. A
group names its years and the manager names the group - `{ id, label: '2A', values: [2024] }` - and
"les anciens" is a group naming several years. What a manager re-types once a year is a number they
can see, which is strictly better than a mode that silently priced a cohort as "everyone else".

The years a manager may pick run from **1816** (the school's founding year, and therefore the oldest
promo there can be) to the current calendar year. The bound is enforced on BOTH sides - `promoYears`
in `criteriaOptions.ts`, `FIRST_PROMO_YEAR` in `pricing/validate.ts` - because `2O24` typed for
`2024` matches nobody for ever, and a criterion that silently matches nobody is what this module
refuses everywhere else.

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
an answer can select a price cell, which is why `forms/visibility.ts` landed with the matrix rather
than after it. It stayed in `forms/` when the rest moved to `src/pricing/`: a product has no
questions, so nothing outside a form can ever ask it anything.

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

Two sources, merged by id and sorted newest-first: forms the caller owns, and forms linked to an
association where they hold `MANAGE_FORMS`. `assertFormManager` has always accepted that second set,
so those forms were editable and exportable by API while appearing in no list on any screen -
reachable only by someone who already knew the URL.

It was three until 2026-08-26: a per-form co-manager list (`forms.coOwners`) named a third set. It
answered the same question as `MANAGE_FORMS` on a second axis and never agreed with it, so the edit
screen offered the section to association managers whose every click 403'd - `assertFormManager`
admitted them, but only the OWNER could change the list. Migration 053 drops the column; the answer
to "who may manage this form" is now the owner plus the association's form managers, one axis, set
in one place.

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

## Sharing a form: the link, and the same link as a QR code

Both `/forms` and the detail screen carry two controls side by side: copy the public link, and show
it as a QR code. The modal (`shared/QrCodeModal.svelte`) knows nothing about forms - the caller hands
it an already absolute URL (`publicAppUrl`), the label the plate and the file name are built from, an
optional owner line, and the sentence saying what scanning it opens. That is what lets whatever comes
next reuse it without a prop naming a feature.

The PNG is rendered ONCE per opening and the preview `<img>` and the download read that SAME blob, so
what a person sees is byte-for-byte what they save. `downloadDecryptedFile` does the saving, as
everywhere else in the app.

### The style is measured, not decorated

`utils/qrCode.ts` does not use `qrcode`'s renderer: it takes the raw module matrix at error
correction `H` and paints it on a canvas sized FROM an integer module pixel size, so the grid never
lands between pixels. Modules are CONNECTED strokes with rounded corners, never isolated dots - a
corner is rounded only where both modules sharing it are light (`moduleCorners`), and the whole grid
is accumulated into ONE path and filled once, so no antialiased seam splits a stroke. The three
finders are stacked rounded squares, the ink is a diagonal gradient between two DARK brand colours,
and the colours are fixed dark-on-light: a QR inverted by a theme is a QR a phone refuses.

Isolated dots were tried first and measured, by decoding the actually painted pixels in a browser
across seven sizes: a 0.84 dot fill decoded 6 times out of 14 combinations against 12 out of 14 for
connected strokes. Adaptive binarisation is the reason - a scanner thresholds a neighbourhood, and a
dot leaves it less dark to find. The look that was asked for and the look that decodes were the same
look. The one remaining failure, a long URL under 160px, is a pure resolution limit: the BARE square
symbol fails at the same threshold, so neither the style nor the badge costs anything there.

The bird sits in a rounded badge over the middle at 22 percent of the side, which
`logoBadgeDamageRatio` keeps under a tenth of the symbol - well inside the 30 percent `H` recovers,
asserted at all 40 versions.

### The plate carries the name

An exported code is read off a poster, where a bare grid says nothing about what it opens. So the PNG
is a taller white plate: the code, then the form title in Fredoka and, when the form belongs to one,
the association name in Nunito - the app's own two faces in its own two text colours. The title wraps
to two lines and then ellipsises. `document.fonts.load` is awaited before drawing, or the canvas
falls back to a system face without saying so. The file lands as `canari-qr-<slug>.png`.

### It encodes the ordinary URL, so the deep link is the app's, not the code's

There is no scheme of our own in the payload: it is the same `https://canari-emse.fr/forms/<id>` the
copy button hands out, which the Android manifest claims with an `autoVerify` intent-filter
(`pathPrefix="/forms/"`) backed by `/.well-known/assetlinks.json`. A scan that lands in a browser
rather than in the app therefore says something about App Link verification on that device, never
about the code - `adb shell pm get-app-links fr.emse.canari` is what settles it, and a scanner that
renders the page in its own webview never consults the resolver at all.

## Note on form management

Association admins also reach a form's submissions, cash validation, edit and delete through the
associations module (`edit/EditFormsTab.svelte`). Building and configuring a form happens in the two
admin routes above.

## Tests

`apps/social-service/src/forms/forms.service.cotisation.spec.ts` (the config refusals, the
`MANAGE_MEMBERS` gate, link immutability, granting on payment) and `forms.service.list.spec.ts` (both
sources, dedup, ordering, naming). The forms module had no test at all before 2026-08-23.

The matrix carries its own: `pricing/audience.spec.ts` (`matchesCondition`, every criterion shape),
`pricing/price-matrix.spec.ts` (cell resolution, the `others` bucket, completeness), `validate.ts`'s
refusals through `forms.service.matrix.spec.ts` (an incomplete grid, a double-counted question, a
condition with no criterion), `forms/visibility.spec.ts` (memoisation, cycles, the legacy pair
ANDed with `showIf`) and `frontend/src/lib/pricing/priceMatrix.test.ts` (the cross product and the
payload). What the boutique does with the same grid is covered by `products.service.spec.ts` - see
[cotisations](../../cotisations.md#a-product-prices-on-the-same-grid-a-form-does).

`frontend/src/lib/utils/qrCode.test.ts` answers the QR claim on PIXELS rather than on the badge's
arithmetic: it rasterises a symbol in pure JS through the SAME exported geometry the canvas draws
(`moduleCorners`, `moduleContains`, `finderShapes`, `badgeShape`) and hands the buffer to `jsQR`, a
real decoder that knows nothing about how the image was made - with no badge, with it, and on a link
far longer than a form URL. happy-dom has no 2D context, which is why the canvas itself is not under
test and the geometry is exported instead of inlined: a retuned radius moves the test with it.
