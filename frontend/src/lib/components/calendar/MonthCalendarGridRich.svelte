<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import { contrastColor, toHex } from '$lib/utils/color';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import {
    DAY_NUM_H,
    EVENT_TITLE_LINE_HEIGHT,
    daySlotLayout,
    fitEventText,
    splitLogoBands,
  } from '$lib/utils/calendarExport';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { associationAccentHex } from '$lib/associations/accent';
  import {
    breaksOnDay as breaksOnDayOf,
    dayOccupancy,
    eventCardsOnDay,
    eventOwners,
  } from '$lib/calendar/feedEvents';
  import { localizedWeekdays, monthGridDays } from '$lib/calendar/monthGrid';
  import { isToday } from '$lib/utils/dates';

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

  /**
   * The header row, asked of the same helper the PDF export asks - so a header cannot read "lun" on
   * screen and "Lun" on the sheet this grid is a preview of, which it did until 2026-09-16.
   */
  const weekdayLabels = $derived(localizedWeekdays(getLocale(), 'short'));

  /**
   * The month's own name, capitalised - "Septembre".
   *
   * THE SAME DECISION THE PDF EXPORT MAKES (`calendarExport.ts`, `monthLabel`): the month alone,
   * no year, `Intl` in the active locale. The year is not missing - it belongs to the navigation
   * control in the rail beside this grid, while this band is the SHEET'S title, and the export is
   * exactly what the user asked this view to read like.
   */
  const monthLabel = $derived(
    new Intl.DateTimeFormat(getLocale(), { month: 'long' })
      .format(focusDate)
      .replace(/^\w/, (c) => c.toUpperCase())
  );

  /**
   * The month's squares, asked of `monthGrid` rather than built here - the seven lines that padded
   * a month to whole weeks existed in this component AND in the PDF export.
   */
  const calendarCells = $derived(monthGridDays(focusDate));

  /** Whether square `day` of the focused month is today - `utils/dates` owns the comparison. */
  function isTodaySquare(day: number): boolean {
    return isToday(new Date(focusDate.getFullYear(), focusDate.getMonth(), day));
  }

  function isWeekend(cellIndex: number): boolean {
    return cellIndex % 7 >= 5;
  }

  /**
   * The event cards for `day` - breaks excluded, they render as a background band.
   *
   * Asked of `feedEvents` rather than computed here. A private copy split the month at MIDNIGHT and
   * survived the 05:00 boundary landing on 2026-09-16, so this grid went on drawing a 23:00-02:00
   * evening on two squares while the day panel beside it drew one.
   */
  function eventsOnDay(day: number): AssociationCalendarFeedEvent[] {
    return eventCardsOnDay(events as AssociationCalendarFeedEvent[], focusDate, day);
  }

  /** Break entries (no-course / vacation) overlapping `day`, drawn as a full-day background band. */
  function breaksOnDay(day: number): AssociationCalendarFeedEvent[] {
    return breaksOnDayOf(events as AssociationCalendarFeedEvent[], focusDate, day);
  }

  /**
   * How this cell divides, asked of the rule the PDF export uses.
   *
   * Not computed here: a cell that halves on screen and fills on the sheet would be two designs,
   * and the whole reason this grid mirrors `calendarExport` is that it is meant to be printable.
   */
  function cellLayout(
    visible: AssociationCalendarFeedEvent[],
    overflowCount: number,
    square: Date
  ) {
    return daySlotLayout(
      visible.map((ev) => dayOccupancy(ev, square)),
      overflowCount
    );
  }

  /** Returns all hex colors for the event: primary first, then co-owners. */
  function eventColors(ev: AssociationCalendarFeedEvent): string[] {
    return eventOwners(ev).map((owner) =>
      associationAccentHex({ id: owner.associationId, color: owner.color })
    );
  }

  /**
   * Logos for the event: primary first, then co-owners (resolved src, or null → initials).
   * Index-aligned with `eventColors`, which is what lets one band list carry both.
   */
  function eventLogos(
    ev: AssociationCalendarFeedEvent
  ): { associationId: string; src: string | null; name: string }[] {
    return eventOwners(ev).map((owner) => ({
      associationId: owner.associationId,
      src: associationLogoSrc(owner.logoUrl),
      name: owner.name,
    }));
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

  /**
   * The day cell's height in pixels, and THE ONE PLACE IT IS STATED.
   *
   * It is an inline `min-height` rather than a `min-h-32` utility because the slot arithmetic below
   * needs the very same number: a Tailwind class and a JavaScript constant would be two statements
   * of one fact, free to drift the day either moves - and a drift here is silent, showing up only
   * as titles that no longer fit the boxes they were sized for.
   *
   * ONE value and no breakpoint: this component renders only above `SCHEDULE_AGENDA_QUERY`
   * (767.98px), below which `/calendar` shows `CalendarScheduleList` instead. The `sm:` variant the
   * cells used to carry could therefore never NOT apply.
   *
   * 128px against a cell 127px wide, where the export gives a 154px cell 123px. Taller than the
   * sheet's proportion on purpose - the user asked for height, and for the same legibility.
   */
  const CELL_H = 128;

  /**
   * The floor the screen imposes on the shared fitter, and the reason is written in `app.css`:
   * `--text-2xs` is 12px and nothing in this app goes below it. The sheet's own floor is 9px.
   */
  const SCREEN_MIN_FONT = 12;

  /**
   * The two type-scale steps the fitter can land on once it may not go below 12px.
   *
   * Emitting the TOKEN rather than the number keeps this grid on the scale `app.css` defines: a
   * literal `font-size:13px` would be a fourteenth hard-coded size of exactly the kind #447
   * removed, even though it happens to equal `--text-xs` today.
   */
  function fontToken(px: number): string {
    return px >= 13 ? 'var(--text-xs)' : 'var(--text-2xs)';
  }
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <div
      class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else}
  <div class="border-cn-border/60 overflow-hidden rounded-2xl border shadow-sm">
    <!-- Month title band, taken from the export's header (`calendarExport.ts`: 88px tall, the brand
         face, centred). A sheet states the month it shows; leaving that to the navigation control
         alone is what made this grid read as a widget rather than as the calendar it prints to. -->
    <div class="border-cn-border/60 bg-cn-surface border-b px-4 py-3 text-center sm:py-4">
      <h2 class="text-text-main text-xl font-bold sm:text-2xl">{monthLabel}</h2>
    </div>

    <!-- Weekday header -->
    <div class="grid grid-cols-7 bg-(--cn-surface)">
      {#each weekdayLabels as w, wi (w)}
        <div
          class="border-cn-border/60 text-2xs border-b py-2.5 text-center font-bold tracking-widest uppercase
 {wi >= 5 ? 'text-text-muted/60' : 'text-text-muted'}"
        >
          {w}
        </div>
      {/each}
    </div>

    <!-- Day cells -->
    <div class="grid grid-cols-7" role="grid" aria-label={m.calendar_month_grid_label()}>
      {#each calendarCells as day, i (i)}
        {#if day === null}
          <div
            class="border-cn-border/40 border-r border-b {isWeekend(i)
              ? 'bg-cn-bg'
              : 'bg-cn-surface'}"
            style="min-height:{CELL_H}px;"
            role="gridcell"
            aria-hidden="true"
          ></div>
        {:else}
          {@const dayEvents = eventsOnDay(day)}
          {@const dayBreaks = breaksOnDay(day)}
          {@const nVisible = dayEvents.length > MAX_VISIBLE ? MAX_VISIBLE - 1 : dayEvents.length}
          {@const visible = dayEvents.slice(0, nVisible)}
          {@const overflowCount = dayEvents.length - nVisible}
          <!-- The slot height the titles are fitted to, computed exactly as the export computes it
               (`CELL_H / nSlots`, floored). The "+N autres" row is a slot and is counted, and a
               lone event splits the cell in two - `daySlotLayout` decides both. -->
          {@const square = new Date(focusDate.getFullYear(), focusDate.getMonth(), day)}
          {@const layout = cellLayout(visible, overflowCount, square)}
          {@const slotH = Math.floor(CELL_H / (layout.nSlots || 1))}
          {@const loneSlot =
            visible.length === 1 && overflowCount === 0 && layout.nSlots === 2
              ? layout.slotOf[0]
              : null}
          {@const selected = selectedDay === day}
          {@const today = isTodaySquare(day)}
          <button
            type="button"
            role="gridcell"
            aria-label="{day}{dayEvents.length > 0
              ? `, ${m.calendar_day_event_count({ count: dayEvents.length })}`
              : ''}"
            aria-selected={selected}
            onclick={() => {
              selectedDay = selectedDay === day ? null : day;
            }}
            style="min-height:{CELL_H}px;"
            class="border-cn-border/40 relative overflow-hidden border-r border-b text-left transition-all {isWeekend(
              i
            )
              ? 'bg-cn-bg'
              : 'bg-cn-surface'} {selected ? '' : 'hover:brightness-95'}"
          >
            <!-- Break (vacation / no-course) background tint - behind everything so a period reads
                 across days; the title shows as a bottom band and on empty days below. -->
            {#if dayBreaks.length > 0}
              <div
                class="pointer-events-none absolute inset-0 z-0"
                style="background:{eventColors(dayBreaks[0])[0]};opacity:0.14;"
              ></div>
            {/if}

            {#if dayEvents.length === 0}
              <!-- Empty cell: day number, plus the break title when this is a vacation day. -->
              <span
                class="absolute top-1.5 left-2 z-10 text-xs leading-none font-bold
 {today ? 'text-cn-yellow' : 'text-text-muted/50'}">{day}</span
              >
              {#if dayBreaks.length > 0}
                <span
                  class="text-2xs absolute inset-x-1 bottom-1 z-10 line-clamp-2 text-center leading-tight font-bold"
                  style="color:{eventColors(dayBreaks[0])[0]};"
                  title={dayBreaks[0].title}>{dayBreaks[0].title}</span
                >
              {/if}
            {:else}
              <!-- Events fill the entire cell, split equally - except a lone event, which takes
                   the half its start hour names and leaves the other as background. -->
              <div class="absolute inset-0 flex flex-col">
                {#if loneSlot === 1}
                  <!-- The morning half of a day whose only event is in the afternoon. It is empty,
                       so it is where the day number goes: the number always belongs to the FIRST
                       slot, and that slot is no longer guaranteed to hold an event. -->
                  <div class="relative flex-1">
                    <span
                      class="absolute top-1.5 left-2 text-xs leading-none font-bold
 {today ? 'text-cn-yellow' : 'text-text-muted/50'}">{day}</span
                    >
                  </div>
                {/if}
                {#each visible as ev, ei (ev.id)}
                  {@const colors = eventColors(ev)}
                  {@const fg = contrastColor(colors[0])}
                  {@const logos = eventLogos(ev)}
                  <!-- The first slot spends `DAY_NUM_H` on the day number, so its title has that
                       much less height to fit into - the export's own arithmetic. -->
                  {@const fit = fitEventText(
                    ei === 0 && loneSlot !== 1 ? slotH - DAY_NUM_H : slotH,
                    SCREEN_MIN_FONT
                  )}
                  <div
                    class="relative flex flex-1 flex-col overflow-hidden {ev.status === 'pending'
                      ? 'opacity-50'
                      : ''}"
                    style="{eventBgStyle(ev)} color:{fg};{ev.status === 'pending'
                      ? `outline:1.5px dashed ${fg};outline-offset:-2px;`
                      : ''}"
                    title={ev.status === 'pending'
                      ? `${ev.title} - en attente de validation`
                      : `${ev.title} - ${ev.associationName}`}
                  >
                    <!-- Day number on the first slot, IN ITS OWN ROW rather than pinned to the
                         corner. The export does exactly this (`calendarExport.ts`, `DAY_NUM_H = 20`
                         above a `flex:1` title), and the reason is the one this view walked into: a
                         corner span is invisible to the centred title beside it, so at 182px cells
                         the two merely happened not to meet, and once the month moved beside a rail
                         and the cell became 128px a long title ran straight over the number - "29"
                         read as "2". A row the title cannot enter removes the overlap by
                         construction, where the `px-5` inset it replaces only reserved slack. -->
                    {#if ei === 0 && loneSlot !== 1}
                      <div class="relative z-10 shrink-0 pt-1 pl-1.5" style="height:{DAY_NUM_H}px;">
                        <span
                          class="text-2xs leading-none font-bold {today
                            ? 'underline decoration-2'
                            : ''}"
                          style="color:{fg};">{day}</span
                        >
                      </div>
                    {/if}
                    <!-- Logo watermark: one centred circle, or that same circle split into one band
                         per owner for a co-owned event. Never a row of small separate logos. -->
                    {#if logos.length === 1}
                      <!-- Sized off the slot HEIGHT alone, like the export's `slotH * 0.62`. Two
                           percentages resolve against different axes, so `width:62%;height:62%` was
                           only square by accident: on the usual slot, wider than it is tall, it
                           rendered as a rounded rectangle instead of the circle the export draws. -->
                      {#if logos[0].src}
                        <img
                          src={logos[0].src}
                          alt=""
                          aria-hidden="true"
                          class="absolute rounded-full object-cover"
                          style="height:62%;aspect-ratio:1;max-height:52px;opacity:0.18;left:50%;top:50%;transform:translate(-50%,-50%);"
                        />
                      {:else}
                        <span
                          class="text-2xs absolute flex items-center justify-center rounded-full font-bold opacity-15"
                          style="height:62%;aspect-ratio:1;max-height:52px;background:rgba(255,255,255,0.2);color:{fg};left:50%;top:50%;transform:translate(-50%,-50%);"
                          >{getInitials(ev.associationName)}</span
                        >
                      {/if}
                    {:else}
                      {@const bands = splitLogoBands(logos.length)}
                      <!-- ONE circle, one band per owner, cut from the same geometry the PDF export
                           uses (splitLogoBands) so the screen and the export agree. `aspect-ratio`
                           rather than a percentage width: the two percentages resolve against
                           different axes, so on a slot shorter than it is wide the circle would
                           flatten into an ellipse. -->
                      <div
                        class="absolute overflow-hidden rounded-full"
                        style="height:62%;aspect-ratio:1;max-height:52px;opacity:0.22;left:50%;top:50%;transform:translate(-50%,-50%);"
                        aria-hidden="true"
                      >
                        {#each logos as lg, i (lg.associationId)}
                          <div
                            class="absolute top-0 h-full overflow-hidden"
                            style="left:{bands[i].leftPct}%;width:{bands[i].widthPct}%;"
                          >
                            {#if lg.src}
                              <!-- max-width:none is load-bearing: Tailwind Preflight's
                                   `img { max-width: 100% }` would clamp this to its BAND instead of
                                   the circle, pushing every band after the first entirely outside
                                   its own window - a right half that paints nothing. -->
                              <img
                                src={lg.src}
                                alt=""
                                class="absolute top-0 h-full max-w-none object-cover"
                                style="left:{bands[i].imgLeftPct}%;width:{bands[i].imgWidthPct}%;"
                              />
                            {:else}
                              <!-- No logo for this owner: its band keeps its place and shows the
                                   initials, so a missing logo never lets a sibling take the whole
                                   circle - which is what disguised the defect on the export. -->
                              <span
                                class="text-2xs flex h-full w-full items-center justify-center font-bold"
                                style="background:rgba(255,255,255,0.3);color:{fg};"
                                >{getInitials(lg.name)}</span
                              >
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                    <!-- Event title, centred in whatever the day number left and always above the
                         watermark.
                         THE CLAMP IS COMPUTED, NOT WRITTEN: `line-clamp-2` was a guess about how
                         much room a slot has, and on a day with three events it is wrong - the
                         slot is 42px, the number takes 20, and two lines want 30. The span then
                         overflowed its centred row in both directions and painted over the day
                         number, which is how "29" still read as "2" after the number got a row of
                         its own. `fitEventText` asks the height instead of assuming it. -->
                    <div
                      class="relative z-10 flex min-h-0 flex-1 items-center justify-center"
                      style="padding:0 {fit.ph}px 2px;"
                    >
                      <span
                        class="text-center font-bold"
                        title="{ev.title} - {ev.associationName}"
                        style="color:{fg};font-size:{fontToken(
                          fit.fontSize
                        )};line-height:{EVENT_TITLE_LINE_HEIGHT};{fit.clampCss}">{ev.title}</span
                      >
                    </div>
                  </div>
                {/each}

                {#if loneSlot === 0}
                  <!-- The afternoon half of a day whose only event is in the morning. -->
                  <div class="flex-1"></div>
                {/if}

                {#if overflowCount > 0}
                  <div
                    class="text-text-muted bg-cn-bg text-2xs flex flex-1 items-center justify-center font-bold"
                  >
                    <!-- The export's own key, and the wording is already identical: this cell was
                         the one place spelling "+N autres" as a French literal in code, which an
                         English reader saw untranslated. -->
                    {m.calendar_export_more_events({ count: overflowCount })}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Break band: a colored strip along the bottom edge, continuous across a period. -->
            {#if dayBreaks.length > 0}
              <div
                class="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-1"
                style="background:{eventColors(dayBreaks[0])[0]};"
              ></div>
            {/if}

            <!-- Selected ring overlay (always on top) -->
            {#if selected}
              <div
                class="ring-cn-yellow/70 pointer-events-none absolute inset-0 z-20 ring-2 ring-inset"
              ></div>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}
