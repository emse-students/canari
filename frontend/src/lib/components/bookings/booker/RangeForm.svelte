<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
  import {
    formatDay,
    formatTimeRangeParts,
    gridUnitLimit,
    isOfferedStart,
  } from '$lib/bookings/grid';
  import { dayUnits, endChoices, resolveRange, startChoices } from '$lib/bookings/planning';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE PHONE'S "+" (owner, 2026-11-01): a booking asked for by words instead of painted with a
   * finger - column, day, start, end - then handed to the SAME sheets the grid opens (`onSubmit` is
   * `SpaceWeek.pick`: the booking sheet with its answers, participants and reminder, or in block
   * mode the block sheet). EVERY CHOICE IS DRAWN FROM THE FREE RUNS (`planning.ts`): a day with
   * nothing free is not offered, a start is a free unit the booking window takes, an end is the end
   * of a contiguous free unit within what one booking may cover. So the form cannot name a range the
   * grid would refuse; should the week have moved since, the server still says so at the send
   * (`refusals.ts`), as it does for a drag. Tapping a free stretch opens it prefilled.
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
    /** The organiser's dashboard: the range is a block, free units are not bound by the window. */
    blockMode: boolean;
    /** What the form opens on: the column, and the start (and end) of the stretch tapped. */
    initial: { resourceId: string; startMs?: number; endMs?: number };
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
  let chosenStart = $state<number | null>(null);
  let chosenEnd = $state<number | null>(null);
  let stale = $state(false);

  const limit = $derived(gridUnitLimit(space, blockMode));
  const offered = (unit: SlotUnit) =>
    isOfferedStart(space, unit, nowMs, lastRefusedStart, blockMode);

  const resource = $derived(
    resources.find((r) => r.id === (chosenResource ?? initial.resourceId)) ?? resources[0]
  );
  const units = $derived(unitsOf(resource.id));
  /** The days with something to start on, for this column. */
  const days = $derived(
    dates.filter((d) => startChoices(dayUnits(units, d, space.timeZone), offered).length > 0)
  );
  const initialDate = $derived(
    initial.startMs === undefined
      ? null
      : (dates.find((d) =>
          dayUnits(units, d, space.timeZone).some((u) => u.startMs === initial.startMs)
        ) ?? null)
  );
  const date = $derived(
    days.includes(chosenDate ?? '') ? chosenDate! : (initialDate ?? days[0] ?? null)
  );
  const starts = $derived(date ? startChoices(dayUnits(units, date, space.timeZone), offered) : []);
  const start = $derived(
    starts.find((u) => u.startMs === (chosenStart ?? initial.startMs)) ?? starts[0]
  );
  const ends = $derived(start ? endChoices(units, start, limit) : []);
  const end = $derived.by(() => {
    if (ends.length === 0) return undefined;
    const picked = ends.find((u) => u.endMs === chosenEnd);
    if (picked) return picked;
    const wanted = chosenStart === null && date === initialDate ? initial.endMs : undefined;
    // A tapped stretch opens on its whole length (as far as one booking goes); the "+" on one step.
    return wanted === undefined
      ? ends[0]
      : ([...ends].reverse().find((u) => u.endMs <= wanted) ?? ends[0]);
  });

  const timeOf = (unit: SlotUnit) => formatTimeRangeParts(unit.startMs, unit.endMs, space.timeZone);

  function submit() {
    if (!start || !end) return;
    const range = resolveRange(units, start.startMs, end.endMs, limit);
    if (!range) {
      Log.i('BOOKINGS', 'the range form named a range that is no longer free');
      stale = true;
      return;
    }
    Log.d('BOOKINGS', `range form: ${range.count} unit(s) from the "+" planning`);
    onSubmit(resource, range.first, range.count);
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
          chosenResource = v;
          chosenDate = chosenStart = chosenEnd = null;
          stale = false;
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
          chosenDate = v;
          chosenStart = chosenEnd = null;
          stale = false;
        }}
      />
      <div class="grid grid-cols-2 gap-3">
        <Select
          label={m.bookings_range_start()}
          value={String(start?.startMs)}
          options={starts.map((u) => ({ value: String(u.startMs), label: timeOf(u).start }))}
          onValueChange={(v) => {
            chosenStart = Number(v);
            chosenEnd = null;
            stale = false;
          }}
        />
        <Select
          label={m.bookings_range_end()}
          value={String(end?.endMs)}
          options={ends.map((u) => ({ value: String(u.endMs), label: timeOf(u).end }))}
          onValueChange={(v) => {
            chosenEnd = Number(v);
            stale = false;
          }}
        />
      </div>
    {/if}
    {#if stale}
      <p
        class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
        role="alert"
      >
        {m.bookings_range_none_day()}
      </p>
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
