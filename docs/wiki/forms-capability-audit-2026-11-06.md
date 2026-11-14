# Forms - what associations need and cannot do yet (audit, 2026-11-06)

**Status (re-read 2026-11-09): sections 1 and 4 are BUILT** - the defects and the priced grid (WP-G0..G5) shipped from `1.6.6` on, and their mechanism is in [forms](frontend/modules/forms.md), the only copy; **section 5 from rank 3 (G-DUP) down is OPEN**, tracked by [its backlog entry](backlog.d/p2-forms-the-gaps-left-after-the-priced-grid.md). Written as an AUDIT + DESIGN, every product question decided by the owner 2026-11-06 (section 8). Read on `main` at `e19c6443d2` (2026-11-06). Asked by the
owner the same day: *"Il faudrait faire aussi des grilles plus propres. Et pouvoir mettre un prix ? En
fait il faut que tu fasses une passe globale pour regarder ce qui n'est pas faisable dans les
formulaires actuellement, ce n'est pas normal."* The mechanism of what exists is in
[forms](frontend/modules/forms.md) (the only copy); this page lists what is MISSING, what is BROKEN,
and the design of the one gap the owner already decided: **the priced grid** (section 4).

Reading order: section 1 (defects - they come first whatever the plan), section 4 (the decided
priced grid and its work packages), section 5 (every other gap, ranked).

## 1. Defects - should work, does not

