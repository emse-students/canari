<script lang="ts">
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    dragRange,
    formatBookingRange,
    formatDay,
    formatDayHead,
    formatTimeRange,
    firstUsefulMin,
    formatTimeRangeParts,
    gridUnitLimit,
    isOfferedStart,
    unitText,
    isPastUnit,
    type DayColumn,
    type WeekLayout,
  } from '$lib/bookings/grid';
  import {
    blockDensity,
    buildRuns,
    cutRange,
    edgeScrollDirection,
    spanOf,
    stackedLines,
    type GridRun,
    type RunKind,
    type StackedLines,
  } from '$lib/bookings/gridRuns';
  import HolderAvatar from '$lib/components/bookings/booker/HolderAvatar.svelte';
  import { onMount } from 'svelte';
  import { gridDragHint } from '$lib/bookings/gridHint';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WEEK OF ONE COLUMN (D46): the days as columns, as the agenda's week, each unit placed on a
   * shared hour axis. It is the grid from `md` up; a phone draws the same week as a planning list
   * (`PlanningList`, D55). A day with nothing offered folds to a narrow strip (Q-R10). Every unit is a button with its whole reading as its name;
   * what tapping it does is the page's (`onPick`). A free unit the booking window refuses now (over,
   * too soon, too far, not open yet) is drawn greyed and DISABLED on the booker's grid: it is not
   * offered, so no sheet opens on it. Should the server still refuse at the send, its typed refusal
   * is said in plain words.
   *
   * THE EYE SEES BLOCKS, THE HAND SEES UNITS. A booking, a stretch of free time, a not-bookable
   * stretch, a block and the range being drawn are each ONE rounded block spanning their units
   * (`gridRuns.ts`); the hour lines stay faint behind them. A booking or a block is one button. Free
   * time is drawn by a quiet block that takes no pointer, over which every free unit keeps its own
   * invisible button, so a press, a tap or a drag still lands on the step under the pointer and the
   * keyboard still walks the units. A block that is too short for its text says less (name and
   * range, then avatar and range, then the avatar alone) and the whole reading stays in its tooltip
   * and its accessible name. A block too NARROW for a row (a week column, or one of two lanes, under
   * about 7rem) stacks instead: avatar, then name, then the hours, each truncated, and under about
   * 5rem the hours take two lines (start, then end). Height still decides how many of those lines
   * exist, so text is dropped only when it cannot fit at all, never because the block is narrow. The avatar is the initials placeholder: the server sends a booker's
   * name and, exactly where it sends the name, their id (`holderId`), which the shared `Avatar` turns into
   * their photo; where the name is hidden the block shows an anonymous icon ([bookings-chantier]).
   *
   * THE AXIS IS THE WHOLE DAY AND ONE HOUR HEIGHT (`HOUR_REM`), whatever the week holds: the booker
   * is never told the space's availability rules, so no hour can be proven unbookable here, and an
   * axis drawn from the week's units would change shape from week to week and jump on a booking.
   * The grid scrolls inside a capped box (the day's header sticks) and opens on the first hour a
   * booker may take, once, when it appears.
   *
   * A DRAG PICKS SEVERAL UNITS AT ONCE: press a free unit and drag down or up the same DAY, and the
   * range follows the pointer, held by `dragRange` to free touching units and to what one booking
   * may cover. A mouse or a pen drags straight away; a finger must HOLD first (a quick drag is the
   * page scrolling, and is left alone), and the page does not scroll while a range is being drawn.
   * Letting go calls `onPick` with the first unit and how many were taken; a plain tap still calls
   * it with one unit.
   *
   * IN BLOCK MODE (the organiser's dashboard, WP-R5, D50) the same drag draws an "Indisponible"
   * instead: red, in slots mode too, and as long as a block may be (`BLOCK_LENGTH_CHOICES`) rather
   * than a booking. It still stops at the first unit that is not free, so it never crosses a
   * booking; the server answers `bookings-inside-block` if the grid was stale.
   */
  interface Props {
    space: BookerSpace;
    /** The column drawn: a space with several columns shows one at a time. */
    resource: BookerResource;
    layout: WeekLayout;
    /** The organiser's dashboard: a drag draws a block, not a booking (WP-R5). */
    blockMode?: boolean;
    nowMs: number;
    /**
     * The LATEST start the server refused as `started` or `notice` while the device's clock still
     * took it. Both refusals only grow with time, so every start at or before it is refused too and
     * is never offered again; `null` while none was refused.
     */
    lastRefusedStart?: number | null;
    /**
     * The grid's vertical scroll, kept by the PARENT: a week with nothing offered unmounts the grid,
     * and the reader must come back to where they were. `null` = never opened: it opens on the first
     * useful hour (`firstUsefulMin`).
     */
    scrollTop?: number | null;
    onPick: (resource: BookerResource, unit: SlotUnit, count?: number) => void;
  }

  let {
    space,
    resource,
    layout,
    blockMode = false,
    nowMs,
    lastRefusedStart = null,
    scrollTop = $bindable(null),
    onPick,
  }: Props = $props();

  /** Whether the reader's primary pointer is a finger: the drag hint names only the gesture that applies. */
  let coarse = $state(isCoarsePointerDevice());
  /** The scrolling box of the grid. */
  let scroller = $state<HTMLElement | null>(null);
  onMount(() => {
    if (scroller) {
      if (scrollTop !== null) {
        // Back from a week that unmounted the grid: the reader's place, not the opening hour.
        scroller.scrollTop = scrollTop;
      } else {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const at = remOf(firstUsefulMin(layout, space, nowMs, blockMode) - layout.startMin);
        // The box opens half a rem above the first useful hour, so that hour's unit is not under the top edge.
        scroller.scrollTop = Math.max(0, (at - 0.5) * rem);
        scrollTop = scroller.scrollTop;
      }
    }
    coarse = isCoarsePointerDevice();
    const stopWatching = onCoarsePointerChange((value) => (coarse = value));
    return () => {
      stopWatching();
      if (edgeFrame !== null) cancelAnimationFrame(edgeFrame);
    };
  });

  /** How long a finger must rest on a unit before a drag draws a range instead of scrolling. */
  const HOLD_MS = 250;
  /** Finger travel (px) before the hold has elapsed that means "scroll", not "draw". */
  const SCROLL_SLOP_PX = 8;
  /** Within this distance (px) of the scrolling box's top or bottom a drag scrolls the box. */
  const EDGE_PX = 32;
  /** How far (px) the box scrolls per pointer move while a drag is at its edge. */
  const EDGE_STEP_PX = 12;
  /** Pointer travel (px) that turns a mouse press into a drag. */
  const DRAG_SLOP_PX = 4;

  /**
   * The most units one gesture may cover - a booking's, or in block mode a block's; a drag is
   * offered only when that is more than one.
   */
  const unitLimit = $derived(gridUnitLimit(space, blockMode));

  interface Selection {
    day: number;
    anchor: number;
    current: number;
  }
  interface Press {
    pointerId: number;
    day: number;
    idx: number;
    x: number;
    y: number;
    touch: boolean;
  }

  /** The range being drawn, if any: where it was pressed and the unit the pointer is over now. */
  let selection = $state<Selection | null>(null);
  let tbodyEl = $state<HTMLElement | null>(null);
  // Imperative gesture state, read only in the pointer handlers.
  let press: Press | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a drag ended on a unit, so the click that may follow is not a second pick. */
  let swallowClick = false;

  /** The drawn range, as `dragRange` clamps it, with the cells it was computed on. */
  const selected = $derived.by(() => {
    const current = selection;
    if (!current) return null;
    const cells = layout.days[current.day]?.cells ?? [];
    // Only a range's START is judged by the booking window, as the server does: a unit AFTER the
    // anchor joins the range whatever the window says of it as a start, and a unit BEFORE the
    // anchor would become the start, so it must be offered.
    const walk = cells.map((c, i) => (i > current.anchor || offered(c) ? c : null));
    const { first, count } = dragRange(walk, current.anchor, current.current, unitLimit);
    if (count === 0) return null;
    return { day: current.day, first, last: first + count - 1, count, cells };
  });

  /** What the chip over the grid reads while a range is drawn: its hours, on the space's clock. */
  const selectedReading = $derived.by(() => {
    if (!selected) return '';
    const first = selected.cells[selected.first];
    const last = selected.cells[selected.last];
    return first && last ? formatTimeRange(first.startMs, last.endMs, space.timeZone) : '';
  });

  function cellAt(node: EventTarget | null): { day: number; idx: number } | null {
    const cell = (node as Element | null)?.closest<HTMLElement>('[data-cell]');
    return cell ? { day: Number(cell.dataset.day), idx: Number(cell.dataset.idx) } : null;
  }

  function clearPress() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    press = null;
  }

  function beginSelection(from: Press) {
    selection = { day: from.day, anchor: from.idx, current: from.idx };
    tbodyEl?.setPointerCapture(from.pointerId);
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.button !== 0 || unitLimit < 2) return;
    const hit = cellAt(e.target);
    const unit = hit ? layout.days[hit.day]?.cells[hit.idx] : null;
    if (!hit || !unit || unit.state !== 'free' || !offered(unit)) return;
    clearPress();
    swallowClick = false;
    const touch = e.pointerType === 'touch';
    const started: Press = { pointerId: e.pointerId, ...hit, x: e.clientX, y: e.clientY, touch };
    press = started;
    if (touch) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (press === started) beginSelection(started);
      }, HOLD_MS);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!selection) {
      const travelled = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (press.touch) {
        // Moved before the hold elapsed: the reader is scrolling the page, not drawing a range.
        if (travelled > SCROLL_SLOP_PX) clearPress();
        return;
      }
      if (travelled <= DRAG_SLOP_PX) return;
      beginSelection(press);
    }
    followEdge(e.clientX, e.clientY);
    selectAt(e.clientX, e.clientY);
  }

  /** The unit under the pointer joins the range (the pointer is captured, so found by position). */
  function selectAt(x: number, y: number) {
    const hit = cellAt(document.elementFromPoint(x, y));
    if (hit && selection && hit.day === selection.day) {
      selection = { ...selection, current: hit.idx };
    }
  }

  let edgeDirection: -1 | 0 | 1 = 0;
  let edgeAt = { x: 0, y: 0 };
  let edgeFrame: number | null = null;

  /**
   * A range drawn at the top or bottom edge of the scrolling box carries the box with it, and keeps
   * doing so while the pointer is HELD there (a frame loop that ends when the pointer leaves the
   * edge or the range ends), so a range can start at the edge and still reach the units beyond it.
   */
  function followEdge(x: number, y: number) {
    edgeAt = { x, y };
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    edgeDirection = edgeScrollDirection(y, box, window.innerHeight, EDGE_PX);
    if (edgeDirection !== 0 && edgeFrame === null) edgeFrame = requestAnimationFrame(edgeStep);
  }

  function edgeStep() {
    edgeFrame = null;
    if (!selection || edgeDirection === 0 || !scroller) return;
    scroller.scrollTop += edgeDirection * EDGE_STEP_PX;
    selectAt(edgeAt.x, edgeAt.y);
    edgeFrame = requestAnimationFrame(edgeStep);
  }

  function handlePointerUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    const range = selected;
    clearPress();
    // No range was drawn: a plain tap, and the click that follows opens the sheet.
    if (!selection) return;
    selection = null;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const first = range?.cells[range.first];
    if (range && first) onPick(resource, first, range.count);
  }

  function handlePointerCancel(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    clearPress();
    selection = null;
  }

  /** The page must not scroll under a finger that is drawing a range; the listener cannot be passive to say so. */
  function holdScroll(node: HTMLElement) {
    const stop = (e: TouchEvent) => {
      if (selection) e.preventDefault();
    };
    node.addEventListener('touchmove', stop, { passive: false });
    return { destroy: () => node.removeEventListener('touchmove', stop) };
  }

  /**
   * Whether tapping a unit does anything: a taken unit always opens its reading, a free one only
   * where `isOfferedStart` says (the booking window for a booker; a block that has not begun for
   * the organiser). One that cannot
   * be booked now is drawn greyed and is not a control at all.
   */
  function offered(unit: SlotUnit): boolean {
    return unit.state !== 'free' || isOfferedStart(space, unit, nowMs, lastRefusedStart, blockMode);
  }

  /** Whether a booking may START at this unit now: the booking window takes it, and the server has not refused it, or a later start, as a start. */
  function bookableStart(unit: SlotUnit): boolean {
    return isOfferedStart(space, unit, nowMs, lastRefusedStart, false);
  }

  /** What a cell says, and whether the booking window refuses it now. */
  function reading(unit: SlotUnit): { text: string; closed: boolean; past: boolean } {
    const bookable = unit.state !== 'free' || bookableStart(unit);
    const text = unitText(unit, bookable);
    // A free unit already over keeps its name for a screen reader but is not written in the cell.
    return { text, closed: !bookable, past: !bookable && isPastUnit(unit, nowMs) };
  }

  /** What a unit is, for the eye: the booking window and the device's clock decide free from closed. */
  function kindOf(unit: SlotUnit): RunKind {
    if (unit.state === 'booked') return 'booked';
    if (unit.state === 'blocked') return 'blocked';
    const { closed, past } = reading(unit);
    return past ? 'past' : closed ? 'closed' : 'free';
  }

  /** Each day's runs; a space of fixed slots keeps its free slots apart (a slot is booked whole). */
  const dayRuns = $derived(
    layout.days.map((d) => buildRuns(d.placed, kindOf, space.slotMode === 'slots'))
  );

  /** The runs of one day with the range being drawn cut out of them. */
  function runsOfDay(dayIndex: number): GridRun[] {
    const runs = dayRuns[dayIndex] ?? [];
    return selected && selected.day === dayIndex
      ? cutRange(runs, layout.days[dayIndex].placed, selected.first, selected.last)
      : runs;
  }

  /** A run's reading: what it says, its hours in the space's zone, and the full accessible name. */
  function runReading(run: GridRun) {
    const unit = run.units[0];
    const text = reading(unit).text;
    const time = formatTimeRange(run.startMs, run.endMs, space.timeZone);
    const timeParts = formatTimeRangeParts(run.startMs, run.endMs, space.timeZone);
    const label = m.bookings_cell_label({
      resource: resource.name,
      time: formatBookingRange(run.startMs, run.endMs, space.timeZone),
      state: text,
    });
    const holder = unit.state === 'booked' ? unit.booking.holderName : undefined;
    const holderId = unit.state === 'booked' ? unit.booking.holderId : undefined;
    return {
      text,
      time,
      timeParts,
      label,
      holder,
      holderId,
      mine: unit.state === 'booked' && unit.booking.mine,
    };
  }

  /** Place a block on its day column, in its lane. */
  function boxStyle(top: number, height: number, lane: number, lanes: number): string {
    return `top:${remOf(top - layout.startMin)}rem;height:${remOf(height)}rem;left:${(lane / lanes) * 100}%;width:${100 / lanes}%`;
  }

  /** The shared axis: its whole hours, as the labels down the left. */
  const hours = $derived.by(() => {
    const out: number[] = [];
    for (let min = layout.startMin; min < layout.endMin; min += 60) out.push(min);
    return out;
  });
  const bodyRem = $derived(((layout.endMin - layout.startMin) / 60) * layout.remPerHour);
  const remOf = (min: number) => (min * layout.remPerHour) / 60;
  const hourLabel = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:00`;
  const folded = (day: DayColumn) => day.state === 'closed';
  /** Open days share the width, a folded one is a strip; an open day never gets narrower than a label. */
  const columns = $derived(
    `3rem ${layout.days.map((d) => (folded(d) ? '2.25rem' : 'minmax(4.25rem, 1fr)')).join(' ')}`
  );
</script>

<!-- The week scrolls inside its own box, never the page, and the hour axis stays in view (sticky). -->
<div
  class="border-cn-border bg-cn-surface relative max-h-[75dvh] overflow-auto rounded-2xl border"
  data-swipe-nav-ignore
  bind:this={scroller}
  onscroll={() => scroller && (scrollTop = scroller.scrollTop)}
>
  {#if selected && selectedReading}
    <p
      role="status"
      class="{blockMode
        ? 'bg-red-err text-cn-surface'
        : 'bg-cn-yellow text-cn-ink'} pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-bold tabular-nums shadow-lg"
    >
      {selectedReading}
    </p>
  {/if}
  <div role="group" aria-label={m.bookings_grid_caption({ space: space.name })}>
    <div
      class="bg-cn-surface sticky top-0 z-20 grid gap-x-1 pe-1"
      style:grid-template-columns={columns}
    >
      <span class="bg-cn-surface sticky left-0 z-10"></span>
      {#each layout.days as day (day.date)}
        {@const head = formatDayHead(day.date)}
        <div
          class="text-text-muted py-2 text-center text-xs leading-tight font-bold"
          aria-label={folded(day)
            ? `${formatDay(day.date)} : ${m.bookings_day_closed()}`
            : formatDay(day.date)}
        >
          <span class="block first-letter:uppercase">{head.weekday}</span>
          <span class="text-text-main text-sm">{head.num}</span>
        </div>
      {/each}
    </div>
    <div
      class="grid gap-x-1 pe-1 select-none [-webkit-touch-callout:none]"
      style:grid-template-columns={columns}
      bind:this={tbodyEl}
      use:holdScroll
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerCancel}
      oncontextmenu={(e) => press?.touch && e.preventDefault()}
      role="presentation"
    >
      <div class="bg-cn-surface sticky left-0 z-10" style:height="{bodyRem}rem" aria-hidden="true">
        {#each hours as min (min)}
          <span
            class="text-text-muted absolute right-1 -translate-y-1/2 text-xs tabular-nums"
            style:top="{remOf(min - layout.startMin)}rem"
            class:hidden={min === layout.startMin}
          >
            {hourLabel(min)}
          </span>
        {/each}
      </div>
      {#each layout.days as day, dayIndex (day.date)}
        <div
          class="relative"
          style:height="{bodyRem}rem"
          style:background-image={folded(day)
            ? 'none'
            : 'linear-gradient(to bottom, color-mix(in srgb, var(--cn-border) 55%, transparent) 1px, transparent 1px)'}
          style:background-size="100% {remOf(60)}rem"
          role="group"
          aria-label={formatDay(day.date)}
        >
          {#if folded(day)}
            <div class="bg-cn-border/20 absolute inset-0 rounded-lg" aria-hidden="true"></div>
          {/if}
          {#each runsOfDay(dayIndex) as run (`${run.startMs}-${run.endMs}-${run.lane}`)}
            {@const r = runReading(run)}
            {@const density = blockDensity(remOf(run.heightMin))}
            {#if run.kind === 'booked' || run.kind === 'blocked'}
              <!-- No `disabled` guard: `offered` is always true for a booked or blocked unit. -->
              <button
                type="button"
                onclick={() => onPick(resource, run.units[0])}
                aria-label={r.label}
                title={r.label}
                style={boxStyle(run.topMin, run.heightMin, run.lane, run.lanes)}
                class="group absolute z-10 block p-px text-left outline-none"
              >
                <span
                  class="group-focus-visible:ring-cn-yellow @container block h-full overflow-hidden rounded-lg border px-1.5 py-0.5 text-xs leading-tight group-focus-visible:ring-2 motion-safe:transition-colors {run.kind ===
                  'blocked'
                    ? 'bg-red-err/10 text-red-err border-red-err/30'
                    : r.mine
                      ? 'bg-cn-yellow/25 text-text-main border-cn-yellow/60 group-hover:bg-cn-yellow/35'
                      : 'bg-control-fill text-text-main border-cn-border group-hover:bg-control-fill/70'}"
                >
                  {#if run.kind === 'blocked'}
                    <span class="block truncate font-semibold">{r.text}</span>
                    {#if density === 'full'}
                      <span class="text-2xs block truncate opacity-80">{r.time}</span>
                    {/if}
                  {:else}
                    {@render bookingFace(
                      r,
                      density,
                      stackedLines(remOf(run.heightMin)),
                      run.units[0]
                    )}
                  {/if}
                </span>
              </button>
            {:else}
              <div
                aria-hidden="true"
                style={boxStyle(run.topMin, run.heightMin, run.lane, run.lanes)}
                class="pointer-events-none absolute block p-px"
              >
                <span
                  class="block h-full overflow-hidden rounded-lg px-1.5 py-1 text-xs leading-tight {run.kind ===
                  'free'
                    ? blockMode
                      ? ''
                      : 'bg-green-ok/10 text-green-ok'
                    : run.kind === 'closed'
                      ? blockMode
                        ? 'bg-control-fill/50'
                        : 'bg-cn-bg/60 text-text-muted'
                      : blockMode
                        ? 'bg-control-fill/50'
                        : 'bg-cn-bg/40'}"
                  style:background-image={run.kind === 'closed' && !blockMode
                    ? 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--cn-border) 70%, transparent) 0 1px, transparent 1px 0.5rem)'
                    : undefined}
                >
                  {#if !blockMode && (run.kind === 'free' || run.kind === 'closed') && density !== 'icon'}
                    <span class="block truncate font-semibold">{r.text}</span>
                    {#if density === 'full' && run.kind === 'free'}
                      <span class="text-text-muted text-2xs block truncate">{r.time}</span>
                    {/if}
                  {/if}
                </span>
              </div>
            {/if}
          {/each}
          {#if selected && selected.day === dayIndex}
            {@const box = spanOf(day.placed, selected.first, selected.last)}
            <div
              aria-hidden="true"
              style={boxStyle(box.topMin, box.heightMin, box.lane, box.lanes)}
              class="pointer-events-none absolute z-20 block p-px"
            >
              <span
                data-selection
                class="block h-full overflow-hidden rounded-lg border px-1.5 py-1 text-xs leading-tight font-bold shadow-sm motion-safe:transition-colors {blockMode
                  ? 'bg-red-err/20 text-red-err border-red-err'
                  : 'bg-cn-yellow text-cn-ink border-cn-yellow'}"
              >
                <span class="block truncate tabular-nums">{selectedReading}</span>
              </span>
            </div>
          {/if}
          {#each day.placed as placed, idx (`${placed.unit.startMs}-${placed.unit.endMs}-${placed.lane}`)}
            {@const unit = placed.unit}
            {#if unit.state === 'free'}
              <button
                type="button"
                data-cell
                data-day={dayIndex}
                data-idx={idx}
                disabled={!offered(unit)}
                onclick={() => {
                  if (swallowClick) {
                    swallowClick = false;
                    return;
                  }
                  onPick(resource, unit);
                }}
                aria-label={m.bookings_cell_label({
                  resource: resource.name,
                  time: formatBookingRange(unit.startMs, unit.endMs, space.timeZone),
                  state: reading(unit).text,
                })}
                title={formatTimeRange(unit.startMs, unit.endMs, space.timeZone)}
                style={boxStyle(placed.topMin, placed.heightMin, placed.lane, placed.lanes)}
                class="focus-visible:ring-cn-yellow absolute z-10 block cursor-pointer rounded-lg outline-none focus-visible:ring-2 disabled:cursor-default motion-safe:transition-colors {blockMode
                  ? 'hover:bg-red-err/10'
                  : 'hover:bg-green-ok/20'}"
              ></button>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<!-- The dashboard says its drag above the grid (manage page), where it is read first. -->
{#if unitLimit > 1 && !blockMode}
  <p class="text-text-muted text-2xs px-1 pt-1">
    {gridDragHint(blockMode, coarse)}
  </p>
{/if}

{#snippet bookingFace(
  r: {
    text: string;
    time: string;
    timeParts: { start: string; end: string };
    holder: string | undefined;
    holderId: string | undefined;
  },
  density: 'full' | 'line' | 'icon',
  stacked: StackedLines,
  unit: SlotUnit
)}
  <!-- Wide (the container holds 7rem): avatar and text in a row. Narrower: the same, stacked. -->
  <span class="flex flex-col items-start gap-1 @min-[7rem]:flex-row @min-[7rem]:gap-1.5">
    <HolderAvatar {unit} />
    {#if density === 'full'}
      <span class="w-full min-w-0 flex-1">
        <span class="block truncate font-semibold">{r.text}</span>
        <!-- One line of hours, or two (start, end) where the block is under 5rem wide. -->
        <span
          class="text-text-muted text-2xs block truncate {stacked >= 3
            ? '@max-[5rem]:hidden'
            : stacked === 2
              ? ''
              : '@max-[7rem]:hidden'}">{r.time}</span
        >
        {#if stacked >= 3}
          <span class="text-text-muted text-2xs hidden @max-[5rem]:block" data-time-split>
            <span class="block truncate">{r.timeParts.start}</span>
            <span class="block truncate">{r.timeParts.end}</span>
          </span>
        {/if}
      </span>
    {:else if density === 'line'}
      <span class="hidden min-w-0 flex-1 @min-[7rem]:block">
        <span class="text-text-muted block truncate font-semibold tabular-nums">{r.time}</span>
      </span>
    {/if}
  </span>
{/snippet}
