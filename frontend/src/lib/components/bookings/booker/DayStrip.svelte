<script lang="ts">
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { formatDay, formatDayHead, type DayColumn } from '$lib/bookings/grid';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WEEK STRIP OF A PHONE (D48): the seven days of the week one is in, the chosen one marked, and
   * under each a dot that says whether the day still has room - read from the SAME week read as the
   * day below it, never a second request. A closed day stays tappable: it answers "nothing offered".
   */
  interface Props {
    days: DayColumn[];
    /** The chosen date. */
    date: string;
    today: string;
    /** "26 octobre - 1 novembre 2026". */
    label: string;
    onSelect: (date: string) => void;
    onPrevious: () => void;
    onNext: () => void;
    /** False while the week shown holds today: there is nowhere to go back to. */
    away?: boolean;
    onToday?: () => void;
  }

  let {
    days,
    date,
    today,
    label,
    onSelect,
    onPrevious,
    onNext,
    away = false,
    onToday,
  }: Props = $props();

  const stateText = (state: DayColumn['state']) =>
    state === 'open'
      ? m.bookings_day_state_open()
      : state === 'none'
        ? m.bookings_day_state_none()
        : m.bookings_day_closed();
  const dot = (state: DayColumn['state']) =>
    state === 'open' ? 'bg-green-ok' : state === 'none' ? 'bg-text-muted/60' : 'bg-transparent';
</script>

<div class="space-y-1">
  <div class="flex items-center gap-1">
    <button
      type="button"
      class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
      aria-label={m.bookings_week_previous()}
      onclick={onPrevious}
    >
      <ChevronLeft size={20} />
    </button>
    <h2 class="text-text-main min-w-0 grow truncate text-center text-sm font-bold">{label}</h2>
    {#if onToday}
      <!-- Aligned with the label, same pill as the desktop bar's: dimmed while this week holds today. -->
      <button
        type="button"
        class="border-cn-border text-text-main hover:bg-cn-border/30 shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
        disabled={!away}
        onclick={onToday}
      >
        {m.bookings_week_today()}
      </button>
    {/if}
    <button
      type="button"
      class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
      aria-label={m.bookings_week_next()}
      onclick={onNext}
    >
      <ChevronRight size={20} />
    </button>
  </div>
  <div class="grid grid-cols-7 gap-1" role="group" aria-label={m.bookings_strip_label()}>
    {#each days as day (day.date)}
      {@const head = formatDayHead(day.date)}
      <button
        type="button"
        aria-pressed={day.date === date}
        aria-label={`${formatDay(day.date)} : ${stateText(day.state)}`}
        onclick={() => onSelect(day.date)}
        class="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl border px-0.5 py-1 text-xs transition-colors {day.date ===
        date
          ? 'bg-cn-yellow text-cn-ink border-cn-yellow font-bold'
          : day.date === today
            ? 'border-cn-yellow bg-cn-surface text-text-muted'
            : 'border-cn-border bg-cn-surface text-text-muted hover:bg-cn-border/30'}"
      >
        <span class="first-letter:uppercase">{head.weekday}</span>
        <span class="text-sm font-bold">{head.num}</span>
        <span class="h-1.5 w-1.5 rounded-full {dot(day.state)}" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
</div>
