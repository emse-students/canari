<script lang="ts">
  import { untrack } from 'svelte';
  import {
    CalendarRange,
    Columns3,
    Database,
    Download,
    Info,
    ListChecks,
    Plus,
    Trash2,
    Users,
  } from '@lucide/svelte';
  import FormSection from '$lib/components/forms/FormSection.svelte';
  import FormSaveBar from '$lib/components/forms/FormSaveBar.svelte';
  import FormQuestionsSection from '$lib/components/forms/FormQuestionsSection.svelte';
  import AudienceConditionEditor from '$lib/components/forms/AudienceConditionEditor.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import ResourceEditor from './ResourceEditor.svelte';
  import SpacePosterField from './SpacePosterField.svelte';
  import {
    addResource,
    deleteSpace,
    updateSpace,
    type ManagedResource,
    type ManagedSpace,
  } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { strandedIdsOf } from '$lib/bookings/stranded';
  import { columnsHidden } from '$lib/bookings/columns';
  import { sectionSummaries } from '$lib/bookings/spaceSummaries';
  import { guardUnsavedChanges } from '$lib/navigation/unsavedChanges';
  import StrandedBookings from './StrandedBookings.svelte';
  import {
    activeRuleCount,
    draftFromSpace,
    draftProblems,
    NUMBER_BOUNDS,
    settingsFromDraft,
    timeZoneChoices,
    type NumberField,
    type SettingsDraft,
  } from '$lib/bookings/spaceSettings.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { downloadSpaceExport } from '$lib/bookings/bookingActions';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { reminderFromValue, reminderOptions } from '$lib/bookings/reminder';
  import { Log } from '$lib/utils/Log';

  /**
   * THE ORGANISER'S EDITOR OF ONE SPACE (WP-B4), in D35's five sections, worded as the questions an
   * organiser asks (WP-R6, D51, Q-R13): L'essentiel; Quand peut-on reserver ?; Qui peut reserver,
   * et que demande-t-on ? (who, names, discoverability, the people ceiling, the questions and the
   * after-booking information); Regles de reservation (collapsed, a badge counting what is set);
   * Donnees (collapsed, a badge with the retention). Each title carries the section's current
   * answer on a line below it. The space's settings save together through the bar at the bottom; each resource
   * and its availability save on their own, because each is its own call and the server may refuse
   * one (D29) while the others stand. Loading and navigation are the page's
   * (`routes/bookings/spaces/[spaceId]/edit`); this component only edits what it is handed.
   */
  interface Props {
    /** The space as the server answered it; the editor keeps its own copy from then on. */
    initial: ManagedSpace;
    /** The owning entity's cotisation tiers, for the audience and the questions' conditions. */
    tiers: MembershipTier[];
    formations: FormationOption[];
    /** The settings were saved: the page renames its header. */
    onSaved: (space: ManagedSpace) => void;
    /** The space was deleted: the page leaves. */
    onDeleted: () => void;
  }

  let { initial, tiers, formations, onSaved, onDeleted }: Props = $props();

  let space = $state<ManagedSpace>(untrack(() => structuredClone($state.snapshot(initial))));
  let draft = $state<SettingsDraft>(untrack(() => draftFromSpace(initial)));
  let saving = $state(false);
  let saveError = $state('');
  let addingResource = $state(false);
  let resourceError = $state('');
  /** The space shows no columns while it has exactly one (D44). */
  const hidden = $derived(columnsHidden(space.name, space.resources));
  /** "Ajouter une colonne" on a hidden column: the form naming the new one is open. */
  let revealing = $state(false);
  let newColumnName = $state('');
  /** The bookings the last refused save named (D29), and a key so a new refusal is a new list. */
  let stranded = $state<{ ids: string[]; key: number }>({ ids: [], key: 0 });

  // A draft that does not parse yet is still a change: compare the raw draft, not what it sends.
  const snapshot = (d: SettingsDraft) => JSON.stringify(d);
  /** The settings as last loaded or saved, to tell a saved screen from one with changes. */
  let savedSettings = $state(untrack(() => snapshot(draft)));
  const dirty = $derived(snapshot(draft) !== savedSettings);
  /** The resources (fields or availability) with changes not saved, by id. */
  let dirtyResources = $state<Record<string, boolean>>({});
  const anythingUnsaved = $derived(dirty || Object.values(dirtyResources).some(Boolean));
  const leaveGuard = guardUnsavedChanges(
    () => anythingUnsaved,
    () => m.bookings_unsaved_leave()
  );
  const problems = $derived(draftProblems(draft));
  const rulesActive = $derived(activeRuleCount(draft));
  /** The one line under each title: what the fields hold now (D51). */
  const summaries = $derived(sectionSummaries(draft, space.resources.length));
  /** The data section's badge: how long answers and files are kept. */
  const retentionBadge = $derived(
    /^\d+$/.test(draft.retentionDays.trim())
      ? m.bookings_retention_badge({ days: draft.retentionDays.trim() })
      : undefined
  );
  const zones = $derived(timeZoneChoices(draft.timeZone));
  /** The step the availability editor offers times on: the SAVED one, which the server reads. */
  const savedStep = $derived(space.slotMode === 'step' ? space.stepMinutes : null);

  function problemOf(field: NumberField | 'name'): string | undefined {
    const p = problems[field];
    if (!p) return undefined;
    if (p === 'required' || field === 'name') return m.bookings_problem_required();
    return m.bookings_problem_range(NUMBER_BOUNDS[field as NumberField]);
  }

  async function saveSettings() {
    if (saving) return;
    const settings = settingsFromDraft(draft);
    if (!settings) {
      saveError = m.bookings_problems_summary();
      return;
    }
    saving = true;
    saveError = '';
    stranded = { ids: [], key: stranded.key };
    const formerName = space.name;
    try {
      await updateSpace(space.id, settings);
      // The server carries the hidden column's name along with the space's (WP-R1); the copy
      // here follows by the same rule, so the column reads right the moment it is revealed.
      const only = space.resources.length === 1 ? space.resources[0] : null;
      if (only && settings.name !== undefined && only.name === formerName) {
        only.name = settings.name;
      }
      space = { ...space, ...settings };
      savedSettings = snapshot(draft);
      Log.i('BOOKINGS', `settings saved space=${space.id.slice(0, 8)}`);
      onSaved(space);
    } catch (e) {
      saveError = describeBookingRefusal(e, m.bookings_save_settings());
      stranded = { ids: strandedIdsOf(e), key: stranded.key + 1 };
    } finally {
      saving = false;
    }
  }

  /** Opens the form naming the column that reveals the columns level (D44). */
  function startReveal() {
    newColumnName = m.bookings_resource_default_name();
    revealing = true;
    Log.d('BOOKINGS', `reveal columns space=${space.id.slice(0, 8)}`);
  }

  async function newResource(chosenName?: string) {
    if (addingResource) return;
    addingResource = true;
    resourceError = '';
    const name = chosenName?.trim() || m.bookings_resource_default_name();
    const position = space.resources.length;
    try {
      const { id } = await addResource(space.id, { name, position });
      space.resources.push({
        id,
        name,
        description: null,
        privateInfo: null,
        linkedUserId: null,
        position,
        lines: [],
        exceptions: [],
      });
      revealing = false;
      Log.i(
        'BOOKINGS',
        `column added space=${space.id.slice(0, 8)} columns=${space.resources.length}`
      );
    } catch (e) {
      resourceError = describeBookingRefusal(e, m.bookings_resource_add_button());
    } finally {
      addingResource = false;
    }
  }

  function resourceChanged(next: ManagedResource) {
    space.resources = space.resources.map((r) => (r.id === next.id ? next : r));
  }

  function resourceDeleted(id: string) {
    space.resources = space.resources.filter((r) => r.id !== id);
    delete dirtyResources[id];
  }

  let exporting = $state(false);
  let exportError = $state('');

  /** The bookings as an .xlsx (D24), its columns in this client's words, named after the space. */
  async function exportXlsx() {
    if (exporting) return;
    exporting = true;
    exportError = '';
    try {
      await downloadSpaceExport(space);
    } catch (e) {
      Log.i('BOOKINGS', `export refused: ${String(e)}`);
      exportError = describeBookingRefusal(e, m.bookings_export_button());
    } finally {
      exporting = false;
    }
  }

  async function removeSpace() {
    const question = BOOKING_NOTIFICATIONS_LIVE
      ? m.bookings_delete_space_confirm_notified({ name: space.name })
      : m.bookings_delete_space_confirm({ name: space.name });
    const confirmed = await showConfirm(question, {
      danger: true,
      confirmLabel: m.common_delete_button(),
    });
    if (!confirmed) return;
    try {
      await deleteSpace(space.id);
      Log.i('BOOKINGS', `space deleted from the editor id=${space.id.slice(0, 8)}`);
      // Nothing is left to save: the leave is the editor's own.
      leaveGuard.release();
      onDeleted();
    } catch (e) {
      saveError = describeBookingRefusal(e, m.common_delete_button());
    }
  }
