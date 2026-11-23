<script lang="ts">
  /**
   * The Alumni duplicates (D47): accounts an Alumni sign-in created whose name and promo match an
   * existing account. "Rattacher" (D48) deletes the duplicate at MiConnect and erases its Canari
   * account - so the confirmation first NAMES what the duplicate holds in Canari, counted by the
   * services that hold it. Global admin only.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { RefreshCw, Link2 } from '@lucide/svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { Log } from '$lib/utils/Log';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import {
    alumniMergeErrorMessage,
    fetchAlumniDuplicates,
    fetchAlumniHoldings,
    mergeAlumniDuplicate,
    type AlumniAccount,
    type AlumniDuplicate,
    type AlumniHoldings,
  } from '$lib/profile/alumniMerge';

  let rows = $state<AlumniDuplicate[]>([]);
  let loading = $state(true);
  let error = $state('');
  let notice = $state('');
  let confirming = $state<{
    duplicate: AlumniAccount;
    target: AlumniAccount;
    held: AlumniHoldings;
  } | null>(null);
  let busy = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      rows = await fetchAlumniDuplicates();
    } catch (err) {
      Log.d('admin.alumni-duplicates.load failed', err);
      error = alumniMergeErrorMessage(err);
    } finally {
      loading = false;
    }
  }

  /** The count of what the duplicate holds is read FIRST: no confirmation without it. */
  async function askMerge(duplicate: AlumniAccount, target: AlumniAccount) {
    error = '';
    notice = '';
    busy = true;
    try {
      confirming = { duplicate, target, held: await fetchAlumniHoldings(duplicate.uuid) };
    } catch (err) {
      Log.d('admin.alumni-duplicates.holdings failed', err);
      error = alumniMergeErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function merge() {
    if (!confirming) return;
    busy = true;
    error = '';
    try {
      await mergeAlumniDuplicate(confirming.duplicate.uuid, confirming.target.uuid);
      confirming = null;
      notice = m.alumni_duplicates_done();
      await load();
    } catch (err) {
      Log.d('admin.alumni-duplicates.merge failed', err);
      error = alumniMergeErrorMessage(err);
      confirming = null;
    } finally {
      busy = false;
    }
  }

  const heldLines = (h: AlumniHoldings): string[] => [
    m.alumni_duplicates_held_posts({ count: h.personalPosts }),
    m.alumni_duplicates_held_associations({ count: h.associations }),
    m.alumni_duplicates_held_communities({ count: h.communities }),
    m.alumni_duplicates_held_forms({ count: h.formSubmissions }),
    m.alumni_duplicates_held_conversations({ count: h.conversations }),
  ];

  onMount(async () => {
    if (!isGlobalAdmin()) {
      void goto(resolve('/dashboard'), { replace: true });
      return;
    }
    await load();
  });
</script>

{#snippet account(a: AlumniAccount, label: string)}
  <div class="min-w-0">
    <p class="text-text-muted text-xs font-semibold uppercase">{label}</p>
    <p class="text-text-main truncate text-sm font-semibold">{a.name}</p>
    <p class="text-text-muted truncate text-xs">
      {a.username} - {m.alumni_duplicates_promos({ promos: a.promos.join(', ') })}
      {#if !a.canariUserId}
        - {m.alumni_duplicates_no_canari()}
      {/if}
    </p>
  </div>
{/snippet}

<PageHeader title={m.alumni_duplicates_nav_label()} subtitle={m.alumni_duplicates_subtitle()}>
  {#snippet actions()}
    <Button
      variant="ghost"
      icon
      onclick={load}
      disabled={loading}
      aria-label={m.moderation_refresh()}
      title={m.moderation_refresh()}
    >
      <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
    </Button>
  {/snippet}
</PageHeader>

<div class="space-y-4">
  {#if error}
    <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-4 text-sm">
      {error}
    </div>
  {/if}
  {#if notice}
    <div class="text-text-main rounded-xl border border-black/5 p-4 text-sm dark:border-white/10">
      {notice}
    </div>
  {/if}

  {#if loading}
    <div class="text-text-muted text-sm">{m.common_loading_label()}</div>
  {:else if rows.length === 0 && !error}
    <div class="text-text-muted text-sm">{m.alumni_duplicates_empty()}</div>
  {:else}
    <ul class="space-y-3">
      {#each rows as row (row.duplicate.uuid)}
        <li
          class="bg-cn-surface space-y-3 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/10"
        >
          {@render account(row.duplicate, m.alumni_duplicates_duplicate_label())}
          {#each row.targets as target (target.uuid)}
            <div class="flex flex-wrap items-center justify-between gap-2">
              {@render account(target, m.alumni_duplicates_target_label())}
              <Button
                size="compact"
                disabled={busy}
                onclick={() => void askMerge(row.duplicate, target)}
              >
                <Link2 size={14} />
                {m.alumni_duplicates_merge()}
              </Button>
            </div>
          {/each}
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if confirming}
  <Modal open title={m.alumni_duplicates_confirm_title()} onClose={() => (confirming = null)}>
    <div class="space-y-4">
      {#if confirming.held.canariAccount}
        <p class="text-text-main text-sm">
          {m.alumni_duplicates_confirm_intro({ username: confirming.duplicate.username })}
        </p>
        <ul class="text-text-main list-disc space-y-1 pl-5 text-sm">
          {#each heldLines(confirming.held) as line (line)}
            <li>{line}</li>
          {/each}
        </ul>
      {:else}
        <p class="text-text-main text-sm">{m.alumni_duplicates_held_nothing()}</p>
      {/if}
      <p class="text-text-muted text-sm">{m.alumni_duplicates_confirm_relink()}</p>
      <div class="flex justify-end gap-2">
        <Button variant="secondary" onclick={() => (confirming = null)}>
          {m.common_cancel_button()}
        </Button>
        <Button variant="danger" loading={busy} onclick={() => void merge()}>
          {m.alumni_duplicates_confirm_button()}
        </Button>
      </div>
    </div>
  </Modal>
{/if}
