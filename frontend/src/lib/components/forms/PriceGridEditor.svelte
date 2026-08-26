<script lang="ts">
  import { TriangleAlert, Ban, Grid3x3, Plus } from '@lucide/svelte';
  import CriterionEditor from './CriterionEditor.svelte';
  import { CONTROL_HINT_CLASS, controlClass } from '$lib/components/ui/controlClasses';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormItem } from '$lib/forms/api';
  import {
    addBucket,
    addDimension,
    cellKey,
    emptyMatrix,
    gridLayout,
    matrixProblem,
    newDimension,
    removeBucket,
    removeDimension,
    type DimensionKind,
    type PriceMatrix,
  } from '$lib/forms/priceMatrix';
  import type { FormationOption } from '$lib/forms/criteriaOptions';
  import { gridProblemMessage } from '$lib/forms/gridProblem';
  import { m } from '$lib/paraglide/messages';

  /**
   * The pricing grid: the criteria a form discriminates on, and one price per combination.
   *
   * It is a GRID rather than a list of rules because the criteria multiply: ticking "formation" and
   * "promotion" describes a table that has to be filled, and exactly one cell then applies to any
   * person - no priority, no tie-break, nothing to explain. That is the user's own framing and it is
   * what makes this screen possible to read.
   *
   * Every cell always has a value: adding a criterion copies existing prices across, and adding a
   * group starts it from the "everyone else" price. So the grid is complete from the first click and
   * the manager only edits what actually differs.
   *
   * A cell can also be marked UNAVAILABLE, which is a decision no price can carry - 0 means free.
   * It is how a combination that simply does not exist ("non-cotisant, formule week-end") stops
   * being offered, and the fill page then greys out the options that would lead to it.
   *
   * Availability is carried by the cell, not by a button beside it. An unavailable cell has nothing
   * to type in, so clicking it is what reopens it; an available cell must give its click to the
   * caret, so closing it is the one action left on a control inside the cell, which takes no width.
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
  }

  let {
    matrix = $bindable(),
    basePrice,
    tiers,
    formations,
    items,
    hasCotisation,
  }: Props = $props();

  const problem = $derived(matrixProblem(matrix));
  const layout = $derived(matrix ? gridLayout(matrix) : { columns: [], rows: [] });
  const usedKinds = $derived(new Set((matrix?.dimensions ?? []).map((d) => d.kind)));

  /** One criterion of each kind, except `answer` - a form can price on two questions. */
  const available = $derived(
    (
      [
        {
          kind: 'cotisation' as const,
          label: m.form_criterion_cotisation(),
          enabled: hasCotisation,
        },
        { kind: 'promo' as const, label: m.form_criterion_promo(), enabled: true },
        { kind: 'formation' as const, label: m.form_criterion_formation(), enabled: true },
        {
          kind: 'answer' as const,
          label: m.form_criterion_answer(),
          enabled: items.some((i) => (i.options?.length ?? 0) > 0),
        },
      ] as const
    ).filter((c) => c.enabled && (c.kind === 'answer' || !usedKinds.has(c.kind)))
  );

  function add(kind: DimensionKind) {
    // A brand-new grid inherits the single price, so switching criteria on changes no total.
    const seeded: PriceMatrix =
      matrix && matrix.dimensions.length > 0 ? matrix : emptyMatrix(basePrice);
    matrix = addDimension(seeded, newDimension(kind));
  }

  /**
   * Removing the last criterion leaves the grid ON with nothing to divide on, rather than switching
   * it off: the mode is a toggle the manager owns one block up, and flipping it back for them would
   * restore a single public price they never asked for.
   */
  function remove(dimensionId: string) {
    if (!matrix) return;
    const next = removeDimension(matrix, dimensionId);
    matrix = next.dimensions.length === 0 ? emptyMatrix(basePrice) : next;
  }

  /** Reassignment is what Svelte tracks, so every mutation inside a criterion comes back here. */
  function touched() {
    if (matrix) matrix = { ...matrix, cells: { ...matrix.cells } };
  }

  function setCell(key: string, raw: string) {
    if (!matrix) return;
    const value = raw === '' ? 0 : Number(raw);
    matrix = { ...matrix, cells: { ...matrix.cells, [key]: Number.isNaN(value) ? 0 : value } };
  }

  /**
   * Flips one cell between a price and "this combination does not exist".
   *
   * Coming back from unavailable restores 0, not the price that was there before: that price is
   * gone, and 0 is the one value a manager cannot mistake for a considered one.
   */
  function toggleAvailability(key: string) {
    if (!matrix) return;
    const next = matrix.cells[key] === null ? 0 : null;
    matrix = { ...matrix, cells: { ...matrix.cells, [key]: next } };
  }
