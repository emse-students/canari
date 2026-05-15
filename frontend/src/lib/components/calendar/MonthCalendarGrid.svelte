<script lang="ts">
  let {
    focusDate,
    events = [],
    loading = false,
    selectedDay = $bindable<number | null>(null),
  } = $props<{
    focusDate: Date;
    events: Array<{ startsAt: string }>;
    loading?: boolean;
    selectedDay?: number | null;
  }>();

  const weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  function sameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function isToday(day: number): boolean {
    const today = new Date();
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return sameDay(d, today);
  }

  function eventsOnDay(day: number): number {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return events.filter((ev: { startsAt: string }) => sameDay(new Date(ev.startsAt), d)).length;
  }

  /** Monday-first calendar cells for the visible month */
  const calendarCells = $derived.by(() => {
    const y = focusDate.getFullYear();
    const m = focusDate.getMonth();
    const first = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0).getDate();
    const mondayIndex = (first.getDay() + 6) % 7;
    const cells: { day: number | null; inMonth: boolean }[] = [];
    for (let i = 0; i < mondayIndex; i++) cells.push({ day: null, inMonth: false });
    for (let day = 1; day <= lastDay; day++) cells.push({ day, inMonth: true });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      cells.push({ day: null, inMonth: false });
    }
    return cells;
  });

  function selectDay(day: number) {
    const count = eventsOnDay(day);
    if (count === 0) {
      selectedDay = null;
      return;
    }
    selectedDay = selectedDay === day ? null : day;
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-3 sm:p-4 shadow-sm">
  {#if loading}
    <div class="flex justify-center py-10">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else}
    <div
      class="grid grid-cols-7 gap-0.5 sm:gap-1 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1.5 sm:mb-2"
    >
      {#each weekdayLabels as w (w)}
        <span>{w}</span>
      {/each}
    </div>
    <div class="grid grid-cols-7 gap-0.5 sm:gap-1" role="grid" aria-label="Calendrier du mois">
      {#each calendarCells as cell, i (i)}
        {#if cell.day === null}
          <div class="aspect-square rounded-lg sm:rounded-xl bg-transparent" role="gridcell"></div>
        {:else}
          {@const count = eventsOnDay(cell.day)}
          {@const selected = selectedDay === cell.day}
          <button
            type="button"
            aria-label="{cell.day}{count > 0 ? `, ${count} événement${count > 1 ? 's' : ''}` : ''}"
            aria-pressed={selected}
            onclick={() => selectDay(cell.day!)}
            class="aspect-square rounded-lg sm:rounded-xl flex flex-col items-center justify-center gap-0.5 text-sm relative border transition-colors min-h-[2.25rem] sm:min-h-0
              {selected
              ? 'border-cn-yellow bg-cn-yellow/20 font-bold text-text-main ring-2 ring-cn-yellow/40'
              : count > 0
                ? 'border-cn-yellow/40 bg-cn-yellow/10 font-semibold text-text-main hover:bg-cn-yellow/15'
                : isToday(cell.day)
                  ? 'border-cn-border bg-cn-bg/50 text-text-main font-medium'
                  : 'border-cn-border/30 bg-cn-bg/20 text-text-muted hover:bg-cn-bg/40'}"
          >
            <span class="leading-none">{cell.day}</span>
            {#if count > 0}
              <span class="flex items-center justify-center gap-px flex-wrap max-w-[90%] px-0.5" aria-hidden="true">
                {#each { length: Math.min(count, 4) } as _, dotIdx (dotIdx)}
                  <span class="h-1 w-1 rounded-full bg-cn-yellow shrink-0"></span>
                {/each}
                {#if count > 4}
                  <span class="text-[8px] font-bold text-cn-dark leading-none">+{count - 4}</span>
                {/if}
              </span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
    {#if selectedDay != null}
      <p class="mt-3 text-center text-xs text-text-muted">
        Jour {selectedDay} sélectionné —
        <button
          type="button"
          class="font-semibold text-cn-dark hover:underline"
          onclick={() => (selectedDay = null)}
        >
          Voir tout le mois
        </button>
      </p>
    {/if}
  {/if}
</div>
