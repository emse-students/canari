# Forms module

**Routes**: `src/routes/forms/[id]/` (fill), `src/routes/f/[id]/` (a public form, answered without an account), `src/routes/forms/create/` + `src/routes/forms/[id]/edit/` (admin)
**Components**: `src/lib/components/forms/` (the fill page: `FormQuestion`, `FormHeader`)
**Shared logic**: `src/lib/forms/` (`fillAnswers.ts`, `cotisationSettings.ts`, `itemsPayload.ts`, `questionTypes.ts`)

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
  -> social-service: POST /api/payments/create-checkout-session (core, internal)
  -> Redirect to Lydia's payer page
  -> Lydia's confirm callback, verified with the ASSOCIATION'S Business key, triggers a read of the
     row's own request at Lydia (core webhook -> social provider-confirm; payee checked first)
  -> On return (/forms/success?submission_id=...):
       POST /api/forms/submissions/:id/confirm-payment
       (reads the row's own request at Lydia; records it if paid and still pending)
  -> On leaving (/forms/cancel?submission_id=...):
       POST /api/forms/submissions/:id/cancel

If cash payment:
  -> Submit marked as "pending cash"
  -> Association admin validates/cancels via EditFormsTab
```

## The fill page is three reusable pieces and its own payment logic (2026-09-30)

`routes/forms/[id]/+page.svelte` was ~1300 lines holding everything; what any page filling a form
needs is now outside it, so a second fill page (a form opened without an account) reuses rather
than copies it:

| Piece | What it owns |
|---|---|
| `forms/fillAnswers.ts` | The empty selection per type, "is this answered", the first required question left empty (and its sentence), which questions an answer reveals, the answers actually sent, the amount formatter |
| `forms/FormQuestion.svelte` | One question card: label, help, image, and the input its type calls for, bound to the answer. Pricing arrives as two callbacks (`optionModifier`, `optionClosed`), because only the page holds the grid slice |
| `forms/FormHeader.svelte` | Title, banner, the price badge (once, for both layouts), description, the anonymity notice |

What stays in the page is what only a signed-in submission has: the pricing slice, saved cards,
cash, the reminder, and the sticky submit bar.

**One defect closed by the extraction**: validation said `!val` where the progress bar said
`val !== ''`, so a required linear scale starting at 0 counted as answered on the bar and was
refused by the button. `isItemAnswered` and `firstMissingAnswer` now share one predicate
(`fillAnswers.test.ts`). `FormQuestion.svelte.test.ts` mounts the card and asserts that each input
type hands its answer back to the PARENT - the one thing moving it behind a `$bindable` could break.

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

### The submit response names no outcome, because a service with no locale cannot (2026-09-23)

`POST /api/forms/:id/submit` used to answer `{ message: 'Form submitted successfully', submissionId }`
and the page wrote `successMessage = res.message || m.form_view_submission_success()`. The server set
`message` on EVERY success, so the `||` never ran: `form_view_submission_success` - "Reponse envoyee !"
- was dead from the day it was written, and a French interface confirmed a submission in English. That
was not a fallback, it was an unreachable branch, which is why nothing ever reported it.

The response now only IDENTIFIES the submission (`{ submissionId }`) and the page says what happened.
The two other success shapes already worked this way and that is exactly why only one path showed
English: cash returns `{ submissionId, cashPayment: true }` and Stripe returns
`{ checkoutUrl, submissionId }`, neither carrying prose, so both fell through to Paraglide.

**A response field a client RENDERS cannot be written by a service that has no locale.** The server
may return a code or an id; the words are the client's.

STILL OPEN on this page, and deliberately not fixed with it: `error = e.message || m.form_view_...`
at [`+page.svelte`](../../../../frontend/src/routes/forms/[id]/+page.svelte) lines 259 and 529 renders
whatever prose the server threw - `Form is closed`, `Failed to create checkout session: ...` - so the
error half of the same screen is still English. A generic translated fallback would lose the reason,
and picking a translation from the prose is branching on an error message, which
[durable-rules](../../durable-rules.md) forbids. It needs typed error codes on the submit path, which
is a design change rather than this cleanup.

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
  **A required priced question not answered yet has chosen no cell** (`pricedQuestionsAwaitingAnswer`,
  `forms/fillAnswers.ts`): until it is (`priceDecided`), the page says nothing about the price - no
  "from" price in the header, no total in the footer or on the button, no "Combinaison indisponible"
  - and closes no option of ANOTHER priced question (`page.pricing.svelte.test.ts`). Its blank used to fall
  in the "others" group and called "Cotisation BDE 2026" unavailable before any answer (Mi 9T,
  v1.2.9-alpha.3). An OPTIONAL priced question left blank still prices as "others", as the server does.

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

## An anonymous form keeps no author (2026-09-30)

A manager can mark a form **anonymous** at creation (`forms.anonymous`, migration 067). It is the
promise *"the server cannot tell you who answered what"*, and it is kept by what is STORED, not by
what is displayed:

| | Named form | Anonymous form |
|---|---|---|
| `submissions.userId` / `email` | the submitter | **NULL** |
| `submissions.createdAt` | the instant | **cut to the UTC day** - a precise clock would re-join the two tables by order alone |
| "has this account answered" | a `submissions` row | `form_respondents (formId, userId)`, which names **no answer and no time** |
| Responses list and XLSX | newest first, name columns | **random-id order**, no name column, date without time |

The registry insert and the answer are ONE transaction (`ON CONFLICT DO NOTHING ... RETURNING` is
what refuses a second answer from the same account). `allowMultipleSubmissions` still works and then
registers nobody.

**Free only, refused where it is chosen** (`assertAnonymousConfigValid`): a payment names its payer
to Stripe and to the submission, and a cotisation is granted TO an account. A price grid, cash, a
cotisation grant and an option supplement are all refused; the create screen disables the payment
toggle and the anonymity toggle against each other, with the reason as the hint.

**Fixed at creation**, exactly like the association link: turning it on later would promise
anonymity to answers already stored with a name, and turning it off would quietly start naming
people who were told they were not. `update` refuses a present, different value; the edit screen
shows the toggle read-only.

What it does NOT hide, stated so nobody over-reads it: an audience restriction (`submitCondition`,
`showIf`) is still judged against the submitter's profile at submit time, and a question that asks
for a promo or a formation on a small group re-identifies its answerer by itself. The fill page says
only what is stored, not more. Database history (WAL, backups) taken while the answer was written is
outside this mechanism.

## A public form is answered without an account (2026-09-30)

A manager can make a form **public** (`forms.isPublic`, migration 068, switch in "Paramètres
avancés"). Anybody holding its link answers at **`/f/:id`** - no session, no app chrome, no login
redirect (`+layout.ts` lets `/f/` through as it does `/legal`). A member who opens that link is sent
to `/forms/:id`, where the form knows who they are; the share button and the QR code of a public form
hand out the `/f/` address.

**Everything follows from a guest having no identity** (`assertPublicConfigValid`, refused at save
time with the sentence shown on the save bar):

| A guest has no... | so a public form... |
|---|---|
| account to grant to | grants no cotisation (refused at save, and `fulfilPayment` refuses it again for a guest row - ERROR, no grant) |
| profile to match | has no `submitCondition`, no question shown by promo, formation or cotisation (an ANSWER condition is fine), and a price grid on ANSWER dimensions only |
| account to charge | still CHARGES (WP-P1, decision PP1): a base price, an answer grid, option supplements, online payment to the e-mail it types, or cash |
| identity to recognise twice | takes several answers (`allowMultipleSubmissions` is forced on) - identify guests with a "Nom prénom" question |

A guest's answer is a `submissions` row with `userId` NULL and its real time (cut to the day when the
form is ALSO anonymous); the responses table names it "Invité". The two routes live in
`PublicFormsController` under `/api/public/forms/` - nginx strips every identity header there - and
the page calls them with plain `fetch`, never `apiFetch`, whose refresh-and-retry is for a session.

**No captcha**: the edge that offered one is gone. Two guards instead:

- **A throttle of 30 answers per minute per visitor** (`ClientIpThrottlerGuard`). Building it found
  that no per-IP throttle here had ever been one: the container nginx overwrote `X-Real-IP` with the
  Docker gateway, so prod logged `172.25.0.1` for every visitor and the existing "20/min per IP" on
  `/api/public/` was 20/min for everybody. The container now takes the client from the host proxy
  (`set_real_ip_from` the private ranges, `real_ip_header X-Real-IP`) and the guard keys on that
  header. A room of guests behind ONE NAT (a school network at an event) shares an address, which is
  why the limit is far above what one person types.
- **A honeypot** field (`website`), off-screen and out of the tab order. A filled one is answered
  `{ ok: true }` like a real answer, stored nowhere, and logged.

**A guest pays (WP-P1, [chantier](../../public-paid-forms-chantier.md))** through the member's
paid path, with `userId` NULL: the same seat lock and 30-minute hold, the same `markPaid`. What a
guest cannot steer, the server sets: a `userId` or `email` in the body is dropped, and the Lydia
return URL is `/f/:id`, never one the client names. `getPublic` is an allowlist (price, currency,
cash, the answer-grid slice) and the submit reply is one too (`toGuestSubmitReply`: the payer page or
"cash owed", never the submission id). A guest's purchase record has `userId` NULL (migration 103);
the association's Achats tab names it "Invité". Both fill pages total with ONE rule,
`lib/forms/fillPricing.ts`.

### At most three answers waiting per visitor (WP-P3, decision PP5)

A guest's paid answer holds a seat while it waits (30 minutes online, until the cash deadline in
cash), and a public form takes any number of answers from one link - so one script could fill an
event with answers nobody pays. `submit` refuses a visitor's FOURTH waiting answer on a form with a
429 `GUEST_PENDING_LIMIT` (`guest-visitor.ts`, worded by `paymentRefusal.ts`).

- **Counted from the rows, under the form's seat lock**, like the capacity count: a guest's paid
  answer carries `guestVisitorKey` (migration 105) and the count is its rows still WAITING - an online
  one within its hold (`livePendingWhere`), a cash one not validated. A paid, cancelled or expired
  answer frees its place at once, with no job.
- **A cash answer has a deadline, always**: a public form that accepts cash is refused without
  `cashPaymentExpiryDays` (at publication and on every edit; the editor says so under the field).
  An edit that sends an explicit `null` is judged on that null, since that is what it saves. A form
  that charges nothing is not asked: it never reaches cash, so a cash flag left over from when it
  charged is not read (`chargesMoney`). Without a deadline, an unpaid cash answer would hold its seat and its visitor's place for ever, and three
  of them from one shared network would shut that network out of the form.
- **The visitor is its address** (`clientAddress`, the `X-Real-IP` nginx sets - the throttle's own
  key, one function for both). An IPv6 address counts as its **/64** (`visitorNetwork`): a host is
  routinely given a whole /64 and picks its address in it at will, so keyed on the full address one
  visitor would be 2^64 visitors to the throttle and the ceiling. An IPv4-mapped address is its
  IPv4. The key is never the address: an HMAC-SHA256 of the form id and
  the address (keyed, because a plain hash of 32 bits is reversed by trying them all; per form, so
  two forms' rows cannot be joined). Its HMAC key is DEDICATED: HKDF-SHA256 of `INTERNAL_SECRET`
  under the label `canari:guest-visitor-key:v1` (`guestVisitorHmacKey`), never the raw secret, which
  authenticates calls between services. No secret, no key: `submit` throws rather than store an
  unkeyed hash.
- **Kept only while it counts**: `forgetSettledGuestVisitors`, in the 5-minute expiry tick (its own
  `try`), clears the key of every answer no longer waiting. Register row C8 and the privacy policy
  say so.
- **The paid path keeps the free path's guards**: the honeypot drops a paid answer before any row or
  payment, and the route keeps `ClientIpThrottlerGuard` at 30 per minute (both asserted in
  `public-forms.controller.spec.ts`).
- **Known cost**: guests behind ONE address (an event hall's network) share the ceiling - three
  can wait to pay at once, the fourth waits a moment or pays later. Not measured ("to evaluate" in
  PP5).
- **Known cost, kept on purpose**: a filled honeypot answers `{ ok: true }`, which on a PAID form a
  bot can tell from a real reply (no payer page): the honeypot catches form-fillers, it does not
  deceive them. Making the two identical was weighed and refused (2026-10-22): a real online reply
  carries Lydia's payer page, which exists only once a payment request was created AT LYDIA - for a
  bot, to an e-mail it typed, which would make the honeypot a relay of Lydia's e-mails - and a forged
  URL is found out by fetching it. A bot that compares replies also reads past a hidden field, so
  the ceiling and the throttle, not the honeypot, are what bound it.

### The guest's return from Lydia: a receipt, not an id (WP-P2) - A SECURITY SURFACE

A member's return page (`/forms/success`) is authorised by the session; a guest has none, and the
submission id is no proof (it travels in URLs and logs). So `submit` mints a **receipt** for each
guest answer paid online (`guest-receipt.ts`): 32 random bytes, handed out ONCE in the Lydia return
URL `/f/:id/receipt?receipt=...`, stored only as their SHA-256 (`submissions.guestReceiptHash`,
migration 104, `select: false`). Cash needs none: the guest reads the reference on the page that
sent the answer.

- **The receipt is the only key.** `POST /api/public/forms/receipts/confirm` (receipt in the BODY,
  out of access logs) finds the row by the hash and by nothing else. A malformed receipt, an unknown
  one, a submission id or a leaked hash all answer the same 404 (`GUEST_RECEIPT_NOT_FOUND`), with no
  provider read.
- **It confirms as the member's return does**: `confirmPayment`, Lydia read server to server about the
  row's OWN request. Nothing else in the URL is read, so a forged return never marks a row paid; a
  receipt replayed after settlement only reads (no provider call, no second record). The verified
  callback settles a guest row on its own, with no return at all.
- **The answer is an allowlist** (`GuestReceiptView`): reference, form id, amount, currency, status,
  the provider state read on this call - never the submission id.
- **Throttled per receipt** (`GuestReceiptThrottlerGuard`, keyed on the HASH) at the member's
  `CONFIRM_PAYMENT_PER_MINUTE`; anything that is not receipt-shaped counts on the visitor.
- **The reference** ("1A2B-3C4D") is the id's first eight hex digits (`guestReference`). It grants
  nothing; the organiser's responses table files a paying guest under it (`toManagerView`'s
  `reference`), so the guest quotes it and the organiser finds the row. No e-mail is sent (PP2).
- **The receipt stays in the URL, ON PURPOSE**: it is the link the guest reopens while the payment
  confirms (PP2), so the page does not strip it (`history.replaceState` would leave a guest who
  closes the tab with nothing). What it would leak is cut where it is cheap (2026-10-22):
  - the front nginx's access log drops the receipt route's query (`/f/<id>/receipt?query-redacted`,
    the `$logged_request_uri` map in `Dockerfile.frontend`, asserted by
    `access-log-redaction.test.mjs` and run against a real nginx);
  - every `/f/` page is answered with the HEADER `Referrer-Policy: no-referrer` (the
    `$public_form_referrer_policy` map, sent by `@ssr` and `@app_shell`, asserted by
    `static-headers.test.mjs` and run against a real nginx), so the page's own requests - its
    chunks, the confirm call, the retry link - do not carry the URL into that log's referer field.
    It has to be a header: the page boots on the client, so its first chunk requests leave before
    a `<meta>` could apply. The page still carries the `<meta>` for a shell served without that
    header (a dev server).
- **Residual risk, stated**: the receipt stays in the guest's browser history, in Lydia's copy of
  the return URL, and in any proxy in front of this container that logs full URLs (outside this
  repository's control). It does not expire. What bounds it: it only READS one answer's reference,
  amount and status, and asks Lydia about that answer's own request (throttled per receipt); it
  cannot pay, cancel, edit or reveal the answers, the payer or the submission id.

Both return pages share one poll (`lib/forms/paymentReturnPoll.ts`). Each attack above is an
integration test on a real Postgres (`guest-payment.integration.spec.ts`), with its mutation control
written beside it.

**What a priced answer may say (2026-10-22, `answer-options.ts`), for members and guests alike** -
the price is only as good as the answer it is computed from:

- **A visible question that decides a price** - one the grid prices on, or one whose options carry
  a supplement - accepts only its own declared options:
  - one id for a single choice or a dropdown, a list without duplicates for a multiple choice;
  - anything else is a 400: an unknown id would match no group and no supplement, and land on the
    "everyone else" price while reading as the choice it names.
- **The question's TYPE says whether its options charge**: only a single choice, a multiple choice
  or a dropdown. A question turned into a matrix keeps its old options as columns; its answer is an
  object that never charged, so it is not judged, and the editor stores those columns at no price
  (`itemsPayload.ts`).
- **Two questions never share an id** (`assertUniqueItemIds`): every reader resolves a question by
  its id, and two readers resolving a duplicate differently would judge one question and price
  another.
  - **When it applies:** at create, and on an edit whose questions' ids differ from the stored ones
    (a question added, removed, reordered or re-identified). The refusal names both questions, by
    position and label, so the organiser can fix them.
  - **What it never blocks:** a duplicate ALREADY STORED never blocks an edit that leaves the ids as
    they are - a title, a deadline, closing the form. The edit page resends the whole list on every
    save, converted for the API (`itemsPayload.ts`), so the list is compared by its ID SEQUENCE,
    never byte for byte.
  - **What that costs:** an edit that changes a duplicated question's CONTENT but keeps its id is
    not refused either; the next change to the ids is.
  - **It depends on no count.** For the record, a read-only count on 2026-10-22 (one SELECT over
    `forms.items`, no write) found NO form holding two items with one id: 0 of 8 on production, 0 of
    1 on dev. The guard would therefore have refused no stored form either way.
- **The stored answer is the priced one.** The answer to a question the submitter did not see
  (`visibleItemIds`) is neither charged nor required, and it is no longer stored either, nor is its
  file attached.
- **A public form that charges cannot leave a reachable "everyone else" cell at 0**
  (`freeFallbackCells`, checked at publication and on every edit of a public form). That cell is
  reached when a priced question can be skipped (not required), hidden (it has a condition), or
  answered with an option no group holds. The manager prices that cell or marks it unavailable; a
  required, unconditional question whose every option is grouped never reaches it, so a 0 there is
  accepted.

## The file question (2026-10-15)

A question of type **`file`** asks the member for one file (a CV, a certificate). Unlike every other
attachment in the app, **it is NOT end-to-end encrypted**: the form's managers read it, so the
server must be able to hand it to them. That one fact decides the whole design.

| Step | Where | What holds |
|---|---|---|
| Pick | `FormQuestion.svelte` | PDF, JPEG, PNG or WebP, 8 MiB at most - the per-request budget under the host WAF ([host-waf-body-limit](../../infrastructure/host-waf-body-limit.md)) (`fileQuestion.ts`); checked before upload to say it in the reader's language. A file with an EMPTY `type` (some Android pickers) is judged by its EXTENSION (`pickedFileType`), and `accept` lists the extensions too; **HEIC is refused with its own sentence**, not converted - only Apple's engine decodes it, so a conversion would work on one phone in two |
| Upload | `POST /api/forms/:id/files` (social-service, `FormFilesService.upload`) | the member must be ELIGIBLE to answer (`assertMayUploadAnswerFile`: the form's `submitCondition`, the same audience check as submit); the TYPE is read from the bytes, never from the name or the claimed type; the form must exist, be open, NOT public, and the item must be a file question (an `itemId` over 64 characters is a 400); at most 10 unsent uploads per member per form (429), counted again under a `pg_advisory_xact_lock` on (form, uploader) in the transaction that inserts the row, so twelve parallel uploads keep exactly ten - a loser's blob is taken back. Sent through `fetchUpload` (XHR): the card shows the percentage and offers a cancel, and the page REFUSES to send the answer while any file is still travelling (`form_file_wait_upload`) - an optional file question would otherwise go out empty |
| Store | `POST /media/internal/form-file` (media-service, secret-gated) | retention class `form-file`, the uploader as owner, **no contentType recorded**, an image's EXIF/GPS removed by re-encoding (a PDF is untouched). The STORED size never exceeds 8 MiB - a re-encode can grow a low-quality photo, so the quality steps down - and the manager's download is bounded by that same 8 MiB. An image that does not decode, declares over 40 Mpx, or cannot fit is a 400 "send it as a PDF" - see [media-service](../../services/media-service.md#the-form-file-class-plaintext-read-by-the-server-only-2026-10-15) |
| Submit | `FormsService.submit` -> `FormFilesService.attach` | the answer is the file's id; one `UPDATE ... RETURNING` inside the submission's transaction claims the `form_files` row, matching id, form, question, UPLOADER, not purged, and either unsent within one day or already this submission's. No row = the whole submission is refused. `attachedAt = GREATEST(NOW(), submission.createdAt)`: a pending submission reused later keeps its old `createdAt`, and the retention must count from the claim. A transaction whose `NOW()` was read just before the one-day edge may claim a file the purge is deleting at that instant - benign: the manager's first download reads "Fichier supprimé" and marks the row purged |
| Read | `GET /api/forms/:id/files/:fileId` | `assertFormManager` FIRST, then the bytes from `GET /media/internal/form-file/:id` with their own Content-Type, `Content-Disposition: attachment` (ASCII + RFC 5987 name), `nosniff`, `no-store`. Never through `GET /media/:id`, the push proxy's `GET /media/internal/:id` (no per-object ACL - both refuse the class) nor `/media/public` |
| Purge | `FormFileRetentionScheduler`, hourly at :37 | see below |

**Refused at save**, with the sentence on the save bar (`assertPublicConfigValid`,
`assertAnonymousConfigValid`, and `fileQuestionProblem` on the page):

- **a public form** (D40): a guest has no account to upload with;
- **an anonymous form**: the `form_files` row and the blob's owner name the uploader, which would
  re-join an anonymous answer to its author (confirmed by the user 2026-10-15; "a file without an
  account" is a future work package);
- **an ANSWER criterion in `submitCondition`** (`assertFileQuestionConfigValid`, and
  `form_file_submit_condition_answer` on the page): the upload is judged on the form's audience
  BEFORE any answer exists, so such a criterion would refuse every upload. A profile criterion
  (promo, formation, cotisation) is known at upload and stays allowed.

**Cancelling an upload is client-side only.** The card aborts the request, but a file the server had
already stored keeps its blob and its unsent `form_files` row until the one-day purge, and that row
holds one of the member's 10 unsent slots meanwhile. Accepted: a member reaching 10 by cancelling
waits a day, which the 429 sentence says.

**The answer reads as a word, never as its id.** `answerText` (and its declared duplicate
`answer-text.ts`) takes the reader's `AnswerWords` - "Fichier" / "Fichier supprimé" - and THROWS on
a file answer without them, so no screen or spreadsheet can print an id by omission. A file is never
a table column (`COLUMN_TYPES`); the responses panel offers a download under the uploader's cleaned
name (`Submission.fileNames`, sent with the list because a native shell cannot read
`Content-Disposition` cross-origin), or "Fichier supprimé" once purged (`deletedFileIds`).

### Retention: `forms.fileRetentionDays` and the purge

`forms.fileRetentionDays` (migration 085, default **7**, CHECK **1..30**) is a row in "Paramètres
avancés", shown only when a question asks for a file. The purge (`purgeOnce`) has two passes, both
drawn ONLY from `form_files` rows - that table is the allowlist; nothing else is a candidate:

1. **Answer files** whose `attachedAt + fileRetentionDays` has passed: blob deleted, then `purgedAt`
   set. The answer stays and reads "Fichier supprimé".
2. **Unsent uploads** older than one day (the attach window is `createdAt > NOW() - 1 day`, the
   purge `<=`, so the two never overlap): blob deleted, then the row deleted.

**ONE clock, the database's.** A run reads `SELECT NOW()` once and passes it as a parameter to both
selections AND to the re-check of each row, and every interval is counted in hours
(`make_interval(hours => 24 * days)`) like the app's own arithmetic. A box clock a few minutes off the
database's would otherwise select a row the re-check calls "not due", an ERROR line every hour.

**Lowering the retention applies at once, without confirmation** (user decision 2026-10-15): the
next run deletes every file already older than the new delay. The settings hint says so.

**The state is the row.** The blob goes first and the row changes only once media-service says the
blob is gone (or was already absent), so a crash in between leaves a row the next run picks up again.
A blob that fails to delete leaves its row untouched, logged, retried next hour; within one run it is
excluded so the run terminates. media-service checks a second allowlist on its side: it deletes only
an object of class `form-file` OWNED by the named uploader, and refuses anything else even when its
id sits in an answer. One log per deleted file and per failure (`[FORM_FILE_GC]`).

**For reuse (bookings):** `purgeExpiredFiles` in `apps/social-service/src/forms/file-retention-purge.ts`
takes each candidate's START date as data (`{ fileId, ownerId, start, retentionDays }`), so a caller
whose clock starts somewhere else - a booking slot's end - passes that instead of `attachedAt`.

## A form's association is chosen once, at creation

A form is either personal or an association's, and `update` refuses any change to `associationId`
(absent means unchanged; a different value is a 400 naming the reason). Moving a form between the two
would ask who owns it afterwards, and there is no answer that does not surprise someone: the owner
who created it, or the managers who inherited it. The edit screen therefore shows the association as
read-only text rather than a disabled picker - a disabled control suggests someone with more rights
could change it, and there is no such someone.

**The create screen dropped the choice for a free form (fixed 2026-09-19).** `associationId` was
sent to the server only when `requiresPayment` was also true - so picking an association for a
FREE form was accepted by the picker, shown in the summary, and then silently dropped from the
payload: the form saved with no owner, and never appeared in that association's `EditFormsTab`.
Nothing server-side ever required payment for an association to own a form
(`formRequiresStripeReadyAssociation` only gates the STRIPE-readiness check, not whether the field
may be set at all), so the restriction was the create page inventing a rule the API never asked
for. `EditFormsTab` now also carries a "create a form" button
(`/forms/create?association=<id>&returnTo=<back to this tab>`), which is what surfaced it: every
free form created that way would otherwise have vanished from the list that opened it.

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

**The global list's row carries SIX actions** (edit, share link, QR, export, responses, delete) -
labelled pill buttons for all six demanded more width than a row had to give, and the name (the only
flex item with a `min-w-0` floor) lost that fight first, truncating to almost nothing. All six are
now icon-only (`.ui-icon-button`, `title=` for the label), matching the delete button, which already
was. `EditFormsTab`'s three-action row kept its text labels (it never ran out of room) but gained the
same `min-w-0`/`truncate` floor on its name, for the same reason (2026-09-20).

### The responses accordion shows the ANSWERS, and the form decides its own layout (2026-09-20)

The accordion printed four fixed columns - date, name, status, amount - and not one answer, so the
thing a manager opens it for was the thing it did not show. **Nothing was missing from the browser**:
`getSubmissions` has always returned `answers`, and `getForms` returns the whole form, questions
included. The page simply never read them.

A column per question is not the fix either. A form has as many questions as it likes, and three of
the eight types - `long_text`, `multiple_choice`, the two matrices - have no bounded length, so one
paragraph would set the height of every row. **So the layout is derived from the FORM**
(`forms/submissionTable.ts`), not from the viewport and not from a setting:

| | What decides it |
|---|---|
| Becomes a column | `short_text`, `single_choice`, `dropdown`, `linear_scale` - the bounded types - capped at `maxAnswerColumns()` (3 on a paid form, 4 on a free one, measured against the 1024px `tool` width) |
| Never becomes a column | anything conditional (`dependsOn`, `showIf`), whatever its type: it is asked of a subset by construction, so its column is blanks with a few values in it |
| Reads in the row's panel | everything, in the form's own question order |

A form of three short questions therefore lays itself flat; a form of twenty paragraphs keeps its
four columns and puts everything in the panel. Neither needed a decision from anybody.

**The panel lists what the person ANSWERED, not what the form asked.** It is driven by `form.items`
(so a value whose question has since been deleted has no label and is not shown - the export
iterates the items for the same reason) and drops the blanks: a list of what somebody did not say is
longer than the list of what they did.

**The page moved from `reading` to `tool`** (680px -> 1024px). It is the responses TABLE, which
`pageWidth.ts` names as the shape that width exists for, and it is what its own two editor pages
already used. Below `sm` the rows are cards instead: the table overflowed a phone at five columns
before any answer was added to it, and a horizontal scrollbar is not a reading of anything. The two
layouts share every piece through snippets, so the status pill, the panel and the two controls have
one definition each.

### A COLUMN OR A CONTROL THAT CANNOT CARRY INFORMATION IS NOT DRAWN (2026-09-21)

The section above derived the ANSWER columns from the form and left the four fixed ones alone. Two
reports from the user, a day after it shipped, are the same objection applied to what was left:

> *"Pourquoi mettre 'Statut' et 'montant' pour un formulaire gratuit ? Et le fait de mettre a la
> fois un volet pour derouler fait doublon si la reponse est deja sur la ligne."*

**A FREE FORM DRAWS NEITHER STATUS NOR AMOUNT.** When `requiresPayment` is false every status reads
`free` and every amount reads `-`, down the whole table - two columns of one repeated value, costing
about 180px each out of the 1024 the page has. `requiresPayment` is not a new notion: it is the one
predicate `summary.ts` already reads to print the free label, and the one `itemsPayload.ts` zeroes
every price modifier on. **It is passed from the page, never inferred from the submissions** - a paid
form whose responses are all still `pending` would infer as free, and a column must not appear the
day somebody finally pays.

The freed width is not left blank: `maxAnswerColumns(false)` is **4**, so a free form draws one more
question than a paid one. That is the same rule as the cap itself - a column is worth its width or it
is not drawn.

**AND A CHEVRON THAT OPENS A PANEL HOLDING NOTHING NEW IS A CONTROL A READER MUST CLICK TO DISCOVER
IT WAS POINTLESS.** The redundancy the report names is not "inline answer AND panel" - for a form
whose purpose is comparing proposals across rows, the inline answer is the scannable thing, and
removing it would mean opening every row to read a table. What is redundant is the CONTROL, on the
rows where it adds nothing. So `panelAddsNothing(answered, columns, isClipped)` disables it when:

- every question this person answered is already a column, **and**
- every one of those cells is showing its answer IN FULL.

A form of one short question therefore loses its chevron on every row, which is the outcome the
report asked for; one paragraph, one conditional question or one clipped answer brings it back on the
rows that have one, which a blanket removal would not have. **The predicate is asked with the columns
the CALLER draws, never with the ones the form would allow** - the card layout below `sm` draws no
answer column at all, so it passes an empty list and keeps its control wherever there is an answer.
The control is disabled rather than removed, so the columns of a table whose rows differ still line
up under their headers.

#### The second half of that report: what "fits its cell" is, and who is allowed to say it (2026-09-22)

The first implementation answered it with a constant - `COLUMN_CELL_CHARS = 25`, `max-w-48` less its
gutter divided by an average glyph at `text-sm` - and the user came back with the obvious question:

> *"pourquoi certaines lignes sont depliables et d'autres non ?"*

**There is no character count that is right, because whether a string fits a box is a fact about a
font, a zoom level and a browser.** Two answers of the same length land on either side of any
threshold, so the table showed a reader rows that expanded next to rows that did not with no visible
rule between them. `reportClipped` replaces it with the browser's own answer, `scrollWidth >
clientWidth`, reported by each cell through a `ResizeObserver` into a `SvelteSet` the control reads.
It re-measures on mount, on resize **and on text change**, the last because a clipped element's
border box does NOT move when its content does.

**AND THE CELL WAS NEVER ACTUALLY BOUNDED.** `max-w-48` on a `<td>` is a *suggestion* under auto
table layout: the browser widens the cell to fit its content anyway, so `truncate` never fired, the
answer was fully visible on the row, and the panel repeated it word for word - the same doublon the
report opened, one step removed. The width now lives on a `<div>` inside the cell, where `max-width`
is honoured, which is also what makes the measurement mean anything.

The lesson generalises past this table: **a threshold that stands in for a measurement the platform
will make for you is a guess, and it is a guess a user meets before you do.**

The colspan is the case neither file shows on its own: it is a number written beside a header list
that now has two lengths, and a short one leaves the panel ending mid-table. `answers.svelte.test.ts`
asserts it equals the rendered header count on both.

### THE XLSX IS WRITTEN IN WORDS THE SERVER DOES NOT HAVE (2026-09-22)

The same report that asked about the chevrons carried a second half:

> *"Au niveau de l'export excel, les en-tetes sont en anglais et Amount Paid et Status apparaissent
> quand meme sur un formulaire gratuit."*

Both are the same defect seen twice: **the export was built where none of the decisions live.**
`FormsService.exportSubmissions` runs in a NestJS service with no Paraglide, no locale and no request
language it could trust, so it wrote its own English - `Timestamp`, `First name`, `Amount paid` - and
the raw `free` enum into the status column, into a file a French manager opens. And it had never been
told about `requiresPayment`, so the two columns the table had just learned to drop were still there,
one repeated value down the whole sheet.

**THE FIX IS NOT A TRANSLATION TABLE ON THE SERVER. It is that the server owns no word at all.** The
client sends `ExportLabels` - the five fixed headers and every payment status label it knows - as a
URL-encoded JSON query parameter, built by `exportLabels()` from Paraglide. `parseExportLabels`
validates it at the boundary and **refuses when it is absent or incomplete**: there is no default,
because the only thing this side could substitute is the English that was the defect, and a silent
fallback ships a wrong file that looks right. A status the client had no word for is written AS
STORED and logged at `warn` - the row is telling the truth about itself, and a blank would hide the
one case worth seeing.

The free/paid rule is now the same predicate on both sides, `requiresPayment`, the one `summary.ts`
reads and the one `itemsPayload.ts` zeroes every price modifier on. `forms.service.export.spec.ts`
asserts it by **parsing the workbook back** rather than by reading a header constant, and
`export-labels.spec.ts` covers every way the parameter can be wrong.

The payment status labels themselves moved out of `FormSubmissionsTable.svelte` into
`frontend/src/lib/forms/paymentStatus.ts` on the same day, for the reason the duplicate reader below
exists: the screen and the file answer one question, and a second copy of the mapping is one added
status away from them disagreeing about the same row.

### Configurations the API refuses

`FormsService.assertCotisationConfigValid` runs on create AND update, and rejects every setting that
would look saved and then do nothing:

- a grant with no beneficiary association, or a price grid divided on a cotisation tier without one;
- a grant on a form that does not require payment — a zero-total submission is stored `free` and
  never reaches `markPaid`, so the grant could not fire;
- either of those on an association with no cotisation;
- a `variantKey` the association does not sell;
- a base-tier grant on an association that sells named tiers only.

A file question is refused on a public or an anonymous form, and `fileRetentionDays` outside 1..30
([the file question](#the-file-question-2026-10-15)).

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

**The reading of a stored answer is a DECLARED DUPLICATE**, and the two suites over it are why.
`frontend/src/lib/forms/answerText.ts` and `apps/social-service/src/forms/answer-text.ts` are the
same file byte for byte, declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses
them drifting; `answerText.test.ts` and `answer-text.spec.ts` assert the same cases on each side.
They answer ONE question - what did this person answer - asked by the responses table and by the
XLSX an hour later, and those two must not be able to disagree. The copy exists because there is no
TS library between `frontend/` and `apps/` ([libs](../../libs.md)). `submissionTable.test.ts` covers
which questions become columns, and `FormSubmissionsTable.answers.svelte.test.ts` mounts the
component for the part neither file can prove: that a column arrives as a header AND a cell, that the
panel is shut until opened, and that its `colspan` still spans the whole header.

The file question has its own suites: `form-files.service.spec.ts` (every upload refusal - wrong
type read from the bytes, too big, closed/public form, not a file question, too many pending - the
ownership statement at submit, the download's 404/410), `forms.service.file.spec.ts` (refused at
save on a public or anonymous form, attached inside the submit transaction, the manager list),
`forms.controller.files.spec.ts` (a non-manager download refused before any byte is read; the
headers), `form-file-retention.scheduler.spec.ts` (a stateful fake database and media service: the
purge run twice, a blob that fails, a file of another class whose id sits in an answer left alone),
and media-service's `media.service.form-file.spec.ts` (the class refused on every client route and
by `DELETE /media/:id`, the purge allowlist, EXIF/ICC stripped with the orientation applied, a PDF
byte-identical). Front: `fileQuestion.test.ts` (empty type, HEIC), `FormQuestion.svelte.test.ts`
(progress, cancel, the busy signal), and the file cases of `answerText.test.ts` and
`FormSubmissionsTable.answers.svelte.test.ts`.

**What a mock cannot prove runs on a real Postgres**: `form-files.integration.spec.ts` applies
migration 085 to a throwaway schema and drives the real service and scheduler - a claim past the
window, by another uploader, of a purged row, from another form, two submissions racing for one
file (exactly one wins), `attachedAt` on a reused submission, twelve parallel uploads (exactly ten
kept), the purge run twice and a lowered retention. It is the ONLY test guarding the `GREATEST(...)`
on `attachedAt`, the advisory lock and the claim SQL as Postgres executes it, and **it runs in CI on
every pull request touching social-service** (`test-social-integration`, against production's
PostgreSQL, failing on any skipped test - [cicd](../../cicd.md#package-1-opening-a-pull-request-ciyml)).
Locally:

```sh
docker run -d --rm --name formfiles-pg -e POSTGRES_PASSWORD=it -p 55432:5432 postgres:18-alpine
cd apps/social-service && SOCIAL_IT_DATABASE_URL=postgres://postgres:it@localhost:55432/postgres \
  bun run test -- src/forms/form-files.integration.spec.ts
```

`frontend/src/lib/utils/qrCode.test.ts` answers the QR claim on PIXELS rather than on the badge's
arithmetic: it rasterises a symbol in pure JS through the SAME exported geometry the canvas draws
(`moduleCorners`, `moduleContains`, `finderShapes`, `badgeShape`) and hands the buffer to `jsQR`, a
real decoder that knows nothing about how the image was made - with no badge, with it, and on a link
far longer than a form URL. happy-dom has no 2D context, which is why the canvas itself is not under
test and the geometry is exported instead of inlined: a retuned radius moves the test with it.

## The paid half: what it needs, scoped 2026-09-30

Found while scoping it, so it is not re-derived (the paid half itself waits for WP-LYDIA-1, [backlog](../../backlog.md)):

- **The payer's e-mail IS Lydia's `payerRecipient`** - the Lydia payer-address blocker resolves itself for a
  guest form, since the guest types an e-mail. It does not for a logged-in boutique purchase.
- **`social-service` calls `core-service`'s `create-checkout-session` WITH the shared internal
  secret** (`internalCoreRequestConfig()`, `apps/social-service/src/internal/core-request.ts`), and
  the route has accepted it since 2026-10-07 (`apps/core-service/src/payment/payment.controller.ts`
  documents the 401 it used to answer). This line said "no credential" until 2026-10-15, which was
  stale. A guest needs no `X-User-Id` for the checkout itself; what is still NOT verified is one
  observed paid form on dev.
- **Fulfilment works without a `userId`** since WP-P1: the purchase record takes NULL and the
  cotisation grant is skipped (and refused at save).
- The scope widened on 2026-10-15 (PP1): price, ANSWER grid, supplements and cash; never a grid on
  the profile nor a grant.

## Four defects found on dev v1.1.2-alpha.2 (2026-10-07)

- **Deleted form = `404`, not an empty `200`.** `FormsService.get` returned `null` and Nest sent a
  `200` with no body, which `getForm` could only call "Empty response from server" in raw English.
  It now throws `NotFoundException`; `getForm` throws the typed `FormNotFoundError` on a 404 and the
  view and edit pages render `form_view_not_found` (Paraglide).
- **A global admin who is not a member** arrived from an association's Formulaires tab with no
  selector (the builder lists MEMBERSHIPS) and a preselected id that matched nothing.
  `lib/associations/requestedAssociation.ts` fetches the requested association when the memberships
  lack it; the server stays the authority (it lets a global admin create for any association).
- **A paid form's refusal reason** now carries the same "Le prestataire de paiement a refuse ce
  paiement" sentence as the shop toast: `submitForm` throws a `SocialApiError` (typed `code`), and
  `providerRefusalMessage` (`lib/associations/paymentRefusal.ts`) words it for both surfaces.
- **No Stripe copy anywhere in the form UI (2026-10-07, user: only Lydia "Paiement Canari" and
  cash).** `lib/associations/paymentProviderCopy.ts` `onlinePaymentCopy`: the form editor shows ONE
  non-selectable online line ("Paiement Canari", paid on Lydia's secure page) and the cash toggle.
  A leftover `stripe` or `disabled` provider shows an explicit "unavailable" line, an unknown one a
  neutral line without description - never a default. Saved cards stay Stripe-only via
  `supportsSavedCards` until the backend batch (see [payments](payments.md)).

## A form with submissions is archived, never removed (2026-10-11)

`submissions.formId` had no foreign key, so deleting a form orphaned its submissions (29 on prod and dev, 5 paid: the payers' records, nameless). Migration 081 adds `forms."deletedAt"` and `submissions_form_fk` (`ON DELETE RESTRICT`, never CASCADE: a cascade would delete paid rows). No tombstone rows exist.

- **One removal path**, `retireForms(manager, { formId } | { associationId })` in `apps/social-service/src/forms/retire-forms.ts`: a correlated `EXISTS` on `submissions` decides per form - archive (`deletedAt = now()`) when it holds any, hard delete when it holds none. `FormsService.delete` and the association delete (inside its one transaction) both call it; a bare `remove` or `manager.delete(Form, ...)` would now be refused by the key.
- **Respondents and lists never see an archived form**: `list` (admin, owned, association scan), `get`, `getPublic`, `submit` (member and guest), `hasSubmission` and `subscribeReminder` filter `deletedAt IS NULL` and answer 404 / no right to submit.
- **Staff still do**: `assertFormManager` and `getSubmissions` do not filter, so an archived form's submissions stay readable by id (owner, global admin, MANAGE_FORMS of the association). An archived form keeps its `associationId`; deleting the association archives rather than detaches it, and it appears in no list, so it cannot show as "Personnel".
- **The migration refuses to run while orphans exist**: it RAISES with their count, so it cannot deploy before the data is cleaned. The 29 orphans were backed up and deleted on both estates on 2026-10-11, and the migration shipped in `v1.2.4` (first on dev in `v1.2.4-alpha.1`). It is idempotent (`IF NOT EXISTS`, a `pg_constraint` check).
- **Every call was a SQL syntax error from `v1.2.4` to its fix (found 2026-10-19)**: TypeORM's `getQuery()` returns a bare `SELECT ...`, so `EXISTS ${sub}` produced `EXISTS SELECT ...`. Form deletes and association deletes both failed. The unit spec's mock returned the parentheses itself, so it passed; the spec now mocks the bare string, and `retire-forms.integration.spec.ts` runs it against PostgreSQL.
- **Still owed (carried over when the backlog entry was closed, 2026-10-18)**: an integration run of migration 081 on a real database (none was reachable when it was written), and the purchase-history name of a paid submission of an archived form (the form row still exists, so it is nameable; not exercised).


## An online payment holds its seat for 30 minutes, and a late one is decided from the row (2026-10-15)

Measured on `main` before this: `submit` counted `pending` toward `maxSubmissions` and nothing ever released it, so an abandoned checkout kept its seat for ever (cash had its own expiry, `expireStalecashPayments`). Decisions PP3 and PP4 of the paid public forms chantier (`public-paid-forms-chantier.md`, planning), for ALL forms, then D1-D3 (user, 2026-10-15) after the adversarial review.

- **The hold is read from the row.** `apps/social-service/src/forms/seat-hold.ts` holds the one constant (`PENDING_PAYMENT_HOLD_SECONDS`, 30 min, from which the Lydia request's shorter lifetime is derived, D1 below) and the one SQL fragment (`PENDING_HOLD_CUTOFF_SQL`, on the DATABASE clock: the column is a `timestamp` written by the database's `now()`, and the service process does not run in the same zone - measured +2 h against a UTC session). The hold counts from **`paymentRequestedAt`** (migration 084), the instant the row's CURRENT payment request was issued, not from `createdAt`: `submit` reuses a live pending row and issues a new request, and the hold restarts with it. `seatHoldingWhere` counts `paid`, `free`, `pending_cash` and a `pending` younger than the hold; the seat count, `get`, `getPublic`, `hasSubmission` and the reuse in `submit` all read it, so a seat is free the moment the hold passes, whether or not any job ran.
- **A retry is not a new answer.** `submit` looks the person's live pending row up BEFORE the capacity check: it already holds their seat, so a retry on a form it filled is reused instead of being refused as "Form is full" (which it was on `main`).
- **The job only makes the row say it.** `FormReminderScheduler.expireStalePendingPayments` (every 5 min, a `running` flag against self-overlap) first reads at Lydia every `pending` row whose request has ended and settles it on a verified answer (the reconciliation sweep, [lydia-api](../../lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for)), then moves what is left `pending` past the hold to `expired` - never a delete, the row is the trace a late payment is matched against. Its `WHERE` names the only state it leaves, so a second run moves nothing. `paymentMethod` tells an online `expired` (null) from a cash one (`cash`).
- **A late payment (`markPaid`) is decided under the form's row lock** (`lockFormSeats`, `SELECT ... FOR UPDATE` on `forms`, READ COMMITTED). A row still holding its seat becomes `paid`; one that holds none (`expired`, `cancelled`, `pending` past the hold) becomes `paid` while the cap has room, else **`paid_over_capacity`**, logged at WARN with the submission, the form and the amount. It grants no cotisation (no seat was given) but keeps its purchase record (the payer's trace). Refunding is the organiser's, outside the application: no refund mechanism exists.
- **What a payment buys runs from durable flags.** The cotisation grant and the purchase record run after the payment's commit; `cotisationGrantedAt` and `purchaseRecordedAt` (migration 084) are CLAIMED by a conditional `UPDATE` only one caller can win, and released if the effect failed. A replay of the same payment (a repeated Lydia callback, or the callback and the payer's return - `confirmPayment` - both landing in `markPaid`) finishes only what is still NULL: before this, each call re-granted and wrote another purchase record, and a failed grant was lost for good. The migration sets both flags on every row already `paid`, because the old code ran both effects on every call.
- **The row names its current request by BOTH of Lydia's ids.** `request/do` answers a numeric `request_id` (what the callbacks and `request/cancel` carry) and a `request_uuid` (what `request/state` and the return URL carry), measured on the sandbox 2026-10-15 ([payments](payments.md)). `submit` stores the first in **`paymentRequestId`** (migration 084) and the second in `stripeSessionId`, by named-column `UPDATE`: the whole-entity `save` it replaced wrote the pre-transaction `paymentRequestedAt` back and silently undid the hold restart of a reuse (measured on Postgres 18).
- **`markPaid` never decides by id, but accuses a foreign one.** One payment can reach it under TWO ids (the callback's `request_id`, `confirmPayment`'s `request_uuid`), and the row now stores BOTH, so idempotence still comes from the row alone (a settled status is a no-op, the two flags) and a replay by either id is silent. The id that settled the row goes in **`paymentSettledBy`** (migration 084) and `stripeSessionId` is no longer overwritten. A confirmation on a settled row naming NEITHER stored id is a second request paid for one answer: logged at ERROR with both sides, status unchanged (the money landed; refusing would hide it). A row written before 084 names only its uuid, so its own callback's numeric id is not accused.
- **One answer per person, at submit (2026-10-21).** A submit after a PAID answer on a single-answer form inserted a new row and issued a new `request/do`, and a second paid purchase was recorded for one answer. `submit` now reads the person's rows UNDER THE FORM LOCK (`answerHoldingWhere`: every seat-holding row plus `paid_over_capacity`) and refuses ANY such row other than the live pending one it reuses - every row is read, not the newest, so an older paid answer behind a newer pending one still refuses (review of #2215) - with **409 `ALREADY_ANSWERED`** (Paraglide `form_already_answered` via `paymentRefusal.ts`) before anything is issued: it is checked FIRST, before the settle that would cancel a pending request at Lydia, and again under the lock. `hasSubmission` reads the same predicate, so the page shows such an answer as answered - and, reading every such row as the guard does, shows the most decided one (`pickShownAnswer`: paid or paid over capacity, then free or cash, an online `pending` last), so a legacy older paid row behind a newer pending one no longer shows "pending" with a retry the server refuses. Logged at INFO: a second tab or a back button is expected, not an accusation. A `cancelled` or `expired` row (declined, cancelled or expired request) is no answer, so the retry after it goes on. Anonymous forms keep their registry, guests and multiple-answer forms are untouched. Tests in `forms.service.seat-hold.spec.ts`. Controls, each run by deleting the check: the lock-held check alone fails one test, two simultaneous FREE answers by the same person (both pass the early check before either row exists, and only the check under the lock stops the second insert); the early check alone fails two, an older paid answer behind a live pending row (the lock-held check still refuses, but only after the settle has cancelled the request at Lydia); both together fail seven; the newest row picked again in `hasSubmission` fails three.
- **One answer per person, also for a late payment.** On a single-answer form, a late payment whose payer already has another row holding a seat or paid lands `paid_over_capacity`, logged at ERROR: never a silent second `paid`.
- **Two decisions of the lead session, 2026-10-22 (decided as lead, not by the user's own word).** (1) A refund done outside the app, or a manager deleting a paid answer, does NOT free the single-answer slot: `ALREADY_ANSWERED` stays, and a refund stays a manual act on the association's Lydia account until refunds are an actual feature. (2) A person holding a `pending_cash` answer who then submits online stays REFUSED; a manager converts or cancels the cash answer first.
- **`cancel-pending` applies only to the row's CURRENT request.** core-service names the request it reports (the callback's `requestId`), and `cancelPendingSubmission` compares it to the stored id under the row lock: another id leaves the row as is, logged, and a report naming none is refused. A row with no stored id matches no report and leaves `pending` through the expiry job. Since #1910 (merged 2026-10-15) the multipart callbacks are parsed, so every cancel or expiry is reported; the comparison and the settled-row no-op are what make that safe. **And the report is a trigger, never the verdict (2026-10-18):** a current, payee-matching report then reads the row's `request_uuid` at Lydia (`settleFromProvider`), and only `declined` or `cancelled-or-expired` (`SETTLED_REFUSED_REQUEST_STATES`) releases the seat - under the lock, while the row still names the uuid read; `paid` records the payment; `open`, an unmeasured state or a failed read keeps the seat (`unreadable` is core's retryable 503) ([payments](payments.md#what-confirms-a-payment-2026-10-16)).
- **What confirms a payment: the callback, and the payer's return when the callback has not (2026-10-15).** It was claimed here that "every payment reaches `markPaid` twice", the callback and `verify-session`. **False, measured on the sandbox** ([payments](payments.md#what-requeststate-answers-and-what-it-does-not-2026-10-15)): `verify-session` took the submission from the `order_ref` it expected `request/state` to echo, and no variant of that call echoes it, so it could never name a submission; and no page reached it anyway, since Lydia does not fill `{CHECKOUT_SESSION_ID}` and the return URL carries `submission_id` instead. The callback was the ONLY confirmation, and a payment whose callback was lost stayed `pending` until the job expired it. `verify-session`, `cancel-session` and `retrieveSession` are deleted. **`POST forms/submissions/:id/confirm-payment`** (submitter or manager) replaces them: on a `pending` row - and on an `expired` or `cancelled` one that names a request, since a payment made at the end of the hold whose callback is lost leaves the row released with no seat (`CONFIRMABLE_PAYMENT_STATUSES`) - it reads the row's OWN `request_uuid` through core-service `payments/request-state` with the Business's vendor token and, on `paid`, calls `markPaid` with that uuid, which decides it like any late payment (`paid` while the form has room, else `paid_over_capacity`) and re-checks UNDER THE ROW LOCK that the row still names the uuid read (`onlyIfRowNames`: a retry that replaced it settled it itself, so nothing is written, at WARN); on `declined` (the payer refused, state 5) or `cancelled-or-expired` (6) it RELEASES a `pending` row to `cancelled` under the row lock, only while the row still names that uuid (`releaseSettledRefusedRow`), so the payer may retry at once (see [a declined payment](#a-declined-payment-releases-the-answer-2026-10-21)); `open` and `unknown` answer the row unchanged, a failed read at WARN. A row whose id is not a Lydia uuid (32 hex digits, `LYDIA_REQUEST_UUID_RE`) - a Stripe-era `cs_...` - is not asked about at all, one INFO line, since core would refuse it with a 400 on every poll. It is throttled per user and submission (`UserResourceThrottlerGuard`, `CONFIRM_PAYMENT_PER_MINUTE` = 12, above the return page's 10-read poll), since each call spends the platform's tokens on Lydia; a 429 ends the poll on "awaiting confirmation". `1 = paid` and `5 = declined` were measured on dev on 2026-10-21 ([payments](payments.md#what-requeststate-answers-and-what-it-does-not-2026-10-15)). The success page polls it instead of the plain read, so a payment reaches `markPaid` once (callback, or return) or twice (both, in either order). Nothing comes from the client but the submission id it may already read - unlike the public `mark-paid` deleted on 2026-08-22. The same measurement found `payments/request-state` refusing every real request: it validated the uuid as the dashed RFC 4122 shape, and Lydia issues 32 hex digits with no dash, so every settle that reached the state read (D2 below) answered 409 on `main` from #1906 until this fix, before any release carried it. Fixed (`SESSION_ID_RE`), with a test that fails on the old shape.
- **What confirms a payment since 2026-10-16: Lydia's answer about the row's OWN request, on either trigger.** The callback is verified with the Business private token of the association that owns the payment, over every received field but `sig` (measured on the sandbox), and is then only a TRIGGER: `provider-confirm` checks the row's payee account is the verifying Business (an authentic callback of one association never settles another's row) and runs the same `settleFromProvider` read as `confirm-payment` - `markPaid` only on Lydia's `paid`, never on the callback's word or amount. An association with NO key stored has its callbacks refused (one 400, the same as a bad signature) and its form payments confirmed only on the payer's return - the designed state, shown in the Lydia panel as "callbacks cannot be verified yet" until a payout manager enters the key. Mechanism, key storage and the boutique gap: [payments](payments.md#what-confirms-a-payment-2026-10-16).
- **The cancel page tells the payer what happened.** It reads the row first and shows a payment the callback already confirmed as paid (or over capacity), never as cancelled; a cancel that found the request PAID at Lydia (`alreadyPaid`) shows the same; the 409 `PREVIOUS_PAYMENT_OPEN` is an answer, shown with its own title and `form_previous_payment_open`, logged at info rather than as an error; anything else says the cancel is not confirmed and when the answer is released. `paymentCancelView` in `paymentReturn.ts` is the one mapping.
- **Every status move is one locked step.** `submit` takes the form lock too (its REPEATABLE READ transaction prevented neither race its comment named: measured on Postgres 18, four concurrent submits on a 1-seat form took 4 seats on `main`, 1 now). `cancelPendingSubmission`, `validateCashPayment` and `cancelCashPayment` go through `moveLockedSubmission` (row lock, check, write), so a cancel or expiry callback of an old request cannot overwrite a `paid` committed in between.
- **The manager sees it first.** `getSubmissions` and the XLSX put `paid_over_capacity` rows on top (`overCapacityFirst`); `frontend/src/lib/forms/paymentStatus.ts` labels both new words (the XLSX takes them from the client, as above) and colours an over-capacity pill as refused, not settled. The return page (`paymentReturn.ts`) keeps waiting on `expired` (a late payment may still land) and says "payment received, form full" on `paid_over_capacity` - it says the payment is at the top of the organiser's responses and to contact them about a refund, and promises neither a notification (D3) nor a refund nothing here enforces.

### A declined payment releases the answer (2026-10-21)

Measured on dev (sandbox): a payer who DECLINES on Lydia's page leaves the request in state `5`, Lydia sends **no callback** and shows its own error page with **no link back**. core-service read `5` as an unmeasured `other`, so the answer stayed `pending` and a retry answered 409 `PREVIOUS_PAYMENT_OPEN` for up to 30 minutes, with no button on the form.

- **The state is a TYPE, classified once at the provider boundary**: `CheckoutRequestStateKind` (`payment-provider.interface.ts`) is `open | paid | declined | cancelled-or-expired | unknown`, from `LYDIA_REQUEST_STATES` (`lydia-payment-provider.ts`: 0 / 1 / 5 / 6). `unknown` - any other code, logged at WARN - is never paid and never settled. social-service reads the wire value through `toRequestState` (`seat-hold.ts`); a word it does not know (an older core's `closed` mid-deploy) is `unknown` too, so a deploy in either order refuses rather than releases.
- **`declined` and `cancelled-or-expired` are `SETTLED_REFUSED_REQUEST_STATES`**: a retry's settle frees the row on them, and `confirmPayment` releases a `pending` row to `cancelled` on them. `confirmPayment` answers `requestState` (the typed state read on that call), from which `paymentReturnVerdict` (`paymentReturn.ts`) derives `declined` / `ended`: the success page says so (`form_success_declined_*`, `form_success_ended_*`) with a retry link.
- **The form page asks once on load.** `GET forms/:id/check` now answers the caller's own `submissionId`; when it is `pending` the page calls `confirm-payment` once, and on a dead request it re-enables the pay button (the retry) with `form_view_payment_declined_note` / `form_view_payment_ended_note`. The same mechanism covers an expired or cancelled request whose callback was lost (state 6 while the row still reads `pending`).
- **A stale state is never answered** (review of #2210): a retry may replace the request between `confirmPayment`'s read and its answer (two tabs, the success page polling while the payer retries). `requestState` is answered only while the row still names the uuid that was read, and the client never derives `declined` / `ended` from a row still `pending`: either would offer a retry that cancels the request being paid.
- **Not covered**: an answer whose request is still `open` (the payer closed the tab) keeps "pending" with no button until the hold ends - the server would cancel and reissue on a retry, but the page offers none ([backlog](../../backlog.md#p2---an-answer-whose-lydia-request-is-still-open-shows-pending-with-no-button-for-up-to-28-minutes-2026-10-21)).

### D1-D3 (user, 2026-10-15) and where each stands

| # | Decision | What it changes | State |
|---|---|---|---|
| D1 | The Lydia request dies with the hold | `submit` sends `expireAfterSeconds: PAYMENT_REQUEST_LIFETIME_SECONDS` = hold - `PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS` = 1800 - 120 = **1680 s** to `create-checkout-session`, and `lydia-payment-provider.ts` puts it in `request/do` as `expire_time` (whole seconds; a value that is not a positive integer is refused there, since Lydia reads 0 as "never"). The margin: Lydia's expiry sweep fired 61-79 s after the deadline on the sandbox, plus the callback's latency, so the request is dead before the seat is released | **DONE** (2026-10-15). A payment landing after the hold anyway is decided from the row like any late payment |
| D2 | Single-answer form: REUSE the pending row and SETTLE the previous Lydia request first (one row, one payable request) | `settleOpenRequest`, BEFORE the transaction and while the row still names its request: core-service `payments/cancel-request` (numeric `request_id` + vendor token). `cancelled` -> free. Error 2 (`already-settled`) was measured only on cancelled and expired requests and very probably answers a PAID one too, so it is followed by `payments/request-state` (uuid + vendor token, measured): `cancelled-or-expired` (6) or `declined` (5) -> free; **`paid` (1) -> the row is marked paid (`markPaid`) and the retry STOPS with `alreadyPaid`** (the payer paid in the app without coming back; a second request was a second charge). Anything else - a failed call, `open`, `unknown`, a row naming NO request (its request is being issued right now), a row written before 084 that names only its uuid and is still open - refuses with **409 `PREVIOUS_PAYMENT_OPEN`** (Paraglide `form_previous_payment_open` on the client) rather than leave two payable requests. **How long a refusal lasts:** at most until the row's hold ends, 30 minutes after `paymentRequestedAt`; past it the row is no longer live, is not reused, and the retry writes a new answer. For a row written BEFORE migration 084, `paymentRequestedAt` was backfilled from `createdAt`, so the bound is 30 minutes after the answer was CREATED - not 30 minutes after the deploy (as #1906's description said), and already over for any answer older than that when 084 ran. The client sentence names that bound ("au plus tard 30 minutes après son lancement"), not "in a moment". Only after a free answer does the transaction clear the ids, re-reading the row under its lock: it must still name the settled request, and a row its own request's cancel callback cancelled meanwhile is taken back (capacity re-checked). A request that is never issued (refused, failed, payments off) releases its row at once (`releaseUnissuedRow`). The submitter's own cancel (`cancelSubmission`) settles by the same rules | **DONE** (2026-10-15). A row past the hold is not reused (left for the job, a new row written); its request died with D1. Lydia's answer to `request/cancel` on a PAID request is not measured - the state read is what makes that unknown harmless |
| D3 | Notify the organiser actively on `paid_over_capacity`, plus the durable "cotisation granted" flag | the flag is built (`cotisationGrantedAt`); the notification is its own type under the EXISTING `forms` category | **BUILT, SWITCHED OFF** (2026-10-22): [the organiser alert](#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off) waits for `minClientVersion` to cover #1911. The return page's over-capacity sentence promises no notification, and keeps not promising one until the switch is on |

### The organiser is told when a payment lands over capacity (D3, built 2026-10-22, SWITCHED OFF)

A row that `markPaid` settles `paid_over_capacity` owes a refund nobody was told about: the WARN line and the pill at the top of the responses were the only trace. The alert tells the form's managers, once.

- **At most once, from the row.** `fulfilPayment` runs on every settle AND every replay; for a `paid_over_capacity` row it claims `organiserNotifiedAt` (migration 102, schema only) through the same `claimFulfilment` / `releaseFulfilment` pair as the two flags of 084 - a conditional `UPDATE ... WHERE "organiserNotifiedAt" IS NULL` exactly one caller wins - then writes the notice, and RELEASES the flag if writing it threw, so the next replay of the same payment retries it. A replayed callback, the payer's return racing the callback, or two settles at once write it once. No clock anywhere. The money path itself is unchanged: the status decision and the two older effects are as they were, the alert is a third effect after them.
- **P3, residual and accepted: a released flag is retried ONLY when the SAME payment confirmation is replayed.** Nothing sweeps `paid_over_capacity` rows with a NULL `organiserNotifiedAt`, so when the write fails and no replay of that confirmation ever comes, the alert is lost and the one trace is the ERROR line `alertOrganisersOnce` writes ("not written - released for the next replay"). The WARN of `markPaid` and the pill on the responses are still there.
- **Who: the owner, plus the association's members whose OWN rights carry `MANAGE_FORMS`** (`AssociationsService.listFlagHolders`). **Decided by the user (2026-10-22, #2228): the BDE super-admins are NOT included, and neither is a global administrator as such** - minimisation: a notification must lead to a page its recipient can open, and the tap opens `/forms`, which lists the reader's own forms and those of associations where they hold `MANAGE_FORMS` themselves (`FormsService.list`). If a BDE supervision is wanted later, it is a separate summary, not this notice. Not the payer.
- **What: the form's title, nothing else** - no payer, no amount (a lock screen is read by whoever holds the phone). One bell row per recipient, type `form_paid_over_capacity`, `postId` = the form, actor `system` / `Canari`; one push per recipient, `contentKey` `form_paid_over_capacity` with the title as its only argument, filed under the EXISTING `forms` category (`push-category.ts`: a new category id is a switch older clients cannot draw), no icon. `FormOrganiserAlertService` (`apps/social-service/src/forms/organiser-alert.service.ts`) owns the who and the what; the claim is `FormsService.alertOrganisersOnce`.
- **Where a tap lands: that form's responses.** They are an accordion on `/forms`, not a page, so the server writes the explicit deep link `fr.emse.canari://form-responses/<formId>` (`FORM_RESPONSES_TARGET` in `push-target.ts`, checked BEFORE the plain `form/<id>` that opens the page answering the form), `appRouteForDeepLink` and `notificationHref` both answer `/forms?responses=<formId>` (`frontend/src/lib/forms/responsesLink.ts`), and the list opens that accordion once it has loaded and scrolls to it. A form the list does not hold is said by `Log.i('forms.responsesLink', ...)` (so it reaches the in-app log a device reading sees) and nothing opens.
- **A push only fails a push.** The bell rows are what the claim covers; the pushes are LAUNCHED WITHOUT BEING AWAITED once the rows are written (bounded, best-effort), so a failed one is logged per recipient (`[FORM-ALERT] push failed`), the bell row stays, and the claim is not released - re-sending the whole notice to retry one push would tell the others twice.
- **THE SWITCH: `FORM_ORGANISER_ALERT_ENABLED = false`.** A client older than #1911 draws an unknown notification type as a COMMENT linking to `/posts/<formId>`, so a new type ships only once the floor covers that fix ([legacy-compatibility](../../legacy-compatibility.md#no-date-yet---a-notification-type-the-client-does-not-know-from-any-new-server-type)). #1911's first stable is `v1.2.9`; the floor reads `1.2.7` since 2026-10-17. **The switch stays ONE one-line constant (user, 2026-10-22).** **The exact precondition to set it to `true`:** `minClientVersion` at or above the version that CARRIES #2228 (its first stable, not merely `1.2.9`), on BOTH estates (production and dev each hold their own row in `/admin/platform`), once BOTH Play AND the App Store serve that version. **The flip is a follow-up pull request** that changes the constant AND the spec pinning it (`organiser-alert.service.spec.ts`, "ships switched off"), and nothing else; someone else runs it. While it is off, a row settled over capacity is NOT claimed (`organiserNotifiedAt` stays NULL) and a debug line says so; the WARN of `markPaid` is unchanged. **Why `1.2.9` is not enough:** a build between `1.2.9` and the release carrying #2228 would show the bell row as the neutral "cannot show" row of #1911, and on Android drop the tap's link (the host `form-responses` is declared in `tauri.conf.json` and the manifest only from #2228 on), so the app would open where it was. The precondition above is what removes both.
- **Tests and controls.** `forms.service.seat-hold.spec.ts` (the claim around a stubbed service: off, once, replays sequential and concurrent, a failed write released then retried, a seated payment never told), `organiser-alert.service.spec.ts` (recipients, the row, the push payload, a failed write throws, a failed push logged), `organiser-alert.integration.spec.ts` against real Postgres (migration 102 applied to a `synchronize`d table and re-run, the real `markPaid`, `listFlagHolders` and `post_notifications`, every case above). Each guard was removed and the tests failed, then restored byte for byte: the switch check (2 fail), the claim (8), the release (2), the over-capacity condition (2), the `MANAGE_FORMS` holders (6), the responses deep link (1), the switch flipped on (1). On the client: the bell href, the deep-link host, the row sentence and the list's link handling each fail their test when removed.

Tests: `forms.service.seat-hold.spec.ts` runs the service on an in-memory store that evaluates its own `where` clauses and refuses any transaction that is not READ COMMITTED (the boundary one second either side of the hold, two simultaneous submits on the last seat, the reuse restarting the hold on a full form, the job twice, a late payment with and without room, two simultaneous late payments on the last seat with a real per-form mutex, replays, a failed grant retried, one payment confirmed under both ids in both orders, a cancel against a paid row, a cancel naming another request (not even read at Lydia), a verified cancel whose request Lydia reads open, unmeasured, paid or not at all (the seat kept, or the payment recorded) and one whose request a retry replaced during the read, the request lifetime (1680 s), the old request settled before the new one with the row still naming it, an old request found PAID stopping the retry, a failed cancel / open state / failed state read / request being issued each refused with `PREVIOUS_PAYMENT_OPEN`, the old request's cancel callback landing DURING the retry and taken back, the submitter's cancel settling the request, a confirmation naming another request accused at ERROR, a late payment on a one-answer form whose payer already has a seat or a payment, the payer's return (`confirmPayment`) recording a payment no callback confirmed, then a late callback as a silent replay, and leaving an open/unknown/unreadable request pending, and the bodies core-service posts entering through `InternalFormsController`: webhook confirm and the payer return's uuid in both orders and at once, a cancel or expire callback after the payment, one between the two confirmations, a payment after its own expiry - one transition, one grant, one purchase each). Controls (each makes it fail): the lock removed from `markPaid`; REPEATABLE READ put back in `submit`; the cancel comparison removed; error 2 read as cancelled without the state read; a failed settle carried past; the one-answer check removed; the foreign-id accusation removed; the take-back of a self-caused cancel removed. The core half is in `lydia-payment-provider.spec.ts` (`expire_time`, `request_id`, `request/cancel` and its error 2, `request/state` and its codes) and `payment.controller.spec.ts` (`request-state` takes the uuid as Lydia issues it, 32 hex digits; it fails on the old dashed pattern). **Real Postgres is NOT in CI**: the Postgres 18 runs quoted on this page (concurrency, migration 084 twice, the hold restart surviving the id write, the real core controllers wired to the real internal route) were throwaway scripts on the pull request, not committed tests - the committed proof is the in-memory store above. `paymentStatus.test.ts` and `paymentReturn.test.ts` (with `paymentCancelView`) on the client.

## What a client reads of a submission is an allowlist (2026-10-15)


**The rotation of the payment-provider and document-vault secrets that were readable before this allowlist is DONE, per the user, 2026-10-22** (relayed by the lead session; the exposure windows stay in the private notes).
`GET /api/forms/submissions/:id` (the submitter or a manager, read by the payment return pages)
answered a payment-provider account credential that no client field read. The two submitter reads and the two
manager lists (`:id/submissions`, `:id/submissions/pending-cash`) also answered the whole row:
the provider ids (`stripeSessionId`, `paymentRequestId`, `paymentSettledBy`), the hold clock and
the fulfilment flags.

`apps/social-service/src/forms/submission.projection.ts` now decides, as an ALLOWLIST, so a column
added later is private until someone adds it there:

- the submitter's view: `id`, `formId`, `answers`, `totalPaid`, `paymentStatus`, `paymentMethod`,
  `cashExpiresAt`, `createdAt`. `GET submissions/:id` answers `id`, `formId`, `totalPaid`,
  `currency` and `paymentStatus` only.
- the manager's view adds `userId` and `email`. Both lists use `userId` to name the submitter
  (`submitterName`, the pending-cash list), and a manager already reads both on member pages.

`submission.projection.spec.ts` fills every private column (and the vendor token) with a
recognisable value and fails if any client read carries one, by value or by key name. Control: it
fails 4/4 against the previous service.

**The association reads had the same leak, closed the same way (2026-10-15).** `GET
/api/associations` and its siblings answered the same payment credential and other private columns, through a denylist rather than an allowlist.
`apps/social-service/src/associations/association.projection.ts` (`toAssociationView`) is now an
allowlist on every route that answers a row: `GET /`, `slug/:slug`, `:id`, `me/list`, `POST /`,
`PATCH :id` and both logo routes. The token and the dashboard URL have their own read,
`GET /api/associations/:id/payout-account`, behind `canManagePayoutAccount` (MANAGE_PAYOUT_ACCOUNT,
the permission the onboarding and the disconnect already ask; a BDE super-admin does not inherit
it), and the Lydia panel (`LydiaBusinessOnboardingForm.svelte`) is its only reader.
`associations.controller.spec.ts` fills the token, the dashboard URL, the vault key and the notes
with recognisable values and fails if any of the eight routes answers one, by value or by key name;
a member without the flag gets a 403 from the payout read. The token was readable by every member
until this shipped, so whether it can be rotated is a question for Lydia
([backlog](../../backlog.md)).
