<script lang="ts">
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import { formatDay, formatTimeRange, unitDay, type PlanningEntry } from '$lib/bookings/grid';
  import { columnsHidden } from '$lib/bookings/columns';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE PLANNING (D14): for each resource, the next units one may book now, a tap away - the view a
   * phone opens on, where a grid of several columns does not fit. A resource with nothing free in
   * the days read says so rather than vanishing.
   */
  interface Props {
    space: BookerSpace;
    resources: BookerResource[];
    entries: PlanningEntry[];
    /** How many days ahead were read, for the "nothing free" sentence. */
    days: number;
    onPick: (resource: BookerResource, unit: SlotUnit) => void;
  }

  let { space, resources, entries, days, onPick }: Props = $props();
  /** One column is the space itself (D44): no column name is drawn. */
  const hideColumns = $derived(columnsHidden(resources));

  const unitsOf = (resourceId: string) =>
    entries.find((e) => e.resourceId === resourceId)?.units ?? [];
</script>

<ul class="space-y-3">
  {#each resources as resource (resource.id)}
    {@const units = unitsOf(resource.id)}
    <li class="border-cn-border bg-cn-surface rounded-2xl border p-4 shadow-sm">
      <h3 class="text-text-main text-base font-bold {hideColumns ? 'sr-only' : ''}">
        {resource.name}
      </h3>
      {#if resource.description}
        <p class="text-text-muted mt-0.5 text-sm whitespace-pre-line">{resource.description}</p>
      {/if}
      {#if units.length === 0}
        <p class="text-text-muted mt-3 text-sm">{m.bookings_planning_none({ days })}</p>
      {:else}
        <ul class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {#each units as unit (unit.startMs)}
            <li>
              <button
                type="button"
                onclick={() => onPick(resource, unit)}
                class="border-green-ok/30 bg-green-ok/10 hover:bg-green-ok/20 text-text-main flex min-h-11 w-full flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors"
              >
                <span class="text-sm font-semibold first-letter:uppercase">
                  {formatDay(unitDay(unit, space.timeZone))}
                </span>
                <span class="text-text-muted text-xs tabular-nums">
                  {formatTimeRange(unit.startMs, unit.endMs, space.timeZone)}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </li>
  {/each}
</ul>
