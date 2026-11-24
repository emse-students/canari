<script lang="ts">
  /**
   * The Alumni duplicates (D47): accounts an Alumni sign-in created whose name and promo match an
   * existing account. "Rattacher" (D48) MARKS the duplicate - MiConnect moves its Alumni link onto
   * the existing account and deletes it at its next Alumni sign-in, and its Canari account is erased
   * after that merge - so the confirmation first NAMES what the duplicate holds in Canari, counted by
   * the services that hold it. THE ADMIN VERIFIES (D51): the duplicate shows what the Alumni base
   * holds (its e-mail, its `af_id`, the name it signed up with), the existing account its name, promo and
   * last MiConnect sign-in - a homonym is not the same person, and the Alumni e-mail is how to ask. The open merges (marked, or interrupted) are listed below, each cancellable, an
   * interrupted one resumable. Global admin only.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { RefreshCw, Link2, RotateCcw, X } from '@lucide/svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { Log } from '$lib/utils/Log';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import { intlLocale } from '$lib/utils/intlLocale';
  import {
    alumniMergeErrorMessage,
    cancelAlumniMerge,
    fetchAlumniDuplicates,
    fetchAlumniHoldings,
    fetchAlumniOpenMerges,
    mergeAlumniDuplicate,
    type AlumniAccount,
    type AlumniDuplicate,
    type AlumniHoldings,
    type AlumniOpenMerge,
  } from '$lib/profile/alumniMerge';

  /** The username prefix of an account an Alumni sign-in created: `alumni-<af_id>` (D46). */
  const ALUMNI_PREFIX = 'alumni-';

  let rows = $state<AlumniDuplicate[]>([]);
  let merges = $state<AlumniOpenMerge[]>([]);
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
      [rows, merges] = await Promise.all([fetchAlumniDuplicates(), fetchAlumniOpenMerges()]);
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

  /** "Reprendre" an interrupted merge: the same call, which resumes its open row. */
  async function resume(open: AlumniOpenMerge) {
    busy = true;
    error = '';
    notice = '';
    try {
      await mergeAlumniDuplicate(open.duplicateUuid, open.targetUuid);
      notice = m.alumni_merges_resumed();
      await load();
    } catch (err) {
      Log.d('admin.alumni-duplicates.resume failed', err);
      error = alumniMergeErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function cancel(open: AlumniOpenMerge) {
    busy = true;
    error = '';
    notice = '';
    try {
      await cancelAlumniMerge(open.duplicateUuid);
      notice = m.alumni_merges_cancelled();
      await load();
    } catch (err) {
      Log.d('admin.alumni-duplicates.cancel failed', err);
      error = alumniMergeErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString(intlLocale());

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
    <p class="text-text-muted text-xs font-semibold">{label}</p>
    <p class="text-text-main truncate text-sm font-semibold">{a.name}</p>
    {#if a.username.startsWith(ALUMNI_PREFIX)}
      <p class="text-text-muted truncate text-xs">
        {m.alumni_duplicates_alumni_identity({
          afId: a.username.slice(ALUMNI_PREFIX.length),
          name: a.name,
        })}
      </p>
    {/if}
    <p class="text-text-muted truncate text-xs">
      {a.username} - {m.alumni_duplicates_promos({ promos: a.promos.join(', ') })}
      {#if !a.canariUserId}
        - {m.alumni_duplicates_no_canari()}
      {/if}
    </p>
    <p class="text-text-muted truncate text-xs">
      {a.email
        ? a.username.startsWith(ALUMNI_PREFIX)
          ? m.alumni_duplicates_alumni_email({ email: a.email })
          : m.alumni_duplicates_email({ email: a.email })
        : m.alumni_duplicates_no_email()}
      - {a.lastLogin
        ? m.alumni_duplicates_last_login({ date: day(a.lastLogin) })
        : m.alumni_duplicates_never_logged_in()}
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
  <p class="text-text-muted text-sm">{m.alumni_duplicates_self_declared()}</p>
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

  {#if merges.length > 0}
    <h2 class="text-text-main pt-2 text-sm font-semibold">{m.alumni_merges_title()}</h2>
    <ul class="space-y-3">
      {#each merges as open (open.duplicateUuid)}
        <li
          class="bg-cn-surface flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/10"
        >
          <div class="min-w-0">
            <p class="text-text-main truncate text-sm font-semibold">{open.duplicateUsername}</p>
            <p class="text-text-muted truncate text-xs">
              {open.status === 'marked' && open.markedAt
                ? m.alumni_merges_marked({ date: day(open.markedAt) })
                : m.alumni_merges_requested({ date: day(open.requestedAt) })}
            </p>
            <p class="text-text-muted truncate text-xs">
              {m.alumni_merges_into({ uuid: open.targetUuid })}
            </p>
          </div>
          <div class="flex gap-2">
            {#if open.status === 'requested'}
              <Button size="compact" disabled={busy} onclick={() => void resume(open)}>
                <RotateCcw size={14} />
                {m.alumni_merges_resume()}
              </Button>
            {/if}
            <Button
              size="compact"
              variant="secondary"
              disabled={busy}
              onclick={() => void cancel(open)}
            >
              <X size={14} />
              {m.alumni_merges_cancel()}
            </Button>
          </div>
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
