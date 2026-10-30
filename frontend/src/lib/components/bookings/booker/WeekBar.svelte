<script lang="ts">
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WEEK'S BAR ON A DESKTOP (D46): the previous and next week, a way back to this week, the
   * week's dates, and what each colour of the grid means. The legend reuses the words a unit is
   * named with (`bookings_cell_*`), so the grid and its key can never disagree.
   */
  interface Props {
    /** "26 octobre - 1 novembre 2026". */
    label: string;
    /** False while the week shown holds today: there is nowhere to go back to. */
    away: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onToday: () => void;
  }

  let { label, away, onPrevious, onNext, onToday }: Props = $props();

  const keys = [
    { swatch: 'bg-green-ok/10 border-green-ok/30', text: () => m.bookings_cell_free() },
    { swatch: 'bg-cn-border/40 border-cn-border', text: () => m.bookings_cell_booked() },
    { swatch: 'bg-cn-yellow/25 border-cn-yellow/60', text: () => m.bookings_cell_mine() },
    { swatch: 'bg-red-err/10 border-red-err/30', text: () => m.bookings_cell_blocked() },
    { swatch: 'bg-cn-bg border-cn-border/60', text: () => m.bookings_cell_closed() },
  ];
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
  <!-- A calendar app's order: the way back to today first, an outlined pill that is always drawn
       (dimmed while the week shown holds today), then the arrows, then the week. -->
  <button
    type="button"
    class="border-cn-border text-text-main hover:bg-cn-border/30 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    disabled={!away}
    onclick={onToday}
  >
    {m.bookings_week_today()}
  </button>
  <div class="flex items-center">
    <button
      type="button"
      class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
      aria-label={m.bookings_week_previous()}
      onclick={onPrevious}
    >
      <ChevronLeft size={20} />
    </button>
    <button
      type="button"
      class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
      aria-label={m.bookings_week_next()}
      onclick={onNext}
    >
      <ChevronRight size={20} />
    </button>
  </div>
  <h2 class="text-text-main min-w-0 grow text-sm font-bold">{label}</h2>
  <ul class="text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
    {#each keys as key (key.swatch)}
      <li class="flex items-center gap-1">
        <span class="inline-block h-3 w-3 rounded-sm border {key.swatch}" aria-hidden="true"></span>
        {key.text()}
      </li>
    {/each}
  </ul>
</div>
