<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import AppLink from '$lib/components/shared/AppLink.svelte';
  import {
    isMentionUserId,
    MENTION_HREF_PREFIX,
    normalizeMentionUserId,
  } from '$lib/utils/mentions';
  import { isInAppHref } from '$lib/utils/publicAppUrl';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';
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
    return isMentionUserId(key) ? key : '';
  });
  const hashtagName = $derived(isHashtag ? href.slice(9) : '');

  let mentionLabel = $state('');

  $effect(() => {
    if (!mentionUserId) {
      mentionLabel = '';
      return;
    }
    // The absence, not a guess: `peekUserDisplayName` answers `null` when the name is not known
    // YET, which is not the same as knowing there is none. Passing the id as a fallback put back
    // the one value `getUserDisplayNameSync` is careful never to return.
    mentionLabel = peekUserDisplayName(mentionUserId) ?? '';
    void resolveUserDisplayName(mentionUserId).then((name) => {
      if (name) mentionLabel = name;
    });
  });

  const isPublicAppLink = $derived(!isMention && !isHashtag && isInAppHref(href));

  function handleMentionClick(e: MouseEvent) {
    e.preventDefault();
    if (mentionUserId) void goto(resolve(`profile/${mentionUserId}`));
  }
</script>

{#if isMention && mentionUserId}
  <button
    type="button"
    onclick={handleMentionClick}
    class="bg-accent/10 text-accent-text hover:bg-accent/20 inline-flex cursor-pointer items-center rounded-full px-1.5 py-0.5 text-[0.88em] leading-none font-semibold transition-colors"
  >
    @{mentionLabel}
  </button>
{:else if isHashtag}
  <!-- THE MENTION CHIP'S OWN TOKEN, and not a fainter cousin of it: a translucent accent text
       measured 2.51:1 on the light post surface, under the 4.5:1 floor and for no reason. `accent-text`
       is 5.05:1 in light and 13.2:1 in dark. A post's surface is FIXED, which is why this one may
       carry an accent at all - the chat bubble's is not, so its hashtag inherits instead
       (`MessageTextBody`). -->
  <span class="text-accent-text font-semibold">#{hashtagName}</span>
{:else if isPublicAppLink}
  <AppLink {href} {title} class="hover:text-accent-text">
    {@render children?.()}
  </AppLink>
{:else}
  <a
    {href}
    {title}
    target="_blank"
    rel="noopener noreferrer external"
    class="text-accent-text hover:text-accent-text underline underline-offset-2 transition-colors"
  >
    {@render children?.()}
  </a>
{/if}
