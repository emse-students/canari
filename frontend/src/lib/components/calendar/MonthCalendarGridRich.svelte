<script lang="ts">
  import { generateAvatarColor, getInitials } from '$lib/utils/avatar';
  import { contrastColor, toHex } from '$lib/utils/color';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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

  const weekdayLabels = $derived(
    Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', { weekday: 'short' })
        .format(new Date(2024, 0, 1 + ((i + 0) % 7)))
        .replace(/\.$/, '')
        .slice(0, 3)
    )
  );

  const calendarCells = $derived.by(() => {
    const y = focusDate.getFullYear();
    const mo = focusDate.getMonth();
    const first = new Date(y, mo, 1);
    const lastDay = new Date(y, mo + 1, 0).getDate();
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

  /** Logos for the event: primary first, then co-owners (resolved src, or null → initials). */
  function eventLogos(ev: AssociationCalendarFeedEvent): { src: string | null; name: string }[] {
    return [
      { src: associationLogoSrc(ev.associationLogoUrl), name: ev.associationName },
      ...(ev.coOwners ?? []).map((co) => ({
        src: associationLogoSrc(co.logoUrl ?? null),
        name: co.name,
      })),
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

  const MAX_VISIBLE = 3;
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <div
      class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
    ></div>
  </div>
{:else}
  <div class="rounded-2xl overflow-hidden shadow-sm border border-cn-border/60">
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
            class="min-h-[72px] sm:min-h-[100px] border-r border-b border-cn-border/40
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
              ? `, ${m.calendar_day_event_count({ count: dayEvents.length })}`
              : ''}"
            aria-selected={selected}
            onclick={() => {
              selectedDay = selectedDay === cell.day ? null : cell.day;
            }}
            class="relative min-h-[72px] sm:min-h-[100px] text-left transition-all border-r border-b border-cn-border/40 overflow-hidden
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
                  {@const logos = eventLogos(ev)}
                  <div
                    class="relative flex-1 flex items-center justify-center overflow-hidden {ev.status ===
                    'pending'
                      ? 'opacity-50'
                      : ''}"
                    style="{eventBgStyle(ev)} color:{fg};{ev.status === 'pending'
                      ? `outline:1.5px dashed ${fg};outline-offset:-2px;`
                      : ''}"
                    title={ev.status === 'pending'
                      ? `${ev.title} - en attente de validation`
                      : `${ev.title} - ${ev.associationName}`}
                  >
                    <!-- Day number on the first slot -->
                    {#if ei === 0}
                      <span
                        class="absolute top-1 left-1.5 text-[10px] font-extrabold leading-none z-10
                          {today ? 'underline decoration-2' : ''}"
                        style="color:{fg};">{cell.day}</span
                      >
                    {/if}
                    <!-- Logo(s) en filigrane : un seul centré, ou une rangée pour les co-portages -->
                    {#if logos.length === 1}
                      {#if logos[0].src}
                        <img
                          src={logos[0].src}
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
                    {:else}
                      <div
                        class="absolute inset-0 flex items-center justify-center gap-1"
                        style="opacity:0.22;"
                        aria-hidden="true"
                      >
                        {#each logos as lg (lg.name)}
                          {#if lg.src}
                            <img
                              src={lg.src}
                              alt=""
                              class="rounded-full object-cover"
                              style="width:30%;height:30%;max-width:30px;max-height:30px;"
                            />
                          {:else}
                            <span
                              class="rounded-full flex items-center justify-center text-[9px] font-black"
                              style="width:26px;height:26px;background:rgba(255,255,255,0.3);color:{fg};"
                              >{getInitials(lg.name)}</span
                            >
                          {/if}
                        {/each}
                      </div>
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
{/if}
