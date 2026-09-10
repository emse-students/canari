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

  let { data }: { data: { post: PostEntity | null } } = $props();

  const userId = $derived(currentUserId() ?? '');
  let authToken = $state('');
  let copiedLink = $state(false);

  function copyPostLink() {
    const id = data.post?.id;
    if (!id) return;
    void copyPublicShareLink(`/posts/${id}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

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
      {#if data.post}
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

  {#if data.post}
    <PostCard post={data.post} currentUserId={userId} {authToken} onDelete={() => goto('/posts')} />
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
