<script lang="ts">
  import PostImage from './PostImage.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';

  interface Props {
    post: PostEntity;
    authToken?: string;
  }

  let { post, authToken = '' }: Props = $props();

  const MAX_CHARS = 400;

  let expanded = $state(false);

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s)>\]"]+/i);
    return match?.[0] ?? null;
  }

  const isTruncatable = $derived((post.markdown?.length ?? 0) > MAX_CHARS);
  const displayedMarkdown = $derived(
    isTruncatable && !expanded ? post.markdown!.slice(0, MAX_CHARS) + '…' : (post.markdown ?? '')
  );
  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);
</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-[0.95rem] text-text-main leading-relaxed break-words">
      <div class="prose prose-sm dark:prose-invert max-w-none opacity-90">
        <SvelteMarkdown source={displayedMarkdown} options={{ gfm: true, breaks: true }} />
      </div>
      {#if isTruncatable}
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="mt-1 text-[0.82rem] font-bold text-amber-600 dark:text-amber-400 hover:underline outline-none focus-visible:underline"
        >
          {expanded ? 'Voir moins' : 'Voir plus'}
        </button>
      {/if}
    </div>
    {#if firstLink}
      <LinkPreviewCard url={firstLink} />
    {/if}
  </div>
{/if}

{#if post.images && post.images.length > 0 && authToken}
  <div class="w-full mt-1">
    {#if post.images.length === 1}
      <div
        class="relative w-full max-h-[75vh] bg-black/5 dark:bg-white/5 flex items-center justify-center overflow-hidden"
      >
        <PostImage media={post.images[0]} {authToken} />
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-0.5 sm:gap-1 bg-white/20 dark:bg-black/20">
        {#each post.images as img (img.mediaId)}
          <div class="relative aspect-square w-full overflow-hidden bg-black/5 dark:bg-white/5">
            <PostImage media={img} {authToken} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
