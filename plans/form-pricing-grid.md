# Form pricing grids, and the criteria behind them

**Status:** plan. Model settled with the user 2026-08-23; two decisions taken here and stated as such.
**Asked for** 2026-08-23: *"il faut qu'on ai moyen de faire tout un tas de discriminations, via la
promo, via la formation, via les differents types de cotisation... ca se traduit par des grilles de
tarif, mais surtout mettre des cases a cocher 'Filtre par...'"* - then, on being offered a
priority-ordered rule list: *"Ce n'est pas possible, si tu coches toutes les options, ca fait une
matrice qui doit etre entierement remplie non ? Les questions doivent pouvoir etre filtrees par
promotion, statut ou formation egalement. Par exemple, le prix de ma cotisation BDE depend de ma
reponse a une question (le choix d'un menu), de ma formation et de mon annee de promotion."*

That correction is the design. A list of rules needs a priority order and an answer for "what if two
match"; **a matrix needs neither** - the cells partition the population, so exactly one applies to
anybody, and the grid is complete or it is not saved. Deterministic and explainable by construction,
which is the standing requirement.

Today a form has exactly two prices, public and cotisant
([forms](../docs/wiki/frontend/modules/forms.md)). The matrix replaces that pair rather than sitting
beside it.

## What the app actually knows about a person

Measured on prod 2026-08-23, `auth_db.users`, 221 rows:

| Attribute | Values seen | Comes from |
|---|---|---|
| `formation` | `ICM` 213, `ISMIN` 3, `Master` 2, null 3 | Authentik `userinfo`, refreshed at every login |
| `promo` | 2022 (4), 2023 (15), 2024 (72), 2025 (101), 2026 (24), plus 2020, 1850, 1816, null 2 | idem |
| cotisation tier | `AssociationProduct` rows, `type='membership'`, per association | the association's own catalogue |

Three facts decide the design:

1. **Neither attribute is self-declared.** `UpdateUserDto` (the body of `PATCH /api/users/me`) carries
   `bio` and nothing else; `promo` and `formation` are written only by `findOrCreateFromOidc`, from
   the identity provider, at every sign-in. So a price may rest on them - the payer cannot move
   themselves into a cheaper cell. **If that DTO ever gains `promo`, this feature becomes a
   self-service discount**, which is worth a comment at the DTO itself.
2. **`formation` is a small OPEN vocabulary, not an enum.** Three real values today, and the next one
   arrives from Authentik with no deploy. The picker offers the values that EXIST, and an unforeseen
   value must still land in a cell - which is what the implicit bucket below is for.
3. **Both can be null**, and 5 rows on prod are. A null is not an error and must price.

`promo` is a **graduation year**, not a study year. "1A pays 10 EUR" is how this will be asked for,
and 1A is `promo - academicYear`. The academic-year rule already exists, in `deriveCotisationTag`
([cotisations](../docs/wiki/cotisations.md)) - the year rolls in September.

## Store the reference, not the result - again

A bucket that says `promo = 2029` is a snapshot: right this year, wrong the next, exactly like the
literal cotisation tag that migration 050 has just finished removing. So a promo bucket is **either**
absolute graduation years **or** relative study years, and says which:

```ts
type PromoBucket =
  | { kind: 'promo'; years: number[] }        // graduation years - "la promo 2024 fete ses 5 ans"
  | { kind: 'studyYear'; years: number[] };   // 1..N, resolved against the academic year at QUOTE time
```

`studyYear` is what a form reused every year wants, and what the UI offers first.

## A dimension is a PARTITION, which is what keeps the matrix finite

The trap in "entierement remplie" is size: 3 formations x 5 promos x 2 tiers x a 3-choice menu is 90
cells, and no one fills 90 cells. A dimension is therefore not "every value of the attribute" - it is
**the buckets the manager cares to distinguish, plus an implicit `others` bucket that always exists
and cannot be deleted.** Promo becomes `[1A] [tous les autres]`: two columns, not five.

```ts
type Dimension =
  | { id: string; kind: 'cotisation'; buckets: { id: string; label: string; variantKeys: (string | null)[] }[] }
  | { id: string; kind: 'promo';      buckets: { id: string; label: string; bucket: PromoBucket }[] }
  | { id: string; kind: 'formation';  buckets: { id: string; label: string; values: string[] }[] }
  | { id: string; kind: 'answer'; questionId: string; buckets: { id: string; label: string; optionIds: string[] }[] };
```

Every dimension gains one `others` bucket at the end, generated rather than stored, which is what
makes the partition total: a null `formation`, a track nobody foresaw, a non-cotisant, a study year
past the last bucket - all land there and all have a price. **There is no such thing as an
unpriced submitter.**

## The matrix

```ts
interface PriceMatrix {
  /** Ordered; the order is display only - it decides no outcome. */
  dimensions: Dimension[];
  /** One entry per cell, keyed by the bucket ids joined in dimension order. Complete or refused. */
  cells: Record<string, number>;   // cents
}
```

- `form.priceMatrix: PriceMatrix | null`, one JSON column (migration `051`). A grid is read and
  written whole, always with its form, and never queried across forms; a table would buy nothing.
- **Completeness is a save-time invariant**, checked server-side: `cells` has exactly
  `prod(buckets + 1)` entries and no others. A missing cell is a submitter with no price, so it is a
  400 naming the cell, not a silent fallback to `basePrice`.
- Every cell is **initialised to `form.basePrice`** when a dimension is added, so the grid is
  complete from the first click and the manager only edits what differs. Adding a dimension multiplies
  the existing cells, carrying each old value into the new row - so switching on "filtrer par
  formation" never resets anything already set.
- `form.basePrice` remains the price of a form with no matrix at all. Nothing changes for a form that
  never opens the grid, which is what makes phase 1 deployable before any UI exists.
- `memberPriceEnabled`, `memberPriceVariantKey`, `basePriceMember` and `priceModifierMember` are
  **dropped**, folded into a one-dimension `cotisation` matrix. Prod holds one form with none of them
  set (measured 2026-08-23), so there is nothing to convert - and doing it days after 050 costs
  nothing, where doing it in a year costs a shim.

### What a cell price MEANS, and the double count it would otherwise cause

A cell is the **base price for that combination**. The total stays
`cell + sum of the modifiers of the options the submitter picked` - with one exception that has to be
enforced, not documented: **a question used as an `answer` dimension contributes no modifier.** The
menu choice is already priced by the cell it selects; letting `priceModifier` add on top would charge
the menu twice, and it would do it silently, in the direction that overcharges a student. So
promoting a question to a dimension zeroes and hides its option modifiers, the UI says why, and the
server ignores them regardless of what a client sends.

## Resolution, and where it happens

`resolvePriceCell(form, submitter, answers)` - one function, one answer, called from the two places
that today share `paysMemberPrice`:

| Call site | Today | After |
|---|---|---|
| `GET /api/forms/:id/check` | `memberPricing: boolean` | the submitter's **slice**: see below |
| `submit` (`baseCents`, `calculateModifiers`) | `memberPricing` threaded through | the resolved cell |

**The slice, and why the client is handed one.** Profile dimensions (cotisation, promo, formation) are
knowable before a single answer; `answer` dimensions are not, and a price that only appears after
submitting is not a price. So `/check` resolves the profile dimensions server-side and returns the
remaining sub-matrix - the answer dimensions only - plus the label of each bucket it applied
("Cotisant, ICM, 1A"). The fill page then updates the total as the person picks, locally, with no
round trip per click, and learns nothing about what other people pay. The server recomputes
everything at submit and that figure is the one charged; the client's total is a display.

**The cross-service edge.** `promo` and `formation` live in core-service; forms live in
social-service, which has never asked core-service for a profile. The path that exists is
`GET /api/internal/users/:id/public-profile` - `INTERNAL_SECRET`-gated, no nginx location, Docker
network only - and it already returns exactly `{ displayName, promo, formation }`. Use it. Do not
widen the nginx auth subrequest to carry profile headers (a forgeable input on a money decision, for
a pricing feature), and do not replicate the two columns into social-service (a stale replica prices
wrongly, and silently).

It **fails closed, loudly**: a matrix with no promo/formation dimension never calls core-service at
all, and one that has them refuses both the quote and the submission when the call fails, saying it is
us and to retry. Both silent alternatives are wrong - the `others` cell overcharges a student, a
guessed bucket undercharges the association - and "the check did not run" reporting success is the
defect the invitation check shipped with for months (`CHANGELOG.md`).

## The same predicate, three uses

A bucket is a predicate over `(profile, answers)`. Written once, it serves all three of the things
asked for, and writing it three times is how the three drift apart:

1. **Pricing** - which cell.
2. **Question visibility** - *"Les questions doivent pouvoir etre filtrees par promotion, statut ou
   formation egalement (du meme genre que les questions conditionnelles)."* `FormItem.dependsOn` /
   `dependsValue` today expresses only "option L of question Y is selected". It becomes a condition
   list of the same shape as a bucket's criteria, with the existing pair as one case - so an existing
   form keeps working and the editor gains "Afficher si..." with the same "Filtrer par..." checkboxes.
3. **Access** - who may submit at all (the user's decision, 2026-08-23: same engine). One optional
   condition on the form; a refused submitter sees why, in their own terms ("reserve aux ICM"), and the
   check runs server-side in `submit` as well as hiding the form, because a hidden form is not a
   closed one.

Question visibility interacts with pricing and the interaction has to be decided rather than
discovered: **a hidden question is not answered, so it prices as its `others` bucket.** That is the
only coherent reading, and it is the reason `others` is generated rather than optional.

## The interface

In the **Payment** section, "Grille tarifaire". One price is the default; nothing appears until
"Ajouter un critere" is pressed, and the checkboxes are the request's own: `[ ] Cotisation`
`[ ] Promotion` `[ ] Formation` `[ ] Reponse a une question`.

Checking one adds a dimension and asks only for its buckets: a bucket is a name plus a set (tiers by
NAME, study years, formations from the values that exist, options of the chosen question). The
`others` bucket is drawn, labelled, and not deletable, so the manager sees that everyone is covered.

The grid renders as a table: **the last dimension across the top, the others nested down the side**,
one input per cell, the cell's inherited value shown greyed until it is edited. It scrolls inside its
own `overflow-x-auto` container and collapses to one card per combination below `sm`; the page body
never scrolls sideways. A "remplir la ligne" affordance sets a whole row at once, because that is the
edit a 12-cell grid actually wants.

Per-option cells stay behind a disclosure (the user's decision, 2026-08-23): the base-price grid is
the screen, "Tarifs par option" is folded. A question promoted to a dimension shows its modifiers
struck through with the one-line reason.

New endpoint for the formation picker: `GET /api/users/formations` - distinct non-null values with
counts, so the picker offers what exists and shows how many people it reaches.

## Phases

1. **Model and money.** Migration 051, entity, DTO, `Dimension`/bucket predicates,
   `resolvePriceCell`, the core-service profile client, the completeness invariant, the two money call
   sites, `/check`'s slice. Tests as the point of the phase: each bucket kind alone, the generated
   `others` (null formation, unforeseen formation, non-cotisant, out-of-range study year), the
   academic-year roll for `studyYear`, completeness refusals, the modifier suppression on a dimension
   question, and the fail-closed transport path. Behaviour-free with no matrix, so it ships first.
2. **The grid UI**: the checkboxes, the bucket editors, the table, `PriceGridEditor`.
3. **The other two uses of the predicate**: "Afficher si..." on a question, and the access condition.
4. **The fill page**: the applied buckets named, the total updating on answer dimensions.
5. **Docs**: [forms](../docs/wiki/frontend/modules/forms.md), [cotisations](../docs/wiki/cotisations.md),
   `CHANGELOG.md`, and the durable rules this leaves - the partition-with-`others`, and the
   double-count a dimension question would cause.

## Decided here, not asked

- **No priority rule, because a matrix cannot need one.** The user's correction; recorded because the
  first draft of this plan had an ordered rule list with a first-match-wins tie-break, and that is a
  worse design that would have needed a paragraph to explain and a support answer every time it
  surprised someone.
- **A dimension question contributes no additive modifier.** Not a preference: the alternative charges
  the same choice twice, in the direction that overcharges.
- **A hidden question prices as `others`.**
