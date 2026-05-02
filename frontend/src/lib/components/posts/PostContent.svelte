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

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s)>\]"]+/i);
    return match?.[0] ?? null;
  }

  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);
</script>

<!-- Contenu Texte (Markdown) -->
{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-[0.95rem] text-text-main leading-relaxed break-words">
      <!-- Texte formaté -->
      <div class="prose prose-sm dark:prose-invert max-w-none opacity-90">
        <SvelteMarkdown source={post.markdown} options={{ gfm: true, breaks: true }} />
      </div>
    </div>
    {#if firstLink}
      <LinkPreviewCard url={firstLink} />
    {/if}
  </div>
{/if}

<!-- Galerie d'Images (Effet "Bleeding Edge" bord à bord) -->
{#if post.images && post.images.length > 0 && authToken}
  <div class="w-full mt-1">
    {#if post.images.length === 1}
      <!-- Image Unique -->
      <div
        class="relative w-full max-h-[75vh] bg-black/5 dark:bg-white/5 flex items-center justify-center overflow-hidden"
      >
        <PostImage media={post.images[0]} {authToken} />
      </div>
    {:else}
      <!-- Mosaïque Multi-Images -->
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
