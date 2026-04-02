<script lang="ts">
  import SvelteMarkdown from 'svelte-markdown';
  import PostImage from './PostImage.svelte';
  import type { PostEntity } from '$lib/posts/api';

  interface Props {
    post: PostEntity;
    authToken?: string;
  }

  let { post, authToken = '' }: Props = $props();
</script>

<!-- Markdown content -->
<div class="px-5 py-3 border-b border-cn-border/40">
  <div class="text-sm text-text-main leading-relaxed">
    <a href="/profile/{encodeURIComponent(post.authorId)}" class="font-bold mr-1 hover:underline"
      >{post.authorDisplayName || post.authorId}</a
    >
    <span class="prose prose-sm max-w-none inline [&_p]:inline [&_p]:m-0">
      <SvelteMarkdown source={post.markdown} />
    </span>
  </div>
</div>

<!-- Images -->
{#if post.images && post.images.length > 0 && authToken}
  <div class="border-b border-cn-border/40">
    {#if post.images.length === 1}
      <PostImage media={post.images[0]} {authToken} />
    {:else}
      <div class="grid grid-cols-2 gap-0.5">
        {#each post.images as img (img.mediaId)}
          <PostImage media={img} {authToken} />
        {/each}
      </div>
    {/if}
  </div>
{/if}
