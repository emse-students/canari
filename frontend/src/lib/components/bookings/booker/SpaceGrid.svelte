<script lang="ts">
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import { windowRefusal, type GridRow } from '$lib/bookings/grid';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE GRID OF ONE DATE (D14): the resources as columns, the units as rows, as the organiser's
   * paper sheet. Every cell is a button with its whole reading as its name; what tapping it does is
   * the page's (`onPick`). A free unit the booking window refuses ON THIS DEVICE'S CLOCK is drawn
   * and named as such, but still opens: the device may be wrong, and the server's answer is the one
   * that counts. A row after the date's midnight (a night window) is marked as the next day.
   */
  interface Props {
    space: BookerSpace;
    resources: BookerResource[];
    rows: GridRow[];
    nowMs: number;
    onPick: (resource: BookerResource, unit: SlotUnit) => void;
  }

  let { space, resources, rows, nowMs, onPick }: Props = $props();

  /** What a cell says, and whether the device's clock puts it outside the booking window. */
  function reading(unit: SlotUnit): { text: string; closed: boolean } {
    if (unit.state === 'booked') {
      const who = unit.booking.mine
        ? m.bookings_cell_mine()
        : (unit.booking.holderName ?? m.bookings_cell_booked());
      return { text: who, closed: false };
    }
    if (unit.state === 'blocked') {
      return { text: unit.blockReason || m.bookings_cell_blocked(), closed: false };
    }
    if (windowRefusal(space, unit.startMs, nowMs) === null) {
      return { text: m.bookings_cell_free(), closed: false };
    }
    return { text: m.bookings_cell_closed(), closed: true };
  }

  function cellClass(unit: SlotUnit, closed: boolean): string {
    if (unit.state === 'booked') {
      return unit.booking.mine
        ? 'bg-cn-yellow/25 text-text-main border-cn-yellow/60'
        : 'bg-cn-border/40 text-text-main border-cn-border';
    }
    if (unit.state === 'blocked') return 'bg-red-err/10 text-red-err border-red-err/30';
    if (closed) return 'bg-cn-bg text-text-muted/60 border-cn-border/60 hover:bg-cn-border/20';
    return 'bg-green-ok/10 text-green-ok border-green-ok/30 hover:bg-green-ok/20';
  }
</script>

<!-- Wider than a phone when a space has many resources: the TABLE scrolls inside its own box,
     never the page, and the time column stays in view. -->
<div
  class="border-cn-border bg-cn-surface overflow-x-auto rounded-2xl border"
  data-swipe-nav-ignore
>
  <table class="w-full border-separate border-spacing-1 text-sm">
    <caption class="sr-only">{m.bookings_grid_caption({ space: space.name })}</caption>
    <thead>
      <tr>
        <th scope="col" class="bg-cn-surface sticky left-0 z-10 w-20 p-2 text-left">
          <span class="sr-only">{m.bookings_grid_time_header()}</span>
        </th>
        {#each resources as resource (resource.id)}
          <th
            scope="col"
            class="text-text-main min-w-28 p-2 text-left text-xs font-bold break-words"
          >
            {resource.name}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr>
          <th
            scope="row"
            class="bg-cn-surface text-text-muted sticky left-0 z-10 p-2 text-left text-xs font-semibold whitespace-nowrap tabular-nums"
          >
            {row.label}
            {#if row.nextDay}
              <span class="block font-normal">{m.bookings_time_next_day()}</span>
            {/if}
          </th>
          {#each row.cells as unit, column (column)}
            {@const resource = resources[column]}
            <td class="p-0">
              {#if unit}
                {@const cell = reading(unit)}
                <button
                  type="button"
                  onclick={() => onPick(resource, unit)}
                  aria-label={m.bookings_cell_label({
                    resource: resource.name,
                    time: row.nextDay ? `${row.label} ${m.bookings_time_next_day()}` : row.label,
                    state: cell.text,
                  })}
                  class="block min-h-11 w-full truncate rounded-lg border px-2 py-2 text-left text-xs font-semibold transition-colors {cellClass(
                    unit,
                    cell.closed
                  )}"
                >
                  {cell.text}
                </button>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
