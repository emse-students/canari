<script lang="ts">
  /**
   * THE READER'S INBOX OF FOLLOW REQUESTS (WP-F4).
   *
   * Every personal account is private (user, 2026-10-25): a person who wants to follow the reader
   * asks, and the reader answers here. Accepting makes them a follower (and tells them); refusing
   * deletes the request and tells nobody. A row leaves the list on the server's answer; a 404 means
   * the request was already answered or withdrawn, and the list is re-read.
   *
   * Reached from the `follow_request` notification row, from its push
   * (`fr.emse.canari://follow-requests`), and from the banner on `/notifications`.
   */
  import { onMount } from 'svelte';
  import { Inbox } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import FollowPersonRow from '$lib/components/follows/FollowPersonRow.svelte';
  import {
    acceptFollowRequest,
    appendFollowPage,
    listFollowRequests,
    nextFollowCursor,
    refuseFollowRequest,
    type FollowListEntry,
  } from '$lib/follows/api';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  let requests = $state<FollowListEntry[]>([]);
  let loading = $state(true);
  let errorMessage = $state('');
  /** The request whose answer is in flight, so no button can be pressed twice. */
  let busy = $state<string | null>(null);
  /** Where the next page starts; `null` once the last page is shown. */
  let next = $state<string | null>(null);
  let loadingMore = $state(false);

  onMount(load);

  async function load() {
    loading = true;
    errorMessage = '';
    try {
      requests = await listFollowRequests();
      next = nextFollowCursor(requests);
      Log.d('FollowRequests', `loaded ${requests.length}`);
    } catch (e: unknown) {
      Log.d('FollowRequests', `load failed: ${String(e)}`);
      errorMessage = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  /** Appends the next page: an inbox of any length is answerable to its last request. */
  async function loadMore() {
    if (!next || loadingMore) return;
    loadingMore = true;
    errorMessage = '';
    try {
      const page = await listFollowRequests(next);
      requests = appendFollowPage(requests, page);
      next = nextFollowCursor(page);
      Log.d('FollowRequests', `page loaded: ${page.length}`);
    } catch (e: unknown) {
      Log.d('FollowRequests', `next page failed: ${String(e)}`);
      errorMessage = m.common_load_error();
    } finally {
      loadingMore = false;
    }
  }

  /** Accepts or refuses one request; the row leaves the list on the server's answer. */
  async function answer(request: FollowListEntry, action: 'accept' | 'refuse') {
    busy = request.userId;
    errorMessage = '';
    Log.d('FollowRequests', `${action} ${request.userId.slice(0, 8)}`);
    try {
      if (action === 'accept') await acceptFollowRequest(request.userId);
      else await refuseFollowRequest(request.userId);
      requests = requests.filter((r) => r.userId !== request.userId);
      showToast(
        action === 'accept' ? m.follow_requests_accepted() : m.follow_requests_refused(),
        'info'
      );
    } catch (e: unknown) {
      const status = refusalStatus(e);
      Log.d('FollowRequests', `${action} refused: status=${status} ${String(e)}`);
      if (status === 404) {
        // Re-read FIRST: `load` clears the message, and the reason is what this answer must show.
        await load();
        errorMessage = m.follow_requests_gone();
      } else {
        errorMessage = m.follow_requests_answer_error();
      }
    } finally {
      busy = null;
    }
  }
</script>

<PageContainer>
  <PageHeader
    title={m.follow_requests_title()}
    subtitle={m.follow_requests_subtitle()}
    backHref="/notifications"
    backLabel={m.nav_notifications_label()}
  />

  {#if errorMessage}
    <div
      class="border-red-err/30 bg-red-err/10 text-red-err mb-3 rounded-xl border px-4 py-3 text-sm"
    >
      {errorMessage}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-6">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if requests.length === 0}
    <div class="text-text-muted flex flex-col items-center gap-3 py-16">
      <Inbox size={40} strokeWidth={1.5} class="opacity-40" />
      <p class="text-sm">{m.follow_requests_empty()}</p>
    </div>
  {:else}
    <ul class="space-y-2">
      {#each requests as request (request.userId)}
        <FollowPersonRow userId={request.userId} createdAt={request.createdAt}>
          {#snippet actions()}
            <button
              type="button"
              class="text-text-muted rounded-xl px-3 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
              disabled={busy !== null}
              onclick={() => answer(request, 'refuse')}
            >
              {m.follow_requests_refuse()}
            </button>
            <button
              type="button"
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
              disabled={busy !== null}
              onclick={() => answer(request, 'accept')}
            >
              {m.follow_requests_accept()}
            </button>
          {/snippet}
        </FollowPersonRow>
      {/each}
    </ul>
    {#if next}
      <div class="mt-3 flex justify-center">
        <button
          type="button"
          class="text-text-main rounded-xl bg-black/5 px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:hover:bg-white/20"
          data-follow-requests-more
          disabled={loadingMore}
          onclick={loadMore}
        >
          {m.follow_list_more()}
        </button>
      </div>
    {/if}
  {/if}
</PageContainer>
