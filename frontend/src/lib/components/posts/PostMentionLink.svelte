<script lang="ts">
  import { goto } from '$app/navigation';
  import { isUserUuid, MENTION_HREF_PREFIX, normalizeMentionUserId } from '$lib/utils/mentions';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { Snippet } from 'svelte';

  interface Props {
    href?: string;
    title?: string;
    children?: Snippet;
  }

  let { href = '', title, children }: Props = $props();

  const isMention = $derived(href.startsWith(MENTION_HREF_PREFIX));
  const isHashtag = $derived(href.startsWith('#hashtag-'));
  const mentionUserId = $derived.by(() => {
    if (!isMention) return '';
    const key = normalizeMentionUserId(decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length)));
    return isUserUuid(key) ? key : '';
  });
  const hashtagName = $derived(isHashtag ? href.slice(9) : '');

  let mentionLabel = $state('');

  $effect(() => {
    if (!mentionUserId) {
      mentionLabel = '';
      return;
    }
    mentionLabel = getUserDisplayNameSync(mentionUserId, mentionUserId);
    void resolveUserDisplayName(mentionUserId).then((name) => {
      if (name) mentionLabel = name;
    });
  });

  function handleMentionClick(e: MouseEvent) {
    e.preventDefault();
    if (mentionUserId) void goto(`/profile/${mentionUserId}`);
  }
</script>

{#if isMention && mentionUserId}
  <button
    type="button"
    onclick={handleMentionClick}
    class="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.88em] font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer leading-none"
  >
    @{mentionLabel || mentionUserId}
  </button>
{:else if isHashtag}
  <span class="font-semibold text-amber-600/80 dark:text-amber-400/70">#{hashtagName}</span>
{:else}
  <a
    {href}
    {title}
    target="_blank"
    rel="noopener noreferrer"
    class="text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-500 transition-colors"
  >
    {@render children?.()}
  </a>
{/if}
