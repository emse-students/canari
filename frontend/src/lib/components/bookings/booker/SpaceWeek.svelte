<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import SpaceGrid from '$lib/components/bookings/booker/SpaceGrid.svelte';
  import ColumnSelect from '$lib/components/bookings/booker/ColumnSelect.svelte';
  import DayStrip from '$lib/components/bookings/booker/DayStrip.svelte';
  import WeekBar from '$lib/components/bookings/booker/WeekBar.svelte';
  import BookingSheet from '$lib/components/bookings/booker/BookingSheet.svelte';
  import BlockSheet from '$lib/components/bookings/booker/BlockSheet.svelte';
  import UnitDetailSheet from '$lib/components/bookings/booker/UnitDetailSheet.svelte';
  import {
    getSlots,
    myBookings,
    type BookerResource,
    type BookerSpace,
    type MyBooking,
    type ResourceSlots,
    type SlotUnit,
  } from '$lib/bookings/api';
  import {
    BLOCK_LENGTH_CHOICES,
    bookingUnitLimit,
    formatWeekRange,
    freeCount,
    freeRunFrom,
    unitDay,
    unitsInOrder,
    weekDates,
    weekLayout,
    weekReadRange,
    windowRefusal,
    WEEK_DAYS,
  } from '$lib/bookings/grid';
  import { addDays, localDate } from '$lib/bookings/zonedTime';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import {
    SCHEDULE_AGENDA_QUERY,
    isScheduleAgendaViewport,
    onViewportChange,
  } from '$lib/utils/viewport';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE WEEK OF ONE SPACE, ONE COLUMN AT A TIME (WP-B5, WP-R2, WP-R5): days as columns on a desktop
   * and one day under a week strip on a phone (D46, D48; the width decides, as the agenda's does),
   * the column selector, and the sheets that book, block and read a taken unit. ONE read holds the
   * week and the day before it, so the strip's dots, the day and the column counts come from the
   * same answer. The booker's page and the organiser's dashboard both draw it - the dashboard in
   * `block` mode, where a drag or a tap on free units opens "Indisponible" (D50) instead of a booking.
   */
  interface Props {
    space: BookerSpace;
    /** The device's clock, which only DRAWS (the server decides every request). */
    nowMs: number;
    /** `block`: the organiser's dashboard, a free unit opens the block sheet (WP-R5). */
    mode?: 'book' | 'block';
    /** Called after every read of the week, with what it holds: the dashboard's counters. */
    onWeekRead?: (slots: ResourceSlots[], week: string[]) => void;
    /** Called after a sheet changed something (a booking, a block, a cancel). */
    onChanged?: () => void;
  }

  let { space, nowMs = $bindable(), mode = 'book', onWeekRead, onChanged }: Props = $props();

  type Sheet =
    | {
        kind: 'book';
        resource: BookerResource;
        run: SlotUnit[];
        /** The units a drag over the grid already selected (1 for a tap). */
        initialCount: number;
        blockRun: SlotUnit[];
        windowNote: boolean;
      }
    | { kind: 'block'; resource: BookerResource; run: SlotUnit[]; initialCount: number }
    | { kind: 'detail'; resource: BookerResource; unit: SlotUnit };

  let slots = $state<ResourceSlots[]>([]);
  let loaded = $state<{ from: string; to: string } | null>(null);
  let mine = $state<Map<string, MyBooking>>(new Map());
  let slotsError = $state('');
  /** A phone draws one day under the strip; wider screens draw the week. */
  let narrow = $state(isScheduleAgendaViewport());
  /** The day shown (a phone), and with it the week shown. */
  let date = $state(untrack(() => localDate(nowMs, space.timeZone)));
  /** The column shown: a space with several columns shows one at a time (D44, D46). */
  let resourceId = $state(untrack(() => space.resources[0]?.id ?? ''));
  let sheet = $state<Sheet | null>(null);

  const today = $derived(localDate(nowMs, space.timeZone));
  const resource = $derived(space.resources.find((r) => r.id === resourceId) ?? space.resources[0]);
  const weekAll = $derived(date ? weekDates(date) : []);
  const columnUnits = $derived(resource ? unitsInOrder(slots, resource.id) : []);
  /** The week of the chosen column: the strip's dots, and the desktop grid. */
  const week = $derived(weekLayout(columnUnits, weekAll, space, nowMs));
  /** What the grid draws: the week, or on a phone the chosen day alone on its own axis. */
  const layout = $derived(narrow ? weekLayout(columnUnits, [date], space, nowMs) : week);
  const freeCounts = $derived(
    new Map(
      space.resources.map((r) => [
        r.id,
        freeCount(
          unitsInOrder(slots, r.id).filter((u) => weekAll.includes(unitDay(u, space.timeZone))),
          space,
          nowMs
        ),
      ])
    )
  );
  const weekLabel = $derived(weekAll.length ? formatWeekRange(weekAll) : '');

  onMount(() =>
    onViewportChange(SCHEDULE_AGENDA_QUERY, (isNarrow) => {
      narrow = isNarrow;
    })
  );

  onMount(() => {
    void reread();
  });

  // The dashboard's counters follow every read and every week moved to.
  $effect(() => {
    const read = slots;
    const days = weekAll;
    if (loaded) untrack(() => onWeekRead?.(read, days));
  });

  /** What is true now: the grid and the reader's bookings, read again after a write. */
  export async function reread() {
    await Promise.all([readMine(), ensureSlots(true)]);
  }

  /** The reader's own bookings, by id: who holds what, and the private texts (D32). */
  async function readMine() {
    try {
      const rows = await myBookings();
      mine = new Map(rows.map((b) => [b.id, b]));
    } catch (e) {
      // The grid still reads; only the holder's cancel and the private texts wait for a reload.
      Log.i('BOOKINGS', `my bookings unavailable on the space page: ${String(e)}`);
    }
  }

  /** The last read asked for: an older answer arriving after it is for a week no longer shown. */
  let slotsRead = 0;

  /** The week shown, read when it is not already (or `force`d after a write). */
  async function ensureSlots(force = false) {
    // Bumped on EVERY call, the cache hit included: a slow read for a week left behind must not
    // land once the view came back to a week already held.
    const ticket = ++slotsRead;
    const { from, to } = weekReadRange(date);
    if (!force && loaded && loaded.from <= from && to <= loaded.to) return;
    slotsError = '';
    try {
      const read = await getSlots(space.id, from, to);
      if (ticket !== slotsRead) return;
      slots = read;
      loaded = { from, to };
      nowMs = Date.now();
    } catch (e) {
      if (ticket !== slotsRead) return;
      Log.i('BOOKINGS', `slots read failed ${from}..${to}: ${String(e)}`);
      slotsError = describeBookingRefusal(e, m.common_load_error());
    }
  }

  /** A whole week at a time: the same weekday on a phone, so the strip keeps its place. */
  function moveWeek(weeks: number) {
    date = addDays(date, weeks * WEEK_DAYS);
    void ensureSlots();
  }

  function chooseDate(next: string) {
    date = next;
    void ensureSlots();
  }

  /**
   * What tapping a unit opens: the reading of a taken unit; on a free one, the booking sheet - with
   * "block instead" for whoever may - or, in block mode, the block sheet with the run a drag drew.
   * A unit the device's clock puts outside the window still opens, with a note: the server judges
   * the START of the range, on its clock, and its answer is final.
   */
  function pick(picked: BookerResource, unit: SlotUnit, count = 1) {
    if (unit.state !== 'free') {
      sheet = { kind: 'detail', resource: picked, unit };
      return;
    }
    const units = unitsInOrder(slots, picked.id);
    if (mode === 'block') {
      Log.d('BOOKINGS', `dashboard block from a ${count}-unit range`);
      sheet = {
        kind: 'block',
        resource: picked,
        run: freeRunFrom(units, unit, BLOCK_LENGTH_CHOICES),
        initialCount: count,
      };
      return;
    }
    const mayBlock = space.canManage || picked.linkedToMe;
    sheet = {
      kind: 'book',
      resource: picked,
      run: freeRunFrom(units, unit, bookingUnitLimit(space)),
      initialCount: count,
      blockRun: mayBlock ? freeRunFrom(units, unit, BLOCK_LENGTH_CHOICES) : [],
      windowNote: windowRefusal(space, unit.startMs, nowMs) !== null,
    };
  }

  async function closeSheet(changed: boolean) {
    sheet = null;
    if (!changed) return;
    await reread();
    onChanged?.();
  }
</script>

<div class="space-y-4">
  {#if space.resources.length > 1 && resource}
    <ColumnSelect
      resources={space.resources}
      value={resource.id}
      counts={freeCounts}
      onSelect={(id) => (resourceId = id)}
    />
  {/if}

  {#if slotsError}
    <p
      class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
      role="alert"
    >
      {slotsError}
    </p>
  {:else if resource}
    {#if narrow}
      <DayStrip
        days={week.days}
        {date}
        {today}
        label={weekLabel}
        onSelect={chooseDate}
        onPrevious={() => moveWeek(-1)}
        onNext={() => moveWeek(1)}
      />
    {:else}
      <WeekBar
        label={weekLabel}
        away={!weekAll.includes(today)}
        onPrevious={() => moveWeek(-1)}
        onNext={() => moveWeek(1)}
        onToday={() => chooseDate(today)}
      />
    {/if}
    {#if layout.endMin === layout.startMin}
      <p class="text-text-muted py-8 text-center text-sm">
        {narrow ? m.bookings_day_empty() : m.bookings_week_empty()}
      </p>
    {:else}
      <SpaceGrid
        {space}
        {resource}
        {layout}
        mode={narrow ? 'day' : 'week'}
        blockMode={mode === 'block'}
        {nowMs}
        onPick={pick}
      />
    {/if}
  {/if}
</div>

{#if sheet}
  {#if sheet.kind === 'book'}
    {@const s = sheet}
    <BookingSheet
      {space}
      resource={s.resource}
      run={s.run}
      initialCount={s.initialCount}
      windowNote={s.windowNote}
      onReread={reread}
      onBlockInstead={s.blockRun.length
        ? () => (sheet = { kind: 'block', resource: s.resource, run: s.blockRun, initialCount: 1 })
        : undefined}
      onClose={closeSheet}
    />
  {:else if sheet.kind === 'block'}
    <BlockSheet
      {space}
      resource={sheet.resource}
      run={sheet.run}
      initialCount={sheet.initialCount}
      onReread={reread}
      onClose={closeSheet}
    />
  {:else}
    <UnitDetailSheet
      {space}
      resource={sheet.resource}
      unit={sheet.unit}
      mine={sheet.unit.state === 'booked' ? mine.get(sheet.unit.booking.id) : undefined}
      {nowMs}
      onClose={closeSheet}
    />
  {/if}
{/if}
