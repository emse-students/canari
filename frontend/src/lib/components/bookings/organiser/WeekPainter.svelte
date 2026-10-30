<script lang="ts">
  import {
    DAY_SLOTS,
    GRAIN_MIN,
    formatRuns,
    modeFrom,
    timeOfMinutes,
    type PaintMode,
    type SelectedRun,
    type WeekRuns,
  } from '$lib/bookings/availabilityPaint';
  import { minutesOf, timeChoices } from '$lib/bookings/availability';
  import Select from '$lib/components/ui/Select.svelte';
  import { Log } from '$lib/utils/Log';
  import { Pencil } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE TYPICAL WEEK, TO PAINT (D49): seven columns, a row per 30 minutes (Q-R11). Press and drag
   * a rectangle: starting on a closed cell OPENS it, starting on an open one CLOSES it - one
   * gesture, no brush to choose. A finger paints at once and the painter does not scroll the page
   * under it (`touch-action: none`), as decided. The open hours are drawn as RUNS, so an edge off the grain (18:45) is drawn where
   * it is, and each run has a pencil for its exact hours. Letting go calls `onPaint`; the parent owns the lines and what they mean.
   */
  interface Props {
    week: WeekRuns;
    /** Monday..Sunday, long, in the reader's language: names a column for a screen reader. */
    dayNames: string[];
    /** Monday..Sunday, short, for the header. */
    shortDayNames: string[];
    onPaint: (dayA: number, dayB: number, slotA: number, slotB: number, mode: PaintMode) => void;
    /** The sentence under the painter when the gesture means something else (fixed slots). */
    hint?: string;
    /** The step the exact-hours pickers sit on (an off-step edge already there is kept). */
    step: number;
    /**
     * The exact hours of a run changed to `[start, end)`; false when the parent could not apply it
     * (it would overlap another slot, or the slot spans two days), which the painter then says.
     */
    onEdit: (run: SelectedRun, start: number, end: number) => boolean;
  }

  let { week, dayNames, shortDayNames, onPaint, hint, step, onEdit }: Props = $props();

  /** The run whose exact hours are being edited (its pencil was pressed), drawn with a ring. */
  let picked = $state<SelectedRun | null>(null);
  /** Said under the run's hours when a change could not be applied, until the next one. */
  let refused = $state<'order' | 'refused' | null>(null);
  /**
   * The drawn run holding the picked hours, with ITS edges: an edit that merged the run with a
   * neighbour is still the picked one (the panel stays), and a paint or a template that removed it
   * leaves nothing selected.
   */
  const selected = $derived.by<SelectedRun | null>(() => {
    if (!picked) return null;
    const run = week[picked.day]?.find(([s, e]) => s <= picked!.start && e >= picked!.end);
    return run ? { day: picked.day, start: run[0], end: run[1] } : null;
  });
  const dayLabel = (day: number) => {
    const name = dayNames[day] ?? '';
    return name.charAt(0).toUpperCase() + name.slice(1);
  };
  const timeOptions = (asEnd: boolean, current: string) =>
    timeChoices(step, asEnd, current).map((t) => ({ value: t, label: t }));

  function select(run: SelectedRun) {
    Log.d('BOOKINGS', `painter run picked day=${run.day} ${run.start}-${run.end}`);
    refused = null;
    picked = run;
  }

  function edit(start: number, end: number) {
    if (!selected || (start === selected.start && end === selected.end)) return;
    // A range that ends before it starts is refused HERE, said aloud, and never reaches the parent.
    const verdict = end <= start ? 'order' : onEdit(selected, start, end) ? null : 'refused';
    refused = verdict;
    if (verdict === null) picked = { day: selected.day, start, end };
    else Log.i('BOOKINGS', `painter run edit refused (${verdict}) ${start}-${end}`);
  }

  interface Drag {
    pointerId: number;
    mode: PaintMode;
    day0: number;
    slot0: number;
    day1: number;
    slot1: number;
  }
  let drag = $state<Drag | null>(null);
  let gridEl = $state<HTMLElement | null>(null);

  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

  /** The day and grain row under a pointer, from the grid's own box. */
  function cellAt(e: PointerEvent): { day: number; slot: number } | null {
    if (!gridEl) return null;
    const box = gridEl.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      day: clamp(Math.floor(((e.clientX - box.left) / box.width) * 7), 6),
      slot: clamp(Math.floor(((e.clientY - box.top) / box.height) * DAY_SLOTS), DAY_SLOTS - 1),
    };
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = cellAt(e);
    if (!hit) return;
    drag = {
      pointerId: e.pointerId,
      mode: modeFrom(week, hit.day, hit.slot),
      day0: hit.day,
      slot0: hit.slot,
      day1: hit.day,
      slot1: hit.slot,
    };
    gridEl?.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const hit = cellAt(e);
    if (hit) drag = { ...drag, day1: hit.day, slot1: hit.slot };
  }

  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const done = drag;
    drag = null;
    onPaint(done.day0, done.day1, done.slot0, done.slot1, done.mode);
  }

  function cancel(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) drag = null;
  }

  /** The rectangle being painted, as percentages of the grid. */
  const preview = $derived(
    drag
      ? {
          left: (Math.min(drag.day0, drag.day1) / 7) * 100,
          width: ((Math.abs(drag.day1 - drag.day0) + 1) / 7) * 100,
          top: (Math.min(drag.slot0, drag.slot1) / DAY_SLOTS) * 100,
          height: ((Math.abs(drag.slot1 - drag.slot0) + 1) / DAY_SLOTS) * 100,
          mode: drag.mode,
        }
      : null
  );

  /** Every second hour is named on the axis. */
  const hourMarks = Array.from({ length: 12 }, (_, i) => i * 2);
  const dayMin = 24 * 60;
  /** The painter's height: tall enough for a finger on a 30 min row, short enough for a screen. */
  const HEIGHT = 'h-[clamp(30rem,80svh,40rem)]';
  /** An hour line (strong) and a half-hour line (faint): the gesture's grain is the half hour. */
  const GRID_LINES = [
    'linear-gradient(to bottom, var(--cn-border) 1px, transparent 1px)',
    'linear-gradient(to bottom, color-mix(in srgb, var(--cn-border) 35%, transparent) 1px, transparent 1px)',
  ].join(', ');
