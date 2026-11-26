<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { goto, afterNavigate } from '$app/navigation';
  import type { PostEntity } from '$lib/posts/api';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { FileX, Share2 } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { page } from '$app/state';
  import { POST_COMMENT_PARAM, isRepeatNavigationToSamePage } from '$lib/posts/notificationTarget';

  let { data }: { data: { post: Promise<PostEntity | null> } } = $props();

  /** The comment a comment, reply or mention notification opened this post at, if any. */
  const focusCommentId = $derived(page.url.searchParams.get(POST_COMMENT_PARAM) ?? undefined);

  /** Every navigation to this route while it is mounted, the same URL again included: a repeated push is an event. */
  let navigations = $state(0);
  afterNavigate((nav) => {
    // Only a navigation to the page ALREADY mounted counts: the one that mounted it runs this
    // callback too, after the card took its starting value.
    if (!isRepeatNavigationToSamePage(nav)) return;
    navigations += 1;
    Log.d('postPage', `repeat navigation #${navigations} to ${nav.to?.url.pathname}`);
  });

  /**
   * The post once it has arrived: `undefined` while it is on its way, `null` when it is absent or
   * refused. The route's load hands over a PROMISE so the page - header, back link - opens at once and
   * a weak link shows a skeleton instead of a frozen feed (WP-NAV-1).
   */
  let post = $state<PostEntity | null | undefined>(undefined);
  $effect(() => {
    const pending = data.post;
    post = undefined;
    let live = true;
    pending.then((value) => {
      if (live) post = value;
    });
    return () => {
      live = false;
    };
  });

  const userId = $derived(currentUserId() ?? '');
  let authToken = $state('');
  /**
   * The header's "Partager" opens the post's share sheet, the one its menu and the reel rail open
   * (user, 2026-10-23) - loaded on the first open, as there.
   */
  let ShareSheet = $state<
    typeof import('$lib/components/posts/PostShareSheet.svelte').default | null
  >(null);
  let shareOpen = $state(false);

  function openShareSheet() {
    import('$lib/components/posts/PostShareSheet.svelte')
      .then((mod) => {
        ShareSheet = mod.default;
        shareOpen = true;
      })
      .catch((e: unknown) => Log.d('postPage', `the share sheet did not load: ${String(e)}`));
  }

  $effect(() => {
    if (post) void postNotifStore.markPostRead(post.id);
  });

  onMount(() => {
    getToken()
      .then((t) => {
        authToken = t;
      })
      .catch(() => {});
  });
</script>

<PageContainer>
  <PageHeader title={m.posts_page_title()} backHref="/posts" backLabel={m.post_back_to_feed()}>
    {#snippet actions()}
      {#if post}
        <button
          type="button"
          onclick={openShareSheet}
          class="text-text-muted hover:text-text-main hover:bg-cn-border/30 inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors"
        >
          <Share2 size={13} />{m.post_share_label()}
        </button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if post === undefined}
    <!-- The page is already here; only the post is on its way. -->
    <div
      data-loading-skeleton
      class="border-cn-border bg-cn-surface animate-pulse rounded-3xl border p-5"
      role="status"
      aria-label={m.common_loading_label()}
    >
      <div class="mb-4 flex items-center gap-3">
        <div class="bg-cn-border/50 h-10 w-10 rounded-full"></div>
        <div class="bg-cn-border/50 h-3 w-32 rounded-full"></div>
      </div>
      <div class="bg-cn-border/50 mb-2 h-3 w-full rounded-full"></div>
      <div class="bg-cn-border/50 mb-2 h-3 w-5/6 rounded-full"></div>
      <div class="bg-cn-border/50 h-3 w-2/3 rounded-full"></div>
    </div>
  {:else if post}
    <!--
      The thread is a SHEET now (`PostCommentsSheet`), and it opens at once only when a notification
      named a comment: that reader came for the thread. Anyone else who followed a link to the post
      sees the post, its newest comment and the line to write one - a full-screen sheet over the
      post they came to read would be a decision made for them.
    -->
    <PostCard
      {post}
      currentUserId={userId}
      {authToken}
      fullContent
      commentsOpen={focusCommentId !== undefined}
      {focusCommentId}
      focusNonce={navigations}
      onDelete={() => goto('/posts')}
    />
  {:else}
    <div
      class="border-cn-border bg-cn-surface rounded-3xl border border-dashed px-6 py-16 text-center"
    >
      <FileX size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
      <h3 class="text-text-main mb-1 text-lg font-bold">{m.post_not_found_title()}</h3>
      <p class="text-text-muted text-sm">{m.post_not_found_desc()}</p>
    </div>
  {/if}

  {#if ShareSheet && post}
    <ShareSheet open={shareOpen} postId={post.id} onClose={() => (shareOpen = false)} />
  {/if}
</PageContainer>
