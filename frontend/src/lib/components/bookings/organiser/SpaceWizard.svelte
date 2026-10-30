<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { ArrowLeft, ArrowRight, Check } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import AudienceConditionEditor from '$lib/components/forms/AudienceConditionEditor.svelte';
  import SpacePosterField from './SpacePosterField.svelte';
  import WeekPainter from './WeekPainter.svelte';
  import TemplatePicker from './TemplatePicker.svelte';
  import { createSpace } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import {
    lineProblem,
    MAX_AVAILABILITY_LINES,
    timeChoices,
    weekdayNames,
  } from '$lib/bookings/availability';
  import {
    applyTemplate,
    editRun,
    paintRows,
    weekRunsOf,
    type PaintMode,
    type SelectedRun,
    type TemplateKey,
  } from '$lib/bookings/availabilityPaint';
  import {
    durationChoices,
    MAX_DURATION_CHOICES,
    newWizardDraft,
    SLOT_LENGTH_CHOICES,
    STEP_CHOICES,
    wizardLines,
    wizardPayload,
    wizardProblems,
    type WizardDraft,
  } from '$lib/bookings/wizard';
  import type { MembershipTier } from '$lib/associations/api';
  import { cotisationOptionsFor } from '$lib/forms/cotisationSettings';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { Log } from '$lib/utils/Log';

  /**
   * THE OPTIONAL CREATION WIZARD (WP-R7, D52), offered on every creation (Q-R14): C'est quoi ? /
   * Quand ? / Pour qui ?, then ONE creation carrying what the steps asked and the hidden column's
   * first hours (`wizard.ts`). "Je regle tout moi-meme" leaves it for the five sections, with the
   * name typed so far. Everything finer - closures, more dated lines, columns, rules, questions - is
   * the editor's, which the page opens on the new space.
   */
  interface Props {
    /** The owning entity, or `null` for a personal space. */
    associationId: string | null;
    /** The name typed before the wizard opened. */
    initialName: string;
    /** The space was created: the caller opens its editor. */
    onCreated: (id: string) => void;
    /** "Je regle tout moi-meme": the caller creates the space by its name alone. */
    onSkip: (name: string) => void;
    /** Leave without creating anything. */
    onCancel: () => void;
  }

  let { associationId, initialName, onCreated, onSkip, onCancel }: Props = $props();

  let draft = $state<WizardDraft>(untrack(() => newWizardDraft(initialName)));
  let step = $state(1);
  /** A step's problems show once its "Suivant" was pressed, not while the organiser types. */
  let tried = $state(false);
  let creating = $state(false);
  /** The poster is uploading: the steps wait for its reference (review of #2687). */
  let posterBusy = $state(false);
  /** The current step's heading, focused on each step change so a screen reader follows. */
  let stepHeading = $state<HTMLHeadingElement | null>(null);
  let error = $state('');
  let tiers = $state<MembershipTier[]>([]);
  let formations = $state<FormationOption[]>([]);

  const STEPS = [
    () => m.bookings_wizard_step_what(),
    () => m.bookings_wizard_step_when(),
    () => m.bookings_wizard_step_who(),
  ];

  onMount(() => {
    Log.d('BOOKINGS', `wizard open association=${associationId ?? 'personal'}`);
    // The audience editor's choices, as the space editor's page loads them.
    if (associationId) {
      void cotisationOptionsFor(associationId).then((o) => (tiers = o.tiers));
    }
    fetchFormations()
      .then((f) => (formations = f))
      .catch((e) => Log.d('BOOKINGS', `formations unavailable: ${String(e)}`));
  });

  const problems = $derived(wizardProblems(draft));
  const stepBlocked = $derived(
    step === 1 ? !!problems.name : step === 2 ? !!problems.hours : false
  );
  const lineCount = $derived(draft.slotMode === 'slots' ? wizardLines(draft).length : 0);

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  const dayNames = $derived(weekdayNames(locale, 'long'));
  const shortDayNames = $derived(weekdayNames(locale, 'short'));
  const week = $derived(weekRunsOf(draft.rows));
  /** The times a dated line offers: the step when it divides an hour, else 15 min. */
  const timeStep = $derived(
    draft.slotMode === 'step' && 60 % draft.stepMinutes === 0 ? draft.stepMinutes : 15
  );

  function useTemplate(key: TemplateKey) {
    Log.d('BOOKINGS', `wizard template=${key}`);
    draft.template = key;
    // The wizard has no other dated line to keep: a template starts the hours afresh.
    draft.rows = applyTemplate([], key);
  }

  function paint(dayA: number, dayB: number, slotA: number, slotB: number, mode: PaintMode) {
    const next = paintRows(draft.rows, dayA, dayB, slotA, slotB, mode);
    if (next !== draft.rows) draft.rows = [...next];
  }

  /** The painter's exact hours of a run: the wizard's week is always runs (a step space). */
  function editRunOf(run: SelectedRun, start: number, end: number): boolean {
    const next = editRun(draft.rows, run.day, [run.start, run.end], start, end);
    if (next === null) return false;
    if (next !== draft.rows) draft.rows = [...next];
    return true;
  }

  function hoursProblem(): string {
    switch (problems.hours) {
      case 'line':
        return m.bookings_wizard_problem_line();
      case 'duration':
        return m.bookings_wizard_problem_duration();
      case 'too-many':
        return m.bookings_avail_lines_cap({ count: lineCount, max: MAX_AVAILABILITY_LINES });
      default:
        return '';
    }
  }

  /** Moves the focus to the new step's heading once it is drawn. */
  async function focusStep() {
    await tick();
    stepHeading?.focus();
  }

  function next() {
    if (posterBusy) return;
    if (stepBlocked) {
      tried = true;
      Log.d('BOOKINGS', `wizard step ${step} blocked: ${JSON.stringify(problems)}`);
      return;
    }
    tried = false;
    step += 1;
    void focusStep();
  }

  function back() {
    tried = false;
    if (step === 1) onCancel();
    else {
      step -= 1;
      void focusStep();
    }
  }

  /**
   * "Je regle tout moi-meme": hands the name back. Without one it is the wizard's own name field
   * that complains - back on the first step, where the field is - never a banner under it.
   */
  function skip() {
    const name = draft.name.trim();
    if (!name) {
      step = 1;
      tried = true;
      return;
    }
    onSkip(name);
  }

  async function create() {
    const payload = wizardPayload(draft);
    if (posterBusy) return;
    if (!payload || creating) {
      tried = true;
      return;
    }
    creating = true;
    error = '';
    try {
      const { id } = await createSpace(
        payload.name,
        associationId,
        { lines: payload.lines, exceptions: [] },
        payload.fields
      );
      Log.i(
        'BOOKINGS',
        `space created by the wizard id=${id.slice(0, 8)} mode=${draft.slotMode} lines=${payload.lines.length}`
      );
      onCreated(id);
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_tab_create_button());
    } finally {
      creating = false;
    }
  }
