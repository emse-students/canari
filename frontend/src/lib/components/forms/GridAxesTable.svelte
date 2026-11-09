<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ClipboardPaste,
    GripVertical,
    Plus,
    X,
  } from '@lucide/svelte';
  import {
    splitPastedList,
    type AddEntriesResult,
    type ProductGridAxis,
  } from '$lib/forms/productGridEditor';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE ROWS AND COLUMNS OF A GRID QUESTION, EDITED IN THE TABLE THEY MAKE - shared by the priced
   * grid (`ProductGridEditor`) and the "Grille de choix" (`MatrixGridEditor`), so both grids look
   * and behave alike (owner, 2026-11-07, after seeing the two edited in two different ways).
   *
   * Columns are chips in the header (renamed in place, removed by their x), rows a narrow first
   * column of inline labels, "Ajouter une ligne" / "Ajouter une colonne" add one and "Coller une
   * liste" adds many. A grip moves a row or a column, by dragging or by the arrow keys; on a touch
   * screen or a phone-width page, where no drag reaches it, two arrow buttons per entry do. Below
   * `sm` the table is drawn to fit a phone: the row labels narrow and wrap, a row's arrows sit
   * under its label, a column's chip stacks its controls. A wider grid scrolls inside its own box,
   * the row labels sticky.
   *
   * What a CELL shows is the caller's (`cell`): the priced grid's closable price, the choice
   * grid's radio or checkbox. So is the model: every edit goes out through a callback, and the
   * caller's own rules decide it.
   */
  interface AxisEntry {
    id: string;
    label: string;
  }

  interface Props {
    rows: readonly AxisEntry[];
    columns: readonly AxisEntry[];
    /** Whether a label collides with another of its axis - marked on the field as it is typed. */
    isDuplicate: (axis: ProductGridAxis, label: string) => boolean;
    onRename: (axis: ProductGridAxis, id: string, label: string) => void;
    /** Appends a blank entry; false when the axis is full. */
    onAddBlank: (axis: ProductGridAxis) => boolean;
    /** Appends pasted labels, refusing the ones already there and counting what overflows. */
    onAddMany: (axis: ProductGridAxis, labels: string[]) => AddEntriesResult;
    onMove: (axis: ProductGridAxis, from: number, to: number) => boolean;
    /** Removes an entry; the caller may refuse it or ask first. */
    onRemove: (axis: ProductGridAxis, id: string) => void | Promise<void>;
    /** The most entries an axis may hold, said when the "+" is refused. */
    maxOf: (axis: ProductGridAxis) => number;
    rowPlaceholder: string;
    columnPlaceholder: string;
    /** One cell's content. */
    cell: Snippet<[AxisEntry, AxisEntry]>;
    /** A header cell after the corner (the priced grid's "Prix" column in per-row mode). */
    afterCornerHeader?: Snippet;
    /** A cell after a row's label (that column's price field). */
    afterRowLabel?: Snippet<[AxisEntry]>;
    /** A whole header row under the chips (the priced grid's price row in per-column mode). */
    headerRow?: Snippet;
    /** Lines under the add buttons: the caller's refusals and hints. */
    footer?: Snippet;
  }

  let {
    rows,
    columns,
    isDuplicate,
    onRename,
    onAddBlank,
    onAddMany,
    onMove,
    onRemove,
    maxOf,
    rowPlaceholder,
    columnPlaceholder,
    cell,
    afterCornerHeader,
    afterRowLabel,
    headerRow,
    footer,
  }: Props = $props();

  const TAG = 'GridAxesTable';

  let tableEl = $state<HTMLElement | null>(null);
  let pasteOpen = $state(false);
  let pasteText = $state('');
  let pasteFeedback = $state('');

  const listOf = (axis: ProductGridAxis) => (axis === 'rows' ? rows : columns);

  function addEntry(axis: ProductGridAxis) {
    if (!onAddBlank(axis)) {
      pasteFeedback = m.form_pgrid_axis_full({ max: maxOf(axis) });
      return;
    }
    // The new blank label takes the focus: "+" then typing is the common case.
    void tick().then(() => {
      const inputs = tableEl?.querySelectorAll<HTMLElement>(`[data-axis-input="${axis}"]`);
      inputs?.[inputs.length - 1]?.focus();
    });
  }

  function feedbackOf(result: AddEntriesResult, axis: ProductGridAxis): string {
    const parts: string[] = [];
    if (result.duplicates.length > 0) {
      parts.push(m.form_pgrid_paste_duplicates({ labels: result.duplicates.join(', ') }));
    }
    if (result.overflow > 0) {
      parts.push(m.form_pgrid_paste_overflow({ count: result.overflow, max: maxOf(axis) }));
    }
    return parts.join(' ');
  }

  function pasteAs(axis: ProductGridAxis) {
    const labels = splitPastedList(pasteText);
    if (labels.length === 0) {
      pasteFeedback = m.form_pgrid_paste_empty();
      return;
    }
    pasteFeedback = feedbackOf(onAddMany(axis, labels), axis);
    if (!pasteFeedback) {
      pasteText = '';
      pasteOpen = false;
    }
  }

  // Reordering: a grip is dragged onto another entry, or moved with the arrow keys.
  let dragAxis = $state<ProductGridAxis | null>(null);
  let dragFrom = $state(-1);

  function onGripDragStart(e: DragEvent, axis: ProductGridAxis, index: number) {
    // The question card is draggable too: this drag is the grid's, never the card's.
    e.stopPropagation();
    dragAxis = axis;
    dragFrom = index;
    e.dataTransfer?.setData('text/plain', `${axis}:${index}`);
  }

  function onEntryDragOver(e: DragEvent, axis: ProductGridAxis) {
    if (dragAxis !== axis) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onEntryDrop(e: DragEvent, axis: ProductGridAxis, index: number) {
    if (dragAxis !== axis) return;
    e.preventDefault();
    e.stopPropagation();
    onMove(axis, dragFrom, index);
    endDrag();
  }

  function endDrag() {
    dragAxis = null;
    dragFrom = -1;
  }

  async function onGripKeydown(e: KeyboardEvent, axis: ProductGridAxis, index: number) {
    const back = axis === 'rows' ? 'ArrowUp' : 'ArrowLeft';
    const forward = axis === 'rows' ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const to = e.key === back ? index - 1 : index + 1;
    if (!onMove(axis, index, to)) return;
    await tick();
    tableEl?.querySelectorAll<HTMLElement>(`[data-axis-grip="${axis}"]`)[to]?.focus();
  }

  /**
   * The touch path: an arrow button moves its entry one step. Focus follows the entry to the same
   * button at its new place, or to the other one once that end of the axis is reached (a disabled
   * button cannot hold focus).
   */
  async function moveByButton(axis: ProductGridAxis, index: number, step: -1 | 1) {
    const to = index + step;
    if (!onMove(axis, index, to)) return;
    await tick();
    const atEnd = step < 0 ? to === 0 : to === listOf(axis).length - 1;
    const side = (atEnd ? -step : step) < 0 ? 'back' : 'forward';
    tableEl?.querySelectorAll<HTMLElement>(`[data-axis-move="${axis}:${side}"]`)[to]?.focus();
  }

  /** The arrow buttons show where no drag works: a coarse pointer, or a phone-width page. */
  const moveButtonClass =
    'ui-icon-button text-text-muted hover:text-text-main hidden rounded-lg hover:bg-black/5 disabled:opacity-25 max-sm:inline-flex pointer-coarse:inline-flex dark:hover:bg-white/10';
  /** A column's arrows on a phone: as wide as its narrow column, the 44px hit box from `tap-target`. */
  const columnMoveButtonClass =
    'text-text-muted hover:text-text-main tap-target hidden h-11 w-11 items-center justify-center rounded-lg hover:bg-black/5 disabled:opacity-25 max-sm:inline-flex max-sm:w-full pointer-coarse:inline-flex dark:hover:bg-white/10';
  /** The row label column is sticky, so a grid too wide for the phone scrolls under it. */
  const stickyLabelClass = 'bg-cn-surface sticky left-0 z-1';
  const footerButtonClass =
    'text-text-muted hover:text-text-main inline-flex min-h-11 items-center gap-2 px-1 text-sm font-bold';

  /**
   * A row label is a textarea so it WRAPS in the phone's narrow column; it grows to its content
   * here rather than through `field-sizing`, which older WebKit lacks. A line break is no label:
   * Enter and pasted newlines become nothing and a space.
   */
  function fitLabel(node: HTMLTextAreaElement) {
    const fit = () => {
      node.style.height = 'auto';
      // Border-box: the underline counts in the height, not in `scrollHeight`.
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
    };
    fit();
    node.addEventListener('input', fit);
    // The column's width settles after mount (and changes with the page): the lines follow it.
    // Only a WIDTH change refits: the height this sets must not feed back into the observer.
    let width = node.clientWidth;
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (node.clientWidth === width) return;
            width = node.clientWidth;
            fit();
          });
    resize?.observe(node);
    return {
      destroy: () => {
        node.removeEventListener('input', fit);
        resize?.disconnect();
      },
    };
  }

  function onRowLabelKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) e.preventDefault();
  }

  function onRowLabelInput(id: string, e: Event) {
    const field = e.currentTarget as HTMLTextAreaElement;
    const label = field.value.replace(/[\r\n]+/g, ' ');
    if (label !== field.value) field.value = label;
    onRename('rows', id, label);
  }

  function togglePaste() {
    pasteOpen = !pasteOpen;
    pasteFeedback = '';
    Log.d(TAG, `paste box ${pasteOpen ? 'opened' : 'closed'}`);
  }