</script>

<FormSection title={m.bookings_section_general()} summary={summaries.essentials} icon={Info}>
  <Input
    id="space-name"
    label={m.bookings_field_name()}
    bind:value={draft.name}
    maxlength={120}
    error={problemOf('name')}
  />
  <Textarea
    id="space-description"
    label={m.bookings_field_description()}
    bind:value={draft.description}
    rows={3}
    maxlength={4000}
  />
  <SpacePosterField
    spaceId={space.id}
    spaceName={space.name}
    poster={space.poster}
    onChanged={(poster) => {
      space.poster = poster;
      onSaved(space);
    }}
  />
  <div>
    <Select
      id="space-zone"
      label={m.bookings_field_time_zone()}
      hint={m.bookings_field_time_zone_hint()}
      value={draft.timeZone}
      options={zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))}
      onValueChange={(v) => (draft.timeZone = v)}
    />
  </div>
</FormSection>

<FormSection
  title={m.bookings_section_resources()}
  summary={summaries.when}
  icon={CalendarRange}
  badge={hidden ? undefined : String(space.resources.length)}
>
  <div>
    <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_mode()}</span>
    <SegmentedControl
      label={m.bookings_field_mode()}
      items={[
        { key: 'step', label: m.bookings_mode_step() },
        { key: 'slots', label: m.bookings_mode_slots() },
      ]}
      value={draft.slotMode}
      onSelect={(k) => (draft.slotMode = k)}
    />
    <p class={CONTROL_HINT_CLASS}>
      {draft.slotMode === 'step' ? m.bookings_mode_step_hint() : m.bookings_mode_slots_hint()}
    </p>
  </div>
  {#if draft.slotMode === 'step'}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Input
        id="space-step"
        label={m.bookings_field_step()}
        inputmode="numeric"
        bind:value={draft.stepMinutes}
        error={problemOf('stepMinutes')}
      />
      <Input
        id="space-max-steps"
        label={m.bookings_field_max_steps()}
        inputmode="numeric"
        bind:value={draft.maxSteps}
        error={problemOf('maxSteps')}
      />
    </div>
  {/if}

  {#if space.resources.length === 0}
    <p class="text-text-muted text-sm">{m.bookings_resource_none()}</p>
  {/if}
  {#if hidden}
    <div class="border-cn-border flex flex-wrap items-start gap-3 rounded-2xl border p-3 sm:p-4">
      <Columns3 size={18} class="text-text-muted mt-0.5 shrink-0" />
      <!-- A basis, so a phone wraps the button below the hint rather than crushing the hint. -->
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-text-main text-sm font-bold">{m.bookings_columns_hidden_title()}</p>
        <p class={CONTROL_HINT_CLASS}>{m.bookings_columns_hidden_hint()}</p>
      </div>
      {#if !revealing}
        <button
          type="button"
          onclick={startReveal}
          class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors"
        >
          <Plus size={16} />
          {m.bookings_resource_add_button()}
        </button>
      {/if}
      {#if revealing}
        <div class="w-full space-y-3">
          <Input
            id="space-new-column"
            label={m.bookings_columns_new_name()}
            bind:value={newColumnName}
            maxlength={120}
          />
          <div class="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onclick={() => (revealing = false)}
              class="text-text-main hover:bg-control-fill rounded-xl px-4 py-2.5 text-sm font-bold"
            >
              {m.common_cancel_button()}
            </button>
            <button
              type="button"
              onclick={() => newResource(newColumnName)}
              disabled={addingResource || !newColumnName.trim()}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-40"
            >
              <Plus size={16} />
              {m.bookings_columns_add_confirm()}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
  <div class="space-y-4">
    {#each space.resources as resource (resource.id)}
      <ResourceEditor
        {resource}
        spaceId={space.id}
        timeZone={space.timeZone}
        stepMinutes={savedStep}
        fixedSlots={space.slotMode === 'slots'}
        onChanged={resourceChanged}
        onDeleted={resourceDeleted}
        onDirty={(d) => (dirtyResources[resource.id] = d)}
        {hidden}
      />
    {/each}
  </div>
  {#if resourceError}
    <p
      class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-3 py-2.5 text-sm"
      role="alert"
    >
      {resourceError}
    </p>
  {/if}
  {#if !hidden}
    <button
      type="button"
      onclick={() => newResource()}
      disabled={addingResource}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-40"
    >
      <Plus size={16} />
      {m.bookings_resource_add_button()}
    </button>
  {/if}
</FormSection>

<FormSection title={m.bookings_section_who()} summary={summaries.who} icon={Users}>
  <!-- The forms' audience switch (FormAdvancedSettings): off is everybody (null), on starts an
         empty set of criteria for the editor to fill. -->
  <div class="space-y-3">
    <Toggle
      label={m.bookings_field_audience()}
      hint={m.bookings_field_audience_hint()}
      bind:checked={
        () => draft.audience != null,
        (on) => {
          draft.audience = on ? {} : null;
        }
      }
    />
    {#if draft.audience != null}
      <AudienceConditionEditor bind:condition={draft.audience} {tiers} {formations} />
    {/if}
  </div>
  <div>
    <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_names()}</span>
    <SegmentedControl
      label={m.bookings_field_names()}
      items={[
        { key: 'occupied', label: m.bookings_names_occupied() },
        { key: 'names', label: m.bookings_names_names() },
      ]}
      value={draft.nameVisibility}
      onSelect={(k) => (draft.nameVisibility = k)}
    />
  </div>
  <div>
    <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_discoverability()}</span>
    <SegmentedControl
      label={m.bookings_field_discoverability()}
      items={[
        { key: 'listed', label: m.bookings_discoverability_listed() },
        { key: 'link', label: m.bookings_discoverability_link() },
      ]}
      value={draft.discoverability}
      onSelect={(k) => (draft.discoverability = k)}
    />
  </div>
  <div>
    <Input
      id="space-max-people"
      label={m.bookings_field_max_people()}
      inputmode="numeric"
      bind:value={draft.maxPeople}
      error={problemOf('maxPeople')}
    />
    <p class={CONTROL_HINT_CLASS}>{m.bookings_field_max_people_hint()}</p>
  </div>
  <div>
    <Textarea
      id="space-private"
      label={m.bookings_field_private_info()}
      bind:value={draft.privateInfo}
      rows={2}
      maxlength={4000}
    />
    <p class={CONTROL_HINT_CLASS}>{m.bookings_field_private_info_hint()}</p>
  </div>
</FormSection>

<FormQuestionsSection
  bind:items={draft.items}
  requiresPayment={false}
  {tiers}
  {formations}
  fileHint={m.bookings_builder_file_hint()}
/>

<FormSection
  title={m.bookings_section_rules()}
  summary={summaries.rules}
  icon={ListChecks}
  collapsible
  startOpen={false}
  badge={rulesActive ? m.bookings_rules_badge({ count: rulesActive }) : undefined}
>
  <div>
    <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_opens_at()}</span>
    <DateTimeField
      density="default"
      id="space-opens-at"
      label={m.bookings_field_opens_at()}
      value={draft.opensAt}
      clearable
      onValueChange={(v) => (draft.opensAt = v)}
    />
    <p class={CONTROL_HINT_CLASS}>
      {m.bookings_field_opens_at_zone({ zone: draft.timeZone.replaceAll('_', ' ') })}
    </p>
  </div>
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <Input
      id="space-notice"
      label={m.bookings_field_min_notice()}
      inputmode="numeric"
      bind:value={draft.minNoticeMinutes}
      error={problemOf('minNoticeMinutes')}
    />
    <div>
      <Input
        id="space-horizon"
        label={m.bookings_field_horizon()}
        inputmode="numeric"
        bind:value={draft.horizonDays}
        error={problemOf('horizonDays')}
      />
      <p class={CONTROL_HINT_CLASS}>{m.bookings_field_horizon_hint()}</p>
    </div>
    <Input
      id="space-max-active"
      label={m.bookings_field_max_active()}
      inputmode="numeric"
      bind:value={draft.maxActiveBookings}
      error={problemOf('maxActiveBookings')}
    />
    <Input
      id="space-quota"
      label={m.bookings_field_quota()}
      inputmode="numeric"
      bind:value={draft.maxMinutesPerPeriod}
      error={problemOf('maxMinutesPerPeriod')}
    />
    <div>
      <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_quota_period()}</span>
      <SegmentedControl
        label={m.bookings_field_quota_period()}
        items={[
          { key: 'day', label: m.bookings_period_day() },
          { key: 'week', label: m.bookings_period_week() },
        ]}
        value={draft.quotaPeriod}
        onSelect={(k) => (draft.quotaPeriod = k)}
      />
    </div>
  </div>
  <p class={CONTROL_HINT_CLASS}>{m.bookings_field_empty_hint()}</p>
  <div>
    <Input
      id="space-withdraw"
      label={m.bookings_field_withdraw()}
      inputmode="numeric"
      bind:value={draft.participantWithdrawMinMinutes}
      error={problemOf('participantWithdrawMinMinutes')}
    />
    <p class={CONTROL_HINT_CLASS}>{m.bookings_field_withdraw_hint()}</p>
  </div>
  {#if BOOKING_NOTIFICATIONS_LIVE}
    <!-- The space's default reminder (Q-R1, the mockup's "Rappel envoye avant le creneau"). -->
    <Select
      id="space-reminder"
      label={m.bookings_reminder_space_label()}
      hint={m.bookings_reminder_space_hint()}
      value={draft.reminderMinutes}
      options={reminderOptions(reminderFromValue(draft.reminderMinutes))}
      onValueChange={(v) => (draft.reminderMinutes = v)}
    />
  {/if}
</FormSection>

<FormSection
  title={m.bookings_section_data()}
  summary={summaries.data}
  badge={retentionBadge}
  icon={Database}
  collapsible
  startOpen={false}
>
  <Input
    id="space-retention"
    label={m.bookings_field_retention()}
    inputmode="numeric"
    bind:value={draft.retentionDays}
    error={problemOf('retentionDays')}
  />
  <p class={CONTROL_HINT_CLASS}>{m.bookings_field_retention_hint()}</p>
  <div class="border-cn-border/60 space-y-2 border-t pt-4">
    <p class="text-text-muted text-sm">{m.bookings_export_hint()}</p>
    <button
      type="button"
      onclick={exportXlsx}
      disabled={exporting}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-40"
    >
      <Download size={16} />
      {m.bookings_export_button()}
    </button>
    {#if exportError}
      <p class="text-red-err text-xs font-medium" role="alert">{exportError}</p>
    {/if}
  </div>
  <div class="border-cn-border/60 space-y-2 border-t pt-4">
    <p class="text-text-muted text-sm">{m.bookings_delete_space_hint()}</p>
    <button
      type="button"
      onclick={removeSpace}
      class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors"
    >
      <Trash2 size={16} />
      {m.bookings_delete_space_button()}
    </button>
  </div>
</FormSection>

{#if saveError}
  <p
    class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
    role="alert"
  >
    {saveError}
  </p>
{/if}
{#if stranded.ids.length}
  {#key stranded.key}
    <StrandedBookings
      spaceId={space.id}
      ids={stranded.ids}
      resources={space.resources}
      timeZone={space.timeZone}
      onRetry={saveSettings}
    />
  {/key}
{/if}

<FormSaveBar
  titleMissing={!draft.name.trim()}
  isSubmitting={saving}
  summary={Object.keys(problems).length
    ? m.bookings_problems_summary()
    : dirty
      ? hidden
        ? m.bookings_unsaved_settings()
        : m.bookings_tab_resources_count({ count: space.resources.length })
      : m.bookings_saved()}
  saveLabel={m.bookings_save_settings()}
  onSave={saveSettings}
/>
