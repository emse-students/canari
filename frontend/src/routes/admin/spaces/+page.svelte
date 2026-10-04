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
  import { Check, Layers, Plus, Star, Trash2, LoaderCircle } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let spaces = $state<SpaceRow[]>([]);
  let associations = $state<Association[]>([]);

  let newFormation = $state<Formation>('ICM');
  let newCampus = $state<Campus>('saint-etienne');
  let opening = $state(false);
  /** The cell or column being persisted, so a second click cannot race the first. */
  let busy = $state<string | null>(null);

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
  const sortedAssociations = $derived(
    [...associations].sort((a, b) => a.name.localeCompare(b.name))
  );
  const associationOptions = $derived<PickerOption[]>(
    sortedAssociations.map((a) => ({ value: a.id, label: a.name }))
  );

  /** The column title of a space, also used in every cell's accessible name. */
  function spaceName(space: SpaceRow): string {
    return `${formationLabel(space.formation)} · ${campusLabel(space.campus)}`;
  }

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

  /** The sentence for a refused BDE designation, chosen by the HTTP status (never by the message). */
  function bdeRefusal(e: unknown): string {
    if (e instanceof SocialApiError) {
      if (e.status === 400) return m.admin_spaces_bde_not_association();
      if (e.status === 404) return m.admin_spaces_bde_missing();
    }
    return m.admin_spaces_bde_error();
  }

  /**
   * Makes an association the BDE of a space, or clears it when it already is. A BDE always reaches
   * the space it governs, so designating one that does not yet adds the rule for that pair.
   */
  async function toggleBde(space: SpaceRow, association: Association) {
    busy = `${space.id}:${association.id}`;
    error = null;
    try {
      if (space.bde?.id !== association.id && !space.reachedBy.includes(association.id)) {
        const current = await getAssociationAudiences(association.id);
        await setAssociationAudiences(association.id, [
          ...current,
          { formation: space.formation, campus: space.campus },
        ]);
      }
      await setSpaceBde(space.id, space.bde?.id === association.id ? null : association.id);
    } catch (e) {
      Log.d('admin.spaces.setBde failed', e);
      error = bdeRefusal(e);
    } finally {
      busy = null;
    }
    // The grid shows what the server kept, not what was clicked.
    spaces = await listSpaces().catch(() => spaces);
  }

  /**
   * Adds or removes the rule for exactly this space. A cell reached only by a WIDER rule (a whole
   * campus) is not a rule of its own, so there is nothing to remove: say where to edit it.
   */
  async function toggleReach(space: SpaceRow, association: Association) {
    const exact = space.exactBy.includes(association.id);
    if (!exact && space.reachedBy.includes(association.id)) {
      error = m.admin_spaces_cell_wide({ association: association.name, space: spaceName(space) });
      return;
    }
    busy = `${space.id}:${association.id}`;
    error = null;
    try {
      const current = await getAssociationAudiences(association.id);
      const others = current.filter(
        (r) => !(r.formation === space.formation && r.campus === space.campus)
      );
      const next = exact
        ? others
        : [...others, { formation: space.formation, campus: space.campus }];
      if (next.length === 0) {
        error = m.admin_audiences_min_one();
        return;
      }
      await setAssociationAudiences(association.id, next);
    } catch (e) {
      Log.d('admin.spaces.toggleReach failed', e);
      error = m.admin_audiences_save_error();
    } finally {
      busy = null;
    }
    spaces = await listSpaces().catch(() => spaces);
  }

  async function close(space: SpaceRow) {
    if (
      !(await showConfirm(m.admin_spaces_close_confirm({ name: spaceName(space) }), {
        danger: true,
        confirmLabel: m.admin_spaces_close_btn(),
      }))
    )
      return;
    busy = space.id;
    error = null;
    try {
      await closeSpace(space.id);
    } catch (e) {
      Log.d('admin.spaces.close failed', e);
      error = m.admin_spaces_close_error();
    } finally {
      busy = null;
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
  const cellButton =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-50';
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
      <p class="text-text-muted text-xs">{m.admin_spaces_legend()}</p>

      {#if spaces.length === 0}
        <p
          class="border-cn-border text-text-muted rounded-2xl border bg-(--cn-surface) px-4 py-8 text-center text-sm"
        >
          {m.admin_spaces_none()}
        </p>
      {:else}
        <div class="border-cn-border overflow-x-auto rounded-2xl border bg-(--cn-surface)">
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr class="border-cn-border border-b">
                <th class="text-text-muted px-4 py-3 text-left text-xs font-semibold">
                  {m.admin_spaces_col_assoc()}
                </th>
                {#each spaces as space (space.id)}
                  <th class="min-w-32 px-3 py-3 text-center">
                    <div class="flex items-center justify-center gap-1">
                      <span class="text-text-main text-xs font-semibold">{spaceName(space)}</span>
                      <button
                        type="button"
                        onclick={() => close(space)}
                        disabled={busy === space.id}
                        aria-label={m.admin_spaces_close_aria()}
                        class="text-text-muted rounded-lg p-1 hover:text-red-500 disabled:opacity-50"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody class="divide-cn-border/70 divide-y">
              {#each sortedAssociations as association (association.id)}
                <tr>
                  <th class="text-text-main px-4 py-2 text-left text-sm font-medium">
                    {association.name}
                  </th>
                  {#each spaces as space (space.id)}
                    {@const reaches = space.reachedBy.includes(association.id)}
                    {@const isBde = space.bde?.id === association.id}
                    {@const pending = busy === `${space.id}:${association.id}`}
                    <td class="px-3 py-2 text-center">
                      <div class="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={pending}
                          aria-pressed={reaches}
                          aria-label={m.admin_spaces_reach_aria({
                            association: association.name,
                            space: spaceName(space),
                          })}
                          onclick={() => toggleReach(space, association)}
                          class="{cellButton} {reaches
                            ? 'border-cn-yellow bg-cn-yellow/20 text-cn-dark'
                            : 'border-cn-border hover:text-text-muted text-transparent'}"
                        >
                          {#if pending}
                            <LoaderCircle size={14} class="animate-spin" />
                          {:else}
                            <Check size={14} />
                          {/if}
                        </button>
                        {#if association.type !== 'list'}
                          <button
                            type="button"
                            disabled={pending}
                            aria-pressed={isBde}
                            aria-label={m.admin_spaces_bde_aria({
                              association: association.name,
                              space: spaceName(space),
                            })}
                            onclick={() => toggleBde(space, association)}
                            class="{cellButton} {isBde
                              ? 'border-cn-yellow bg-cn-yellow text-cn-ink'
                              : 'border-cn-border hover:text-text-muted text-transparent'}"
                          >
                            <Star size={14} />
                          </button>
                        {:else}
                          <span class="h-8 w-8" aria-hidden="true"></span>
                        {/if}
                      </div>
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

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

    <details class="border-cn-border rounded-2xl border bg-(--cn-surface) px-4 py-3">
      <summary class="text-text-main cursor-pointer text-sm font-semibold">
        {m.admin_spaces_advanced()}
      </summary>
      <div class="mt-3 space-y-3">
        <p class="text-text-muted text-sm">{m.admin_audiences_hint()}</p>

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
      </div>
    </details>
  {/if}
</div>
