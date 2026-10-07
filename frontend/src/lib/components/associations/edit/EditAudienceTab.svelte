<script lang="ts">
  /**
   * The audience editor of an association or a list (audiences chantier, WP-B, user 2026-10-07):
   * THREE presets instead of the raw grid, for a BDE star and for a global admin. `everyone` is an
   * institution's alone (decision 6) - the SERVER refuses it elsewhere, hiding it here is only a
   * courtesy. The grid at `/admin/spaces` stays the global admin's tool for anything else.
   *
   * A reader with no campus anywhere (neither on the entity nor on their profile) cannot be offered
   * presets, which are computed from a campus: they get the profile prompt (decision 5). A global
   * admin reads the rules in force; a BDE star cannot (the read route is global-admin only), so the
   * editor opens with no preset ticked for them and says so.
   */
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { Globe, LoaderCircle } from '@lucide/svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import CheckboxGroup from '$lib/components/ui/CheckboxGroup.svelte';
  import ProfileCampusPrompt from '$lib/components/profile/ProfileCampusPrompt.svelte';
  import {
    listAllAudiences,
    setAssociationAudiences,
    type Association,
    type AudienceRule,
  } from '$lib/associations/api';
  import {
    offeredPresets,
    presetToRules,
    readPreset,
    type AudiencePreset,
  } from '$lib/associations/audiencePresets';
  import { audienceRefusalMessage } from '$lib/associations/audienceRefusal';
  import {
    CAMPUSES,
    FORMATIONS,
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import { fetchMyProfile } from '$lib/stores/user';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
    /** A global admin reads the rules in force and may pick any campus; a BDE star does neither. */
    isGlobalAdmin: boolean;
  }

  let { asso, isGlobalAdmin }: Props = $props();

  let loading = $state(true);
  let saving = $state(false);
  let profileCampus = $state<Campus | ''>('');
  /** `null` while unknown (a star), `[]` for an entity with no rule. */
  let currentRules = $state<AudienceRule[] | null>(null);
  let preset = $state<AudiencePreset | null>(null);
  let campus = $state<Campus | ''>('');
  /** The CheckboxGroup binds plain strings; they are only ever `FORMATIONS` values. */
  let ticked = $state<string[]>([]);
  const formations = $derived(ticked as Formation[]);

  const presets = $derived(offeredPresets(asso.type));
  const reading = $derived(currentRules ? readPreset(currentRules) : null);
  const customInForce = $derived(currentRules !== null && currentRules.length > 0 && !reading);
  const needsCampus = $derived(preset !== 'everyone');
  const noCampusAnywhere = $derived(!loading && !profileCampus && !campus);
  const formationsMissing = $derived(preset === 'formations' && formations.length === 0);
  const canSave = $derived(
    !saving && preset !== null && (!needsCampus || campus !== '') && !formationsMissing
  );

  const presetCopy = $derived<Record<AudiencePreset, { label: string; desc: string }>>({
    campus: { label: m.audience_preset_campus(), desc: m.audience_preset_campus_desc() },
    formations: {
      label: m.audience_preset_formations(),
      desc: m.audience_preset_formations_desc(),
    },
    everyone: { label: m.audience_preset_everyone(), desc: m.audience_preset_everyone_desc() },
  });
  const campusOptions = $derived<PickerOption[]>(
    CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) }))
  );
  const formationOptions = $derived(
    FORMATIONS.map((f) => ({ value: f, label: formationLabel(f) }))
  );

  onMount(async () => {
    try {
      const me = await fetchMyProfile();
      profileCampus = CAMPUSES.find((c) => c === me.campus) ?? '';
    } catch (err) {
      Log.d('audience.profile failed', err);
    }
    if (isGlobalAdmin) {
      try {
        currentRules = (await listAllAudiences())
          .filter((r) => r.associationId === asso.id)
          .map((r) => ({ formation: r.formation, campus: r.campus }));
      } catch (err) {
        Log.d('audience.rules failed', err);
      }
    }
    const read = currentRules ? readPreset(currentRules) : null;
    campus = (read && read.campus) || profileCampus;
    if (read) {
      preset = read.preset;
      ticked = [...read.formations];
    }
    loading = false;
  });

  async function save() {
    if (!canSave || preset === null) return;
    saving = true;
    const rules = presetToRules(preset, campus, formations);
    Log.d('audience.save', { association: asso.id, preset, rules: rules.length });
    try {
      currentRules = await setAssociationAudiences(asso.id, rules);
      showToast(m.audience_saved(), 'info');
    } catch (err) {
      Log.d('audience.save failed', err);
      showToast(audienceRefusalMessage(err) ?? m.audience_save_error());
    } finally {
      saving = false;
    }
  }
</script>

{#if loading}
  <div class="flex items-center justify-center py-12">
    <LoaderCircle class="animate-spin" size={24} />
  </div>
{:else if noCampusAnywhere && preset !== 'everyone'}
  <ProfileCampusPrompt />
{:else}
  <div
    class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-6 shadow-sm"
    data-audience-editor
  >
    <div>
      <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
        <Globe size={20} />
        {m.audience_heading()}
      </h2>
      <p class="text-text-muted mt-1 text-sm">{m.audience_intro()}</p>
    </div>

    <div class="space-y-2" role="radiogroup" aria-label={m.audience_heading()}>
      {#each presets as option (option)}
        {@const on = preset === option}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          data-audience-preset={option}
          onclick={() => (preset = option)}
          class="flex w-full flex-col items-start gap-0.5 rounded-xl border px-4 py-3 text-left transition-colors
 {on ? 'border-cn-yellow bg-cn-yellow/15' : 'border-cn-border hover:bg-cn-bg'}"
        >
          <span class="text-text-main text-sm font-bold">{presetCopy[option].label}</span>
          <span class="text-text-muted text-xs">{presetCopy[option].desc}</span>
        </button>
      {/each}
    </div>

    {#if needsCampus && preset !== null}
      {#if isGlobalAdmin}
        <div>
          <label for="audience-campus" class="text-text-main mb-2 ml-1 block text-sm font-bold"
            >{m.audience_campus_label()}</label
          >
          <Picker
            id="audience-campus"
            value={campus}
            options={campusOptions}
            label={m.audience_campus_label()}
            variant="field"
            density="default"
            onValueChange={(v) => (campus = v as Campus)}
          />
        </div>
      {:else if campus}
        <p class="text-text-main text-sm font-bold" data-audience-campus>
          {m.audience_campus_label()} : {campusLabel(campus)}
        </p>
      {/if}
    {/if}

    {#if preset === 'formations'}
      <CheckboxGroup
        label={m.audience_formations_label()}
        options={formationOptions}
        bind:selected={ticked}
      />
      {#if formationsMissing}
        <p class="text-text-muted text-xs" role="status">{m.audience_formations_required()}</p>
      {/if}
    {/if}

    {#if customInForce}
      <p class="text-text-muted text-xs" role="status">{m.audience_current_custom()}</p>
    {:else if currentRules === null && !isGlobalAdmin}
      <p class="text-text-muted text-xs" role="status">{m.audience_current_unknown()}</p>
    {/if}

    <button
      type="button"
      disabled={!canSave}
      onclick={save}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
    >
      {m.audience_save()}
    </button>

    {#if isGlobalAdmin}
      <a
        href={resolve('/admin/spaces')}
        class="text-text-main inline-block text-sm font-bold underline underline-offset-2"
      >
        {m.audience_grid_link()}
      </a>
    {/if}
  </div>
{/if}
