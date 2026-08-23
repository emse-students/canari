# Form pricing grids, and the criteria behind them

**Status:** plan, awaiting three decisions (bottom of this page).
**Asked for** 2026-08-23: *"il faut qu'on ai moyen de faire tout un tas de discriminations, via la
promo, via la formation, via les differents types de cotisation... Pour l'interface, ca se traduit
par des grilles de tarif, mais surtout mettre des cases a cocher 'Filtre par...'"*

Today a form has exactly two prices: the public one and the cotisant one
([forms](../docs/wiki/frontend/modules/forms.md)). This generalises that pair into an ordered list of
**price segments**, each selected by criteria, and replaces the member-price pair rather than sitting
beside it - two mechanisms for "some people pay less" is the gas factory this module was just cleaned
out of.

## What the app actually knows about a person

Measured on prod 2026-08-23, `auth_db.users`, 221 rows:

| Attribute | Values seen | Comes from |
|---|---|---|
| `formation` | `ICM` 213, `ISMIN` 3, `Master` 2, null 3 | Authentik `userinfo`, refreshed at every login |
| `promo` | 2022 (4), 2023 (15), 2024 (72), 2025 (101), 2026 (24), plus 2020, 1850, 1816, null 2 | idem |
| cotisation tier | `AssociationProduct` rows, `type='membership'`, per association | the association's own catalogue |

Two facts decide the design:

1. **Neither attribute is self-declared.** `UpdateUserDto` (the body of `PATCH /api/users/me`)
   carries `bio` and nothing else; `promo` and `formation` are written only by
   `findOrCreateFromOidc`, from the identity provider, on every sign-in. So a price may rest on them
   - the payer cannot move themselves into a cheaper segment. **If that DTO ever gains `promo`, this
   feature becomes a self-service discount**, which is worth a comment at the DTO.
2. **`formation` is a small open vocabulary, not an enum.** Three real values today, and the next one
   arrives from Authentik with no deploy. So the picker offers the values that EXIST (a `GROUP BY`
   behind an endpoint) and an unknown value simply matches nothing - never a hard-coded list that
   silently stops matching a new track.

`promo` is a **graduation year**, not a study year. "1A pays 10 EUR" is the way this will be asked
for, and 1A is `promo - academicYear`. The academic-year rule already exists, in
`deriveCotisationTag` ([cotisations](../docs/wiki/cotisations.md)) - a year rolls in September.

## Store the reference, not the result - again

A segment that says `promo = 2029` is a snapshot: correct this year, wrong the next, exactly like the
literal cotisation tag migration 050 has just finished removing. A segment therefore stores **either**
an absolute promo set **or** a relative study year, and says which:

```ts
type PromoCriterion =
  | { kind: 'promo'; years: number[] }        // graduation years, e.g. [2028, 2029]
  | { kind: 'studyYear'; years: number[] };   // 1..N, resolved against the academic year at QUOTE time
```

`studyYear` is the one a reusable form wants, and the one the UI should offer first. `promo` stays
for the case that genuinely means a cohort ("la promo 2024 fete ses 5 ans").

## The model

One JSON column on `form`, not a table: a grid is read and written whole, always with its form, and
never queried across forms. Migration `051`.

```ts
interface PriceSegment {
  /** Stable id, referenced by each option's per-segment modifier. Never displayed. */
  id: string;
  /** What a person reads when the form tells them which price applies - "Cotisant 1A". */
  label: string;
  /** Base price in cents for this segment. */
  basePrice: number;
  /** AND across the dimensions present; OR inside each. An absent dimension is no constraint. */
  criteria: {
    cotisation?: { variantKeys: (string | null)[] } | { any: true };
    promo?: PromoCriterion;
    formation?: { values: string[] };
  };
}
```

- `form.priceSegments: PriceSegment[]` - **ordered**, and the order is the resolution rule.
- `form.basePrice` stays exactly as it is: the fallback, for a submitter matching no segment. Every
  form keeps working with an empty array, which is what makes this shippable in one migration with
  no data conversion.
- `FormOption.priceModifiers?: Record<segmentId, number>` replaces `priceModifierMember`. The
  fallback modifier stays `priceModifier`. This is the grid: **segments are columns, the base price
  and each priced option are rows.**
- `memberPriceEnabled`, `memberPriceVariantKey`, `basePriceMember` and `priceModifierMember` are
  **dropped**, folded into a segment whose only criterion is `cotisation`. Prod holds one form with
  neither set (measured 2026-08-23), so there is again nothing to convert - and doing it now, days
  after 050, costs nothing, where doing it in a year costs a shim.

## Resolution: first match wins, and the form says which

A submitter can satisfy several segments. Two candidate rules, and the choice must be visible:

