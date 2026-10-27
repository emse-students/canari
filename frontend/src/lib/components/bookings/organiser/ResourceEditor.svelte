<script lang="ts">
  import { untrack } from 'svelte';
  import { Save, Trash2 } from '@lucide/svelte';
  import { deleteResource, updateResource, type ManagedResource } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import AvailabilityEditor from './AvailabilityEditor.svelte';

  /**
   * One resource (D10, D32): its name, its public and its after-booking text, the account linked
   * to it, and its availability. Its fields and its availability save separately - they are two
   * calls, and a refusal of one (D29) must not lose what was typed in the other.
   *
   * `hidden` is the space's ONE default column (D44): its name is the space's, its texts are the
   * space's own, and it cannot be deleted alone - so only the linked account and the hours are
   * drawn. A text it already carries (a space set up before WP-R1) stays shown, so nothing the
   * server still serves is out of the organiser's sight.
   */
  interface Props {
    resource: ManagedResource;
    spaceId: string;
    /** The space's SAVED zone: the bookings a refusal names are read on it (D25). */
    timeZone: string;
    stepMinutes: number | null;
    onChanged: (resource: ManagedResource) => void;
    onDeleted: (resourceId: string) => void;
    /** Whether the fields or the availability hold changes not saved, for the leave warning. */
    onDirty: (dirty: boolean) => void;
    /** The space shows no columns (D44, `columnsHidden`): this is its only one. */
    hidden?: boolean;
  }

  let {
    resource,
    spaceId,
    timeZone,
    stepMinutes,
    onChanged,
    onDeleted,
    onDirty,
    hidden = false,
  }: Props = $props();

  // The editor's own copy: the parent keys this component by the resource id.
  let name = $state(untrack(() => resource.name));
  /**
   * The name as the server last had it. It FOLLOWS THE PROP: a renamed space renames its hidden
   * column on the server (WP-R1), and the editor's copy must not write the former name back on a
   * later save (review of #2590). The copy is re-seeded only when the organiser has not edited it.
   */
  let baseName = $state(untrack(() => resource.name));
  $effect(() => {
    const incoming = resource.name;
    untrack(() => {
      if (incoming === baseName) return;
      if (name === baseName) name = incoming;
      Log.d('BOOKINGS', `resource name re-seeded id=${resource.id.slice(0, 8)}`);
      baseName = incoming;
    });
  });
  /** Only a name the organiser typed is sent: a copy is never written back. */
  const nameEdited = $derived(name.trim() !== baseName);
  let description = $state(untrack(() => resource.description ?? ''));
  let privateInfo = $state(untrack(() => resource.privateInfo ?? ''));
  let linkedUserId = $state(untrack(() => resource.linkedUserId ?? ''));
  let saving = $state(false);
  let deleting = $state(false);
  let saved = $state(false);
  let error = $state('');

  let availabilityDirty = $state(false);
  /** A hidden column still shows a text it carries: never hide what the server serves. */
  const showTexts = $derived(!hidden || !!resource.description || !!resource.privateInfo);

  const fieldId = (f: string) => `resource-${resource.id}-${f}`;
  const fieldsNow = () => JSON.stringify([description, privateInfo, linkedUserId]);
  /** The fields other than the name as last loaded or saved. */
  let savedFields = $state(untrack(fieldsNow));
  const fieldsDirty = $derived(nameEdited || fieldsNow() !== savedFields);

  $effect(() => {
    onDirty(fieldsDirty || availabilityDirty);
  });

  async function save() {
    if (!name.trim() || saving) return;
    saving = true;
    saved = false;
    error = '';
    const fields = {
      ...(nameEdited ? { name: name.trim() } : {}),
      description: description.trim() || null,
      privateInfo: privateInfo.trim() || null,
      linkedUserId: linkedUserId || null,
    };
    Log.d('BOOKINGS', `resource save id=${resource.id} linked=${fields.linkedUserId !== null}`);
    try {
      await updateResource(resource.id, fields);
      saved = true;
      savedFields = fieldsNow();
      if (fields.name !== undefined) baseName = fields.name;
      onChanged({ ...resource, ...fields });
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_resource_save());
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const confirmed = await showConfirm(
      m.bookings_resource_delete_confirm({ name: resource.name }),
      {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }
    );
    if (!confirmed) return;
    deleting = true;
    error = '';
    try {
      await deleteResource(resource.id);
      Log.i('BOOKINGS', `resource deleted id=${resource.id.slice(0, 8)}`);
      onDeleted(resource.id);
    } catch (e) {
      error = describeBookingRefusal(e, m.common_delete_button());
    } finally {
      deleting = false;
    }
  }
</script>

<article class="border-cn-border space-y-4 rounded-2xl border p-3 sm:p-4">
  {#if !hidden}
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <Input
          id={fieldId('name')}
          label={m.bookings_resource_name()}
          bind:value={name}
          maxlength={120}
          error={name.trim() ? undefined : m.bookings_problem_required()}
          oninput={() => (saved = false)}
        />
      </div>
      <button
        type="button"
        class="ui-icon-button text-text-muted hover:text-red-err mt-7 shrink-0 rounded-full"
        aria-label={m.bookings_resource_delete_aria({ name: resource.name })}
        disabled={deleting}
        onclick={remove}
      >
        <Trash2 size={18} />
      </button>
    </div>
  {/if}

  {#if showTexts}
    <Textarea
      id={fieldId('description')}
      label={m.bookings_field_description()}
      bind:value={description}
      rows={2}
      maxlength={2000}
      oninput={() => (saved = false)}
    />
    <div>
      <Textarea
        id={fieldId('private')}
        label={m.bookings_field_private_info()}
        bind:value={privateInfo}
        rows={2}
        maxlength={2000}
        oninput={() => (saved = false)}
      />
      <p class={CONTROL_HINT_CLASS}>{m.bookings_field_private_info_hint()}</p>
    </div>
  {/if}
  <div>
    <label class={CONTROL_LABEL_CLASS} for={fieldId('linked')}>{m.bookings_resource_linked()}</label
    >
    <UserAutocomplete
      inputId={fieldId('linked')}
      value={linkedUserId}
      onValueChange={(v) => {
        linkedUserId = v;
        saved = false;
      }}
    />
    <p class={CONTROL_HINT_CLASS}>{m.bookings_resource_linked_hint()}</p>
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
      <p class="text-green-ok text-sm" role="status">{m.bookings_resource_saved()}</p>
    {/if}
    <button
      type="button"
      onclick={save}
      disabled={!name.trim() || saving}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Save size={16} />
      {saving ? m.form_saving_label() : m.bookings_resource_save()}
    </button>
  </div>

  <div class="border-cn-border/60 border-t pt-4">
    <AvailabilityEditor
      {spaceId}
      {timeZone}
      resourceId={resource.id}
      resourceName={resource.name}
      lines={resource.lines}
      exceptions={resource.exceptions}
      {stepMinutes}
      onSaved={(lines, exceptions) => onChanged({ ...resource, lines, exceptions })}
      onDirty={(d) => (availabilityDirty = d)}
    />
  </div>
</article>
