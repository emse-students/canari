<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { CalendarClock, CalendarDays, Pencil, Plus } from '@lucide/svelte';
  import { createSpace, listManagedSpaces, type ManagedSpaceRow } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { spaceEditorHref, spaceHref } from '$lib/bookings/routes';
  import Input from '$lib/components/ui/Input.svelte';
  import SpaceWizard from './SpaceWizard.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * The spaces one owner manages, and a new one by its name: the bookings tab of an association, a
   * list or an institution (D16, D38), drawn only to a holder of `MANAGE_BOOKINGS`, which is what
   * the server asks of every call here - or, with `associationId` null, the reader's PERSONAL spaces
   * on the Reservations page (D16: "a personal space is created from the page itself"). Every
   * setting is edited on the space's own page. A creation opens the three-step wizard (D52, offered
   * on every creation, Q-R14) with the name typed; "Je regle tout moi-meme" creates by the name
   * alone, as before the wizard, and both land on the space's editor.
   */
  interface Props {
    /** The owning entity, or `null` for the reader's personal spaces. */
    associationId: string | null;
  }

  let { associationId }: Props = $props();
  const personal = $derived(associationId === null);

  let spaces = $state<ManagedSpaceRow[]>([]);
  let loading = $state(true);
  let error = $state('');
  let newName = $state('');
  let creating = $state(false);
  /** The name the wizard opened with; null while the wizard is closed. */
  let wizardName = $state<string | null>(null);

  onMount(load);

  async function load() {
    Log.d('BOOKINGS', `managed spaces load association=${associationId ?? 'personal'}`);
    loading = true;
    error = '';
    try {
      spaces = await listManagedSpaces(associationId);
    } catch (e) {
      error = describeBookingRefusal(e, m.common_load_error());
    } finally {
      loading = false;
    }
  }

  /** The name is typed: the wizard takes it from here. */
  function create(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    error = '';
    wizardName = name;
  }

  /** "Je regle tout moi-meme": the space by its name alone, every setting at its default. */
  async function createByName(name: string) {
    if (creating) return;
    if (!name) {
      // The wizard's name was emptied: back to the form, which asks for one.
      wizardName = null;
      return;
    }
    creating = true;
    error = '';
    try {
      const { id } = await createSpace(name, associationId);
      Log.i('BOOKINGS', `space created from the tab id=${id.slice(0, 8)}`);
      await openEditor(id);
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_tab_create_button());
    } finally {
      creating = false;
    }
  }

  function openEditor(id: string) {
    return goto(resolve(internalPath(spaceEditorHref(id))));
  }
</script>

<div class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-4 shadow-sm sm:p-6">
  <div>
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
      <CalendarClock size={20} />
      {personal ? m.bookings_personal_title() : m.bookings_tab_label()}
    </h2>
    <p class="text-text-muted mt-1 text-sm">
      {personal ? m.bookings_personal_subtitle() : m.bookings_tab_subtitle()}
    </p>
  </div>

  {#if wizardName !== null}
    <SpaceWizard
      {associationId}
      initialName={wizardName}
      onCreated={(id) => void openEditor(id)}
      onSkip={(name) => void createByName(name)}
      onCancel={() => (wizardName = null)}
    />
  {:else}
    <form class="flex flex-col gap-3 sm:flex-row sm:items-end" onsubmit={create}>
      <div class="min-w-0 flex-1">
        <Input
          id="bookings-new-space"
          label={m.bookings_tab_new_label()}
          placeholder={m.bookings_tab_new_placeholder()}
          bind:value={newName}
          maxlength={120}
        />
      </div>
      <button
        type="submit"
        disabled={!newName.trim() || creating}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={16} />
        {m.bookings_tab_create_button()}
      </button>
    </form>
  {/if}

  {#if error}
    <p
      class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
      role="alert"
    >
      {error}
    </p>
  {/if}

  {#if loading}
    <div class="flex justify-center py-8">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if spaces.length === 0}
    <p class="text-text-muted py-6 text-center text-sm">
      {personal ? m.bookings_personal_empty() : m.bookings_tab_empty()}
    </p>
  {:else}
    <ul class="space-y-3">
      {#each spaces as space (space.id)}
        <li
          class="border-cn-border/70 bg-cn-bg flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
        >
          <div class="min-w-0 flex-1">
            <p class="text-text-main truncate text-sm font-semibold">{space.name}</p>
            <p class="text-text-muted mt-0.5 text-xs">
              <!-- One column is, since WP-R1, the space's hidden one (D44): no count to read. -->
              {#if space.resourceCount !== 1}
                {m.bookings_tab_resources_count({ count: space.resourceCount })} ·
              {/if}
              {space.discoverability === 'link'
                ? m.bookings_discoverability_link()
                : m.bookings_discoverability_listed()}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <a
              href={resolve(internalPath(spaceHref(space.id)))}
              class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
            >
              <CalendarDays size={12} />
              {m.bookings_tab_open_action()}
            </a>
            <a
              href={resolve(internalPath(spaceEditorHref(space.id)))}
              class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
            >
              <Pencil size={12} />
              {m.bookings_tab_edit_action()}
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