- **First match in the manager's order** - the manager holds the priority, the order is on screen and
  draggable, and the outcome is explainable in one sentence. **Recommended.**
- Cheapest match - kinder to the submitter, and a manager who adds a segment can silently lose money
  on an unrelated one. Not recommended.

Whichever it is, the resolved segment's `label` is returned to the client and shown, because a price
a person cannot account for is a support request.

## Where it is computed, and what happens when it cannot be

One function, `resolvePriceSegment(form, submitter): PriceSegment | null`, called from the two places
that already share `paysMemberPrice`:

| Call site | Today | After |
|---|---|---|
| `GET /api/forms/:id/check` | returns `memberPricing: boolean` | returns `segmentId`, `segmentLabel`, `basePrice` |
| `submit` (`baseCents`, `calculateModifiers`) | `memberPricing` boolean threaded through | the segment threaded through |

The fill page keeps deriving nothing - it renders what the server says, which is why swapping the
rule underneath it needed no client change last time.

**The cross-service edge.** `promo` and `formation` live in core-service; forms live in
social-service, which has never asked core-service for a profile. The path that exists is
`GET /api/internal/users/:id/public-profile` - INTERNAL_SECRET-gated, no nginx location, Docker
network only - and it already returns exactly `{ displayName, promo, formation }`. Use it; do not
widen the nginx auth subrequest to carry profile headers (a forgeable input on a money decision, for
a pricing feature), and do not replicate the two columns into social-service (a stale replica prices
wrongly and silently).

It **fails closed, loudly**: a form with no promo/formation criterion never calls core-service at
all, and a form that has one refuses the quote and the submission when the call fails, with a message
saying it is us and to retry. Both silent alternatives are wrong - the fallback price overcharges a
student, the discounted one undercharges the association - and "the check did not run" reporting
success is the defect the invitation check shipped for months (`CHANGELOG.md`).

## The interface

In the **Payment** section, a "Grille tarifaire" block. One price is the default and looks exactly as
it does today; nothing appears until "Ajouter un tarif" is pressed.

Each segment row, when added: a name, a price, and the checkboxes the request asks for -
`[ ] Cotisation` `[ ] Promotion` `[ ] Formation`. Checking one reveals its picker and nothing else:

- **Cotisation**: the tier list already fetched by `CotisationTierPicker`, by NAME, plus "n'importe
  quelle cotisation".
- **Promotion**: study year (1A..5A) or graduation year, the toggle between the two carrying the
  one-line reason ("une annee d'etude reste vraie l'an prochain").
- **Formation**: multi-select of the values that exist, from a new
  `GET /api/users/formations` (distinct, non-null, count > 0).

Then the grid itself, only once a form has both segments and priced options: segments as columns,
base price and each priced option as rows, one input per cell. It scrolls inside its own
`overflow-x-auto` container and collapses to one card per segment below `sm` - the page body never
scrolls sideways.

Reordering is drag-and-drop, reusing the questions list's mechanism, with the first-match rule
written above the grid rather than inferred from it.

## Phases

1. **Model and money.** Migration 051, entity, DTO, `resolvePriceSegment`, the core-service client,
   the two call sites, `/check`'s new answer. Tests first-class: matching (each dimension alone, AND
   across, OR within, absent dimension, no match), ordering, the academic-year roll for `studyYear`,
   the fail-closed transport path, and a config-refusal set mirroring
   `assertCotisationConfigValid` (a segment naming a tier the association does not sell, a
   `formation` value nobody has, an empty criteria object - which is a segment matching everyone and
   therefore a mistake).
2. **The grid UI**, in `FormPaymentSection` + a new `PriceGridEditor`, with the checkboxes and the
   pickers.
3. **The fill page** naming the applied segment.
4. **Docs**: [forms](../docs/wiki/frontend/modules/forms.md), [cotisations](../docs/wiki/cotisations.md),
   `CHANGELOG.md`, and the durable rule this leaves.

Phase 1 ships alone and changes no behaviour with an empty `priceSegments`, which is how it gets on
prod before the UI exists.

## Three decisions needed

1. **Resolution rule** - first match in the manager's order (recommended), or cheapest match?
2. **Does the same criteria engine also gate WHO MAY SUBMIT**, not only what they pay? It is the
   obvious neighbour ("reserve aux ICM 1A"), it is the same predicate, and building the predicate
   twice is how the two drift apart. Cheap now, expensive later.
3. **Per-option cells, or base price only, in phase 2?** The grid multiplies inputs by segments; a
   form with 4 segments and 6 priced options is 28 cells. Base-price-only is a much smaller screen
   and covers most of what is asked for, with per-option cells behind a disclosure.
