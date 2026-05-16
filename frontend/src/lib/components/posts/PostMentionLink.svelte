<script lang="ts">
  import { goto } from '$app/navigation';
  import { searchUsers } from '$lib/stores/user';
  import type { Snippet } from 'svelte';

  interface Props {
    href?: string;
    title?: string;
    children?: Snippet;
  }

  let { href = '', title, children }: Props = $props();

  const isMention = $derived(href.startsWith('#mention-'));
  const isHashtag = $derived(href.startsWith('#hashtag-'));
  const mentionName = $derived(isMention ? href.slice(9) : '');
  const hashtagName = $derived(isHashtag ? href.slice(9) : '');

  async function handleMentionClick(e: MouseEvent) {
    e.preventDefault();
    const results = await searchUsers(mentionName);
    if (results.length > 0) {
      void goto(`/profile/${results[0].id}`);
    }
  }
</script>

{#if isMention}
  <button
    type="button"
    onclick={handleMentionClick}
    class="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.88em] font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer leading-none"
  >
    @{mentionName}
  </button>
{:else if isHashtag}
  <span class="font-semibold text-amber-600/80 dark:text-amber-400/70">#{hashtagName}</span>
{:else}
  <a {href} {title} target="_blank" rel="noopener noreferrer" class="text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-500 transition-colors">
    {@render children?.()}
  </a>
{/if}
