<script lang="ts">
  /**
   * "REPUBLIE PAR N PERSONNES" (WP-F6, owner 2026-11-02): the AUTHOR of a personal post reads who
   * reposted it to their followers, and removes one repost with "Retirer". Opened from the post's
   * menu (`PostActionsMenu`), on the author's own post only - the server answers a 404 to anyone
   * else, and lists nobody across a block with the author.
   *
   * The rows are the follow lists' (`FollowPersonRow`), paged the same way. A removal takes the
   * row off at once and puts it back if the write is refused; a 404 `MEMBER_REPOST_NOT_LISTED`
   * means the repost is already gone (taken back, or its reposter now out of the author's sight),
   * which is what the tap asked for. The removed reposter is told nothing.
   */
  import Modal from '$lib/components/shared/Modal.svelte';
  import FollowPersonRow from '$lib/components/follows/FollowPersonRow.svelte';
  import { appendFollowPage, nextFollowCursor, type FollowListEntry } from '$lib/follows/api';
  import {
    MEMBER_REPOST_NOT_LISTED,
    listPostReposters,
    removePostRepost,
  } from '$lib/posts/reposters';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import { peekUserDisplayName } from '$lib/utils/users/displayName';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    open: boolean;
    /** The author's own personal post. */
    postId: string;
    onClose: () => void;
    /** A repost was removed: the card re-reads itself (its count, its "Republie par" line). */
    onRemoved?: () => void;
  }

  let { open, postId, onClose, onRemoved }: Props = $props();

  let reposters = $state<FollowListEntry[]>([]);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state('');
  /** The reposter whose removal is in flight. */
  let pendingId = $state<string | null>(null);

  // Read afresh on every opening: the list changes while the sheet is closed.
  $effect(() => {
    if (!open) return;
    void load(postId);
  });

  async function load(id: string) {
    loading = true;
    error = '';
    try {
      const page = await listPostReposters(id);
      reposters = page;
      next = nextFollowCursor(page);
      Log.d('PostRepostersSheet', `${id.slice(0, 8)}: ${page.length} reposter(s)`);
    } catch (e: unknown) {
      Log.d('PostRepostersSheet.load failed', e);
      reposters = [];
      next = null;
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!next || loadingMore) return;
    loadingMore = true;
    error = '';
    try {
      const page = await listPostReposters(postId, next);
      reposters = appendFollowPage(reposters, page);
      next = nextFollowCursor(page);
      Log.d('PostRepostersSheet', `${postId.slice(0, 8)}: next page, ${page.length} row(s)`);
    } catch (e: unknown) {
      Log.d('PostRepostersSheet.loadMore failed', e);
      error = m.common_load_error();
    } finally {
      loadingMore = false;
    }
  }

  async function handleRemove(userId: string) {
    const name = peekUserDisplayName(userId) ?? m.notif_actor_unknown();
    const confirmed = await showConfirm(m.post_reposters_remove_confirm({ name }), {
      danger: true,
      confirmLabel: m.post_reposters_remove(),
    });
    if (!confirmed) return;
    const previous = reposters;
    reposters = reposters.filter((r) => r.userId !== userId);
    pendingId = userId;
    error = '';
    try {
      await removePostRepost(postId, userId);
      Log.d('PostRepostersSheet', `${postId.slice(0, 8)}: repost by ${userId.slice(0, 8)} removed`);
      onRemoved?.();
    } catch (e: unknown) {
      if (refusalCode(e) === MEMBER_REPOST_NOT_LISTED) {
        // Already gone: the row stays off, and the card re-reads what is left.
        Log.d(
          'PostRepostersSheet',
          `${postId.slice(0, 8)}: repost of ${userId.slice(0, 8)} already gone`
        );
        onRemoved?.();
      } else {
        Log.d('PostRepostersSheet.remove failed', e);
        reposters = previous;
        error = m.post_reposters_remove_error();
      }
    } finally {
      pendingId = null;
    }
  }

  const buttonClass =
    'text-text-main shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-bold transition-colors hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20';
</script>

<Modal {open} title={m.post_reposters_title()} {onClose}>
  <div class="flex flex-col gap-3" data-post-reposters>
    {#if error}
      <p class="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">{error}</p>
    {/if}
    {#if loading}
      <p class="text-text-muted text-sm font-medium">{m.common_loading_label()}</p>
    {:else if reposters.length === 0 && !error}
      <p class="text-text-muted text-sm font-medium">{m.post_reposters_empty()}</p>
    {:else}
      <ul class="space-y-2">
        {#each reposters as reposter (reposter.userId)}
          <FollowPersonRow userId={reposter.userId} createdAt={reposter.createdAt}>
            {#snippet actions()}
              <button
                type="button"
                class={buttonClass}
                data-reposter-remove={reposter.userId}
                disabled={pendingId === reposter.userId}
                onclick={() => handleRemove(reposter.userId)}
              >
                {m.post_reposters_remove()}
              </button>
            {/snippet}
          </FollowPersonRow>
        {/each}
      </ul>
      {#if next}
        <button type="button" class={buttonClass} disabled={loadingMore} onclick={loadMore}>
          {m.follow_list_more()}
        </button>
      {/if}
    {/if}
  </div>
</Modal>
