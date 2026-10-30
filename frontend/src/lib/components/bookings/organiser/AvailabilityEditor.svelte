<script lang="ts">
  import { untrack } from 'svelte';
  import { MoonStar, Plus, Save, TriangleAlert, X } from '@lucide/svelte';
  import {
    applyTemplate,
    paintRows,
    paintSlotRows,
    slotLengthFor,
    weekRunsOf,
    weekSlotsOf,
    type PaintMode,
    type TemplateKey,
  } from '$lib/bookings/availabilityPaint';
  import {
    closureProblem,
    crossesMidnight,
    fromStoredLines,
    lineProblem,
    MAX_AVAILABILITY_LINES,
    timeChoices,
    toStoredLines,
    wholeDaysInARow,
    weekdayNames as weekdayNamesIn,
    type Closure,
    type EditorLine,
    type StoredLine,
  } from '$lib/bookings/availability';
  import { setAvailability } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { strandedIdsOf } from '$lib/bookings/stranded';
  import StrandedBookings from './StrandedBookings.svelte';
  import WeekPainter from './WeekPainter.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import { CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { Log } from '$lib/utils/Log';

  /**
   * One resource's availability (D11, D49): a template to start from, the typical week PAINTED
   * (`WeekPainter`, the one editor of the week), the dated ranges of a one-off event, and
   * closures. A range is edited as the organiser thinks of it - "Friday 22:00 to 02:00" is ONE
   * range - and written as the stored lines by `toStoredLines` (WP-B2: a window crossing midnight
   * is two lines). The painter, the templates and the dated lines all edit the SAME `rows`, so
   * they can never disagree. Saved on its own: the server replaces the whole
   * availability, and refuses a change that strands a coming booking (D29), naming them: they are
   * listed under the button, each with its cancel.
   */
  interface Props {
    spaceId: string;
    /** The space's SAVED zone, which the named bookings are read on (D25). */
    timeZone: string;
    resourceId: string;
    resourceName: string;
    lines: StoredLine[];
    exceptions: Closure[];
    /** The space's step, so the times offered fall on it; 15 min for a space of fixed slots. */
    stepMinutes: number | null;
    /**
     * The space's SAVED mode is fixed slots: each weekly line is one slot, and the painter opens
     * or closes whole slots, never merging them (owner, 2026-10-29).
     */
    fixedSlots: boolean;
    /**
     * The space's SAVED slot length (migration 116), what a painted slot opens; null on a space
     * created before it was stored, whose length is then read from its lines.
     */
    slotMinutes: number | null;
    /** Called once the server took the new availability, with what it now stores. */
    onSaved: (lines: StoredLine[], exceptions: Closure[]) => void;
    /** Whether the editor holds changes not saved, for the leave warning. */
    onDirty: (dirty: boolean) => void;
  }

  let {
    spaceId,
    timeZone,
    resourceId,
    resourceName,
    lines,
    exceptions,
    stepMinutes,
    fixedSlots,
    slotMinutes,
    onSaved,
    onDirty,
  }: Props = $props();

  // The editor's own copy: the parent re-mounts this component when the resource changes.
  let rows = $state<EditorLine[]>(untrack(() => fromStoredLines(lines)));
  let closures = $state<Closure[]>(untrack(() => exceptions.map((c) => ({ ...c }))));
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);
  /** The bookings the last refused save named (D29); the key makes a new refusal a new list. */
  let stranded = $state<{ ids: string[]; key: number }>({ ids: [], key: 0 });

  const draftNow = () => JSON.stringify([rows, closures]);
  /** The availability as last loaded or saved. */
  let savedDraft = $state(untrack(draftNow));
  $effect(() => {
    onDirty(draftNow() !== savedDraft);
  });

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  /** A step that divides an hour keeps the list short; anything else falls back to 15 min. */
  const step = $derived(stepMinutes && 60 % stepMinutes === 0 ? stepMinutes : 15);

  /** Monday..Sunday in the reader's language. */
  const weekdayNames = $derived(weekdayNamesIn(locale, 'long'));
  const shortDayNames = $derived(weekdayNamesIn(locale, 'short'));
  /** The week as the painter draws it, always read from the lines: slots apart, hours merged. */
  const week = $derived(fixedSlots ? weekSlotsOf(rows) : weekRunsOf(rows));
  /** What a painted cell opens on a fixed-slot space, said under the painter. */
  const slotLength = $derived(fixedSlots ? slotLengthFor(rows, slotMinutes) : null);

  const TEMPLATES: { key: TemplateKey; name: () => string; sub: () => string }[] = [
    {
      key: 'always',
      name: () => m.bookings_avail_tpl_always(),
      sub: () => m.bookings_avail_tpl_always_sub(),
    },
    {
      key: 'weekdays',
      name: () => m.bookings_avail_tpl_weekdays(),
      sub: () => m.bookings_avail_tpl_weekdays_sub(),
    },
    {
      key: 'event',
      name: () => m.bookings_avail_tpl_event(),
      sub: () => m.bookings_avail_tpl_event_sub(),
    },
    {
      key: 'empty',
      name: () => m.bookings_avail_tpl_empty(),
      sub: () => m.bookings_avail_tpl_empty_sub(),
    },
  ];

  /** A template replaces the week (the dated lines stay) - still a draft until it is saved. */
  function useTemplate(key: TemplateKey) {
    Log.d('BOOKINGS', `availability template=${key} resource=${resourceId}`);
    rows = applyTemplate(rows, key);
    touch();
  }

  /**
   * The slots a paint could not open, the column being at the server's line cap, and how many it
   * would have held: said under the painter until the next paint, rather than refused at the save.
   */
  let capNotice = $state<{ count: number } | null>(null);

  function paint(dayA: number, dayB: number, slotA: number, slotB: number, mode: PaintMode) {
    let next: readonly EditorLine[];
    capNotice = null;
    if (fixedSlots) {
      const painted = paintSlotRows(rows, dayA, dayB, slotA, slotB, mode, slotMinutes);
      next = painted.rows;
      if (painted.refused > 0) {
        const count = toStoredLines(next).length + painted.refused;
        Log.i('BOOKINGS', `availability paint capped: ${painted.refused} slot(s) not opened`);
        capNotice = { count };
      }
    } else {
      next = paintRows(rows, dayA, dayB, slotA, slotB, mode);
    }
    if (next === rows) return;
    Log.d(
      'BOOKINGS',
      `availability paint days=${dayA}-${dayB} slots=${slotA}-${slotB} ${mode} fixed=${fixedSlots}`
    );
    rows = [...next];
    touch();
  }

  const timeOptions = (asEnd: boolean, current: string) =>
    timeChoices(step, asEnd, current).map((t) => ({ value: t, label: t }));

  /** The days the 24/7 warning names, in the reader's words. */
  const wholeDays = $derived(
    wholeDaysInARow(rows).map((key) =>
      key.startsWith('w')
        ? (weekdayNames[Number(key.slice(1)) - 1] ?? key)
        : new Date(`${key.slice(1)}T12:00:00Z`).toLocaleDateString(locale, {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          })
    )
  );

  const lineProblems = $derived(rows.map(lineProblem));
  const closureProblems = $derived(closures.map(closureProblem));
  const blocked = $derived(
    lineProblems.some((p) => p !== null) || closureProblems.some((p) => p !== null)
  );

  function problemText(p: string | null): string {
    switch (p) {
      case 'time':
        return m.bookings_avail_problem_time();
      case 'empty':
        return m.bookings_avail_problem_empty();
      case 'date':
        return m.bookings_avail_problem_date();
      case 'order':
        return m.bookings_avail_problem_order();
      default:
        return '';
    }
  }

  function touch() {
    saved = false;
    error = '';
  }

  function addDate() {
    rows.push({ kind: 'dated', date: '', start: '14:00', end: '18:00' });
    touch();
  }

  async function save() {
    if (blocked || saving) return;
    saving = true;
    touch();
    stranded = { ids: [], key: stranded.key };
    const stored = toStoredLines(rows);
    Log.d('BOOKINGS', `availability save resource=${resourceId} lines=${stored.length}`);
    try {
      await setAvailability(resourceId, stored, closures);
      saved = true;
      savedDraft = draftNow();
      onSaved(stored, closures);
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_avail_save());
      stranded = { ids: strandedIdsOf(e), key: stranded.key + 1 };
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  <h4 class="text-text-main text-sm font-bold">{m.bookings_avail_title()}</h4>

  <div class="space-y-2">
    <p class="text-text-main text-sm font-semibold">{m.bookings_avail_templates_title()}</p>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {#each TEMPLATES as tpl (tpl.key)}
        <button
          type="button"
          data-template={tpl.key}
          onclick={() => useTemplate(tpl.key)}
          class="border-cn-border bg-cn-surface hover:border-cn-yellow/40 flex min-h-11 flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors"
        >
          <span class="text-text-main text-sm font-bold">{tpl.name()}</span>
          <span class="text-text-muted text-xs">{tpl.sub()}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="space-y-2">
    <p class="text-text-main text-sm font-semibold">{m.bookings_avail_week_title()}</p>
    <WeekPainter
      {week}
      dayNames={weekdayNames}
      {shortDayNames}
      onPaint={paint}
      hint={slotLength === null
        ? undefined
        : m.bookings_avail_paint_slots_hint({ minutes: slotLength })}
    />
    {#if capNotice}
      <p class="text-red-err text-xs font-medium" role="alert">
        {m.bookings_avail_lines_cap({ count: capNotice.count, max: MAX_AVAILABILITY_LINES })}
      </p>
    {/if}
  </div>

  <div class="space-y-3">
    <div>
      <p class="text-text-main text-sm font-semibold">{m.bookings_avail_dates_title()}</p>
      <p class="text-text-muted text-xs">{m.bookings_avail_dates_hint()}</p>
    </div>
    <ul class="space-y-3">
      {#each rows as row, i (i)}
        {#if row.kind === 'dated'}
          {@render lineRow(row, i)}
        {/if}
      {/each}
    </ul>
    <button
      type="button"
      onclick={addDate}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
    >
      <Plus size={14} />
      {m.bookings_avail_add_date()}
    </button>
  </div>

  {#if wholeDays.length}
    <p
      class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm"
      role="status"
    >
      <TriangleAlert size={15} class="mt-0.5 shrink-0" />
      <span>{m.bookings_avail_247_warning({ days: wholeDays.join(', ') })}</span>
    </p>
  {/if}

  <div class="space-y-3">
    <h4 class="text-text-main text-sm font-bold">{m.bookings_avail_closures()}</h4>
    <ul class="space-y-3">
      {#each closures as closure, i (i)}
        <li class="border-cn-border/70 bg-cn-bg rounded-xl border p-3">
          <div class="flex items-start gap-2">
            <div class="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <span class={CONTROL_LABEL_CLASS}>{m.bookings_avail_closure_from()}</span>
                <DateTimeField
                  density="default"
                  id="closure-{resourceId}-{i}-from"
                  dateOnly
                  label={m.bookings_avail_closure_from()}
                  value={closure.fromDate}
                  onValueChange={(v) => {
                    closures[i] = { ...closure, fromDate: v };
                    touch();
                  }}
                />
              </div>
              <div>
                <span class={CONTROL_LABEL_CLASS}>{m.bookings_avail_closure_to()}</span>
                <DateTimeField
                  density="default"
                  id="closure-{resourceId}-{i}-to"
                  dateOnly
                  label={m.bookings_avail_closure_to()}
                  value={closure.toDate}
                  invalid={closureProblems[i] === 'order'}
                  onValueChange={(v) => {
                    closures[i] = { ...closure, toDate: v };
                    touch();
                  }}
                />
              </div>
            </div>
            <button
              type="button"
              class="ui-icon-button text-text-muted hover:text-red-err mt-7 shrink-0 rounded-full"
              aria-label={m.bookings_avail_remove_closure_aria()}
              onclick={() => {
                closures.splice(i, 1);
                touch();
              }}
            >
              <X size={18} />
            </button>
          </div>
          {#if closureProblems[i]}
            <p class="text-red-err mt-2 text-xs" role="alert">
              {problemText(closureProblems[i])}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
    <button
      type="button"
      onclick={() => {
        closures.push({ fromDate: '', toDate: '' });
        touch();
      }}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
    >
      <Plus size={14} />
      {m.bookings_avail_add_closure()}
    </button>
  </div>

  {#if error}
    <p
      class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-3 py-2.5 text-sm"
      role="alert"
    >
      {error}
    </p>
  {/if}
  {#if stranded.ids.length}
    {#key stranded.key}
      <StrandedBookings
        {spaceId}
        ids={stranded.ids}
        resources={[{ id: resourceId, name: resourceName }]}
        {timeZone}
        onRetry={save}
      />
    {/key}
  {/if}

  <div class="flex flex-wrap items-center justify-end gap-3">
    {#if saved}
      <p class="text-green-ok text-sm" role="status">{m.bookings_avail_saved()}</p>
    {/if}
    <button
      type="button"
      onclick={save}
      disabled={blocked || saving}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Save size={16} />
      {saving ? m.form_saving_label() : m.bookings_avail_save()}
    </button>
  </div>
</div>

{#snippet lineRow(row: EditorLine, i: number)}
  <li class="border-cn-border/70 bg-cn-bg space-y-3 rounded-xl border p-3">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        {#if row.kind === 'dated'}
          <div>
            <span class={CONTROL_LABEL_CLASS}>{m.bookings_avail_date()}</span>
            <DateTimeField
              density="default"
              id="avail-{resourceId}-{i}-date"
              dateOnly
              label={m.bookings_avail_date()}
              value={row.date}
              invalid={lineProblems[i] === 'date'}
              onValueChange={(v) => {
                rows[i] = { ...row, date: v };
                touch();
              }}
            />
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="ui-icon-button text-text-muted hover:text-red-err mt-7 shrink-0 rounded-full"
        aria-label={m.bookings_avail_remove_aria()}
        onclick={() => {
          rows.splice(i, 1);
          touch();
        }}
      >
        <X size={18} />
      </button>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <Select
        id="avail-{resourceId}-{i}-start"
        label={m.bookings_avail_start()}
        value={row.start}
        options={timeOptions(false, row.start)}
        onValueChange={(v) => {
          rows[i] = { ...row, start: v };
          touch();
        }}
      />
      <Select
        id="avail-{resourceId}-{i}-end"
        label={m.bookings_avail_end()}
        value={row.end}
        options={timeOptions(true, row.end)}
        onValueChange={(v) => {
          rows[i] = { ...row, end: v };
          touch();
        }}
      />
    </div>
    {#if lineProblems[i]}
      <p class="text-red-err text-xs" role="alert">{problemText(lineProblems[i])}</p>
    {:else if crossesMidnight(row)}
      <p class="text-text-muted flex items-center gap-1.5 text-xs">
        <MoonStar size={13} />
        {m.bookings_avail_next_day()}
      </p>
    {/if}
  </li>
{/snippet}
