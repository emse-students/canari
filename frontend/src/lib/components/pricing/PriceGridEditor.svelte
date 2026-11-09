<script lang="ts">
  import { TriangleAlert, Plus } from '@lucide/svelte';
  import CriterionEditor from './CriterionEditor.svelte';
  import PriceCellsEditor from './PriceCellsEditor.svelte';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormItem } from '$lib/forms/api';
  import {
    addBucket,
    addDimension,
    emptyMatrix,
    guestFreeCellKey,
    matrixProblem,
    MAX_CRITERIA,
    newDimension,
    pricesOnProfile,
    removeBucket,
    removeDimension,
    type DimensionKind,
    type PriceMatrix,
  } from '$lib/pricing/priceMatrix';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { criterionTitle } from '$lib/pricing/criterionTitle';
  import { gridProblemMessage } from '$lib/pricing/gridProblem';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * The pricing grid: the criteria a price discriminates on, and one price per combination.
   *
   * It is a GRID rather than a list of rules because the criteria multiply, and exactly one cell
   * then applies to any person - no priority, no tie-break, nothing to explain. Since 2026-11-06 it
   * is drawn as what it is, a table: at most TWO criteria (owner), the first down the side, the
   * second across the top (`PriceCellsEditor`). The "Critère" menu refuses a third; a stored grid
   * with more still loads and saves untouched, laid out with the extra criteria nested in the rows.
   *
   * Every cell always has a value: adding a criterion copies existing prices across, and adding a
   * group starts it from the "everyone else" price. So the grid is complete from the first click and
   * the manager only edits what actually differs.
   */
  interface Props {
    /** Non-null whenever the manager has switched the grid on, even before the first criterion. */
    matrix: PriceMatrix | null;
    /** The single price, in euros, used for every cell of a brand-new criterion. */
    basePrice: number;
    tiers: MembershipTier[];
    formations: FormationOption[];
    items: FormItem[];
    /** Whether the beneficiary association sells any cotisation - gates that one criterion. */
    hasCotisation: boolean;
    /** The block's title; a form calls it "Prix d'inscription", a product its own grid. */
    title?: string;
    /**
     * The form is public: a guest has no promo, formation or cotisation, so on a criterion about
     * who the person is it pays the "everyone else" tier - said under the grid, never by hiding a
     * criterion (owner, 2026-11-06). The cell a guest lands in may not be free (`freeFallbackCells`
     * server-side, decision PP1), so it is flagged where it is fixed.
     */
    isPublic?: boolean;
  }

  let {
    matrix = $bindable(),
    basePrice,
    tiers,
    formations,
    items,
    hasCotisation,
    title = m.form_grid_title(),
    isPublic = false,
  }: Props = $props();

  const problem = $derived(matrixProblem(matrix));
  /** A public form's grid on who the person is: guests land in its "everyone else" tier. */
  const guestsPayOthers = $derived(isPublic && pricesOnProfile(matrix));
  const sources = $derived({ tiers, formations, items });
  const usedKinds = $derived(new Set((matrix?.dimensions ?? []).map((d) => d.kind)));
  const full = $derived((matrix?.dimensions.length ?? 0) >= MAX_CRITERIA);
  const guestFreeKey = $derived(isPublic ? guestFreeCellKey(matrix, items) : null);

  /**
   * The criteria this grid can be divided on. One of each kind, except `answer` - a form can price
   * on two questions. A kind this grid cannot offer at all is left out; one already used, or past
   * the two-criteria bound, is shown greyed with why.
   */
  const menu = $derived(
    (
      [
        { kind: 'promo' as const, offered: true },
        { kind: 'formation' as const, offered: true },
        { kind: 'cotisation' as const, offered: hasCotisation },
        { kind: 'answer' as const, offered: items.some((i) => (i.options?.length ?? 0) > 0) },
      ] as const
    )
      .filter((c) => c.offered)
      .map((c) => {
        const taken = c.kind !== 'answer' && usedKinds.has(c.kind);
        const note = taken
          ? m.form_grid_criterion_taken()
          : full
            ? m.form_grid_criterion_full()
            : null;
        return { kind: c.kind, label: criterionTitle(c.kind), note };
      })
  );

  let menuOpen = $state(false);
  let menuAsSheet = $state(false);
  let menuAnchor: HTMLButtonElement | null = $state(null);

  function openMenu() {
    menuAsSheet = window.matchMedia('(width < 40rem)').matches;
    menuOpen = true;
    Log.d('PRICE_GRID', `criterion menu open, ${menu.length} kinds, full=${full}`);
  }

  function add(kind: DimensionKind) {
    // The menu greys these out; refusing here too keeps the bound true whatever reaches this call.
    if (full || (kind !== 'answer' && usedKinds.has(kind))) {
      Log.d('PRICE_GRID', `criterion ${kind} refused: full or already used`);
      return;
    }
    Log.d('PRICE_GRID', `add criterion ${kind}`);
    // A brand-new grid inherits the single price, so switching criteria on changes no total.
    const seeded: PriceMatrix =
      matrix && matrix.dimensions.length > 0 ? matrix : emptyMatrix(basePrice);
    matrix = addDimension(seeded, newDimension(kind));
    menuOpen = false;
  }

  /**
   * Removing the last criterion leaves the grid ON with nothing to divide on, rather than switching
   * it off: the mode is a toggle the manager owns one block up, and flipping it back for them would
   * restore a single public price they never asked for.
   */
  function remove(dimensionId: string) {
    if (!matrix) return;
    Log.d('PRICE_GRID', `remove criterion ${dimensionId}`);
    const next = removeDimension(matrix, dimensionId);
    matrix = next.dimensions.length === 0 ? emptyMatrix(basePrice) : next;
  }

  /** Reassignment is what Svelte tracks, so every mutation inside a criterion comes back here. */
  function touched() {
    if (matrix) matrix = { ...matrix, cells: { ...matrix.cells } };
  }

  /** "Lignes" for every criterion but the last of two or more, which runs across the top. */
  function axisLabel(index: number, count: number): string {
    return count > 1 && index === count - 1 ? m.form_grid_axis_columns() : m.form_grid_axis_rows();
  }
