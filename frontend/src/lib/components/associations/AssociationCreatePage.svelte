<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    createAssociation,
    listAssociations,
    setAssociationAudiences,
    type Association,
  } from '$lib/associations/api';
  import { associationPickerOptions } from '$lib/associations/selectGroups';
  import { reachChoiceToRules, type ReachChoice } from '$lib/associations/audienceRules';
  import {
    CAMPUSES,
    FORMATIONS,
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import { fetchMyProfile, isGlobalAdmin } from '$lib/stores/user';
  import ProfileCampusPrompt from '$lib/components/profile/ProfileCampusPrompt.svelte';
  import {
    AUDIENCE_REFUSAL,
    audienceRefusalCode,
    audienceRefusalText,
  } from '$lib/associations/audienceRefusal';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';
  import { slugify } from '$lib/utils/textFold';

  interface Props {
    /** What this page creates: the three directories share ONE flow and differ by what it asks. */
    kind: 'association' | 'list' | 'institution';
  }

  let { kind }: Props = $props();

  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let contactEmail = $state('');
  /** Lists only. */
  let promo = $state<number | ''>('');
  let parentAssociationId = $state('');
  let parents = $state<Association[]>([]);
  /** Institutions only: the ceiling of their reach, written right after the creation. */
  let reach = $state<ReachChoice>('none');
  let reachCampus = $state<Campus | ''>('');
  let reachFormation = $state<Formation | ''>('');
  let submitting = $state(false);
  let error = $state('');
  /**
   * The creator's profile has no campus (decision 5 of the audiences chantier): an association or a
   * list takes its creator's campus as its default audience, so the profile prompt replaces the form
   * rather than letting the server's refusal be the first the creator hears of it.
   */
  let campusMissing = $state(false);

  /** Everything that differs between the three kinds, resolved at render (Paraglide). */
  const copy = $derived(
    {
      association: {
        heading: m.assoc_new_heading(),
        back: m.assoc_new_back(),
        backHref: '/associations',
        nameLabel: m.assoc_new_name_label(),
        namePlaceholder: m.assoc_new_name_placeholder(),
        slugPlaceholder: 'bureau-des-eleves',
        descPlaceholder: m.assoc_new_desc_placeholder(),
        emailPlaceholder: 'contact@asso.fr',
        submit: m.assoc_new_create_btn(),
        failure: m.assoc_new_error_fallback(),
      },
      list: {
        heading: m.list_new_create_btn(),
        back: m.list_new_back(),
        backHref: '/lists',
        nameLabel: m.list_new_name_label(),
        namePlaceholder: m.list_new_name_placeholder(),
        slugPlaceholder: 'liste-canari-2027',
        descPlaceholder: m.list_new_desc_placeholder(),
        emailPlaceholder: 'contact@liste.fr',
        submit: m.list_new_create_btn(),
        failure: m.list_new_error_fallback(),
      },
      institution: {
        heading: m.inst_new_create_btn(),
        back: m.inst_new_back(),
        backHref: '/institutions',
        nameLabel: m.inst_new_name_label(),
        namePlaceholder: m.inst_new_name_placeholder(),
        slugPlaceholder: 'maison-des-eleves-gardanne',
        descPlaceholder: m.inst_new_desc_placeholder(),
        emailPlaceholder: 'contact@emse.fr',
        submit: m.inst_new_create_btn(),
        failure: m.inst_new_error_fallback(),
      },
    }[kind]
  );

  const parentOptions = $derived<PickerOption[]>([
    { value: '', label: m.list_new_parent_none() },
    ...associationPickerOptions(parents),
  ]);
  const reachOptions = $derived<PickerOption[]>([
    { value: 'none', label: m.inst_new_reach_none() },
    { value: 'school', label: m.inst_new_reach_school() },
    { value: 'campus', label: m.inst_new_reach_campus() },
    { value: 'cell', label: m.inst_new_reach_cell() },
  ]);
  const campusOptions = $derived<PickerOption[]>(
    CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) }))
  );
  const formationOptions = $derived<PickerOption[]>(
    FORMATIONS.map((f) => ({ value: f, label: formationLabel(f) }))
  );

  /** A choice that still lacks its campus or formation cannot be submitted (it would reach nobody). */
  const reachIncomplete = $derived(
    kind === 'institution' &&
      ((reach === 'campus' && !reachCampus) ||
        (reach === 'cell' && (!reachCampus || !reachFormation)))
  );

  onMount(async () => {
    // D20/D24: the server refuses anyone else, so a reader who cannot create one is sent back
    // rather than shown a form that can only fail.
    if (kind === 'institution' && !isGlobalAdmin()) {
      void goto(resolve('/institutions'), { replaceState: true });
      return;
    }
    if (kind !== 'institution') {
      try {
        const me = await fetchMyProfile();
        campusMissing = !CAMPUSES.some((c) => c === me.campus);
      } catch (err) {
        // Unknown is not "missing": the server's typed refusal still answers on submit.
        Log.d('create.profile failed', err);
      }
    }
    if (kind === 'list') {
      try {
        parents = await listAssociations('association');
      } catch (err) {
        Log.d('create.parents failed', err);
        parents = [];
      }
    }
  });

  function onNameInput() {
    slug = slugify(name);
  }

  async function handleSubmit() {
    if (!name.trim() || !slug.trim()) {
      error = m.assoc_new_error_required();
      return;
    }
    submitting = true;
    error = '';
    try {
      const created = await createAssociation({
        name: name.trim(),
        slug: slug.trim(),
        type: kind === 'association' ? undefined : kind,
        description: description.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        ...(kind === 'list'
          ? {
              promo: promo !== '' ? Number(promo) : undefined,
              parentAssociationId: parentAssociationId || undefined,
            }
          : {}),
      });
      if (kind === 'institution') {
        await finishInstitution(created);
        return;
      }
      await goto(resolve(`${kind === 'list' ? '/lists' : '/associations'}/${created.slug}`));
    } catch (err) {
      Log.d(`create.submit failed (${kind})`, err);
      const refusal = audienceRefusalCode(err);
      if (refusal === AUDIENCE_REFUSAL.CREATOR_CAMPUS_REQUIRED) {
        campusMissing = true;
      } else {
        error = refusal ? audienceRefusalText(refusal) : copy.failure;
      }
    } finally {
      submitting = false;
    }
  }

  /**
   * Writes the audience chosen on the form, then opens the members tab: an institution is usable
   * once it has a reach and people who may publish in its name. The institution EXISTS by now, so a
   * failed write is announced and the reader still lands where they can fix it - staying here would
   * invite a second creation of the same slug.
   */
  async function finishInstitution(created: Association) {
    const rules = reachChoiceToRules(reach, reachCampus, reachFormation);
    if (rules.length > 0) {
      try {
        await setAssociationAudiences(created.id, rules);
      } catch (err) {
        Log.d('create.audiences failed', err);
        showToast(m.inst_new_reach_error());
      }
    }
    await goto(resolve(`/associations/${created.slug}/edit/members`));
  }
