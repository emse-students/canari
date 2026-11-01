<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    formatDay,
    formatTimeRange,
    formatTimeRangeParts,
    gridUnitLimit,
    isOfferedStart,
  } from '$lib/bookings/grid';
  import { dayUnits, endChoices, startChoices, unitKey } from '$lib/bookings/planning';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE PHONE'S "+" (owner, 2026-11-01): a booking asked for by words instead of painted with a
   * finger - column, day, start, end - then handed to the SAME sheets the grid opens (`onSubmit` is
   * `SpaceWeek.pick`: the booking sheet with its answers, participants and reminder, or in block
   * mode the block sheet). EVERY CHOICE IS DRAWN FROM THE FREE RUNS (`planning.ts`): a day with
   * nothing free is not offered, a start is a free unit `isOfferedStart` takes, an end is the end of
   * a contiguous free unit within what one booking may cover. So the form cannot name a range the
   * grid would refuse; should the week have moved since, the server still says so at the send
   * (`refusals.ts`), as it does for a drag. Tapping a free stretch opens it prefilled.
   *
   * A start is keyed by its WHOLE unit (`unitKey`, start AND end): two slots of a list may start at
   * the same instant (10:00-11:00 and 10:00-12:00), and a slot is labelled with its full range.
   * After a column change the prefill follows the stretch where the new column has it free, else the
   * first choice. `initial` is read with `?.`: the owner clears it to close the form, and a derived
   * may be re-read once on the way out.
   */
  interface Props {
    space: BookerSpace;
    resources: BookerResource[];
    /** One column's units, as the week read holds them. */
    unitsOf: (resourceId: string) => SlotUnit[];
    /** The dates of the week shown, in order. */
    dates: string[];
    nowMs: number;
    lastRefusedStart: number | null;
    /** The organiser's dashboard: the range is a block. */
    blockMode: boolean;
    /** What the form opens on: the column, and the first unit (and the end) of the stretch tapped. */
    initial: { resourceId: string; unit?: SlotUnit; endMs?: number } | null;
    onSubmit: (resource: BookerResource, first: SlotUnit, count: number) => void;
    onClose: () => void;
  }

  let {
    space,
    resources,
    unitsOf,
    dates,
    nowMs,
    lastRefusedStart,
    blockMode,
    initial,
    onSubmit,
    onClose,
  }: Props = $props();

  /** What the reader chose; each falls back to the first valid choice while unset or gone stale. */
  let chosenResource = $state<string | null>(null);
  let chosenDate = $state<string | null>(null);
  let chosenStart = $state<string | null>(null);
  let chosenEnd = $state<number | null>(null);

  const limit = $derived(gridUnitLimit(space, blockMode));
  const offered = (unit: SlotUnit) =>
    isOfferedStart(space, unit, nowMs, lastRefusedStart, blockMode);
  const bySlot = $derived(space.slotMode === 'slots');

  const resource = $derived(
    resources.find((r) => r.id === (chosenResource ?? initial?.resourceId)) ?? resources[0]
  );
  const units = $derived(unitsOf(resource.id));
  /** The days with something to start on, for this column. */
  const days = $derived(
    dates.filter((d) => startChoices(dayUnits(units, d, space.timeZone), offered).length > 0)
  );
  const initialKey = $derived(initial?.unit ? unitKey(initial.unit) : null);
  /** The day of the tapped stretch, where this column has it. */
  const initialDate = $derived(
    initialKey === null
      ? null
      : (dates.find((d) =>
          dayUnits(units, d, space.timeZone).some((u) => unitKey(u) === initialKey)
        ) ?? null)
  );
  const date = $derived(
    chosenDate !== null && days.includes(chosenDate)
      ? chosenDate
      : initialDate !== null && days.includes(initialDate)
        ? initialDate
        : (days[0] ?? null)
  );
  const starts = $derived(date ? startChoices(dayUnits(units, date, space.timeZone), offered) : []);
  const start = $derived(
    starts.find((u) => unitKey(u) === (chosenStart ?? initialKey)) ?? starts[0]
  );
  const ends = $derived(start ? endChoices(units, start, limit) : []);
  const end = $derived.by(() => {
    if (ends.length === 0) return undefined;
    const picked = ends.find((u) => u.endMs === chosenEnd);
    if (picked) return picked;
    const wanted =
      chosenStart === null && start && unitKey(start) === initialKey ? initial?.endMs : undefined;
    // A tapped stretch opens on its whole length (as far as one booking goes); the "+" on one step.
    return wanted === undefined
      ? ends[0]
      : ([...ends].reverse().find((u) => u.endMs <= wanted) ?? ends[0]);
  });

  /** A slot is read as its whole range, a step as its start. */
  const startLabel = (unit: SlotUnit) =>
    bySlot
      ? formatTimeRange(unit.startMs, unit.endMs, space.timeZone)
      : formatTimeRangeParts(unit.startMs, unit.endMs, space.timeZone).start;
  /** The end is read from the chosen start, so one past midnight says "(lendemain)". */
  const endLabel = (from: SlotUnit, unit: SlotUnit) =>
    formatTimeRangeParts(from.startMs, unit.endMs, space.timeZone).end;

  untrack(() =>
    Log.d(
      'BOOKINGS',
      `range form opened: ${blockMode ? 'block' : 'booking'}, ${initial?.unit ? 'prefilled from a free row' : 'blank'}`
    )
  );

  function submit() {
    if (!start || !end) return;
    // `ends` is the free run from `start`, so the count is the end's place in it.
    const count = ends.indexOf(end) + 1;
    Log.d('BOOKINGS', `range form: ${count} unit(s) from the "+" planning`);
    onSubmit(resource, start, count);
  }
</script>

<Modal
  open
  title={blockMode ? m.bookings_range_title_block() : m.bookings_range_title()}
  topAnchored
  footerEdge
  {onClose}
>
  <div class="space-y-4">
    {#if resources.length > 1}
      <Select
        label={m.bookings_range_resource()}
        value={resource.id}
        options={resources.map((r) => ({ value: r.id, label: r.name }))}
        onValueChange={(v) => {
          Log.d('BOOKINGS', 'range form: column switched');
          chosenResource = v;
          chosenDate = chosenStart = chosenEnd = null;
        }}
      />
    {/if}
    {#if date === null}
      <p class="text-text-muted text-sm" role="status">{m.bookings_range_none()}</p>
    {:else}
      <Select
        label={m.bookings_range_day()}
        value={date}
        options={days.map((d) => ({ value: d, label: formatDay(d) }))}
        onValueChange={(v) => {
          Log.d('BOOKINGS', 'range form: day switched');
          chosenDate = v;
          chosenStart = chosenEnd = null;
        }}
      />
      <div class="grid grid-cols-2 gap-3">
        <Select
          label={m.bookings_range_start()}
          value={start ? unitKey(start) : ''}
          options={starts.map((u) => ({ value: unitKey(u), label: startLabel(u) }))}
          onValueChange={(v) => {
            chosenStart = v;
            chosenEnd = null;
          }}
        />
        <Select
          label={m.bookings_range_end()}
          value={String(end?.endMs)}
          options={start
            ? ends.map((u) => ({ value: String(u.endMs), label: endLabel(start, u) }))
            : []}
          onValueChange={(v) => (chosenEnd = Number(v))}
        />
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex justify-end">
      <button
        type="button"
        disabled={!start || !end}
        onclick={submit}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {m.bookings_range_continue()}
      </button>
    </div>
  {/snippet}
</Modal>
