<script lang="ts">
  /**
   * THE AGENDA ON A PHONE IS A LIST, NOT A GRID.
   *
   * A month grid gives every day the same square whether it holds nothing or four events, so on a
   * 393px screen each cell is about 48px wide and can show a coloured dot and no words. Seven of
   * those columns spend the whole screen saying which days exist - something a reader already knows
   * - and none of it on what is happening. The user asked for the reference's answer instead
   * (2026-09-09): *"sur mobile, on devrait avoir la liste des evenements sous forme de planning au
   * lieu de la grille"*.
   *
   * So this is a schedule: one row per event, days that have no events are not drawn at all, and
   * the date sits in a narrow gutter on the left that repeats only when the day changes. A
   * multi-day event appears on each of its days, because the question a reader is asking is "what
   * is on that day", not "what started that day" - `groupMonthEventsByDay` owns that rule and the
   * month grid beside it uses the same one.
   *
   * The grid is not deleted: from `md` up there is room for it and it answers a different question
   * (the shape of the month). This component replaces it only where it does not fit.
   */
  import { CalendarDays } from '@lucide/svelte';
  import { isToday } from '$lib/utils/dates';
  import {
    eventAccentColor,
    formatEventTimeRange,
    groupMonthEventsByDay,
  } from '$lib/calendar/feedEvents';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Any date in the month to show. */
    focusDate: Date;
    /** The whole feed; this component takes the focused month out of it itself. */
    events: AssociationCalendarFeedEvent[];
    /** True while the feed is still being fetched. */
    loading?: boolean;
    /** Hides the association name on each row (a single-association agenda). */
    hideAssociationName?: boolean;
    onEventClick: (event: AssociationCalendarFeedEvent) => void;
  }

  let {
    focusDate,
    events,
    loading = false,
    hideAssociationName = false,
    onEventClick,
  }: Props = $props();

  const groups = $derived(groupMonthEventsByDay(events, focusDate));

  /** `lun.`, `mar.` - the reference's gutter, short enough not to widen it. */
  function weekdayLabel(date: Date): string {
    return new Intl.DateTimeFormat('fr-FR', { weekday: 'short' }).format(date);
  }
</script>

{#if loading}
  <div class="border-cn-border bg-cn-surface rounded-2xl border p-8 text-center">
    <div
      class="border-cn-yellow mx-auto h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else if groups.length === 0}
  <div
    class="border-cn-border bg-cn-bg/30 text-text-muted rounded-2xl border border-dashed px-4 py-8 text-center text-sm"
  >
    <CalendarDays size={20} class="mx-auto mb-2 opacity-50" />
    {m.calendar_empty()}
  </div>
{:else}
  <div class="border-cn-border bg-cn-surface overflow-hidden rounded-2xl border shadow-sm">
    <ul class="divide-cn-border/40 divide-y">
      {#each groups as group (group.day)}
        {@const today = isToday(group.date)}
        <li class="flex gap-3 px-3 py-3">
          <!-- The date gutter. Fixed width so every day's events start on the same line, which is
               what makes the list scannable as a column rather than as a ragged edge. -->
          <div class="w-11 shrink-0 text-center">
            <div
              class="mx-auto flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold {today
                ? 'bg-cn-yellow text-cn-ink'
                : 'text-text-main'}"
            >
              {group.day}
            </div>
            <div class="text-text-muted text-2xs mt-0.5 lowercase">
              {weekdayLabel(group.date)}
            </div>
          </div>

          <ul class="min-w-0 flex-1 space-y-0.5">
            {#each group.events as event (event.id)}
              {@const logoSrc = associationLogoSrc(event.associationLogoUrl)}
              <li>
                <button
                  type="button"
                  class="hover:bg-cn-bg flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors"
                  onclick={() => onEventClick(event)}
                >
                  <span
                    class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style="background:{eventAccentColor(event)};"
                    aria-hidden="true"
                  ></span>
                  <span class="min-w-0 flex-1">
                    <span class="text-text-main block truncate text-sm font-semibold"
                      >{event.title}</span
                    >
                    <span class="text-text-muted mt-0.5 flex items-center gap-1.5 text-xs">
                      <span class="shrink-0 font-medium">{formatEventTimeRange(event)}</span>
                      {#if !hideAssociationName}
                        <span aria-hidden="true">&#183;</span>
                        {#if logoSrc}
                          <img
                            src={logoSrc}
                            alt=""
                            class="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
                          />
                        {/if}
                        <span class="truncate">{event.associationName}</span>
                      {/if}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  </div>
{/if}
