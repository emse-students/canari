<script lang="ts">
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { contrastColor } from '$lib/utils/color';
  import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

  let {
    focusDate,
    events = [],
    loading = false,
    selectedDay = $bindable<number | null>(null),
  } = $props<{
    focusDate: Date;
    events: AssociationCalendarFeedEvent[];
    loading?: boolean;
    selectedDay?: number | null;
  }>();

  const weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

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
    while (cells.length % 7 !== 0) cells.push({ day: null, inMonth: false });
    return cells;
  });

  function sameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function isToday(day: number): boolean {
    const today = new Date();
    return sameDay(new Date(focusDate.getFullYear(), focusDate.getMonth(), day), today);
  }

  function eventsOnDay(day: number): AssociationCalendarFeedEvent[] {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return (events as AssociationCalendarFeedEvent[])
      .filter((ev: AssociationCalendarFeedEvent) => sameDay(new Date(ev.startsAt), d))
      .sort(
        (a: AssociationCalendarFeedEvent, b: AssociationCalendarFeedEvent) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
      );
  }

  /** Returns the effective background color for an event block (hex preferred, HSL fallback). */
  function eventBgColor(ev: AssociationCalendarFeedEvent): string {
    return ev.associationColor ?? generateAvatarColor(ev.associationId);
  }

  /**
   * Returns the text color that ensures readability on the given background.
   * Handles both hex (#rrggbb) from user-defined colors and HSL from generateAvatarColor.
   * Auto-generated HSL colors have lightness 45-60% → white text is always safe.
   */
  function eventTextColor(bg: string): string {
    return bg.startsWith('#') ? contrastColor(bg) : '#ffffff';
  }

  /** Days in the current month that have at least one event (for mobile list). */
  const daysWithEvents = $derived.by(() => {
    const lastDay = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 0).getDate();
    const result: { day: number; events: AssociationCalendarFeedEvent[] }[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const dayEvents = eventsOnDay(day);
      if (dayEvents.length > 0) result.push({ day, events: dayEvents });
    }
    return result;
  });

  function formatDayHeader(day: number): string {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(d);
  }

  function formatTime(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso)
    );
  }

  const MAX_VISIBLE = 3;
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <div class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
  </div>
{:else}
  <!-- ── Desktop grid ───────────────────────────────────────────────────── -->
  <div class="hidden sm:block rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 overflow-hidden shadow-sm">
    <!-- Weekday header -->
    <div class="grid grid-cols-7 border-b border-cn-border/60">
      {#each weekdayLabels as w (w)}
        <div class="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          {w}
        </div>
      {/each}
    </div>

    <!-- Day cells -->
    <div class="grid grid-cols-7 divide-x divide-y divide-cn-border/40" role="grid" aria-label="Calendrier du mois">
      {#each calendarCells as cell, i (i)}
        {#if cell.day === null}
          <div
            class="min-h-[90px] bg-cn-bg/30 p-1"
            role="gridcell"
            aria-hidden="true"
          ></div>
        {:else}
          {@const dayEvents = eventsOnDay(cell.day)}
          {@const visible = dayEvents.slice(0, MAX_VISIBLE)}
          {@const extra = dayEvents.length - MAX_VISIBLE}
          {@const selected = selectedDay === cell.day}
          {@const today = isToday(cell.day)}
          <button
            type="button"
            role="gridcell"
            aria-label="{cell.day}{dayEvents.length > 0 ? `, ${dayEvents.length} événement${dayEvents.length > 1 ? 's' : ''}` : ''}"
            aria-selected={selected}
            onclick={() => {
              selectedDay = selectedDay === cell.day ? null : cell.day;
            }}
            class="min-h-[90px] p-1.5 text-left flex flex-col gap-1 transition-colors
              {selected
                ? 'bg-cn-yellow/15'
                : today
                  ? 'bg-cn-bg/60'
                  : 'bg-[var(--cn-surface)]/50 hover:bg-cn-bg/40'}"
          >
            <!-- Day number -->
            <span
              class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold leading-none self-end
                {today
                  ? 'bg-cn-yellow text-cn-dark'
                  : selected
                    ? 'text-cn-dark font-extrabold'
                    : 'text-text-muted'}"
            >
              {cell.day}
            </span>

            <!-- Event blocks -->
            {#each visible as ev (ev.id)}
              {@const bg = eventBgColor(ev)}
              {@const fg = eventTextColor(bg)}
              <span
                class="block w-full truncate rounded px-1.5 py-0.5 text-[10px] font-semibold leading-snug"
                style="background:{bg};color:{fg};"
                title="{ev.title} — {ev.associationName}"
              >
                {ev.title}
              </span>
            {/each}

            {#if extra > 0}
              <span class="text-[10px] font-semibold text-text-muted pl-1">+{extra} autre{extra > 1 ? 's' : ''}</span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>

  <!-- ── Mobile list ───────────────────────────────────────────────────── -->
  <div class="sm:hidden space-y-4">
    {#if daysWithEvents.length === 0}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-8 text-center text-sm text-text-muted">
        Aucun événement ce mois-ci.
      </div>
    {:else}
      {#each daysWithEvents as { day, events: dayEvs } (day)}
        {@const selected = selectedDay === day}
        <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 overflow-hidden shadow-sm">
          <button
            type="button"
            onclick={() => { selectedDay = selected ? null : day; }}
            class="w-full flex items-center justify-between px-4 py-2.5 border-b border-cn-border/50 transition-colors
              {selected ? 'bg-cn-yellow/15' : 'hover:bg-cn-bg/40'}"
          >
            <span class="text-sm font-bold text-text-main capitalize">
              {formatDayHeader(day)}
            </span>
            <span class="text-xs font-semibold text-text-muted">
              {dayEvs.length} événement{dayEvs.length > 1 ? 's' : ''}
            </span>
          </button>
          <ul class="divide-y divide-cn-border/40">
            {#each dayEvs as ev (ev.id)}
              {@const bg = eventBgColor(ev)}
              {@const fg = eventTextColor(bg)}
              <li class="flex items-start gap-3 px-4 py-3">
                <span
                  class="mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style="background:{bg};"
                ></span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-semibold text-text-main truncate">{ev.title}</p>
                  <p class="text-xs text-text-muted">
                    <span
                      class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold mr-1.5"
                      style="background:{bg};color:{fg};"
                    >{ev.associationName}</span>
                    {formatTime(ev.startsAt)}{ev.endsAt ? ` – ${formatTime(ev.endsAt)}` : ''}
                  </p>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}
  </div>
{/if}
