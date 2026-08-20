<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    listDocumentReviewers,
    addDocumentReviewer,
    removeDocumentReviewer,
    type DocumentReviewerGrant,
  } from '$lib/associations/api';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { FileCheckCorner, Trash2, UserPlus } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reviewers = $state<DocumentReviewerGrant[]>([]);
  let resolvedNames = $state<Record<string, string>>({});

  let newUserId = $state('');
  let adding = $state(false);
  const removingIds = new SvelteSet<string>();

  /** Resolves display names for a set of user ids (sync cache first, then async). */
  function resolveNames(ids: string[]) {
    for (const id of ids) {
      resolvedNames = { ...resolvedNames, [id]: getUserDisplayNameSync(id) || id };
      void resolveUserDisplayName(id).then((name) => {
        if (name) resolvedNames = { ...resolvedNames, [id]: name };
      });
    }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      reviewers = await listDocumentReviewers();
      resolveNames(reviewers.map((r) => r.userId));
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleAdd() {
    const userId = newUserId.trim();
    if (!userId || adding) return;
    adding = true;
    error = null;
    try {
      const grant = await addDocumentReviewer(userId);
      if (!reviewers.some((r) => r.userId === grant.userId)) {
        reviewers = [grant, ...reviewers];
        resolveNames([grant.userId]);
      }
      newUserId = '';
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      adding = false;
    }
  }

  async function handleRemove(grant: DocumentReviewerGrant) {
    const name = resolvedNames[grant.userId] ?? grant.userId;
    if (
      !(await showConfirm(m.docreview_revoke_confirm({ name }), {
        danger: true,
        confirmLabel: m.docreview_revoke_button(),
      }))
    )
      return;
    removingIds.add(grant.userId);
    error = null;
    try {
      await removeDocumentReviewer(grant.userId);
      reviewers = reviewers.filter((r) => r.userId !== grant.userId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_delete_error();
    } finally {
      removingIds.delete(grant.userId);
    }
  }

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
    void load();
  });
</script>

{#if ready}
  <div class="space-y-6">
    <header class="flex items-start gap-3">
      <span
        class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
      >
        <FileCheckCorner size={20} />
      </span>
      <div>
        <h2 class="text-text-main text-lg font-extrabold">{m.docreview_title()}</h2>
        <p class="text-text-muted mt-0.5 text-sm">{m.docreview_subtitle()}</p>
      </div>
    </header>

    <!-- Add reviewer -->
    <form
      class="flex flex-col gap-3 sm:flex-row"
      onsubmit={(e) => {
        e.preventDefault();
        void handleAdd();
      }}
    >
      <div class="min-w-0 flex-1">
        <UserAutocomplete
          value={newUserId}
          onValueChange={(v) => (newUserId = v)}
          placeholder={m.docreview_add_placeholder()}
          inputId="add-reviewer-autocomplete"
          onSubmit={handleAdd}
        />
      </div>
      <button
        type="submit"
        disabled={adding || !newUserId.trim()}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
      >
        <UserPlus size={16} />
        {adding ? m.common_saving_label() : m.docreview_add_button()}
      </button>
    </form>

    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else}
      <div
        class="border-cn-border divide-cn-border/70 divide-y overflow-hidden rounded-2xl border bg-(--cn-surface)"
      >
        {#if reviewers.length === 0}
          <p class="text-text-muted px-4 py-8 text-center text-sm">{m.docreview_empty()}</p>
        {:else}
          {#each reviewers as grant (grant.userId)}
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <span class="text-text-main block truncate text-sm font-semibold">
                  {resolvedNames[grant.userId] ?? grant.userId}
                </span>
                <span class="text-text-muted block truncate text-xs">
                  {m.docreview_granted_on({ date: new Date(grant.createdAt).toLocaleDateString() })}
                </span>
              </div>
              <button
                type="button"
                onclick={() => handleRemove(grant)}
                disabled={removingIds.has(grant.userId)}
                title={m.docreview_revoke_button()}
                class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 inline-flex items-center justify-center rounded-xl border p-2 transition-colors disabled:opacity-50"
              >
                <Trash2 size={15} />
              </button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
