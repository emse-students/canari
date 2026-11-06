<script lang="ts">
  import { Ban, TriangleAlert, Undo2, X } from '@lucide/svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { CONTROL_HINT_CLASS, controlClass } from '$lib/components/ui/controlClasses';
  import { longPress } from '$lib/actions/longPress';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import {
    crossKey,
    fillCells,
    gridAxes,
    lineCellKeys,
    OTHERS_BUCKET_ID,
    parseEuros,
    rowUnavailable,
    type GridLine,
    type PriceMatrix,
  } from '$lib/pricing/priceMatrix';
  import { bucketSummary, type CriterionSources } from '$lib/pricing/bucketValues';
  import { criterionTitle } from '$lib/pricing/criterionTitle';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * The prices of a grid, as a TRUE table: the first criterion's groups down the side, the second's
   * across the top, one price where they meet (owner, 2026-11-06).
   *
   * Three states a cell can be in, each drawn so it cannot be mistaken for another:
   *   - a PRICE, typed in euros;
   *   - EMPTY, which is 0 and has always been - now said by a muted "Gratuit" chip, so a blank box is
   *     never read as "not filled in yet";
   *   - UNAVAILABLE (`null`), struck through like a closed cell of the priced-grid question
   *     (`.price-cell-closed`), so the combination is visibly absent rather than free.
   *
   * A row or column header selects the line and offers the two bulk edits a manager reaches for -
   * "Même prix partout" and "Tout rendre indisponible". On a phone the table becomes one card per
   * row with labelled price pills: nothing scrolls sideways.
   */
  interface Props {
    matrix: PriceMatrix;
    /** The lists group values are named from, for the line under a row header. */
    sources: CriterionSources;
    /** The cell a public form's guest would get for free, which the server refuses; else null. */
    guestFreeKey: string | null;
  }

  let { matrix = $bindable(), sources, guestFreeKey }: Props = $props();

  const axes = $derived(gridAxes(matrix));
  /** "Promotion \ Formation": the criteria named where the two headers meet. */
  const corner = $derived(
    matrix.dimensions.length < 2
      ? criterionTitle(matrix.dimensions[0].kind)
      : `${matrix.dimensions
          .slice(0, -1)
          .map((d) => criterionTitle(d.kind))
          .join(' · ')} \\ ${criterionTitle(matrix.dimensions[matrix.dimensions.length - 1].kind)}`
  );

  let hideUnavailable = $state(false);
  const shownRows = $derived(
    hideUnavailable ? axes.rows.filter((r) => !rowUnavailable(matrix, r, axes.columns)) : axes.rows
  );

  /** The selected header. Its line may vanish under it (a group removed): the bar then hides. */
  let selection = $state<{ axis: 'row' | 'column'; key: string } | null>(null);
  const selectedLine = $derived.by(() => {
    if (!selection) return null;
    const lines = selection.axis === 'row' ? axes.rows : axes.columns;
    return lines.find((l) => l.key === selection?.key) ?? null;
  });
  const selectedKeys = $derived(
    selection && selectedLine ? new Set(lineCellKeys(axes, selection.axis, selection.key)) : null
  );
  let bulk = $state('');
  const bulkValue = $derived(bulk.trim() === '' ? null : parseEuros(bulk));

  /** The phone's open pill, by cell key. */
  let editingKey = $state<string | null>(null);

  /** A line's name: its groups, "Tous les autres" for the generated one. */
  function lineLabel(line: GridLine): string {
    return line.labels.map((l) => l || m.form_criterion_others()).join(' · ');
  }

  /** What a row holds, under its name - or that nothing in it can be bought. */
  function rowSub(row: GridLine): string {
    if (rowUnavailable(matrix, row, axes.columns)) return m.form_grid_row_all_unavailable();
    return row.ids
      .map((id, i) => {
        const d = matrix.dimensions[i];
        const bucket = d.buckets.find((b) => b.id === id);
        return bucket ? bucketSummary(d, bucket, sources) : '';
      })
      .filter(Boolean)
      .join(' · ');
  }

  function columnLabel(column: GridLine): string {
    return column.ids.length === 0 ? m.form_grid_single_column() : lineLabel(column);
  }

  function cellLabel(row: GridLine, column: GridLine): string {
    return column.ids.length === 0 ? lineLabel(row) : `${lineLabel(row)} × ${lineLabel(column)}`;
  }

  /** An input shows a price; 0 shows nothing, and the "Gratuit" chip says what that means. */
  function shown(key: string): string {
    const value = matrix.cells[key];
    return typeof value === 'number' && value !== 0 ? String(value) : '';
  }

  /**
   * Commits a typed price. Text that is not a price leaves the cell as it was, and the input is put
   * back so it does not show a value the grid does not hold.
   */
  function commit(key: string, input: HTMLInputElement) {
    const value = parseEuros(input.value);
    if (value === null) {
      Log.d('PRICE_GRID', `cell ${key}: typed text is not a price, kept as it was`);
      input.value = shown(key);
      return;
    }
    matrix = fillCells(matrix, [key], value);
  }

  /**
   * Flips one cell between a price and "this combination does not exist". Coming back restores 0,
   * not the price that was there before: that price is gone, and "Gratuit" is the one value a
   * manager cannot mistake for a considered one.
   */
  function toggle(key: string) {
    const next = matrix.cells[key] === null ? 0 : null;
    Log.d('PRICE_GRID', `cell ${key} -> ${next === null ? 'unavailable' : 'available'}`);
    matrix = fillCells(matrix, [key], next);
  }

  function select(axis: 'row' | 'column', key: string) {
    const same = selection?.axis === axis && selection.key === key;
    selection = same ? null : { axis, key };
    bulk = '';
  }

  function applyBulk() {
    if (!selection || !selectedKeys || bulkValue === null) return;
    Log.d('PRICE_GRID', `same price on ${selectedKeys.size} cells of a ${selection.axis}`);
    matrix = fillCells(matrix, [...selectedKeys], bulkValue);
  }

  function closeSelection() {
    if (!selection || !selectedKeys) return;
    Log.d('PRICE_GRID', `close ${selectedKeys.size} cells of a ${selection.axis}`);
    matrix = fillCells(matrix, [...selectedKeys], null);
  }

  /** A touch hold on a cell is the phone's corner button. */
  const holdToToggle = (key: string) => ({
    pointerTypes: ['touch', 'pen'] as const,
    onHold: () => toggle(key),
  });

  /** The guest's free cell, named where the two "Tous les autres" meet - for the status line. */
  const guestCellLabel = $derived.by(() => {
    if (!guestFreeKey) return null;
    const row = axes.rows.find((r) => r.ids.every((id) => id === OTHERS_BUCKET_ID));
    const column = axes.columns.find((c) => c.ids.every((id) => id === OTHERS_BUCKET_ID));
    return row && column ? cellLabel(row, column) : null;
  });
