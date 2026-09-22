<script lang="ts">
  /**
   * THE AGENDA ON A PHONE IS A LIST, NOT A GRID - AND IT ROLLS FORWARD FROM TODAY.
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
   * is on that day", not "what started that day" - `groupEventsByDayInRange` owns that rule and the
   * month grid beside it uses the same one.
   *
   * THE SECOND HALF OF THE SAME ARGUMENT LANDED ON 2026-09-20 (user): the list had kept the GRID's
   * unit. It drew one calendar month, so opening the agenda on the 28th meant scrolling past 27
   * days that had already happened, and reaching next week meant finding a month arrow. A month is
   * a constraint of drawing squares; a list has no first or last square. It now starts at TODAY and
   * grows forward on scroll to a stated horizon, which deletes the month header and both arrows -
   * the thumb already does what they did.
   *
   * There is no way BACK, deliberately: the past is a desktop question (user, 2026-09-20), and the
   * reader of a phone agenda is asking what is next. The month name survives as a SEPARATOR rather
   * than a control - in a flow that crosses months, nothing else distinguishes 3 December from
   * 3 January.
   *
   * The grid is not deleted: from `md` up there is room for it and it answers a different question
   * (the shape of the month). This component replaces it only where it does not fit.
   */
  import { CalendarDays } from '@lucide/svelte';
  import { isToday } from '$lib/utils/dates';
  import {
    eventAccentColor,
    eventOwnersLabel,
    formatEventTimeRange,
    groupEventsByDayInRange,
    type EventDayGroup,
  } from '$lib/calendar/feedEvents';
  import {
    ROLLING_HORIZON_MONTHS,
    type AgendaRollingWindow,
  } from '$lib/calendar/agendaMonth.svelte';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  interface Props {
    /** The whole feed; this component takes its own window out of it. */
    events: AssociationCalendarFeedEvent[];
    /** The window being drawn, and the only thing that knows how to grow it. */
    rolling: AgendaRollingWindow;
    /** True while the FIRST chunk is being fetched - later ones show a footer spinner instead. */
    loading?: boolean;
    /**
     * The association whose own agenda this is, if any - its solo events drop the name the page
     * already carries. A shared event still names every association running it.
     */
    ownAssociationId?: string | null;
    onEventClick: (event: AssociationCalendarFeedEvent) => void;
  }

  let { events, rolling, loading = false, ownAssociationId = null, onEventClick }: Props = $props();

  /** One month of the flow: its heading, and the days under it. */
  interface MonthSection {
    /** `2026-09` - stable across appends, so a keyed `{#each}` never re-creates a drawn month. */
    key: string;
    label: string;
    monthStart: Date;
    groups: EventDayGroup[];
  }

  /**
   * The BCP-47 tag BOTH formatters below take.
   *
   * One derivation, because the two halves of a row disagreed: the heading read the locale and the
   * weekday under it was hard-coded `fr-FR`, so an English reader got "September 2026" over a gutter
   * of `lun.` / `mar.`. The heading is the half anybody looks at, which is why it was the only half
   * that was right.
   */
  const localeTag = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');

  const monthFormatter = $derived(
    new Intl.DateTimeFormat(localeTag, { month: 'long', year: 'numeric' })
  );

  /**
   * `lun.`, `mar.` - the reference's gutter, short enough not to widen it.
   *
   * Built once per LOCALE and not once per row: this list draws a year of days, and a
   * `new Intl.DateTimeFormat` inside the markup is one construction per day per render.
   */
  const weekdayFormatter = $derived(new Intl.DateTimeFormat(localeTag, { weekday: 'short' }));

  const groups = $derived(groupEventsByDayInRange(events, rolling.from, rolling.to));

  /**
   * The days cut into months, in order.
   *
   * Built from the groups rather than from the window's bounds: a month with nothing in it has no
   * heading either, which is the same rule the days themselves follow.
   */
  const sections = $derived.by(() => {
    const out: MonthSection[] = [];
    for (const group of groups) {
      const key = `${group.date.getFullYear()}-${String(group.date.getMonth() + 1).padStart(2, '0')}`;
      const last = out.at(-1);
      if (last?.key === key) {
        last.groups.push(group);
        continue;
      }
      const monthStart = new Date(group.date.getFullYear(), group.date.getMonth(), 1);
      out.push({ key, label: monthFormatter.format(monthStart), monthStart, groups: [group] });
    }
    return out;
  });

  /** Nothing at all, and nothing further to ask for - the only state that is genuinely empty. */
  const empty = $derived(
    !loading && sections.length === 0 && rolling.complete && !rolling.loadingMore
  );

  let sectionEls = $state<(HTMLElement | null)[]>([]);
  let sentinel = $state<HTMLElement | null>(null);

  /**
   * WHICH MONTH THE READER IS ON, reported upwards.
   *
   * `focusDate` still decides what the PDF export exports and which month a phone turned sideways
   * gets; with the arrows gone, the scroll position is the only thing that can say. The band is the
   * top 15% of the viewport, and the FIRST section touching it wins - "first" in document order,
   * which is the one nearest the top when two meet at a boundary.
   */
  $effect(() => {
    const els = sections.map((_, i) => sectionEls[i]).filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- observer bookkeeping, never rendered
    const onScreen = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target);
          else onScreen.delete(entry.target);
        }
        const index = els.findIndex((el) => onScreen.has(el));
        if (index >= 0) rolling.setVisibleMonth(sections[index].monthStart);
      },
      { rootMargin: '0px 0px -85% 0px' }
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  });

  /**
   * THE SCROLL THAT ASKS FOR MORE, RE-ARMED AFTER EVERY STEP.
   *
   * An observer reports TRANSITIONS, and appending a chunk below a sentinel that never left the
   * screen is not one - which is how an infinite scroll stops dead on a quiet stretch where three
   * months add no rows at all. Reading `loadingMore` puts this effect on that flip, so each step
   * ends with a fresh observation of the sentinel where it now is. The chain terminates on
   * `complete`, never on a count of attempts.
   */
  $effect(() => {
    const el = sentinel;
    if (!el || rolling.complete || rolling.stalled) return;
    void rolling.loadingMore;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) rolling.loadMore();
      },
      // Early enough that the next chunk is usually there before the reader reaches the end.
      { rootMargin: '400px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

{#if loading}
  <div class="border-cn-border bg-cn-surface rounded-2xl border p-8 text-center">
    <div
      class="border-cn-yellow mx-auto h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else if empty}
  <div
    class="border-cn-border bg-cn-bg/30 text-text-muted rounded-2xl border border-dashed px-4 py-8 text-center text-sm"
  >
    <CalendarDays size={20} class="mx-auto mb-2 opacity-50" />
    {m.calendar_schedule_empty()}
  </div>
{:else}
  <div class="space-y-4">
    {#each sections as section, index (section.key)}
      <!-- NO `overflow-hidden` ANYWHERE ABOVE THE HEADING. An ancestor with a clipped overflow
           becomes the scrollport a `sticky` child sticks inside, and one that cannot scroll simply
           carries the heading off the top - the month label would vanish exactly when it is needed.
           So each month is its own block and the card is the list under the heading, not around it.
           `top-0` is the top of `.page-scroll-wrap`, which starts below the mobile header. -->
      <section bind:this={sectionEls[index]}>
        <h3
          class="bg-cn-bg text-text-muted sticky top-0 z-10 py-2 text-xs font-bold tracking-wide uppercase"
        >
          {section.label}
        </h3>

        <div class="border-cn-border bg-cn-surface rounded-2xl border shadow-sm">
          <ul class="divide-cn-border/40 divide-y">
            {#each section.groups as group (group.date.getTime())}
              {@const today = isToday(group.date)}
              <li class="flex gap-3 px-3 py-3">
                <!-- The date gutter. Fixed width so every day's events start on the same line,
                     which is what makes the list scannable as a column rather than as a ragged
                     edge. -->
                <div class="w-11 shrink-0 text-center">
                  <div
                    class="mx-auto flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold {today
                      ? 'bg-cn-yellow text-cn-ink'
                      : 'text-text-main'}"
                  >
                    {group.day}
                  </div>
                  <div class="text-text-muted text-2xs mt-0.5 lowercase">
                    {weekdayFormatter.format(group.date)}
                  </div>
                </div>

                <ul class="min-w-0 flex-1 space-y-0.5">
                  {#each group.events as event (event.id)}
                    {@const logoSrc = associationLogoSrc(event.associationLogoUrl)}
                    {@const owners = eventOwnersLabel(event, ownAssociationId)}
                    {@const pending = event.status === 'pending'}
                    <li>
                      <!--
                        A PROPOSED EVENT READS AS PROPOSED HERE TOO, IN THE GRID'S OWN VOCABULARY.
                        The month grid has drawn one dimmed and dashed since it existed; this list
                        showed it identical to a validated one, and the user reported exactly that -
                        *"Pas de difference entre un evenement propose et un evenement valide dans
                        la vue planning liste (en mode calendrier il y a des pointilles)"*. The flag
                        was here all along: both views take the same
                        `AssociationCalendarFeedEvent`, and only one read it.

                        The grid dims the coloured BLOCK and dashes its outline. A row's coloured
                        thing is the dot, so the dot becomes a ring drawn in the same dashes rather
                        than a filled disc - the same sentence in the shape this view has. And it is
                        never carried by colour or shape alone: the title attribute says it in
                        words, from the one message both views now use.
                      -->
                      <button
                        type="button"
                        class="hover:bg-cn-bg flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors {pending
                          ? 'opacity-50'
                          : ''}"
                        title={pending
                          ? m.calendar_event_pending_title({ title: event.title })
                          : null}
                        onclick={() => onEventClick(event)}
                      >
                        <span
                          class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                          style={pending
                            ? `border:1.5px dashed ${eventAccentColor(event)};`
                            : `background:${eventAccentColor(event)};`}
                          aria-hidden="true"
                        ></span>
                        <span class="min-w-0 flex-1">
                          <span class="text-text-main block truncate text-sm font-semibold"
                            >{event.title}</span
                          >
                          <span class="text-text-muted mt-0.5 flex items-center gap-1.5 text-xs">
                            <span class="shrink-0 font-medium">{formatEventTimeRange(event)}</span>
                            {#if owners}
                              <span aria-hidden="true">&#183;</span>
                              {#if logoSrc}
                                <img
                                  src={logoSrc}
                                  alt=""
                                  class="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
                                />
                              {/if}
                              <span class="truncate">{owners}</span>
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
      </section>
    {/each}

    <!-- THE FOOT OF THE SCROLL SAYS WHICH OF THE THREE THINGS IS TRUE, because a spinner that never
         resolves and a list that has genuinely ended look identical, and a reader who cannot tell
         them apart keeps pulling at a list that is finished. -->
    {#if rolling.stalled}
      <div class="flex justify-center py-4">
        <button
          type="button"
          onclick={rolling.retry}
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border bg-(--cn-surface) px-4 py-2 text-sm font-bold transition-colors"
        >
          {m.common_retry_button()}
        </button>
      </div>
    {:else if rolling.complete}
      <p class="text-text-muted py-4 text-center text-xs">
        {m.calendar_schedule_horizon_end({ months: ROLLING_HORIZON_MONTHS })}
      </p>
    {:else}
      <div bind:this={sentinel} class="flex justify-center py-4" aria-live="polite">
        <span class="sr-only">{m.calendar_schedule_loading_more()}</span>
        <div
          class="border-cn-yellow h-5 w-5 animate-spin rounded-full border-2 border-t-transparent"
          aria-hidden="true"
        ></div>
      </div>
    {/if}
  </div>
{/if}
