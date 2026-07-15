<script lang="ts">
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { toHex } from '$lib/utils/color';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import { ChevronRight, CalendarDays } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    focusDate: Date;
    selectedDay: number | null;
    events: AssociationCalendarFeedEvent[];
    /** When true, hides association name on each row (single-association agenda). */
    hideAssociationName?: boolean;
    onEventClick: (ev: AssociationCalendarFeedEvent) => void;
    onClearSelection?: () => void;
  }

  let {
    focusDate,
    selectedDay,
    events,
    hideAssociationName = false,
    onEventClick,
    onClearSelection,
  }: Props = $props();

  function eventsOnDay(day: number): AssociationCalendarFeedEvent[] {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return events
      .filter((ev) => {
        const start = new Date(ev.startsAt);
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        if (!ev.endsAt) return d.getTime() === startDay.getTime();
        const end = new Date(ev.endsAt);
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        return d >= startDay && d <= endDay;
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }

  const dayEvents = $derived(selectedDay != null ? eventsOnDay(selectedDay) : []);

  function formatDayLabel(day: number): string {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(focusDate.getFullYear(), focusDate.getMonth(), day));
  }

  function formatTimeRange(ev: AssociationCalendarFeedEvent): string {
    const start = formatTime(ev.startsAt);
    if (!ev.endsAt) return start;
    return `${start} - ${formatTime(ev.endsAt)}`;
  }

  function formatTime(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso)
    );
  }

  function eventAccentColor(ev: AssociationCalendarFeedEvent): string {
    return toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
  }
</script>

{#if selectedDay == null}
  <div
    class="rounded-2xl border border-dashed border-cn-border bg-cn-bg/30 px-4 py-6 text-center text-sm text-text-muted"
  >
    <CalendarDays size={20} class="mx-auto mb-2 opacity-50" />
    {m.calendar_day_select_prompt()}
  </div>
{:else if dayEvents.length === 0}
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 px-4 py-5 text-center text-sm text-text-muted"
  >
    {m.calendar_day_no_events()}
    {#if onClearSelection}
      <button
        type="button"
        class="mt-2 block mx-auto text-sm font-semibold text-cn-dark hover:underline"
        onclick={onClearSelection}
      >
        {m.calendar_day_choose_another()}
      </button>
    {/if}
  </div>
{:else}
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 overflow-hidden shadow-sm"
  >
    <div
      class="flex items-center justify-between gap-2 border-b border-cn-border/60 px-4 py-3 bg-cn-bg/30"
    >
      <p class="text-sm font-bold text-text-main capitalize">
        {formatDayLabel(selectedDay)}
        <span class="text-text-muted font-semibold ml-1">
          · {m.calendar_day_event_count({ count: dayEvents.length })}
        </span>
      </p>
      {#if onClearSelection}
        <button
          type="button"
          class="text-xs font-semibold text-cn-dark hover:underline shrink-0"
          onclick={onClearSelection}
        >
          {m.calendar_day_all_month()}
        </button>
      {/if}
    </div>
    <ul class="divide-y divide-cn-border/40">
      {#each dayEvents as ev (ev.id)}
        {@const accent = eventAccentColor(ev)}
        {@const logoSrc = associationLogoSrc(ev.associationLogoUrl)}
        <li>
          <button
            type="button"
            class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-cn-bg/50 transition-colors"
            onclick={() => onEventClick(ev)}
          >
            <span
              class="h-9 w-1 rounded-full shrink-0"
              style="background:{accent};"
              aria-hidden="true"
            ></span>
            {#if logoSrc && !hideAssociationName}
              <img src={logoSrc} alt="" class="h-8 w-8 rounded-full object-cover shrink-0" />
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-sm font-bold text-text-main truncate">{ev.title}</p>
              <p class="text-xs text-text-muted mt-0.5 truncate">
                {#if !hideAssociationName}
                  <span class="font-semibold">{ev.associationName}</span>
                  <span class="mx-1">·</span>
                {/if}
                {formatTimeRange(ev)}
              </p>
            </div>
            <ChevronRight size={18} class="shrink-0 text-text-muted" />
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
