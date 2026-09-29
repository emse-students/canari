<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/svelte';
  import FloatingSurface from './FloatingSurface.svelte';
  import Button from './Button.svelte';
  import { controlClass, type ControlDensity } from './controlClasses';
  import {
    clampToMin,
    dayBeforeMin,
    formatLocalDateTime,
    fromDate,
    minuteChoices,
    parseLocalDateTime,
    shiftMonth,
    toDate,
    type LocalDateTime,
  } from './dateTimeField';
  import { monthGridDays, localizedWeekdays } from '$lib/calendar/monthGrid';
  import { Log } from '$lib/utils/Log';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';

  /**
   * A date and a time chosen in the APP - a month grid and two columns of hours and minutes, in a
   * sheet on a phone and a popover on a wide window - replacing `<input type="datetime-local">`.
   *
   * WHY (user, 2026-09-29, the rule in durable-rules: a choice is drawn by the app). The native
   * input opens Android's own date dialog and then a second, separate clock dialog - two system
   * screens in a row for one field.
   *
   * THE VALUE IS THE NATIVE INPUT'S (`YYYY-MM-DDTHH:mm`, wall time, `''` for none), so a caller
   * swaps the element and keeps every line that parses or sends it. The choice is a DRAFT until
   * "Valider": closing the surface any other way leaves the value as it was, as cancelling the
   * native dialog did. `min` greys out whole days before it and clamps an earlier time to it.
   */
  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    /** Accessible name, and the sheet's title. */
    label: string;
    id?: string;
    /** Earliest allowed value, same format. */
    min?: string;
    /** Offers "Effacer" when a value is set - for an optional date. */
    clearable?: boolean;
    disabled?: boolean;
    /** Shown on the trigger when the value is empty. */
    placeholder?: string;
    /** Minute granularity offered (a value off the step is still kept and shown). */
    minuteStep?: number;
    variant?: 'inline' | 'field';
    density?: ControlDensity;
    invalid?: boolean;
    /** Full override of the trigger's classes. */
    triggerClass?: string;
    /** Custom trigger content; receives the formatted value (`''` when empty). */
    trigger?: Snippet<[string]>;
  }

  let {
    value,
    onValueChange,
    label,
    id,
    min = '',
    clearable = false,
    disabled = false,
    placeholder = '',
    minuteStep = 5,
    variant = 'field',
    density = 'compact',
    invalid = false,
    triggerClass = '',
    trigger,
  }: Props = $props();

  const SHEET_QUERY = '(width < 40rem)';

  let open = $state(false);
  let asSheet = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let hoursEl: HTMLDivElement | null = $state(null);
  let minutesEl: HTMLDivElement | null = $state(null);
  let draft = $state<LocalDateTime>(fromDate(new Date()));
  let view = $state({ year: 0, month: 0 });

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');

  const formatted = $derived.by(() => {
    const dt = parseLocalDateTime(value);
    if (!dt) return '';
    return toDate(dt).toLocaleString(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  const monthTitle = $derived(
    new Date(view.year, view.month, 1).toLocaleDateString(locale, {
      month: 'long',
      year: 'numeric',
    })
  );
  const weekdays = $derived(localizedWeekdays(locale, 'short'));
  const cells = $derived(monthGridDays(new Date(view.year, view.month, 1)));
  const minutes = $derived(minuteChoices(minuteStep, draft.minute));
  const HOURS = Array.from({ length: 24 }, (_, h) => h);
  const today = new Date();

  const pad2 = (n: number) => String(n).padStart(2, '0');

  /** An empty field opens on the next step of the current hour, never in the past of `min`. */
  function startingPoint(): LocalDateTime {
    const parsed = parseLocalDateTime(value);
    if (parsed) return parsed;
    const now = fromDate(new Date());
    const rounded = Math.ceil(now.minute / minuteStep) * minuteStep;
    const start = fromDate(toDate({ ...now, minute: rounded }));
    return min ? clampToMin(start, min) : start;
  }

  async function openField() {
    if (disabled) return;
    draft = startingPoint();
    view = { year: draft.year, month: draft.month };
    asSheet = window.matchMedia(SHEET_QUERY).matches;
    open = true;
    Log.d(
      'DATETIME',
      `open "${label}" as ${asSheet ? 'sheet' : 'popover'}, value=${value || 'empty'}`
    );
    await tick();
    for (const column of [hoursEl, minutesEl]) {
      column?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' });
    }
  }

  function close(refocus: boolean) {
    open = false;
    if (refocus) triggerEl?.focus({ preventScroll: true });
  }

  function pickDay(day: number) {
    draft = { ...draft, year: view.year, month: view.month, day };
  }

  function moveMonth(delta: number) {
    view = shiftMonth(view.year, view.month, delta);
  }

  function confirm() {
    const chosen = formatLocalDateTime(min ? clampToMin(draft, min) : draft);
    Log.d('DATETIME', `"${label}" -> ${chosen === value ? 'unchanged' : 'changed'}`);
    if (chosen !== value) onValueChange(chosen);
    close(true);
  }

  function clear() {
    Log.d('DATETIME', `"${label}" cleared`);
    onValueChange('');
    close(true);
  }

  const INLINE_TRIGGER =
    'text-text-main flex max-w-full items-center gap-1.5 truncate rounded-lg px-1 py-1 text-sm font-semibold outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60 dark:hover:bg-white/10';

  const resolvedTriggerClass = $derived(
    triggerClass ||
      (variant === 'field'
        ? `${controlClass(invalid, density)} flex items-center justify-between gap-2 text-left cursor-pointer disabled:cursor-default`
        : INLINE_TRIGGER)
  );

  const COLUMN = 'flex h-40 w-16 flex-col gap-0.5 overflow-y-auto overscroll-contain';
  const CELL =
    'shrink-0 rounded-lg py-1.5 text-center text-sm font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-amber-500/50';
</script>

<button
  bind:this={triggerEl}
  {id}
  type="button"
  {disabled}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label={`${label} - ${formatted || placeholder}`}
  class={resolvedTriggerClass}
  onclick={() => (open ? close(false) : openField())}
>
  {#if trigger}
    {@render trigger(formatted)}
  {:else}
    <span class="min-w-0 truncate {formatted ? '' : 'text-text-muted'}">
      {formatted || placeholder}
    </span>
    <CalendarDays size={16} strokeWidth={2.25} class="text-text-muted shrink-0" />
  {/if}
</button>

<FloatingSurface {open} {asSheet} anchor={triggerEl} {label} onClose={close} popoverWidth="content">
  <div class="flex flex-col gap-3 px-2 pb-1 sm:flex-row sm:items-start">
    <div class="w-full sm:w-72">
      <div class="flex items-center justify-between pb-1">
        <button
          type="button"
          class="ui-icon-button text-text-muted hover:text-text-main rounded-full"
          aria-label={m.calendar_prev_month()}
          onclick={() => moveMonth(-1)}
        >
          <ChevronLeft size={18} strokeWidth={2.5} />
        </button>
        <p class="text-text-main text-sm font-bold first-letter:uppercase">{monthTitle}</p>
        <button
          type="button"
          class="ui-icon-button text-text-muted hover:text-text-main rounded-full"
          aria-label={m.calendar_next_month()}
          onclick={() => moveMonth(1)}
        >
          <ChevronRight size={18} strokeWidth={2.5} />
        </button>
      </div>
      <div class="grid grid-cols-7 gap-0.5 text-center">
        {#each weekdays as name (name)}
          <span class="text-text-muted text-2xs py-1 font-bold uppercase">{name}</span>
        {/each}
        {#each cells as day, i (i)}
          {#if day === null}
            <span></span>
          {:else}
            {@const selected =
              draft.year === view.year && draft.month === view.month && draft.day === day}
            {@const isToday =
              today.getFullYear() === view.year &&
              today.getMonth() === view.month &&
              today.getDate() === day}
            <button
              type="button"
              aria-pressed={selected}
              disabled={!!min && dayBeforeMin(view.year, view.month, day, min)}
              class="mx-auto flex size-9 items-center justify-center rounded-full text-sm font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 disabled:opacity-30 {selected
                ? 'bg-amber-400 text-black'
                : isToday
                  ? 'text-text-main ring-1 ring-amber-500/60 hover:bg-black/5 dark:hover:bg-white/10'
                  : 'text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
              onclick={() => pickDay(day)}
            >
              {day}
            </button>
          {/if}
        {/each}
      </div>
    </div>

    <div class="flex items-start justify-center gap-2 sm:pt-9">
      <div bind:this={hoursEl} class={COLUMN} role="group" aria-label={m.ui_datetime_hours()}>
        {#each HOURS as h (h)}
          <button
            type="button"
            aria-pressed={draft.hour === h}
            class="{CELL} {draft.hour === h
              ? 'bg-amber-400 text-black'
              : 'text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
            onclick={() => (draft = { ...draft, hour: h })}
          >
            {pad2(h)}
          </button>
        {/each}
      </div>
      <span class="text-text-muted pt-1.5 text-sm font-bold">:</span>
      <div bind:this={minutesEl} class={COLUMN} role="group" aria-label={m.ui_datetime_minutes()}>
        {#each minutes as mi (mi)}
          <button
            type="button"
            aria-pressed={draft.minute === mi}
            class="{CELL} {draft.minute === mi
              ? 'bg-amber-400 text-black'
              : 'text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
            onclick={() => (draft = { ...draft, minute: mi })}
          >
            {pad2(mi)}
          </button>
        {/each}
      </div>
    </div>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      {#if clearable && value}
        <Button variant="ghost" class="mr-auto" onclick={clear}>{m.common_clear_aria()}</Button>
      {/if}
      <Button variant="primary" onclick={confirm}>{m.common_validate_button()}</Button>
    </div>
  {/snippet}
</FloatingSurface>
