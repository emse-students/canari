<script lang="ts">
  /**
   * A compact, touch-sized picker of the formation x campus pairs an audience reaches: one block per
   * campus, a parent box for the whole campus and one box per formation. It is the narrow-screen
   * sibling of the `/admin/spaces` grid, built on the SAME pure helpers (`audienceRules.ts`) so a
   * union of several campuses or formations - which the three presets cannot say - is written
   * exactly as the grid would write it (`toRules`, the smallest equivalent rule set).
   */
  import { Check, Minus } from '@lucide/svelte';
  import {
    campusCells,
    cellOf,
    coverage,
    toggleGroup,
    type Cell,
  } from '$lib/associations/audienceRules';
  import { CAMPUSES, FORMATIONS, campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The pairs reached; replaced (never mutated) on every toggle so the parent sees a change. */
    cells: Set<Cell>;
  }

  let { cells = $bindable() }: Props = $props();

  const box =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors';
  const on = 'border-cn-yellow bg-cn-yellow/20 text-cn-dark';
  const half = 'border-cn-yellow/60 text-cn-dark';
  const off = 'border-cn-border text-transparent';
</script>

<div class="space-y-3" data-cell-picker>
  {#each CAMPUSES as campus (campus)}
    {@const group = campusCells(campus)}
    {@const state = coverage(group, cells)}
    <fieldset class="border-cn-border rounded-xl border p-3">
      <legend class="sr-only">{campusLabel(campus)}</legend>
      <button
        type="button"
        aria-pressed={state === 'all'}
        data-cell-campus={campus}
        onclick={() => (cells = toggleGroup(cells, group))}
        class="flex w-full items-center gap-2 text-left"
      >
        <span class="{box} {state === 'all' ? on : state === 'some' ? half : off}">
          {#if state === 'some'}<Minus size={14} />{:else}<Check size={14} />{/if}
        </span>
        <span class="text-text-main text-sm font-bold">
          {campusLabel(campus)} - {m.admin_spaces_col_campus()}
        </span>
      </button>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each FORMATIONS as formation (formation)}
          {@const cell = cellOf(formation, campus)}
          {@const reached = cells.has(cell)}
          <button
            type="button"
            aria-pressed={reached}
            data-cell={cell}
            onclick={() => (cells = toggleGroup(cells, [cell]))}
            class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors {reached
              ? on
              : 'border-cn-border text-text-muted hover:bg-cn-bg'}"
          >
            {#if reached}<Check size={12} />{/if}
            {formationLabel(formation)}
          </button>
        {/each}
      </div>
    </fieldset>
  {/each}
</div>
