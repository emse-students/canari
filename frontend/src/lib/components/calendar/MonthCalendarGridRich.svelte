<script lang="ts">
  import { generateAvatarColor, getInitials } from '$lib/utils/avatar';
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

  const calendarCells = $derived.by(() => {
    const y = focusDate.getFullYear();
    const m = focusDate.getMonth();
    const first = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0).getDate();
    const mondayIndex = (first.getDay() + 6) % 7;
    const cells: { day: number | null }[] = [];
    for (let i = 0; i < mondayIndex; i++) cells.push({ day: null });
    for (let day = 1; day <= lastDay; day++) cells.push({ day });
    while (cells.length % 7 !== 0) cells.push({ day: null });
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
    return sameDay(new Date(focusDate.getFullYear(), focusDate.getMonth(), day), new Date());
  }

  function isWeekend(cellIndex: number): boolean {
    return cellIndex % 7 >= 5;
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

  /** Effective hex/HSL background color for an event block. */
  function eventBg(ev: AssociationCalendarFeedEvent): string {
    return ev.associationColor ?? generateAvatarColor(ev.associationId);
  }

  const daysWithEvents = $derived.by(() => {
    const lastDay = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 0).getDate();
    const result: { day: number; events: AssociationCalendarFeedEvent[] }[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const dayEvs = eventsOnDay(day);
      if (dayEvs.length > 0) result.push({ day, events: dayEvs });
    }
    return result;
  });

  function formatDayHeader(day: number): string {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(focusDate.getFullYear(), focusDate.getMonth(), day));
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
  <div class="hidden sm:block rounded-2xl overflow-hidden shadow-sm border border-cn-border/60">
    <!-- Weekday header -->
    <div class="grid grid-cols-7 bg-[var(--cn-surface)]">
      {#each weekdayLabels as w, wi (w)}
        <div
          class="py-2.5 text-center text-[11px] font-bold uppercase tracking-widest border-b border-cn-border/60
                 {wi >= 5 ? 'text-text-muted/60' : 'text-text-muted'}"
        >
          {w}
        </div>
      {/each}
    </div>

    <!-- Day cells -->
    <div class="grid grid-cols-7" role="grid" aria-label="Calendrier du mois">
      {#each calendarCells as cell, i (i)}
        {#if cell.day === null}
          <div
            class="min-h-[100px] p-1.5 border-r border-b border-cn-border/40
                   {isWeekend(i) ? 'bg-cn-bg/40' : 'bg-[var(--cn-surface)]/30'}"
            role="gridcell"
            aria-hidden="true"
          ></div>
        {:else}
          {@const dayEvents = eventsOnDay(cell.day)}
          {@const visible = dayEvents.slice(0, MAX_VISIBLE)}
          {@const extra = dayEvents.length - MAX_VISIBLE}
          {@const selected = selectedDay === cell.day}
          {@const today = isToday(cell.day)}
          {@const firstBg = dayEvents.length > 0 ? eventBg(dayEvents[0]) : null}
          <button
            type="button"
            role="gridcell"
            aria-label="{cell.day}{dayEvents.length > 0 ? `, ${dayEvents.length} événement${dayEvents.length > 1 ? 's' : ''}` : ''}"
            aria-selected={selected}
            onclick={() => { selectedDay = selectedDay === cell.day ? null : cell.day; }}
            class="relative min-h-[100px] p-1.5 text-left flex flex-col gap-1 transition-all border-r border-b border-cn-border/40
              {isWeekend(i) ? 'bg-cn-bg/40' : 'bg-[var(--cn-surface)]/60'}
              {selected ? 'ring-inset ring-2 ring-cn-yellow/70 bg-cn-yellow/8' : 'hover:bg-cn-bg/60'}"
          >
            <!-- Day number — top left, yellow circle if today -->
            <span
              class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold leading-none self-start
                {today
                  ? 'bg-cn-yellow text-cn-dark shadow-sm'
                  : selected
                    ? 'text-cn-dark font-extrabold'
                    : dayEvents.length > 0
                      ? 'text-text-main'
                      : 'text-text-muted/70'}"
            >
              {cell.day}
            </span>

            <!-- Event blocks -->
            {#each visible as ev (ev.id)}
              {@const bg = eventBg(ev)}
              {@const fg = contrastColor(bg)}
              <span
                class="flex items-center gap-1 w-full overflow-hidden rounded-md text-[10px] font-bold leading-none"
                style="background:{bg};color:{fg};padding:3px 5px;"
                title="{ev.title} — {ev.associationName}"
              >
                {#if ev.associationLogoUrl}
                  <img
                    src={ev.associationLogoUrl}
                    alt=""
                    aria-hidden="true"
                    class="h-3.5 w-3.5 rounded-full object-cover shrink-0 opacity-90"
                  />
                {:else}
                  <span
                    class="h-3.5 w-3.5 rounded-full shrink-0 flex items-center justify-center text-[7px] font-black"
                    style="background:rgba(255,255,255,0.25);color:{fg};"
                  >{getInitials(ev.associationName)}</span>
                {/if}
                <span class="truncate">{ev.title}</span>
              </span>
            {/each}

            {#if extra > 0}
              <span class="text-[9px] font-semibold text-text-muted pl-1">
                +{extra} autre{extra > 1 ? 's' : ''}
              </span>
            {/if}

            <!-- Subtle color accent bar at bottom for days with events -->
            {#if firstBg && dayEvents.length > 0 && !selected}
              <span
                class="absolute bottom-0 left-0 right-0 h-0.5 opacity-40"
                style="background:{firstBg};"
              ></span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>

  <!-- ── Mobile list ───────────────────────────────────────────────────── -->
  <div class="sm:hidden space-y-3">
    {#if daysWithEvents.length === 0}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-8 text-center text-sm text-text-muted">
        Aucun événement ce mois-ci.
      </div>
    {:else}
      {#each daysWithEvents as { day, events: dayEvs } (day)}
        {@const selected = selectedDay === day}
        {@const today = isToday(day)}
        {@const firstBg = eventBg(dayEvs[0])}
        <div
          class="rounded-2xl border overflow-hidden shadow-sm transition-all
                 {selected ? 'border-cn-yellow/70' : 'border-cn-border'}"
        >
          <!-- Day header with colored left accent -->
          <button
            type="button"
            onclick={() => { selectedDay = selected ? null : day; }}
            class="w-full flex items-center gap-3 px-4 py-3 border-b transition-colors
                   {selected ? 'bg-cn-yellow/10 border-cn-yellow/30' : 'bg-[var(--cn-surface)]/90 border-cn-border/50 hover:bg-cn-bg/50'}"
          >
            <span
              class="h-8 w-1 rounded-full shrink-0"
              style="background:{firstBg};"
            ></span>
            <span class="flex-1 text-sm font-bold text-text-main capitalize text-left">
              {today ? '⭐ ' : ''}{formatDayHeader(day)}
            </span>
            <span class="text-xs font-semibold text-text-muted shrink-0">
              {dayEvs.length} év.
            </span>
          </button>

          <!-- Event list -->
          <ul class="divide-y divide-cn-border/30 bg-[var(--cn-surface)]/60">
            {#each dayEvs as ev (ev.id)}
              {@const bg = eventBg(ev)}
              {@const fg = contrastColor(bg)}
              <li class="flex items-center gap-3 px-4 py-3">
                <!-- Color + logo indicator -->
                <span
                  class="h-8 w-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center"
                  style="background:{bg};"
                >
                  {#if ev.associationLogoUrl}
                    <img src={ev.associationLogoUrl} alt="" aria-hidden="true" class="h-8 w-8 object-cover" />
                  {:else}
                    <span class="text-[11px] font-black" style="color:{fg};">{getInitials(ev.associationName)}</span>
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-bold text-text-main truncate">{ev.title}</p>
                  <p class="text-xs text-text-muted flex items-center gap-1.5 mt-0.5">
                    <span class="font-semibold">{ev.associationName}</span>
                    <span>·</span>
                    <span>{formatTime(ev.startsAt)}{ev.endsAt ? ` – ${formatTime(ev.endsAt)}` : ''}</span>
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