</script>

<div class="border-cn-border space-y-4 border-t-2 pt-4">
  <div>
    <p class="text-text-main text-base font-bold">{title}</p>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_hint()}</p>
  </div>

  <section class="space-y-2" aria-labelledby="price-criteria-heading">
    <div class="flex items-center gap-3">
      <h3 id="price-criteria-heading" class="text-text-main flex-1 text-sm font-bold">
        {m.form_grid_criteria_heading()}
      </h3>
      {#if menu.length > 0}
        <button
          bind:this={menuAnchor}
          type="button"
          onclick={() => (menuOpen ? (menuOpen = false) : openMenu())}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          class="border-cn-border text-text-main hover:bg-cn-bg inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-bold"
        >
          <Plus size={16} />
          {m.form_grid_add_criterion()}
        </button>
      {/if}
    </div>

    {#if matrix}
      {#each matrix.dimensions as dimension, i (dimension.id)}
        <CriterionEditor
          {dimension}
          axisLabel={axisLabel(i, matrix.dimensions.length)}
          {sources}
          onAddBucket={(bucket) => {
            if (matrix) matrix = addBucket(matrix, dimension.id, bucket);
          }}
          onRemoveBucket={(bucketId) => {
            if (matrix) matrix = removeBucket(matrix, dimension.id, bucketId);
          }}
          onRemove={() => remove(dimension.id)}
          onChange={touched}
        />
      {/each}
    {/if}
  </section>

  {#if matrix && problem}
    <p
      class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn flex items-start gap-2 rounded-xl border-2 px-3 py-2 text-xs font-semibold"
    >
      <TriangleAlert size={13} class="mt-0.5 shrink-0" />
      {gridProblemMessage(problem)}
    </p>
  {/if}

  {#if matrix && !problem}
    <PriceCellsEditor
      bind:matrix={() => matrix as PriceMatrix, (next) => (matrix = next)}
      {sources}
      {guestFreeKey}
    />
    {#if guestsPayOthers}
      <p class={CONTROL_HINT_CLASS}>{m.form_price_grid_guest_tier()}</p>
    {/if}
  {/if}
</div>

<FloatingSurface
  open={menuOpen}
  asSheet={menuAsSheet}
  anchor={menuAnchor}
  label={m.form_grid_add_criterion()}
  popoverWidth="content"
  onClose={(refocus) => {
    menuOpen = false;
    if (refocus) menuAnchor?.focus();
  }}
>
  <div class="flex flex-col p-1" data-testid="criterion-menu">
    {#each menu as item (item.kind)}
      <button
        type="button"
        onclick={() => add(item.kind)}
        aria-disabled={item.note !== null}
        class="hover:bg-cn-bg flex min-h-11 flex-col items-start justify-center rounded-lg px-3 py-1.5 text-left text-sm font-semibold {item.note
          ? 'text-text-muted'
          : 'text-text-main'}"
      >
        <span>{item.label}</span>
        {#if item.note}
          <span class="text-text-muted text-xs font-normal">{item.note}</span>
        {/if}
      </button>
    {/each}
  </div>
</FloatingSurface>
