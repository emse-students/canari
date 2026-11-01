<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    formatBookingRange,
    formatDay,
    formatTimeRange,
    isOfferedStart,
    unitText,
  } from '$lib/bookings/grid';
  import type { GridRun } from '$lib/bookings/gridRuns';
  import type { PlanningDay } from '$lib/bookings/planning';
  import HolderAvatar from '$lib/components/bookings/booker/HolderAvatar.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WEEK AS A LIST, FOR A PHONE (owner, 2026-11-01; supersedes D48 there): the seven days one
   * under the other, each a run of rows - a booking, a block, a free stretch, a stretch not offered
   * now - as the agenda's schedule list is. A taken row opens its reading (`onOpen`, the same sheet
   * the grid opens); a FREE row opens the range form prefilled with its stretch (`onFree`); the
   * button at the bottom opens it blank (`onAdd`). Nothing is painted with a finger. The list is the
   * week the grid would draw, read once: `days` come from `planningDays`.
   */
  interface Props {
    days: PlanningDay[];
    space: BookerSpace;
    resource: BookerResource;
    nowMs: number;
    lastRefusedStart: number | null;
    /** The organiser's dashboard: free rows are blockable whatever the window says. */
    blockMode: boolean;
    /** The day the strip selected: the list scrolls to it. */
    focusDate: string;
    today: string;
    onOpen: (unit: SlotUnit) => void;
    onFree: (run: GridRun) => void;
    onAdd: () => void;
  }

  let {
    days,
    space,
    resource,
    nowMs,
    lastRefusedStart,
    blockMode,
    focusDate,
    today,
    onOpen,
    onFree,
    onAdd,
  }: Props = $props();

  const offered = (unit: SlotUnit) =>
    isOfferedStart(space, unit, nowMs, lastRefusedStart, blockMode);

  let list = $state<HTMLElement | null>(null);
  let lastFocus = '';
  $effect(() => {
    const date = focusDate;
    if (!list || date === lastFocus) return;
    const first = lastFocus === '';
    lastFocus = date;
    // The first draw already sits at the top; only a day picked afterwards moves the page.
    if (!first) list.querySelector<HTMLElement>(`[data-day="${date}"]`)?.scrollIntoView?.();
  });

  const rowClass = (run: GridRun, takeable: boolean) =>
    run.kind === 'booked'
      ? run.units[0].state === 'booked' && run.units[0].booking.mine
        ? 'border-cn-yellow/60 bg-cn-yellow/25 text-text-main'
        : 'border-cn-border bg-control-fill text-text-main'
      : run.kind === 'blocked'
        ? 'border-red-err/30 bg-red-err/10 text-red-err'
        : takeable
          ? 'border-green-ok/30 bg-green-ok/10 text-green-ok'
          : 'border-cn-border/60 bg-cn-bg/60 text-text-muted';
</script>

<div bind:this={list} class="space-y-1" data-planning>
  {#each days as day (day.date)}
    <section data-day={day.date} aria-label={formatDay(day.date)} class="scroll-mt-2">
      <h3
        class="text-text-muted px-1 pt-3 pb-1.5 text-xs font-bold tracking-wide uppercase {day.date ===
        today
          ? 'text-text-main'
          : ''}"
      >
        {formatDay(day.date)}{day.rows.length === 0 ? ` - ${m.bookings_day_closed()}` : ''}
      </h3>
      <ul class="space-y-1.5">
        {#each day.rows as run (`${run.startMs}-${run.endMs}-${run.lane}`)}
          {@const unit = run.units[0]}
          {@const takeable = run.kind === 'free' && offered(unit)}
          {@const text = unitText(unit, run.kind !== 'closed')}
          {@const time = formatTimeRange(run.startMs, run.endMs, space.timeZone)}
          <li>
            {#if run.kind === 'closed'}
              <div
                class="flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm {rowClass(
                  run,
                  false
                )}"
              >
                <span class="w-28 shrink-0 text-xs font-bold tabular-nums">{time}</span>
                <span class="min-w-0 truncate">{text}</span>
              </div>
            {:else}
              <button
                type="button"
                data-row={run.kind}
                aria-label={m.bookings_cell_label({
                  resource: resource.name,
                  time: formatBookingRange(run.startMs, run.endMs, space.timeZone),
                  state: text,
                })}
                disabled={run.kind === 'free' && !takeable}
                onclick={() => (run.kind === 'free' ? onFree(run) : onOpen(unit))}
                class="focus-visible:ring-cn-yellow flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 disabled:cursor-default {rowClass(
                  run,
                  takeable
                )}"
              >
                <span class="w-28 shrink-0 text-xs font-bold tabular-nums">{time}</span>
                {#if run.kind === 'booked'}
                  <HolderAvatar {unit} />
                {/if}
                <span class="min-w-0 flex-1 truncate font-semibold">{text}</span>
                {#if takeable}
                  <Plus size={18} aria-hidden="true" />
                {/if}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<button
  type="button"
  onclick={onAdd}
  aria-label={blockMode ? m.bookings_planning_add_block() : m.bookings_planning_add()}
  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover focus-visible:ring-cn-yellow sticky bottom-4 z-20 mt-4 ml-auto flex h-14 w-14 items-center justify-center rounded-full shadow-lg outline-none focus-visible:ring-2"
>
  <Plus size={28} aria-hidden="true" />
</button>
