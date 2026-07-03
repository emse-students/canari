<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import {
    updateAssociation,
    uploadAssociationLogo,
    deleteAssociationLogo,
    listAssociations,
    type Association,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Check } from '@lucide/svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { m } from '$lib/paraglide/messages';
  import AssociationLogoCropper from '$lib/components/associations/AssociationLogoCropper.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import ColorPicker from '$lib/components/ui/ColorPicker.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';

  interface Props {
    asso: Association;
    /** Whether the caller may edit the profile and logo (MANAGE_MEMBERS / global admin). */
    canEdit: boolean;
    /** Called with the refreshed association after any successful mutation. */
    onUpdated: (a: Association) => void;
  }

  let { asso, canEdit, onUpdated }: Props = $props();

  // Editable copies seeded once from the association passed at mount.
  const initial = untrack(() => asso);
  let editName = $state(initial.name);
  let editDescription = $state(initial.description ?? '');
  let editBioMarkdown = $state(initial.bioMarkdown ?? '');
  /** Hex color for calendar display, or "" to use auto-generated color. */
  let editColor = $state(initial.color ?? '');
  /** Public contact e-mail, or "" when none. */
  let editContactEmail = $state(initial.contactEmail ?? '');

  // ── List-only fields (campaign year, parent association, optional 2nd theme) ──
  const isList = initial.type === 'list';
  let editPromo = $state<number | ''>(initial.promo ?? '');
  let editParentId = $state(initial.parentAssociationId ?? '');
  let editName2 = $state(initial.name2 ?? '');
  /** Candidate parent associations (regular associations only), for the select. */
  let parentOptions = $state<Association[]>([]);

  onMount(async () => {
    if (!isList) return;
    try {
      parentOptions = (await listAssociations('association')).filter((a) => !a.archived);
    } catch {
      parentOptions = [];
    }
  });

  /** Material You-inspired tonal palette (tone ~60, moderate saturation). */
  const PRESET_COLORS = [
    '#6B92D1',
    '#5BA8A0',
    '#5EA86C',
    '#8BAC5A',
    '#ACA05A',
    '#AC7A5A',
    '#AC5E5E',
    '#AC5E8C',
    '#8C5EAC',
    '#6E7EAC',
    '#5EA8A8',
    '#7CAC7C',
  ] as const;

  let saving = $state(false);
  let saveSuccess = $state(false);
  let settingsError = $state('');
  let logoBusy = $state(false);
  let showCropper = $state(false);

  async function handleSaveProfile() {
    saving = true;
    settingsError = '';
    saveSuccess = false;
    try {
      const updated = await updateAssociation(asso.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim(),
        bioMarkdown: editBioMarkdown.trim(),
        color: editColor.trim() || null,
        contactEmail: editContactEmail.trim() || null,
        ...(isList
          ? {
              promo: editPromo === '' ? null : Number(editPromo),
              parentAssociationId: editParentId || null,
              name2: editName2.trim() || null,
            }
          : {}),
      });
      editDescription = updated.description ?? '';
      editBioMarkdown = updated.bioMarkdown ?? '';
      editColor = updated.color ?? '';
      editContactEmail = updated.contactEmail ?? '';
      editPromo = updated.promo ?? '';
      editParentId = updated.parentAssociationId ?? '';
      editName2 = updated.name2 ?? '';
      onUpdated(updated);
      saveSuccess = true;
      setTimeout(() => (saveSuccess = false), 3500);
    } catch (err) {
      settingsError = err instanceof Error ? err.message : m.common_save_error();
    } finally {
      saving = false;
    }
  }

  async function onLogoExported(blob: Blob) {
    logoBusy = true;
    settingsError = '';
    try {
      const file = new File([blob], 'logo.jpg', { type: 'image/jpeg' });
      onUpdated(await uploadAssociationLogo(asso.id, file));
      showCropper = false;
    } catch (err) {
      settingsError = err instanceof Error ? err.message : m.asso_edit_logo_upload_error();
    } finally {
      logoBusy = false;
    }
  }

  async function handleRemoveLogo() {
    if (
      !(await showConfirm(m.asso_edit_logo_remove_confirm(), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    )
      return;
    logoBusy = true;
    try {
      onUpdated(await deleteAssociationLogo(asso.id));
    } catch (err) {
      settingsError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      logoBusy = false;
    }
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
  <h2 class="text-lg font-bold text-text-main tracking-tight">{m.asso_edit_profile_title()}</h2>
  <div class="flex flex-wrap items-start gap-4">
    <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
    {#if canEdit}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => (showCropper = !showCropper)}
          disabled={logoBusy}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg disabled:opacity-50"
        >
          {showCropper ? m.asso_edit_logo_close_cropper() : m.asso_edit_logo_change()}
        </button>
        {#if asso.logoUrl}
          <button
            type="button"
            onclick={handleRemoveLogo}
            disabled={logoBusy}
            class="rounded-xl px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {m.asso_edit_logo_remove()}
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if showCropper}
    <AssociationLogoCropper onExport={onLogoExported} onCancel={() => (showCropper = false)} />
  {/if}

  <Input label={m.asso_edit_name_label()} bind:value={editName} />

  {#if isList}
    <Input
      label={m.list_new_name2_label()}
      bind:value={editName2}
      placeholder={m.list_new_name2_placeholder()}
    />
    <Input label={m.list_new_promo_label()} type="number" bind:value={editPromo} placeholder="2027" />
    <div>
      <label for="edit-list-parent" class="block text-sm font-bold text-text-main mb-2 ml-1">
        {m.list_new_parent_label()}
      </label>
      <select
        id="edit-list-parent"
        bind:value={editParentId}
        class="w-full rounded-xl border border-cn-border bg-cn-bg/30 px-4 py-2.5 text-sm text-text-main"
      >
        <option value="">{m.list_new_parent_none()}</option>
        {#each parentOptions as opt (opt.id)}
          <option value={opt.id}>{opt.name}</option>
        {/each}
      </select>
    </div>
  {/if}

  <Input
    label={m.asso_edit_contact_email_label()}
    type="email"
    bind:value={editContactEmail}
    placeholder="contact@asso.fr"
  />
  <div class="space-y-2">
    <span class="block text-sm font-bold text-text-main ml-1">{m.asso_edit_description_label()}</span>
    <MarkdownComposerField
      bind:value={editDescription}
      maxlength={2000}
      minHeight="72px"
      class="rounded-xl border border-cn-border bg-cn-bg/30 overflow-hidden"
      editorClass="min-h-[72px] w-full px-4 py-3 text-sm text-text-main leading-relaxed"
      placeholder={m.asso_edit_description_placeholder()}
    />
  </div>
  <div class="space-y-2">
    <span class="block text-sm font-bold text-text-main ml-1">{m.asso_edit_bio_label()}</span>
    <MarkdownComposerField
      bind:value={editBioMarkdown}
      maxlength={16000}
      minHeight="160px"
      class="rounded-xl border border-cn-border bg-cn-bg/30 overflow-hidden"
      editorClass="min-h-[160px] w-full px-4 py-3 text-sm text-text-main leading-relaxed"
      placeholder={m.asso_edit_bio_placeholder()}
    />
  </div>
  <div class="flex flex-col gap-3">
    <span class="block text-sm font-bold text-text-main ml-1">{m.asso_edit_calendar_color_label()}</span>
    <div class="flex flex-wrap gap-1.5">
      {#each PRESET_COLORS as c (c)}
        <button
          type="button"
          onclick={() => (editColor = c)}
          title={c}
          class="h-7 w-7 rounded-full border-2 transition-all hover:scale-110 focus:outline-none shrink-0
                 {editColor === c
            ? 'border-cn-dark ring-2 ring-offset-1 ring-cn-yellow/70 scale-110'
            : 'border-transparent hover:border-white/60'}"
          style="background:{c};"
          aria-label={c}
        ></button>
      {/each}
    </div>
    <div class="flex items-center gap-2 ml-0.5">
      <span class="text-xs text-text-muted">{m.asso_edit_custom_color_label()}</span>
      <ColorPicker bind:value={editColor} label={m.asso_edit_color_picker_label()} />
    </div>
  </div>

  <div class="rounded-xl border border-cn-border/70 bg-cn-bg/40 p-3 text-xs text-text-muted space-y-3">
    <p class="font-semibold text-text-main">{m.asso_edit_preview_label()}</p>
    {#if editDescription.trim()}
      <div>
        <p class="font-medium text-text-main mb-1">{m.asso_edit_preview_description_label()}</p>
        <ProfileBioMarkdown source={editDescription} class="text-sm" />
      </div>
    {/if}
    {#if editBioMarkdown.trim()}
      <div>
        <p class="font-medium text-text-main mb-1">{m.asso_edit_preview_bio_label()}</p>
        <ProfileBioMarkdown source={editBioMarkdown} />
      </div>
    {:else if !editDescription.trim()}
      <p>{m.asso_edit_preview_empty()}</p>
    {/if}
  </div>
  {#if settingsError}
    <div class="text-sm text-red-600">{settingsError}</div>
  {/if}
  {#if canEdit}
    <div class="flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onclick={handleSaveProfile}
        disabled={saving}
        class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
      >
        {saving ? m.asso_edit_saving_label() : m.asso_edit_save_profile_button()}
      </button>
      {#if saveSuccess}
        <span class="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
          <Check size={15} />
          {m.asso_edit_saved_success()}
        </span>
      {/if}
    </div>
  {:else}
    <p class="text-sm text-text-muted">
      {m.asso_edit_no_manage_permission()}
    </p>
  {/if}
</div>