</script>

<div class="border-cn-border bg-cn-surface rounded-2xl border p-2">
  <div class="grid gap-x-1" style:grid-template-columns="2.5rem repeat(7, minmax(0, 1fr))">
    <span></span>
    {#each shortDayNames as name, day (day)}
      <span class="text-text-muted py-1 text-center text-xs font-bold first-letter:uppercase">
        {name}
      </span>
    {/each}
  </div>
  <div class="grid gap-x-1" style:grid-template-columns="2.5rem repeat(7, minmax(0, 1fr))">
    <div class="relative {HEIGHT}" aria-hidden="true">
      {#each hourMarks as hour (hour)}
        <span
          class="text-text-muted absolute right-1 text-xs tabular-nums"
          class:hidden={hour === 0}
          style:top="{(hour / 24) * 100}%"
          style:transform="translateY(-50%)"
        >
          {String(hour).padStart(2, '0')}:00
        </span>
      {/each}
    </div>
    <div
      bind:this={gridEl}
      class="relative col-span-7 grid {HEIGHT} touch-none grid-cols-7 gap-x-1 select-none"
      role="group"
      aria-label={m.bookings_avail_painter_label()}
      data-painter
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={cancel}
    >
      {#each week as runs, day (day)}
        <div
          class="border-cn-border/60 relative rounded-lg border"
          style:background-image={GRID_LINES}
          style:background-size="100% calc(100% / 24), 100% calc(100% / 48)"
          role="group"
          data-day={day}
          aria-label="{dayNames[day]} : {formatRuns(runs) || m.bookings_day_closed()}"
        >
          {#each runs as [start, end], i (i)}
            {@const isSelected =
              selected !== null &&
              selected.day === day &&
              selected.start === start &&
              selected.end === end}
            <div
              class="bg-green-ok/25 border-green-ok/50 absolute inset-x-0 rounded-md border {isSelected
                ? 'ring-cn-yellow ring-2'
                : ''}"
              style:top="{(start / dayMin) * 100}%"
              style:height="{((end - start) / dayMin) * 100}%"
            >
              <!-- The exact and the keyboard's route: a press on the run itself paints, so the
                   run has its own button, which the grid's gesture never sees. -->
              <button
                type="button"
                data-run-edit
                class="ui-icon-button ui-icon-button--sm bg-cn-surface border-cn-border text-text-main absolute top-0 right-0 z-10 rounded border"
                aria-label={m.bookings_avail_run_aria({
                  day: dayLabel(day),
                  from: timeOfMinutes(start),
                  to: timeOfMinutes(end),
                })}
                aria-pressed={isSelected}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => select({ day, start, end })}
              >
                <Pencil size={11} />
              </button>
            </div>
          {/each}
        </div>
      {/each}
      {#if preview}
        <div
          class="pointer-events-none absolute rounded-md border-2 {preview.mode === 'open'
            ? 'bg-cn-yellow/40 border-cn-yellow'
            : 'bg-red-err/15 border-red-err border-dashed'}"
          style:left="{preview.left}%"
          style:width="{preview.width}%"
          style:top="{preview.top}%"
          style:height="{preview.height}%"
        ></div>
      {/if}
    </div>
  </div>
  {#if selected}
    <div
      class="border-cn-border bg-cn-bg mt-2 space-y-3 rounded-xl border p-3"
      data-run-editor
      role="group"
      aria-label={m.bookings_avail_run_edit_title({ day: dayLabel(selected.day) })}
    >
      <p class="text-text-main text-sm font-semibold">
        {m.bookings_avail_run_edit_title({ day: dayLabel(selected.day) })}
      </p>
      <div class="grid grid-cols-2 gap-3">
        <Select
          id="week-painter-run-start"
          label={m.bookings_avail_start()}
          value={timeOfMinutes(selected.start)}
          options={timeOptions(false, timeOfMinutes(selected.start))}
          onValueChange={(v) => edit(minutesOf(v), selected!.end)}
        />
        <Select
          id="week-painter-run-end"
          label={m.bookings_avail_end()}
          value={timeOfMinutes(selected.end)}
          options={timeOptions(true, timeOfMinutes(selected.end))}
          onValueChange={(v) => edit(selected!.start, minutesOf(v))}
        />
      </div>
      {#if refused}
        <p class="text-red-err text-xs" role="alert">
          {refused === 'order' ? m.bookings_avail_problem_order() : m.bookings_avail_run_refused()}
        </p>
      {/if}
      <button
        type="button"
        onclick={() => (picked = null)}
        class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
      >
        {m.bookings_avail_run_close()}
      </button>
    </div>
  {/if}
  <p class="text-text-muted px-1 pt-2 text-xs">
    {hint ?? m.bookings_avail_paint_hint({ grain: GRAIN_MIN })}
  </p>
</div>
