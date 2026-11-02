<script lang="ts">
  /**
   * THE PLATFORM ADMIN'S CREATE FORM on `/admin/spaces` (owner, 2026-11-02): exactly a name, a kind,
   * its spaces and an OPTIONAL first admin. With no first admin the entity has no member at all -
   * the admin who creates it does not become one. Logo, description and cotisations stay on the
   * management page.
   *
   * The slug is never typed: the preview asks the server which slug a create of this name would
   * take NOW (`previewAdminSlug`, the server's own `slugCandidates` and collision checks), and the
   * create stays the authority - the slug it answers is the one the page then links to.
   */
  import { onDestroy } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import Input from '$lib/components/ui/Input.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import CellPicker from '$lib/components/associations/CellPicker.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { toRules, type Cell } from '$lib/associations/audienceRules';
  import { entityBase, firstAdminPresetFor } from '$lib/associations/editSections';
  import { audienceRefusalMessage } from '$lib/associations/audienceRefusal';
  import {
    ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN,
    ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY,
    ASSOCIATION_SLUG_EXHAUSTED,
    SocialApiError,
    adminCreateAssociation,
    previewAdminSlug,
    type Association,
  } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Called with the entity the server created (its slug is the server's). */
    onCreated: (created: Association) => void;
  }

  let { onCreated }: Props = $props();

  /** How long the name must rest before its slug is asked for: one request per pause, not per key. */
  const PREVIEW_PAUSE_MS = 300;

  let name = $state('');
  let kind = $state<Association['type']>('association');
  let cells = $state<Set<Cell>>(new Set());
  let firstAdminId = $state('');
  let submitting = $state(false);
  let error = $state('');

  /** The previewed slug; `undefined` while none is known, `null` when the server has none free. */
  let slug = $state<string | null | undefined>(undefined);
  let previewing = $state(false);
  /** Numbers each preview when SENT, so an answer older than the one on screen is dropped. */
  let previewSeq = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const kindOptions = $derived<PickerOption[]>([
    { value: 'association', label: m.admin_entity_kind_association() },
    { value: 'list', label: m.admin_entity_kind_list() },
    { value: 'institution', label: m.admin_entity_kind_institution() },
  ]);

  /** Re-asks the slug whenever the name changes; an empty name has no slug to show. */
  function schedulePreview(next: string) {
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    if (!next.trim()) {
      slug = undefined;
      previewing = false;
      return;
    }
    previewing = true;
    previewTimer = setTimeout(async () => {
      try {
        const answer = await previewAdminSlug(next.trim());
        if (seq !== previewSeq) return;
        slug = answer;
      } catch (err) {
        if (seq !== previewSeq) return;
        // The preview is a courtesy: its failure says nothing about the create, which decides.
        Log.d('admin.create.slugPreview failed', err);
        slug = undefined;
      } finally {
        if (seq === previewSeq) previewing = false;
      }
    }, PREVIEW_PAUSE_MS);
  }

  onDestroy(() => clearTimeout(previewTimer));

  /** The sentence for a refused create, chosen by the typed code (never by the message). */
  function refusal(err: unknown): string {
    const audience = audienceRefusalMessage(err);
    if (audience) return audience;
    if (err instanceof SocialApiError) {
      if (err.code === ASSOCIATION_SLUG_EXHAUSTED) return m.assoc_new_error_slug_exhausted();
      if (err.code === ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN) return m.admin_entity_admin_unknown();
      if (err.code === ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY) {
        return m.admin_entity_first_admin_institution();
      }
    }
    return m.admin_entity_create_error();
  }

  async function submit() {
    if (!name.trim()) {
      error = m.assoc_new_error_required();
      return;
    }
    submitting = true;
    error = '';
    try {
      const created = await adminCreateAssociation({
        name: name.trim(),
        type: kind,
        audiences: toRules(cells),
        ...(firstAdminId
          ? {
              firstAdmin: {
                userId: firstAdminId,
                permissions: firstAdminPresetFor(kind),
              },
            }
          : {}),
      });
      Log.d(`admin.create: ${kind} created, first admin ${firstAdminId ? 'yes' : 'no'}`);
      name = '';
      cells = new Set();
      firstAdminId = '';
      schedulePreview('');
      onCreated(created);
    } catch (err) {
      Log.d('admin.create failed', err);
      error = refusal(err);
    } finally {
      submitting = false;
    }
  }
</script>

<form
  class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-4"
  data-admin-create
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <h3 class="text-text-main text-base font-bold">{m.admin_entity_create_title()}</h3>

  <div class="space-y-1.5">
    <Input
      label={m.admin_entity_name_label()}
      bind:value={name}
      oninput={(e) => schedulePreview(e.currentTarget.value)}
      required
    />
    <p class="text-text-muted ml-1 text-xs" data-slug-preview aria-live="polite">
      {#if previewing}
        {m.admin_entity_slug_checking()}
      {:else if slug}
        {m.admin_entity_slug_preview({ path: `${entityBase(kind)}/${slug}` })}
      {:else if slug === null}
        {m.assoc_new_error_slug_exhausted()}
      {:else}
        {m.admin_entity_slug_hint()}
      {/if}
    </p>
  </div>

  <div>
    <label for="admin-create-kind" class="text-text-main mb-2 ml-1 block text-sm font-bold">
      {m.admin_entity_kind_label()}
    </label>
    <Picker
      id="admin-create-kind"
      value={kind}
      options={kindOptions}
      label={m.admin_entity_kind_label()}
      variant="field"
      density="default"
      onValueChange={(v) => (kind = v as Association['type'])}
    />
  </div>

  <fieldset class="space-y-2">
    <legend class="text-text-main mb-1 ml-1 text-sm font-bold">
      {m.admin_entity_spaces_label()}
    </legend>
    <p class="text-text-muted ml-1 text-xs">{m.admin_entity_spaces_hint()}</p>
    <CellPicker bind:cells />
  </fieldset>

  <div class="space-y-1.5">
    <label for="admin-create-first-admin" class="text-text-main ml-1 block text-sm font-bold">
      {m.admin_entity_first_admin_label()}
    </label>
    <UserAutocomplete
      inputId="admin-create-first-admin"
      value={firstAdminId}
      onValueChange={(v) => (firstAdminId = v)}
      placeholder={m.admin_entity_first_admin_placeholder()}
    />
    <p class="text-text-muted ml-1 text-xs" data-first-admin-hint>
      {firstAdminId ? m.admin_entity_first_admin_set() : m.admin_entity_first_admin_none()}
      {#if kind === 'institution'}
        {m.admin_entity_first_admin_institution()}
      {/if}
    </p>
  </div>

  {#if error}
    <p class="text-red-err text-sm" role="alert">{error}</p>
  {/if}

  <Button type="submit" loading={submitting} disabled={submitting}>
    {m.admin_entity_create_submit()}
  </Button>
</form>
