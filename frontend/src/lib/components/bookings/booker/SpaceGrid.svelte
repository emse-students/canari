<script lang="ts">
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    bookingUnitLimit,
    dragRange,
    formatTimeRange,
    windowRefusal,
    type GridRow,
  } from '$lib/bookings/grid';
  import { localTime } from '$lib/bookings/zonedTime';
  import { columnsHidden } from '$lib/bookings/columns';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE GRID OF ONE DATE (D14): the resources as columns, the units as rows, as the organiser's
   * paper sheet. Every cell is a button with its whole reading as its name; what tapping it does is
   * the page's (`onPick`). A free unit the booking window refuses ON THIS DEVICE'S CLOCK is drawn
   * and named as such, but still opens: the device may be wrong, and the server's answer is the one
   * that counts. A row after the date's midnight (a night window) is marked as the next day.
   *
   * A DRAG PICKS SEVERAL UNITS AT ONCE: press a free unit and drag down or up the same resource's
   * column, and the range follows the pointer, held by `dragRange` to free touching units and to
   * what one booking may cover. A mouse or a pen drags straight away; a finger must HOLD first
   * (a quick drag is the page scrolling, and is left alone), and the page does not scroll while a
   * range is being drawn. Letting go calls `onPick` with the first unit and how many were taken; a
   * plain tap still calls it with one unit.
   */
  interface Props {
    space: BookerSpace;
    resources: BookerResource[];
    rows: GridRow[];
    nowMs: number;
    onPick: (resource: BookerResource, unit: SlotUnit, count?: number) => void;
  }

  let { space, resources, rows, nowMs, onPick }: Props = $props();
  /** One column is the space itself (D44): no column name is drawn. */
  const hideColumns = $derived(columnsHidden(space.name, resources));

  /** How long a finger must rest on a unit before a drag draws a range instead of scrolling. */
  const HOLD_MS = 250;
  /** Finger travel (px) before the hold has elapsed that means "scroll", not "draw". */
  const SCROLL_SLOP_PX = 8;
  /** Pointer travel (px) that turns a mouse press into a drag. */
  const DRAG_SLOP_PX = 4;

  /** The most units one booking may cover; a drag is offered only when that is more than one. */
  const unitLimit = $derived(bookingUnitLimit(space));

  interface Selection {
    column: number;
    anchor: number;
    current: number;
  }
  interface Press {
    pointerId: number;
    column: number;
    row: number;
    x: number;
    y: number;
    touch: boolean;
  }

  /** The range being drawn, if any: where it was pressed and the row the pointer is over now. */
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
    const cells = rows.map((row) => row.cells[current.column]);
    const { first, count } = dragRange(cells, current.anchor, current.current, unitLimit);
    if (count === 0) return null;
    return { column: current.column, first, last: first + count - 1, count, cells };
  });

  /** What the chip over the grid reads while a range is drawn: its hours, on the space's clock. */
  const selectedReading = $derived.by(() => {
    if (!selected) return '';
    const first = selected.cells[selected.first];
    const last = selected.cells[selected.last];
    return first && last ? formatTimeRange(first.startMs, last.endMs, space.timeZone) : '';
  });

  function cellAt(node: EventTarget | null): { row: number; column: number } | null {
    const cell = (node as Element | null)?.closest<HTMLElement>('[data-cell]');
    return cell ? { row: Number(cell.dataset.row), column: Number(cell.dataset.col) } : null;
  }

  function clearPress() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    press = null;
  }

  function beginSelection(from: Press) {
    selection = { column: from.column, anchor: from.row, current: from.row };
    tbodyEl?.setPointerCapture(from.pointerId);
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.button !== 0 || unitLimit < 2) return;
    const hit = cellAt(e.target);
    const unit = hit ? rows[hit.row]?.cells[hit.column] : null;
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
    if (hit && selection && hit.column === selection.column) {
      selection = { ...selection, current: hit.row };
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    const column = press.column;
    const range = selected;
    clearPress();
    // No range was drawn: a plain tap, and the click that follows opens the sheet.
    if (!selection) return;
    selection = null;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const first = range?.cells[range.first];
    if (range && first) onPick(resources[column], first, range.count);
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
  function reading(unit: SlotUnit): { text: string; closed: boolean } {
    if (unit.state === 'booked') {
      const who = unit.booking.mine
        ? m.bookings_cell_mine()
        : (unit.booking.holderName ?? m.bookings_cell_booked());
      return { text: who, closed: false };
    }
    if (unit.state === 'blocked') {
      return { text: unit.blockReason || m.bookings_cell_blocked(), closed: false };
    }
    if (windowRefusal(space, unit.startMs, nowMs) === null) {
      return { text: m.bookings_cell_free(), closed: false };
    }
    return { text: m.bookings_cell_closed(), closed: true };
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
    return reading(a).text === reading(b).text;
  }

  /** The row sits on the hour: only those carry a full time label, the half hours a faint one. */
  function onTheHour(row: GridRow): boolean {
    return localTime(row.startMs, space.timeZone).slice(3, 5) === '00';
  }

  function cellClass(unit: SlotUnit, closed: boolean): string {
    if (unit.state === 'booked') {
      return unit.booking.mine
        ? 'bg-cn-yellow/25 text-text-main border-cn-yellow/60'
        : 'bg-cn-border/40 text-text-main border-cn-border';
    }
    if (unit.state === 'blocked') return 'bg-red-err/10 text-red-err border-red-err/30';
    if (closed) return 'bg-cn-bg text-text-muted/60 border-cn-border/60 hover:bg-cn-border/20';
    return 'bg-green-ok/10 text-green-ok border-green-ok/30 hover:bg-green-ok/20';
  }
</script>

<!-- Wider than a phone when a space has many resources: the TABLE scrolls inside its own box,
     never the page, and the time column stays in view. -->
<div
  class="border-cn-border bg-cn-surface relative overflow-x-auto rounded-2xl border"
  data-swipe-nav-ignore
>
  {#if selected && selectedReading}
    <p
      role="status"
      class="bg-cn-yellow text-cn-ink pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-bold tabular-nums shadow-lg"
    >
      {selectedReading}
    </p>
  {/if}
  <table class="w-full border-separate border-spacing-x-1 border-spacing-y-px text-sm">
    <caption class="sr-only">{m.bookings_grid_caption({ space: space.name })}</caption>
    <thead>
      <tr>
        <th scope="col" class="bg-cn-surface sticky left-0 z-10 w-20 p-2 text-left">
          <span class="sr-only">{m.bookings_grid_time_header()}</span>
        </th>
        {#each resources as resource (resource.id)}
          <!-- The hidden column is the space itself (D44): the caption already names it once. -->
          <th
            scope="col"
            class="text-text-main min-w-28 p-2 text-left text-xs font-bold break-words"
          >
            {#if !hideColumns}{resource.name}{/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody
      bind:this={tbodyEl}
      use:holdScroll
      class="select-none [-webkit-touch-callout:none]"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerCancel}
      oncontextmenu={(e) => press?.touch && e.preventDefault()}
    >
      {#each rows as row, rowIndex (row.key)}
        <tr>
          <th
            scope="row"
            class="bg-cn-surface sticky left-0 z-10 px-2 py-0 text-left text-xs whitespace-nowrap tabular-nums {onTheHour(
              row
            )
              ? 'text-text-muted font-semibold'
              : 'text-text-muted/50 font-normal'}"
          >
            {row.label}
            {#if row.nextDay}
              <span class="block font-normal">{m.bookings_time_next_day()}</span>
            {/if}
          </th>
          {#each row.cells as unit, column (column)}
            {@const resource = resources[column]}
            <td class="p-0">
              {#if unit}
                {@const cell = reading(unit)}
                {@const joinedAbove = sameRun(rows[rowIndex - 1]?.cells[column], unit)}
                {@const joinedBelow = sameRun(unit, rows[rowIndex + 1]?.cells[column])}
                {@const inRange =
                  selected !== null &&
                  selected.column === column &&
                  rowIndex >= selected.first &&
                  rowIndex <= selected.last}
                <button
                  type="button"
                  data-cell
                  data-row={rowIndex}
                  data-col={column}
                  onclick={() => {
                    if (swallowClick) {
                      swallowClick = false;
                      return;
                    }
                    onPick(resource, unit);
                  }}
                  aria-label={m.bookings_cell_label({
                    resource: resource.name,
                    time: row.nextDay ? `${row.label} ${m.bookings_time_next_day()}` : row.label,
                    state: cell.text,
                  })}
                  class="block min-h-8 w-full truncate border px-2 py-1 text-left text-xs font-semibold transition-colors {joinedAbove
                    ? 'rounded-t-none border-t-black/5'
                    : 'rounded-t-lg'} {joinedBelow ? 'rounded-b-none' : 'rounded-b-lg'} {inRange
                    ? 'bg-cn-yellow/40 text-text-main border-cn-yellow'
                    : cellClass(unit, cell.closed)}"
                >
                  {joinedAbove ? '' : cell.text}
                </button>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if unitLimit > 1}
  <p class="text-text-muted text-2xs px-1 pt-1">{m.bookings_grid_drag_hint()}</p>
{/if}
