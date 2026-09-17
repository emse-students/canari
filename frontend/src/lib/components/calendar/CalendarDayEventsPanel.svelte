<script lang="ts">
  import {
    eventAccentColor,
    eventsOnDay as eventsOnDayOf,
    formatEventTimeRange,
  } from '$lib/calendar/feedEvents';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import { eventOwnersLabel } from '$lib/calendar/feedEvents';
  import { ChevronRight, CalendarDays } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    focusDate: Date;
    selectedDay: number | null;
    events: AssociationCalendarFeedEvent[];
    /**
     * The association whose own agenda this is, if any: its rows drop the name and logo it would
     * only repeat. A row it merely CO-OWNS belongs to someone else and still names its owner -
     * the page is not the owner of everything it lists.
     */
    ownAssociationId?: string | null;
    onEventClick: (ev: AssociationCalendarFeedEvent) => void;
  }

  let { focusDate, selectedDay, events, ownAssociationId = null, onEventClick }: Props = $props();

  // Which day an event occupies, and how its time reads, are shared with the phone's schedule list:
  // two copies of "does this multi-day event cover this day" is two chances to disagree.
  const dayEvents = $derived(
    selectedDay != null ? eventsOnDayOf(events, focusDate, selectedDay) : []
  );

  function formatDayLabel(day: number): string {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(focusDate.getFullYear(), focusDate.getMonth(), day));
  }
</script>

{#if selectedDay == null}
  <div
    class="border-cn-border bg-cn-bg/30 text-text-muted rounded-2xl border border-dashed px-4 py-6 text-center text-sm"
  >
    <CalendarDays size={20} class="mx-auto mb-2 opacity-50" />
    {m.calendar_day_select_prompt()}
  </div>
{:else if dayEvents.length === 0}
  <div
    class="border-cn-border text-text-muted bg-cn-surface rounded-2xl border px-4 py-5 text-center text-sm"
  >
    {m.calendar_day_no_events()}
  </div>
{:else}
  <div class="border-cn-border bg-cn-surface overflow-hidden rounded-2xl border shadow-sm">
    <div
      class="border-cn-border/60 bg-cn-bg/30 flex items-center justify-between gap-2 border-b px-4 py-3"
    >
      <p class="text-text-main text-sm font-bold capitalize">
        {formatDayLabel(selectedDay)}
        <span class="text-text-muted ml-1 font-semibold">
          · {m.calendar_day_event_count({ count: dayEvents.length })}
        </span>
      </p>
    </div>
    <ul class="divide-cn-border/40 divide-y">
      {#each dayEvents as ev (ev.id)}
        {@const accent = eventAccentColor(ev)}
        {@const logoSrc = associationLogoSrc(ev.associationLogoUrl)}
        {@const owners = eventOwnersLabel(ev, ownAssociationId)}
        {@const pending = ev.status === 'pending'}
        <li>
          <!--
            THE SAME SENTENCE THE GRID DRAWS, BECAUSE THIS IS THE SCREEN RIGHT AFTER IT. A reader
            taps a day in the month grid, where a proposed event is dimmed and dashed, and lands
            here - which said nothing about it until 2026-09-17. `status` was on the event the whole
            time; this view simply never read it. The accent bar takes the dashes because it is this
            row's coloured thing, and the title attribute says it in words so the distinction is
            never carried by colour or shape alone.
          -->
          <button
            type="button"
            class="hover:bg-cn-bg flex w-full items-center gap-3 px-4 py-3 text-left transition-colors {pending
              ? 'opacity-50'
              : ''}"
            title={pending ? m.calendar_event_pending_title({ title: ev.title }) : null}
            onclick={() => onEventClick(ev)}
          >
            <span
              class="h-9 w-1 shrink-0 rounded-full"
              style={pending ? `border:1.5px dashed ${accent};` : `background:${accent};`}
              aria-hidden="true"
            ></span>
            {#if logoSrc && owners}
              <img src={logoSrc} alt="" class="h-8 w-8 shrink-0 rounded-full object-cover" />
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-text-main truncate text-sm font-bold">{ev.title}</p>
              <p class="text-text-muted mt-0.5 truncate text-xs">
                {#if owners}
                  <span class="font-semibold">{owners}</span>
                  <span class="mx-1">·</span>
                {/if}
                {formatEventTimeRange(ev)}
              </p>
            </div>
            <ChevronRight size={18} class="text-text-muted shrink-0" />
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