</script>

<div data-testid="grid-axes-table">
  <div class="overflow-x-auto pt-3" bind:this={tableEl}>
    <table class="border-separate border-spacing-0 max-sm:w-full">
      <thead>
        <tr>
          <th
            scope="col"
            class="text-text-muted {stickyLabelClass} w-56 min-w-44 pr-2 pb-2 text-left text-xs font-bold max-sm:w-auto max-sm:min-w-26 max-sm:pr-1"
            >{m.form_pgrid_corner()}</th
          >
          {@render afterCornerHeader?.()}
          {#each columns as column, ci (column.id)}
            <th
              scope="col"
              class="w-26 px-1 pb-2 align-bottom max-sm:w-8 max-sm:min-w-8 max-sm:px-0.5"
              ondragover={(e) => onEntryDragOver(e, 'columns')}
              ondrop={(e) => onEntryDrop(e, 'columns', ci)}
            >
              <span
                class="bg-cn-border/60 flex items-center justify-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-1 max-sm:flex-col max-sm:rounded-lg max-sm:px-0 {isDuplicate(
                  'columns',
                  column.label
                )
                  ? 'ring-red-err ring-2'
                  : ''}"
              >
                <button
                  type="button"
                  draggable="true"
                  data-axis-grip="columns"
                  ondragstart={(e) => onGripDragStart(e, 'columns', ci)}
                  ondragend={endDrag}
                  onkeydown={(e) => onGripKeydown(e, 'columns', ci)}
                  aria-label={m.form_pgrid_move_column({ label: column.label || ci + 1 })}
                  class="text-text-muted flex h-8 w-4 shrink-0 cursor-grab items-center justify-center max-sm:hidden pointer-coarse:hidden"
                  ><GripVertical size={12} /></button
                >
                <input
                  data-axis-input="columns"
                  value={column.label}
                  oninput={(e) => onRename('columns', column.id, e.currentTarget.value)}
                  aria-label={m.form_pgrid_column_label({ n: ci + 1 })}
                  aria-invalid={isDuplicate('columns', column.label) || !column.label.trim()}
                  placeholder={columnPlaceholder}
                  maxlength={100}
                  class="text-text-main placeholder:text-text-muted/60 min-h-8 w-12 min-w-0 border-0 bg-transparent text-center text-sm font-bold outline-none max-sm:w-full max-sm:text-xs"
                />
                <button
                  type="button"
                  onclick={() => onRemove('columns', column.id)}
                  disabled={columns.length <= 1}
                  aria-label={m.form_pgrid_remove_column({ label: column.label || ci + 1 })}
                  class="text-text-muted hover:text-red-err tap-target flex h-8 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-30 max-sm:w-full"
                  ><X size={12} /></button
                >
              </span>
              <span
                class="mt-1 hidden justify-center gap-0.5 max-sm:flex max-sm:flex-col pointer-coarse:flex"
              >
                <button
                  type="button"
                  data-axis-move="columns:back"
                  onclick={() => moveByButton('columns', ci, -1)}
                  disabled={ci === 0}
                  aria-label={m.form_pgrid_move_column_left({ label: column.label || ci + 1 })}
                  class={columnMoveButtonClass}><ArrowLeft size={16} /></button
                >
                <button
                  type="button"
                  data-axis-move="columns:forward"
                  onclick={() => moveByButton('columns', ci, 1)}
                  disabled={ci === columns.length - 1}
                  aria-label={m.form_pgrid_move_column_right({ label: column.label || ci + 1 })}
                  class={columnMoveButtonClass}><ArrowRight size={16} /></button
                >
              </span>
            </th>
          {/each}
          <!-- On a phone this "+" gives way to the footer's, and the cell keeps a sliver so the last
               column's widened hit boxes stay inside the table. -->
          <th class="pb-2 pl-1 align-bottom max-sm:w-2 max-sm:p-0">
            <button
              type="button"
              onclick={() => addEntry('columns')}
              aria-label={m.form_pgrid_add_column()}
              title={m.form_pgrid_add_column()}
              class="ui-icon-button border-cn-border bg-cn-surface text-text-main rounded-full border max-sm:hidden"
              ><Plus size={16} /></button
            >
          </th>
        </tr>
        {@render headerRow?.()}
      </thead>
      <tbody>
        {#each rows as row, ri (row.id)}
          <tr
            ondragover={(e) => onEntryDragOver(e, 'rows')}
            ondrop={(e) => onEntryDrop(e, 'rows', ri)}
          >
            <th
              scope="row"
              class="{stickyLabelClass} py-0.5 pr-2 text-left font-normal max-sm:min-w-26 max-sm:pr-1"
            >
              <span class="flex items-center gap-1 max-sm:flex-wrap max-sm:gap-0">
                <button
                  type="button"
                  draggable="true"
                  data-axis-grip="rows"
                  ondragstart={(e) => onGripDragStart(e, 'rows', ri)}
                  ondragend={endDrag}
                  onkeydown={(e) => onGripKeydown(e, 'rows', ri)}
                  aria-label={m.form_pgrid_move_row({ label: row.label || ri + 1 })}
                  class="ui-icon-button text-text-muted cursor-grab rounded-lg max-sm:hidden pointer-coarse:hidden"
                  ><GripVertical size={14} /></button
                >
                <!-- On a phone the arrows go under the label, the label keeping the width. -->
                <span class="contents max-sm:order-last max-sm:flex max-sm:w-full">
                  <button
                    type="button"
                    data-axis-move="rows:back"
                    onclick={() => moveByButton('rows', ri, -1)}
                    disabled={ri === 0}
                    aria-label={m.form_pgrid_move_row_up({ label: row.label || ri + 1 })}
                    class={moveButtonClass}><ArrowUp size={16} /></button
                  >
                  <button
                    type="button"
                    data-axis-move="rows:forward"
                    onclick={() => moveByButton('rows', ri, 1)}
                    disabled={ri === rows.length - 1}
                    aria-label={m.form_pgrid_move_row_down({ label: row.label || ri + 1 })}
                    class={moveButtonClass}><ArrowDown size={16} /></button
                  >
                </span>
                <textarea
                  rows="1"
                  use:fitLabel
                  data-axis-input="rows"
                  value={row.label}
                  oninput={(e) => onRowLabelInput(row.id, e)}
                  onkeydown={onRowLabelKeydown}
                  aria-label={m.form_pgrid_row_label({ n: ri + 1 })}
                  aria-invalid={isDuplicate('rows', row.label) || !row.label.trim()}
                  placeholder={rowPlaceholder}
                  maxlength={100}
                  class="text-text-main placeholder:text-text-muted/60 focus:border-accent-icon min-h-10 w-0 min-w-0 flex-1 resize-none overflow-hidden border-0 border-b bg-transparent px-1 py-2.5 text-sm font-semibold break-words outline-none max-sm:px-0 {isDuplicate(
                    'rows',
                    row.label
                  )
                    ? 'border-red-err'
                    : 'border-cn-border'}"></textarea>
                <button
                  type="button"
                  onclick={() => onRemove('rows', row.id)}
                  disabled={rows.length <= 1}
                  aria-label={m.form_pgrid_remove_row({ label: row.label || ri + 1 })}
                  class="text-text-muted hover:text-red-err tap-target flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-30 max-sm:w-8"
                  ><X size={14} /></button
                >
              </span>
            </th>
            {@render afterRowLabel?.(row)}
            {#each columns as column (column.id)}
              <td class="px-1 py-0.5 max-sm:px-0.5">
                {@render cell(row, column)}
              </td>
            {/each}
            <td></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <!-- Outside the table, so a grid that scrolls sideways never carries them out of view. -->
  <div class="flex flex-wrap gap-x-4 pt-1.5">
    <button type="button" onclick={() => addEntry('rows')} class={footerButtonClass}>
      <Plus size={16} />
      {m.form_pgrid_add_row()}
    </button>
    <button type="button" onclick={() => addEntry('columns')} class="{footerButtonClass} sm:hidden">
      <Plus size={16} />
      {m.form_pgrid_add_column()}
    </button>
    <button type="button" aria-expanded={pasteOpen} onclick={togglePaste} class={footerButtonClass}>
      <ClipboardPaste size={16} />
      {m.form_pgrid_paste_button()}
    </button>
  </div>

  {#if pasteOpen}
    <div
      class="border-cn-border mt-2 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start"
    >
      <label class="flex min-w-0 flex-1 flex-col gap-1.5">
        <span class="text-text-main text-sm font-bold">{m.form_pgrid_paste_label()}</span>
        <textarea
          rows="4"
          bind:value={pasteText}
          placeholder={m.form_pgrid_paste_placeholder()}
          class="border-cn-border text-text-main focus:border-accent-icon bg-cn-surface resize-y rounded-lg border px-3 py-2.5 text-sm outline-none"
        ></textarea>
      </label>
      <div class="flex flex-col gap-2 sm:pt-6">
        <button
          type="button"
          onclick={() => pasteAs('rows')}
          class="bg-accent text-cn-ink min-h-11 rounded-lg px-4 text-sm font-bold"
          >{m.form_pgrid_paste_as_rows()}</button
        >
        <button
          type="button"
          onclick={() => pasteAs('columns')}
          class="bg-cn-border/60 text-text-main min-h-11 rounded-lg px-4 text-sm font-bold"
          >{m.form_pgrid_paste_as_columns()}</button
        >
      </div>
    </div>
  {/if}
  {#if pasteFeedback}
    <p class="text-red-err pt-1 text-xs font-semibold" role="status">{pasteFeedback}</p>
  {/if}
  {@render footer?.()}
</div>
