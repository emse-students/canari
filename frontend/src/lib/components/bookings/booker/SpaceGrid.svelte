<script lang="ts">
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    BLOCK_LENGTH_CHOICES,
    bookingUnitLimit,
    dragRange,
    formatBookingRange,
    formatDay,
    formatDayHead,
    formatTimeRange,
    isPastUnit,
    windowRefusal,
    type DayColumn,
    type WeekLayout,
  } from '$lib/bookings/grid';
  import { localTime } from '$lib/bookings/zonedTime';
  import { onMount } from 'svelte';
  import { gridDragHint } from '$lib/bookings/gridHint';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WEEK OF ONE COLUMN (D46, D48): the days as columns, as the agenda's week, each unit placed
   * on a shared hour axis; on a phone the same component draws ONE day. A day with nothing offered
   * folds to a narrow strip (Q-R10). Every unit is a button with its whole reading as its name;
   * what tapping it does is the page's (`onPick`). A free unit the booking window refuses ON THIS
   * DEVICE'S CLOCK is drawn and named as such, but still opens: the device may be wrong, and the
   * server's answer is the one that counts.
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
    /** `day` draws one column without its axis header and never folds it (the phone). */
    mode: 'week' | 'day';
    /** The organiser's dashboard: a drag draws a block, not a booking (WP-R5). */
    blockMode?: boolean;
    nowMs: number;
    onPick: (resource: BookerResource, unit: SlotUnit, count?: number) => void;
  }

  let { space, resource, layout, mode, blockMode = false, nowMs, onPick }: Props = $props();

  /** Whether the reader's primary pointer is a finger: the drag hint names only the gesture that applies. */
  let coarse = $state(isCoarsePointerDevice());
  onMount(() => {
    coarse = isCoarsePointerDevice();
    return onCoarsePointerChange((value) => (coarse = value));
  });

  /** How long a finger must rest on a unit before a drag draws a range instead of scrolling. */
  const HOLD_MS = 250;
  /** Finger travel (px) before the hold has elapsed that means "scroll", not "draw". */
  const SCROLL_SLOP_PX = 8;
  /** Pointer travel (px) that turns a mouse press into a drag. */
  const DRAG_SLOP_PX = 4;

  /**
   * The most units one gesture may cover - a booking's, or in block mode a block's; a drag is
   * offered only when that is more than one.
   */
  const unitLimit = $derived(blockMode ? BLOCK_LENGTH_CHOICES : bookingUnitLimit(space));

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
    const { first, count } = dragRange(cells, current.anchor, current.current, unitLimit);
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
    if (!hit || !unit || unit.state !== 'free') return;
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
    // The pointer is captured, so the unit under it is found by position, not by event target.
    const hit = cellAt(document.elementFromPoint(e.clientX, e.clientY));
    if (hit && selection && hit.day === selection.day) {
      selection = { ...selection, current: hit.idx };
    }
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

  /** What a cell says, and whether the device's clock puts it outside the booking window. */
  function reading(unit: SlotUnit): { text: string; closed: boolean; past: boolean } {
    if (unit.state === 'booked') {
      const who = unit.booking.mine
        ? m.bookings_cell_mine()
        : (unit.booking.holderName ?? m.bookings_cell_booked());
      return { text: who, closed: false, past: false };
    }
    if (unit.state === 'blocked') {
      return { text: unit.blockReason || m.bookings_cell_blocked(), closed: false, past: false };
    }
    if (windowRefusal(space, unit.startMs, nowMs) === null) {
      return { text: m.bookings_cell_free(), closed: false, past: false };
    }
    // A free unit already over keeps its name for a screen reader but is not written in the cell.
    return { text: m.bookings_cell_closed(), closed: true, past: isPastUnit(unit, nowMs) };
  }

  /**
   * Two units that read as ONE thing on the grid: touching free units the device's clock treats the
   * same way, touching blocked units, or the units of one booking. A run is drawn as a single block
   * (rounded only at its ends, its label said once) while every unit stays its own button, so a
   * press or a drag still lands on the step under the pointer.
   */
  function sameRun(a: SlotUnit | null | undefined, b: SlotUnit | null | undefined): boolean {
    if (!a || !b || a.endMs !== b.startMs || a.state !== b.state) return false;
    if (a.state === 'booked' && b.state === 'booked') return a.booking.id === b.booking.id;
    const [ra, rb] = [reading(a), reading(b)];
    return ra.text === rb.text && ra.past === rb.past;
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
  const folded = (day: DayColumn) => mode === 'week' && day.state === 'closed';
  /** Open days share the width, a folded one is a strip; an open day never gets narrower than a label. */
  const columns = $derived(
    `3rem ${layout.days.map((d) => (folded(d) ? '2.25rem' : 'minmax(5.5rem, 1fr)')).join(' ')}`
  );

  /** A slot is booked whole, so its start is what names it; a step's start is the row's. */
  function unitText(unit: SlotUnit, text: string): string {
    return space.slotMode === 'slots'
      ? `${localTime(unit.startMs, space.timeZone)} - ${text}`
      : text;
  }

  function cellClass(unit: SlotUnit, closed: boolean, past: boolean): string {
    if (unit.state === 'booked') {
      return unit.booking.mine
        ? 'bg-cn-yellow/25 text-text-main border-cn-yellow/60'
        : 'bg-cn-border/40 text-text-main border-cn-border';
    }
    if (unit.state === 'blocked') return 'bg-red-err/10 text-red-err border-red-err/30';
    if (past) return 'bg-cn-bg/50 text-text-muted/40 border-cn-border/30';
    if (closed) return 'bg-cn-bg text-text-muted/60 border-cn-border/60 hover:bg-cn-border/20';
    return 'bg-green-ok/10 text-green-ok border-green-ok/30 hover:bg-green-ok/20';
  }
</script>

<!-- The week scrolls inside its own box, never the page, and the hour axis stays in view (sticky). -->
<div
  class="border-cn-border bg-cn-surface relative overflow-x-auto rounded-2xl border"
  data-swipe-nav-ignore
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
    {#if mode === 'week'}
      <div class="grid gap-x-1 pe-1" style:grid-template-columns={columns}>
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
    {/if}
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
            : 'linear-gradient(to bottom, var(--cn-border) 1px, transparent 1px)'}
          style:background-size="100% {remOf(60)}rem"
          role="group"
          aria-label={formatDay(day.date)}
        >
          {#if folded(day)}
            <div class="bg-cn-border/20 absolute inset-0 rounded-lg" aria-hidden="true"></div>
          {/if}
          {#each day.placed as placed, idx (`${placed.unit.startMs}-${placed.unit.endMs}`)}
            {@const unit = placed.unit}
            {@const cell = reading(unit)}
            {@const joinedAbove = sameRun(day.cells[idx - 1], unit)}
            {@const joinedBelow = sameRun(unit, day.cells[idx + 1])}
            {@const inRange =
              selected !== null &&
              selected.day === dayIndex &&
              idx >= selected.first &&
              idx <= selected.last}
            <button
              type="button"
              data-cell
              data-day={dayIndex}
              data-idx={idx}
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
                state: cell.text,
              })}
              style:top="{remOf(placed.topMin - layout.startMin)}rem"
              style:height="{remOf(placed.heightMin)}rem"
              style:left="{(placed.lane / placed.lanes) * 100}%"
              style:width="{100 / placed.lanes}%"
              class="absolute block overflow-hidden border px-1.5 py-0.5 text-left text-xs leading-tight font-semibold transition-colors {joinedAbove
                ? 'rounded-t-none border-t-black/5'
                : 'rounded-t-lg'} {joinedBelow ? 'rounded-b-none' : 'rounded-b-lg'} {inRange
                ? blockMode
                  ? 'bg-red-err/20 text-red-err border-red-err'
                  : 'bg-cn-yellow/40 text-text-main border-cn-yellow'
                : cellClass(unit, cell.closed, cell.past)}"
            >
              {joinedAbove || cell.past ? '' : unitText(unit, cell.text)}
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

{#if unitLimit > 1}
  <p class="text-text-muted text-2xs px-1 pt-1">
    {gridDragHint(blockMode, coarse)}
  </p>
{/if}
