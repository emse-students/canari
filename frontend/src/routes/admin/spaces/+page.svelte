<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    listAssociations,
    listSpaces,
    openSpace,
    closeSpace,
    setSpaceBde,
    getAssociationAudiences,
    setAssociationAudiences,
    SocialApiError,
    type Association,
    type AudienceRule,
    type SpaceRow,
  } from '$lib/associations/api';
  import {
    CAMPUSES,
    FORMATIONS,
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { Layers, Plus, Trash2, LoaderCircle } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let spaces = $state<SpaceRow[]>([]);
  let associations = $state<Association[]>([]);

  let newFormation = $state<Formation>('ICM');
  let newCampus = $state<Campus>('saint-etienne');
  let opening = $state(false);
  /** The space whose BDE is being persisted. */
  let savingBdeFor = $state<string | null>(null);

  let audienceFor = $state('');
  let rules = $state<AudienceRule[]>([]);
  let rulesLoading = $state(false);
  let rulesSaving = $state(false);
  let rulesMessage = $state<string | null>(null);
  let rulesError = $state<string | null>(null);

  const formationOptions: PickerOption[] = FORMATIONS.map((f) => ({
    value: f,
    label: formationLabel(f),
  }));
  const campusOptions: PickerOption[] = CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) }));
  const ruleFormationOptions = $derived<PickerOption[]>([
    { value: '', label: m.admin_audiences_formation_any() },
    ...formationOptions,
  ]);
  const ruleCampusOptions = $derived<PickerOption[]>([
    { value: '', label: m.admin_audiences_campus_any() },
    ...campusOptions,
  ]);
  /** Only a regular association can be a BDE: a list is not one (the server refuses it too). */
  const bdeCandidates = $derived(
    [...associations].filter((a) => a.type !== 'list').sort((a, b) => a.name.localeCompare(b.name))
  );
  const bdeOptions = $derived<PickerOption[]>([
    { value: '', label: m.admin_spaces_bde_none() },
    ...bdeCandidates.map((a) => ({ value: a.id, label: a.name })),
  ]);
  const associationOptions = $derived<PickerOption[]>(
    [...associations]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ value: a.id, label: a.name }))
  );

  async function load() {
    loading = true;
    error = null;
    try {
      [spaces, associations] = await Promise.all([listSpaces(), listAssociations()]);
    } catch (e) {
      Log.d('admin.spaces.load failed', e);
      error = m.admin_spaces_load_error();
    } finally {
      loading = false;
    }
  }

  async function open() {
    opening = true;
    error = null;
    try {
      await openSpace(newFormation, newCampus);
      spaces = await listSpaces();
    } catch (e) {
      Log.d('admin.spaces.open failed', e);
      error =
        e instanceof SocialApiError && e.status === 409
          ? m.admin_spaces_already_open()
          : m.admin_spaces_open_error();
    } finally {
      opening = false;
    }
  }

  async function designateBde(space: SpaceRow, associationId: string) {
    savingBdeFor = space.id;
    error = null;
    try {
      await setSpaceBde(space.id, associationId || null);
      spaces = await listSpaces();
    } catch (e) {
      Log.d('admin.spaces.setBde failed', e);
      error = bdeRefusal(e);
      // The picker shows what the user chose, not what the server kept: reload so it never lies.
      spaces = await listSpaces().catch(() => spaces);
    } finally {
      savingBdeFor = null;
    }
  }

  /** The sentence for a refused BDE designation, chosen by the HTTP status (never by the message). */
  function bdeRefusal(e: unknown): string {
    if (e instanceof SocialApiError) {
      if (e.status === 409) return m.admin_spaces_bde_taken();
      if (e.status === 400) return m.admin_spaces_bde_not_association();
      if (e.status === 404) return m.admin_spaces_bde_missing();
    }
    return m.admin_spaces_bde_error();
  }

  async function close(space: SpaceRow) {
    const name = `${formationLabel(space.formation)} · ${campusLabel(space.campus)}`;
    if (
      !(await showConfirm(m.admin_spaces_close_confirm({ name }), {
        danger: true,
        confirmLabel: m.admin_spaces_close_btn(),
      }))
    )
      return;
    savingBdeFor = space.id;
    error = null;
    try {
      await closeSpace(space.id);
    } catch (e) {
      Log.d('admin.spaces.close failed', e);
      error = m.admin_spaces_close_error();
    } finally {
      savingBdeFor = null;
    }
    spaces = await listSpaces().catch(() => spaces);
  }

  async function chooseAssociation(id: string) {
    audienceFor = id;
    rules = [];
    rulesMessage = null;
    rulesError = null;
    if (!id) return;
    rulesLoading = true;
    try {
      rules = await getAssociationAudiences(id);
    } catch (e) {
      Log.d('admin.spaces.getAudiences failed', e);
      rulesError = m.admin_audiences_load_error();
    } finally {
      rulesLoading = false;
    }
  }

  function addRule() {
    rules = [...rules, { formation: null, campus: null }];
  }

  function removeRule(index: number) {
    rules = rules.filter((_, i) => i !== index);
  }

  function patchRule(index: number, patch: Partial<AudienceRule>) {
    rules = rules.map((r, i) => (i === index ? { ...r, ...patch } : r));
  }

  async function saveRules() {
    if (rules.length === 0) {
      rulesError = m.admin_audiences_min_one();
      return;
    }
    rulesSaving = true;
    rulesMessage = null;
    rulesError = null;
    try {
      rules = await setAssociationAudiences(audienceFor, rules);
      spaces = await listSpaces();
      rulesMessage = m.admin_audiences_saved();
    } catch (e) {
      Log.d('admin.spaces.setAudiences failed', e);
      rulesError = m.admin_audiences_save_error();
    } finally {
      rulesSaving = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    void load();
  });

  const triggerClass =
    'border-cn-border text-text-main flex w-full items-center justify-between gap-2 rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-left text-sm';
