<script lang="ts">
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import GridAxesTable from './GridAxesTable.svelte';
  import { duplicateLabels, gridRowLabels } from '$lib/forms/answerBounds';
  import {
    addBlankMatrixEntry,
    addMatrixEntries,
    matrixAllowsMultiple,
    matrixAxisEntries,
    matrixAxisMax,
    moveMatrixEntry,
    removeMatrixEntry,
    renameMatrixEntry,
    setMatrixMultiple,
    type EditorMatrixQuestion,
  } from '$lib/forms/matrixEditor';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE "GRILLE DE CHOIX": one editor for the two stored survey grids (owner, 2026-11-07).
   *
   * "Grille unique" and "Grille multiple" were two entries of the type menu, edited as two stacked
   * lists of inputs while the priced grid was edited in its own table - three looks for one idea.
   * Now one switch, "Plusieurs reponses par ligne", writes the stored type (`matrix_multiple` when
   * on, `matrix_single` when off - nothing changes on the wire or on the server), and the rows and
   * columns are edited in the priced grid's own table (`GridAxesTable`). A cell shows what the
   * respondent will tick there: a radio button, or a checkbox.
   */
  interface Props {
    /** The question, mutated in place (a `$state` proxy held by the card or the wizard). */
    item: EditorMatrixQuestion & { required?: boolean; requireEveryRow?: boolean };
  }

  let { item }: Props = $props();

  const rows = $derived(matrixAxisEntries(item, 'rows'));
  const columns = $derived(matrixAxisEntries(item, 'columns'));
  const multiple = $derived(matrixAllowsMultiple(item));
  // A grid answer is keyed by its row label, so two rows of one label are one answer (D4): marked
  // here as it is typed, refused by the page before the save and by the server at it.
  const duplicateRows = $derived(duplicateLabels(gridRowLabels(item.rows as any)));
  const duplicateColumns = $derived(
    duplicateLabels(columns.map((c) => c.label).filter((label) => label.trim()))
  );
</script>

<div class="space-y-3" data-testid="matrix-grid-editor">
  <Toggle
    label={m.form_matrix_multiple_toggle()}
    hint={multiple ? m.form_matrix_multiple_hint_on() : m.form_matrix_multiple_hint_off()}
    bind:checked={() => multiple, (on) => setMatrixMultiple(item, on)}
  />

  <GridAxesTable
    {rows}
    {columns}
    isDuplicate={(axis, label) => (axis === 'rows' ? duplicateRows : duplicateColumns).has(label)}
    onRename={(axis, id, label) => renameMatrixEntry(item, axis, id, label)}
    onAddBlank={(axis) => addBlankMatrixEntry(item, axis)}
    onAddMany={(axis, labels) => addMatrixEntries(item, axis, labels)}
    onMove={(axis, from, to) => moveMatrixEntry(item, axis, from, to)}
    onRemove={(axis, id) => {
      removeMatrixEntry(item, axis, id);
    }}
    maxOf={matrixAxisMax}
    rowPlaceholder={m.form_matrix_row_placeholder()}
    columnPlaceholder={m.form_matrix_column_placeholder()}
  >
    {#snippet cell()}
      <!-- What the respondent ticks here: drawn, not operable - the editor takes no answer. -->
      <span class="flex h-11 w-full min-w-12 items-center justify-center max-sm:min-w-0">
        <span
          aria-hidden="true"
          data-matrix-cell={multiple ? 'checkbox' : 'radio'}
          class="border-text-muted/60 block h-4 w-4 border-2 {multiple
            ? 'rounded-sm'
            : 'rounded-full'}"
        ></span>
      </span>
    {/snippet}
    {#snippet footer()}
      {#if duplicateRows.size > 0 || duplicateColumns.size > 0}
        <p class="text-red-err pt-1 text-xs font-semibold" role="alert">
          {m.form_builder_grid_duplicate_inline()}
        </p>
      {/if}
    {/snippet}
  </GridAxesTable>

  {#if item.required}
    <!-- D5: a required grid wants one answered row, unless every row is asked for. -->
    <Toggle
      label={m.form_builder_require_every_row()}
      bind:checked={
        () => item.requireEveryRow === true,
        (on) => {
          item.requireEveryRow = on;
        }
      }
    />
  {/if}
</div>