</script>

<PageContainer>
  <PageHeader title={copy.heading} backHref={copy.backHref} backLabel={copy.back} />

  {#if campusMissing}
    <ProfileCampusPrompt />
  {:else}
    <form
      class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-6"
      onsubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <Input
        label={copy.nameLabel}
        bind:value={name}
        oninput={onNameInput}
        placeholder={copy.namePlaceholder}
        required
      />

      <Input label="Slug (URL)" bind:value={slug} placeholder={copy.slugPlaceholder} required />
      <p class="text-text-muted -mt-3 text-xs">
        {m.assoc_new_slug_hint()}
      </p>

      {#if kind === 'list'}
        <Input
          label={m.list_new_promo_label()}
          type="number"
          bind:value={promo}
          placeholder="2027"
        />

        <div>
          <label for="create-parent" class="text-text-main mb-2 ml-1 block text-sm font-bold"
            >{m.list_new_parent_label()}</label
          >
          <Picker
            id="create-parent"
            value={parentAssociationId}
            options={parentOptions}
            label={m.list_new_parent_label()}
            variant="field"
            density="default"
            onValueChange={(v) => (parentAssociationId = v)}
          />
        </div>
      {/if}

      <Textarea
        label={m.assoc_new_desc_label()}
        bind:value={description}
        placeholder={copy.descPlaceholder}
        rows={3}
      />

      <Input
        label={m.assoc_new_email_label()}
        type="email"
        bind:value={contactEmail}
        placeholder={copy.emailPlaceholder}
      />

      {#if kind === 'institution'}
        <div class="space-y-3">
          <div>
            <label for="create-reach" class="text-text-main mb-2 ml-1 block text-sm font-bold"
              >{m.inst_new_reach_label()}</label
            >
            <Picker
              id="create-reach"
              value={reach}
              options={reachOptions}
              label={m.inst_new_reach_label()}
              variant="field"
              density="default"
              onValueChange={(v) => (reach = v as ReachChoice)}
            />
            <p class="text-text-muted mt-2 ml-1 text-xs">{m.inst_new_reach_hint()}</p>
          </div>
          {#if reach === 'campus' || reach === 'cell'}
            <div class="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  for="create-reach-campus"
                  class="text-text-main mb-2 ml-1 block text-sm font-bold"
                  >{m.inst_new_reach_campus_label()}</label
                >
                <Picker
                  id="create-reach-campus"
                  value={reachCampus}
                  options={campusOptions}
                  label={m.inst_new_reach_campus_label()}
                  variant="field"
                  density="default"
                  onValueChange={(v) => (reachCampus = v as Campus)}
                />
              </div>
              {#if reach === 'cell'}
                <div>
                  <label
                    for="create-reach-formation"
                    class="text-text-main mb-2 ml-1 block text-sm font-bold"
                    >{m.inst_new_reach_formation_label()}</label
                  >
                  <Picker
                    id="create-reach-formation"
                    value={reachFormation}
                    options={formationOptions}
                    label={m.inst_new_reach_formation_label()}
                    variant="field"
                    density="default"
                    onValueChange={(v) => (reachFormation = v as Formation)}
                  />
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if error}
        <div
          class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
        >
          {error}
        </div>
      {/if}

      <button
        type="submit"
        disabled={submitting || !name.trim() || !slug.trim() || reachIncomplete}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? m.common_creating_label() : copy.submit}
      </button>
    </form>
  {/if}
</PageContainer>
