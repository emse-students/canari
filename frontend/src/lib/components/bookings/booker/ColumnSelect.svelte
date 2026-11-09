<script lang="ts">
  import type { BookerResource } from '$lib/bookings/api';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHICH COLUMN ONE BOOKS (D46): pills up to five columns, a list beyond - fourteen pills would
   * wrap into a wall. The page shows this only when a space has several columns (D44). Each option
   * carries how many units one may take in the week read, so a column that is full says so before
   * it is opened.
   */
  interface Props {
    resources: BookerResource[];
    value: string;
    /** Units one may take now, by column id. */
    counts: ReadonlyMap<string, number>;
    onSelect: (id: string) => void;
  }

  let { resources, value, counts, onSelect }: Props = $props();

  /** Up to here the columns are pills, past it a list. */
  const PILL_LIMIT = 5;
  const countOf = (id: string) => counts.get(id) ?? 0;
</script>

<div class="space-y-1">
  <p id="bookings-column-label" class="text-text-muted text-xs font-bold">
    {m.bookings_column_label()}
  </p>
  {#if resources.length <= PILL_LIMIT}
    <div class="flex flex-wrap gap-2" role="group" aria-labelledby="bookings-column-label">
      {#each resources as resource (resource.id)}
        <button
          type="button"
          aria-pressed={resource.id === value}
          onclick={() => onSelect(resource.id)}
          class="min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors {resource.id ===
          value
            ? 'bg-cn-yellow text-cn-ink border-cn-yellow'
            : 'border-cn-border bg-cn-surface text-text-main hover:bg-cn-border/30'}"
        >
          {resource.name}
          <span class="text-xs font-normal opacity-70">
            {m.bookings_column_free_count({ count: countOf(resource.id) })}
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <select
      aria-labelledby="bookings-column-label"
      class="border-cn-border bg-cn-surface text-text-main min-h-11 w-full max-w-md rounded-xl border px-3 text-sm"
      {value}
      onchange={(e) => onSelect(e.currentTarget.value)}
    >
      {#each resources as resource (resource.id)}
        <option value={resource.id}>
          {resource.name} - {m.bookings_column_free_count({ count: countOf(resource.id) })}
        </option>
      {/each}
    </select>
  {/if}
</div>