</script>

{#snippet cellNote(key: string)}
  {#if key === guestFreeKey}
    <span class="text-xs font-bold text-amber-900 dark:text-amber-100" data-testid="guest-free"
      >{m.form_grid_guest_free()}</span
    >
  {:else if matrix.cells[key] === 0}
    <span class="price-free-chip">{m.form_grid_free()}</span>
  {/if}
{/snippet}

<section class="space-y-3" aria-labelledby="price-cells-heading">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h3 id="price-cells-heading" class="text-text-main text-sm font-bold">
      {m.form_grid_prices_heading()}
    </h3>
    <Toggle bind:checked={hideUnavailable} label={m.form_grid_hide_unavailable()} />
  </div>

  {#if selection && selectedLine}
    <div
      class="border-cn-border bg-cn-bg flex flex-wrap items-center gap-2 rounded-2xl border px-3 py-2"
      data-testid="selection-bar"
    >
      <span class="text-text-main text-sm font-bold">
        {selection.axis === 'row'
          ? m.form_grid_selected_row({ name: lineLabel(selectedLine) })
          : m.form_grid_selected_column({ name: columnLabel(selectedLine) })}
      </span>
      <label class="text-text-main flex items-center gap-2 text-sm">
        {m.form_grid_same_price()}
        <span class="flex w-28 items-center gap-1">
          <input
            bind:value={bulk}
            inputmode="decimal"
            class={controlClass(bulk.trim() !== '' && bulkValue === null, 'compact')}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyBulk();
              }
            }}
          />
          <span aria-hidden="true">€</span>
        </span>
      </label>
      <button
        type="button"
        onclick={applyBulk}
        disabled={bulkValue === null}
        class="bg-text-main text-cn-surface rounded-full px-3 py-1.5 text-xs font-bold disabled:opacity-40"
      >
        {m.form_grid_apply()}
      </button>
      <button
        type="button"
        onclick={closeSelection}
        class="border-cn-border text-text-main hover:bg-cn-surface rounded-full border px-3 py-1.5 text-xs font-bold"
      >
        {m.form_grid_close_all()}
      </button>
      <button
        type="button"
        onclick={() => (selection = null)}
        aria-label={m.form_grid_close_selection()}
        class="ui-icon-button text-text-muted ml-auto rounded-lg"
      >
        <X size={16} />
      </button>
    </div>
  {/if}

  <!-- Wide grids scroll inside their own box; the page body never scrolls sideways. -->
  <div class="overflow-x-auto max-sm:hidden" data-testid="price-table">
    <table class="price-grid" style="--price-cols: {axes.columns.length}">
      <colgroup>
        <col class="group-col" />
        {#each axes.columns as column (column.key)}
          <col class="price-col" />
        {/each}
      </colgroup>
      <thead>
        <tr>
          <th scope="col" class="text-text-muted px-2 pb-2 text-left text-xs font-bold">
            {corner}
          </th>
          {#each axes.columns as column (column.key)}
            {@const picked = selection?.axis === 'column' && selection.key === column.key}
            <th scope="col" class="p-1">
              {#if column.ids.length === 0}
                <span class="text-text-muted block px-2 text-xs font-bold">
                  {columnLabel(column)}
                </span>
              {:else}
                <button
                  type="button"
                  onclick={() => select('column', column.key)}
                  aria-pressed={picked}
                  title={m.form_grid_select_column()}
                  class="price-header w-full"
                  class:price-header-picked={picked}
                >
                  {columnLabel(column)}
                </button>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each shownRows as row (row.key)}
          {@const picked = selection?.axis === 'row' && selection.key === row.key}
          <tr data-testid="price-row">
            <th scope="row" class="p-1">
              <button
                type="button"
                onclick={() => select('row', row.key)}
                aria-pressed={picked}
                title={m.form_grid_select_row()}
                class="price-header w-full text-left"
                class:price-header-picked={picked}
              >
                <span class="block truncate">{lineLabel(row)}</span>
                <span class="price-header-sub block truncate">{rowSub(row)}</span>
              </button>
            </th>
            {#each axes.columns as column (column.key)}
              {@const key = crossKey(row, column)}
              {@const label = cellLabel(row, column)}
              {@const closed = matrix.cells[key] === null}
              <td class="p-1">
                <div
                  class="cell-host relative"
                  data-testid="price-cell"
                  data-key={key}
                  use:longPress={holdToToggle(key)}
                >
                  {#if closed}
                    <div class="price-cell price-cell-closed">{m.form_grid_cell_unavailable()}</div>
                  {:else}
                    <label
                      class="price-cell"
                      class:price-cell-picked={selectedKeys?.has(key)}
                      class:price-cell-guest={key === guestFreeKey}
                    >
                      <span class="sr-only">{m.form_grid_cell_price_label({ cell: label })}</span>
                      <span class="flex items-baseline gap-0.5">
                        <input
                          value={shown(key)}
                          inputmode="decimal"
                          placeholder="—"
                          onchange={(e) => commit(key, e.currentTarget)}
                          class="price-input"
                        />
                        <span class="text-text-muted text-xs" aria-hidden="true">€</span>
                      </span>
                      {@render cellNote(key)}
                    </label>
                  {/if}
                  <button
                    type="button"
                    onclick={() => toggle(key)}
                    aria-label={closed
                      ? m.form_grid_cell_restore_named({ cell: label })
                      : m.form_grid_cell_disable_named({ cell: label })}
                    title={closed
                      ? m.form_grid_cell_restore_named({ cell: label })
                      : m.form_grid_cell_disable_named({ cell: label })}
                    class="price-corner"
                    class:cell-action={!closed}
                  >
                    {#if closed}<Undo2 size={14} />{:else}<Ban size={14} />{/if}
                  </button>
                </div>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- A phone: one card per row, a labelled pill per price, edited in place under the card. -->
  <div class="space-y-2 sm:hidden" data-testid="price-cards">
    {#each shownRows as row (row.key)}
      {@const editing = axes.columns.find((c) => crossKey(row, c) === editingKey)}
      <div class="border-cn-border rounded-2xl border p-3" data-testid="price-card">
        <p class="text-text-main text-sm font-bold">
          {lineLabel(row)}
          <span class="text-text-muted text-xs font-semibold">{rowSub(row)}</span>
        </p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each axes.columns as column (column.key)}
            {@const key = crossKey(row, column)}
            {@const value = matrix.cells[key]}
            <button
              type="button"
              onclick={() => (editingKey = editingKey === key ? null : key)}
              use:longPress={holdToToggle(key)}
              aria-expanded={editingKey === key}
              class="price-pill"
              class:price-cell-closed={value === null}
              class:price-pill-free={value === 0}
              class:price-cell-guest={key === guestFreeKey}
              class:price-cell-picked={editingKey === key}
              data-testid="price-pill"
            >
              <span class="text-text-muted text-xs">{columnLabel(column)}</span>
              <b
                >{value === null
                  ? m.form_grid_cell_unavailable()
                  : value === 0
                    ? m.form_grid_free()
                    : formatAmount(Math.round(value * 100))}</b
              >
            </button>
          {/each}
        </div>
        {#if editing}
          {@const key = crossKey(row, editing)}
          {@const label = cellLabel(row, editing)}
          <div class="mt-2 flex flex-wrap items-center gap-2" data-testid="pill-editor">
            <span class="text-text-muted text-xs font-bold">{label}</span>
            {#if matrix.cells[key] !== null}
              <span class="flex w-32 items-center gap-1">
                <input
                  value={shown(key)}
                  inputmode="decimal"
                  placeholder="—"
                  aria-label={m.form_grid_cell_price_label({ cell: label })}
                  onchange={(e) => commit(key, e.currentTarget)}
                  class={controlClass(false, 'compact')}
                />
                <span aria-hidden="true">€</span>
              </span>
              {@render cellNote(key)}
            {/if}
            <button
              type="button"
              onclick={() => toggle(key)}
              class="border-cn-border text-text-main rounded-full border px-3 py-1.5 text-xs font-bold"
            >
              {matrix.cells[key] === null
                ? m.form_grid_make_available()
                : m.form_grid_make_unavailable()}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if guestCellLabel}
    <p
      role="status"
      class="border-amber-warn/30 bg-amber-warn/10 flex items-start gap-2 rounded-xl border-2 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-100"
    >
      <TriangleAlert size={13} class="mt-0.5 shrink-0" />
      {m.form_grid_guest_free_status({ cell: guestCellLabel })}
    </p>
  {/if}

  <div class="space-y-1">
    <!-- A phone has no headers to click: its cards are edited pill by pill. -->
    <p class="{CONTROL_HINT_CLASS} max-sm:hidden">{m.form_grid_header_hint()}</p>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_corner_hint()}</p>
    <p class={CONTROL_HINT_CLASS}>{m.form_grid_empty_free_hint()}</p>
  </div>
</section>
