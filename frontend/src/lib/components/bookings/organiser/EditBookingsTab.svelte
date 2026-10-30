<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { CalendarClock, LayoutDashboard, Plus, Settings } from '@lucide/svelte';
  import { createSpace, listManagedSpaces, type ManagedSpaceRow } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { spaceDashboardHref, spaceEditorHref, spaceHref } from '$lib/bookings/routes';
  import Modal from '$lib/components/shared/Modal.svelte';
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
  let creating = $state(false);
  /** The creation is the wizard, opened by the button, whose first step asks for the name. */
  let creatorOpen = $state(false);

  function closeCreator() {
    creatorOpen = false;
  }

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

  /** "Je regle tout moi-meme": the space by its name alone, every setting at its default. */
  async function createByName(name: string) {
    if (creating) return;
    if (!name) {
      // "Je regle tout moi-meme" with no name typed yet: the wizard's first step asks for it.
      error = m.bookings_problem_required();
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

<div class="space-y-3">
  <div class="flex items-center justify-between gap-3">
    <h2 class="text-text-main min-w-0 text-lg font-bold tracking-tight">
      {personal ? m.bookings_personal_title() : m.bookings_tab_label()}
    </h2>
    <button
      type="button"
      onclick={() => {
        error = '';
        creatorOpen = true;
      }}
      class="bg-cn-border/40 text-text-main hover:bg-cn-border/70 inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors"
    >
      <Plus size={16} aria-hidden="true" />
      {m.bookings_tab_new_button()}
    </button>
  </div>
  {#if !personal}
    <p class="text-text-muted text-sm">{m.bookings_tab_subtitle()}</p>
  {/if}

  {#if creatorOpen}
    <Modal open title={m.bookings_tab_new_button()} fullViewport onClose={closeCreator}>
      <SpaceWizard
        {associationId}
        initialName=""
        onCreated={(id) => void openEditor(id)}
        onSkip={(name) => void createByName(name)}
        onCancel={closeCreator}
      />
      {#if error}
        <p
          class="border-red-err/30 bg-red-err/10 text-red-err mt-3 rounded-xl border px-4 py-3 text-sm"
          role="alert"
        >
          {error}
        </p>
      {/if}
    </Modal>
  {/if}

  {#if error && !creatorOpen}
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
    <p class="text-text-muted py-2 text-sm">
      {personal ? m.bookings_personal_empty() : m.bookings_tab_empty()}
    </p>
  {:else}
    <!-- The same rows as the list of spaces to book: the row opens the space, and the two icons
         on the right are the organiser's - its dashboard and its settings. -->
    <ul
      class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border shadow-sm"
    >
      {#each spaces as space (space.id)}
        <li class="flex items-center">
          <a
            href={resolve(internalPath(spaceHref(space.id)))}
            class="text-text-main hover:bg-cn-border/20 flex min-w-0 flex-1 items-center gap-3 p-4 transition-colors"
          >
            <span
              class="bg-cn-yellow/15 text-text-muted flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
              aria-hidden="true"
            >
              <CalendarClock size={22} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-base font-semibold">{space.name}</span>
              <span class="text-text-muted block truncate text-sm">
                <!-- One column is, since WP-R1, the space's hidden one (D44): no count to read. -->
                {#if space.resourceCount !== 1}
                  {m.bookings_row_resources({ count: space.resourceCount })} ·
                {/if}
                {space.discoverability === 'link'
                  ? m.bookings_discoverability_link()
                  : m.bookings_discoverability_listed()}
              </span>
            </span>
          </a>
          <a
            href={resolve(internalPath(spaceDashboardHref(space.id)))}
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
            aria-label={m.bookings_dashboard_title()}
            title={m.bookings_dashboard_title()}
          >
            <LayoutDashboard size={18} />
          </a>
          <a
            href={resolve(internalPath(spaceEditorHref(space.id)))}
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 me-2 rounded-lg"
            aria-label={m.bookings_tab_edit_action()}
            title={m.bookings_tab_edit_action()}
          >
            <Settings size={18} />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
