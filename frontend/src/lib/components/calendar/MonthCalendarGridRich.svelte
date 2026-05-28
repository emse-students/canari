<script lang="ts">
  import { generateAvatarColor, getInitials } from '$lib/utils/avatar';
  import { contrastColor, toHex } from '$lib/utils/color';
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
      .filter((ev: AssociationCalendarFeedEvent) => {
        const start = new Date(ev.startsAt);
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        if (!ev.endsAt) return d.getTime() === startDay.getTime();
        const end = new Date(ev.endsAt);
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        return d >= startDay && d <= endDay;
      })
      .sort(
        (a: AssociationCalendarFeedEvent, b: AssociationCalendarFeedEvent) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
      );
  }

  /** Returns all hex colors for the event: primary first, then co-owners. */
  function eventColors(ev: AssociationCalendarFeedEvent): string[] {
    const primary = toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
    return [
      primary,
      ...(ev.coOwners ?? []).map((co) => toHex(co.color ?? generateAvatarColor(co.associationId))),
    ];
  }

  /** Inline CSS background for an event block - solid or split-color gradient. */
  function eventBgStyle(ev: AssociationCalendarFeedEvent): string {
    const colors = eventColors(ev);
    if (colors.length === 1) return `background:${colors[0]};`;
    const pct = 100 / colors.length;
    const stops = colors.flatMap((c, i) => [
      `${c} ${(i * pct).toFixed(1)}%`,
      `${c} ${((i + 1) * pct).toFixed(1)}%`,
    ]);
    return `background:linear-gradient(to right,${stops.join(',')});`;
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
    <div
      class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
    ></div>
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
            class="min-h-[100px] border-r border-b border-cn-border/40
                   {isWeekend(i) ? 'bg-cn-bg/40' : 'bg-[var(--cn-surface)]/30'}"
            role="gridcell"
            aria-hidden="true"
          ></div>
        {:else}
          {@const dayEvents = eventsOnDay(cell.day)}
          {@const nVisible = dayEvents.length > MAX_VISIBLE ? MAX_VISIBLE - 1 : dayEvents.length}
          {@const visible = dayEvents.slice(0, nVisible)}
          {@const overflowCount = dayEvents.length - nVisible}
          {@const selected = selectedDay === cell.day}
          {@const today = isToday(cell.day)}
          <button
            type="button"
            role="gridcell"
            aria-label="{cell.day}{dayEvents.length > 0
              ? `, ${dayEvents.length} événement${dayEvents.length > 1 ? 's' : ''}`
              : ''}"
            aria-selected={selected}
            onclick={() => {
              selectedDay = selectedDay === cell.day ? null : cell.day;
            }}
            class="relative min-h-[100px] text-left transition-all border-r border-b border-cn-border/40 overflow-hidden
              {isWeekend(i) ? 'bg-cn-bg/40' : 'bg-[var(--cn-surface)]/60'}
              {selected ? '' : 'hover:brightness-95'}"
          >
            {#if dayEvents.length === 0}
              <!-- Empty cell: day number only -->
              <span
                class="absolute top-1.5 left-2 text-xs font-bold leading-none
                  {today ? 'text-cn-yellow' : 'text-text-muted/50'}">{cell.day}</span
              >
            {:else}
              <!-- Events fill the entire cell, split equally -->
              <div class="absolute inset-0 flex flex-col">
                {#each visible as ev, ei (ev.id)}
                  {@const colors = eventColors(ev)}
                  {@const fg = contrastColor(colors[0])}
                  <div
                    class="relative flex-1 flex items-center justify-center overflow-hidden"
                    style="{eventBgStyle(ev)} color:{fg};"
                  >
                    <!-- Day number on the first slot -->
                    {#if ei === 0}
                      <span
                        class="absolute top-1 left-1.5 text-[10px] font-extrabold leading-none z-10
                          {today ? 'underline decoration-2' : ''}"
                        style="color:{fg};">{cell.day}</span
                      >
                    {/if}
                    <!-- Circular logo watermark centred in the slot -->
                    {#if ev.associationLogoUrl}
                      <img
                        src={ev.associationLogoUrl}
                        alt=""
                        aria-hidden="true"
                        class="absolute rounded-full object-cover"
                        style="width:62%;height:62%;max-width:52px;max-height:52px;opacity:0.18;left:50%;top:50%;transform:translate(-50%,-50%);"
                      />
                    {:else}
                      <span
                        class="absolute rounded-full flex items-center justify-center text-[11px] font-black opacity-15"
                        style="width:52px;height:52px;background:rgba(255,255,255,0.2);color:{fg};left:50%;top:50%;transform:translate(-50%,-50%);"
                        >{getInitials(ev.associationName)}</span
                      >
                    {/if}
                    <!-- Event title, centred and always on top of watermark -->
                    <span
                      class="relative z-10 text-[10px] font-bold text-center leading-tight px-3 line-clamp-2"
                      title="{ev.title} - {ev.associationName}"
                      style="color:{fg};">{ev.title}</span
                    >
                  </div>
                {/each}

                {#if overflowCount > 0}
                  <div
                    class="flex-1 flex items-center justify-center text-[9px] font-bold text-text-muted bg-cn-bg/80"
                  >
                    +{overflowCount} autre{overflowCount > 1 ? 's' : ''}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Selected ring overlay (always on top) -->
            {#if selected}
              <div
                class="absolute inset-0 ring-inset ring-2 ring-cn-yellow/70 pointer-events-none z-20"
              ></div>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>

  <!-- ── Mobile list ───────────────────────────────────────────────────── -->
  <div class="sm:hidden space-y-3">
    {#if daysWithEvents.length === 0}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-8 text-center text-sm text-text-muted"
      >
        Aucun événement ce mois-ci.
      </div>
    {:else}
      {#each daysWithEvents as { day, events: dayEvs } (day)}
        {@const selected = selectedDay === day}
        {@const today = isToday(day)}
        {@const firstBg = eventColors(dayEvs[0])[0]}
        <div
          class="rounded-2xl border overflow-hidden shadow-sm transition-all
                 {selected ? 'border-cn-yellow/70' : 'border-cn-border'}"
        >
          <!-- Day header with colored left accent -->
          <button
            type="button"
            onclick={() => {
              selectedDay = selected ? null : day;
            }}
            class="w-full flex items-center gap-3 px-4 py-3 border-b transition-colors
                   {selected
              ? 'bg-cn-yellow/10 border-cn-yellow/30'
              : 'bg-[var(--cn-surface)]/90 border-cn-border/50 hover:bg-cn-bg/50'}"
          >
            <span class="h-8 w-1 rounded-full shrink-0" style="background:{firstBg};"></span>
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
              {@const primaryColor = eventColors(ev)[0]}
              {@const fg = contrastColor(primaryColor)}
              {@const coOwnerNames = (ev.coOwners ?? []).map((co) => co.name).filter(Boolean)}
              <li class="flex items-center gap-3 px-4 py-3">
                <span
                  class="h-8 w-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center"
                  style="background:{primaryColor};"
                >
                  {#if ev.associationLogoUrl}
                    <img
                      src={ev.associationLogoUrl}
                      alt=""
                      aria-hidden="true"
                      class="h-8 w-8 object-cover"
                    />
                  {:else}
                    <span class="text-[11px] font-black" style="color:{fg};"
                      >{getInitials(ev.associationName)}</span
                    >
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-bold text-text-main truncate">{ev.title}</p>
                  <p class="text-xs text-text-muted flex items-center gap-1.5 mt-0.5">
                    <span class="font-semibold"
                      >{ev.associationName}{coOwnerNames.length > 0
                        ? ` & ${coOwnerNames.join(', ')}`
                        : ''}</span
                    >
                    <span>·</span>
                    <span
                      >{formatTime(ev.startsAt)}{ev.endsAt
                        ? ` – ${formatTime(ev.endsAt)}`
                        : ''}</span
                    >
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
