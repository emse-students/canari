<script lang="ts">
  import { untrack } from 'svelte';
  import { MoonStar, Plus, Save, TriangleAlert, X } from '@lucide/svelte';
  import {
    closureProblem,
    crossesMidnight,
    fromStoredLines,
    lineProblem,
    timeChoices,
    toStoredLines,
    wholeDaysInARow,
    type Closure,
    type EditorLine,
    type StoredLine,
    type Weekday,
  } from '$lib/bookings/availability';
  import { setAvailability } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import Select from '$lib/components/ui/Select.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import { CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { Log } from '$lib/utils/Log';

  /**
   * One resource's availability (D11): weekly and dated ranges, and closures. A range is edited as
   * the organiser thinks of it - "Friday 22:00 to 02:00" is ONE range - and written as the stored
   * lines by `toStoredLines` (WP-B2: a window crossing midnight is two lines). Saved on its own: the
   * server replaces the whole availability, and refuses a change that strands a coming booking
   * (D29), naming how many.
   */
  interface Props {
    resourceId: string;
    lines: StoredLine[];
    exceptions: Closure[];
    /** The space's step, so the times offered fall on it; 15 min for a space of fixed slots. */
    stepMinutes: number | null;
    /** Called once the server took the new availability, with what it now stores. */
    onSaved: (lines: StoredLine[], exceptions: Closure[]) => void;
  }

  let { resourceId, lines, exceptions, stepMinutes, onSaved }: Props = $props();

  // The editor's own copy: the parent re-mounts this component when the resource changes.
  let rows = $state<EditorLine[]>(untrack(() => fromStoredLines(lines)));
  let closures = $state<Closure[]>(untrack(() => exceptions.map((c) => ({ ...c }))));
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  /** A step that divides an hour keeps the list short; anything else falls back to 15 min. */
  const step = $derived(stepMinutes && 60 % stepMinutes === 0 ? stepMinutes : 15);

  /** Monday..Sunday in the reader's language, capitalised as a choice; 2024-01-01 was a Monday. */
  const weekdayNames = $derived(
    [1, 2, 3, 4, 5, 6, 7].map((d) =>
      new Date(Date.UTC(2024, 0, d)).toLocaleDateString(locale, {
        weekday: 'long',
        timeZone: 'UTC',
      })
    )
  );
  const weekdayOptions = $derived(
    weekdayNames.map((name, i) => ({
      value: String(i + 1),
      label: name.charAt(0).toUpperCase() + name.slice(1),
    }))
  );
  const kindOptions = $derived([
    { value: 'weekly', label: m.bookings_avail_weekly() },
    { value: 'dated', label: m.bookings_avail_dated() },
  ]);

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

  function setKind(i: number, kind: string) {
    const row = rows[i];
    rows[i] =
      kind === 'dated'
        ? { kind: 'dated', date: '', start: row.start, end: row.end }
        : { kind: 'weekly', weekday: 1, start: row.start, end: row.end };
    touch();
  }

  function addLine() {
    const last = rows.at(-1);
    rows.push(
      last?.kind === 'weekly'
        ? { ...last, weekday: ((last.weekday % 7) + 1) as Weekday }
        : { kind: 'weekly', weekday: 1, start: '09:00', end: '18:00' }
    );
    touch();
  }

  async function save() {
    if (blocked || saving) return;
    saving = true;
    touch();
    const stored = toStoredLines(rows);
    Log.d('BOOKINGS', `availability save resource=${resourceId} lines=${stored.length}`);
    try {
      await setAvailability(resourceId, stored, closures);
      saved = true;
      onSaved(stored, closures);
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_avail_save());
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  <h4 class="text-text-main text-sm font-bold">{m.bookings_avail_title()}</h4>

  {#if rows.length === 0}
    <p class="text-text-muted text-sm">{m.bookings_avail_empty()}</p>
  {/if}

  <ul class="space-y-3">
    {#each rows as row, i (i)}
      <li class="border-cn-border/70 bg-cn-bg space-y-3 rounded-xl border p-3">
        <div class="flex items-start gap-2">
          <div class="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              id="avail-{resourceId}-{i}-kind"
              label={m.bookings_avail_kind()}
              value={row.kind}
              options={kindOptions}
              onValueChange={(v) => setKind(i, v)}
            />
            {#if row.kind === 'weekly'}
              <Select
                id="avail-{resourceId}-{i}-day"
                label={m.bookings_avail_day()}
                value={String(row.weekday)}
                options={weekdayOptions}
                onValueChange={(v) => {
                  rows[i] = { ...row, weekday: Number(v) as Weekday };
                  touch();
                }}
              />
            {:else}
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
    {/each}
  </ul>

  <button
    type="button"
    onclick={addLine}
    class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
  >
    <Plus size={14} />
    {m.bookings_avail_add_line()}
  </button>

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
