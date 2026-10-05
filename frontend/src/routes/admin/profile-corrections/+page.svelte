<script lang="ts">
  /**
   * The queue of profile correction requests (D10): what people say is wrong in their MiConnect
   * profile, oldest first. An admin either applies it - the edit form, whose save answers the request
   * and notifies the person - or refuses it with a note the person is shown.
   */
  import { onMount, type ComponentProps } from 'svelte';
  import { goto } from '$app/navigation';
  import { RefreshCw, UserPen, Ban } from '@lucide/svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import ProfileEditForm from '$lib/components/profile/ProfileEditForm.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { Log } from '$lib/utils/Log';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import {
    CORRECTION_NOTE_MAX,
    fetchCorrectionQueue,
    profileErrorMessage,
    refuseCorrection,
    type CorrectionQueueRow,
  } from '$lib/profile/profileEdit';

  type Person = ComponentProps<typeof ProfileEditForm>['person'];

  let rows = $state<CorrectionQueueRow[]>([]);
  let loading = $state(true);
  let error = $state('');
  let editing = $state<{ request: CorrectionQueueRow; person: Person } | null>(null);
  let refusing = $state<CorrectionQueueRow | null>(null);
  let note = $state('');
  let busy = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      rows = await fetchCorrectionQueue();
    } catch (err) {
      Log.d('admin.profile-corrections.load failed', err);
      error = m.profile_corrections_load_error();
    } finally {
      loading = false;
    }
  }

  async function startEdit(request: CorrectionQueueRow) {
    error = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/${encodeURIComponent(request.userId)}`);
      if (!res.ok) throw new Error(String(res.status));
      editing = { request, person: (await res.json()) as Person };
    } catch (err) {
      Log.d('admin.profile-corrections.person failed', err);
      error = m.profile_corrections_load_error();
    }
  }

  async function refuse() {
    if (!refusing) return;
    busy = true;
    error = '';
    try {
      await refuseCorrection(refusing.id, note);
      refusing = null;
      note = '';
      await load();
    } catch (err) {
      Log.d('admin.profile-corrections.refuse failed', err);
      error = profileErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  onMount(async () => {
    if (!isGlobalAdmin()) {
      goto('/');
      return;
    }
    await load();
  });
</script>

<PageHeader title={m.profile_corrections_nav_label()} subtitle={m.profile_corrections_subtitle()}>
  {#snippet actions()}
    <button
      type="button"
      onclick={load}
      disabled={loading}
      class="ui-icon-button text-text-muted rounded-xl transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
      title={m.moderation_refresh()}
    >
      <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
    </button>
  {/snippet}
</PageHeader>

<div class="space-y-4">
  {#if error}
    <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-4 text-sm">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-text-muted text-sm">{m.common_loading_label()}</div>
  {:else if rows.length === 0}
    <div class="text-text-muted text-sm">{m.profile_corrections_empty()}</div>
  {:else}
    <ul class="space-y-3">
      {#each rows as row (row.id)}
        <li
          class="bg-cn-surface space-y-3 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/10"
        >
          <div>
            <p class="text-text-main text-sm font-semibold">{row.displayName ?? row.userId}</p>
            <p class="text-text-muted text-xs">
              {new Date(row.createdAt).toLocaleString()}
            </p>
          </div>
          <p class="text-text-main text-sm whitespace-pre-wrap">{row.message}</p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="bg-cn-yellow text-cn-dark flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold"
              onclick={() => void startEdit(row)}
            >
              <UserPen size={14} />
              {m.profile_corrections_apply()}
            </button>
            <button
              type="button"
              class="text-text-muted flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5"
              onclick={() => (refusing = row)}
            >
              <Ban size={14} />
              {m.profile_corrections_refuse()}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if editing}
  <ProfileEditForm
    person={editing.person}
    requestId={editing.request.id}
    onClose={() => (editing = null)}
    onSaved={() => {
      editing = null;
      void load();
    }}
  />
{/if}

{#if refusing}
  <Modal open title={m.profile_corrections_refuse_title()} onClose={() => (refusing = null)}>
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void refuse();
      }}
    >
      <p class="text-text-muted text-sm">{m.profile_corrections_refuse_help()}</p>
      <textarea
        class="bg-cn-surface min-h-24 w-full rounded-xl border border-black/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10"
        bind:value={note}
        maxlength={CORRECTION_NOTE_MAX}
        placeholder={m.profile_corrections_note_placeholder()}></textarea>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5"
          onclick={() => (refusing = null)}
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="submit"
          disabled={busy}
          class="bg-red-err rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {m.profile_corrections_refuse()}
        </button>
      </div>
    </form>
  </Modal>
{/if}