</script>

<div class="border-cn-border space-y-4 border-t-2 pt-4">
  <div class="flex items-start gap-2">
    <Grid3x3 size={16} class="text-text-muted mt-0.5 shrink-0" />
    <div>
      <p class="text-text-main text-sm font-bold">{m.form_grid_title()}</p>
      <p class={CONTROL_HINT_CLASS}>{m.form_grid_hint()}</p>
    </div>
  </div>

  {#if matrix}
    <div class="space-y-3">
      {#each matrix.dimensions as dimension (dimension.id)}
        <CriterionEditor
          {dimension}
          {tiers}
          {formations}
          {items}
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
    </div>
  {/if}

  {#if available.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each available as criterion (criterion.kind)}
        <button
          type="button"
          onclick={() => add(criterion.kind)}
          class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border-2 px-3 py-2 text-xs font-bold transition-colors"
        >
          <Plus size={13} />
          {m.form_grid_filter_by({ criterion: criterion.label })}
        </button>
      {/each}
    </div>
  {/if}

  {#if matrix && problem}
    <p
      class="border-amber-warn/30 bg-amber-warn/10 flex items-start gap-2 rounded-xl border-2 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-100"
    >
      <TriangleAlert size={13} class="mt-0.5 shrink-0" />
      {gridProblemMessage(problem)}
    </p>
  {/if}

  {#if matrix && !problem}
    <!-- Wide content scrolls inside its own box; the page body never scrolls sideways. -->
    <div class="border-cn-border overflow-x-auto rounded-2xl border-2">
      <!-- The counts are all `.price-grid` needs; the sizes are its own, in `app.css`. -->
      <table
        class="price-grid text-sm"
        style="--group-cols: {matrix.dimensions.length - 1}; --price-cols: {layout.columns.length}"
      >
        <colgroup>
          {#each matrix.dimensions.slice(0, -1) as dimension (dimension.id)}
            <col class="group-col" />
          {/each}
          {#each layout.columns as column (column.id)}
            <col class="price-col" />
          {/each}
        </colgroup>
        <thead>
          <tr class="border-cn-border bg-cn-bg/40 border-b-2">
            {#each matrix.dimensions.slice(0, -1) as dimension (dimension.id)}
              <th
                class="text-text-muted px-3 py-2 text-left text-xs font-bold tracking-wide uppercase"
              >
                {m.form_grid_group_column()}
              </th>
            {/each}
            {#each layout.columns as column (column.id)}
              <th class="text-text-main px-3 py-2 text-left text-xs font-bold break-words">
                {column.label || m.form_criterion_others()}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-cn-border/50 divide-y">
          {#each layout.rows as row (row.ids.join('|'))}
            <tr>
              {#each row.labels as label, i (i)}
                <td class="text-text-main px-3 py-2 text-xs font-semibold break-words">
                  {label || m.form_criterion_others()}
                </td>
              {/each}
              {#each layout.columns as column (column.id)}
                {@const key = cellKey([...row.ids, column.id])}
                {@const unavailable = matrix.cells[key] === null}
                <td class="p-1.5">
                  {#if unavailable}
                    <button
                      type="button"
                      onclick={() => toggleAvailability(key)}
                      title={m.form_grid_cell_restore_title()}
                      class="text-text-muted border-cn-border bg-cn-border/20 hover:border-cn-yellow/40 hover:text-text-main w-full rounded-2xl border-2 border-dashed py-2 text-center text-xs font-semibold transition-colors"
                    >
                      {m.form_grid_cell_unavailable()}
                    </button>
                  {:else}
                    <div class="cell-host relative">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={matrix.cells[key] ?? 0}
                        oninput={(e) => setCell(key, e.currentTarget.value)}
                        class="{controlClass(false, 'compact')} no-spinner"
                      />
                      <button
                        type="button"
                        onclick={() => toggleAvailability(key)}
                        title={m.form_grid_cell_disable_title()}
                        class="cell-action text-text-muted hover:text-red-err absolute inset-y-0 right-2 flex items-center"
                      >
                        <Ban size={13} />
                      </button>
                    </div>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_currency_hint()}</p>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_unavailable_hint()}</p>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_toggle_hint()}</p>
  {/if}
</div>