</script>

<div class="space-y-6">
  <header class="flex items-start gap-3">
    <span
      class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
    >
      <Layers size={20} />
    </span>
    <div>
      <h2 class="text-text-main text-lg font-bold">{m.admin_spaces_title()}</h2>
      <p class="text-text-muted mt-0.5 text-sm">{m.admin_spaces_subtitle()}</p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    <section class="space-y-3">
      <div
        class="border-cn-border divide-cn-border/70 divide-y overflow-hidden rounded-2xl border bg-(--cn-surface)"
      >
        {#if spaces.length === 0}
          <p class="text-text-muted px-4 py-8 text-center text-sm">{m.admin_spaces_none()}</p>
        {:else}
          {#each spaces as space (space.id)}
            <div class="grid gap-3 px-4 py-3 sm:grid-cols-2 sm:items-center">
              <div class="min-w-0">
                <span class="text-text-main block text-sm font-semibold">
                  {formationLabel(space.formation)} · {campusLabel(space.campus)}
                </span>
                <span class="text-text-muted block text-xs">
                  {m.admin_spaces_assoc_count({ count: space.associationCount })}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <Picker
                    id="bde-{space.id}"
                    value={space.bde?.id ?? ''}
                    options={bdeOptions}
                    label={m.admin_spaces_bde_label()}
                    {triggerClass}
                    onValueChange={(v) => designateBde(space, v)}
                  />
                </div>
                {#if savingBdeFor === space.id}
                  <LoaderCircle size={14} class="text-cn-yellow animate-spin" />
                {/if}
                <button
                  type="button"
                  onclick={() => close(space)}
                  disabled={savingBdeFor === space.id}
                  aria-label={m.admin_spaces_close_aria()}
                  class="text-text-muted rounded-xl p-2 hover:text-red-500 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <span class="text-text-muted mb-1 block text-xs font-semibold">
            {m.admin_spaces_open_title()}
          </span>
          <Picker
            id="new-formation"
            value={newFormation}
            options={formationOptions}
            label={m.directory_label_formation()}
            {triggerClass}
            onValueChange={(v) => (newFormation = v as Formation)}
          />
        </div>
        <Picker
          id="new-campus"
          value={newCampus}
          options={campusOptions}
          label={m.directory_label_campus()}
          {triggerClass}
          onValueChange={(v) => (newCampus = v as Campus)}
        />
        <button
          type="button"
          disabled={opening}
          onclick={open}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
        >
          {#if opening}
            <LoaderCircle size={14} class="animate-spin" />
          {:else}
            <Plus size={14} />
          {/if}
          {m.admin_spaces_open_btn()}
        </button>
      </div>
    </section>

    <section class="space-y-3">
      <div>
        <h3 class="text-text-main text-base font-bold">{m.admin_audiences_title()}</h3>
        <p class="text-text-muted mt-0.5 text-sm">{m.admin_audiences_hint()}</p>
      </div>

      <Picker
        id="audience-association"
        value={audienceFor}
        options={[{ value: '', label: m.admin_audiences_pick() }, ...associationOptions]}
        label={m.admin_audiences_pick()}
        {triggerClass}
        onValueChange={chooseAssociation}
      />

      {#if audienceFor}
        {#if rulesLoading}
          <LoaderCircle size={16} class="text-cn-yellow animate-spin" />
        {:else}
          <div class="space-y-2">
            {#each rules as rule, index (index)}
              <div class="grid items-center gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Picker
                  id="rule-formation-{index}"
                  value={rule.formation ?? ''}
                  options={ruleFormationOptions}
                  label={m.directory_label_formation()}
                  {triggerClass}
                  onValueChange={(v) =>
                    patchRule(index, { formation: v === '' ? null : (v as Formation) })}
                />
                <Picker
                  id="rule-campus-{index}"
                  value={rule.campus ?? ''}
                  options={ruleCampusOptions}
                  label={m.directory_label_campus()}
                  {triggerClass}
                  onValueChange={(v) =>
                    patchRule(index, { campus: v === '' ? null : (v as Campus) })}
                />
                <button
                  type="button"
                  onclick={() => removeRule(index)}
                  aria-label={m.admin_audiences_remove()}
                  class="text-text-muted rounded-xl p-2 hover:text-red-500"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            {/each}
          </div>

          {#if rulesError}
            <p class="text-sm text-red-500" role="alert">{rulesError}</p>
          {/if}
          {#if rulesMessage}
            <p class="text-sm text-emerald-600">{rulesMessage}</p>
          {/if}

          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              onclick={addRule}
              class="border-cn-border text-text-main inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              <Plus size={14} />
              {m.admin_audiences_add()}
            </button>
            <button
              type="button"
              disabled={rulesSaving}
              onclick={saveRules}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold disabled:opacity-50"
            >
              {#if rulesSaving}
                <LoaderCircle size={14} class="animate-spin" />
              {/if}
              {m.admin_audiences_save()}
            </button>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>
