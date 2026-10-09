<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PostEntity } from '$lib/posts/api';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { FileX, Link, Check } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { m } from '$lib/paraglide/messages';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';

  let { data }: { data: { post: Promise<PostEntity | null> } } = $props();

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
  let copiedLink = $state(false);

  function copyPostLink() {
    const id = post?.id;
    if (!id) return;
    void copyPublicShareLink(`/posts/${id}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
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
          onclick={copyPostLink}
          class="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors {copiedLink
            ? 'text-green-ok bg-green-50 dark:bg-green-950/20'
            : 'text-text-muted hover:text-text-main hover:bg-cn-border/30'}"
        >
          {#if copiedLink}
            <Check size={13} />{m.post_link_copied()}
          {:else}
            <Link size={13} />{m.post_share_label()}
          {/if}
        </button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if post === undefined}
    <!-- The page is already here; only the post is on its way. -->
    <div
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
      `commentsOpen` because this page IS the post: a reader who followed a link to it came for the
      thread, not to scroll past it. In the feed the section stays closed behind the comment button.
    -->
    <PostCard
      {post}
      currentUserId={userId}
      {authToken}
      commentsOpen
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
</PageContainer>