</script>

<section class="space-y-5" aria-labelledby="space-wizard-title">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 id="space-wizard-title" class="text-text-main text-base font-bold">
      {m.bookings_wizard_title()}
    </h3>
    <button
      type="button"
      onclick={skip}
      disabled={creating}
      class="text-text-muted hover:text-text-main text-sm font-semibold underline underline-offset-2 disabled:opacity-40"
    >
      {m.bookings_wizard_skip()}
    </button>
  </div>

  <!-- The mockup's stepper: a numbered disc per step, joined by a bar, the done ones ticked. On a
       phone only the current step keeps its word, the discs and bars say the rest. -->
  <ol class="flex items-center gap-2" aria-label={m.bookings_wizard_steps_label()}>
    {#each STEPS as label, i (i)}
      {#if i > 0}
        <li
          aria-hidden="true"
          class="h-0.5 min-w-3 flex-1 rounded-full {step > i ? 'bg-cn-yellow' : 'bg-cn-border'}"
        ></li>
      {/if}
      <li
        aria-current={step === i + 1 ? 'step' : undefined}
        class="flex shrink-0 items-center gap-1.5 text-xs font-semibold {step === i + 1
          ? 'text-text-main'
          : 'text-text-muted'}"
      >
        <span
          class="grid size-6 place-items-center rounded-full text-xs font-bold {step === i + 1
            ? 'bg-cn-yellow text-cn-ink'
            : step > i + 1
              ? 'bg-green-ok/15 text-green-ok'
              : 'bg-control-fill'}"
        >
          {#if step > i + 1}<Check size={12} />{:else}{i + 1}{/if}
        </span>
        <span class={step === i + 1 ? '' : 'max-sm:sr-only'}>{label()}</span>
      </li>
    {/each}
  </ol>

  {#if step === 1}
    <div class="space-y-4">
      <h4
        bind:this={stepHeading}
        tabindex="-1"
        class="text-text-main text-sm font-bold outline-none"
      >
        {m.bookings_wizard_step_what()}
      </h4>
      <Input
        id="wizard-name"
        label={m.bookings_field_name()}
        placeholder={m.bookings_wizard_name_placeholder()}
        bind:value={draft.name}
        maxlength={120}
        error={tried && problems.name ? m.bookings_problem_required() : undefined}
      />
      <Textarea
        id="wizard-description"
        label={m.bookings_wizard_description_label()}
        placeholder={m.bookings_wizard_description_placeholder()}
        bind:value={draft.description}
        rows={2}
        maxlength={4000}
      />
      <SpacePosterField
        spaceId={null}
        spaceName={draft.name}
        poster={draft.poster}
        onChanged={(poster) => (draft.poster = poster)}
        onBusy={(b) => (posterBusy = b)}
      />
    </div>
  {:else if step === 2}
    <div class="space-y-4">
      <h4
        bind:this={stepHeading}
        tabindex="-1"
        class="text-text-main text-sm font-bold outline-none"
      >
        {m.bookings_section_resources()}
      </h4>
      <TemplatePicker selected={draft.template} onPick={useTemplate} />

      {#if draft.template === 'event'}
        <ul class="space-y-3">
          {#each draft.rows as row, i (i)}
            {#if row.kind === 'dated'}
              <li
                class="border-cn-border/70 bg-cn-bg grid grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-3"
              >
                <div>
                  <span class={CONTROL_LABEL_CLASS}>{m.bookings_avail_date()}</span>
                  <DateTimeField
                    density="default"
                    id="wizard-date-{i}"
                    dateOnly
                    label={m.bookings_avail_date()}
                    value={row.date}
                    invalid={tried && lineProblem(row) === 'date'}
                    onValueChange={(v) => (draft.rows[i] = { ...row, date: v })}
                  />
                </div>
                <Select
                  id="wizard-date-{i}-start"
                  label={m.bookings_avail_start()}
                  value={row.start}
                  options={timeChoices(timeStep, false, row.start).map((t) => ({
                    value: t,
                    label: t,
                  }))}
                  onValueChange={(v) => (draft.rows[i] = { ...row, start: v })}
                />
                <Select
                  id="wizard-date-{i}-end"
                  label={m.bookings_avail_end()}
                  value={row.end}
                  options={timeChoices(timeStep, true, row.end).map((t) => ({
                    value: t,
                    label: t,
                  }))}
                  onValueChange={(v) => (draft.rows[i] = { ...row, end: v })}
                />
              </li>
            {/if}
          {/each}
        </ul>
      {:else}
        <WeekPainter
          {week}
          {dayNames}
          {shortDayNames}
          onPaint={paint}
          step={timeStep}
          onEdit={editRunOf}
        />
      {/if}
      <p class={CONTROL_HINT_CLASS}>{m.bookings_wizard_when_hint()}</p>

      <fieldset class="space-y-2">
        <legend class={CONTROL_LABEL_CLASS}>{m.bookings_wizard_duration_title()}</legend>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 {draft.slotMode ===
          'step'
            ? 'border-cn-yellow'
            : 'border-cn-border'}"
        >
          <input
            type="radio"
            name="wizard-mode"
            value="step"
            bind:group={draft.slotMode}
            class="mt-1"
          />
          <span class="min-w-0 flex-1 space-y-2">
            <span class="text-text-main block text-sm font-bold">
              {m.bookings_wizard_duration_free()}
            </span>
            {#if draft.slotMode === 'step'}
              <span class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  id="wizard-max"
                  label={m.bookings_wizard_max_label()}
                  value={String(draft.maxMinutes)}
                  options={durationChoices(MAX_DURATION_CHOICES)}
                  onValueChange={(v) => (draft.maxMinutes = Number(v))}
                />
                <Select
                  id="wizard-step"
                  label={m.bookings_wizard_step_label()}
                  value={String(draft.stepMinutes)}
                  options={durationChoices(STEP_CHOICES)}
                  onValueChange={(v) => (draft.stepMinutes = Number(v))}
                />
              </span>
            {/if}
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 {draft.slotMode ===
          'slots'
            ? 'border-cn-yellow'
            : 'border-cn-border'}"
        >
          <input
            type="radio"
            name="wizard-mode"
            value="slots"
            bind:group={draft.slotMode}
            class="mt-1"
          />
          <span class="min-w-0 flex-1 space-y-2">
            <span class="text-text-main block text-sm font-bold">
              {m.bookings_wizard_duration_fixed()}
            </span>
            <span class="text-text-muted block text-xs"
              >{m.bookings_wizard_duration_fixed_sub()}</span
            >
            {#if draft.slotMode === 'slots'}
              <Select
                id="wizard-slot"
                label={m.bookings_wizard_slot_length()}
                value={String(draft.slotMinutes)}
                options={durationChoices(SLOT_LENGTH_CHOICES)}
                onValueChange={(v) => (draft.slotMinutes = Number(v))}
              />
              <span class="text-text-muted block text-xs" role="status">
                {m.bookings_wizard_slots_count({ count: lineCount })}
              </span>
            {/if}
          </span>
        </label>
      </fieldset>
      {#if problems.hours && (tried || problems.hours === 'too-many')}
        <p class="text-red-err text-xs font-medium" role="alert">{hoursProblem()}</p>
      {/if}
    </div>
  {:else}
    <div class="space-y-4">
      <h4
        bind:this={stepHeading}
        tabindex="-1"
        class="text-text-main text-sm font-bold outline-none"
      >
        {m.bookings_wizard_step_who()}
      </h4>
      <fieldset class="space-y-2">
        <legend class={CONTROL_LABEL_CLASS}>{m.bookings_wizard_audience_title()}</legend>
        <label
          class="flex cursor-pointer items-center gap-3 rounded-xl border p-3 {draft.restricted
            ? 'border-cn-border'
            : 'border-cn-yellow'}"
        >
          <input type="radio" name="wizard-audience" value={false} bind:group={draft.restricted} />
          <span class="text-text-main text-sm font-bold">{m.bookings_wizard_audience_all()}</span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 {draft.restricted
            ? 'border-cn-yellow'
            : 'border-cn-border'}"
        >
          <input
            type="radio"
            name="wizard-audience"
            value={true}
            bind:group={draft.restricted}
            class="mt-1"
          />
          <span class="min-w-0 flex-1">
            <span class="text-text-main block text-sm font-bold">
              {m.bookings_wizard_audience_some()}
            </span>
            <span class="text-text-muted block text-xs"
              >{m.bookings_wizard_audience_some_sub()}</span
            >
          </span>
        </label>
        {#if draft.restricted}
          <AudienceConditionEditor bind:condition={draft.audience} {tiers} {formations} />
        {/if}
      </fieldset>
      <div>
        <span class={CONTROL_LABEL_CLASS}>{m.bookings_wizard_names_title()}</span>
        <SegmentedControl
          label={m.bookings_wizard_names_title()}
          items={[
            { key: 'names', label: m.bookings_wizard_names_yes() },
            { key: 'occupied', label: m.bookings_wizard_names_no() },
          ]}
          value={draft.nameVisibility}
          onSelect={(k) => (draft.nameVisibility = k)}
        />
      </div>
      <div>
        <span class={CONTROL_LABEL_CLASS}>{m.bookings_wizard_find_title()}</span>
        <SegmentedControl
          label={m.bookings_wizard_find_title()}
          items={[
            { key: 'listed', label: m.bookings_wizard_find_listed() },
            { key: 'link', label: m.bookings_wizard_find_link() },
          ]}
          value={draft.discoverability}
          onSelect={(k) => (draft.discoverability = k)}
        />
      </div>
    </div>
  {/if}

  {#if error}
    <p
      class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
      role="alert"
    >
      {error}
    </p>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3">
    <button
      type="button"
      onclick={back}
      disabled={creating}
      class="text-text-main hover:bg-control-fill inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-40"
    >
      <ArrowLeft size={16} />
      {step === 1 ? m.common_cancel_button() : m.common_back()}
    </button>
    {#if step < 3}
      <button
        type="button"
        onclick={next}
        disabled={posterBusy}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {m.bookings_wizard_next()}
        <ArrowRight size={16} />
      </button>
    {:else}
      <button
        type="button"
        onclick={create}
        disabled={creating || posterBusy}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Check size={16} />
        {creating ? m.bookings_wizard_creating() : m.bookings_tab_create_button()}
      </button>
    {/if}
  </div>
</section>