| # | Defect | Evidence | Severity | Fix size |
|---|---|---|---|---|
| **D1** | **Every form holding a visible grid question (`matrix_single`, `matrix_multiple`) is refused at submit, member and guest alike, answered or not.** The fill page sends a grid's answer as an object `{ rowLabel: value }` - and sends it even when empty, since `initialSelections` seeds `{ row: '' }` per row and `visibleAnswers` filters by visibility, not by answered. `IsValidAnswers` (`apps/social-service/src/forms/dto/form.dto.ts`) accepts only a string, a string array or a number per key: an object fails, the global `ValidationPipe` answers 400 `answers must contain at most 50 keys; each value must be ...`, and the page prints that English prose (`e.message`). | Probed 2026-11-06: `validateSync(plainToInstance(SubmitFormDto, { answers: { q1: { Vert: 'M' } } }))` fails on `answers`, a plain string passes (a throwaway jest spec, deleted). The validator dates from `c586c84cb9` (2026-06-01), the grid types from 2026-05-27; no test submits a grid answer through the DTO (`forms.service.matrix.spec.ts` calls the service directly). **Not observed on a device**: one submit of a grid form on dev settles it. | **P1** - a user-facing path broken for five months, and it is exactly the owner's hoodie form | S |
| D2 | A `long_text` answer over 2000 characters is refused with the same English 400: the textarea carries no `maxlength`, no counter, and the bound (`ANSWERS_MAX_STRING_LEN`) is told to nobody. A cover letter is routinely longer (recruitment, section 3). | `FormQuestion.svelte` (no `maxlength`), `form.dto.ts` | P2 | S |
| D3 | A form with more than 50 visible questions is refused at submit (`ANSWERS_MAX_KEYS = 50`), because every visible question's EMPTY selection is sent too. The editor never says there is a cap. | `form.dto.ts`, `fillAnswers.ts` `visibleAnswers` | P3 (rare) | S |
| D4 | Grid rows are stored as LABELS (`rows: string[]`) and an answer is keyed by the label: two rows with one label collide in the answer and share one radio `name`; nothing refuses a duplicate row label at save. | `FormItemDto.rows`, `FormQuestion.svelte` (`name={matrix-...-${row}}`) | P3 | S |
| D5 | A required grid demands an answer in EVERY row (`isItemAnswered`), with no way to turn that off - Google Forms makes it an option ("Require a response in each row"). For an order ("which colours do you want") a required grid is unusable. | `fillAnswers.ts` | P3 (moot once section 4 ships; still true for survey grids) | S |
| D6 | The submit error half of the fill page still renders server prose (`e.message ||` fallbacks, `routes/forms/[id]/+page.svelte` lines 295 and 433) - already recorded as open in [forms](frontend/modules/forms.md#the-submit-response-names-no-outcome-because-a-service-with-no-locale-cannot-2026-09-23); D1-D3 are three more English sentences reaching a French user through it. | | P3 | M (typed codes on the submit path) |
| D7 | **Stale wiki** in [forms](frontend/modules/forms.md): the "Payment methods" table still names Stripe Checkout and saved cards (the form UI is Lydia + cash since 2026-10-07), and three passages say "no refund mechanism exists" - refunds from Canari exist since enrolment lot 4 and free the seat of a refunded form answer (`refunds.service.ts`, `UPDATE submissions SET "paymentStatus" = 'refunded'`; [payments](frontend/modules/payments.md#refunds-from-canari-enrolment-lot-4)). | | doc | S |

D1 ships first and alone (WP-G0 below): it is independent of every design question.

## 2. What the forms feature can do today (inventory)

### Question types (`SUPPORTED_QUESTION_TYPES`, mirrored by `QUESTION_TYPES`)

| Type | What it supports | What it does not |
|---|---|---|
| `short_text` | label, help text, image, required, `showIf` | no format (e-mail, phone, number), no length bound, no pattern |
| `long_text` | same | 2000-character hard cap, unannounced (D2) |
| `single_choice`, `dropdown` | options with an integer-cent **supplement** each; may be a price-grid dimension (then no supplement) | no quota per option, no "other" free-text option |
| `multiple_choice` | options with supplements (each ticked option adds once) | no min/max selected, no quantity per option |
| `linear_scale` | min, max, two end labels | no star/emoji rating |
| `matrix_single`, `matrix_multiple` | rows x columns, radio or checkbox per cell | **cannot be submitted (D1)**; never priced (its answer "never charged", `answer-options.ts`); every row required (D5); rows keyed by label (D4); editor is two full-width input lists |
| `file` | one PDF/JPEG/PNG/WebP, 8 MiB, re-encoded, readable by managers only, purged after 1-30 days | refused on public and anonymous forms; one file per question; 30 days max retention |

Absent: number, date, time, e-mail, phone, quantity, product, section/page break, statement (text-only block), signature, ranking.

### Form-level options

| Option | Support |
|---|---|
| Price | `basePrice` OR a **price matrix** (cross product of dimensions: cotisation tier, `notCotisation`, promo groups, formation, an ANSWER to a choice question; generated "everyone else" bucket; a cell may be "unavailable"), plus option supplements. Computed server-side only (`priceFor` + `calculateModifiers` in `submit`). |
| Payment | Lydia online (one consolidated line item, 30-min seat hold, request expiry 1680 s, reconciliation sweep, typed refusals), cash with an expiry and manager validation. Refunds from the association's Achats tab (full or partial). Amount bounded by the provider range. |
| Capacity | `maxSubmissions` = **answers**, not seats or items; `paid_over_capacity` for a late payment; organiser alert built but switched off. |
| Window | `opensAt` (shotgun) with "remind me" push at opening, `closedAt`. |
| Who | `submitCondition` (same criteria), per-question `showIf`; one answer per account unless `allowMultipleSubmissions`. |
| Cotisation | a paid answer may grant a tier (`grantsCotisation`, MANAGE_MEMBERS). |
| Anonymous | no author stored, day-precision time, free only, fixed at creation. |
| Public | `/f/:id` without account; may charge (WP-P1); 30/min throttle, honeypot, 3 waiting paid answers per visitor; receipt + reference, no e-mail. The in-flight option-rules work lets a public form keep a profile grid, the guest paying "everyone else". |
| Outputs | responses accordion (bounded types as columns), XLSX export (one column per question, words from the client), QR code plate, calendar link. |
| Lifecycle | archive instead of delete once answered; association fixed at creation. |

Not present at all: duplicate a form, edit an answer, waiting list, promo code, date-based price, per-option quota, sections/pages, results summary or charts, confirmation e-mail or receipt to a member, review status on answers, deposit or instalments.

## 3. Use cases walked through the current feature

| Use case | Where it breaks or forces a workaround |
|---|---|
| **Merch (hoodie by size x colour)** | A grid cannot be submitted (D1) and could never carry a price or a quantity. Workaround: one `single_choice` per colour with sizes as options, one supplement each - no quantity, so two hoodies = two answers with `allowMultipleSubmissions`, no cart total, no per-variant count in the export. **Section 4.** |
| Several products in one order | Only supplements on choice questions; no quantity, so "3 stickers + 1 mug" is not expressible. Covered by section 4 (several priced grids add up; a 1 x 1 grid is a single product with a quantity). |
| **Event ticketing** - ticket types | A `single_choice` "Tarif" priced by a grid dimension or by supplements works. Member/non-member price: works (cotisation dimension). **Quota per ticket type: no** (G-QUOTA). **+1 guest: no** - a second seat is not counted, `maxSubmissions` counts answers (G-SEATS). **Early bird: no** date dimension (G-DATEPRICE). **Promo code: no** (G-PROMO). |
| Gala with menu and diet | Works: choice questions (menu priced by the grid's answer dimension), `showIf` for follow-ups, long text for allergies. Missing: per-menu quota (G-QUOTA), a guest's own menu (G-SEATS). |
| Trip registration | ID upload works for members (file, 8 MiB, manager-only) but **retention is 30 days at most**, often shorter than the trip's lead time; impossible on a public form. Emergency contact: free text only, no phone format (G-VALID). **Deposit / instalments: no** (G-DEPOSIT). |
| Time-slot booking | Not a form job: [bookings](bookings-chantier.md) (built, WP-B7 left). Forms has no slot type and should not get one. |
| Polls and elections | One account one vote: yes (named, or anonymous via `form_respondents`). Eligibility: `submitCondition`. **Results: none** - only the XLSX; no counts or chart (G-RESULTS). No "results visible to voters after close". |
| Recruitment | Long answers capped at 2000 chars (D2); file works (members only). **No review workflow**: no status/notes/tags per answer, no shortlist filter (G-REVIEW). |
| Sign-up with waiting list | "Form is full" is final; no waiting list, no promotion when a seat frees (G-WAITLIST). |
| Edit / cancel an answer | A member cannot edit an answer at all; may cancel only a PENDING online one. A manager may delete an answer or refund a payment (seat freed). (G-EDIT) |
| Exports and accounting | XLSX only, one row per answer, amount + status; **no line items, no totals per option or variant, no payment reference column** (G-EXPORT; the variant half is in section 4). |
| Validation | Only `required`. No e-mail/phone/number/min/max/length/pattern (G-VALID). |
| Sections, branching | `showIf` on an answer or a profile criterion exists and is judged server-side. **No pages/sections, no "go to section"**, no condition on a grid answer (G-SECTIONS). |
| Confirmation / receipt | No e-mail anywhere in social-service. A member sees the answer on the form page; a guest gets a reference (PP2, by design). No organiser-written confirmation text (G-CONFIRM). |
| Closing date, max responses, one per person | All present. |
| Duplicate last year's form | **Not possible**; rebuilt by hand, prices and grid included (G-DUP). |

## 4. The priced grid - DECIDED (owner, 2026-11-06), designed here

### 4.1 The requirement, as decided

Reference: a Google Forms "Grille de cases à cocher" titled *SWEAT CAPUCHE BY011 PREMIUM 28€*, help
text *300g - 60% coton - broderie*, columns XS..XXL, rows *Sweat capuche - Vert / Bordeaux / Noir /
Bleu Marine / Crème / Gris*, a compact zebra table with a narrow wrapping first column. Owner:
*"je veux pouvoir mettre des prix différents aux différentes colonnes/lignes, ou bien tout mettre au
même prix, cocher plusieurs fois et que ça multiplie etc."* Then four answers (2026-11-06):

1. **Quantity**: each cell is a **stepper** (0, 1, 2...), the creator sets a **maximum per cell**;
   total = sum of quantity x unit price.
2. **Tiers**: prices are set **per category** (e.g. 25 € cotisant, 30 € autres) - for each tier, one
   price, or one price per row, or one per column. **A guest pays "autres".**
3. **No stock** on the grid: it is a pre-order; the association orders from the answers. (Stock per
   cell stays a possible later gap, G-STOCK.)
4. **Mobile**: one card per row showing its price, the columns as tappable pills/steppers, **no
   horizontal scroll**. Desktop keeps the Google-like table.

### 4.2 A NEW question type, not a mode of the survey grid

`product_grid` (French label *Grille d'articles*). Reasons:

- The survey grids answer "what do you think, per row"; this one answers "how many of each". Their
  answer shapes (`{ row: optionId }` vs quantities), their required rule (every row vs at least one
  item) and their pricing (never vs always) all differ. A mode flag would put an `if` in every reader.
- **An older client renders an unknown type as a label with no input** (`FormQuestion.svelte` has no
  `{:else}` branch). Turning an existing `matrix_multiple` priced would let such a client send a
  checkbox answer to a priced question; a new type cannot be mis-read, only not drawn.
- `answer-options.ts` already says a grid's answer "never charged"; that stays true.

**Survey grids keep living**, get D1/D4/D5 fixed and the cleaner editor (G-GRIDEDIT, section 5).

### 4.3 The stored shape (inside `forms.items` jsonb - no form migration)

```ts
interface ProductGridItem {
  id: string; type: 'product_grid'; label: string; description?: string; imageUrl?: string;
  required: true;                       // forced: see 4.8 (older clients)
  rows: { id: string; label: string }[];      // ids, never labels (D4)
  columns: { id: string; label: string }[];   // a single column/row = a one-axis product
  maxPerCell: number;                   // 1..99; 1 draws a checkbox instead of a stepper
  closedCells: string[];                // 'rowId:colId' combinations not sold (decision Q2)
  pricing: {
    mode: 'single' | 'per_row' | 'per_column';
    /** null = one price list for everybody. Otherwise ONE profile Dimension (cotisation,
     *  notCotisation, promo or formation - never an answer), the same type as a price-matrix
     *  dimension, buckets + the generated '_others'. */
    tiers: Dimension | null;
    /** bucketId ('_all' when tiers is null) -> axis key -> cents.
     *  axis key: '*' (single), a row id (per_row), a column id (per_column). Complete, >= 0. */
    prices: Record<string, Record<string, number>>;
  };
  showIf?: AudienceCondition;           // as any question
}
```

- **Row price + column surcharge: NOT in v1.** It is the only mode needing two numbers per cell and a
  sum rule the payer must reverse-engineer; the realistic case ("XXL +2 €") is `per_column` with
  XXL's own price. If a real form needs both axes, the extension is a per-cell price (`mode:
  'per_cell'`, axis key `row:col`), not a surcharge rule.
- **A closed combination** (no Crème in XS, decided Q2): the creator clicks the cell in the editor;
  it is stored in `closedCells`, drawn **struck through and disabled** for the buyer (shown, not
  hidden - the same rule as an unavailable price-grid cell, an option that vanishes reads as a bug),
  and the server refuses any quantity on it (`PRODUCT_GRID_INVALID`). It applies to every category.
  A grid with every cell closed is refused at save.
- **No cap per order** (decided Q1): `maxPerCell` is the only bound; the total of an answer is
  bounded by it and by the provider's payable range, which `submit` already refuses with its typed
  code.
- **A second order is a second answer** (decided Q3): adding a `product_grid` switches
  `allowMultipleSubmissions` ON in the editor (the manager may turn it off for a one-per-person
  sale). No answer is ever edited (decided Q7). With several answers on, `submit` reuses no pending
  row, so each order has its own row, request and reference.
- One tier dimension per grid, not a cross product: "cotisant / autres" is the case named; a promo x
  cotisation cross product would multiply the price inputs per row by the number of cells.

### 4.4 The answer shape - and the DTO change it shares with D1

`{ "<rowId>:<colId>": quantity }`, zero cells omitted. ONE level of object, so `IsValidAnswers`
needs exactly the extension D1 needs: a value may also be a flat object (bounded key count, keys
<= 80 chars, values string | string[] | number). Row and column ids are UUIDs, so `:` never occurs in
them.

### 4.5 Server pricing - where it plugs in (never trust the client)

`FormsService.submit` today: `priceFor` -> `baseCents` (base price or the form's price-matrix cell),
then the per-item loop adds `calculateModifiers` for choice supplements, then `totalCents` becomes ONE
consolidated Lydia line item (`create-checkout-session`, `unit_amount = totalCents`), bounded by
`PROVIDER_MIN/MAX_AMOUNT_CENTS`, stored as `submissions.totalPaid`. The grid adds one step in the same
loop, for a VISIBLE `product_grid` item:

1. `parseProductGridAnswer(item, answer)` (new `forms/product-grid.ts`): every key a declared
   `row:col`, every value an integer `0..maxPerCell`, else 400 with a typed code
   (`PRODUCT_GRID_INVALID`). At least one unit when required.
2. The tier: `bucketFor(item.pricing.tiers, facts)` (`pricing/audience.ts`) - the same resolver the
   form grid uses. A guest has no profile, so every profile criterion lands in `_others` (the
   option-rules work in flight already states that for the form grid). `factsFor` must ask the
   profile when any `product_grid` has `tiers` (extend `dimensionsNeedProfile`'s input).
3. `productGridLines(item, quantities, bucketId)` -> `{ itemId, rowId, colId, rowLabel, colLabel,
   quantity, unitCents, lineCents }[]`; their sum is added to `totalCents`.
4. The base: a merch form has `basePrice = 0` and no form grid. A form may still combine a
   registration price (base or form grid) with product grids - they add.

Everything downstream is unchanged: the seat hold, the reuse of a pending row (its `answers` and
`totalPaid` are rewritten - and its `lines`, below), D2's settle, cash, `markPaid`, refunds (partial
refunds already exist for a returned item).

**`requiresPayment`**: a form with a `product_grid` must have `requiresPayment = true`; an answer
whose total is 0 is impossible because the grid is required (>= 1 unit) and a price may be 0 only if
the creator says so - a total of 0 then stores `free`, as today.

**Anonymous**: refused (it charges). **Public**: allowed; the guest pays `_others`. **Cotisation
grant**: unaffected (the grant is form-level).

### 4.6 One migration: the priced lines are snapshotted on the answer

`submissions.lines jsonb NULL` (schema only, additive, no backfill). Written in `submit` with the lines
of 4.5 (null for a form without a product grid). Why it is needed: a creator edits a price or renames
"Bleu Marine" after 40 orders; the export and the responses must say what was CHARGED, not what the
form says now, and `totalPaid` alone cannot be split back into lines. It also lets a refund name the
line it returns. Projection: added to the submitter and manager views in `submission.projection.ts`
(allowlist).

Editing a form with answers: rows/columns are matched by id, so a rename is safe and a deleted row's
past orders stay readable from `lines`. A price change applies to new answers only; the editor says so
under the price fields when the form has answers.

### 4.7 Respondent rendering

- **Price shown where it varies**: in the header for `single` ("28 €"), under each row label for
  `per_row`, in each column header for `per_column`. Only the CURRENT viewer's tier is shown - the
  `check` endpoint (member) or `getPublic` (guest) sends the resolved table `productGridPrices:
  { itemId: { axisKey: cents } }`, so the page derives no tier rule (as `memberPricing` today).
- **Desktop (`sm` and up)**: the Google-like table - narrow wrapping first column, zebra rows
  (`--cn-*` tokens), one compact stepper `[-] n [+]` per cell (a checkbox when `maxPerCell` = 1),
  a line "3 articles - 84 €" under the table.
- **390 px**: one card per row (label + its price), the columns as pills in a wrapping flex row, no
  horizontal scroll. Tapping a pill sets it to 1 and turns it into a pill-sized stepper ("M x1 -/+");
  minus at 1 returns it to a plain pill. With `maxPerCell` = 1 a pill is a toggle. Cards stack, so 6
  colours x 6 sizes is 6 short cards, not a 36-cell table.
- The running total joins the sticky submit bar through `fillPricing.ts` (the ONE client total
  rule); the server recomputes and that figure is charged.

### 4.8 Older clients

**Decided Q4: the type opens as soon as it ships; an old app is refused at submit with "mettez à
jour l'application".** An app older than the release carrying the renderer draws the label and no
input. Because the type is **always required**, its submit carries no answer for the grid, and the
server refuses it with a TYPED code, `400 { code: 'FORM_UPDATE_APP' }`, before any row or payment -
never an empty order that would then hold a seat. A current client never reaches it (its own
required check stops first) and words the code through Paraglide; an old client prints the server's
`message` raw (D6), so that one sentence is written for it in both languages - *"Mettez à jour
l'application pour répondre à ce formulaire. / Update the app to answer this form."* - the
precedent being `AUDIENCE_COTISATION_BOTH_MODES`, whose English sentence also tells an older editor
to update. Also ship, in WP-G0, an `{:else}` branch in `FormQuestion.svelte` saying the same, so any
future type degrades visibly.

### 4.9 Editor

A compact table editor (`ProductGridEditor.svelte`, used by `FormBuilder.svelte` for this type):

- Columns as chips in a header row (inline-editable text, x on hover/focus), rows as a narrow first
  column of inline inputs - the table IS the editor, so it doubles as the preview.
- **"Coller une liste"** on each axis: a textarea, one entry per line (commas also split), appended
  in order; duplicates refused with a sentence.
- Drag handles on rows and columns (reusing the drag-exclusion work in flight so inputs keep their
  pointer events).
- Price mode as a segmented control *Prix unique / Par ligne / Par colonne*; the price inputs appear
  where the mode puts them (one field, a price column beside the row labels, a price row under the
  headers). Euros in the UI, cents on the wire (`itemsPayload.ts`).
- *Prix par catégorie*: off, or pick ONE criterion with the existing `CriterionEditor`; the price
  inputs then show one tab per bucket (*Cotisants*, *Autres*), each a complete price list. Save-time
  refusals reuse `pricing/validate.ts` (partition, overlap) plus completeness of `prices`.
- *Quantité max par case* number input (default 5).
- Live preview: the respondent component rendered disabled, toggled desktop/mobile.

### 4.10 Responses and export

- `answerText` (the declared duplicate, both copies) reads a `product_grid` answer as
  `Vert / M x2; Noir / L x1`, from the row/column labels, falling back to `lines` for a deleted row.
- Not a responses column (unbounded); read in the row's panel.
- XLSX: the main sheet keeps one row per answer (the text above). **New sheet "Articles"**: one line
  per (answer, cell) from `lines` - name or "Invité"/reference, row, column, quantity, unit price,
  line total, payment status. **New sheet "Totaux"**: per grid, rows x columns quantities and
  amounts, counted over `paid` + `free`, with a separate block for `pending_cash` (money not yet
  received). Words come from the client's `ExportLabels`, as every other header.

### 4.11 Work packages (hand to builders in this order)

| WP | Scope | Files | Migration | Size | Risk |
|---|---|---|---|---|---|
| **WP-G0** | D1 + D4 + D2's announcement: `IsValidAnswers` accepts a flat object; server checks a survey grid's answer against its declared rows/columns; refuse duplicate row labels at save; `maxlength` + counter on `long_text`; `{:else}` "update the app" branch in `FormQuestion.svelte`. Test: a grid answer through the real `ValidationPipe` (the gap that hid D1). Read on dev: one grid form submitted. | `form.dto.ts`, `answer-options.ts`, `FormQuestion.svelte`, specs | none | S | low |
| **WP-G1** | Server: `product_grid` in both type lists (+ drift test), save-time validation (`assertProductGridValid`: ids unique, 1..99 max, `closedCells` declared and not all, prices complete per mode x bucket, tier dimension profile-only, `requiresPayment`, anonymous refused), `forms/product-grid.ts` (parse, lines), pricing in `submit` (a closed cell refused), the typed `FORM_UPDATE_APP` refusal of a missing grid answer (4.8), `factsFor` profile need, `productGridPrices` on `check`/`getPublic`, `submissions.lines` written and projected. Tests: totals per mode x tier, guest = `_others`, a forged quantity/key/price, reuse of a pending row rewriting `lines`, the Lydia amount = sum. | `forms.service.ts`, `forms/product-grid.ts`, `submit-refusal.ts`, `dto/*`, `pricing/*`, `submission.entity.ts`, `submission.projection.ts`, `public-forms.controller.ts` | `submissions.lines jsonb NULL` (schema only) | M-L | **payments**: the amount charged; adversarial review on Opus |
| **WP-G2** | Respondent: the component (desktop table, 390 px cards, closed cells struck through), `fillPricing.ts` totals, both fill pages, required/answered predicate (>= 1 unit). | `FormQuestion.svelte` or a new `ProductGridQuestion.svelte`, `fillAnswers.ts`, `fillPricing.ts`, `routes/forms/[id]`, `routes/f/[id]` | none | M | low (display; the server decides) |
| **WP-G3** | Editor: `ProductGridEditor.svelte`, paste-a-list, reorder, closing a cell by clicking it, `allowMultipleSubmissions` on when a grid is added, price modes, per-category tabs, preview; `itemsPayload.ts` euros<->cents; Paraglide on the first draft. Parallel with G2. | `components/forms/*`, `forms/itemsPayload.ts`, `messages/*.json` | none | M | low |
| **WP-G4** | Responses and export: `answerText` (both copies), panel, "Articles" and "Totaux" sheets, `ExportLabels` extension. | `answer-text.ts` x2, `forms.service.ts` export, `export-labels.ts`, `FormSubmissionsTable.svelte` | none | S-M | data (accounting figures) |
| **WP-G5** | Docs: a section in [forms](frontend/modules/forms.md), the French guide, `changelog.d`, fix D7's stale lines. | wiki | - | S | - |

G0 first (independent, fixes production). G1 before G2/G3 (they read its shapes). G4 after G1.
Estimated whole: ~2 builder-weeks.

## 5. The other gaps, ranked

Impact = how many of the section-3 use cases it unblocks. Effort S < 1 day, M 2-4 days, L > 1 week.

| Rank | Gap | Impact | Effort, files, migration | Risk |
|---|---|---|---|---|
| 1 | **The priced grid (section 4)** - also gives single products with quantity and multi-product orders | merch, multi-product orders, gala extras, ticket bundles (4) | L total (WP-G0..G5); one schema migration | payments |
| 2 | **D1 survey grid broken** (WP-G0) | any form with a grid (planning polls, availability, satisfaction) | S, none | low |
| 3 | **G-DUP duplicate a form** (questions, prices, grid, settings; not answers, not dates) | every yearly event (all) | S: a server `POST forms/:id/duplicate` (copies `items` with new ids, re-validates) + a list action | low |
| 4 | **G-VALID answer formats**: e-mail, phone, number with min/max, length min/max on text; `multiple_choice` min/max selected | trips, ticketing guests, recruitment, every contact field (5+) | M: an optional `validation` on `FormItemDto`, judged in `submit` and mirrored in `fillAnswers.ts`; jsonb, no migration | low |
| 5 | **G-QUOTA per option** ("navette: 50 places", "menu végé: 30") | ticketing types, gala menus, trips options (3) | M: `quota` on an option, counted from `answers` under `lockFormSeats` with `seatHoldingWhere`; greyed option on the fill page | **payments/over-booking**: must share the seat lock and the late-payment rule (`paid_over_capacity`) |
| 6 | **G-RESULTS summary** (counts per option, per grid cell, chart; **managers only**, Q5) | polls, elections, surveys (3) | M: a server aggregate route (manager-only; anonymous forms aggregate fine) + a page | privacy: small-group anonymity (refuse a count below N for anonymous forms?) |
| 7 | **G-EXPORT accounting**: payment reference and method columns, totals per option and per supplement, CSV | every paid form (4) | S-M: export only (the grid half is WP-G4) | data |
| 8 | ~~G-EDIT an answer~~ - **CLOSED, won't do (owner, Q7)**: a buyer sends a new order instead (Q3) | - | - | - |
| 9 | **G-WAITLIST** when full, promoted in order when a seat frees (expiry, cancel, refund); **decided Q6: the first waiting is notified automatically, has a deadline to confirm or pay, then the place passes on** | ticketing, trips, sign-ups (3) | L: a `waitlisted` status (migration), a promotion step under the seat lock, a notification type (floor rule as D3's alert), a payment window for the promoted | payments + fairness |
| 10 | **G-SEATS** a +1 counted as a seat (a ticket quantity that counts toward `maxSubmissions`, with one name per seat) | ticketing, gala (2) | M-L: capacity counts `seats` not rows (migration: `submissions.seats int default 1`), every capacity read changes | payments/over-booking |
| 11 | G-SECTIONS pages and "go to section"; conditions on a grid answer | long trips/recruitment forms (2) | M: a `section` item type + client paging; server unchanged (visibility already judged) | low |
| 12 | G-DATEPRICE early-bird (a `date` dimension: before/after an instant, judged on the DB clock at submit) | ticketing, gala (2) | M: `pricing/*` new criterion, both sides | payments: a late payment of an early-bird answer keeps its price (the row's) |
| 13 | G-REVIEW status/notes/tags per answer for managers | recruitment (1, high value there) | M: migration (`submissions.reviewStatus`, a notes table) | privacy (notes about people: register of processing) |
| 14 | G-PROMO codes | ticketing, merch (2) | L: codes table, usage counts under lock, refusal codes | payments + abuse |
| 15 | G-DATE / G-TIME question types | trips, sign-ups (2) | S | low |
| 16 | G-CONFIRM an organiser-written confirmation text shown after submit (and a push to members) | all paid forms | S-M (text on the form, rendered by both success pages) | low; e-mail stays out (PP2) |
| 17 | G-DEPOSIT deposit / instalments | trips (1) | L: two requests per answer, a balance state | **payments**, high |
| 18 | G-FILE several files per question, guest files (longer retention: **refused, Q8 - 30 days max stays**) | trips, recruitment | M (retention bound is a decision D23/D41) | **privacy** (ID documents) |
| 19 | G-STOCK stock per grid cell (owner: not now, 2026-11-06) | merch sold from stock | M on top of WP-G1 (quantity sums under `lockFormSeats`) | payments/over-selling |
| 20 | G-GRIDEDIT the cleaner editor for SURVEY grids (chips, paste, reorder, preview, "require each row" option fixing D5) | polls, availability | S-M: reuse WP-G3's pieces | low |

**Recommended order**: WP-G0 -> WP-G1..G5 -> G-DUP -> G-VALID -> G-EXPORT -> G-QUOTA -> G-RESULTS ->
G-WAITLIST / G-SEATS (designed together: both change what a seat is) -> the rest.

## 6. What the editor work in flight already covers (2026-11-06)

Read from the other sessions' worktrees without touching them:

| Work in flight | Covers |
|---|---|
| `fix/form-option-rules` (one table of mutually exclusive form options, both sides) | a public form may keep a profile price grid, the guest paying "everyone else" - the rule 4.5 relies on for guests; nothing about grids or validation |
| `fix/inputs-win-over-drag` (`dragExclusion.ts`, `draggableCard.ts`) | the drag of question cards no longer steals input gestures - WP-G3's row/column drag should reuse it |
| `feat/compact-form-editor` (no change yet) | compact question cards - overlaps G-GRIDEDIT and WP-G3's visual language; coordinate before WP-G3 |
| `feat/form-question-image` (media-service only so far) | question images - unrelated to the gaps above |

None of them addresses D1-D5 or any gap of section 5.

## 7. Benchmark - what was checked, and only that

| Product | Checked | Source |
|---|---|---|
| Google Forms | Types include date, time, rating, grids. Short-answer validation: number, text (e.g. e-mail), length, regex; paragraph: length, regex; checkboxes: at least/at most/exactly; grids: "require a response in each row", "limit to one response per column", shuffle rows; custom error text. **Grids carry no price and no quantity.** | [question types](https://support.google.com/docs/answer/7322334?hl=en), [response validation](https://support.google.com/docs/answer/3378864?hl=en) |
| HelloAsso | Several rates per audience, capacity per rate, promo codes, complementary options, a shop with stock and payment in 3 instalments. **From third-party guides, not HelloAsso's own help centre** (not reached); live shops sell size/colour variants as separate items or pick the size in a later step - no evidence of a size x colour grid. | [Tool-advisor review](https://tool-advisor.fr/logiciel-association/comparatif/helloasso/), [APEL presentation](https://www.apel.fr/sites/default/files/2026-02/03_02_2026%20-%20Visio%20HelloAsso%20x%20APEL.pdf), [example shop](https://www.helloasso.com/associations/js-services/paiements/vente-debardeurs-et-tshirts-js-services) |
| Typeform | ONE Stripe/PayPal payment question per form, its amount from a calculator variable fed by logic ("branching and calculations"); paid plans only. Community threads report the variable link behaving differently from the help article. | [help centre](https://help.typeform.com/hc/en-us/articles/360051922272-Let-respondents-choose-how-much-they-want-to-pay), [community](https://community.typeform.com/build-your-typeform-7/logic-variables-not-available-in-stripe-payment-field-how-to-link-price-variable-17967) |

Read-out: Canari's server-side price matrix is already stronger than Typeform's calculator and than
Google (no payment). The priced grid of section 4 has no direct equivalent among the three; the
ticketing gaps (quota per rate, promo code) are what HelloAsso has and Canari lacks.

## 8. Decided by the owner, 2026-11-06

The grid's four answers are in 4.1. The eight further questions, answered the same day:

| # | Question | Decision | Where it lands |
|---|---|---|---|
| Q1 | A cap per ORDER beside the max per cell? | **None**: the max per cell is enough | 4.3 |
| Q2 | May the creator close a combination? | **Yes**, by clicking the cell in the editor; struck through (or absent) for the buyer | 4.3 `closedCells` |
| Q3 | How does a buyer order again? | **A new order** (the form allows several answers); no order editing | 4.3 |
| Q4 | When does the editor offer the type? | **As soon as it ships**; an old app is refused at submit with "mettez à jour l'application" | 4.8 |
| Q5 | Who sees poll and election results? | **Managers only** | G-RESULTS: a manager-only page, no voter view |
| Q6 | Waiting list, when a place frees? | **The first person waiting is notified automatically and has a deadline to confirm or pay; past it the place passes to the next** | G-WAITLIST |
| Q7 | Edit an answer after submit? | **No** (the owner chose this over the recommendation) | G-EDIT closed, won't do |
| Q8 | Trip ID documents kept past 30 days? | **No, 30 days max, as today** | G-FILE: no retention change |

**Release (owner, 2026-11-06): forms are the ABSOLUTE PRIORITY, and everything above ships in
`1.6.6`, not `1.6.7`.**
